"""Grow the vertex limiter from faces made elsewhere (the web app's random faces, the stress test): exact-check each
face; every broken one adds the triangles of its crossings to config/limit_crossings.json, then limits.json is
re-exported. `uv run python -m ftv_pipeline.validate.grow faces.json [...]` (faces: lists of {target: weight})."""
from __future__ import annotations

import json
import sys
import tomllib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .checks import Checker
from .model import HeadModel
from .vlimits import CONFIG, REPORT_ONLY, VLimits, export, save_crossings

_ctx: dict = {}


def _init() -> None:
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    m = HeadModel.load()
    ch = Checker(m, cfg)
    _ctx.update(m=m, ch=ch, vl=VLimits.build(m, ch, cfg))


def _one(w: dict) -> tuple[list[str], list[int]]:
    m, ch, vl = _ctx["m"], _ctx["ch"], _ctx["vl"]
    w = {k: v for k, v in w.items() if k in m.names or k in m.sliders}
    vec = m.vector(m.expand(w))
    P, piv = m.positions(vec), m.pivots(vec)
    res = ch.run(P, piv)
    bad = [k for k, r in res.items() if r.fail and k not in REPORT_ONLY]  # what the limiter guards, as in vlimits
    return bad, (vl.tris_from_break(ch, P, piv) if bad else [])


def grow(faces: list[dict], workers: int = 8) -> dict:
    with ProcessPoolExecutor(workers, initializer=_init) as pool:
        results = list(pool.map(_one, faces, chunksize=4))
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    m = HeadModel.load()
    ch = Checker(m, cfg)
    vl = VLimits.build(m, ch, cfg)
    kinds: dict[str, int] = {}
    for bad, _ in results:
        for k in bad:
            kinds[k] = kinds.get(k, 0) + 1
    added = vl.add_tris([t for _, tris in results for t in tris])
    save_crossings(vl)
    export(vl)
    broken = sum(1 for bad, _ in results if bad)
    print(f"{len(faces)} faces: {broken} broken {kinds}; +{added} triangles (total {len(vl.tris)})")
    return {"faces": len(faces), "broken": broken, "kinds": kinds, "added": added}


def measure(sets: dict[str, list[dict]], workers: int = 8) -> dict:
    """Exact-check named sets of faces without changing anything: {name: (faces, broken, {check: count})}."""
    out = {}
    with ProcessPoolExecutor(workers, initializer=_init) as pool:
        for name, faces in sets.items():
            bad = [b for b, _ in pool.map(_one, faces, chunksize=4) if b]
            kinds: dict[str, int] = {}
            for b in bad:
                for k in b:
                    kinds[k] = kinds.get(k, 0) + 1
            out[name] = (len(faces), len(bad), kinds)
            print(f"{name:10s} {len(faces):4d} faces, broken by the exact checks: {len(bad)} {kinds}", flush=True)
    return out


if __name__ == "__main__":
    # --measure name=path.json …: a list of faces, {level: {"faces": [...]}} per Distinctiveness, or a dump of
    # {"faces": [{"weights"}], "characters": [{"weights"}]}
    if sys.argv[1] == "--measure":
        sets = {}
        for arg in sys.argv[2:]:
            name, path = arg.split("=", 1)
            doc = json.loads(Path(path).read_text())
            if isinstance(doc, dict) and "faces" in doc and isinstance(doc["faces"], list) and doc["faces"] and "weights" in doc["faces"][0]:
                sets[name + ":sheet"] = [f["weights"] for f in doc["faces"]]
                sets[name + ":characters"] = [p["weights"] for p in doc["characters"]]
            elif isinstance(doc, dict):
                sets.update({f"{name}:D{k}": v["faces"] for k, v in doc.items()})
            else:
                sets[name] = doc
        measure(sets)
        sys.exit(0)
    faces = []
    for path in sys.argv[1:]:
        doc = json.loads(Path(path).read_text())
        for v in (doc.values() if isinstance(doc, dict) else [doc]):
            faces += v["faces"] if isinstance(v, dict) else v
    grow(faces)
