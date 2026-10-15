# /// script
# dependencies = ["numpy", "scipy", "pillow"]
# ///
"""Calibration runs scored on the long marker beeps (every 4th beep and flash is 3× longer): long flash vs long beep,
so a sound late by more than half a beep period is still paired with its own flash.  uv run calmark.py <run> [...]"""
import sys, json
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfiltfilt
sys.path.insert(0, str(Path(__file__).parent))
import room
for name in sys.argv[1:]:
    run = room.Run(name); mov = room.ROOM / f"{name}.mov"
    st, pts = room.probe(mov); r = run.meta["screenRect"]
    cx, cy = int((r["x"] + r["w"] / 2) * room.SCALE) - room.CROP_X, int((r["y"] + r["h"] / 2) * room.SCALE) - room.CROP_Y
    fr = room.frames(mov, cx - 100, cy - 100, 200, 200, 8, 8, True); n = min(len(fr), len(pts))
    bright = fr[:n].reshape(n, -1).mean(1); T = pts[:n]
    lit = bright > (bright.min() + 0.5 * (bright.max() - bright.min()))
    x = room.mic(mov); sos = butter(4, [800, 1250], btype="band", fs=48000, output="sos")
    env, hop = room.envelope(sosfiltfilt(sos, x), 48000, hop=0.001, win=0.003)
    ta = st.get("audio", 0) + np.arange(len(env)) * hop
    on = env > max(0.0006, 0.3 * env.max())
    def runs(mask, t):
        out, i = [], 0
        while i < len(mask):
            if mask[i]:
                j = i
                while j + 1 < len(mask) and mask[j + 1]: j += 1
                out.append((t[i], t[j] - t[i])); i = j + 1
            else: i += 1
        return out
    beeps = [b for b in runs(on, ta) if b[1] > 0.02]
    flashes = runs(lit, T)
    lb = [b[0] for b in beeps if b[1] > 0.12]; lf = [f[0] for f in flashes if f[1] > 0.12]
    pairs = [min(lf, key=lambda f: abs(f - b)) - b for b in lb] if lf else []
    print(name, f"beeps {len(beeps)} (long {len(lb)})  flashes {len(flashes)} (long {len(lf)})  long flash − long beep ms:", [round(1000 * p) for p in pairs])
