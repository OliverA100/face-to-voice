"""Named points on the GNM head (eyeball centres, the midline profile's landmarks, chin, ear tops), and the table that
pairs them with the same points on the aligned MakeHuman head (saved in config/guides/landmarks.json, guides.py) for the
glasses solver."""
from __future__ import annotations

import functools

import numpy as np

from .gnm import GNM
from .surface import Surface, gnm_surface

PROFILE_STEP_M = 0.0005  # sampling of the midline profile


LANDMARK_NAMES = ("eye_left", "eye_right", "nose_bridge", "nose_tip", "subnasale", "lip_upper", "stomion", "lip_lower",
                  "labiomental", "chin_front", "chin")


def midline_profile(surface: Surface, ys: np.ndarray, x0: float = 0.0) -> np.ndarray:
    """z of the front-most surface point on the line (x0, y, ·) per y: the face's profile curve.
    Rays that pass through a gap (between the lips) are filled in from their neighbours."""
    pos, tris = surface.positions, surface.triangles
    a, b, c = (pos[tris[:, i]] for i in range(3))
    xs = np.stack([a[:, 0], b[:, 0], c[:, 0]])
    sel = (xs.min(0) <= x0) & (xs.max(0) >= x0) & (np.maximum(np.maximum(a[:, 2], b[:, 2]), c[:, 2]) > 0.0)
    a, b, c = a[sel], b[sel], c[sel]
    v0, v1 = b[:, :2] - a[:, :2], c[:, :2] - a[:, :2]
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    ok = np.abs(den) > 1e-14
    z = np.full(len(ys), np.nan)
    for i, y in enumerate(ys):
        p = np.array([x0, y]) - a[:, :2]
        with np.errstate(all="ignore"):
            u = (p[:, 0] * v1[:, 1] - v1[:, 0] * p[:, 1]) / den
            v = (v0[:, 0] * p[:, 1] - p[:, 0] * v0[:, 1]) / den
        hit = ok & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
        if hit.any():
            z[i] = (a[hit, 2] + u[hit] * (b[hit, 2] - a[hit, 2]) + v[hit] * (c[hit, 2] - a[hit, 2])).max()
    good = np.isfinite(z)
    good &= z > np.nanmedian(z) - 0.03  # a ray through the mouth gap lands deep inside
    return np.interp(ys, ys[good], z[good])


def profile_landmarks(surface: Surface, eye_y: float, x0: float = 0.0) -> dict[str, np.ndarray]:
    """Midline landmarks from the profile curve, top to bottom: nose bridge (sellion, the deepest
    point of the nose root), nose tip, subnasale, upper lip, stomion (between the lips), lower lip,
    labiomental fold, chin front (pogonion). Below the nose tip they are the alternating local
    minima and maxima of the profile's depth, in that order."""
    ys = np.arange(eye_y - 0.14, eye_y + 0.02, PROFILE_STEP_M)
    z = midline_profile(surface, ys, x0)
    z = np.convolve(np.pad(z, 2, mode="edge"), np.ones(5) / 5.0, mode="valid")  # 2.5 mm moving average
    at = lambda i: np.array([x0, ys[i], z[i]])  # noqa: E731
    nose = np.flatnonzero((ys > eye_y - 0.06) & (ys < eye_y - 0.015))
    tip = int(nose[z[nose].argmax()])
    root = np.flatnonzero((ys > ys[tip] + 0.015) & (ys < eye_y + 0.015))
    out = {"nose_bridge": at(int(root[z[root].argmin()])), "nose_tip": at(tip)}
    i = tip
    for name, sign in (("subnasale", -1.0), ("lip_upper", 1.0), ("stomion", -1.0), ("lip_lower", 1.0), ("labiomental", -1.0), ("chin_front", 1.0)):
        # walk down while the profile keeps going the way of this extremum (deeper for a minimum, further out for a maximum)
        while i > 0 and sign * (z[i - 1] - z[i]) >= 0.0:
            i -= 1
        out[name] = at(i)
    return out


def _eye_centres(left: np.ndarray, right: np.ndarray) -> dict[str, np.ndarray]:
    """Centres of the two eyeballs' bounding boxes; "left" is the one on +x."""
    a, b = ((p.min(0) + p.max(0)) / 2.0 for p in (left, right))
    return {"eye_left": a, "eye_right": b} if a[0] > b[0] else {"eye_left": b, "eye_right": a}


def gnm_landmarks(gnm: GNM, positions: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Named points on the GNM head (template, or `positions` of a morphed head): LANDMARK_NAMES
    (eyeball centres, the midline profile's landmarks, "chin": the gnathion, the most forward-and-down midline point) plus the two
    ear tops (the highest point of the ear's root, where a temple arm rests)."""
    pos = (gnm.template if positions is None else positions).astype(np.float64)
    out = _eye_centres(pos[gnm.vertex_groups["left_eye"]], pos[gnm.vertex_groups["right_eye"]])
    out.update(profile_landmarks(gnm_surface(gnm, pos.astype(np.float32), ears=True), float(out["eye_left"][1])))
    ids = np.flatnonzero(gnm.vertex_groups["skin_exterior"] & (gnm.template[:, 1] > 0.15) & (np.abs(gnm.template[:, 0]) < 0.005))
    out["chin"] = pos[ids[(pos[ids, 2] - pos[ids, 1]).argmax()]]  # gnathion: most forward-and-down midline point
    # Ear root: ear vertices that share a triangle with non-ear skin; its top is the highest of them per side.
    ears = gnm.vertex_groups["ears"]
    tri_ears = ears[gnm.triangles]
    root = np.zeros(len(pos), bool)
    root[gnm.triangles[tri_ears.any(axis=1) & ~tri_ears.all(axis=1)].ravel()] = True
    root &= ears
    for side, sign in (("left", 1.0), ("right", -1.0)):
        ids = np.flatnonzero(root & (sign * gnm.template[:, 0] > 0))
        out[f"ear_top_{side}"] = pos[ids[pos[ids, 1].argmax()]]
    return out


@functools.cache
def landmark_table() -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """name → (point on the aligned MakeHuman head, point on the GNM template head), for LANDMARK_NAMES. The MakeHuman
    points come from config/guides/landmarks.json (guides.py)."""
    from .guides import mh_landmarks

    mh, gn = mh_landmarks(), gnm_landmarks(GNM.load())
    return {n: (mh[n], gn[n]) for n in LANDMARK_NAMES}
