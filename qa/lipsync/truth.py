# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "torch==2.8.0", "torchaudio==2.8.0", "num2words==0.5.14"]
# ///
"""Audio ground truth for a recorded run, built WITHOUT the app's own code or ElevenLabs' stamps:

  1. a CTC forced aligner (torchaudio wav2vec2 base 960h, ~20 ms frames) places every letter of the spoken text on
     the audio the page actually played (the tapped audio, so underrun gaps are in it);
  2. acoustic landmarks refine the letters that matter for the mouth:
       p/b/m   closure start (sound drops) and release (burst / sound back), on 2 ms envelopes; m uses >1.5 kHz
       f/v/th  hiss onset/end (>3.5 kHz share of the energy)
       vowels  the loudness peak (nucleus)
All times are on the page's AudioContext clock. Writes out/runs/<name>/truth.json.

  uv run truth.py <run> [<run> ...]
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, resample_poly, sosfiltfilt

from runio import HERE, Run

os.environ.setdefault("TORCH_HOME", str(HERE / "out" / ".torch"))

VOWELS = set("aeiouy")
TAG = re.compile(r"\[[^\]]*\]\s*")


def spoken_text(run: Run) -> str:
    """The line's text from the NDJSON the page played (the speak response, or the replayed clip)."""
    if run.meta.get("kind") == "chat":
        return TAG.sub("", run.meta.get("text", "")).strip()
    nd = ""
    if run.speak:
        nd = run.speak[-1].get("text", "")
    if not nd and run.meta.get("clip"):
        nd = Path(run.meta["clip"]).read_text()
    chars = []
    for line in nd.splitlines():
        if not line.strip():
            continue
        j = json.loads(line)
        a = j.get("alignment") or j.get("normalized_alignment")
        if a:
            chars += a["characters"]
    return TAG.sub("", "".join(chars)).strip()


def normalise(text: str) -> str:
    from num2words import num2words

    def num(m: re.Match) -> str:
        s = m.group(0)
        try:
            if re.fullmatch(r"\d+(st|nd|rd|th)", s):
                return num2words(int(s[:-2]), to="ordinal")
            if re.fullmatch(r"(1[1-9]|20)\d\d", s):
                return num2words(int(s), to="year")
            return num2words(float(s) if "." in s else int(s))
        except Exception:
            return s

    text = re.sub(r"\d+(\.\d+)?(st|nd|rd|th)?", num, text)
    text = text.upper().replace("-", " ")
    text = re.sub(r"[^A-Z' ]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def align(x16: np.ndarray, words: list[str]):
    import torch
    import torchaudio

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model()
    labels = bundle.get_labels()  # ('-', '|', 'E', 'T', ...)
    index = {c: i for i, c in enumerate(labels)}
    with torch.inference_mode():
        em, _ = model(torch.from_numpy(x16).float()[None])
        em = torch.log_softmax(em, dim=-1)
    transcript = "|".join(words)
    tokens = [index[c] for c in transcript if c in index]
    ali, scores = torchaudio.functional.forced_align(em, torch.tensor([tokens]), blank=0)
    spans = torchaudio.functional.merge_tokens(ali[0], scores[0].exp())
    ratio = x16.shape[0] / em.shape[1] / 16000  # seconds per emission frame
    out = []
    for s, ch in zip(spans, [c for c in transcript if c in index]):
        out.append({"c": ch, "s": s.start * ratio, "e": s.end * ratio, "p": float(s.score)})
    return out


def band(x, sr, lo=None, hi=None):
    if lo and hi:
        sos = butter(4, [lo, hi], btype="band", fs=sr, output="sos")
    elif lo:
        sos = butter(4, lo, btype="high", fs=sr, output="sos")
    else:
        sos = butter(4, hi, btype="low", fs=sr, output="sos")
    return sosfiltfilt(sos, x)


def db_env(x, sr, hop=0.002, win=0.008):
    h, w = int(sr * hop), int(sr * win)
    n = max(1, (len(x) - w) // h + 1)
    idx = np.arange(w)[None, :] + h * np.arange(n)[:, None]
    e = np.sqrt((x[idx] ** 2).mean(axis=1)) + 1e-6
    return 20 * np.log10(e)


def closure(env, hop, t0, s, e, before=0.12, after=0.1):
    """Quietest stretch near a stop letter [s, e] (seconds from audio start): onset = the energy has fallen halfway (dB)
    from the sound before to the dip; release = halfway back up to the sound after, at the steepest rise."""
    a, b = int(max(0, (s - before) / hop)), int(min(len(env) - 1, (e + after) / hop))
    if b - a < 10:
        return None
    seg = env[a:b]
    sm = np.convolve(seg, np.ones(5) / 5, mode="same")
    k = int(np.argmin(sm))
    dip = sm[k]
    pre = sm[: k + 1].max() if k > 0 else dip
    post = sm[k:].max()
    if min(pre, post) - dip < 6:  # no real closure in the sound
        return {"dip": (a + k) * hop, "depth": float(min(pre, post) - dip), "weak": True}
    half_pre = dip + 0.5 * (pre - dip)
    i = k
    while i > 0 and sm[i] < half_pre:
        i -= 1
    j = k
    half_post = dip + 0.5 * (post - dip)
    while j < len(sm) - 1 and sm[j] < half_post:
        j += 1
    # burst: steepest rise between the dip and the half-way point (+4 ms)
    d = np.diff(seg[k : min(len(seg) - 1, j + 2) + 1])
    burst = k + int(np.argmax(d)) + 1 if len(d) else j
    return {"on": (a + i) * hop, "dip": (a + k) * hop, "release": (a + burst) * hop, "back": (a + j) * hop, "depth": float(min(pre, post) - dip), "weak": False}


def hiss(ratio, hop, s, e, before=0.06, after=0.08):
    a, b = int(max(0, (s - before) / hop)), int(min(len(ratio) - 1, (e + after) / hop))
    if b - a < 6:
        return None
    seg = np.convolve(ratio[a:b], np.ones(5) / 5, mode="same")
    k = int(np.argmax(seg))
    lo = seg.min()
    mid = lo + 0.5 * (seg[k] - lo)
    i = k
    while i > 0 and seg[i] > mid:
        i -= 1
    j = k
    while j < len(seg) - 1 and seg[j] > mid:
        j += 1
    return {"on": (a + i) * hop, "peak": (a + k) * hop, "off": (a + j) * hop, "rise": float(seg[k] - lo)}


def main(name: str):
    run = Run(name)
    ctx = run.ctx_of_speech()
    x, sr, t0 = run.audio(ctx)
    text = spoken_text(run)
    if not text:
        print(f"{name}: no text found, skipped")
        return
    words = normalise(text).split()
    # the voice's extent (first/last 10 ms block above −40 dBFS) — the aligner gets just that, with 0.2 s margins
    env10 = db_env(x, sr, hop=0.01, win=0.02)
    voiced = np.where(env10 > -40)[0]
    if not len(voiced):
        print(f"{name}: silent")
        return
    v0 = max(0, voiced[0] * 0.01 - 0.2)
    v1 = min(len(x) / sr, voiced[-1] * 0.01 + 0.3)
    seg = x[int(v0 * sr) : int(v1 * sr)]
    x16 = resample_poly(seg, 1, 3).astype(np.float32) if sr == 48000 else resample_poly(seg, 16000, sr).astype(np.float32)
    letters = align(x16, words)
    for L in letters:
        L["s"] += v0
        L["e"] += v0

    hop = 0.002
    broad = db_env(x, sr, hop)
    high = db_env(band(x, sr, lo=1500), sr, hop)
    hf = band(x, sr, lo=3500)
    lf = band(x, sr, hi=3500)
    ratio = db_env(hf, sr, hop) - db_env(lf, sr, hop)
    loud = np.convolve(10 ** (broad / 20), np.ones(10) / 10, mode="same")

    # rebuild words → letters with their neighbours, to tell "ph"/"th"/"mb" apart
    events = []
    flat = [L for L in letters if L["c"] != "|"]
    seq = "".join(L["c"] for L in letters).split("|")
    k = 0
    for w in seq:
        wl = flat[k : k + len(w)]
        k += len(w)
        lw = w.lower()
        for i, L in enumerate(wl):
            c = lw[i]
            nxt = lw[i + 1] if i + 1 < len(lw) else ""
            prv = lw[i - 1] if i > 0 else ""
            ev = {"word": lw, "i": i, "c": c, "s": L["s"] + t0, "e": L["e"] + t0, "score": L["p"]}
            if (c in "pb" and nxt != "h" and not (c == "b" and prv == "m")) or (c == "m"):
                if c == "p" and prv == "p" or c == "b" and prv == "b" or c == "m" and prv == "m":
                    continue  # doubled letter: one closure
                cl = closure(high if c == "m" else broad, hop, 0, L["s"], L["e"])
                if cl:
                    ev.update({"kind": "closure", **{k2: (v + t0 if isinstance(v, float) and k2 not in ("depth",) else v) for k2, v in cl.items()}})
                    events.append(ev)
            elif c in "fv" or (c == "p" and nxt == "h") or (c == "t" and nxt == "h"):
                h = hiss(ratio, hop, L["s"], L["e"] + (wl[i + 1]["e"] - L["e"] if nxt == "h" and i + 1 < len(wl) else 0))
                if h:
                    ev.update({"kind": "th" if c == "t" else "fv", **{k2: (v + t0 if k2 != "rise" else v) for k2, v in h.items()}})
                    events.append(ev)
            elif c in VOWELS and not (c == "e" and i == len(lw) - 1 and len(lw) > 2):  # skip silent final e
                if prv in VOWELS:
                    continue  # vowel pair: one nucleus (taken at the first letter, span extended)
                j = i
                while j + 1 < len(lw) and lw[j + 1] in VOWELS:
                    j += 1
                s, e = L["s"], wl[j]["e"]
                a, b = int(s / hop), max(int(s / hop) + 1, int(e / hop))
                pk = a + int(np.argmax(loud[a:b])) if b > a else a
                ev.update({"kind": "vowel", "letters": lw[i : j + 1], "peak": pk * hop + t0, "level": float(20 * np.log10(loud[pk] + 1e-6)), "e": e + t0})
                events.append(ev)

    out = {
        "run": name,
        "ctx": ctx,
        "text": text,
        "words": words,
        "voice": [v0 + t0, v1 + t0],
        "letters": [{**L, "s": L["s"] + t0, "e": L["e"] + t0} for L in letters],
        "events": events,
    }
    (run.dir / "truth.json").write_text(json.dumps(out, indent=1))
    kinds = {}
    for e in events:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(f"{name}: {len(words)} words, {len(letters)} aligned tokens, events {kinds}")


if __name__ == "__main__":
    for n in sys.argv[1:]:
        main(n)
