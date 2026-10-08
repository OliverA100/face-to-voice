"""`uv run verify`: decode the packed .glb, compare it with the float32 source, validate, report.

gltfpack reorders vertices for cache efficiency and quantises positions to 16-bit integers with a
per-node scale/translation, so the check is: transform every decoded vertex to world space, match
it to the nearest source vertex (KD-tree), and compare positions, morph deltas and triangles.
"""
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from pygltflib import GLTF2
from scipy.spatial import cKDTree

from .export_glb import MANIFEST, PACKED_EXTRA, PACKED_GLB, RAW_GLB, REFERENCE_EXTRA_NPZ, REFERENCE_NPZ
from .gnm import EXPECTED, OUT_DIR, REPO_DIR
from .tools import file_sizes, fmt_mb, gltf_transform

DECODED_GLB = OUT_DIR / "head.decoded.glb"
REPORT = OUT_DIR / "report.md"
MAX_ERROR_M = 10e-6  # 10 µm: below anything visible on a 25 cm head
MAX_UV_ERROR = 2.5e-4  # a quarter texel at 1024² (gltfpack -vtf keeps ~13 bits of mantissa)

_DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_accessor(gltf: GLTF2, blob: bytes, index: int) -> np.ndarray:
    """Accessor -> float64 array (N, components), handling strides and normalized integers."""
    acc = gltf.accessors[index]
    bv = gltf.bufferViews[acc.bufferView]
    dtype = np.dtype(_DTYPES[acc.componentType])
    n = _NCOMP[acc.type]
    start = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    stride = bv.byteStride or dtype.itemsize * n
    arr = np.ndarray((acc.count, n), dtype, buffer=blob, offset=start, strides=(stride, dtype.itemsize))
    arr = arr.astype(np.float64)
    if acc.normalized:
        limit = {np.int8: 127, np.uint8: 255, np.int16: 32767, np.uint16: 65535}[dtype.type]
        arr = np.maximum(arr / limit, -1.0)
    return arr


def local_matrix(node) -> np.ndarray:
    if node.matrix:
        return np.array(node.matrix, np.float64).reshape(4, 4).T  # glTF matrices are column-major
    m = np.eye(4)
    if node.scale:
        m = np.diag([*node.scale, 1.0]) @ m
    if node.rotation:
        x, y, z, w = node.rotation
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
        rm = np.eye(4)
        rm[:3, :3] = r
        m = rm @ m
    if node.translation:
        tm = np.eye(4)
        tm[:3, 3] = node.translation
        m = tm @ m
    return m


def mesh_nodes(gltf: GLTF2) -> list[tuple[str, object, np.ndarray]]:
    """(part name, node, world matrix) for every node that carries a mesh.

    gltfpack keeps our named part nodes but moves each mesh onto an unnamed child that holds the
    dequantisation translation/scale, so the part name is the nearest named ancestor."""
    out = []

    def walk(idx: int, parent: np.ndarray, name: str | None) -> None:
        node = gltf.nodes[idx]
        world = parent @ local_matrix(node)
        name = node.name or name
        if node.mesh is not None:
            out.append((name, node, world))
        for c in node.children or []:
            walk(c, world, name)

    for root in gltf.scenes[gltf.scene or 0].nodes:
        walk(root, np.eye(4), None)
    return out


def canonical_triangles(tris: np.ndarray) -> set[tuple[int, int, int]]:
    """Rotate each triangle so its smallest index comes first (keeps winding), as a set."""
    tris = np.asarray(tris, np.int64)
    k = tris.argmin(axis=1)
    rows = np.arange(len(tris))
    rolled = np.stack([tris[rows, k], tris[rows, (k + 1) % 3], tris[rows, (k + 2) % 3]], axis=1)
    return set(map(tuple, rolled.tolist()))


def match_vertices(pos, ref_pos, deltas, names, ref_deltas, ref_names, uv=None, ref_uv=None):
    """Nearest source vertex for every decoded vertex. Coincident vertices (e.g. upper and lower
    teeth touching) are told apart by their morph deltas, and UV-seam copies by their UVs."""
    tree = cKDTree(ref_pos)
    dist, idx = tree.query(pos)
    k_dist, k_idx = tree.query(pos, k=6, distance_upper_bound=4 * MAX_ERROR_M)
    common = [(k, ref_names.index(n)) for k, n in enumerate(names) if n in ref_names]
    for i in np.where(np.isfinite(k_dist[:, 1]))[0]:  # more than one candidate within tolerance
        cands = k_idx[i][np.isfinite(k_dist[i])]
        cost = [sum(np.abs(deltas[k][i] - ref_deltas[r][c]).sum() for k, r in common)
                + (float(np.abs(uv[i] - ref_uv[c]).sum()) if uv is not None else 0.0) for c in cands]
        best = cands[int(np.argmin(cost))]
        idx[i], dist[i] = best, np.linalg.norm(pos[i] - ref_pos[best])
    return dist, idx


def check_fidelity(packed: Path = PACKED_GLB, decoded: Path = DECODED_GLB, reference: Path = REFERENCE_NPZ) -> list[dict]:
    gltf_transform("copy", packed, decoded, capture=False)
    gltf = GLTF2().load_binary(str(decoded))
    if "EXT_meshopt_compression" in (gltf.extensionsRequired or []):
        raise RuntimeError("decoded file is still meshopt-compressed; cannot compare")
    blob = gltf.binary_blob()
    ref = np.load(reference)
    results = []
    for name, node, world in mesh_nodes(gltf):
        if f"{name}.positions" not in ref:
            results.append({"mesh": name, "ok": False, "error": "unexpected mesh (not in reference)"})
            continue
        mesh = gltf.meshes[node.mesh]
        prim = mesh.primitives[0]
        lin, off = world[:3, :3], world[:3, 3]
        pos = read_accessor(gltf, blob, prim.attributes.POSITION) @ lin.T + off
        ref_pos = ref[f"{name}.positions"].astype(np.float64)
        names = list((mesh.extras or {}).get("targetNames", []))
        ref_names = list(ref[f"{name}.targets"])
        ref_deltas = ref[f"{name}.deltas"].astype(np.float64)
        deltas = []
        for k in range(len(names)):
            target = prim.targets[k]  # pygltflib loads morph targets as plain dicts
            acc_index = target["POSITION"] if isinstance(target, dict) else target.POSITION
            deltas.append(read_accessor(gltf, blob, acc_index) @ lin.T)
        uv = read_accessor(gltf, blob, prim.attributes.TEXCOORD_0) if prim.attributes.TEXCOORD_0 is not None else None
        ref_uv = ref[f"{name}.uvs"] if f"{name}.uvs" in ref.files else None
        if (uv is None) != (ref_uv is None):
            results.append({"mesh": name, "ok": False, "error": "TEXCOORD_0 present in only one of packed/reference"})
            continue
        dist, idx = match_vertices(pos, ref_pos, deltas, names, ref_deltas, ref_names, uv, ref_uv)
        row = {
            "mesh": name, "vertices": len(pos), "ref_vertices": len(ref_pos), "order": idx,
            "max_position_error_um": round(float(dist.max() * 1e6), 2),
            "bijection": bool(len(np.unique(idx)) == len(ref_pos) == len(pos)),
        }
        # Triangles (mapped back to source vertex ids) must be the same set with the same winding.
        tris = read_accessor(gltf, blob, prim.indices).astype(np.int64).reshape(-1, 3)
        row["triangles_ok"] = canonical_triangles(idx[tris]) == canonical_triangles(ref[f"{name}.indices"])
        # Morph targets: same names, deltas within tolerance after the node's linear transform.
        row["targets"] = len(names)
        row["target_names_ok"] = names == ref_names
        max_delta_err = 0.0
        for k, tname in enumerate(names):
            if tname not in ref_names:
                continue
            ref_d = ref_deltas[ref_names.index(tname)][idx]
            max_delta_err = max(max_delta_err, float(np.abs(deltas[k] - ref_d).max()))
        row["max_delta_error_um"] = round(max_delta_err * 1e6, 2)
        uv_err = float(np.abs(uv - ref_uv[idx]).max()) if uv is not None else 0.0
        row["max_uv_error"] = round(uv_err, 6)
        row["ok"] = bool(
            row["bijection"] and row["triangles_ok"] and row["target_names_ok"]
            and dist.max() < MAX_ERROR_M and max_delta_err < MAX_ERROR_M and uv_err < MAX_UV_ERROR
        )
        results.append(row)
    found = {r["mesh"] for r in results}
    results.extend({"mesh": key[: -len(".positions")], "ok": False, "error": "missing from packed file"}
                   for key in ref.files if key.endswith(".positions") and key[: -len(".positions")] not in found)
    return results


def run_validator(packed: Path = PACKED_GLB) -> tuple[bool, str]:
    proc = gltf_transform("validate", packed)
    text = proc.stdout + proc.stderr
    return "No errors found." in text, text.strip()


def main() -> None:
    fidelity = check_fidelity()
    valid, validator_text = run_validator()
    if PACKED_EXTRA.exists():
        # head.extra.glb: its own fidelity, and the SAME vertex order as head.glb in every mesh it shares (the web
        # app appends its targets to head.glb's meshes by index)
        extra = check_fidelity(PACKED_EXTRA, OUT_DIR / "head.extra.decoded.glb", REFERENCE_EXTRA_NPZ)
        order = {r["mesh"]: r.get("order") for r in fidelity}
        for r in extra:
            r["mesh"] = f"{r['mesh']} (extra)"
            base = order.get(r["mesh"][: -len(" (extra)")])
            same = base is not None and r.get("order") is not None and np.array_equal(base, r["order"])
            r["same_order"] = bool(same)
            if not same:
                r["ok"] = False
                r.setdefault("error", "vertex order differs from head.glb")
        fidelity += extra
        v2, t2 = run_validator(PACKED_EXTRA)
        valid, validator_text = valid and v2, validator_text + "\n--- head.extra.glb ---\n" + t2
    inspect_md = gltf_transform("inspect", PACKED_GLB, "--format", "md").stdout
    summary = json.loads((OUT_DIR / "export_summary.json").read_text())
    manifest = json.loads(MANIFEST.read_text())
    sizes_raw, sizes = file_sizes(RAW_GLB), file_sizes(PACKED_GLB)
    all_ok = valid and all(r.get("ok") for r in fidelity)

    lines = [
        "# head.glb export report",
        "",
        f"Generated {datetime.now(UTC).isoformat(timespec='seconds')} · "
        f"GNM Head v3.0 @ `{manifest['source']['commit'][:12]}` · overall: **{'PASS' if all_ok else 'FAIL'}**",
        "",
        "## Size",
        "",
        "| File | On disk | gzip | brotli |",
        "|---|---|---|---|",
        f"| `out/head.raw.glb` (float32, uncompressed) | {fmt_mb(sizes_raw['raw'])} | {fmt_mb(sizes_raw['gzip'])} | {fmt_mb(sizes_raw['brotli'])} |",
        f"| `web/public/models/head.glb` (meshopt + 16-bit) | **{fmt_mb(sizes['raw'])}** | {fmt_mb(sizes['gzip'])} | **{fmt_mb(sizes['brotli'])}** |",
        "",
        "## Geometry",
        "",
        f"- {summary['vertices']} vertices, {summary['triangles']} triangles over {summary['meshes']} meshes "
        f"(source: {EXPECTED['vertices']:,} vertices / {EXPECTED['triangles']:,} triangles; no decimation, seam vertices duplicated once per part)",
        f"- {summary['targets']} morph targets (positions only), morph weight 1.0 = {manifest['sigma_scale']}σ",
        "",
        "| Mesh | Material | Vertices | Triangles | Targets |",
        "|---|---|---|---|---|",
        *[f"| {m['name']} | {m['material']} | {m['vertices']} | {m['triangles']} | {len(m['targets'])} |" for m in manifest["meshes"]],
        "",
        f"## Fidelity (packed vs float32 source, tolerance {MAX_ERROR_M * 1e6:.0f} µm)",
        "",
        "| Mesh | Vertices | Max position error | Max morph-delta error | Triangles | Target names | OK |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in fidelity:
        if "error" in r:
            lines.append(f"| {r['mesh']} | – | – | – | – | – | ❌ {r['error']} |")
        else:
            lines.append(
                f"| {r['mesh']} | {r['vertices']} | {r['max_position_error_um']} µm | {r['max_delta_error_um']} µm | "
                f"{'ok' if r['triangles_ok'] else 'MISMATCH'} | {'ok' if r['target_names_ok'] else 'MISMATCH'} | "
                f"{'✅' if r['ok'] else '❌'} |"
            )
    lines += [
        "",
        f"## glTF validator: {'clean' if valid else 'ERRORS'}",
        "",
        "```",
        validator_text[-3000:],
        "```",
        "",
        "## glTF-Transform inspect",
        "",
        inspect_md.strip(),
        "",
    ]
    REPORT.write_text("\n".join(lines))

    print(f"packed: {fmt_mb(sizes['raw'])} on disk, {fmt_mb(sizes['gzip'])} gzip, {fmt_mb(sizes['brotli'])} brotli")
    for r in fidelity:
        if "error" in r:
            print(f"  ❌ {r['mesh']}: {r['error']}")
        else:
            print(f"  {'✅' if r['ok'] else '❌'} {r['mesh']:10s} pos err {r['max_position_error_um']:6.2f} µm, "
                  f"delta err {r['max_delta_error_um']:6.2f} µm, {r['targets']} targets")
    print(f"validator: {'clean' if valid else 'ERRORS (see report)'}")
    print(f"report: {REPORT.relative_to(REPO_DIR)}")
    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
