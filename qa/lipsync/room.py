# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pillow"]
# ///
"""Analyses a room recording (room.mjs): what was on the SCREEN vs what the MIC heard, on the capture's own clock.

  cal runs:    each beep heard vs the first frame the flash shows (calibrate.html?mode=heard draws the flash when the
               page thinks the beep is being heard). flash − beep = what the page gets wrong about its own delay,
               plus the display's delay, plus the capture's own screen-vs-mic offset (the same for every browser, so
               browser-to-browser differences are exact).
  line runs:   the in-page tapped audio is matched to the mic (cross-correlation), so every truth.json event lands on
               the capture clock; the mouth is measured on the captured screen frames (mouth.py's pixel rules) and
               scored like events.py. Writes out/runs/<name>/room.json.

  uv run room.py <name> [...]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.signal import butter, sosfiltfilt

from runio import HERE, Run, envelope

ROOM = HERE / "out" / "room"
SCALE = 2  # Retina: screen points → captured pixels
CROP_X, CROP_Y = 0, 0  # the capture region's origin in pixels (room.mjs ROOM_REGION starts at 0,0)


def probe(mov: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", str(mov)], capture_output=True, text=True).stdout
    st = {s["codec_type"]: float(s.get("start_time", 0)) for s in json.loads(out)["streams"]}
    pts = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", str(mov)], capture_output=True, text=True).stdout.split()
    return st, np.array([float(p.strip(",")) for p in pts if p.strip(",")])


def frames(mov: Path, x: int, y: int, w: int, h: int, out_w: int, out_h: int, gray: bool):
    fmt = "gray" if gray else "rgb24"
    cmd = ["ffmpeg", "-v", "error", "-i", str(mov), "-vf", f"crop={w}:{h}:{x}:{y},scale={out_w}:{out_h}:flags=area,format={fmt}", "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    ch = 1 if gray else 3
    n = len(raw) // (out_w * out_h * ch)
    return np.frombuffer(raw[: n * out_w * out_h * ch], dtype=np.uint8).reshape(n, out_h, out_w, ch)


def mic(mov: Path):
    # rebuilt from the packets' timestamps (gaps → silence), not by counting samples: the capture can drop audio
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mov), "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def cal(name: str):
    run = Run(name)
    mov = ROOM / f"{name}.mov"
    st, pts = probe(mov)
    r = run.meta["screenRect"]
    # a patch in the middle of the page (the whole viewport flashes)
    cx, cy = int((r["x"] + r["w"] / 2) * SCALE) - CROP_X, int((r["y"] + r["h"] / 2) * SCALE) - CROP_Y
    fr = frames(mov, cx - 100, cy - 100, 200, 200, 8, 8, True)
    n = min(len(fr), len(pts))
    bright = fr[:n].reshape(n, -1).mean(1)
    T = pts[:n]
    x = mic(mov)
    sos = butter(4, [800, 1250], btype="band", fs=48000, output="sos")
    env, hop = envelope(sosfiltfilt(sos, x), 48000, hop=0.001, win=0.003)
    ta = st.get("audio", 0) + np.arange(len(env)) * hop
    thr = max(0.0006, 0.3 * env.max())  # quiet sources (an earbud held to the mic) too
    on = env > thr
    beeps = [ta[i] for i in range(1, len(on)) if on[i] and not on[i - 1] and not on[max(0, i - 300) : i].any()]
    lit = bright > (bright.min() + 0.5 * (bright.max() - bright.min()))
    res = []
    for b in beeps:
        k = [i for i in range(1, n) if lit[i] and not lit[i - 1] and abs(T[i] - b) < 0.35]
        if k:
            res.append(T[k[0]] - b)
    res = np.array(res)
    rep = float(np.nanmedian(run.out_latency(0))) if run.frames else float("nan")
    out = {"run": name, "browser": run.meta.get("browser"), "beeps": len(beeps), "paired": len(res), "flash_minus_beep_ms": [round(1000 * v, 1) for v in res], "median_ms": round(1000 * float(np.median(res)), 1) if len(res) else None, "reported_output_latency_ms": round(1000 * rep, 1), "fps": round(1 / np.median(np.diff(T)), 1)}
    (run.dir / "room.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out))


def line(name: str):
    sys.path.insert(0, str(HERE))
    from events import SEAL_PX
    from mouth import features

    run = Run(name)
    truth = json.loads((run.dir / "truth.json").read_text())
    mov = ROOM / f"{name}.mov"
    st, pts = probe(mov)
    # 1. the page's tapped audio → the mic: best lag of the envelopes (10 ms grid, then 1 ms)
    xt, sr, t0 = run.audio(truth["ctx"])
    xm = mic(mov)
    et, _ = envelope(xt, sr, hop=0.001, win=0.01)
    em, _ = envelope(xm, 48000, hop=0.001, win=0.01)
    a = (et - et.mean()) / (et.std() + 1e-9)
    b = (em - em.mean()) / (em.std() + 1e-9)
    c = np.correlate(b, a, mode="valid") if len(b) >= len(a) else np.correlate(a, b, mode="valid")[::-1]
    lag = int(np.argmax(c))  # mic sample index (ms) where the tap's sample 0 is heard
    corr = float(c[lag] / len(a))
    shift = st.get("audio", 0) + lag * 0.001 - t0  # capture time = page ctx time + shift
    # 2. mouth on the captured screen: found in the capture itself (browser bars make the page's own idea of where it
    #    sits on screen unreliable), with findcrop.py's rule on a full-resolution frame
    still = run.dir / "room-still.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1.0", "-i", str(mov), "-frames:v", "1", str(still)], check=True)
    W = Image.open(still).size[0]
    k = json.loads(subprocess.run([sys.executable, str(HERE / "findcrop.py"), str(still), str(W), "0.6"], capture_output=True, text=True).stdout)
    x0, y0, w, h = k["x"], k["y"], k["w"], k["h"]
    fr = frames(mov, x0, y0, w, h, w // 2, h // 2, False)
    n = min(len(fr), len(pts))
    H = []
    for i in range(n):
        f = features(Image.fromarray(fr[i]))
        H.append(f[0]["height"] * 2 if f else np.nan)  # back to captured-pixel units (Retina 2× of 1× CSS)
    T = pts[:n]
    Hh = np.array(H, dtype=float)
    seal_px = SEAL_PX * 2
    ev = []
    for e in truth["events"]:
        if e["kind"] == "closure" and not e.get("weak"):
            on, rel = e["on"] + shift, e["release"] + shift
            wdw = (T >= on - 0.15) & (T <= rel + 0.15)
            sealed = np.where(wdw & (Hh <= seal_px))[0]
            if not len(sealed):
                ev.append({"kind": "closure", "word": e["word"], "unsealed": True})
                continue
            groups = np.split(sealed, np.where(np.diff(sealed) > 1)[0] + 1)
            g = min(groups, key=lambda g: abs((T[g[0]] + T[g[-1]]) / 2 - (on + rel) / 2))
            ev.append({"kind": "closure", "word": e["word"], "seal": float(T[g[0]] - on), "release_off": float((T[g[-1] + 1] if g[-1] + 1 < n else T[g[-1]]) - rel)})
        elif e["kind"] == "vowel":
            pk = e["peak"] + shift
            wdw = np.where((T >= max(e["s"] + shift - 0.04, pk - 0.15)) & (T <= min(e["e"] + shift + 0.04, pk + 0.15)))[0]
            if len(wdw) < 2 or np.all(np.isnan(Hh[wdw])):
                continue
            hm = np.nanmax(Hh[wdw])
            top = wdw[Hh[wdw] >= hm - 2]
            ev.append({"kind": "vowel", "word": e["word"], "off": float(T[top].mean() - pk)})
    # overall lag: opening height vs the mic's loudness
    env, hop = envelope(xm, 48000, hop=0.005, win=0.03)
    te = st.get("audio", 0) + np.arange(len(env)) * hop
    v0, v1 = truth["voice"][0] + shift, truth["voice"][1] + shift
    grid = np.arange(v0, v1, 0.005)
    good = ~np.isnan(Hh)
    le = np.interp(grid, te, env)
    hm = np.interp(grid, T[good], Hh[good])
    la, lb = (le - le.mean()) / le.std(), (hm - hm.mean()) / hm.std()
    best = max(range(-40, 41), key=lambda L: float(np.mean(la[: len(la) - L] * lb[L:])) if L >= 0 else float(np.mean(la[-L:] * lb[: len(lb) + L])))
    cl = [e for e in ev if e["kind"] == "closure" and "seal" in e]
    vw = [e for e in ev if e["kind"] == "vowel"]
    med = lambda v: round(1000 * float(np.median(v)), 1) if len(v) else None
    out = {"run": name, "browser": run.meta.get("browser"), "tap_to_mic_corr": round(corr, 3), "fps": round(1 / np.median(np.diff(T)), 1), "closures": len([e for e in ev if e["kind"] == "closure"]), "sealed": len(cl), "release_med_ms": med([e["release_off"] for e in cl]), "seal_med_ms": med([e["seal"] for e in cl]), "vowel_med_ms": med([e["off"] for e in vw]), "xcorr_lag_ms": best * 5.0, "rows": ev}
    (run.dir / "room.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if k != "rows"}))


if __name__ == "__main__":
    for n in sys.argv[1:]:
        (cal if "-cal-" in n else line)(n)
