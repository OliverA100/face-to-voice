# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy"]
# ///
"""Measures the mouth from the frame grabs alone (pixels, not the app's numbers), per frame:

  open   pixels of mouth interior (dark) + teeth (bright, grey) between the lips, in % of the lip box
  height tallest column of that opening, px      width   its horizontal extent, px
  lips   the lip box (red-ish pixels below the nose), px
  clipped  the lips are out of the crop (the head pitches for seconds at a time): frames grouped by the head's outline in
           the whole-head grab, each group judged by its median lip height; such frames aren't measured (events.py)

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


def head_top(img) -> int | None:
    """The top of the head in a whole-head grab (first row in the middle fifth that differs from the flat background)."""
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    H, W, _ = a.shape
    col = a[:, int(W * 0.4) : int(W * 0.6)]
    rows = np.where(np.abs(col - a[2, 2]).max(2).max(1) > 25)[0]
    return int(rows[0]) if len(rows) else None


def lips_y(img) -> float | None:
    """The lips' height in a whole-head grab, 0..1 of the image (findcrop.py's widest flat red blob). Noisy frame to
    frame (an open mouth splits the lips; a nostril or the chin's shadow can win), fine as a median."""
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    H, W, _ = a.shape
    r, g = a[..., 0], a[..., 1]
    m = (r > 90) & (g < 0.65 * r) & (r - g > 45)
    m[: int(H * 0.4)] = False
    m[int(H * 0.85) :] = False
    m[:, : int(W * 0.3)] = False
    m[:, int(W * 0.7) :] = False
    lab, _ = ndimage.label(ndimage.binary_closing(m, iterations=2))
    best, score = None, 0
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        area = int((lab[sl] == i).sum())
        if w >= W * 0.04 and w >= 2 * h and area * w > score:
            best, score = sl, area * w
    return None if best is None else (best[0].start + best[0].stop) / 2 / H


def clipped_frames(run: Run) -> set[int]:
    """Frames whose lips are out of the middle of the mouth crop. The head pitches for seconds at a time (cursor
    follow, nods in a chat), and an older run's crop stayed where the lips were when it was set. Frames are grouped by
    the head's position (its top in the whole-head grab, which the mouth doesn't move) and the crop; a group is out
    when its median lip height in the crop is outside 0.3–0.7."""
    rows = run.by_index
    seen = []  # (frame, group key, lip height in the crop or None)
    for i in run.image_indices("full"):
        f = rows.get(i, {})
        k, c = f.get("crop"), f.get("canvas")
        if not k or not c:
            continue
        im = run.image(i, "full")
        top = head_top(im)
        if top is None:
            continue
        y = lips_y(im)
        key = (json.dumps(k, sort_keys=True), round(top * 360 / im.width / 4))
        seen.append((i, key, None if y is None else (y * c[3] - k["y"]) / k["h"]))
    groups: dict = {}
    for _, key, y in seen:
        if y is not None:
            groups.setdefault(key, []).append(y)
    out = set()
    for i, key, _ in seen:
        ys = groups.get(key, [])
        if len(ys) >= 15 and not 0.3 <= float(np.median(ys)) <= 0.7:
            out.add(i)
    return out


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
    clipped = clipped_frames(run)
    for i in out:
        out[i]["clipped"] = i in clipped
    (run.dir / "mouth.json").write_text(json.dumps(out))
    opens = np.array([v["open"] for v in out.values()])
    print(f"{name}: {len(out)} frames ({sum(v['clipped'] for v in out.values())} with the lips out of the crop), open % p5/p50/p95 = {np.percentile(opens, [5, 50, 95]).round(2)}")
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
