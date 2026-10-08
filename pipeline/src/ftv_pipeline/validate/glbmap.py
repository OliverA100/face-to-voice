"""GNM vertex id -> (part, vertex index inside the shipped head.glb mesh).

gltfpack reorders each mesh's vertices, so the web app cannot address a GNM vertex by its id. Like `uv run verify`, we
decode head.glb (out/head.decoded.glb, written by verify, decoded again here when head.glb is newer), put every decoded
vertex in head space and match it to the GNM template; coincident vertices (teeth touching, UV-seam copies) are told apart by their morph deltas. head.extra.glb
keeps the same vertex order (verify checks it), so one map serves both files.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from pygltflib import GLTF2
from scipy.spatial import cKDTree

from ..export_glb import PACKED_GLB
from ..gnm import OUT_DIR
from ..parts import PARTS
from ..tools import gltf_transform
from ..verify_glb import mesh_nodes, read_accessor
from .model import HeadModel

DECODED = OUT_DIR / "head.decoded.glb"


def decoded_glb() -> Path:
    """out/head.decoded.glb, decoded again from head.glb (as `uv run verify` does) when it is missing or older than
    head.glb: an old decode would map the vertices of the previous head."""
    if not PACKED_GLB.exists():
        raise SystemExit(f"{PACKED_GLB} is missing: run `uv run export` first")
    if not DECODED.exists() or DECODED.stat().st_mtime < PACKED_GLB.stat().st_mtime:
        tmp = DECODED.with_name("head.decoded.tmp.glb")
        gltf_transform("copy", PACKED_GLB, tmp)
        os.replace(tmp, DECODED)
    return DECODED


def vertex_map(model: HeadModel, wanted: np.ndarray) -> dict[int, tuple[str, int]]:
    """{GNM vertex id: (part name, decoded vertex index)} for the `wanted` ids."""
    gltf = GLTF2().load_binary(str(decoded_glb()))
    blob = gltf.binary_blob()
    names = [p.name for p in PARTS]
    T = model.gnm.template.astype(np.float64)
    out: dict[int, tuple[str, int]] = {}
    for part, node, world in mesh_nodes(gltf):
        if part not in names:
            continue
        mine = wanted[model.owner[wanted] == names.index(part)]
        if not len(mine):
            continue
        prim = gltf.meshes[node.mesh].primitives[0]
        lin, off = world[:3, :3], world[:3, 3]
        pos = read_accessor(gltf, blob, prim.attributes.POSITION) @ lin.T + off
        # one probe target to tell coincident vertices apart (largest-motion identity target in this mesh)
        tnames = list((gltf.meshes[node.mesh].extras or {}).get("targetNames", []))
        k = tnames.index("head_000") if "head_000" in tnames else (0 if tnames else None)
        dec_delta = None
        if k is not None:
            t = prim.targets[k]
            dec_delta = read_accessor(gltf, blob, t["POSITION"] if isinstance(t, dict) else t.POSITION) @ lin.T
            src_delta = model.deltas[model.names.index(tnames[k])]
        tree = cKDTree(pos)
        for v in mine.tolist():
            d, cand = tree.query(T[v], k=6)
            cand = cand[d < d[0] + 2e-5]
            if dec_delta is not None and len(cand) > 1:
                cand = [cand[int(np.argmin([np.abs(dec_delta[c] - src_delta[v]).sum() for c in cand]))]]
            if d[0] > 5e-5:
                raise RuntimeError(f"GNM vertex {v} ({part}) has no decoded vertex within 50 µm ({d[0] * 1e6:.0f} µm)")
            out[v] = (part, int(cand[0]))
    missing = set(wanted.tolist()) - set(out)
    if missing:
        raise RuntimeError(f"{len(missing)} GNM vertices not in head.glb (e.g. {sorted(missing)[:5]})")
    return out
