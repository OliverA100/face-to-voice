"""addon_fit.py: the rigid binder's maths (rigid_delta's exact cases, rotation_vector) and target selection."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.addon_fit import _select_targets, rigid_delta, rotation_vector

ANCHORS = np.array([[0.0, 0.3, 0.12], [0.06, 0.31, 0.04], [-0.06, 0.31, 0.04], [0.07, 0.29, 0.0], [-0.07, 0.29, 0.0]])
VERTICES = np.random.default_rng(2).normal(scale=0.05, size=(50, 3)) + np.array([0, 0.3, 0.06])


def test_pure_translation_moves_every_vertex_the_same():
    shift = np.array([0.001, -0.002, 0.0005])
    np.testing.assert_allclose(rigid_delta(VERTICES, ANCHORS, ANCHORS + shift), np.broadcast_to(shift, VERTICES.shape), atol=1e-8)


def test_pure_scaling_about_a_point_is_exact():
    p, k = np.array([0.01, 0.28, 0.05]), 1.02
    moved = p + k * (ANCHORS - p)
    np.testing.assert_allclose(rigid_delta(VERTICES, ANCHORS, moved), (k - 1) * (VERTICES - p), atol=1e-8)


def test_rotation_vector_of_a_turn_about_y():
    a = np.radians(12.0)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    np.testing.assert_allclose(rotation_vector(R), [0, a, 0], atol=1e-12)
    np.testing.assert_allclose(rotation_vector(np.eye(3)), 0.0)


def test_select_targets_drops_small_and_weakest_but_keeps_protected():
    def moving(mm: float) -> np.ndarray:
        return np.array([[mm / 1000, 0.0, 0.0]])

    candidates = {"head_000": moving(5), "head_001": moving(0.5), "head_002": moving(0.001), "sem_age": moving(0.2), "emo_happy": moving(0.3)}
    kept, dropped = _select_targets(candidates, min_delta_mm=0.01, max_targets=3)
    assert list(kept) == ["head_000", "sem_age", "emo_happy"]  # head_001 is the weakest raw one, head_002 too small
    assert dropped == pytest.approx({"head_002": 0.001, "head_001": 0.5})
