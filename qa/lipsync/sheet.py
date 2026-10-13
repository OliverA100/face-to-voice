# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Lays out shapes.mjs renders as one contact sheet: a row per face × view, a column per viseme, labelled.

  uv run sheet.py out/shapes/<tag> [--cell 220]     → out/shapes/<tag>.jpg
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

d = Path(sys.argv[1])
cell = int(sys.argv[sys.argv.index("--cell") + 1]) if "--cell" in sys.argv else 220
files = sorted(d.glob("f*-*-*.png"))
key = lambda p: re.match(r"f(\d+)-([a-z_]+)-([A-Za-z]+)\.png", p.name).groups()
faces = sorted({int(key(p)[0]) for p in files})
order = ["rest", "pp", "ppr", "ff", "th", "dd", "ll", "ss", "aa", "e", "i", "o", "u"]
found = []
for p in files:
    if key(p)[1] not in found:
        found.append(key(p)[1])
visemes = [v for v in order if v in found] + [v for v in found if v not in order]
views = ["front", "threeQuarter", "profile"]
label = {"rest": "rest", "pp": "p b m", "ppr": "p b m (round)", "ff": "f v", "th": "th", "dd": "t d n", "ll": "l", "ss": "s z", "aa": "ah", "e": "eh", "i": "ee", "o": "oh", "u": "oo w"}
W = 90 + cell * len(visemes)
H = 30 + cell * len(faces) * len(views)
S = Image.new("RGB", (W, H), "white")
g = ImageDraw.Draw(S)
for c, v in enumerate(visemes):
    g.text((90 + c * cell + 6, 8), label.get(v, v), fill=(0, 0, 0))
r = 0
for f in faces:
    for view in views:
        g.text((6, 30 + r * cell + cell // 2), f"face {f}\n{view}", fill=(0, 0, 0))
        for c, v in enumerate(visemes):
            p = d / f"f{f}-{v}-{view}.png"
            if p.exists():
                im = Image.open(p).convert("RGB")
                w, h = im.size
                s = min(w, h)
                im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((cell, cell))
                S.paste(im, (90 + c * cell, 30 + r * cell))
        r += 1
out = d.parent / f"{d.name}.jpg"
S.save(out, quality=90)
print(out)
