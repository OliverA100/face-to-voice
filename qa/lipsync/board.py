# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""The scoreboard: a bench tag's scores per set of lines, so tuning (on one set) never hides what happens on the others.

Sets, by the clip's character: tune = T* (Harvard lists 5–34: tune on this one only), held = S* (Harvard 1–4, ARCTIC),
test2 = U* and test3 = W* (ARCTIC), conv = V* (sets/conversation.json), stress = the original lines (A, B, C, D*, E*:
tongue twisters and m-heavy lines; a regression check, not a target). The last four are for final checks only.

p/b/m at the end of a phrase (nothing sounded within 250 ms after their release: "time.", "Tom,") are counted apart:
the lips stay shut into the pause, which is natural, and there is no release to time.

  ./bench.sh --tag NAME out/clips/*.ndjson && uv run board.py NAME [NAME2 …]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

from bench import BENCH, score

SETS = [("tune", r"^T\d"), ("held", r"^S\d"), ("test2", r"^U\d"), ("test3", r"^W\d"), ("conv", r"^V\d"), ("stress", r"^(A|B|C|D\d|E\d)-")]


def finals(truth: dict) -> set[float]:
    """The onsets of the p/b/m with nothing sounded within 250 ms after their release."""
    ev = sorted(truth["events"], key=lambda e: e.get("on", e.get("s", e.get("peak", 0))))
    out = set()
    for i, e in enumerate(ev):
        if e["kind"] != "closure":
            continue
        later = [x.get("peak", x.get("on", x.get("s"))) for x in ev[i + 1 :] if x.get("on", x.get("s", x.get("peak", 0))) > e["release"] - 0.01]
        if not later or min(later) > e["release"] + 0.25:
            out.add(round(e["on"], 3))
    return out


def row(tag: str, rx: str) -> str | None:
    files = [f for f in sorted(BENCH.glob(f"{tag}-*.json")) if re.match(rx, f.stem[len(tag) + 1 :])]
    if not files:
        return None
    cl, vw, fv, mo = [], [], [], []
    for f in files:
        rows, b = score(f)
        clip = Path(b.get("clip", ""))
        truth = json.loads(Path(b["truth"]).read_text()) if "truth" in b else json.loads(Path(str(clip)[: -len(".ndjson")] + ".truth.json").read_text())
        fin = finals(truth)
        for r in rows:
            if r["kind"] == "closure":
                r["final"] = round(r["t"], 3) in fin
                cl.append(r)
            elif r["kind"] == "vowel":
                vw.append(r)
            elif r["kind"] == "fv":
                fv.append(r["off"])
            elif r["kind"] == "motion":
                mo.append(r)
    mid = [r for r in cl if not r["final"]]
    s = [r for r in mid if "seal" in r]
    rel = np.array([r["release_off"] for r in s]) * 1000
    ms = lambda v: f"{np.median(v) * 1000:+4.0f}" if len(v) else "   –"
    return (
        f"{len(files):4} {len(s):4}/{len(mid):<4} {np.median(rel):+4.0f} {np.percentile(np.abs(rel), 90):4.0f} {int((rel > 100).sum()):4} {int((rel < -100).sum()):4} "
        f"{ms([r['seal'] for r in s])} {ms([r['close_start'] for r in s if 'close_start' in r])} {ms([r['off'] for r in vw])} "
        f"{np.percentile(np.abs([r['off'] for r in vw]), 90) * 1000:4.0f} {ms(fv)} {np.median([r['maxGap'] for r in vw]):5.1f} {np.mean([m['vmax'] for m in mo]):4.0f} {np.mean([m['acc95'] for m in mo]):4.1f}"
        f"   final {sum(1 for r in cl if r['final'])}"
    )


if __name__ == "__main__":
    print(f"{'tag':14} {'set':6} lines sealed     rel  p90 late early  seal close vowel vp90   fv  open  vmax  acc")
    for tag in sys.argv[1:]:
        for name, rx in SETS:
            r = row(tag, rx)
            if r:
                print(f"{tag:14} {name:6} {r}")
