"""Glasses on the GNM head: an optician's fit and a binding whose arms follow the head's width; glasses_gen.py fits
its frames with it.

Placement (`place_glasses`) is the way an optician fits a frame, in small moves that are solved
one after the other a few times:
  0. size:   GlassesFit.scale about the bridge;
  1. centre: the frame keeps its position relative to the aligned MakeHuman head's eyes (landmarks.landmark_table),
             moved onto the GNM eyes;
  2. seat:   slide along z until the front (bridge, pads, rims) touches the skin with NOSE_CLEAR_M to spare;
  3. splay:  open or close the temple arms (a shear in x behind the hinge) until they pass the side of
             the head with ARM_CLEAR_M to spare: no arm cuts through the temple;
  4. tilt:   pitch about the front until the arms' underside rests EAR_GAP_M above the ear root.
The anchors the rigid binder follows are the nose root, the skin beside each arm at the temple, and
the two ear roots (5 points, weighted by ANCHOR_WEIGHT).

Other faces (`bind_glasses`): per identity target the anchors' best-fit similarity transform
(addon_fit.bind_rigid), plus a correction from the same solver: one similarity cannot follow the head's
WIDTH (a rounder face is wider at the temples, not at the nose), so per target the head is posed at
+1 and −1, the splay and the seat are solved again, and half the difference is baked as that
target's extra linear term. The front stays rigid; the arms open and close like a real frame's.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .addon_fit import MIN_DELTA_MM, Bound, bind_rigid
from .head_context import HeadContext
from .landmarks import gnm_landmarks, landmark_table, midline_profile
from .surface import gnm_surface, signed_distance


@dataclass(frozen=True)
class GlassesFit:
    """The knobs place_glasses reads."""

    scale: float = 1.0  # size relative to the source, applied about the nose bridge before the frame is seated
    offset_m: tuple[float, float, float] = (0.0, 0.0, 0.0)  # last manual nudge, GNM axes
    min_delta_mm: float = MIN_DELTA_MM  # a target is baked when it moves some vertex at least this far at weight 1.0


HINGE_DEPTH_M = 0.022  # the front is this deep (from the front-most vertex back); behind it the arms begin


ARM_MIN_X_M = 0.04  # arm vertices are further than this from the midline (nose pads also reach back, near the midline)


NOSE_CLEAR_M = 0.0003  # gap left between the front and the skin where they touch


ARM_CLEAR_M = 0.0015  # gap between the arms and the side of the head (spare room: other identities are followed only approximately)


EAR_GAP_M = 0.0005  # the arms' underside rests this far above the ear root's top


EAR_BAND_M = 0.006  # … measured on the part of the arm within this distance (in z) of the ear root


SAMPLE_STEP_M = 0.003  # triangle edges are sampled this densely for the clearance tests (arms have few vertices)


SPLAY_LIMITS = (-0.3, 0.5)  # shear of the arms (metres sideways per metre back); > 0 opens them


TILT_LIMITS_DEG = (-10.0, 10.0)


SEAT_LIMITS_M = (-0.02, 0.02)


# How much each anchor counts in the binder's best-fit transform. The nose leads: a bridge that sinks into the nose
# shows more than an arm 1 mm off the temple (the arms' distance from the head is the splay's job).
ANCHOR_WEIGHT = {"nose": 6.0, "temple": 1.0, "ear": 1.0}


ROUNDS = 5  # seat → splay → tilt, repeated (each move disturbs the others a little)


@dataclass
class Placement:
    """The fitted frame: its binding (rest positions on the template head plus one delta per identity target) and the
    solver's numbers (seat, splay, tilt, the gaps it left, the anchors, the width corrections it baked)."""

    bound: Bound
    report: dict


def _edge_samples(triangles: np.ndarray, positions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Points along every triangle edge, as (vertex a, vertex b, t): vertices included, edges split to ≤ SAMPLE_STEP_M."""
    edges = np.unique(np.sort(np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]), axis=1), axis=0)
    n = np.maximum(np.ceil(np.linalg.norm(positions[edges[:, 0]] - positions[edges[:, 1]], axis=1) / SAMPLE_STEP_M).astype(int), 1)
    a, b, t = [], [], []
    for k in range(int(n.max()) + 1):
        sel = n >= k
        a.append(edges[sel, 0]), b.append(edges[sel, 1]), t.append(k / n[sel])
    return np.concatenate(a), np.concatenate(b), np.concatenate(t)


def _solve(f, lo: float, hi: float, steps: int = 24) -> float:
    """Root of an increasing function by bisection; the nearer limit when there is none inside."""
    if f(lo) >= 0:
        return lo
    if f(hi) <= 0:
        return hi
    for _ in range(steps):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    return (lo + hi) / 2


def place_glasses(asset, ctx: HeadContext) -> Placement:
    """See the module docstring. `asset` needs .style.fit (GlassesFit), .aligned (N, 3: the frame relative to the
    MakeHuman eyes) and .triangles (the ones the clearance tests sample)."""
    fit = asset.style.fit
    table, marks = landmark_table(), gnm_landmarks(ctx.gnm)
    eyes_mh = (table["eye_left"][0] + table["eye_right"][0]) / 2
    eyes = (table["eye_left"][1] + table["eye_right"][1]) / 2
    ear = (marks["ear_top_left"] + marks["ear_top_right"]) / 2  # both ears as one height and depth: the frame stays level
    start = asset.aligned.astype(np.float64)
    start[:, 0] -= (start[:, 0].min() + start[:, 0].max()) / 2 - eyes_mh[0]  # the asset's own centre on the eyes' centre
    bridge = np.array([eyes_mh[0], eyes_mh[1], start[:, 2].max()])
    start = bridge + fit.scale * (start - bridge)  # size, about the bridge
    start += (eyes - eyes_mh) * (1, 1, 0) + np.asarray(fit.offset_m, np.float64)
    hinge_z = start[:, 2].max() - HINGE_DEPTH_M
    arm = (np.abs(start[:, 0]) > ARM_MIN_X_M) & (start[:, 2] < hinge_z)
    pivot = np.array([0.0, eyes[1], hinge_z])
    sa, sb, st = _edge_samples(asset.triangles, start)
    sample_arm = arm[sa] & arm[sb]

    def pose(seat: float, splay: float, tilt_deg: float) -> np.ndarray:
        p = start.copy()
        p[:, 0] += np.where(arm, np.sign(p[:, 0]) * splay * (hinge_z - p[:, 2]), 0.0)
        c, s = np.cos(np.radians(tilt_deg)), np.sin(np.radians(tilt_deg))  # > 0 lowers the arms' ends
        d = p - pivot
        p[:, 1], p[:, 2] = pivot[1] + c * d[:, 1] + s * d[:, 2], pivot[2] - s * d[:, 1] + c * d[:, 2]
        p[:, 2] += seat
        return p

    def samples(p: np.ndarray, sel: np.ndarray) -> np.ndarray:
        return p[sa[sel]] + st[sel, None] * (p[sb[sel]] - p[sa[sel]])

    def front_gap(seat, splay, tilt):
        return signed_distance(samples(pose(seat, splay, tilt), ~sample_arm), ctx.skin).min() - NOSE_CLEAR_M

    def arm_gap(seat, splay, tilt):
        q = samples(pose(seat, splay, tilt), sample_arm)
        q = q[q[:, 2] > ear[2] - EAR_BAND_M]  # behind the ear the tips may tuck in
        return signed_distance(q, ctx.skin).min() - ARM_CLEAR_M

    def ear_gap(seat, splay, tilt):
        level = samples(pose(seat, splay, 0.0), sample_arm)[:, 2]  # the band is chosen before tilting, so it is the same for every tilt
        band = np.abs(level - ear[2]) < EAR_BAND_M
        if not band.any():  # a short arm that ends before the ear: its last few millimetres
            band = level < level.min() + EAR_BAND_M
        q = samples(pose(seat, splay, tilt), sample_arm)[band]
        return ear[1] + EAR_GAP_M - q[:, 1].min()  # increasing in tilt: a larger tilt lowers the arm

    seat = splay = tilt = 0.0
    for _ in range(ROUNDS):
        seat = _solve(lambda v, splay=splay, tilt=tilt: front_gap(v, splay, tilt), *SEAT_LIMITS_M)
        splay = _solve(lambda v, seat=seat, tilt=tilt: arm_gap(seat, v, tilt), *SPLAY_LIMITS)
        tilt = _solve(lambda v, seat=seat, splay=splay: ear_gap(seat, splay, v), *TILT_LIMITS_DEG)
    seat = _solve(lambda v: front_gap(v, splay, tilt), *SEAT_LIMITS_M)
    out = pose(seat, splay, tilt)

    # Anchors, symmetric by construction: the nose root on the midline at eye height, the skin beside each arm halfway
    # between hinge and ear (found on the left, mirrored to the right), the two ear roots.
    names = ("nose", "temple_left", "temple_right", "ear_left", "ear_right")
    nose = np.array([0.0, eyes[1], midline_profile(ctx.skin, np.array([eyes[1]]))[0]])
    arms = samples(out, sample_arm & (start[sa, 0] > 0))
    temple = ctx.skin.closest(arms[[np.abs(arms[:, 2] - (hinge_z + seat + ear[2]) / 2).argmin()]])[2][0]
    anchors = np.stack([nose, temple, temple * (-1, 1, 1), marks["ear_top_left"], marks["ear_top_right"]])
    weights = np.array([ANCHOR_WEIGHT[n.split("_")[0]] for n in names])
    lever = np.where(arm, np.sign(start[:, 0]) * (hinge_z - start[:, 2]), 0.0)  # sideways metres per unit of splay, as in `pose`
    in_front_of_ear = samples(out, sample_arm)[:, 2] > ear[2] - EAR_BAND_M
    bound, followed = bind_glasses(out, anchors, weights, lever, (sa, sb, st), sample_arm, in_front_of_ear, ctx, fit.min_delta_mm)
    report = {"scale": fit.scale, "seat_mm": round(seat * 1000, 2), "splay": round(splay, 4), "tilt_deg": round(tilt, 2),
              "eyes_shift_mm": [round(float(v) * 1000, 2) for v in (eyes - eyes_mh)],
              "front_gap_mm": round(float(front_gap(seat, splay, tilt) + NOSE_CLEAR_M) * 1000, 2),
              "arm_gap_mm": round(float(arm_gap(seat, splay, tilt) + ARM_CLEAR_M) * 1000, 2),
              "ear_gap_mm": round(float(EAR_GAP_M - ear_gap(seat, splay, tilt)) * 1000, 2),
              "front_width_mm": round(float(np.ptp(out[~arm, 0])) * 1000, 1),
              "anchors": {n: [round(float(x), 5) for x in a] for n, a in zip(names, anchors)},
              "followed": followed}
    return Placement(bound, report)


FOLLOW_SPLAY_LIMITS = (-0.12, 0.12)  # per identity target at weight ±1: how far the arms may open or close


# The splay is solved on the part of the arms at least this far behind the hinge: right behind the hinge a millimetre of
# clearance costs a centimetre at the ear (the front's width is rigid, a wider temple there is the frame size's matter).
FOLLOW_MIN_LEVER_M = 0.03


FOLLOW_SEAT_LIMITS_M = (-0.006, 0.006)  # … and the frame slide along z


FOLLOW_MIN = (0.002, 0.0002)  # corrections below this (splay, seat in metres) are not baked


def bind_glasses(positions: np.ndarray, anchors: np.ndarray, weights: np.ndarray, lever: np.ndarray,
                 edge_samples: tuple[np.ndarray, np.ndarray, np.ndarray], sample_arm: np.ndarray, in_front_of_ear: np.ndarray,
                 ctx: HeadContext, min_delta_mm: float) -> tuple[Bound, dict]:
    """addon_fit.bind_rigid plus the width correction (module docstring): per identity target and sign,
    the head is posed, the frame follows by the baked similarity delta, then the arms' splay is
    solved against the posed skin (ARM_CLEAR_M) and the seat (NOSE_CLEAR_M); half the difference
    between +1 and −1 is that target's extra term: delta.x += splay · lever, delta.z += seat.
    Returns (Bound, {target: [splay, seat in mm]} of the corrections that were baked)."""
    bound = bind_rigid(positions, anchors, ctx=ctx, weights=weights, min_delta_mm=min_delta_mm)
    sa, sb, st = edge_samples
    arm_part = sample_arm.copy()
    arm_part[sample_arm] = in_front_of_ear  # behind the ear the tips may tuck in
    arm_part &= np.abs(lever[sa] + st * (lever[sb] - lever[sa])) >= FOLLOW_MIN_LEVER_M
    followed = {}
    for name, delta in bound.deltas.items():
        solved = []
        for sign in (1.0, -1.0):
            skin = gnm_surface(ctx.gnm, ctx.head({name: sign}))
            p = positions.astype(np.float64) + sign * delta

            def sampled(q: np.ndarray, sel: np.ndarray) -> np.ndarray:
                return q[sa[sel]] + st[sel, None] * (q[sb[sel]] - q[sa[sel]])

            def arm_gap(k: float) -> float:
                return signed_distance(sampled(p + np.outer(k * lever, (1.0, 0.0, 0.0)), arm_part), skin).min() - ARM_CLEAR_M  # noqa: B023

            splay = _solve(arm_gap, *FOLLOW_SPLAY_LIMITS, steps=12)
            p = p + np.outer(splay * lever, (1.0, 0.0, 0.0))
            seat = _solve(lambda z: signed_distance(sampled(p + np.array((0.0, 0.0, z)), ~sample_arm), skin).min() - NOSE_CLEAR_M,  # noqa: B023
                          *FOLLOW_SEAT_LIMITS_M, steps=12)
            solved.append((splay, seat))
        splay, seat = (solved[0][0] - solved[1][0]) / 2.0, (solved[0][1] - solved[1][1]) / 2.0
        if abs(splay) < FOLLOW_MIN[0] and abs(seat) < FOLLOW_MIN[1]:
            continue
        extra = np.zeros_like(delta)
        extra[:, 0], extra[:, 2] = splay * lever, seat
        bound.deltas[name] = (delta + extra).astype(np.float32)
        followed[name] = [round(splay, 4), round(seat * 1000, 2)]
    return bound, followed
