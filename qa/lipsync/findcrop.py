# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy"]
# ///
"""Finds the lips in a screenshot of the canvas and prints the mouth crop as JSON (CSS px, relative to the canvas):
the widest flat red blob (lips are redder than skin, g/r ≈ 0.6 vs 0.74) in the middle of the frame.

  uv run findcrop.py canvas.png <css width>
"""

import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

img = Image.open(sys.argv[1]).convert("RGB")
css_w = float(sys.argv[2])
# lips vs skin: g/r ≈ 0.6 vs 0.74 in page grabs; a screen capture (display colour profile) is more saturated, so it
# passes a stricter ratio as the third argument (room.py: 0.6)
RATIO = float(sys.argv[3]) if len(sys.argv) > 3 else 0.65
a = np.asarray(img).astype(np.int16)
H, W, _ = a.shape
r, g = a[..., 0], a[..., 1]
m = (r > 90) & (g < RATIO * r) & (r - g > 45)
m[: int(H * 0.4)] = False
m[int(H * 0.85) :] = False
m[:, : int(W * 0.3)] = False
m[:, int(W * 0.7) :] = False
lab, n = ndimage.label(ndimage.binary_closing(m, iterations=3))
best, score = None, 0
for i, sl in enumerate(ndimage.find_objects(lab), start=1):
    h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
    area = int((lab[sl] == i).sum())
    if w < W * 0.04 or w < 2 * h:  # lips: wide and flat
        continue
    if area * w > score:
        best, score = sl, area * w
if best is None:
    print("null")
    sys.exit(0)
k = css_w / W
cx = (best[1].start + best[1].stop) / 2 * k
cy = (best[0].start + best[0].stop) / 2 * k
lw = (best[1].stop - best[1].start) * k
w = round(lw * 1.8)
h = round(w * 0.62)
print(json.dumps({"x": round(cx - w / 2), "y": round(cy - h / 2), "w": w, "h": h, "lipsW": round(lw)}))
