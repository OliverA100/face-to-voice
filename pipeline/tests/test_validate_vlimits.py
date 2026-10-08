"""validate/vlimits.py: the limiter's per-ray triangle test must agree with the exact check's (checks.ray_hits)."""
from __future__ import annotations

import numpy as np

from ftv_pipeline.validate.checks import ray_hits
from ftv_pipeline.validate.vlimits import REPORT_ONLY, ray_pairs


def test_ray_pairs_matches_ray_hits():
    rng = np.random.default_rng(0)
    D = rng.normal(size=(40, 3))
    D /= np.linalg.norm(D, axis=1, keepdims=True)
    tri = rng.normal(size=(25, 3, 3))
    want = ray_hits(D, tri)  # (n, m): every ray against every triangle
    got = ray_pairs(D, np.broadcast_to(tri, (len(D), *tri.shape)))  # (n, K): each ray against its own K
    assert np.array_equal(np.isnan(want), np.isnan(got))
    assert np.allclose(want[~np.isnan(want)], got[~np.isnan(got)])
    assert (~np.isnan(got)).any()  # the random set does hit something


def test_report_only_checks():
    assert set(REPORT_ONLY) == {"symmetry", "folded", "eye_pivot"}
