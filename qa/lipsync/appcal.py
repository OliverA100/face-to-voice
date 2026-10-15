# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pillow"]
# ///
"""appstale.mjs --cal runs: the page's flash patch (lit while the app's player says a beep is heard) against the beeps
the Mac's mic heard, paired on the long marker beeps. flash − beep < 0: the sound comes later than the app thinks.

  uv run appcal.py <run> [...]"""
import json
import sys

import numpy as np
from scipy.signal import butter, sosfiltfilt

import room

for name in sys.argv[1:]:
    mov = room.ROOM / f"{name}.mov"
    m = json.loads((room.ROOM / f"{name}.json").read_text())
    wv = m["win"]
    cx, cy = int((wv["x"] + wv["w"] / 2) * room.SCALE), int((wv["y"] + wv["h"] / 2) * room.SCALE)
    st, pts = room.probe(mov)
    fr = room.frames(mov, cx - 100, cy - 100, 200, 200, 8, 8, True)
    n = min(len(fr), len(pts))
    bright, T = fr[:n].reshape(n, -1).mean(1), pts[:n]
    lit = bright > (bright.min() + 0.5 * (bright.max() - bright.min()))
    x = room.mic(mov)
    env, hop = room.envelope(sosfiltfilt(butter(4, [800, 1250], btype="band", fs=48000, output="sos"), x), 48000, hop=0.001, win=0.003)
    ta = st.get("audio", 0) + np.arange(len(env)) * hop
    on = env > max(0.0006, 0.3 * env.max())

    def runs(mask, t):
        out, i = [], 0
        while i < len(mask):
            if mask[i]:
                j = i
                while j + 1 < len(mask) and mask[j + 1]:
                    j += 1
                out.append((t[i], t[j] - t[i]))
                i = j + 1
            else:
                i += 1
        return out

    beeps = [b for b in runs(on, ta) if b[1] > 0.02]
    flashes = runs(lit, T)
    lb, lf = [b[0] for b in beeps if b[1] > 0.12], [f[0] for f in flashes if f[1] > 0.12]
    pairs = [min(lf, key=lambda f: abs(f - b)) - b for b in lb] if lf else []
    print(f"{name}: beeps {len(beeps)} (long {len(lb)}), flashes {len(flashes)} (long {len(lf)}), long flash − long beep ms: {[round(1000 * p) for p in pairs]}, player {m['state']}")
