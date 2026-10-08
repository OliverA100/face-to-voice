"""Shared fixtures: a tiny synthetic GNM (no download) and a skip marker for tests that need the cached model."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.gnm import GNM, WEIGHTS_FILE

needs_gnm = pytest.mark.skipif(not WEIGHTS_FILE.exists(), reason=f"cached GNM weights not found at {WEIGHTS_FILE}")


@pytest.fixture
def tiny_gnm() -> GNM:
    """A five-vertex 'head': a unit square of skin (two triangles) and one tooth vertex above its centre.

    Two identity components and one expression component with seeded random bases; vertex 0 mirrors 1, 3 mirrors 2.
    """
    rng = np.random.default_rng(0)
    template = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]], np.float32)
    skin = np.array([True, True, True, True, False])
    return GNM(
        template=template,
        triangles=np.array([[0, 1, 2], [0, 2, 3], [2, 3, 4]], np.int32),
        identity_basis=rng.standard_normal((2, 5, 3)).astype(np.float32),
        expression_basis=rng.standard_normal((1, 5, 3)).astype(np.float32),
        identity_names=["head_000", "head_001"],
        expression_names=["lower_face_region_000"],
        joint_names=["neck", "head", "left_eye", "right_eye"],
        joint_positions=np.zeros((4, 3), np.float32),
        joint_identity_basis=rng.standard_normal((2, 4, 3)).astype(np.float32),
        vertex_groups={"skin": skin, "skin_exterior": skin.copy(), "teeth": ~skin},
        mirror=np.array([1, 0, 3, 2, 4]),
    )
