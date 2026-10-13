# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Before | after video of the same line: two runs' mouth grabs, each placed at its heard time and lined up on the
voice onset (truth.json), with the line's audio. Written at 1× and slowed down (the audio slowed with its pitch kept).

  uv run sidebyside.py <before run> <after run> [--slow 0.25] [--view mouth|full] [--out name]
      → out/compare/<name>.mp4 and <name>-slow.mp4   (name defaults to the after run's)

Each frame shows what was on screen while that moment of the audio was heard (the latest grab at or before it).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from events import heard_times
from runio import RUNS, Run

OUT = RUNS.parent

args = sys.argv[1:]


def opt(k: str, d: str) -> str:
    if f"--{k}" in args:
        i = args.index(f"--{k}")
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return d


slow = float(opt("slow", "0.25"))
view = opt("view", "mouth")
name = opt("out", "")
before, after = args[:2]
name = name or after
FPS = 60
PRE, POST = 0.4, 0.4
H = 300 if view == "mouth" else 420  # each panel's height in the video


def timeline(run: Run):
    """(heard time − voice onset, frame index), sorted; the voice's span."""
    truth = json.loads((run.dir / "truth.json").read_text())
    ht = heard_times(run, truth["ctx"])
    v0, v1 = truth["voice"]
    have = set(run.image_indices(view))
    t = sorted((ht[i] - v0, i) for i in ht if i in have)
    return np.array([x for x, _ in t]), [i for _, i in t], v0, v1 - v0, truth["ctx"]


runs = [Run(before), Run(after)]
lines = [timeline(r) for r in runs]
length = max(d for *_, d, _ in lines) + POST
cache: dict = {}


def panel(k: int, t: float) -> Image.Image:
    T, idx, *_ = lines[k]
    j = int(np.searchsorted(T, t, side="right")) - 1
    i = idx[max(0, j)]
    if (k, i) not in cache:
        im = runs[k].image(i, view).convert("RGB")
        cache[(k, i)] = im.resize((round(im.width * H / im.height), H))
    return cache[(k, i)]


def frames(dir: Path, speed: float) -> None:
    n = int((PRE + length) * FPS / speed)
    for f in range(n):
        t = -PRE + f * speed / FPS
        a, b = panel(0, t), panel(1, t)
        S = Image.new("RGB", (a.width + b.width + 8, H + 28), "white")
        S.paste(a, (0, 28))
        S.paste(b, (a.width + 8, 28))
        g = ImageDraw.Draw(S)
        g.text((6, 8), f"before ({before})", fill=(0, 0, 0))
        g.text((a.width + 14, 8), f"after ({after})", fill=(0, 0, 0))
        g.text((S.width - 70, 8), f"{t * 1000:+.0f} ms", fill=(120, 120, 120))
        S.save(dir / f"{f:06d}.jpg", quality=88)


def audio(dir: Path) -> Path:
    """The after run's audio from PRE before the voice onset (both runs replay the same line)."""
    r = runs[1]
    x, sr, t0 = r.audio(lines[1][4])
    v0 = lines[1][2]
    a = max(0, int((v0 - PRE - t0) * sr))
    seg = x[a : a + int((PRE + length) * sr)]
    if v0 - PRE < t0:  # the recording started after PRE before the voice: pad with silence
        seg = np.concatenate([np.zeros(int((t0 - (v0 - PRE)) * sr), np.float32), seg])
    p = dir / "audio.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(seg, -1, 1) * 32767).astype(np.int16).tobytes())
    return p


out = OUT / "compare"
out.mkdir(parents=True, exist_ok=True)
for speed, suffix in ((1.0, ""), (slow, "-slow")):
    tmp = Path(tempfile.mkdtemp())
    try:
        frames(tmp, speed)
        wav = audio(tmp)
        # atempo takes 0.5–2 per stage: chain stages for 0.25 etc.; the pitch stays
        stages, s = [], speed
        while s < 0.5:
            stages.append("atempo=0.5")
            s /= 0.5
        stages.append(f"atempo={s:.4f}")
        dst = out / f"{name}{suffix}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "%06d.jpg"), "-i", str(wav),
             "-filter:a", ",".join(stages), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-crf", "18", "-c:a", "aac", "-shortest", str(dst)],
            check=True, stdin=subprocess.DEVNULL,
        )
        print(dst)
    finally:
        shutil.rmtree(tmp)
