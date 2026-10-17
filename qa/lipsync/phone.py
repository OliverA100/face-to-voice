# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""A phone filmed by the Mac's camera playing saved lines (the ?lsqaPhone overlay: the camera on the mouth, so the mouth
is ~250 px wide in the film), per p/b/m and vowel like events.py.

Each line is found in the film's sound by its clip's loudness (out/clips/<clip>.ndjson); the clip's audio truth
(<clip>.truth.json) then says when each closure, burst and vowel peak was heard in the film. A frame shows at its
timestamp minus the camera's own delay (QuickTime + the Mac camera: 85–93 ms by a clap filmed with it).
The opening: the tallest column of dark pixels (the mouth interior) in the mouth box.

  uv run phone.py <film.mov> <mouth box> <camera delay ms> <clip> ... [--dark=35] [--seal=6] [--minh]
      mouth box: "x,y,w,h", or "x,y,w,h@from-to;x,y,w,h@from-to" (s) when the phone moved, or "auto"
      e.g. phone.py ~/Desktop/phone-2.mov auto 93 A-plosive B-plosive E2-plosive-happy A-mumble
  auto: find the lips by colour before each playing (the phone can move); heights are scaled to a 250 px mouth.
  Each clip may be played several times: each playing is scored on its own (in film order: "1st", "2nd", …).
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
CLIPS = HERE / "out" / "clips"
# luma under this is the mouth's interior (skin and lips ~90–145; the shadow line between closed lips reads ~40–50)
# relative to the skin's brightness (median luma in the box), so films with other exposure read the same: 0.32 ≈ 35 of
# 109 in a dim film; --dark=N sets an absolute level instead
DARK_FRAC = 0.32
DARK = next((float(a.split("=")[1]) for a in sys.argv if a.startswith("--dark=")), None)
SEAL_PX = float(next((a.split("=")[1] for a in sys.argv if a.startswith("--seal=")), 6))  # sealed at or under (film px)

mov, cam = sys.argv[1], float(sys.argv[3]) / 1000
# "x,y,w,h" for the whole film, "x,y,w,h@from-to;…" per stretch (the phone moved), or "auto"
BOXES = [] if sys.argv[2] == "auto" else [([int(v) for v in b.split("@")[0].split(",")], [float(v) for v in b.split("@")[1].split("-")] if "@" in b else [0, 1e9]) for b in sys.argv[2].split(";")]
clips = [a for a in sys.argv[4:] if not a.startswith("--")]
# --sets=new:0-33,old:118-200: score only the playings inside these stretches, labelled (else 1st, 2nd … playing)
SETS = [(n, [float(v) for v in r.split("-")]) for n, r in (x.split(":") for x in next((a.split("=")[1] for a in sys.argv if a.startswith("--sets=")), "").split(",") if x)]
if "--minh" in sys.argv:
    pass


def film_audio() -> np.ndarray:
    a = subprocess.run(["ffmpeg", "-v", "error", "-i", mov, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(a, np.int16).astype(float) / 32768


def env(sig: np.ndarray, sr: int, hop: float) -> np.ndarray:
    h = int(sr * hop)
    n = len(sig) // h
    return np.log(np.sqrt((sig[: n * h].reshape(n, h) ** 2).mean(1)) + 1e-4)


def clip_audio(c: str) -> np.ndarray:
    nd = (CLIPS / f"{c}.ndjson").read_text()
    pcm = b"".join(base64.b64decode(json.loads(l).get("audio_base64") or "") for l in nd.splitlines() if l.strip())
    return np.frombuffer(pcm, "<i2").astype(float) / 32768


def ncc(f: np.ndarray, c: np.ndarray) -> np.ndarray:
    from numpy.lib.stride_tricks import sliding_window_view

    c = (c - c.mean()) / c.std()
    W = sliding_window_view(f, len(c))
    m, s = W.mean(1), W.std(1) + 1e-9
    return ((W - m[:, None]) / s[:, None]) @ c / len(c)


def playings(fe: np.ndarray, c: str) -> list[float]:
    """Film times (s) where the clip starts, best match first then in order: every match over 0.6, at least a clip apart."""
    ce = env(clip_audio(c), 24000, 0.005)
    cor = ncc(fe, ce)
    out = []
    for i in np.argsort(-cor):
        if cor[i] < 0.6:
            break
        if all(abs(i - j) > len(ce) for j in out):
            out.append(i)
    return sorted(i * 0.005 for i in out)


PTS = None


def pts() -> np.ndarray:
    global PTS
    if PTS is None:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", mov], capture_output=True, text=True).stdout
        PTS = np.array([float(p.strip(",")) for p in out.split() if p.strip(",")])
    return PTS


def grab(t0: float, t1: float, crop: list[int] | None = None, gray: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Frames (film time, pixels) with timestamps in [t0, t1), whole or cropped (x, y, w, h)."""
    x0, y0, w, h = crop or (0, 0, 1920, 1080)
    vf = f"crop={w}:{h}:{x0}:{y0}" + (",format=gray" if gray else "")
    a = max(0.0, t0 - 1)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{a:.3f}", "-i", mov, "-t", f"{t1 - a + 0.5:.3f}", "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray" if gray else "rgb24", "-"], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape((-1, h, w) if gray else (-1, h, w, 3))
    t = pts()[pts() >= a - 1e-3][: len(fr)]
    keep = (t >= t0) & (t < t1)
    return t[keep], fr[: len(t)][keep]


def find_mouth(t: float) -> list[int] | None:
    """The mouth box around the lips (redder than skin: g/r < 0.65) in the frame at film time t: the widest flat blob."""
    from scipy import ndimage

    _, fr = grab(t, t + 0.1, gray=False)
    if not len(fr):
        return None
    a = fr[0].astype(np.int16)
    r, g = a[..., 0], a[..., 1]
    lab, _ = ndimage.label(ndimage.binary_closing((r > 90) & (g < 0.65 * r) & (r - g > 45), iterations=3))
    best, score = None, 0
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        hh, ww = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        area = int((lab[sl] == i).sum())
        if ww > 80 and ww > 2.5 * hh and area * ww > score:
            best, score = sl, area * ww
    if best is None:
        return None
    cx, cy, lw = (best[1].start + best[1].stop) // 2, (best[0].start + best[0].stop) // 2, best[1].stop - best[1].start
    w, h = int(lw * 1.15) // 2 * 2, int(lw * 0.5) // 2 * 2
    return [max(0, cx - w // 2), max(0, cy - h // 2), w, h]


x = film_audio()
fe = env(x, 48000, 0.005)
rows_all = {}
for c in clips:
    truth = json.loads((CLIPS / f"{c}.truth.json").read_text())
    found = playings(fe, c)
    if SETS:
        found = [(k, t) for k, (n, (a, z)) in enumerate(SETS) for t in found if a <= t < z][: len(SETS) * 4]
    else:
        found = list(enumerate(found))
    for k, start in found:
        # finer: 1 ms around the 5 ms match
        f1, c1 = env(x, 48000, 0.001), env(clip_audio(c), 24000, 0.001)
        i0 = int(start * 1000)
        seg = f1[max(0, i0 - 20) : i0 + 20 + len(c1)]
        start = (max(0, i0 - 20) + int(np.argmax(ncc(seg, c1)))) / 1000
        # the mouth for this playing (the phone can move between them): the lips before the line starts
        bx = next((b for b, (a, z) in BOXES if a <= start < z), None) if BOXES else find_mouth(start + truth["voice"][0] - 0.3)
        if bx is None:
            print(f"{c} at {start:.2f}: no lips found")
            continue
        T, fr = grab(start - 0.5, start + truth["voice"][1] + 0.6, bx)
        T = T - cam
        dark = DARK if DARK is not None else DARK_FRAC * float(np.median(fr))
        H = (fr < dark).sum(1).max(1).astype(float) * 250 / bx[2]  # tallest dark column, scaled to a 250 px wide mouth
        rows = []
        mids = [start + (e["on"] + e["release"]) / 2 for e in truth["events"] if e["kind"] == "closure" and not e.get("weak")]
        for e in truth["events"]:
            if e["kind"] == "closure" and not e.get("weak"):
                on, rel = start + e["on"], start + e["release"]
                mid = (on + rel) / 2
                w = np.where((T >= on - 0.15) & (T <= rel + 0.15))[0]
                if not len(w):
                    continue
                si = w[H[w] <= SEAL_PX]
                runs = [g for g in (np.split(si, np.where(np.diff(si) > 1)[0] + 1) if len(si) else []) if min(mids, key=lambda m: abs(m - (T[g[0]] + T[g[-1]]) / 2)) == mid]
                r = {"kind": "closure", "word": e["word"], "minH": float(H[w].min())}
                if runs:
                    g = min(runs, key=lambda g: abs((T[g[0]] + T[g[-1]]) / 2 - mid))
                    r["seal"] = T[g[0]] - on
                    r["release"] = T[min(g[-1] + 1, len(T) - 1)] - rel
                rows.append(r)
            elif e["kind"] == "vowel":
                pk = start + e["peak"]
                w = np.where((T >= max(start + e["s"] - 0.04, pk - 0.15)) & (T <= min(start + e["e"] + 0.04, pk + 0.15)))[0]
                if len(w) >= 2:
                    top = w[H[w] >= H[w].max() - 2]
                    rows.append({"kind": "vowel", "word": e["word"], "off": float(T[top].mean()) - pk})
        # whole-line lag: opening vs loudness, best lag in ±200 ms
        grid = np.arange(start + truth["voice"][0], start + truth["voice"][1], 0.005)
        le = np.interp(grid, np.arange(len(fe)) * 0.005, fe)
        hm = np.interp(grid, T, H)
        a, b = (le - le.mean()) / le.std(), (hm - hm.mean()) / (hm.std() + 1e-9)
        lag = max(range(-40, 41), key=lambda L: float(np.mean(a[: len(a) - L] * b[L:])) if L >= 0 else float(np.mean(a[-L:] * b[: len(b) + L]))) * 5
        rows_all[(c, k)] = (start, lag, rows)

if "--minh" in sys.argv:
    for (c, k), (_, _, rr) in sorted(rows_all.items()):
        print(c, k, sorted(int(r["minH"]) for r in rr if r["kind"] == "closure"))
ms = lambda v: f"{np.median(v) * 1000:+.0f} (p90 |{np.percentile(np.abs(v), 90) * 1000:.0f}|)" if len(v) else "–"
print(f"camera delay {cam * 1000:.0f} ms; negative = the mouth is early")
for k in sorted({k for _, k in rows_all}):
    rows = [r for (c, kk), (_, _, rr) in rows_all.items() if kk == k for r in rr]
    cl = [r for r in rows if r["kind"] == "closure"]
    s = [r for r in cl if "release" in r]
    print(f"{SETS[k][0] if SETS else f'playing {k + 1}'}: lines {sum(1 for (_, kk) in rows_all if kk == k)}, lag {np.median([v[1] for (c, kk), v in rows_all.items() if kk == k]):+.0f} ms, "
          f"release {ms([r['release'] for r in s])}, seal {ms([r['seal'] for r in s])}, vowel {ms([r['off'] for r in rows if r['kind'] == 'vowel'])}, sealed {len(s)}/{len(cl)}")
    for (c, kk), (start, lag, rr) in sorted(rows_all.items()):
        if kk == k:
            s2 = [r for r in rr if r["kind"] == "closure" and "release" in r]
            print(f"   {c:18} at {start:6.2f} s  lag {lag:+4d}  release {ms([r['release'] for r in s2])}  sealed {len(s2)}/{sum(1 for r in rr if r['kind'] == 'closure')}")
