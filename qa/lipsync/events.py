# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Pairs every audio event (truth.json) with what the mouth did on screen (mouth.json) and prints the offsets.

Time base: the "heard" clock. A sample the page played at context time X is heard when currentTime − outputLatency
(the browser's report) reaches X; each frame is placed at the heard time of the moment it was drawn. So offsets already include the latency the browser REPORTS; the real device delay is measured
separately (capture-room).  Positive = the mouth is LATE.

  closure  p/b/m: seal start − sound stops (on); release (lips part) − burst; closing movement start − on
  vowel    widest opening in the vowel − its loudness peak
  fv       narrowest opening near the hiss − hiss onset (rough: lip-to-teeth shows as a small gap, not a seal)
  xcorr    opening height vs loudness, best lag in ±200 ms

  uv run events.py <run> [...]          → out/runs/<name>/events.json + a summary line
"""

from __future__ import annotations

import json
import sys

import numpy as np

from runio import RUNS as RUNS_DIR, Run, envelope

SEAL_PX = 3.4  # opening height at or under which the lips count as sealed (px on a 1× canvas; a closed lip line is ~2–3)


def heard_times(run: Run, ctx: int) -> dict[int, float]:
    """Each frame's heard time, by the rule the room recordings back (docs/lipsync.md): ctx.currentTime minus the
    reported outputLatency. Not getOutputTimestamp: Firefox's and Safari's leave the output delay out. Chrome's
    currentTime moves in 10.7 ms steps; between steps the time is carried on performance.now (at most 12 ms), as the
    app's clock does."""
    out = {}
    last_t, since = None, 0.0
    for r in run.frames:
        if len(r["ctx"]) <= ctx:
            continue
        c = r["ctx"][ctx]
        if c["t"] != last_t:
            last_t, since = c["t"], r["perf"]
        carry = min(0.012, max(0.0, (r["perf"] - since) / 1000))
        lat = c.get("out") or 0
        if not lat and c.get("otp") and c.get("otc") is not None:  # no outputLatency (older Safari): from the timestamp
            lat = max(0.0, c["t"] - (c["otc"] + (r["perf"] - c["otp"]) / 1000))
        out[r["i"]] = c["t"] + carry - lat
    return out


# --app: the app's own mouth values instead of pixels (needs ?debug; works on any skin tone). Openness is a weighted
# sum of the open shapes; "sealed" = closure shapes (PP + FF) ≥ 0.85, mapped onto the same height scale (sealed → 0).
OPEN_W = {"aa": 1.0, "E": 0.6, "I": 0.45, "O": 0.75, "U": 0.5, "DD": 0.35, "SS": 0.3, "TH": 0.3}


def app_mouth(run: Run) -> dict[int, dict]:
    out = {}
    for r in run.frames:
        a = (r.get("app") or {}).get("act")
        if not a:
            continue
        closed = a.get("PP", 0) + a.get("FF", 0)
        h = sum(a.get(k, 0) * w for k, w in OPEN_W.items()) * 20 * max(0.0, 1 - closed)
        out[r["i"]] = {"height": 0.0 if closed >= 0.85 else max(h, 3.5 * (1 - closed / 0.85) + 0.01), "area": h}
    return out


APP = "--app" in sys.argv


def analyse(name: str, seal_px: float | None = None):
    run = Run(name)
    if APP:
        seal_px = SEAL_PX
    if seal_px is None and not APP:  # SEAL_PX is for a 1× canvas; grabs are at the canvas's own resolution
        c = next((r["canvas"] for r in run.frames if r.get("canvas")), [1, 1, 1, 1])
        seal_px = SEAL_PX * c[0] / c[2]
    truth = json.loads((run.dir / "truth.json").read_text())
    mouth = app_mouth(run) if APP else {int(k): v for k, v in json.loads((run.dir / "mouth.json").read_text()).items()}
    ctx = truth["ctx"]
    ht = heard_times(run, ctx)
    idx = sorted(i for i in mouth if i in ht)
    T = np.array([ht[i] for i in idx])
    Hh = np.array([mouth[i]["height"] for i in idx], dtype=float)
    A = np.array([mouth[i]["area"] for i in idx], dtype=float)
    C = np.array([bool(mouth[i].get("clipped")) for i in idx])  # the lips left the crop (head moved): not measurable
    order = np.argsort(T)
    T, Hh, A, C = T[order], Hh[order], A[order], C[order]
    fps = 1 / np.median(np.diff(T)) if len(T) > 2 else 0

    rows = []
    unmeasured = 0
    mids = sorted((e["on"] + e["release"]) / 2 for e in truth["events"] if e["kind"] == "closure" and not e.get("weak"))

    def owner(t: float) -> float:
        """The acoustic closure whose middle is nearest t (each seal on screen belongs to one closure)."""
        return min(mids, key=lambda m: abs(m - t))

    for e in truth["events"]:
        if e["kind"] == "closure" and not e.get("weak"):
            on, rel = e["on"], e["release"]
            w = (T >= on - 0.15) & (T <= rel + 0.15)
            if not w.any():
                continue
            if C[w].any():
                unmeasured += 1
                continue
            sealed = w & (Hh <= seal_px)
            r = {"kind": "closure", "c": e["c"], "word": e["word"], "on": on, "release": rel, "minH": float(Hh[w].min())}
            mid = (on + rel) / 2
            si = np.where(sealed)[0]
            runs = [g for g in (np.split(si, np.where(np.diff(si) > 1)[0] + 1) if len(si) else []) if owner((T[g[0]] + T[g[-1]]) / 2) == mid]
            if runs:
                # the sealed stretch nearest the acoustic closure (and nearer to it than to any other closure)
                best = min(runs, key=lambda g: abs((T[g[0]] + T[g[-1]]) / 2 - mid))
                s0, s1 = best[0], best[-1]
                r["seal"] = float(T[s0]) - on
                r["release_off"] = (float(T[s1 + 1]) if s1 + 1 < len(T) else float(T[s1])) - rel
                r["seal_ms"] = (float(T[s1]) - float(T[s0])) * 1000 + 1000 / max(fps, 1)
                # closing movement start: last local max of opening height in the 300 ms before the seal
                k = s0
                lo = np.searchsorted(T, T[s0] - 0.3)
                while k > lo and Hh[k - 1] >= Hh[k]:
                    k -= 1
                r["close_start"] = float(T[k]) - on
            else:
                r["unsealed"] = True
            rows.append(r)
        elif e["kind"] == "vowel":
            pk = e["peak"]
            w = (T >= max(e["s"] - 0.04, pk - 0.15)) & (T <= min(e["e"] + 0.04, pk + 0.15))
            if w.sum() < 2:
                continue
            if C[w].any():
                unmeasured += 1
                continue
            j = np.where(w)[0]
            # plateau-aware: centre of the frames within 1 px of the max
            hm = Hh[j].max()
            top = j[Hh[j] >= hm - 1]
            rows.append({"kind": "vowel", "c": e["letters"], "word": e["word"], "peak": pk, "level": e["level"], "off": float(T[top].mean()) - pk, "maxH": float(hm)})
        elif e["kind"] in ("fv", "th"):
            w = (T >= e["on"] - 0.12) & (T <= e["off"] + 0.04)
            if w.sum() < 2:
                continue
            if C[w].any():
                unmeasured += 1
                continue
            j = np.where(w)[0]
            k = j[int(np.argmin(Hh[j]))]
            rows.append({"kind": e["kind"], "c": e["c"], "word": e["word"], "on": e["on"], "off": float(T[k]) - e["on"], "minH": float(Hh[k])})

    # cross-correlation: opening height vs loudness (5 ms grid over the voice)
    x, sr, t0 = run.audio(ctx)
    env, hop = envelope(x, sr, hop=0.005, win=0.03)
    te = t0 + np.arange(len(env)) * hop
    v0, v1 = truth["voice"]
    grid = np.arange(v0, v1, 0.005)
    le = np.interp(grid, te, env)
    hm = np.interp(grid, T, Hh) if len(T) else np.zeros_like(grid)
    best, lag = -2.0, 0.0
    if hm.std() > 0 and le.std() > 0:
        a = (le - le.mean()) / le.std()
        b = (hm - hm.mean()) / hm.std()
        for L in range(-40, 41):
            if L >= 0:
                c = float(np.mean(a[: len(a) - L] * b[L:]))
            else:
                c = float(np.mean(a[-L:] * b[: len(b) + L]))
            if c > best:
                best, lag = c, L * 5.0

    def ms(v):
        return None if v is None else round(1000 * v, 1)

    cl = [r for r in rows if r["kind"] == "closure"]
    sealed = [r for r in cl if "seal" in r]
    vw = [r for r in rows if r["kind"] == "vowel"]
    fv = [r for r in rows if r["kind"] in ("fv",)]
    med = lambda a: float(np.median(a)) if len(a) else None
    p90 = lambda a: float(np.percentile(np.abs(a), 90)) if len(a) else None
    summary = {
        "run": name,
        "fps": round(fps, 1),
        "closures": len(cl),
        "sealed": len(sealed),
        "release_med_ms": ms(med([r["release_off"] for r in sealed])),
        "release_p90abs_ms": ms(p90([r["release_off"] for r in sealed])),
        "seal_med_ms": ms(med([r["seal"] for r in sealed])),
        "close_start_med_ms": ms(med([r["close_start"] for r in sealed])),
        "vowels": len(vw),
        "vowel_med_ms": ms(med([r["off"] for r in vw])),
        "vowel_p90abs_ms": ms(p90([r["off"] for r in vw])),
        "fv": len(fv),
        "fv_med_ms": ms(med([r["off"] for r in fv])),
        "xcorr_lag_ms": lag,
        "xcorr": round(best, 3),
        "unmeasured": unmeasured,
    }
    # drift: release offsets vs time along the line
    if len(sealed) >= 4:
        tt = np.array([r["on"] for r in sealed])
        oo = np.array([r["release_off"] for r in sealed])
        summary["drift_ms_per_5s"] = round(float(np.polyfit(tt - tt[0], oo, 1)[0]) * 5000, 1)
    summary["source"] = "app" if APP else "pixels"
    (run.dir / ("events-app.json" if APP else "events.json")).write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
    return summary, rows


if __name__ == "__main__":
    verbose = "-v" in sys.argv
    for n in [a for a in sys.argv[1:] if not a.startswith("-")]:
        if not ((RUNS_DIR / n / "meta.json").exists() and (RUNS_DIR / n / "truth.json").exists()):
            continue  # nothing spoken (calibration runs), or a run cut short
        s, rows = analyse(n)
        print(json.dumps(s))
        if verbose:
            for r in rows:
                print("  ", {k: (round(v * 1000) if isinstance(v, float) and k not in ("minH", "maxH", "level", "seal_ms") else v) for k, v in r.items() if k not in ("on", "release", "peak")})
