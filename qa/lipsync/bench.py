# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Scores bench.ts runs (out/bench/*.json) against each line's audio truth (out/clips/<line>.truth.json) with the
rules of events.py, on the mouth's lip gap in mm (sealed = gap ≤ SEAL_MM). Negative = the mouth is early.

  uv run bench.py <tag> [<tag> …]        → one summary line per tag (all its lines pooled) + per-line rows with -v
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
BENCH = HERE / "out" / "bench"
SEAL_MM = 0.5  # lip gap (mm from rest) at or under which the lips count as closed


def score(path: Path):
    b = json.loads(path.read_text())
    clip = Path(b.get("clip", ""))
    truth = json.loads(Path(b["truth"]).read_text()) if "truth" in b else json.loads(Path(str(clip)[: -len(".ndjson")] + ".truth.json").read_text())
    T = np.array([f["t"] for f in b["frames"]])
    G = np.array([f["gap"] for f in b["frames"]])
    J = np.array([f["jaw"] for f in b["frames"]])
    closures = [e for e in truth["events"] if e["kind"] == "closure" and not e.get("weak")]
    mids = [(e["on"] + e["release"]) / 2 for e in closures]
    rows = []
    for e in truth["events"]:
        if e["kind"] == "closure" and not e.get("weak"):
            on, rel = e["on"], e["release"]
            mid = (on + rel) / 2
            w = (T >= on - 0.15) & (T <= rel + 0.15)
            si = np.where(w & (G <= SEAL_MM))[0]
            groups = [g for g in (np.split(si, np.where(np.diff(si) > 1)[0] + 1) if len(si) else []) if min(mids, key=lambda m: abs(m - (T[g[0]] + T[g[-1]]) / 2)) == mid]
            r = {"kind": "closure", "c": e["c"], "word": e["word"], "t": on}
            if groups:
                g = min(groups, key=lambda g: abs((T[g[0]] + T[g[-1]]) / 2 - mid))
                r["seal"] = float(T[g[0]] - on)
                r["release_off"] = float(T[min(g[-1] + 1, len(T) - 1)] - rel)
                r["seal_ms"] = float(T[g[-1]] - T[g[0]]) * 1000
                k = g[0]
                lo = np.searchsorted(T, T[g[0]] - 0.3)
                while k > lo and G[k - 1] >= G[k]:
                    k -= 1
                r["close_start"] = float(T[k] - on)
            else:
                r["unsealed"] = True
                r["minGap"] = float(G[w].min()) if w.any() else None
            rows.append(r)
        elif e["kind"] == "vowel":
            pk = e["peak"]
            w = np.where((T >= max(e["s"] - 0.04, pk - 0.15)) & (T <= min(e["e"] + 0.04, pk + 0.15)))[0]
            if len(w) < 2:
                continue
            gm = G[w].max()
            top = w[G[w] >= gm - 0.3]
            # squeezed: a closure ends within 120 ms before the vowel's peak and another starts within 120 ms after it
            before = any(0 < pk - c["release"] < 0.12 for c in closures)
            after = any(0 < c["on"] - pk < 0.12 for c in closures)
            rows.append({"kind": "vowel", "c": e["letters"], "word": e["word"], "t": pk, "off": float(T[top].mean() - pk), "maxGap": float(gm), "level": e["level"], "squeezed": before and after})
        elif e["kind"] == "fv":
            w = np.where((T >= e["on"] - 0.12) & (T <= e["off"] + 0.04))[0]
            if len(w) < 2:
                continue
            k = w[int(np.argmin(G[w]))]
            rows.append({"kind": "fv", "c": e["c"], "word": e["word"], "t": e["on"], "off": float(T[k] - e["on"])})
    # jumpiness: lip-gap speed and acceleration, and how often the gap changes direction (per second of voice)
    v = np.diff(G) * b["fps"]
    a = np.diff(v) * b["fps"] / 1000  # m/s²
    rev = int(np.sum(np.sign(v[1:]) * np.sign(v[:-1]) < 0 & (np.abs(v[1:]) > 5)))
    dur = T[-1] - T[0]
    rows.append({"kind": "motion", "vmax": float(np.percentile(np.abs(v), 99)), "acc95": float(np.percentile(np.abs(a), 95)), "rev_per_s": rev / dur})
    return rows, b


def main(tags, verbose):
    for tag in tags:
        files = sorted(BENCH.glob(f"{tag}-*.json"))
        allrows = []
        for f in files:
            rows, b = score(f)
            allrows += rows
            if verbose:
                print(f"  {f.stem}")
                for r in rows:
                    print("    ", {k: (round(v * 1000) if isinstance(v, float) and k in ("seal", "release_off", "close_start", "off") else v) for k, v in r.items() if k != "t"})
        cl = [r for r in allrows if r["kind"] == "closure"]
        s = [r for r in cl if "seal" in r]
        med = lambda v: f"{1000 * np.median(v):+.0f}" if len(v) else "–"
        p90 = lambda v: f"{1000 * np.percentile(np.abs(v), 90):.0f}" if len(v) else "–"
        rel = [r["release_off"] for r in s]
        late = sum(1 for v in rel if v > 0.1)
        vw = [r["off"] for r in allrows if r["kind"] == "vowel"]
        fv = [r["off"] for r in allrows if r["kind"] == "fv"]
        mo = [r for r in allrows if r["kind"] == "motion"]
        vg = [r["maxGap"] for r in allrows if r["kind"] == "vowel"]
        sq = [r["maxGap"] for r in allrows if r["kind"] == "vowel" and r["squeezed"]]
        shut = sum(1 for v in sq if v < 1.0)
        print(
            f"{tag:24} lines {len(files):2}  sealed {len(s)}/{len(cl)}  release {med(rel)} (p90 {p90(rel)}, >100 late {late})  seal {med([r['seal'] for r in s])}"
            f"  close-start {med([r['close_start'] for r in s])}  vowel {med(vw)} (p90 {p90(vw)})  fv {med(fv)}"
            f"  | vowel opening med {np.median(vg):.1f} mm, squeezed {np.median(sq) if sq else 0:.1f} mm ({shut}/{len(sq)} under 1 mm)"
            f"  | lip speed p99 {np.mean([m['vmax'] for m in mo]):.0f} mm/s, accel p95 {np.mean([m['acc95'] for m in mo]):.1f} m/s², reversals {np.mean([m['rev_per_s'] for m in mo]):.1f}/s"
        )


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if not a.startswith("-")], "-v" in sys.argv)
