"""`uv run export`: GNM Head -> web/public/models/head.glb (+ head.manifest.json).

Steps: load the weights -> pick components from config/components.toml -> split the mesh into
parts (skin, mouth, teeth, ... , eyes) -> bake each component as a morph target (position deltas
at `sigma_scale` standard deviations) -> write an uncompressed GLB with pygltflib -> compress it
with gltfpack (meshopt + 16-bit quantisation) -> write the manifest the web app reads.
"""
from __future__ import annotations

import json
import os
import shutil
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .glb import GlbWriter
from .gnm import CONFIG_FILE, GNM, GNM_COMMIT, GNM_REPO, OUT_DIR, REPO_DIR, WEIGHTS_SHA256, WEIGHTS_URL
from .parts import EYE_PIVOTS, MATERIALS, PARTS, PartSpec
from .tools import file_sizes, fmt_mb, gltfpack

MODELS_DIR = REPO_DIR / "web" / "public" / "models"
RAW_GLB = OUT_DIR / "head.raw.glb"
REFERENCE_NPZ = OUT_DIR / "head.reference.npz"  # what `verify` compares the packed file against
PACKED_GLB = MODELS_DIR / "head.glb"
RAW_EXTRA = OUT_DIR / "head.extra.raw.glb"
REFERENCE_EXTRA_NPZ = OUT_DIR / "head.extra.reference.npz"
PACKED_EXTRA = MODELS_DIR / "head.extra.glb"
MANIFEST = MODELS_DIR / "head.manifest.json"

# gltfpack flags. -cc: meshopt compression (high). -kn/-km/-ke: keep named nodes, materials and
# extras (target names, eye pivots). -vp 16: 16-bit positions (~5 µm steps on this head; the
# default 14 bits would quantise subtle expression deltas visibly). -vn 8: 8-bit normals.
# Never -si (simplification would break the morph targets) and never -cz (KHR variant).
# -kv: keep TEXCOORD_0 although the glTF materials have no textures (the web app adds them). -vtf: float UVs; the
# quantised ones are rescaled per mesh through KHR_texture_transform on the material's textures, which head.glb
# does not have (the decoded UVs come out squeezed into 0..0.25).
GLTFPACK_FLAGS = ("-cc", "-kn", "-km", "-ke", "-kv", "-vp", "16", "-vn", "8", "-vtf")

# Head asset budget: the export fails when the packed files are larger.
BUDGET_DISK = 4_000_000
BUDGET_BROTLI = 3_000_000
MAX_TARGETS = 120  # per mesh; three.js fails on low-end Android around ~200

# Kinds that change the face's shape (move the eye pivots) and kinds that animate it.
SHAPE_KINDS = ("identity", "semantic")
MOTION_KINDS = ("expression", "emotion")
EXTRA_KINDS = ("semantic", "emotion")  # shipped in head.extra.glb (after the first view)


@dataclass
class Target:
    name: str
    kind: str  # identity | expression | preset | semantic (identity direction) | emotion (expression part)
    region: str
    scale: float  # sigma per morph weight 1.0
    delta: np.ndarray  # (V, 3) metres at weight 1.0
    joint_delta: np.ndarray  # (4, 3) metres at weight 1.0 (identity only)
    meshes: list[str] = field(default_factory=list)  # filled during export


def load_config(path: Path = CONFIG_FILE) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def resolve_targets(gnm: GNM, cfg: dict) -> list[Target]:
    sigma = float(cfg["export"]["sigma_scale"])
    overrides = cfg["export"].get("scale_overrides", {})
    targets: list[Target] = []
    seen: set[str] = set()

    def add(t: Target) -> None:
        if t.name in seen:
            raise ValueError(f"component {t.name!r} listed twice in {CONFIG_FILE.name}")
        seen.add(t.name)
        targets.append(t)

    for kind in ("identity", "expression"):
        for name in cfg[kind]["components"]:
            if gnm.kind_of(name) != kind:
                raise ValueError(f"{name!r} is not a {kind} component")
            s = float(overrides.get(name, sigma))
            add(Target(name, kind, gnm.region_of(name), s, gnm.delta(name) * s, gnm.joint_delta(name) * s))

    for name, combo in cfg.get("presets", {}).items():
        delta = np.zeros_like(gnm.template)
        jdelta = np.zeros((4, 3), np.float32)
        for comp, w in combo.items():
            gnm.kind_of(comp)  # validates the name
            delta += np.float32(w) * gnm.delta(comp)
            jdelta += np.float32(w) * gnm.joint_delta(comp)
        add(Target(name, "preset", "preset", 1.0, delta, jdelta))

    # Semantic identity sliders (config/semantic_sliders.toml, semantic.py): one solved direction each.
    if cfg.get("semantic", {}).get("enabled", False):
        from .semantic import semantic_targets

        for name, delta, jdelta in semantic_targets(gnm):
            add(Target(name, "semantic", "semantic", 1.0, delta, jdelta))
    # Emotions (config/emotions.json, emotions.py): an upper- and a lower-face target per emotion.
    if cfg.get("emotions", {}).get("enabled", False):
        from .emotions import emotion_targets

        for name, delta in emotion_targets(gnm):
            add(Target(name, "emotion", "emotion_" + name.rsplit("_", 1)[1], 1.0, delta, np.zeros((4, 3), np.float32)))
    return targets


# --- mesh partitioning ------------------------------------------------------------------------


def assign_vertices(gnm: GNM, parts: list[PartSpec]) -> np.ndarray:
    """(V,) index into `parts`, or -1 for vertices that are not shipped."""
    owner = np.full(gnm.template.shape[0], -1, np.int64)
    for i, p in enumerate(parts):
        m = gnm.mask(*p.groups, exclude=p.exclude)
        owner[(owner == -1) & m] = i
    return owner


def assign_triangles(owner: np.ndarray, triangles: np.ndarray, n_parts: int) -> np.ndarray:
    """(T,) part index by majority vote of the triangle's vertices; ties -> higher priority."""
    o = owner[triangles]  # (T, 3)
    counts = np.stack([(o == i).sum(axis=1) for i in range(n_parts)], axis=1)  # (T, P)
    best = counts.argmax(axis=1)  # argmax returns the first (highest-priority) max
    best[counts.max(axis=1) == 0] = -1
    return best


def split_seams(tris: np.ndarray, corner_uvs: np.ndarray | None) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Local vertices for a part: (used, local_tris, uvs). Without UVs, one vertex per template vertex (sorted ids).
    With per-corner UVs, a template vertex that sits on a UV seam becomes one vertex per distinct UV; the copies
    share position and morph deltas, so the surface does not change. Parts without seams keep the same order."""
    if corner_uvs is None:
        used, local = np.unique(tris, return_inverse=True)
        return used, local.reshape(-1, 3), None
    key = np.concatenate([tris.reshape(-1, 1).astype(np.int64), np.round(corner_uvs.reshape(-1, 2) * 1e6).astype(np.int64)], axis=1)
    uniq, first, local = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return uniq[:, 0], local.reshape(-1, 3), corner_uvs.reshape(-1, 2)[first].astype(np.float32)


def vertex_normals(positions: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Area-weighted smooth normals."""
    a, b, c = (positions[triangles[:, i]] for i in range(3))
    face = np.cross(b - a, c - a)
    n = np.zeros_like(positions)
    for i in range(3):
        np.add.at(n, triangles[:, i], face)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    return (n / np.maximum(length, 1e-12)).astype(np.float32)


def boundary_loops(triangles: np.ndarray) -> list[list[int]]:
    """Closed loops of edges that belong to exactly one triangle."""
    e = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])
    e = np.sort(e, axis=1)
    uniq, counts = np.unique(e, axis=0, return_counts=True)
    adj: dict[int, list[int]] = {}
    for a, b in uniq[counts == 1]:
        adj.setdefault(int(a), []).append(int(b))
        adj.setdefault(int(b), []).append(int(a))
    loops, seen = [], set()
    for start in adj:
        if start in seen:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nxt = [n for n in adj[cur] if n != prev]
            if not nxt or nxt[0] == start:
                break
            prev, cur = cur, nxt[0]
            loop.append(cur)
            seen.add(cur)
        loops.append(loop)
    return loops


# --- export -----------------------------------------------------------------------------------


def write_packed(payloads: list[dict], pivots: dict, keep, raw: Path, packed: Path, reference_npz: Path, base: bool) -> None:
    """Write the meshes with the targets `keep(name)` accepts to `raw`, gltfpack it to `packed`, save the float32
    reference `verify` compares against. Meshes without such targets are left out of files other than head.glb (`base`)."""
    writer = GlbWriter(generator="face-to-voice pipeline (github.com/OliverA100/face-to-voice)")
    reference: dict[str, np.ndarray] = {}
    mesh_nodes = {}
    for pl in payloads:
        chosen = [(n, d) for n, d in zip(pl["names"], pl["deltas"]) if keep(n)]
        if not chosen and not base:
            continue
        mesh_id = writer.mesh(pl["name"], positions=pl["pos"], normals=pl["normals"], indices=pl["tris"],
                              material=writer.material(pl["material"], *MATERIALS[pl["material"]]),
                              target_deltas=[d for _, d in chosen], target_names=[n for n, _ in chosen], uvs=pl["uvs"])
        mesh_nodes[pl["name"]] = (pl["node"], writer.node(pl["name"], mesh=mesh_id))
        reference[f"{pl['name']}.positions"] = pl["world"].astype(np.float32)
        reference[f"{pl['name']}.indices"] = pl["tris"].astype(np.uint32)
        if pl["uvs"] is not None:
            reference[f"{pl['name']}.uvs"] = pl["uvs"]
        reference[f"{pl['name']}.targets"] = np.array([n for n, _ in chosen])
        reference[f"{pl['name']}.deltas"] = (np.stack([d for _, d in chosen]) if chosen else np.zeros((0, len(pl["pos"]), 3))).astype(np.float32)
    # Scene graph: head (group) -> parts + eye pivots -> eye parts.
    pivot_nodes = {node: writer.node(node, translation=pivots[node],
                                     children=[nid for n, (parent, nid) in mesh_nodes.items() if parent == node])
                   for node in EYE_PIVOTS}
    head_children = [nid for n, (parent, nid) in mesh_nodes.items() if parent == "head"] + list(pivot_nodes.values())
    writer.finish(raw, roots=[writer.node("head", children=head_children)])
    np.savez_compressed(reference_npz, **reference)
    gltfpack(raw, packed, *GLTFPACK_FLAGS)


def commit(staged: dict[Path, Path]) -> None:
    """Move every staged file onto its shipped path (os.replace, same file system: each file is the old one or the
    new one, never half written)."""
    for final, tmp in staged.items():
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, final)


def export(cfg: dict) -> dict:
    t0 = time.time()
    gnm = GNM.load()
    targets = resolve_targets(gnm, cfg)
    include = set(cfg["export"]["parts"]["include"])
    parts = [p for p in PARTS if p.material in include]
    eps = float(cfg["export"]["parts"]["min_delta_mm"]) / 1000.0

    positions = gnm.template.copy()
    owner = assign_vertices(gnm, parts)
    tri_owner = assign_triangles(owner, gnm.triangles, len(parts))
    shipped_tris = gnm.triangles[tri_owner >= 0]
    normals = vertex_normals(positions, shipped_tris)
    deltas = [t.delta.copy() for t in targets]  # (V, 3) each; grows by one row for the neck cap
    part_tris: dict[str, np.ndarray] = {p.name: gnm.triangles[tri_owner == i] for i, p in enumerate(parts)}
    with_uvs = bool(cfg["export"]["parts"].get("uvs", True)) and gnm.triangle_uvs is not None
    part_uvs: dict[str, np.ndarray] | None = {p.name: gnm.triangle_uvs[tri_owner == i] for i, p in enumerate(parts)} if with_uvs else None

    # Close the neck: the skin surface (skin + mouth) has exactly one open loop, at the bottom.
    neck_cap = False
    if cfg["export"]["parts"].get("cap_neck", True) and "skin" in part_tris:
        surface = np.concatenate([part_tris[n] for n in ("skin", "mouth") if n in part_tris])
        loops = boundary_loops(surface)
        loop = min(loops, key=lambda L: positions[L, 1].mean())  # lowest loop = neck
        centre_idx = len(positions)
        centre = positions[loop].mean(axis=0, keepdims=True)
        positions = np.concatenate([positions, centre])
        deltas = [np.concatenate([d, d[loop].mean(axis=0, keepdims=True)]) for d in deltas]
        fan = np.array([[centre_idx, loop[(i + 1) % len(loop)], loop[i]] for i in range(len(loop))])
        a, b, c = (positions[fan[:, i]] for i in range(3))
        if np.cross(b - a, c - a).sum(axis=0)[1] > 0:  # cap must face down (-Y)
            fan = fan[:, [0, 2, 1]]
        normals = np.concatenate([normals, np.array([[0.0, -1.0, 0.0]], np.float32)])
        part_tris["skin"] = np.concatenate([part_tris["skin"], fan])
        if part_uvs is not None:
            # The cap is hidden under the bust: its corners reuse a UV each loop vertex already has, the centre the mean.
            any_uv = np.zeros((len(positions), 2), np.float32)
            any_uv[gnm.triangles.ravel()] = gnm.triangle_uvs.reshape(-1, 2)
            any_uv[centre_idx] = any_uv[loop].mean(axis=0)
            part_uvs["skin"] = np.concatenate([part_uvs["skin"], any_uv[fan]])
        neck_cap = True

    # Build one mesh per part (payloads first: the same meshes are written into one or two files).
    pivots = {node: gnm.joint_positions[gnm.joint_names.index(j)] for node, j in EYE_PIVOTS.items()}
    payloads: list[dict] = []
    mesh_infos = []

    def emit(name: str, material: str, node: str, used: np.ndarray, world_pos: np.ndarray, local_tris: np.ndarray, part_normals: np.ndarray, uvs: np.ndarray | None = None) -> None:
        """One mesh: `used` are the template vertex ids its vertices derive from (for the morph deltas)."""
        pivot = pivots.get(node, np.zeros(3, np.float32))
        joint = gnm.joint_names.index(EYE_PIVOTS[node]) if node in EYE_PIVOTS else None
        part = []
        for i, t in enumerate(targets):
            d = deltas[i][used]
            if joint is not None:
                # The web app moves the eye pivot by the target's joint delta (manifest identity_pivot_basis), so
                # the eye meshes carry only the eyeball's change of SHAPE, not its translation (else it moves twice)
                d = d - t.joint_delta[joint]
            if np.abs(d).max() > eps:
                part.append((i, d))
        names = [targets[i].name for i, _ in part]
        for i, _ in part:
            targets[i].meshes.append(name)
        payloads.append({"name": name, "material": material, "node": node, "pos": world_pos - pivot, "world": world_pos,
                         "normals": part_normals, "tris": local_tris, "uvs": uvs, "names": names, "deltas": [d for _, d in part]})
        mesh_infos.append({"name": name, "material": material, "node": node,
                           "vertices": len(used), "triangles": len(local_tris), "targets": names})

    for p in parts:
        tris = part_tris[p.name]
        if len(tris) == 0:
            continue
        used, local, uvs = split_seams(tris, part_uvs[p.name] if part_uvs is not None else None)
        emit(p.name, p.material, p.node, used, positions[used], local, normals[used], uvs)

    # Split: the raw sliders' targets ship in head.glb (what the first view needs); the semantic and emotion
    # targets in head.extra.glb, fetched after the head is on screen and merged into the same meshes.
    kinds = {t.name: t.kind for t in targets}
    split = bool(cfg["export"].get("split", True))
    in_extra = (lambda n: kinds[n] in EXTRA_KINDS) if split else (lambda n: False)
    # The shipped files (and the references `verify` compares them with) are written to a staging folder first and
    # replace the old ones together only once they are within budget: a failed export leaves the old set in place.
    stage = OUT_DIR / "export.staged"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    shipped = (PACKED_GLB, REFERENCE_NPZ, MANIFEST) + ((PACKED_EXTRA, REFERENCE_EXTRA_NPZ) if split else ())
    staged = {p: stage / p.name for p in shipped}
    write_packed(payloads, pivots, lambda n: not in_extra(n), RAW_GLB, staged[PACKED_GLB], staged[REFERENCE_NPZ], base=True)
    if split:
        write_packed(payloads, pivots, in_extra, RAW_EXTRA, staged[PACKED_EXTRA], staged[REFERENCE_EXTRA_NPZ], base=False)
    for m in mesh_infos:
        m["extraTargets"] = [n for n in m["targets"] if in_extra(n)]
        m["targets"] = [n for n in m["targets"] if not in_extra(n)]

    # Manifest for the web app (and for `verify`).
    shipped_positions = positions[np.unique(np.concatenate(list(part_tris.values())))]
    manifest = {
        "version": 1,
        "source": {
            "model": "GNM Head v3.0 (Google LLC, Apache-2.0)", "repo": GNM_REPO, "commit": GNM_COMMIT,
            "weights_url": WEIGHTS_URL, "weights_sha256": WEIGHTS_SHA256,
        },
        "units": "meters", "up": "+Y", "forward": "+Z",
        "sigma_scale": float(cfg["export"]["sigma_scale"]),
        "bounds": {"min": shipped_positions.min(axis=0).tolist(), "max": shipped_positions.max(axis=0).tolist()},
        "neck_cap": neck_cap,
        # TEXCOORD_0 on every head mesh: GNM's own layout (one 0..1 space per GNM component), seam vertices split.
        "uvs": with_uvs,
        # head.extra.glb: more morph targets for the same meshes (same vertex order), loaded after the first view
        "extra": {"file": PACKED_EXTRA.name} if split else None,
        "targets": [
            {
                "name": t.name, "kind": t.kind, "region": t.region, "scale": t.scale, "file": "extra" if in_extra(t.name) else "base",
                "max_delta_mm": round(float(np.abs(t.delta).max() * 1000), 3), "meshes": t.meshes,
            }
            for t in targets
        ],
        "meshes": mesh_infos,
        "nodes": {
            node: {
                "pivot": pivots[node].tolist(),
                # How each identity target moves this pivot at weight 1.0 (metres). The web app
                # adds sum(weight * basis) to the pivot so gaze stays centred on the eyeball.
                "identity_pivot_basis": {
                    t.name: t.joint_delta[gnm.joint_names.index(joint)].tolist()
                    for t in targets
                    if t.kind in SHAPE_KINDS and np.abs(t.joint_delta[gnm.joint_names.index(joint)]).max() > 1e-6
                },
            }
            for node, joint in EYE_PIVOTS.items()
        },
    }
    staged[MANIFEST].write_text(json.dumps(manifest, indent=2) + "\n")

    sizes_raw, sizes = file_sizes(RAW_GLB), file_sizes(staged[PACKED_GLB])
    extra_sizes = file_sizes(staged[PACKED_EXTRA]) if split else {"raw": 0, "gzip": 0, "brotli": 0}
    summary = {
        "targets": len(targets), "meshes": len(mesh_infos),
        "vertices": int(sum(m["vertices"] for m in mesh_infos)),
        "triangles": int(sum(m["triangles"] for m in mesh_infos)),
        "raw_bytes": sizes_raw["raw"], "packed": sizes, "extra": extra_sizes, "seconds": round(time.time() - t0, 1),
        "base_targets": sum(1 for t in targets if not in_extra(t.name)), "extra_targets": sum(1 for t in targets if in_extra(t.name)),
    }
    summary["max_targets_per_mesh"] = max(len(m["targets"]) + len(m["extraTargets"]) for m in mesh_infos)
    total = {k: sizes[k] + extra_sizes[k] for k in ("raw", "brotli")}
    (OUT_DIR / "export_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    over = []
    if total["raw"] > BUDGET_DISK:
        over.append(f"{fmt_mb(total['raw'])} on disk (both files) > {fmt_mb(BUDGET_DISK)}")
    if total["brotli"] > BUDGET_BROTLI:
        over.append(f"{fmt_mb(total['brotli'])} brotli (both files) > {fmt_mb(BUDGET_BROTLI)}")
    if summary["max_targets_per_mesh"] > MAX_TARGETS:
        over.append(f"{summary['max_targets_per_mesh']} targets on one mesh > {MAX_TARGETS}")
    if over:
        shutil.rmtree(stage, ignore_errors=True)
        raise SystemExit("head.glb is over budget (the shipped files are unchanged): " + "; ".join(over))
    commit(staged)
    if not split:
        PACKED_EXTRA.unlink(missing_ok=True)
    stage.rmdir()
    return summary


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    s = export(load_config())
    print(f"\nexported {s['targets']} targets ({s['base_targets']} in head.glb + {s['extra_targets']} in head.extra.glb; "
          f"at most {s['max_targets_per_mesh']} per mesh) over {s['meshes']} meshes "
          f"({s['vertices']} vertices, {s['triangles']} triangles) in {s['seconds']} s")
    print(f"  raw    {RAW_GLB.relative_to(REPO_DIR)}: {fmt_mb(s['raw_bytes'])}")
    p = s["packed"]
    print(f"  packed {PACKED_GLB.relative_to(REPO_DIR)}: {fmt_mb(p['raw'])} on disk, "
          f"{fmt_mb(p['gzip'])} gzip, {fmt_mb(p['brotli'])} brotli")
    e = s["extra"]
    if e["raw"]:
        print(f"  packed {PACKED_EXTRA.relative_to(REPO_DIR)}: {fmt_mb(e['raw'])} on disk, "
              f"{fmt_mb(e['gzip'])} gzip, {fmt_mb(e['brotli'])} brotli (loaded after the first view)")
    print(f"  manifest {MANIFEST.relative_to(REPO_DIR)}")
    cfg = load_config()
    if cfg.get("semantic", {}).get("enabled") or cfg.get("emotions", {}).get("enabled"):
        from .sliders_json import main as update_sliders

        update_sliders()  # semantic sliders + emotions in web/src/data/sliders.json follow their configs
    print("run `uv run verify` to check the packed file against the source")
