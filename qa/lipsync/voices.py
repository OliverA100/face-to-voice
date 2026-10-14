# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""How each voice delivers its lines, next to how the mouth keeps up: speaking rate, pauses, loudness range (the
emphasis), and the bench's lip-sync offsets for the same lines. Voices pace, pause and stress words differently, so a
timing rule tuned on one can miss on another.

  uv run voices.py <bench tag> [clip prefix …]       e.g.  uv run voices.py v2 D1 D2 E1 E2 A B C
      (bench first: ./bench.sh --tag v2 out/clips/*.ndjson; clips need truth.json: uv run truth.py out/clips/*.ndjson)

Per voice (the clips starting "<prefix>-"): syllables per second while speaking (vowel nuclei per second of voice
outside pauses), pauses (≥150 ms under the line's loudest −35 dB) per 10 s and their median length, the vowels'
loudness spread (p90 − p10 dB: how much it stresses words), and the mouth: p/b/m release median and late (>100 ms),
seals, vowel offset median.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np

from bench import score

HERE = Path(__file__).parent
CLIPS = HERE / "out" / "clips"
BENCH = HERE / "out" / "bench"


def audio(nd: Path) -> tuple[np.ndarray, int]:
    pcm = b"".join(base64.b64decode(json.loads(l).get("audio_base64") or "") for l in nd.read_text().splitlines() if l.strip())
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768, 24000


def pauses(x: np.ndarray, sr: int, v0: float, v1: float) -> list[float]:
    """Stretches of at least 150 ms under the line's loudest 10 ms block −35 dB, inside the voice."""
    n = sr // 100
    blocks = x[: len(x) // n * n].reshape(-1, n)
    db = 20 * np.log10(np.sqrt((blocks**2).mean(1)) + 1e-9)
    quiet = db < db.max() - 35
    out, run = [], 0
    for k in range(int(v0 * 100), min(len(quiet), int(v1 * 100))):
        if quiet[k]:
            run += 1
        else:
            if run >= 15:
                out.append(run / 100)
            run = 0
    return out


tag, prefixes = sys.argv[1], sys.argv[2:]
print(f"{'voice':7} {'lines':>5} {'syl/s':>6} {'pauses/10s':>10} {'pause ms':>8} {'stress dB':>9} | {'release':>7} {'late':>5} {'sealed':>7} {'vowel':>6}")
for p in prefixes:
    clips = sorted(c for c in CLIPS.glob(f"{p}-*.ndjson"))
    rates, ps, plen, spread, rel, sealed, total, vow = [], [], [], [], [], 0, 0, []
    dur = 0.0
    for nd in clips:
        tj = nd.with_suffix(".truth.json")
        bj = BENCH / f"{tag}-{nd.stem}.json"
        if not tj.exists():
            continue
        t = json.loads(tj.read_text())
        v0, v1 = t["voice"]
        x, sr = audio(nd)
        pz = pauses(x, sr, v0, v1)
        speaking = (v1 - v0) - sum(pz)
        vowels = [e for e in t["events"] if e["kind"] == "vowel"]
        rates.append(len(vowels) / max(speaking, 0.1))
        ps.append(len(pz))
        plen += pz
        dur += v1 - v0
        lv = [e["level"] for e in vowels]
        if len(lv) > 3:
            spread.append(np.percentile(lv, 90) - np.percentile(lv, 10))
        if bj.exists():
            rows, _ = score(bj)
            cl = [r for r in rows if r["kind"] == "closure"]
            total += len(cl)
            sealed += sum(1 for r in cl if "release_off" in r)
            rel += [r["release_off"] for r in cl if "release_off" in r]
            vow += [r["off"] for r in rows if r["kind"] == "vowel"]
    if not rates:
        continue
    ms = lambda v: f"{np.median(v) * 1000:+.0f}" if len(v) else "–"
    print(
        f"{p:7} {len(rates):5} {np.mean(rates):6.1f} {10 * sum(ps) / max(dur, 0.1):10.1f} {np.median(plen) * 1000 if plen else 0:8.0f} {np.mean(spread):9.1f} | "
        f"{ms(rel):>7} {sum(1 for v in rel if v > 0.1):5} {f'{sealed}/{total}':>7} {ms(vow):>6}"
    )
