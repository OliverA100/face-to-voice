"""`uv run validate --sweep`: where does each slider, alone, first break the face?

Every Shape, Advanced and Fine-tune slider is pushed from the average face toward each of its ends (the wide ends
from `uv run slider-ranges`, or its sliders.json end): a coarse walk, then bisection to the first state where an exact
check fails (checks.py; symmetry and folded creases are reported, never a break). The slider's end becomes that
point minus a small margin. Each break also seeds the web limiter's crossing triangles (vlimits.py).

Writes config/slider_breaks.json (committed; sliders_json.py takes the nearer of the anthropometric end and the
break) and out/validation/sweep.json / sweep.md.
"""
from __future__ import annotations

import json
import time
import tomllib
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from ..gnm import OUT_DIR, PIPELINE_DIR
from .checks import Checker
from .model import HeadModel

CONFIG = PIPELINE_DIR / "config" / "validation.toml"
SLIDER_RANGES = PIPELINE_DIR / "config" / "slider_ranges.json"
SLIDER_BREAKS = PIPELINE_DIR / "config" / "slider_breaks.json"
OUT = OUT_DIR / "validation"
SWEPT_KINDS = ("semantic", "identity", "expression", "control")
# reported, never a break: symmetry; folded = skin turned over without passing through itself, i.e. a sharp crease
# (a lowered brow hooding the lid); skin that does pass through itself is self_intersect
NOT_A_BREAK = ("symmetry", "folded")

_ctx: dict = {}


def _init() -> None:
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    model = HeadModel.load()
    _ctx.update(cfg=cfg, model=model, checker=Checker(model, cfg))


def _broken(target: str, x: float) -> tuple[bool, dict]:
    m, ch = _ctx["model"], _ctx["checker"]
    w = m.vector(m.expand({target: x}))
    res = ch.run(m.positions(w), m.pivots(w))
    return any(r.fail for k, r in res.items() if k not in NOT_A_BREAK), res


def sweep_side(args: tuple[str, float]) -> dict:
    """First break between 0 and `end` (signed) for one slider."""
    target, end = args
    sc = _ctx["cfg"]["sweep"]
    t0 = time.time()
    prev, hit = 0.0, None
    for x in np.linspace(0.0, end, int(sc["coarse_steps"]) + 1)[1:]:
        bad, res = _broken(target, float(x))
        if bad:
            hit = float(x)
            break
        prev = float(x)
    out = {"target": target, "end": end, "break": None, "checks": {}, "seconds": 0.0}
    if hit is not None:
        lo, hi = prev, hit
        for _ in range(int(sc["bisect_steps"])):
            mid = (lo + hi) / 2
            if _broken(target, mid)[0]:
                hi = mid
            else:
                lo = mid
        bad, res = _broken(target, hi)
        out.update({"break": hi, "safe": lo,
                    "checks": {k: round(r.value, 3) for k, r in res.items() if r.fail and k not in NOT_A_BREAK}})
    out["seconds"] = round(time.time() - t0, 1)
    return out


def candidate_ends(model: HeadModel) -> dict[str, tuple[float, float]]:
    """target -> (min, max) to sweep: the anthropometric ends where they exist, the configured ends for fine-tune
    controls, else the slider's own ends. A control's sliders.json end is already pulled in to its break, so sweeping
    only to there would find it clean and drop the cap."""
    from ..emotions import CONTROL_PREFIX, control_ends, load_controls

    ranges = json.loads(SLIDER_RANGES.read_text()) if SLIDER_RANGES.exists() else {}
    controls = {CONTROL_PREFIX + c["id"]: control_ends(c) for c in load_controls()["control"]}
    out = {}
    for t, s in model.sliders.items():
        if s["kind"] not in SWEPT_KINDS:
            continue
        lo, hi = controls.get(t, (s["min"], s["max"]))
        r = ranges.get(t, {})
        out[t] = (float(r.get("min", lo)), float(r.get("max", hi)))
    return out


def run(only: list[str] | None = None, workers: int = 10) -> dict:
    model = HeadModel.load()
    ends = candidate_ends(model)
    jobs = [(t, e) for t, (lo, hi) in ends.items() if not only or t in only for e in (lo, hi) if abs(e) > 1e-6]
    with open(CONFIG, "rb") as f:
        margin = float(tomllib.load(f)["sweep"]["margin"])
    t0 = time.time()
    results = []
    with ProcessPoolExecutor(workers, initializer=_init) as pool:
        for k, r in enumerate(pool.map(sweep_side, jobs), 1):
            results.append(r)
            tag = f"breaks at {r['break']:+.2f} ({', '.join(r['checks'])})" if r["break"] is not None else "clean"
            print(f"[{k}/{len(jobs)}] {r['target']:24s} → {r['end']:+.2f}: {tag}  {r['seconds']}s", flush=True)
    print(f"swept {len(jobs)} slider ends in {time.time() - t0:.0f} s")

    breaks = json.loads(SLIDER_BREAKS.read_text()) if (only and SLIDER_BREAKS.exists()) else {}
    for r in results:
        side = "min" if r["end"] < 0 else "max"
        entry = breaks.setdefault(r["target"], {})
        if r["break"] is None:
            entry.pop(side, None)
        else:
            entry[side] = {"end": round(r["safe"] * (1 - margin), 3), "break": round(r["break"], 3), "checks": r["checks"]}
        if not entry:
            breaks.pop(r["target"])
    SLIDER_BREAKS.write_text(json.dumps(breaks, indent=1) + "\n")
    OUT.mkdir(parents=True, exist_ok=True)
    old = json.loads((OUT / "sweep.json").read_text()) if (only and (OUT / "sweep.json").exists()) else []
    keep = [o for o in old if (o["target"], o["end"]) not in {(r["target"], r["end"]) for r in results}]
    allres = keep + results
    (OUT / "sweep.json").write_text(json.dumps(allres, indent=1))
    write_markdown(allres, model, OUT / "sweep.md")
    return breaks


def write_markdown(results: list[dict], model: HeadModel, path) -> None:
    by = {}
    for r in results:
        by.setdefault(r["target"], {})["min" if r["end"] < 0 else "max"] = r
    L = ["# Break sweep: each slider alone, from the average face to its ends", "",
         "break = first weight where an exact check fails (checks.py), with the failing checks and their values "
         "(mm, or crossing triangle pairs / folded triangles). clean = no break up to the end.", "",
         "| slider | kind | −end | − side | +end | + side |", "|---|---|---:|---|---:|---|"]

    def cell(r):
        if not r:
            return "—"
        if r["break"] is None:
            return "clean"
        return f"breaks at {r['break']:+.2f}: " + ", ".join(f"{k} {v:g}" for k, v in r["checks"].items())

    for t, sides in by.items():
        s = model.sliders[t]
        lo, hi = sides.get("min"), sides.get("max")
        L.append(f"| {s['name']} | {s['kind']} | {lo['end'] if lo else 0:+.2f} | {cell(lo)} | {hi['end'] if hi else 0:+.2f} | {cell(hi)} |")
    path.write_text("\n".join(L) + "\n")

