# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Frame strips around audio events, for checking by eye: one row per event, mouth crops every ~17 ms from 120 ms
before to 120 ms after the acoustic moment (p/b/m: the burst; f/v/th: hiss onset; vowels: loudness peak; or a word).
The frame nearest the moment has a red border; each crop is labelled with its offset (ms) and opening height (px).

  uv run strips.py <run> [closure|fv|th|vowel|word:<text>] [--all]    → out/runs/<run>/strip-<kind>.jpg
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image, ImageDraw

from events import heard_times
from runio import Run

STEP = 1 / 60
SPAN = 0.12


def main(name: str, kind: str, only_bad: bool):
    run = Run(name)
    truth = json.loads((run.dir / "truth.json").read_text())
    ev = json.loads((run.dir / "events.json").read_text())["rows"]
    mouth = {int(k): v for k, v in json.loads((run.dir / "mouth.json").read_text()).items()}
    ht = heard_times(run, truth["ctx"])
    idx = sorted(i for i in mouth if i in ht)
    T = np.array([ht[i] for i in idx])
    rows = []
    if kind.startswith("word:"):
        w = kind[5:].lower()
        for L in truth["letters"]:
            pass
        letters = [L for L in truth["letters"] if L["c"] != "|"]
        words = "".join(L["c"] for L in truth["letters"]).split("|")
        k = 0
        for word in words:
            span = letters[k : k + len(word)]
            k += len(word)
            if word.lower() == w:
                rows.append((word.lower(), (span[0]["s"] + span[-1]["e"]) / 2, max(SPAN, (span[-1]["e"] - span[0]["s"]) / 2 + 0.08)))
    else:
        for r in ev:
            if r["kind"] != kind:
                continue
            if only_bad and kind == "closure" and "unsealed" not in r and abs(r.get("release_off", 0)) < 0.04:
                continue
            t = r.get("release") if kind == "closure" else (r.get("peak") if kind == "vowel" else r.get("on"))
            if t is None:
                continue
            lab = f"{r['c']} in {r['word']}"
            if kind == "closure":
                lab += " UNSEALED" if r.get("unsealed") else f"  release {1000 * r['release_off']:+.0f} ms"
            rows.append((lab, t, SPAN))
    if not rows:
        print("no events")
        return
    sample = run.image(idx[0])
    cw, ch = sample.size
    sc = 120 / cw
    tw, th = int(cw * sc), int(ch * sc)
    ncol = int(2 * SPAN / STEP) + 1
    ncol = max(ncol, max(int(2 * s / STEP) + 1 for _, _, s in rows))
    S = Image.new("RGB", (160 + ncol * tw, len(rows) * (th + 14)), "white")
    d = ImageDraw.Draw(S)
    for ri, (lab, t, span) in enumerate(rows):
        y = ri * (th + 14)
        d.text((4, y + th // 2), lab[:26], fill=(0, 0, 0))
        n = int(2 * span / STEP) + 1
        for ci in range(n):
            tt = t - span + ci * STEP
            j = int(np.argmin(np.abs(T - tt)))
            i = idx[j]
            im = run.image(i).resize((tw, th))
            x = 160 + ci * tw
            S.paste(im, (x, y))
            off = (T[j] - t) * 1000
            if abs(T[j] - t) <= STEP / 2:
                d.rectangle([x, y, x + tw - 1, y + th - 1], outline=(255, 0, 0), width=2)
            d.text((x + 2, y + th), f"{off:+.0f} h{mouth[i]['height']}", fill=(60, 60, 60))
    out = run.dir / f"strip-{kind.replace(':', '-')}.jpg"
    S.save(out, quality=88)
    print(out)


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    main(a[0], a[1] if len(a) > 1 else "closure", "--all" not in sys.argv)
