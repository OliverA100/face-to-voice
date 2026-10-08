"""surface.py: closest points, signed distance and the Umeyama fit on small synthetic meshes (no GNM needed)."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.surface import (
    Surface,
    boundary_edges,
    closest_point_barycentric,
    extrude_rim,
    signed_distance,
    similarity_fit,
)


def cube(n: int = 3) -> Surface:
    """The cube [-1, 1]³, each face an n × n grid of outward-wound triangle pairs (Surface.closest looks at 16)."""
    pos, tris = [], []
    for axis in range(3):
        for sign in (-1.0, 1.0):
            normal = np.eye(3)[axis] * sign
            u = np.eye(3)[(axis + 1) % 3]
            v = np.cross(normal, u)  # u × v = the outward normal
            base = len(pos)
            pos.extend(normal + u * (2 * i / n - 1) + v * (2 * j / n - 1) for i in range(n + 1) for j in range(n + 1))
            for i in range(n):
                for j in range(n):
                    a, b, c, d = (base + (i + di) * (n + 1) + j + dj for di, dj in ((0, 0), (1, 0), (1, 1), (0, 1)))
                    tris += [(a, b, c), (a, c, d)]
    return Surface.build(np.array(pos), np.array(tris))


def test_cube_is_wound_outwards():
    s = cube()
    assert ((s.normals * s.positions).sum(1) > 0).all()  # every vertex normal points away from the centre


@pytest.mark.parametrize(("point", "expected"), [
    ((0.0, 0.0, 3.0), 2.0),  # above a face's middle
    ((0.2, -0.3, 1.5), 0.5),
    ((0.0, 0.0, 0.5), -0.5),  # inside: negative
    ((0.0, 0.0, 0.0), -1.0),
    ((2.0, 2.0, 0.0), np.sqrt(2.0)),  # beside an edge
])
def test_signed_distance_to_a_cube(point, expected):
    assert signed_distance(np.array([point]), cube())[0] == pytest.approx(expected)


def test_closest_point_lies_on_the_surface():
    s = cube()
    tri, bary, cp = s.closest(np.array([[0.3, 0.4, 5.0], [5.0, 0.1, -0.2]]))
    np.testing.assert_allclose(cp, [[0.3, 0.4, 1.0], [1.0, 0.1, -0.2]])
    np.testing.assert_allclose(bary.sum(1), 1.0, rtol=1e-6)
    np.testing.assert_allclose(np.einsum("nk,nkd->nd", bary, s.positions[s.triangles[tri]]), cp, atol=1e-6)


@pytest.mark.parametrize(("p", "bary"), [
    ((-1.0, -1.0, 0.0), (1, 0, 0)),  # nearest vertex a
    ((3.0, -0.5, 0.0), (0, 1, 0)),  # nearest vertex b
    ((0.5, -1.0, 0.0), (0.5, 0.5, 0)),  # nearest edge ab
    ((0.25, 0.25, 7.0), (0.5, 0.25, 0.25)),  # above the inside
])
def test_closest_point_barycentric_regions(p, bary):
    a, b, c = np.array([0.0, 0, 0]), np.array([1.0, 0, 0]), np.array([0.0, 1, 0])
    got = closest_point_barycentric(np.array(p), a, b, c)
    np.testing.assert_allclose(got, bary, atol=1e-12)


def test_similarity_fit_recovers_a_known_transform():
    rng = np.random.default_rng(4)
    src = rng.normal(size=(40, 3))
    angle = 0.7
    R = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    t = np.array([0.1, -2.0, 0.5])
    s, R_fit, t_fit = similarity_fit(src, 1.3 * src @ R.T + t)
    assert s == pytest.approx(1.3)
    np.testing.assert_allclose(R_fit, R, atol=1e-10)
    np.testing.assert_allclose(t_fit, t, atol=1e-10)


def test_extrude_rim_adds_a_skirt_below_the_open_edge():
    # an open square in the y = 0 plane facing up: its four rim edges are all "low"
    pos = np.array([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], float)
    tris = np.array([[0, 2, 1], [0, 3, 2]])
    assert len(boundary_edges(tris)) == 4
    new_pos, new_tris = extrude_rim(pos, tris, rim_y_max=0.5, depth=0.4)
    assert len(new_pos) == 8 and len(new_tris) == 2 + 4 * 2
    np.testing.assert_allclose(new_pos[4:, 1], -0.4)
