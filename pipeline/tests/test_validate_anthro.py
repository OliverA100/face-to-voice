"""validate/anthro.py: the tape-measure outline and the published reference table."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.validate.anthro import MEASURES, _outline, load_reference


def prism(n: int, r: float) -> tuple[np.ndarray, np.ndarray]:
    """A regular n-gon prism of radius r from z = 0 to z = 1 (sides only, triangulated)."""
    a = 2 * np.pi * np.arange(n) / n
    ring = np.c_[r * np.cos(a), r * np.sin(a)]
    P = np.r_[np.c_[ring, np.zeros(n)], np.c_[ring, np.ones(n)]]
    k = np.arange(n)
    tris = np.r_[np.c_[k, (k + 1) % n, n + (k + 1) % n], np.c_[k, n + (k + 1) % n, n + k]]
    return P, tris


def test_outline_is_the_convex_perimeter_of_the_cut():
    n, r = 12, 0.08
    P, tris = prism(n, r)
    got = _outline(P, tris, np.array([0.0, 0.0, 1.0]), np.array([0.0, 0.0, 0.5]))
    assert got == pytest.approx(n * 2 * r * np.sin(np.pi / n))


def test_outline_misses():
    P, tris = prism(8, 0.05)
    assert _outline(P, tris, np.array([0.0, 0.0, 1.0]), np.array([0.0, 0.0, 2.0])) == float("inf")


def test_reference_ranges_are_consistent():
    ref = load_reference()
    assert ref, "config/anthropometry.toml has no [measure.*] entries"
    for k, r in ref.items():
        assert k in MEASURES, k
        assert r.sd > 0 and r.low < r.mean < r.high, k
