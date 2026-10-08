"""Binding a rigid add-on (the glasses: glasses_fit.py, glasses_gen.py) to the GNM head, and where add-ons are written.

Bound holds the rest positions plus one delta array per morph target; bind_rigid bakes a rigid asset's identity
targets from anchor points on the skin (rigid_delta: the best-fit similarity's first-order term) within the shared
limits (MAX_TARGETS, MIN_DELTA_MM).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .export_glb import MODELS_DIR, SHAPE_KINDS
from .gnm import OUT_DIR
from .head_context import HeadContext, head_context
from .surface import bind_to_gnm, similarity_fit

ADDONS_OUT = OUT_DIR / "addons"  # previews, raw/decoded .glb, references, diagnostics (git-ignored)


ADDONS_MODELS_DIR = MODELS_DIR / "addons"  # what ships: <category>/<id>.glb, thumbs/<id>.webp, index.json


MAX_TARGETS = 120  # morph targets per mesh (contract, = head.glb's per-mesh cap); the weakest raw ones are dropped first


PROTECTED_PREFIXES = ("sem_", "emo_")  # semantic sliders and emotions are never dropped (the panel drives them)


MIN_DELTA_MM = 0.01  # a target is kept when it moves at least one vertex this far at weight 1.0


def rotation_vector(R: np.ndarray) -> np.ndarray:
    """Axis · angle (radians) of a rotation matrix (angles well below 180°)."""
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / 2.0  # axis · sin(angle)
    s, c = np.linalg.norm(w), (np.trace(R) - 1.0) / 2.0
    return np.zeros(3) if s < 1e-12 else w / s * math.atan2(s, c)


@dataclass
class Bound:
    """An asset bound to the head: rest positions plus one delta array per morph target."""

    positions: np.ndarray  # (N, 3) float32 metres, GNM template space
    deltas: dict[str, np.ndarray]  # target name → (N, 3) float32 metres at weight 1.0, in head.glb's target order
    dropped: dict[str, float] = field(default_factory=dict)  # targets left out → their largest delta in mm


def _select_targets(candidates: dict[str, np.ndarray], min_delta_mm: float, max_targets: int) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    """Keep the targets that move a vertex ≥ min_delta_mm; above max_targets drop the weakest."""
    size = {n: float(np.linalg.norm(d, axis=1).max()) * 1000.0 for n, d in candidates.items()}
    names = [n for n in candidates if size[n] >= min_delta_mm]
    dropped = {n: round(size[n], 4) for n in candidates if size[n] < min_delta_mm}
    if len(names) > max_targets:
        raw = [n for n in names if not n.startswith(PROTECTED_PREFIXES)]
        weakest = sorted(raw, key=lambda n: size[n])[: len(names) - max_targets]
        dropped.update({n: round(size[n], 4) for n in weakest})
        names = [n for n in names if n not in weakest]
    return {n: candidates[n] for n in names}, dropped


def similarity_generator(anchors: np.ndarray, moved: np.ndarray, weights: np.ndarray | None = None) -> tuple[float, np.ndarray, np.ndarray, np.ndarray]:
    """(scale − 1, rotation vector ω, anchor centroid c, centroid shift Δc) of the best-fit
    similarity transform anchors → moved (weighted Umeyama, surface.similarity_fit)."""
    anchors, moved = np.asarray(anchors, np.float64), np.asarray(moved, np.float64)
    w = np.ones(len(anchors)) if weights is None else np.asarray(weights, np.float64)
    w = w / w.sum()
    s, R, _ = similarity_fit(anchors, moved, w)
    c = w @ anchors
    return s - 1.0, rotation_vector(R), c, w @ moved - c


def rigid_delta(vertices: np.ndarray, anchors: np.ndarray, moved: np.ndarray, weights: np.ndarray | None = None) -> np.ndarray:
    """The morph delta of a rigid body that rests on `anchors` when the anchors go to `moved`.

    The maths. Let a_k be the anchors on the template head and a'_k = a_k + d_k the same skin
    points with one morph target at weight 1.0. The best-fit similarity transform (least squares,
    Umeyama) is

        x' = s · R (x − c) + c',        c = Σ w_k a_k,   c' = Σ w_k a'_k

    with scale s, rotation R and the weighted anchor centroids c, c'. A morph target is LINEAR in
    its weight, so what is baked is the transform's first-order term: with R = exp([ω]×) and
    s = 1 + σ,

        δ(x) = Δc + σ · (x − c) + ω × (x − c),        Δc = c' − c.

    The terms dropped are second order in σ and |ω| (a 3° rotation 8 cm from the centroid: 0.1 mm).
    The delta is exact for a pure translation of the anchors (σ = 0, ω = 0 → δ = Δc everywhere)
    and for a pure scaling about any point p (a' = p + k (a − p) → δ(x) = (k − 1)(x − p)), it is
    antisymmetric in the weight (−1 undoes +1), and several targets add up like their transforms
    do to first order.

    vertices (N, 3), anchors (K, 3), moved (K, 3), K ≥ 3 and not collinear → (N, 3) float32."""
    sigma, omega, c, dc = similarity_generator(anchors, moved, weights)
    x = np.asarray(vertices, np.float64) - c
    return (dc + sigma * x + np.cross(omega, x)).astype(np.float32)


def bind_rigid(vertices: np.ndarray, anchors: np.ndarray, *, ctx: HeadContext | None = None, weights: np.ndarray | None = None,
               min_delta_mm: float = MIN_DELTA_MM, max_targets: int = MAX_TARGETS) -> Bound:
    """Bind a rigid asset (glasses) to anchor points on the head: identity targets only.

    anchors : (K, 3) points on or near the GNM template skin, K ≥ 3 and not collinear (nose bridge
              + the two temple/ear contacts; more points make the fit steadier). They are bound to
              the skin with the ears (closest point, barycentric), so each target moves them the
              way it moves the skin under them; `rigid_delta` turns the moved anchors into one
              delta per vertex. Expression targets are never baked: glasses do not follow speech.
    weights : (K,) how much each anchor counts in the best-fit transform (default: all the same)."""
    ctx = ctx or head_context()
    anchors = np.asarray(anchors, np.float64)
    if len(anchors) < 3:
        raise ValueError("bind_rigid needs at least 3 anchors")
    spread = np.linalg.svd(anchors - anchors.mean(0), compute_uv=False)
    if spread[1] < 1e-3 * spread[0]:
        raise ValueError("the anchors are collinear: the rotation about their line is undetermined")
    binding = bind_to_gnm(anchors, ctx.gnm, ctx.skin_ears)
    on_skin = binding.anchors(ctx.gnm.template)  # the anchors' foot points; the offsets ride along unchanged
    corners = binding.corners
    candidates = {}
    for t in ctx.targets:
        if t.kind not in SHAPE_KINDS:
            continue
        d = np.einsum("nk,nkd->nd", binding.bary, t.delta[corners]).astype(np.float64)
        candidates[t.name] = rigid_delta(vertices, on_skin, on_skin + d, weights)
    deltas, dropped = _select_targets(candidates, min_delta_mm, max_targets)
    return Bound(np.asarray(vertices, np.float32).copy(), deltas, dropped)
