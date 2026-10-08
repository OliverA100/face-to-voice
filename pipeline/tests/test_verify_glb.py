from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np

from ftv_pipeline.verify_glb import MAX_ERROR_M, canonical_triangles, local_matrix, match_vertices


def test_canonical_triangles_keep_winding() -> None:
    assert canonical_triangles(np.array([[3, 1, 2], [2, 3, 1]])) == {(1, 2, 3)}
    assert canonical_triangles(np.array([[1, 3, 2]])) != canonical_triangles(np.array([[1, 2, 3]]))


def _node(matrix=None, translation=None, rotation=None, scale=None) -> SimpleNamespace:
    return SimpleNamespace(matrix=matrix, translation=translation, rotation=rotation, scale=scale)


def test_local_matrix_is_t_r_s() -> None:
    h = math.sqrt(0.5)
    m = local_matrix(_node(translation=[1, 2, 3], rotation=[0, h, 0, h], scale=[2, 2, 2]))  # 90° about +Y
    p = m @ np.array([1.0, 0, 0, 1])
    np.testing.assert_allclose(p[:3], [1, 2, 1], atol=1e-12)  # scaled to x = 2, turned to z = -2, moved
    col_major = list(np.arange(16.0))
    np.testing.assert_array_equal(local_matrix(_node(matrix=col_major)), np.arange(16.0).reshape(4, 4).T)


def test_match_vertices_separates_coincident_vertices_by_their_deltas() -> None:
    ref_pos = np.array([[0, 0, 0], [0, 0, 0], [1, 0, 0]], float)  # 0 and 1 coincide (upper/lower teeth touching)
    ref_deltas = np.array([[[0, 1, 0], [0, -1, 0], [0, 0, 0]]], float)
    pos = ref_pos[[2, 1, 0]] + 1e-7  # decoded order differs, positions quantised
    deltas = [ref_deltas[0][[2, 1, 0]]]
    dist, idx = match_vertices(pos, ref_pos, deltas, ["t"], ref_deltas, ["t"])
    np.testing.assert_array_equal(idx, [2, 1, 0])
    assert dist.max() < MAX_ERROR_M
