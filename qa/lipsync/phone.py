# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""A phone filmed by the Mac's camera (QuickTime, phone-1.mov): mouth darkness in a small box vs the phone's sound.

The mouth is ~30 px wide in such a film, so this only reads open vs closed. Per spoken line: the best lag between
the mouth signal and the loudness (positive = mouth late), corrected for the camera's own delay measured from a clap
(sound vs the frame the hands meet).

  uv run phone.py <film.mov> <mouth x> <mouth y> <camera delay ms> <line start s> [...]
"""

import subprocess
import sys

import numpy as np

mov, mx, my, cam = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]) / 1000
starts = [float(s) for s in sys.argv[5:]]
W, H = 40, 24
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mov, "-vf", f"crop={W}:{H}:{mx - W // 2}:{my - H // 2},format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(float)
pts = np.array([float(p.strip(",")) for p in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", mov], capture_output=True, text=True).stdout.split() if p.strip(",")])
n = min(len(fr), len(pts))
# darkness: how many pixels are well below the box's bright (skin) level
ref = np.percentile(fr[:n].reshape(n, -1), 80, axis=1)
dark = (fr[:n].reshape(n, -1) < (ref[:, None] - 45)).sum(1).astype(float)
T = pts[:n] - cam  # when the screen actually showed it
a = subprocess.run(["ffmpeg", "-v", "error", "-i", mov, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], capture_output=True).stdout
x = np.frombuffer(a, np.int16).astype(float) / 32768
h = 240
e = np.sqrt((x[: len(x) // h * h].reshape(-1, h) ** 2).mean(1))
te = np.arange(len(e)) * h / 48000
for s in starts:
    grid = np.arange(s, s + 4.0, 0.005)
    le = np.interp(grid, te, np.convolve(e, np.ones(6) / 6, "same"))
    dm = np.interp(grid, T, dark)
    la, lb = (le - le.mean()) / le.std(), (dm - dm.mean()) / (dm.std() + 1e-9)
    best = max(range(-40, 41), key=lambda L: float(np.mean(la[: len(la) - L] * lb[L:])) if L >= 0 else float(np.mean(la[-L:] * lb[: len(lb) + L])))
    c = float(np.mean(la[: len(la) - best] * lb[best:])) if best >= 0 else float(np.mean(la[-best:] * lb[: len(lb) + best]))
    print(f"line at {s:5.1f}s: mouth vs sound {best * 5:+d} ms (corr {c:.2f}), mouth dark px range {dm.min():.0f}..{dm.max():.0f}")
