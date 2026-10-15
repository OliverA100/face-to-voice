# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Is each word's mouth on that word? The timing scores (bench.py) only ask whether the mouth opens where the sound is
loud, and the loudness gate opens it there whatever shape it shows: a line whose shapes run a word behind still scores
well. Here each word's cues (grouped by the word they were stamped for) are compared with the span the aligner hears
that word in (truth.json letters): the offset of their middles, and whether they overlap at all.

  uv run wordsync.py <bench tag> [<clip prefix, default T>] [-v]
"""
import json, re, sys
from pathlib import Path
import numpy as np
HERE = Path(__file__).parent
VOWELS = {"aa", "E", "I", "O", "U"}


def words_heard(tr):
    spans, cur = [], []
    for l in tr["letters"] + [{"c": "|"}]:
        if l["c"] == "|":
            if cur:
                spans.append((cur[0]["s"], cur[-1]["e"]))
            cur = []
        else:
            cur.append(l)
    return spans


def line(b, tr):
    """[(word index, heard span, cue span)] for the words whose cue groups and heard words line up one to one."""
    groups = {}
    for c in b["cues"]:
        if c.get("ws") is None or c["v"] not in VOWELS:
            continue
        groups.setdefault(c["ws"], []).append(c)
    stamped = [groups[k] for k in sorted(groups)]
    heard = words_heard(tr)
    nd = Path(b["clip"]).read_text()
    text = "".join("".join((json.loads(l).get("alignment") or {}).get("characters") or []) for l in nd.splitlines() if l.strip())
    tagged = text.lstrip().startswith("[")
    # words with a vowel cue, in order; the aligner's words in order (tags are not words to it)
    toks = [w for w in re.sub(r"\[[^\]]*\]", " ", text).split() if re.search(r"[A-Za-z0-9]", w)]
    if len(toks) != len(heard):
        return tagged, None
    # map each cue group (by stamped word start) to the token it belongs to: the stamps' order is the words' order
    starts = sorted(groups)
    rows = []
    ws_of_tok = []
    k = 0
    # every token has a stamped start; tokens without a vowel cue (none in English) are skipped
    alls = sorted({c["ws"] for c in b["cues"] if c.get("ws") is not None})
    if len(alls) != len(toks):
        return tagged, None
    for i, ws in enumerate(alls):
        if ws in groups:
            cs = groups[ws]
            rows.append((i, heard[i], (min(c["s"] for c in cs), max(c["e"] for c in cs))))
    return tagged, rows


if __name__ == "__main__":
    tag = sys.argv[1]
    rx = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("-") else "T"
    verbose = "-v" in sys.argv
    stats = {}
    skipped = 0
    for f in sorted((HERE / "out" / "bench").glob(f"{tag}-{rx}*.json")):
        b = json.loads(f.read_text())
        if "ws" not in b["cues"][0]:
            sys.exit("bench run without word stamps: bench again")
        tr = json.loads(Path(b["clip"][: -len(".ndjson")] + ".truth.json").read_text())
        tagged, rows = line(b, tr)
        if rows is None:
            skipped += 1
            continue
        for i, (h0, h1), (c0, c1) in rows:
            off = ((c0 + c1) / 2 - (h0 + h1) / 2) * 1000
            miss = c1 < h0 or c0 > h1
            key = ("tagged" if tagged else "plain", "first word" if i == 0 else "2nd–3rd" if i < 3 else "later")
            stats.setdefault(key, []).append((off, miss))
            if verbose and (miss or abs(off) > 150):
                print(f"  {f.stem[len(tag) + 1:]:24} word {i}  heard {h0:.2f}–{h1:.2f}  cues {c0:.2f}–{c1:.2f}  {off:+.0f} ms{'  MISSES' if miss else ''}")
    for k in sorted(stats):
        v = np.array([o for o, _ in stats[k]]); m = np.mean([x for _, x in stats[k]]) * 100
        print(f"{k[0]:7} {k[1]:11} n {len(v):4}  median {np.median(v):+5.0f} ms  |off| p75 {np.percentile(np.abs(v), 75):4.0f}  over 150 ms {np.mean(np.abs(v) > 150) * 100:3.0f}%  off the word entirely {m:3.0f}%")
    print("lines skipped (words and stamps don't pair up):", skipped)
