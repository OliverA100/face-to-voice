# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Recorder self-check on a calibrate.html run: each beep's start (from the tapped audio) vs the first frame whose grab
shows the flash, and vs that frame's ctx-time stamp.

  uv run cal.py cal-chrome-raw

Expect (mode=raw): flash frame stamp − beep start in [0, one frame); grab shows the flash on the stamped frame
(if the grab were one frame late, 'grab lag' would read one frame).
"""

import sys

import numpy as np

from runio import Run, envelope

run = Run(sys.argv[1])
x, sr, t0 = run.audio(0)
env, hop = envelope(x, sr, hop=0.001, win=0.002)
on = env > 0.05
starts = [t0 + i * hop for i in range(1, len(on)) if on[i] and not on[i - 1]]

idx = [i for i in run.image_indices("mouth") if i in run.by_index and run.by_index[i]["ctx"]]
bright = {}
for i in idx:
    im = run.image(i)
    bright[i] = float(np.asarray(im.convert("L")).mean())
ft = run.frame_t(0)
rows = run.by_index
lat = np.nanmedian(run.out_latency(0))

print(f"{run.name}: {len(starts)} beeps, {len(idx)} grabs, reported output latency {lat*1000:.1f} ms")
mode = "heard" if "heard" in run.name else "raw"
res = []
for s in starts:
    # first grabbed frame after (s − 0.1) that is bright
    cand = [i for i in idx if rows[i]["ctx"][0]["t"] >= s - 0.2 and bright[i] > 128]
    if not cand:
        continue
    i = cand[0]
    stamp = rows[i]["ctx"][0]["t"]
    # app-style draw time: in heard mode the page subtracted the latency
    eff = stamp - (rows[i]["ctx"][0].get("out") or 0) if mode == "heard" else stamp
    prev = [j for j in idx if j < i]
    prev_stamp = rows[prev[-1]]["ctx"][0]["t"] if prev else np.nan
    res.append((s, stamp - s, eff - s, stamp - prev_stamp))
    print(f"  beep {s:7.3f}  first flash frame {i:5d}  stamp−beep {1000*(stamp-s):6.1f} ms  (frame gap {1000*(stamp-prev_stamp):5.1f} ms)")
if res:
    d = np.array([r[1] for r in res])
    g = np.array([r[3] for r in res])
    print(f"stamp−beep median {1000*np.median(d):.1f} ms, range {1000*d.min():.1f}..{1000*d.max():.1f}; frame gap median {1000*np.median(g):.1f} ms")
    print("PASS: grabs match their stamps" if np.all(d >= -0.0005) and np.all(d <= g + 0.003) else "CHECK: a grab is off its stamp")
