# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Does the mouth say each word with the right number of movements? Per word (the aligner's span, truth.json): how
many times the lips open (peaks of the lip gap at least `prom` mm above the dips around them) against how many
syllables the audio has in it (truth.json vowel events: loudness peaks). Extra openings read as jumpy ("coat" mouthed
as two syllables, an extra movement in "grass"); none at all as a word not mouthed ("A king…").

  uv run mouthing.py <bench tag> [<clip prefix, default T>] [-v] [--prom 1.5]
"""
import json, sys
from pathlib import Path
import numpy as np
HERE = Path(__file__).parent


def spans(tr):
    out, cur, k = [], [], 0
    words = tr["words"]
    for l in tr["letters"] + [{"c": "|"}]:
        if l["c"] == "|":
            if cur:
                out.append((words[len(out)].lower() if len(out) < len(words) else "?", cur[0]["s"], cur[-1]["e"]))
            cur = []
        else:
            cur.append(l)
    return out


def openings(T, G, a, b, prom):
    """Peaks of the gap inside [a, b] standing `prom` mm above the lowest point on each side (within the word ±80 ms)."""
    idx = np.where((T >= a - 0.08) & (T <= b + 0.08))[0]
    if len(idx) < 3:
        return 0
    g = G[idx]
    n, last_low, peak = 0, g[0], None
    for k in range(1, len(g)):
        if peak is None:
            if g[k] - last_low >= prom:
                peak = g[k]
            last_low = min(last_low, g[k])
        else:
            if g[k] > peak:
                peak = g[k]
            elif peak - g[k] >= prom:
                t = T[idx[k]]
                n += 1
                peak, last_low = None, g[k]
    if peak is not None:
        n += 1
    return n


if __name__ == "__main__":
    tag = sys.argv[1]
    rx = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("-") else "T"
    prom = float(sys.argv[sys.argv.index("--prom") + 1]) if "--prom" in sys.argv else 1.5
    verbose = "-v" in sys.argv
    tally = {"right": 0, "extra": 0, "missing": 0, "fewer": 0}
    rows = []
    for f in sorted((HERE / "out" / "bench").glob(f"{tag}-{rx}*.json")):
        b = json.loads(f.read_text())
        tr = json.loads(Path(b["clip"][: -len(".ndjson")] + ".truth.json").read_text())
        T = np.array([q["t"] for q in b["frames"]]); G = np.array([q["gap"] for q in b["frames"]])
        for w, a, z in spans(tr):
            syl = sum(1 for e in tr["events"] if e["kind"] == "vowel" and a - 0.02 <= e["peak"] <= z + 0.02)
            if syl == 0:
                continue
            n = openings(T, G, a, z, prom)
            kind = "right" if n == syl else "extra" if n > syl else "missing" if n == 0 else "fewer"
            tally[kind] += 1
            if kind != "right":
                rows.append((f.stem[len(tag) + 1 :], w, syl, n, kind))
    tot = sum(tally.values())
    print(f"{tag}: {tot} words  " + "  ".join(f"{k} {v} ({v / tot * 100:.0f}%)" for k, v in tally.items()))
    if verbose:
        for r in rows:
            print(f"  {r[0]:24} {r[1]:12} syllables {r[2]}  openings {r[3]}  {r[4]}")
