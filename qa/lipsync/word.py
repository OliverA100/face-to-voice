# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""One word in a bench run, for finding why it's off: the sound's events around it (truth), the cues the app placed,
and when its lips were shut (gap ≤ 0.5 mm).   uv run word.py <bench tag> <clip> <word> [<window s, default 0.5>]"""
import json, sys
from pathlib import Path
import numpy as np
tag, clip, word = sys.argv[1:4]
win = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
b = json.loads((Path(__file__).parent / "out" / "bench" / f"{tag}-{clip}.json").read_text())
tr = json.loads(Path(b.get("truth") or b["clip"][:-7] + ".truth.json").read_text())
ev = [e for e in tr["events"] if e["word"] == word.lower()]
if not ev:
    sys.exit(f"{word} not in {clip}: {tr['text']}")
t0 = min(e.get("on", e.get("s", e.get("peak"))) for e in ev) - win
t1 = max(e.get("release", e.get("e", e.get("peak"))) for e in ev) + win
print(tr["text"])
print("sound:", " ".join(f"{e['word']}:{e['kind'][0]}{'['+e['c']+']' if e['kind']!='vowel' else '('+e['letters']+')'}@{e.get('on', e.get('peak', e.get('s'))):.2f}" + (f"-{e['release']:.2f}" if 'release' in e else "") for e in tr["events"] if t0 <= e.get("on", e.get("peak", e.get("s", 0))) <= t1))
print("cues: ", " ".join(f"{c['v']}:{c['x']}@{c['s']:.2f}-{c['e']:.2f}" for c in b["cues"] if t0 <= c["s"] <= t1 and c["v"] in ("PP", "FF", "aa", "E", "I", "O", "U")))
T = np.array([f["t"] for f in b["frames"]]); G = np.array([f["gap"] for f in b["frames"]])
w = (T >= t0) & (T <= t1); sh = w & (G <= 0.5)
idx = np.where(sh)[0]
runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1) if len(idx) else []
print("shut: ", " ".join(f"{T[r[0]]:.2f}-{T[r[-1]]:.2f}" for r in runs if len(r)))
