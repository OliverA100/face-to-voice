# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Real lips (GRID, grid.py) against the app's (bench.sh output), measured the same way: per line, the lips count as
shut within 15% of that line's range of lip gap above its smallest; per p/b/m, when the gap starts closing, when it is
shut and when it opens, against when the sound falls ("on") and the burst. Split by what comes before the p/b/m: a
vowel ("by" in "set red by…") or silence (a line's first word, after a pause).

  uv run human.py <bench tag> [<set regex, default ^T\\d (the tuning set)>]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
GRID = HERE / "out" / "grid"
BENCH = HERE / "out" / "bench"
ALIGN = GRID / "align" / "alignments"


def human() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"vowel": [], "silence": []}
    for f in sorted(GRID.glob("s*.jsonl")):
        talker = f.stem
        for line in open(f):
            r = json.loads(line)
            al = ALIGN / talker / f"{r['video']}.align"
            if not al.exists():  # some talkers' timings are filed under another number (grid.py)
                al = next(iter(sorted(ALIGN.glob(f"*/{r['video']}.align"))))
            ws = [(int(a) / 25000, int(b) / 25000, w) for a, b, w in (l.split() for l in al.read_text().split("\n") if len(l.split()) == 3)]
            for e in r["events"]:
                if "seal" not in e:
                    continue
                # the word before the p/b/m's word: silence or a word ending in a vowel sound (GRID's words)
                k = next((i for i, (a, b, w) in enumerate(ws) if w == e["word"] and a <= e["on"] + 0.12 and b >= e["on"]), None)
                prev = ws[k - 1][2] if k else "sil"
                ctx = "silence" if prev == "sil" else "vowel" if re.search(r"[aeiouy]$|ue$|ee$", prev) or prev in ("two", "three", "now", "again", "by") else None
                if ctx:
                    out[ctx].append(e)
    return out


def app(tag: str, rx: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"vowel": [], "silence": []}
    for f in sorted(BENCH.glob(f"{tag}-*.json")):
        if not re.match(rx, f.stem[len(tag) + 1 :]):
            continue
        b = json.loads(f.read_text())
        clip = Path(b.get("clip", ""))
        truth = json.loads(Path(b["truth"]).read_text()) if "truth" in b else json.loads(Path(str(clip)[: -len(".ndjson")] + ".truth.json").read_text())
        T = np.array([q["t"] for q in b["frames"]])
        G = np.array([q["gap"] for q in b["frames"]])
        voiced = (T >= truth["voice"][0]) & (T <= truth["voice"][1])
        if voiced.sum() < 10:
            continue
        lo, hi = np.percentile(G[voiced], [2, 95])
        shut = lo + 0.15 * (hi - lo)
        ev = sorted(truth["events"], key=lambda e: e.get("on", e.get("s", e.get("peak", 0))))
        for i, e in enumerate(ev):
            if e["kind"] != "closure" or e.get("weak"):
                continue
            on, burst = e["on"], e["release"]
            before = [x for x in ev[:i] if x["kind"] == "vowel"]
            ctx = "vowel" if before and on - before[-1]["peak"] < 0.25 else "silence"
            w = np.where((T >= on - 0.25) & (T <= burst + 0.15))[0]
            closed = w[G[w] <= shut]
            if not len(closed):
                continue
            runs = np.split(closed, np.where(np.diff(closed) > 1)[0] + 1)
            mid = (on + burst) / 2
            r = min(runs, key=lambda q: abs((T[q[0]] + T[q[-1]]) / 2 - mid))
            k = r[0]
            while k > w[0] and G[k - 1] >= G[k] and T[r[0]] - T[k - 1] < 0.3:
                k -= 1
            out[ctx].append({"close_start": T[k] - on, "seal": T[r[0]] - on, "release": T[min(r[-1] + 1, len(T) - 1)] - burst})
    return out


def human_fv_vowels() -> tuple[list[float], list[float]]:
    fv, vw = [], []
    for f in sorted(GRID.glob("s*.jsonl")):
        for line in open(f):
            r = json.loads(line)
            fv += [e["off"] for e in r.get("fv", [])]
            vw += [e["off"] for e in r.get("vowels", [])]
    return fv, vw


def app_fv_vowels(tag: str, rx: str) -> tuple[list[float], list[float]]:
    """As bench.py scores them: f/v = the smallest gap near the hiss onset; vowels = the widest point vs the loudest."""
    sys.path.insert(0, str(HERE))
    from bench import score

    fv, vw = [], []
    for f in sorted(BENCH.glob(f"{tag}-*.json")):
        if re.match(rx, f.stem[len(tag) + 1 :]):
            rows, _ = score(f)
            fv += [r["off"] for r in rows if r["kind"] == "fv"]
            vw += [r["off"] for r in rows if r["kind"] == "vowel"]
    return fv, vw


def show_fv(name: str, fv: list[float], vw: list[float]) -> None:
    q = lambda v: f"{np.median(v) * 1000:+4.0f} (IQR {np.percentile(v, 25) * 1000:+4.0f}..{np.percentile(v, 75) * 1000:+4.0f}, n {len(v)})" if len(v) else "–"
    print(f"{name:10} f/v lips to teeth vs hiss {q(fv)}   vowel widest vs loudest {q(vw)}")


def show(name: str, d: dict[str, list[dict]]) -> None:
    for ctx, ev in d.items():
        if not ev:
            continue
        cols = []
        for k in ("close_start", "seal", "release"):
            v = np.array([e[k] for e in ev]) * 1000
            cols.append(f"{k} {np.median(v):+4.0f} (IQR {np.percentile(v, 25):+4.0f}..{np.percentile(v, 75):+4.0f})")
        print(f"{name:10} after {ctx:7} n {len(ev):4}  " + "  ".join(cols))


if __name__ == "__main__":
    show("human", human())
    show_fv("human", *human_fv_vowels())
    if len(sys.argv) > 1:
        rx = sys.argv[2] if len(sys.argv) > 2 else r"^T\d"
        show(sys.argv[1], app(sys.argv[1], rx))
        show_fv(sys.argv[1], *app_fv_vowels(sys.argv[1], rx))
