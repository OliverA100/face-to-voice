"""validate/checks.py: the exact geometric tests on hand-built triangles, and the checks on GNM's neutral face."""
from __future__ import annotations

import tomllib

import numpy as np
import pytest

from ftv_pipeline.gnm import WEIGHTS_FILE
from ftv_pipeline.validate.checks import _segment_hits, crossing_depth, intersecting_pairs, ray_hits

# A in z = 0; B pierces A; C floats parallel above A; D far away
P = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0],
              [0.2, 0.2, -0.5], [0.2, 0.2, 0.5], [0.6, 0.2, 0.5],
              [0.2, 0.2, 0.1], [0.6, 0.2, 0.1], [0.2, 0.6, 0.1],
              [2, 2, -1], [2, 2, 1], [3, 2, 0]], float)
TRIS = np.array([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]])


def _pairs(P, tris, tol=0.0) -> set[tuple[int, int]]:
    i, j = intersecting_pairs(P, tris, tol)
    return {tuple(sorted(p)) for p in zip(i.tolist(), j.tolist())}


def test_intersecting_pairs_finds_crossings_only():
    got = _pairs(P, TRIS)
    # B and C share an edge line in y = 0.2 (a touch), so either answer is right there
    assert got in ({(0, 1), (1, 2)}, {(0, 1)})
    assert (0, 2) not in got and (0, 3) not in got


def test_shared_corner_is_not_a_crossing():
    P2 = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [0.5, 0.5, 1], [0.5, -0.5, -1]], float)
    assert _pairs(P2, np.array([[0, 1, 2], [0, 4, 5]])) == set()


def test_crossing_depth_is_the_smaller_poke():
    # B's corner 3 mm under A's plane; A pokes 200 mm through B's plane on its smaller side: depth = 3 mm
    P2 = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.2, 0.2, -0.003], [0.2, 0.2, 0.5], [0.6, 0.2, 0.5]], float)
    tris = np.array([[0, 1, 2], [3, 4, 5]])
    i, j = intersecting_pairs(P2, tris)
    assert len(i) == 1
    assert crossing_depth(P2, tris, i, j)[0] == pytest.approx(3.0)
    # a graze: one corner a micron through
    P2[3, 2] = -1e-6
    i, j = intersecting_pairs(P2, tris)
    assert crossing_depth(P2, tris, i, j)[0] == pytest.approx(0.001)
    assert len(crossing_depth(P2, tris, np.zeros(0, int), np.zeros(0, int))) == 0


def test_segment_tolerance_sees_near_misses():
    a, b, c = (np.array([[0.0, 0, 0]]), np.array([[1.0, 0, 0]]), np.array([[0.0, 1, 0]]))
    p0, p1 = np.array([[-0.01, 0.5, -1]]), np.array([[-0.01, 0.5, 1]])  # passes 1% outside the edge x = 0
    assert not _segment_hits(p0, p1, a, b, c)[0]
    assert _segment_hits(p0, p1, a, b, c, tol=0.02)[0]


def test_ray_hits_distance_and_misses():
    tri = np.array([[[-1, -1, 2], [1, -1, 2], [0, 1, 2]], [[5, 5, 1], [6, 5, 1], [5, 6, 1]]], float)
    D = np.array([[0, 0, 1.0], [0, 0, -1.0]])
    t = ray_hits(D, tri)
    assert t[0, 0] == pytest.approx(2.0)
    assert np.isnan(t[0, 1])  # off to the side
    assert np.isnan(t[1]).all()  # behind the origin


# --- on GNM's neutral face (needs the cached model) ---------------------------------------------------------------------

needs_gnm = pytest.mark.skipif(not WEIGHTS_FILE.exists(), reason="GNM weights not cached (pipeline/.cache)")


@pytest.fixture(scope="module")
def neutral():
    from ftv_pipeline.validate.checks import Checker
    from ftv_pipeline.validate.model import HeadModel
    from ftv_pipeline.validate.vlimits import CONFIG

    m = HeadModel.load()
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    w = np.zeros(len(m.names), np.float32)
    return m, cfg, Checker(m, cfg), m.positions(w), m.pivots(w)


@needs_gnm
def test_neutral_face_is_not_broken(neutral):
    _, _, ch, P, piv = neutral
    res = ch.run(P, piv, symmetric=True)
    assert not [k for k, r in res.items() if r.fail]
    assert res["lips_cross"].value < 0  # closed lips: each inner edge well inside the other lip's outer edge


@needs_gnm
def test_lower_lip_edge_above_the_upper_lip_crosses(neutral):
    _, cfg, ch, P, piv = neutral
    _, lo = ch.stomion
    ls, _ = ch.lip_outer
    P = P.copy()
    P[lo, 1] += P[ls, 1].mean() - P[lo, 1].mean() + 0.001  # lower lip's inner edge 1 mm above the upper lip's top
    res = ch.run(P, piv)
    assert res["lips_cross"].value == pytest.approx(1.0, abs=1e-3)
    assert res["lips_cross"].fail == (cfg["checks"]["lips_cross_mm"] < 1.0)


@needs_gnm
def test_limiter_mirror_passes_the_neutral_face(neutral):
    from ftv_pipeline.validate.vlimits import VLimits

    m, cfg, ch, P, piv = neutral
    vl = VLimits.build(m, ch, cfg)
    assert not any(vl.broken(P, piv).values())
