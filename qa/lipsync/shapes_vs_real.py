# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""The mouth's size per vowel against real talkers' (GRID, gridframes.py): how far the lips open and how much wider or
narrower the mouth gets than at rest, at each vowel's loudest moment, per vowel class; and the spread of the opening
over all moments inside words (the aligner's word spans for the app, GRID's for the talkers). The opening counts from each sentence's most closed moment (its p/b/m). Real lips are measured over the outer-eye-corner distance and put in mm with the app's own
(88 mm); the app's from a bench run made with out/shape_coefs.json (pipeline rig shape_coefs.py).

  uv run shapes_vs_real.py <bench tag> [<set regex, default ^T\\d>]
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).parent
EYES = json.loads((HERE / "out" / "shape_coefs.json").read_text())["rest"]["eyes"]
# GRID's words → the class of their (stressed) vowel
CLASS = {"open": "at a r one five nine white by i y now".split(), "mid": "set red seven again lay place eight h j k f l m n s x".split(),
         "spread": "bin green three please in with six b c d e g p t v z zero".split(), "round": "blue two soon four o q u".split()}
WORD_CLASS = {w: c for c, ws in CLASS.items() for w in ws}
APP_CLASS = {"aa": "open", "E": "mid", "I": "spread", "O": "round", "U": "round"}
LAG = 0.027  # real lips are widest ~27 ms after the loudest moment (human.py)


def real(only=None):
    out = {c: {"gap": [], "width": []} for c in CLASS}
    voiced_gap = []
    for f in sorted((HERE / "out" / "grid" / "frames").glob("s*.jsonl")):
        if only and f.stem != only:
            continue
        for line in open(f):
            r = json.loads(line)
            L = np.array([[np.nan if q is None else q for q in row] for row in r["lips"]], float)
            ok = ~np.isnan(L[:, 0])
            if ok.sum() < 0.8 * len(L):
                continue
            t = np.arange(len(L)) / r["fps"] + 0.5 / r["fps"]
            gap = lambda s: np.interp(s, t[ok], L[ok, 0]) * EYES
            width = lambda s: np.interp(s, t[ok], L[ok, 1]) * EYES
            sil = [(a, b) for a, b, w in r["words"] if w == "sil"]
            if not sil or sil[0][1] - sil[0][0] < 0.3:
                continue
            rest_t = np.arange(sil[0][0] + 0.05, sil[0][1] - 0.1, 0.04)
            rest_w = np.median([width(s) for s in rest_t])
            rest_g = np.percentile(L[ok, 0], 2) * EYES  # the sentence's most closed (p/b/m), not rest: some breathe open-mouthed
            db = np.array(r["db"])
            for a, b, w in r["words"]:
                if w == "sil":
                    continue
                k0, k1 = int(a / 0.01), int(b / 0.01)
                if k1 - k0 < 6:
                    continue
                pk = (k0 + int(np.argmax(db[k0:k1]))) * 0.01 + LAG
                for s in np.arange(a, b, 0.04):
                    voiced_gap.append(gap(s) - rest_g)
                c = WORD_CLASS.get(w)
                if c:
                    out[c]["gap"].append(gap(pk) - rest_g)
                    out[c]["width"].append(width(pk) - rest_w)
    return out, voiced_gap


def word_spans(tr):
    """Each word's span from the aligner's letters ("|" between words), as GRID's alignments give theirs."""
    spans, cur = [], []
    for l in tr["letters"] + [{"c": "|"}]:
        if l["c"] == "|":
            if cur:
                spans.append((cur[0]["s"], cur[-1]["e"]))
            cur = []
        else:
            cur.append(l)
    return spans


def app(tag, rx):
    out = {c: {"gap": [], "width": []} for c in CLASS}
    voiced_gap = []
    for f in sorted((HERE / "out" / "bench").glob(f"{tag}-*.json")):
        if not re.match(rx, f.stem[len(tag) + 1 :]):
            continue
        b = json.loads(f.read_text())
        if "width" not in b["frames"][0]:
            sys.exit(f"{f.name}: no width (make out/shape_coefs.json, then bench again)")
        tr = json.loads(Path(b["clip"][: -len(".ndjson")] + ".truth.json").read_text())
        T = np.array([q["t"] for q in b["frames"]])
        for w0, w1 in word_spans(tr):
            for s in np.arange(w0, w1, 0.04):
                voiced_gap.append(b["frames"][min(len(T) - 1, int(np.searchsorted(T, s)))]["gap"])
        for e in tr["events"]:
            if e["kind"] != "vowel":
                continue
            k = min(len(T) - 1, int(np.searchsorted(T, e["peak"] + 0.007)))
            q = b["frames"][k]
            v = max(APP_CLASS, key=lambda x: q["act"].get(x, 0))
            if q["act"].get(v, 0) < 0.2:
                continue
            out[APP_CLASS[v]]["gap"].append(q["gap"])
            out[APP_CLASS[v]]["width"].append(q["width"])
    return out, voiced_gap


def row(name, d, vg):
    cells = []
    for c in CLASS:
        g, w = np.array(d[c]["gap"]), np.array(d[c]["width"])
        cells.append(f"{c:6} n {len(g):4}  open {np.median(g):5.1f}  width {np.median(w):+5.1f}" if len(g) else f"{c:6} –")
    vg = np.array(vg)
    print(f"{name:8} voiced opening p50 {np.percentile(vg, 50):4.1f}  p90 {np.percentile(vg, 90):4.1f} mm")
    for c in cells:
        print(f"{'':8} {c}")


def app_mp(rx):
    """The app's recorded face through the same MediaPipe measure (appframes.py → <run>/mp.json)."""
    out = {c: {"gap": [], "width": []} for c in CLASS}
    voiced_gap = []
    for d in sorted((HERE / "out" / "runs").glob(rx)):
        if not (d / "mp.json").exists() or not (d / "truth.json").exists():
            continue
        rows = json.loads((d / "mp.json").read_text())
        tr = json.loads((d / "truth.json").read_text())
        t = np.array([r["t"] for r in rows]); g = np.array([r["gap"] for r in rows]) * EYES; w = np.array([r["width"] for r in rows]) * EYES
        quiet = (t < tr["voice"][0] - 0.1) | (t > tr["voice"][1] + 0.6)
        if quiet.sum() < 5:
            continue
        rest_w, rest_g = np.median(w[quiet]), np.percentile(g, 2)
        for w0, w1 in word_spans(tr):
            for s in np.arange(w0, w1, 0.04):
                voiced_gap.append(np.interp(s, t, g) - rest_g)
        for e in tr["events"]:
            if e["kind"] != "vowel":
                continue
            s = e["peak"] + LAG
            k = int(np.argmin(np.abs(t - s)))
            act = rows[k]["act"] or {}
            v = max(APP_CLASS, key=lambda x: act.get(x, 0))
            if act.get(v, 0) < 0.2:
                continue
            out[APP_CLASS[v]]["gap"].append(np.interp(s, t, g) - rest_g)
            out[APP_CLASS[v]]["width"].append(np.interp(s, t, w) - rest_w)
    return out, voiced_gap


if __name__ == "__main__":
    if "--talkers" in sys.argv:
        for tk in ("s1", "s4", "s11", "s20"):
            row(tk, *real(tk))
        sys.exit()
    if "--mp" in sys.argv:
        row("real", *real())
        row("app (mp)", *app_mp(sys.argv[sys.argv.index("--mp") + 1]))
        sys.exit()
    row("real", *real())
    if len(sys.argv) > 1:
        row(sys.argv[1], *app(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else r"^T\d"))
