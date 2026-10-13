"""Loads a recorded run (out/runs/<name>/, written by lib.mjs) into numpy arrays.

Times are on the page's AudioContext clock (seconds) unless noted:
  run.audio(ctx)  -> (samples float32 mono, sample rate, time of sample 0)
  run.frames      -> list of dict rows (frames.jsonl)
  run.frame_t     -> ctx time each frame was rendered at (the time the app read when it drew it)
"""

from __future__ import annotations

import json
import wave
from functools import cached_property
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RUNS = HERE / "out" / "runs"


class Run:
    def __init__(self, name_or_path: str | Path):
        p = Path(name_or_path)
        self.dir = p if p.is_dir() else RUNS / str(name_or_path)
        self.meta = json.loads((self.dir / "meta.json").read_text())
        self.frames = [json.loads(l) for l in (self.dir / "frames.jsonl").read_text().splitlines() if l.strip()]
        self.speak = json.loads((self.dir / "speak.json").read_text()) if (self.dir / "speak.json").exists() else []

    @property
    def name(self) -> str:
        return self.dir.name

    def audio(self, ctx: int = 0):
        w = self.meta["wavs"][str(ctx)]
        with wave.open(str(self.dir / w["file"])) as f:
            x = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        return x, w["sr"], w["startTime"]

    def ctx_of_speech(self) -> int:
        """The context that carried the loudest audio (the voice)."""
        best, loud = 0, -1.0
        for k in self.meta["wavs"]:
            x, _, _ = self.audio(int(k))
            v = float(np.abs(x).max()) if len(x) else 0
            if v > loud:
                best, loud = int(k), v
        return best

    def frame_t(self, ctx: int = 0) -> np.ndarray:
        return np.array([r["ctx"][ctx]["t"] if len(r["ctx"]) > ctx else np.nan for r in self.frames])

    def frame_perf(self) -> np.ndarray:
        return np.array([r["perf"] for r in self.frames]) / 1000

    def out_latency(self, ctx: int = 0) -> np.ndarray:
        """What the browser says the speakers are behind by, per frame (outputLatency, else getOutputTimestamp)."""
        res = []
        for r in self.frames:
            c = r["ctx"][ctx] if len(r["ctx"]) > ctx else {}
            out = c.get("out")
            if out and out > 0:
                res.append(out)
            elif c.get("otc") is not None and c.get("otp"):
                res.append(max(0.0, c["t"] - (c["otc"] + (r["perf"] - c["otp"]) / 1000)))
            else:
                res.append(np.nan)
        return np.array(res)

    def image(self, i: int, kind: str = "mouth"):
        from PIL import Image

        p = self.dir / kind / f"{i:06d}.jpg"
        return Image.open(p) if p.exists() else None

    def image_indices(self, kind: str = "mouth") -> list[int]:
        return sorted(int(p.stem) for p in (self.dir / kind).glob("*.jpg"))

    @cached_property
    def by_index(self) -> dict[int, dict]:
        return {r["i"]: r for r in self.frames}


def envelope(x: np.ndarray, sr: int, hop: float = 0.005, win: float = 0.01) -> tuple[np.ndarray, float]:
    """RMS envelope, one value per `hop` seconds (window `win`). Returns (env, hop)."""
    h, w = int(sr * hop), int(sr * win)
    n = max(0, (len(x) - w) // h + 1)
    if n == 0:
        return np.zeros(0), hop
    idx = np.arange(w)[None, :] + h * np.arange(n)[:, None]
    return np.sqrt((x[idx] ** 2).mean(axis=1)), hop
