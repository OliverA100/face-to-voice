# /// script
# requires-python = "==3.12.*"
# dependencies = ["numpy", "scipy", "mediapipe==0.10.14"]
# ///
"""Real people's lips around p/b/m, from the GRID audio-visual corpus (CC BY 4.0, Cooke et al. 2006; 25 fps video of
34 talkers reading "bin blue at f two now"-style sentences): the targets the app's mouth is tuned toward.

Per sentence: the lips from MediaPipe's face mesh (inner-lip gap, mouth width, nose-to-chin, each over the distance
between the outer eye corners), the sound from the video's own audio track, the words from GRID's alignments. Per
word-initial p/b/m ("bin", "blue", "by", "place", "please", the letters "b" and "p"): the acoustic closure (truth.py's
closure(): where the sound falls, the burst) and, on the lips (interpolated between frames), when they start closing,
when they are shut and when they part. Per sentence: the best lag between the lip gap and the loudness.

  uv run grid.py <talker zip dir, e.g. out/grid/s1> [--max 300]     → out/grid/<talker>.jsonl
  uv run grid.py --summary out/grid/*.jsonl                          → the numbers, per talker and pooled

Times in s; negative = before the acoustic moment. "on" = the sound has fallen halfway into the closure, "burst" =
the release in the sound.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from truth import band, closure, db_env, hiss  # noqa: E402

FPS = 25
LIP_UP, LIP_DOWN, CORNER_L, CORNER_R, EYE_L, EYE_R, NOSE, CHIN = 13, 14, 61, 291, 33, 263, 1, 152
PBM_WORDS = {"bin", "blue", "by", "place", "please", "b", "p"}
FV_WORDS = {"four", "five"}  # word-initial f
SR = 16000


def frames(video: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    w, h = 360, 288
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)], capture_output=True, text=True).stdout.strip()
    if probe:
        w, h = (int(v) for v in probe.split(",")[:2])
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def audio(video: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def lips(mesh, fr: np.ndarray) -> np.ndarray:
    """Per frame: [gap, width, jaw] over the eye-corner distance (NaN where no face)."""
    out = np.full((len(fr), 3), np.nan)
    for k, f in enumerate(fr):
        r = mesh.process(f)
        if not r.multi_face_landmarks:
            continue
        p = np.array([[q.x * f.shape[1], q.y * f.shape[0]] for q in r.multi_face_landmarks[0].landmark])
        eye = np.linalg.norm(p[EYE_L] - p[EYE_R])
        out[k] = [np.linalg.norm(p[LIP_UP] - p[LIP_DOWN]) / eye, np.linalg.norm(p[CORNER_L] - p[CORNER_R]) / eye, np.linalg.norm(p[NOSE] - p[CHIN]) / eye]
    return out


def words(align: Path) -> list[tuple[float, float, str]]:
    out = []
    for line in align.read_text().split("\n"):
        parts = line.split()
        if len(parts) == 3:
            out.append((int(parts[0]) / 25000, int(parts[1]) / 25000, parts[2]))
    return out


def analyse(video: Path, align: Path, mesh) -> dict | None:
    fr = frames(video)
    x = audio(video)
    if len(fr) < 10 or len(x) < SR:
        return None
    L = lips(mesh, fr)
    t = np.arange(len(fr)) / FPS + 0.5 / FPS  # each frame's middle
    ok = ~np.isnan(L[:, 0])
    if ok.sum() < 0.8 * len(fr):
        return None
    gap = np.interp(np.arange(0, t[-1], 0.001), t[ok], L[ok, 0])  # 1 ms grid, between frames
    g = lambda s: gap[min(len(gap) - 1, max(0, int(round(s * 1000))))]
    lo, hi = np.percentile(L[ok, 0], [2, 95])
    shut = lo + 0.15 * (hi - lo)  # this sentence's "lips together"
    hop = 0.002
    env = db_env(x, SR, hop=hop, win=0.008)
    ws = words(align)
    # the word timings must fit this recording: the voice starts with the first word (from 150 ms before to 300 ms after)
    first = next((a for a, b, w in ws if w != "sil"), None)
    loudish = np.convolve(env > env.max() - 20, np.ones(15), mode="valid") >= 15  # 30 ms within 20 dB of the peak
    onset = next((k * hop for k, v in enumerate(loudish) if v), None)
    if first is None or onset is None or not -0.15 <= onset - first <= 0.3:  # a first "b/p" is silent until its burst
        return None
    events = []
    for s, e, w in ws:
        if w not in PBM_WORDS:
            continue
        c = closure(env, hop, 0.0, s, min(e, s + 0.08), before=0.12, after=0.1)
        if not c or c.get("weak"):
            continue
        on, burst = c["on"], c["release"]
        a, b = int(max(0, (on - 0.25) * 1000)), int(min(len(gap) - 1, (burst + 0.15) * 1000))
        seg = gap[a:b]
        closed = np.where(seg <= shut)[0]
        ev = {"word": w, "on": on, "burst": burst, "dur": burst - on, "min_gap": float((seg.min() - lo) / (hi - lo))}
        if len(closed):
            # the shut stretch nearest the acoustic closure
            runs = np.split(closed, np.where(np.diff(closed) > 1)[0] + 1)
            mid = ((on + burst) / 2) * 1000 - a
            r = min(runs, key=lambda q: abs((q[0] + q[-1]) / 2 - mid))
            seal, part = (a + r[0]) / 1000, (a + r[-1] + 1) / 1000
            # closing starts: the last top of the gap in the 300 ms before the seal
            k = r[0]
            while k > 0 and k > r[0] - 300 and seg[k - 1] >= seg[k]:
                k -= 1
            ev.update(seal=seal - on, release=part - burst, close_start=(a + k) / 1000 - on, shut_ms=(part - seal) * 1000)
        events.append(ev)
    # f/v: the hiss (high band over low band, as truth.py) and the smallest lip gap near it (the lower lip on the teeth)
    ratio = db_env(band(x, SR, lo=3500), SR, hop) - db_env(band(x, SR, hi=3500), SR, hop)
    fvs = []
    for s, e, w in ws:
        if w not in FV_WORDS:
            continue
        h = hiss(ratio, hop, s, min(e, s + 0.1))
        if not h:
            continue
        a, b = int(max(0, (h["on"] - 0.12) * 1000)), int(min(len(gap) - 1, (h["off"] + 0.04) * 1000))
        if b > a:
            fvs.append({"word": w, "on": h["on"], "off": (a + int(np.argmin(gap[a:b]))) / 1000 - h["on"]})
    # vowels: each word's loudest moment, and when the lips are widest within 150 ms of it
    loud = np.convolve(10 ** (env / 20), np.ones(10) / 10, mode="same")
    vowels = []
    for s, e, w in ws:
        if w == "sil" or e - s < 0.08:
            continue
        a, b = int(s / hop), int(e / hop)
        pk = (a + int(np.argmax(loud[a:b]))) * hop
        lo2, hi2 = int(max(0, (max(s - 0.04, pk - 0.15)) * 1000)), int(min(len(gap) - 1, (min(e + 0.04, pk + 0.15)) * 1000))
        if hi2 - lo2 > 20:
            seg = gap[lo2:hi2]
            top = np.where(seg >= seg.max() - 0.02 * (hi - lo))[0]
            vowels.append({"word": w, "peak": pk, "off": (lo2 + top.mean()) / 1000 - pk})
    # the gap against the loudness over the voice: best lag (positive = the lips late)
    voiced = [(s, e) for s, e, w in ws if w != "sil"]
    if voiced:
        v0, v1 = voiced[0][0], voiced[-1][1]
        grid = np.arange(v0, v1, 0.005)
        le = np.interp(grid, np.arange(len(env)) * hop, env)
        gm = np.array([g(q) for q in grid])
        A, B = (le - le.mean()) / (le.std() + 1e-9), (gm - gm.mean()) / (gm.std() + 1e-9)
        best = max(range(-40, 41), key=lambda k: float(np.mean(A[: len(A) - k] * B[k:])) if k >= 0 else float(np.mean(A[-k:] * B[: len(B) + k])))
        lag = best * 0.005
    else:
        lag = None
    return {"video": video.stem, "events": events, "fv": fvs, "vowels": vowels, "lag": lag, "faces": float(ok.mean())}


def summary(files: list[str]) -> None:
    rows = {}
    for f in files:
        talker = Path(f).stem
        rows[talker] = [json.loads(l) for l in open(f)]
    def stats(v):
        v = np.array([q for q in v if q is not None]) * 1000
        if not len(v):
            return "–"
        return f"{np.median(v):+5.0f} (p10 {np.percentile(v, 10):+5.0f}, p90 {np.percentile(v, 90):+5.0f}, n {len(v)})"
    pooled = {k: [] for k in ("close_start", "seal", "release", "lag")}
    print("talker  sentences  closing starts (vs sound falls)      lips shut (vs sound falls)          lips part (vs burst)              gap vs loudness lag")
    for talker, rs in sorted(rows.items()):
        ev = [e for r in rs for e in r["events"]]
        d = {k: [e.get(k) for e in ev if k in e] for k in ("close_start", "seal", "release")}
        d["lag"] = [r["lag"] for r in rs if r["lag"] is not None]
        for k in pooled:
            pooled[k] += d[k]
        sealed = sum(1 for e in ev if "seal" in e)
        print(f"{talker:7} {len(rs):9}  {stats(d['close_start'])}  {stats(d['seal'])}  {stats(d['release'])}  {stats(d['lag'])}   sealed {sealed}/{len(ev)}")
    print(f"{'all':7} {sum(len(r) for r in rows.values()):9}  {stats(pooled['close_start'])}  {stats(pooled['seal'])}  {stats(pooled['release'])}  {stats(pooled['lag'])}")


if __name__ == "__main__":
    if sys.argv[1] == "--summary":
        summary(sys.argv[2:])
        sys.exit()
    import mediapipe as mp

    talker = Path(sys.argv[1])
    cap = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 300
    aligns = HERE / "out" / "grid" / "align" / "alignments" / talker.name
    out = HERE / "out" / "grid" / f"{talker.name}.jsonl"
    vids = sorted(v for v in talker.rglob("*.mpg") if not v.name.startswith("._") and "__MACOSX" not in v.parts)[:cap]
    done = {json.loads(l)["video"] for l in open(out)} if out.exists() else set()
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=False, max_num_faces=1, refine_landmarks=True) as mesh, open(out, "a") as fo:
        for n, v in enumerate(vids):
            if v.stem in done:
                continue
            # the alignment of this sentence: in the talker's folder, else wherever it is (the archive files some talkers'
            # word timings under another number: s11's videos match s10's names, s20's s21's); checked against the sound
            al = aligns / f"{v.stem}.align"
            if not al.exists():
                al = next(iter(sorted((aligns.parent).glob(f"*/{v.stem}.align"))), None)
                if al is None:
                    continue
            r = analyse(v, al, mesh)
            if r:
                fo.write(json.dumps(r) + "\n")
                fo.flush()
            if n % 50 == 0:
                print(f"{talker.name}: {n}/{len(vids)}", flush=True)
