"""`uv run groom-metrics [ours:<id> | bystedt:<style>] ...`: measure strand grooms the same way, to compare our
procedural grooms (groom.py) with artist-made ones. All grooms are measured on the GNM head (Bystedt's fitted as
import_hair.py does).

Metrics (per groom):
  length       p10 / p50 / p90 strand length (mm)
  standoff     median / p90 distance from the skin (mm) at the crown, at ear level and below the ears
  bend         large-scale turning (degrees per cm, segments of 10 mm): S-curves, drape
  frizz        small-scale turning (degrees per cm, 3 mm segments) minus the large-scale part
  coherence    mean cosine between a strand's mid direction and its 12 root-neighbours' (1 = locks move together)
  spread       neighbour distance at the tip ÷ at the root (< 1 clumped, > 1 fanning out)
  layering     share of strand points that have another strand's points within 2 mm outside them (hair over hair)
"""
from __future__ import annotations

import argparse

import numpy as np
from scipy.spatial import cKDTree

from .gnm import GNM
from .groom import resample


def load(spec: str, gnm: GNM) -> np.ndarray:
    kind, name = spec.split(":", 1)
    if kind == "ours":
        from .groom import build, load_specs

        return build(load_specs()[name], gnm, log=lambda *a: None).strands
    from . import import_hair as ih

    if kind != "bystedt":
        raise SystemExit(f"unknown groom source {kind!r}: use ours:<id> or bystedt:<style>")
    strands, head_v, _ = ih.load_bystedt(name)
    s, R, t = ih.fit_head(head_v, gnm)
    rng = np.random.default_rng(1)
    if len(strands) > 6000:
        strands = [strands[i] for i in rng.choice(len(strands), 6000, replace=False)]
    return ih.fit_strands(strands, s, R, t, gnm, 32)


def turning(strands: np.ndarray, seg_mm: float) -> np.ndarray:
    """Mean turning angle (degrees per cm) per strand, after resampling to `seg_mm` segments."""
    out = []
    for s in strands:
        L = np.linalg.norm(np.diff(s, axis=0), axis=1).sum()
        n = max(3, int(L * 1000 / seg_mm))
        r = resample(s, n)
        d = np.diff(r, axis=0)
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)
        ang = np.degrees(np.arccos(np.clip((d[1:] * d[:-1]).sum(1), -1, 1)))
        out.append(ang.sum() / max(L * 100, 1e-6))
    return np.array(out)


def measure(strands: np.ndarray, gnm: GNM) -> dict:
    from .surface import gnm_surface

    surf = gnm_surface(gnm, ears=True, extrude=True)
    N, P, _ = strands.shape
    seg = np.linalg.norm(np.diff(strands, axis=1), axis=2)
    L = seg.sum(1) * 1000
    pts = strands.reshape(-1, 3)
    tri, bary, cp = surf.closest(pts)
    nrm = surf.normals_at(tri, bary)
    dist = ((pts - cp) * nrm).sum(1) * 1000
    y = pts[:, 1]
    bands = {"crown": y > 0.36, "ears": (y > 0.25) & (y <= 0.33), "below": y <= 0.22}
    standoff = {k: (round(float(np.median(dist[m])), 1), round(float(np.percentile(dist[m], 90)), 1)) if m.sum() > 50 else None for k, m in bands.items()}
    bend = turning(strands[::4], 10)
    fine = turning(strands[::4], 3)
    roots = strands[:, 0]
    k = 13
    _, nb = cKDTree(roots).query(roots, k=k)
    mid = strands[:, P // 2] - strands[:, P // 2 - 1]
    mid /= np.maximum(np.linalg.norm(mid, axis=1, keepdims=True), 1e-12)
    coh = (mid[nb[:, 1:]] * mid[:, None, :]).sum(2).mean()
    root_d = np.linalg.norm(roots[nb[:, 1:]] - roots[:, None, :], axis=2).mean(1)
    tips = strands[:, -1]
    tip_d = np.linalg.norm(tips[nb[:, 1:]] - tips[:, None, :], axis=2).mean(1)
    spread = np.median(tip_d / np.maximum(root_d, 1e-6))
    # layering: is there hair within 2 mm further out (away from the head centre) than this point?
    centre = np.array([0, 0.29, 0.01])
    sample = pts[np.random.default_rng(0).choice(len(pts), min(20000, len(pts)), replace=False)]
    tree = cKDTree(pts)
    out_dir = (sample - centre) / np.linalg.norm(sample - centre, axis=1, keepdims=True)
    probe = sample + out_dir * 0.002
    layered = np.mean([len(h) > 2 for h in tree.query_ball_point(probe, 0.0015)])
    return {
        "strands": N,
        "length_mm": tuple(np.percentile(L, [10, 50, 90]).round(0).tolist()),
        "standoff_mm": standoff,
        "bend_deg_cm": round(float(np.median(bend)), 1),
        "frizz_deg_cm": round(float(np.median(fine - bend)), 1),
        "coherence": round(float(coh), 3),
        "spread": round(float(spread), 2),
        "layering": round(float(layered), 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("grooms", nargs="+")
    args = ap.parse_args()
    gnm = GNM.load()
    rows = [(g, measure(load(g, gnm), gnm)) for g in args.grooms]
    keys = list(rows[0][1])
    print("groom".ljust(22) + "".join(k.ljust(30) for k in keys[1:]))
    for g, m in rows:
        print(g.ljust(22) + "".join(str(m[k]).ljust(30) for k in keys[1:]))
