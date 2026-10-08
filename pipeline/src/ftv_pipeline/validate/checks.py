"""Exact geometric checks: is a posed head physically broken?

"Broken" means impossible, not unusual: eyelids through the eyeball, teeth or mouth through the lips or cheeks, skin
crossing itself, folded (inverted) skin, features merging. GNM's own neutral face already has resting contacts
(the lids sit a little inside the eyeball, the closed lips overlap ~1 mm, the mouth interior overlaps itself), so
every check measures how much WORSE a face is than the neutral face, per vertex or per region, in millimetres.

    eye_lids        outer skin inside the visible eyeball (sclera, iris, pupil: lids, nose, cheeks), mm beyond neutral.
                    The clear cornea bulge does not count: it is invisible in the app, and closing lids slide over it.
                    Broken = one spot deeper than eye_lids_hard_mm, or eye_lids_count spots deeper than eye_lids_mm.
                    The lid edges themselves rest on the eye, so they only count past eye_lids_hard_mm.
    eye_through     the eyeball (cornea included) showing through the outer skin between its vertices, which the
                    vertex depths of eye_lids miss: how far a visible eye point sticks out past the skin on the ray
                    from its pivot, mm beyond neutral
    eye_pivot      eyeball centre (sphere fit to the sclera) off its pivot, mm beyond neutral
    mouth_inside    teeth, gums or tongue through the outer skin (lips, cheeks, chin): how deep, mm (crossing_depth)
    lips_cross      one lip passes through the other: the inner edge of a lip beyond the OUTER edge of the other (lower
                    lip edge above the top of the upper red lip, or the reverse), mm; pressed lips overlap inside the
                    mesh without showing, and that is fine
    self_intersect  skin or mouth lining through itself where the neutral face does not (nose into lip, chin into
                    neck, ear into scalp, cheek through the mouth): how deep, mm (crossing_depth). Lids touching lids,
                    lips touching lips (a blink, closed lips) and an ear's own folds touching are contact.
    folded          outer-skin triangles turned over (facing the other way than at neutral) or squashed flat, away
                    from the lid and lip edges (which squeeze shut on a blink or closed lips). Reported, not a break on
                    its own: skin that turns over without passing through itself is a sharp crease (a hooded lid)
    symmetry        left/right mismatch beyond neutral, mm (only meaningful for symmetric states)

Thresholds: config/validation.toml [checks]. A check fails when its value exceeds its threshold.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from ..export_glb import assign_triangles
from ..parts import PARTS
from ..semantic import config_landmarks
from ..semantic import load_config as load_semantic
from ..surface import Surface
from .model import HeadModel


@dataclass
class Result:
    value: float  # mm (or a count), 0 = as good as the neutral face
    where: int  # a vertex index near the worst spot (-1: none), for heat maps and probes
    fail: bool


class Checker:
    def __init__(self, model: HeadModel, cfg: dict):
        self.model = model
        self.cfg = cfg["checks"]
        g = model.gnm
        T = g.template
        names = [p.name for p in PARTS]
        tri_owner = assign_triangles(model.owner, g.triangles, len(PARTS))
        part = lambda *ns: np.isin(model.owner, [names.index(n) for n in ns])  # noqa: E731
        ext = g.vertex_groups["skin_exterior"] & part("skin")
        self.ext = np.flatnonzero(ext)
        self.ext_tris = g.triangles[ext[g.triangles].all(1)]
        # one crossing test over skin, mouth lining and all of the teeth, gums and tongue (eyes: own check); the back
        # gums sit 15-19 mm inside the skin in front of the ears at neutral, yet some head shapes cross them (GNM#105)
        surf = np.isin(tri_owner, [names.index(n) for n in ("skin", "mouth")])
        inner = np.isin(tri_owner, [names.index(n) for n in ("teeth", "gums", "tongue")])
        self.cross_tris = g.triangles[np.r_[np.flatnonzero(surf), np.flatnonzero(inner)]]
        self.cross_inner = np.r_[np.zeros(surf.sum(), bool), np.ones(inner.sum(), bool)]
        face = Surface.build(T, self.ext_tris)
        cen = T[g.triangles].mean(1)
        _, _, cp = face.closest(cen[inner], k=8)
        back = np.linalg.norm(cen[inner] - cp, axis=1) >= float(self.cfg["mouth_front_mm"]) / 1000
        self.cross_back = np.r_[np.zeros(surf.sum(), bool), back]  # their resting overlap is not contact (_raw)
        self.cross_outer = ext[self.cross_tris].all(1)  # outer skin (the mouth lining and eye sockets are inside)
        # contact that is never breakage: lid on lid (per eye) and lip on lip, near the rims of the openings
        rims = []
        for grp, split_x in (("eye_sockets", True), ("mouth_sock", False)):
            touch = g.vertex_groups[grp][g.triangles].any(1)
            rim = np.unique(g.triangles[touch])
            rim = rim[ext[rim]]
            rims += [rim[T[rim, 0] > 0], rim[T[rim, 0] < 0]] if split_x else [rim]
        zone = float(self.cfg["rim_contact_mm"]) / 1000
        tc = T[self.cross_tris].mean(1)
        self.rim_zone = np.full(len(self.cross_tris), -1)
        for z, rim in enumerate(rims):
            d, _ = cKDTree(T[rim]).query(tc)
            self.rim_zone[(d < zone) & ~self.cross_inner] = z
        # the red lips are soft: red lip on red lip is contact anywhere (pressed or rolled lips), like the mouth rim
        lips = g.vertex_groups["upper_lip"] | g.vertex_groups["lower_lip"]
        self.rim_zone[lips[self.cross_tris].all(1) & ~self.cross_inner] = len(rims) - 1
        # the ear's own folds (rim on inner ridge) touch in ~2% of typical faces, hidden in the fold: contact too
        # (an ear passing into the scalp is still a crossing: those pairs are not both ear)
        ears = g.vertex_groups["ears"]
        self.rim_zone[ears[self.cross_tris].all(1) & (T[self.cross_tris].mean(1)[:, 0] > 0)] = len(rims)
        self.rim_zone[ears[self.cross_tris].all(1) & (T[self.cross_tris].mean(1)[:, 0] < 0)] = len(rims) + 1
        d, _ = cKDTree(T[np.concatenate(rims)]).query(T[self.ext_tris].mean(1))
        self.ext_rim = d < zone  # outer-skin triangles at the lid and lip edges
        eye_rim = np.concatenate(rims[:2])
        d, _ = cKDTree(T[eye_rim]).query(T)
        self.lid_edge = d < float(self.cfg["lid_edge_mm"]) / 1000  # (V,) the lid edges, resting on the eye
        # each eye: its visible surface (sclera + iris + pupil: one nearly convex closed ball) and its sclera
        self.shell_tris, self.sclera = [], []
        for side in ("L", "R"):
            ids = [names.index(f"{n}_{side}") for n in ("sclera", "iris", "pupil")]
            self.shell_tris.append(g.triangles[np.isin(tri_owner, ids)])
            self.sclera.append(np.flatnonzero(part(f"sclera_{side}")))
        # eye_through: each eye's visible points (and its cornea), and the outer skin around it that could cut through it
        # (the clear cornea too: it bulges in front of the iris, and poking through a closing lid it shows as a glossy
        # patch of skin)
        self.shell_v = [np.union1d(np.unique(t), np.flatnonzero(part(f"cornea_{side}"))) for t, side in zip(self.shell_tris, "LR")]
        piv_t = model.pivots(np.zeros(len(model.names), np.float32))
        cen_t = T[self.ext_tris].mean(1)
        self.through_tris = [self.ext_tris[np.linalg.norm(cen_t - piv_t[e], axis=1) < float(self.cfg["eye_through_reach_mm"]) / 1000]
                             for e in range(2)]
        self.through_edge = [self.lid_edge[t].any(1) for t in self.through_tris]  # lid-edge triangles (do not count)
        lm = config_landmarks(load_semantic())
        self.stomion = (lm["stomion_upper"], lm["stomion_lower"])
        self.lip_outer = (lm["labrale_superius"], lm["labrale_inferius"])
        self.mirror = g.mirror
        # the neutral face: every value below is measured against it
        w0 = np.zeros(len(model.names), np.float32)
        P0, piv0 = model.positions(w0), model.pivots(w0)
        self.base = self._raw(P0, piv0, baseline=True)

    # --- the measurements ------------------------------------------------------------------------------------------

    def _eye_depth(self, P: np.ndarray, pivots: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
        """Per eye: (outer-skin vertex ids near it, how deep each is inside the visible eyeball in mm; < 0 = outside).
        The eyeball is nearly convex, so the side of the closest point's normal is a reliable inside test."""
        out = []
        reach = float(self.cfg["eye_reach_mm"]) / 1000
        for e in range(2):
            shell = Surface.build(P, self.shell_tris[e])
            radius = np.linalg.norm(P[np.unique(self.shell_tris[e])] - pivots[e], axis=1).max()
            near = self.ext[np.linalg.norm(P[self.ext] - pivots[e], axis=1) < radius + reach]
            tri, bary, cp = shell.closest(P[near], k=8)
            depth = -np.einsum("ij,ij->i", P[near] - cp, shell.normals_at(tri, bary))
            # the normal side can flip near the iris rim; nothing further than the eye's radius is inside it
            outside = radius - np.linalg.norm(P[near] - pivots[e], axis=1)
            out.append((near, np.minimum(depth, outside) * 1000))
        return out

    def _eye_through(self, P: np.ndarray, pivots: np.ndarray) -> list[np.ndarray]:
        """Per eye: how far (mm) each visible eye point sticks out through the skin: the ray from the pivot through it
        crosses outer skin inside the eye, skin that is not the lid edge (lid edges rest on the eye: eye_lids' business),
        and the point is that far beyond it. 0 where nothing crosses (the eye opening) or only the lid edge does. The skin
        vertices' depth (eye_lids) misses this: a round eye pokes out between the vertices of the flat skin triangles."""
        out = []
        clear = float(self.cfg["eye_through_clearance_mm"]) / 1000
        for e in range(2):
            V = P[self.shell_v[e]] - pivots[e]
            L0 = np.linalg.norm(V, axis=1)
            L = L0 + clear  # skin closer than this to the eyeball shows it through (and flickers): count it as through
            t = ray_hits(V / L0[:, None], P[self.through_tris[e]] - pivots[e])  # (n, m), nan = no hit
            t = np.where(self.through_edge[e][None, :], np.nan, t)  # lid-edge skin does not count
            behind = np.nanmax(np.where(t < L[:, None], t, -np.inf), axis=1)
            out.append(np.where(np.isfinite(behind), (L - behind) * 1000, 0.0))
        return out

    def _sphere_centre(self, X: np.ndarray) -> np.ndarray:
        A = np.c_[2 * X, np.ones(len(X))]
        sol, *_ = np.linalg.lstsq(A, (X ** 2).sum(1), rcond=None)
        return sol[:3]

    def _raw(self, P: np.ndarray, pivots: np.ndarray, baseline: bool = False) -> dict:
        """Per-vertex / per-region raw measurements (the neutral face's are kept as the baseline)."""
        raw = {"eyes": self._eye_depth(P, pivots), "through": self._eye_through(P, pivots)}
        raw["pivot_off"] = [self._sphere_centre(P[self.sclera[e]]) - pivots[e] for e in range(2)]
        up, lo = self.stomion
        ls, li = self.lip_outer
        # > 0: an inner lip edge is past the other lip's outer edge (lower edge above ls, or upper edge below li)
        raw["lip_through"] = max(P[lo].mean(0)[1] - P[ls].mean(0)[1], P[li].mean(0)[1] - P[up].mean(0)[1]) * 1000
        raw["cross"] = intersecting_pairs(P, self.cross_tris)
        n = _face_normals(P, self.ext_tris)
        raw["normals"] = n
        raw["area"] = np.linalg.norm(np.cross(P[self.ext_tris[:, 1]] - P[self.ext_tris[:, 0]], P[self.ext_tris[:, 2]] - P[self.ext_tris[:, 0]]), axis=1)
        flip = np.array([-1.0, 1.0, 1.0])
        raw["asym"] = np.linalg.norm(P[self.ext] - P[self.mirror[self.ext]] * flip, axis=1) * 1000
        if baseline:  # neighbourhoods of the neutral face's own crossings: contact there is not new
            i, j = raw["cross"]
            seed = ~(self.cross_back[i] | self.cross_back[j])  # the back teeth and gums resting in the mouth lining
            touched = np.unique(self.cross_tris[np.r_[i[seed], j[seed]]])
            cen = P[self.cross_tris].mean(1)
            zone = cKDTree(P[touched]).query(cen, distance_upper_bound=float(self.cfg["contact_zone_mm"]) / 1000)[0]
            raw["contact"] = np.isfinite(zone)
            raw["neutral_pairs"] = {(int(a), int(b)) for a, b in zip(i, j)}
        return raw

    def run(self, P: np.ndarray, pivots: np.ndarray, symmetric: bool = False) -> dict[str, Result]:
        b, r, c = self.base, self._raw(P, pivots), self.cfg
        out: dict[str, Result] = {}
        # eyes: skin inside the eyeball, beyond what the neutral lids already do (vertex sets differ: match by id)
        worst, where, spots = 0.0, -1, 0
        for (ids0, d0), (ids, d) in zip(b["eyes"], r["eyes"]):
            base = dict(zip(ids0.tolist(), np.maximum(d0, 0.0).tolist()))
            extra = d - np.array([base.get(i, 0.0) for i in ids.tolist()])
            spots = max(spots, int(((extra > c["eye_lids_mm"]) & ~self.lid_edge[ids]).sum()))
            if len(extra) and extra.max() > worst:
                worst, where = float(extra.max()), int(ids[extra.argmax()])
        out["eye_lids"] = Result(worst, where, worst > c["eye_lids_hard_mm"] or spots >= c["eye_lids_count"])
        # eyes: the eyeball sticking out through the skin, against the neutral face point by point. Unlike a lid pressing
        # into the eye (hidden), an eye showing through skin is seen at any depth: eye_through_mm only absorbs noise
        worst, where = 0.0, -1
        for e, (t0, t) in enumerate(zip(b["through"], r["through"])):
            extra = t - t0
            if extra.max() > worst:
                worst, where = float(extra.max()), int(self.shell_v[e][extra.argmax()])
        out["eye_through"] = Result(worst, where, worst > c["eye_through_mm"])
        off = max(float(np.linalg.norm(r["pivot_off"][e] - b["pivot_off"][e])) for e in range(2)) * 1000
        out["eye_pivot"] = Result(off, -1, off > c["eye_pivot_mm"])
        i, j = r["cross"]
        new = ~(b["contact"][i] & b["contact"][j])  # away from the neutral face's own contacts…
        new &= ~((self.rim_zone[i] >= 0) & (self.rim_zone[i] == self.rim_zone[j]))  # …and not lid-on-lid / lip-on-lip
        inner = self.cross_inner[i] | self.cross_inner[j]
        # teeth, gums and tongue overlap each other and the mouth lining by design: only the outer skin is a barrier
        mouth = new & ((self.cross_inner[i] & self.cross_outer[j]) | (self.cross_inner[j] & self.cross_outer[i]))
        depth = crossing_depth(P, self.cross_tris, i, j)
        k = np.flatnonzero(mouth)
        worst = float(depth[k].max()) if len(k) else 0.0
        where = int(self.cross_tris[i[k[depth[k].argmax()]], 0]) if len(k) else -1
        out["mouth_inside"] = Result(worst, where, worst > c["crossing_depth_mm"])
        lips = r["lip_through"]
        out["lips_cross"] = Result(float(lips), int(self.stomion[1][0]), float(lips) > c["lips_cross_mm"])
        skin = new & ~inner
        k = np.flatnonzero(skin)
        worst = float(depth[k].max()) if len(k) else 0.0
        where = int(self.cross_tris[i[k[depth[k].argmax()]], 0]) if len(k) else -1
        out["self_intersect"] = Result(worst, where, worst > c["crossing_depth_mm"])
        turned = (np.einsum("ij,ij->i", r["normals"], b["normals"]) < 0) | (r["area"] < b["area"] * float(c["squash_ratio"]))
        turned &= ~self.ext_rim
        where = int(self.ext_tris[np.flatnonzero(turned)[0], 0]) if turned.any() else -1
        out["folded"] = Result(float(turned.sum()), where, int(turned.sum()) > c["folded_triangles"])
        asym = r["asym"] - b["asym"]
        k = int(asym.argmax())
        moved = float(np.linalg.norm(P[self.ext] - self.model.gnm.template[self.ext], axis=1).max()) * 1000
        allowed = max(float(c["symmetry_mm"]), float(c["symmetry_share"]) * moved)
        out["symmetry"] = Result(float(asym[k]), int(self.ext[k]), symmetric and float(asym[k]) > allowed)
        return out


def ray_hits(D: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """(n, m): distance along each unit ray from the origin (D, (n, 3)) to each triangle (tri, (m, 3, 3)), nan where it
    misses (Möller–Trumbore, both faces)."""
    A, B, C = tri[:, 0], tri[:, 1], tri[:, 2]
    e1, e2 = B - A, C - A
    h = np.cross(D[:, None, :], e2[None])  # (n, m, 3)
    a = np.einsum("nmk,mk->nm", h, e1)
    ok = np.abs(a) > 1e-14
    f = np.where(ok, 1.0 / np.where(ok, a, 1.0), 0.0)
    s = -A  # origin − A
    u = f * np.einsum("nmk,mk->nm", h, s)
    q = np.cross(s, e1)  # (m, 3)
    v = f * np.einsum("nk,mk->nm", D, q)
    t = f * np.einsum("mk,mk->m", e2, q)[None, :]
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
    return np.where(hit, t, np.nan)


def _face_normals(P: np.ndarray, tris: np.ndarray) -> np.ndarray:
    n = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-18)


# --- triangle / triangle intersection (numpy, no extra dependency) ----------------------------------------------------


def _segment_hits(p0, p1, a, b, c, tol: float = 0.0) -> np.ndarray:
    """Möller–Trumbore, vectorised: does segment p0→p1 cross triangle abc? `tol` > 0 also counts segments passing
    within that share of the triangle's border (the web limiter uses it to see a little more than this exact test)."""
    e1, e2, d = b - a, c - a, p1 - p0
    h = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, h)
    ok = np.abs(det) > 1e-18
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = p0 - a
    u = np.einsum("ij,ij->i", s, h) * inv
    q = np.cross(s, e1)
    v = np.einsum("ij,ij->i", d, q) * inv
    t = np.einsum("ij,ij->i", e2, q) * inv
    return ok & (u >= -tol) & (v >= -tol) & (u + v <= 1 + tol) & (t >= -tol) & (t <= 1 + tol)


def intersecting_pairs(P: np.ndarray, tris: np.ndarray, tol: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Index pairs (i, j) into `tris` of triangles that cross each other (sharing a corner does not count).
    Broad phase: bounding spheres via a KD-tree; then a plane-side rejection; then edge-through-triangle tests."""
    P = P.astype(np.float64)
    V = P[tris]
    cen = V.mean(1)
    rad = np.linalg.norm(V - cen[:, None], axis=2).max(1)
    pairs = cKDTree(cen).query_pairs(2 * float(rad.max()), output_type="ndarray")
    if not len(pairs):
        return np.zeros(0, int), np.zeros(0, int)
    i, j = pairs[:, 0], pairs[:, 1]
    keep = np.linalg.norm(cen[i] - cen[j], axis=1) <= rad[i] + rad[j]
    i, j = i[keep], j[keep]
    keep = ~(tris[i][:, :, None] == tris[j][:, None, :]).any((1, 2))
    i, j = i[keep], j[keep]
    A, B = V[i], V[j]
    nA = np.cross(A[:, 1] - A[:, 0], A[:, 2] - A[:, 0])
    nB = np.cross(B[:, 1] - B[:, 0], B[:, 2] - B[:, 0])
    sB = np.einsum("ikj,ij->ik", B - A[:, :1], nA)
    sA = np.einsum("ikj,ij->ik", A - B[:, :1], nB)
    if tol == 0:  # (with a tolerance, near misses on one side of a plane count too: no plane-side rejection)
        keep = ~((sB > 0).all(1) | (sB < 0).all(1) | (sA > 0).all(1) | (sA < 0).all(1))
        i, j, A, B = i[keep], j[keep], A[keep], B[keep]
    hit = np.zeros(len(i), bool)
    for X, Y in ((A, B), (B, A)):
        for k in range(3):
            hit |= _segment_hits(X[:, k], X[:, (k + 1) % 3], Y[:, 0], Y[:, 1], Y[:, 2], tol)
    return i[hit], j[hit]


def crossing_depth(P: np.ndarray, tris: np.ndarray, i: np.ndarray, j: np.ndarray) -> np.ndarray:
    """How far each crossing pair (i, j) really passes through (mm): for each triangle, how far it pokes through the
    other's plane on its smaller side; the pair's depth is the smaller of the two. A graze (an edge just touching, a
    corner a few microns through) is ~0; a nose pushed into a lip is millimetres."""
    if not len(i):
        return np.zeros(0)
    A, B = P[tris[i]].astype(np.float64), P[tris[j]].astype(np.float64)

    def poke(X, Y):
        n = np.cross(Y[:, 1] - Y[:, 0], Y[:, 2] - Y[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-18)
        d = np.einsum("ikj,ij->ik", X - Y[:, :1], n)  # (k, 3) signed distances of X's corners to Y's plane
        return np.minimum(np.maximum(d, 0).max(1), np.maximum(-d, 0).max(1))

    return np.minimum(poke(A, B), poke(B, A)) * 1000
