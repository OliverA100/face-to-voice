# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pillow"]
# ///
"""A recording of calibrate.html in the iPhone simulator (screencapture of the Simulator window + the Mac's mic): the
whole screen flashing against the beeps heard, paired on the long marker beeps. flash − beep < 0: the sound is later
than the page thinks.   uv run simcal.py out/room/<name>.mov [...]"""
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfiltfilt

import room

for f in sys.argv[1:]:
    mov = Path(f)
    st, pts = room.probe(mov)
    import subprocess
    w, h = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(mov)]).decode().strip().split(","))
    fr = room.frames(mov, int(w * 0.1), int(h * 0.35), int(w * 0.8), int(h * 0.3), 8, 8, True)
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
    pairs = [min(lf, key=lambda q: abs(q - b)) - b for b in lb] if lf else []
    print(f"{mov.stem}: beeps {len(beeps)} (long {len(lb)}), flashes {len(flashes)} (long {len(lf)}), long flash − long beep ms: {[round(1000 * p) for p in pairs]}")
