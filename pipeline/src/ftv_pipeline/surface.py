"""The GNM skin as a surface for closest-point queries, and the small geometry the add-on and hair tools share:
gnm_surface (the skin_exterior surface, with or without the ears, optionally extended below the bust), Surface (closest
point, interpolated normals), signed_distance, bind_to_gnm / Binding (anchoring points on the skin), similarity_fit
(Umeyama).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from .gnm import GNM

GNM_NECK_Y = 0.134


RIM_EXTRUSION_M = 0.4  # how far both skins are extended below their bottom rim


def similarity_fit(src: np.ndarray, dst: np.ndarray, weights: np.ndarray | None = None) -> tuple[float, np.ndarray, np.ndarray]:
    """Umeyama: (weighted) least-squares scale, rotation, translation with dst ≈ s·R@src + t."""
    src, dst = np.asarray(src, np.float64), np.asarray(dst, np.float64)
    w = np.ones(len(src)) if weights is None else np.asarray(weights, np.float64)
    w = w / w.sum()
    mu_s, mu_d = w @ src, w @ dst
    S, D = src - mu_s, dst - mu_d
    H = (S * w[:, None]).T @ D
    U, sig, Vt = np.linalg.svd(H)
    d = np.ones(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        d[2] = -1.0
    R = Vt.T @ np.diag(d) @ U.T
    scale = float((sig * d).sum() / (w * (S**2).sum(1)).sum())
    t = mu_d - scale * R @ mu_s
    return scale, R, t


@dataclass
class Surface:
    """A triangle soup with a KD-tree over its centroids, for closest-point queries."""

    positions: np.ndarray  # (V, 3)
    triangles: np.ndarray  # (T, 3), indices into positions
    tree: cKDTree
    normals: np.ndarray  # (V, 3) vertex normals

    @classmethod
    def build(cls, positions: np.ndarray, triangles: np.ndarray) -> Surface:
        from .export_glb import vertex_normals

        centroids = positions[triangles].mean(axis=1)
        return cls(positions.astype(np.float64), triangles, cKDTree(centroids), vertex_normals(positions, triangles))

    def closest(self, points: np.ndarray, k: int = 16) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(triangle index, barycentric weights, closest point) per query point: exact closest point on
        each of the k triangles with the nearest centroids, keep the best."""
        points = np.asarray(points, np.float64)
        _, cand = self.tree.query(points, k=k)  # (N, k)
        cand = cand.reshape(len(points), -1)
        tri = self.triangles[cand]  # (N, k, 3)
        a, b, c = (self.positions[tri[:, :, i]] for i in range(3))  # (N, k, 3)
        bary = closest_point_barycentric(points[:, None, :], a, b, c)  # (N, k, 3)
        cp = bary[..., 0:1] * a + bary[..., 1:2] * b + bary[..., 2:3] * c
        d2 = ((cp - points[:, None, :]) ** 2).sum(-1)
        best = d2.argmin(axis=1)
        rows = np.arange(len(points))
        return cand[rows, best].astype(np.int32), bary[rows, best].astype(np.float32), cp[rows, best]

    def normals_at(self, tri: np.ndarray, bary: np.ndarray) -> np.ndarray:
        """Unit interpolated normal at (triangle, barycentric) points."""
        n = np.einsum("nk,nkd->nd", bary.astype(np.float64), self.normals[self.triangles[tri]])
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def closest_point_barycentric(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Barycentric coordinates of the closest point on triangle (a, b, c) to p (Ericson, RTCD 5.1.5), vectorised."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(-1), (ac * ap).sum(-1)
    bp = p - b
    d3, d4 = (ab * bp).sum(-1), (ac * bp).sum(-1)
    cp_ = p - c
    d5, d6 = (ab * cp_).sum(-1), (ac * cp_).sum(-1)
    vc, vb, va = d1 * d4 - d3 * d2, d5 * d2 - d1 * d6, d3 * d6 - d5 * d4
    shape = np.broadcast(d1, d3, d5).shape
    out = np.zeros((*shape, 3), np.float64)
    done = np.zeros(shape, bool)

    def put(mask, w0, w1, w2):
        m = mask & ~done
        for i, w in enumerate((w0, w1, w2)):
            out[..., i][m] = np.broadcast_to(w, shape)[m]
        done[m] = True

    put((d1 <= 0) & (d2 <= 0), 1.0, 0.0, 0.0)  # vertex a
    put((d3 >= 0) & (d4 <= d3), 0.0, 1.0, 0.0)  # vertex b
    with np.errstate(divide="ignore", invalid="ignore"):
        v = d1 / (d1 - d3)
        put((vc <= 0) & (d1 >= 0) & (d3 <= 0), 1.0 - v, v, 0.0)  # edge ab
        put((d6 >= 0) & (d5 <= d6), 0.0, 0.0, 1.0)  # vertex c
        w = d2 / (d2 - d6)
        put((vb <= 0) & (d2 >= 0) & (d6 <= 0), 1.0 - w, 0.0, w)  # edge ac
        w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        put((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0), 0.0, 1.0 - w2, w2)  # edge bc
        denom = va + vb + vc
        v_in, w_in = vb / denom, vc / denom
        put(~done, 1.0 - v_in - w_in, v_in, w_in)  # inside
    return out


def boundary_edges(triangles: np.ndarray) -> np.ndarray:
    """(E, 2) directed edges that belong to exactly one triangle, in that triangle's winding order."""
    directed = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])
    key = np.sort(directed, axis=1)
    _, first, counts = np.unique(key, axis=0, return_index=True, return_counts=True)
    return directed[first[counts == 1]]


def extrude_rim(positions: np.ndarray, triangles: np.ndarray, rim_y_max: float, depth: float = RIM_EXTRUSION_M) -> tuple[np.ndarray, np.ndarray]:
    """Extend an open surface below its bottom rim: every boundary edge below `rim_y_max` gets a
    copy translated by -depth in y and a side quad, wound so the vertex normals keep pointing
    outwards. Returns (positions, triangles) with the new vertices appended."""
    edges = boundary_edges(triangles)
    low = positions[edges][:, :, 1].max(axis=1) < rim_y_max
    edges = edges[low]
    rim = np.unique(edges)
    new_index = {int(v): len(positions) + i for i, v in enumerate(rim)}
    lowered = positions[rim] - np.array([0.0, depth, 0.0], positions.dtype)
    quads = []
    for a, b in edges:  # the adjacent face runs a→b, so the side face must run b→a
        a2, b2 = new_index[int(a)], new_index[int(b)]
        quads.append((b, a, a2))
        quads.append((b, a2, b2))
    return np.concatenate([positions, lowered]), np.concatenate([triangles, np.asarray(quads, triangles.dtype)])


@dataclass
class Binding:
    """Where each point is anchored on the GNM head."""

    triangle: np.ndarray  # (N,) int32 index into `surface_triangles` (GNM vertex ids per corner)
    bary: np.ndarray  # (N, 3) float32
    offset: np.ndarray  # (N, 3) float32 metres: rest position − anchor point
    surface_triangles: np.ndarray  # (T, 3) int32 GNM vertex ids
    normal_distance: np.ndarray  # (N,) float32 metres, signed along the anchor normal (< 0 = under the skin)
    normal: np.ndarray  # (N, 3) float32 unit anchor normal

    @property
    def corners(self) -> np.ndarray:
        """(N, 3) GNM vertex ids of the anchor triangle."""
        return self.surface_triangles[self.triangle]

    def anchors(self, gnm_positions: np.ndarray) -> np.ndarray:
        """(N, 3) anchor points on a (possibly morphed) GNM head."""
        return np.einsum("nk,nkd->nd", self.bary, gnm_positions[self.corners])


def gnm_surface(gnm: GNM, positions: np.ndarray | None = None, ears: bool = False, extrude: bool = False) -> Surface:
    """The skin_exterior surface of the GNM head. Without the ears by default, for roots and anchors (hair over an ear
    follows the skull, not the ear); collision and clearance pass `ears` so hair clears the GNM ears. `extrude` extends
    the bust below its rim, so hair hanging past the cape is measured against the cape's silhouette instead of its
    underside."""
    mask = gnm.vertex_groups["skin_exterior"] > 0.5
    if not ears:
        mask = mask & ~(gnm.vertex_groups["ears"] > 0.5)
    tris = gnm.triangles[mask[gnm.triangles].all(axis=1)]
    pos = gnm.template if positions is None else positions
    if extrude:
        pos, tris = extrude_rim(pos, tris, GNM_NECK_Y + 0.01)
    return Surface.build(pos, tris)


def bind_to_gnm(points: np.ndarray, gnm: GNM, surface: Surface | None = None, k: int = 16) -> Binding:
    """Anchor each point (metres, GNM space) to the closest point on the GNM skin_exterior surface."""
    surface = surface or gnm_surface(gnm)
    tri, bary, cp = surface.closest(points, k=k)
    offset = (np.asarray(points, np.float64) - cp).astype(np.float32)
    n = surface.normals_at(tri, bary)
    return Binding(tri, bary, offset, surface.triangles, (offset * n).sum(1).astype(np.float32), n.astype(np.float32))


def signed_distance(points: np.ndarray, surface: Surface) -> np.ndarray:
    """Distance to the surface, negative under the skin."""
    tri, bary, cp = surface.closest(points)
    off = points - cp
    return np.linalg.norm(off, axis=1) * np.where((off * surface.normals_at(tri, bary)).sum(1) < 0, -1.0, 1.0)
