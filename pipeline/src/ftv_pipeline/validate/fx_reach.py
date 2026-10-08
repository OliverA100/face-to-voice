"""How far each fine-tune control may go on top of each emotion (web/src/data/fxReach.json).

    uv run validate --fx-reach        # after `uv run export` and `uv run validate --sweep/--ends` (the slider ends)

A fine-tune control adds to the emotion, and two things stop it:

1. **What faces can do.** Every expression measure (lid opening, brow height, jaw drop, corner raise …, per side) has
   an envelope: the furthest any real expression takes it, i.e. the app's emotions and GNM's sampler labels (one
   typical sample each). Emotion + fine-tune may not go past it (by more than ENVELOPE_TOL_MM): Surprised already opens
   the eyes about as wide as eyes go, so "Eyes wide" adds little there. The measures are linear in the weights, so the
   app recomputes this exactly for any emotion mix, intensity and other fine-tune values (lib/morphs/fxReach.ts).
2. **Geometry.** On the average face, emotion + control is exact-checked (checks.py) and the control stops before it
   breaks anything the emotion alone does not (ANIM_WORSE_MM more where the emotion alone already touches). Stored
   per emotion at full strength; the app interpolates by the emotion's weight.

The app maps each slider's full travel onto what is allowed, so a slider end always means "as far as this emotion
allows" and the emotion itself is never pushed out (a fine-tune that took all the room would leave the animation caps
fading the emotion away).
"""
from __future__ import annotations

import json
import time
import tomllib
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from .. import emotions as E
from ..gnm import GNM, REPO_DIR
from .checks import Checker
from .model import HeadModel
from .stress import ANIM_WORSE_MM
from .vlimits import CONFIG, REPORT_ONLY

OUT_JSON = REPO_DIR / "web" / "src" / "data" / "fxReach.json"
ENVELOPE_TOL_MM = 0.3  # how far past the furthest real expression a measure may go (noise, rounding)
MIN_RATE_MM = 0.05  # a control that moves a measure less than this per unit is not limited by it
BISECT = 7  # geometry: steps of the search for where a control breaks (1/128 of its travel)

_ctx: dict = {}


def measure_rows(sol: E.GoalSolver) -> tuple[list[str], np.ndarray]:
    """Every expression measure, each side apart (mm per GNM σ, linearised)."""
    names, rows = [], []
    for n, rs in sol.rows.items():
        if n in E.ONE_SIDED:  # the same rows as the sided ones below
            continue
        for k, r in enumerate(rs):
            names.append(n + (("_l", "_r")[k] if len(rs) == 2 else ""))
            rows.append(r)
    return names, np.array(rows)


def _init() -> None:
    m = HeadModel.load()
    with open(CONFIG, "rb") as f:
        _ctx.update(m=m, ch=Checker(m, tomllib.load(f)))


def _fails(w: np.ndarray) -> dict[str, float]:
    m, ch = _ctx["m"], _ctx["ch"]
    res = ch.run(m.positions(w), m.pivots(w))
    return {k: float(r.value) for k, r in res.items() if r.fail and k not in REPORT_ONLY}


def control_direction(m: HeadModel, ctl: str, side: int) -> np.ndarray:
    """Target weights per unit of |value| on one side of a control: the weights at value `side` (±1), which already
    point the way that side goes (its comboNeg, or the combo reversed)."""
    return m.vector(m.expand({ctl: side}))


def _geo(job: tuple) -> tuple:
    """(emotion, control, side) -> how far (control units) before it breaks what the emotion alone does not."""
    emo, ctl, side, top = job
    m = _ctx["m"]
    w0 = m.vector({f"emo_{emo}_upper": 1.0, f"emo_{emo}_lower": 1.0}) if emo != "neutral" else np.zeros(len(m.names), np.float32)
    d = control_direction(m, ctl, side)
    base = _fails(w0)

    def ok(t: float) -> bool:
        return all(k in base and v <= base[k] + ANIM_WORSE_MM for k, v in _fails(w0 + t * d).items())

    if top <= 0 or ok(top):
        return emo, ctl, side, max(top, 0.0)
    good, bad = 0.0, top
    for _ in range(BISECT):
        mid = (good + bad) / 2
        good, bad = (mid, bad) if ok(mid) else (good, mid)
    return emo, ctl, side, good


def run(workers: int = 8) -> None:
    t0 = time.time()
    gnm = GNM.load()
    doc = E.load_doc()
    sol = E.GoalSolver(gnm)
    names, M = measure_rows(sol)
    emos = E.resolve(gnm, doc, sol)
    # the envelope: the furthest any real expression takes each measure (the app's emotions, GNM's labels, rest)
    real = [M @ (r.upper + r.lower) for r in emos] + [M @ E.label_vector(doc, l) for l in doc["labels"]] + [np.zeros(len(names))]
    lo, hi = np.min(real, 0), np.max(real, 0)

    sliders = {s["target"]: s for s in json.loads((REPO_DIR / "web" / "src" / "data" / "sliders.json").read_text())["sliders"]}
    controls = {}
    for c in E.solve_controls(gnm, sol):
        if "vector" not in c:  # pupil size: not an expression
            continue
        t = E.CONTROL_PREFIX + c["id"]
        s = sliders[t]
        neg = c["vector_neg"] if "vector_neg" in c else -c["vector"]
        controls[t] = {"ends": [float(s["min"]), float(s["max"])], "pos": M @ c["vector"], "neg": M @ neg}

    def env_reach(base: np.ndarray, a: np.ndarray, end: float) -> float:
        t = end
        for j in np.flatnonzero(np.abs(a) >= MIN_RATE_MM):
            lim = (hi[j] + ENVELOPE_TOL_MM - base[j]) / a[j] if a[j] > 0 else (lo[j] - ENVELOPE_TOL_MM - base[j]) / a[j]
            t = min(t, max(0.0, lim))
        return t

    states = {"neutral": np.zeros(len(names)), **{r.id: M @ (r.upper + r.lower) for r in emos}}
    jobs = []
    for e, base in states.items():
        for t, c in controls.items():
            for side, end in ((-1, -c["ends"][0]), (1, c["ends"][1])):
                if end > 1e-6:
                    jobs.append((e, t, side, env_reach(base, c["pos"] if side > 0 else c["neg"], end)))
    with ProcessPoolExecutor(workers, initializer=_init) as ex:
        found = list(ex.map(_geo, jobs, chunksize=2))
    geo = {t: {e: [0.0, 0.0] for e in states} for t in controls}
    for e, t, side, x in found:
        geo[t][e][0 if side < 0 else 1] = round(x, 3)

    r2 = lambda a: [round(float(x), 2) for x in a]  # noqa: E731
    out = {
        "note": "generated by `uv run validate --fx-reach` (pipeline/src/ftv_pipeline/validate/fx_reach.py): expression "
                "measures (mm, each side apart), the furthest real expressions take them (lo/hi), each emotion part's "
                "and each fine-tune control's change per unit, and per control the geometric reach on each emotion "
                "at full strength ([negative side, positive side] in control units, on the average face)",
        "tolMm": ENVELOPE_TOL_MM,
        "minRateMm": MIN_RATE_MM,
        "measures": names,
        "lo": r2(lo),
        "hi": r2(hi),
        "emotions": {r.id: {"upper": r2(M @ r.upper), "lower": r2(M @ r.lower)} for r in emos},
        "controls": {t: {"pos": r2(c["pos"]), "neg": r2(c["neg"]), "geo": geo[t]} for t, c in controls.items()},
    }
    OUT_JSON.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"-> {OUT_JSON.relative_to(REPO_DIR)}: {OUT_JSON.stat().st_size / 1024:.1f} KB, {len(jobs)} geometry searches "
          f"({time.time() - t0:.0f} s)")
    # the report: what each control may do on each emotion (share of its travel: envelope / geometry)
    print(f"\n{'':11s}" + "".join(f"{t[3:13]:>11s}- {t[3:13]:>11s}+" for t in controls))
    for e, base in states.items():
        cells = []
        for t, c in controls.items():
            for i, (side, end) in enumerate(((-1, -c["ends"][0]), (1, c["ends"][1]))):
                if end <= 1e-6:
                    cells.append(f"{'·':>12s}")
                    continue
                env = env_reach(base, c["pos"] if side > 0 else c["neg"], end) / end
                cells.append(f"{env:5.2f}/{geo[t][e][i] / end:4.2f} ")
        print(f"{e:11s}" + "".join(cells))
