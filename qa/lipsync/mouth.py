# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy"]
# ///
"""Measures the mouth from the frame grabs alone (pixels, not the app's numbers), per frame:

  open   pixels of mouth interior (dark) + teeth (bright, grey) between the lips, in % of the lip box
  height tallest column of that opening, px      width   its horizontal extent, px
  lips   the lip box (red-ish pixels below the nose), px

Sealed lips = open ≈ 0. Writes out/runs/<name>/mouth.json; `--sheet` also saves a debug strip with the masks drawn.

  uv run mouth.py <run> [...] [--sheet]
"""

from __future__ import annotations

import json
import sys

import numpy as np
from scipy import ndimage

from runio import Run

DARK = 38  # interior luma (the shaded mouth floor is ~10–25; the closed lip line stays above ~40)
TEETH_L, TEETH_SAT = 175, 45


def features(img):
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    luma = (0.299 * r + 0.587 * g + 0.114 * b)
    sat = a.max(2) - a.min(2)
    H, W = luma.shape
    # the crop is centred on the lips (inject.js findCrop): look only at the middle band, away from the nostrils (top)
    # and the shadow under the chin (bottom)
    band = np.zeros((H, W), bool)
    band[int(H * 0.28) : int(H * 0.78), int(W * 0.12) : int(W * 0.88)] = True
    top = int(H * 0.28)
    lip = (r > 90) & (g < 0.65 * r) & (r - g > 45) & band  # lips are redder than skin (g/r ≈ 0.6 vs 0.74)
    lab, n = ndimage.label(ndimage.binary_closing(lip, iterations=2))
    if n == 0:
        return None
    sizes = ndimage.sum(lip, lab, range(1, n + 1))
    keep = 1 + int(np.argmax(sizes))
    ys, xs = np.where(lab == keep)
    # lips can be split in two (upper/lower) by an open mouth: take every red blob overlapping the main one's columns
    x0, x1 = xs.min(), xs.max()
    big = [i + 1 for i, s in enumerate(sizes) if s > 0.15 * sizes.max()]
    m = np.isin(lab, big)
    ys, xs = np.where(m)
    y0, y1 = max(top, ys.min() - 2), min(H - 1, ys.max() + 2)
    x0, x1 = max(0, xs.min() - 2), min(W - 1, xs.max() + 2)
    box = np.zeros_like(lip)
    box[y0 : y1 + 1, x0 : x1 + 1] = True
    box &= band
    dark = (luma < DARK) & box
    teeth = (luma > TEETH_L) & (sat < TEETH_SAT) & box
    # teeth only count next to the dark interior or between the lips (not skin highlights on the lip)
    near = ndimage.binary_dilation(dark, iterations=4)
    opening = dark | (teeth & near)
    area = int(opening.sum())
    cols = opening.sum(0)
    height = int(cols.max()) if area else 0
    xs_o = np.where(cols > 0)[0]
    width = int(xs_o.max() - xs_o.min() + 1) if area else 0
    boxarea = (y1 - y0 + 1) * (x1 - x0 + 1)
    return {"open": 100.0 * area / boxarea, "area": area, "height": height, "width": width, "lips": [int(x0), int(y0), int(x1), int(y1)], "dark": int(dark.sum()), "teeth": int((teeth & near).sum())}, (opening, box)


def main(name: str, sheet: bool):
    run = Run(name)
    out = {}
    picks = []
    for i in run.image_indices("mouth"):
        im = run.image(i, "mouth")
        f = features(im)
        if f is None:
            continue
        out[i] = f[0]
        if sheet and i % 15 == 0 and len(picks) < 24:
            picks.append((i, im, f[1]))
    if not out:
        print(f"{name}: no frame grabs (skipped)")
        return
    (run.dir / "mouth.json").write_text(json.dumps(out))
    opens = np.array([v["open"] for v in out.values()])
    print(f"{name}: {len(out)} frames, open % p5/p50/p95 = {np.percentile(opens, [5, 50, 95]).round(2)}")
    if sheet and picks:
        from PIL import Image, ImageDraw

        w, h = picks[0][1].size
        S = Image.new("RGB", (w * 6, h * ((len(picks) + 5) // 6)), "white")
        for k, (i, im, (opening, box)) in enumerate(picks):
            im = im.convert("RGB").copy()
            px = im.load()
            ys, xs = np.where(opening)
            for y, x in zip(ys, xs):
                px[int(x), int(y)] = (0, 255, 0)
            d = ImageDraw.Draw(im)
            yb, xb = np.where(box)
            d.rectangle([xb.min(), yb.min(), xb.max(), yb.max()], outline=(0, 0, 255))
            d.text((4, 4), f"{i} {out[i]['open']:.1f}%", fill=(0, 0, 0))
            S.paste(im, ((k % 6) * w, (k // 6) * h))
        S.save(run.dir / "mouth-sheet.jpg")


if __name__ == "__main__":
    sheet = "--sheet" in sys.argv
    for n in [a for a in sys.argv[1:] if not a.startswith("--")]:
        main(n, sheet)
