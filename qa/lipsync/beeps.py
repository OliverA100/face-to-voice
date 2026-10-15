# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""out/beeps.ndjson: a beep track as a speak-route clip for appstale.mjs --cal: 12 s of 24 kHz PCM, a 1 kHz beep each
second from 1 s to 10 s, 60 ms long, every 4th 180 ms (the marker appcal.py pairs on).  uv run beeps.py"""
import base64
import json
from pathlib import Path

import numpy as np

sr = 24000
x = np.zeros(12 * sr)
for k in range(1, 11):
    i = k * sr
    j = i + int((0.18 if k % 4 == 0 else 0.06) * sr)
    x[i:j] = 0.5 * np.sin(2 * np.pi * 1000 * np.arange(j - i) / sr)
pcm = (x * 32767).astype("<i2").tobytes()
step = sr * 2 // 4
lines = []
for off in range(0, len(pcm), step):
    al = {"characters": ["a"], "character_start_times_seconds": [0.0], "character_end_times_seconds": [0.1]} if off == 0 else None
    lines.append(json.dumps({"audio_base64": base64.b64encode(pcm[off : off + step]).decode(), "alignment": al, "normalized_alignment": None}))
out = Path(__file__).parent / "out" / "beeps.ndjson"
out.write_text("\n".join(lines) + "\n")
print(out, len(lines), "chunks")
