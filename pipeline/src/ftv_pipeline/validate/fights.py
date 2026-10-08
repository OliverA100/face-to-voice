"""`uv run validate --fights`: which Shape sliders take room from each other?

Two sliders "fight" when one at its end leaves the other less room before the face breaks (eye size vs eye spacing:
both push the eye toward the nose). Measured with the web limiter's own mirror (vlimits.py): how far slider A may go
each way alone, and with slider B at each of its ends. Reported: the share of A's track lost per side, worst first.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor

from ..gnm import OUT_DIR
from . import vlimits
from .model import HeadModel

OUT = OUT_DIR / "validation"


def _reach(job: tuple) -> tuple:
    b, b_end, a, a_end = job
    m, vl = vlimits._ctx["model"], vlimits._ctx["vl"]
    w0 = m.vector(m.expand({b: b_end})) if b else m.vector({})
    d = m.vector(m.expand({a: a_end})) / a_end
    return job, vl.reach(w0, d, a_end)


def run(workers: int = 8, top: int = 30) -> list[dict]:
    m = HeadModel.load()
    rows = json.loads(vlimits.CROSSINGS_JSON.read_text()) if vlimits.CROSSINGS_JSON.exists() else []
    shape = [t for t, s in m.sliders.items() if s["kind"] == "semantic"]
    ends = {t: [e for e in (m.sliders[t]["min"], m.sliders[t]["max"]) if abs(e) > 1e-6] for t in shape}
    jobs = [(None, 0.0, a, e) for a in shape for e in ends[a]]
    jobs += [(b, be, a, e) for b in shape for be in ends[b] for a in shape if a != b for e in ends[a]]
    t0 = time.time()
    with ProcessPoolExecutor(workers, initializer=vlimits._init, initargs=(rows,)) as pool:
        got = dict(pool.map(_reach, jobs, chunksize=16))
    alone = {(a, e): x for (b, _, a, e), x in got.items() if b is None}
    out = []
    for (b, be, a, e), x in got.items():
        if b is None:
            continue
        lost = (abs(alone[(a, e)]) - abs(x)) / abs(e)
        if lost > 0.05:
            out.append({"a": a, "side": "+" if e > 0 else "−", "b": b, "b_end": be, "lost": lost})
    out.sort(key=lambda r: -r["lost"])
    L = ["# Sliders that take room from each other", "",
         "With slider B at one of its ends, the share of slider A's track (that side) the limiter takes away because the "
         "face would break earlier (vertex limiter, vlimits.py). Pairs not listed lose under 5%.", "",
         "| A (side) | B at | A loses |", "|---|---|---:|"]
    L += [f"| {m.sliders[r['a']]['name']} ({r['side']}) | {m.sliders[r['b']]['name']} {r['b_end']:+.2f} | {r['lost'] * 100:.0f}% |"
          for r in out[:top]]
    pairs = len(jobs) - len(alone)
    L += ["", f"{len(out)} of {pairs} (A side, B end) combinations lose more than 5% ({time.time() - t0:.0f} s)."]
    (OUT / "fights.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return out
