"""glasses_fit.py: the solver's pure parts, the bisection and the edge sampling (the fit itself needs the GNM)."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.glasses_fit import SAMPLE_STEP_M, _edge_samples, _solve


def test_solve_finds_the_root_of_an_increasing_function():
    assert _solve(lambda v: v ** 3 - 0.125, -1.0, 1.0) == pytest.approx(0.5, abs=1e-6)


def test_solve_returns_the_nearer_limit_when_there_is_no_root():
    assert _solve(lambda v: v + 10.0, -1.0, 1.0) == -1.0  # already clear at the lower limit
    assert _solve(lambda v: v - 10.0, -1.0, 1.0) == 1.0  # never clear inside: as far as allowed


def test_edge_samples_cover_every_edge_at_the_sample_step():
    positions = np.array([[0, 0, 0], [0.01, 0, 0], [0, 0.002, 0]], float)  # one long (10 mm) and two short edges
    a, b, t = _edge_samples(np.array([[0, 1, 2]]), positions)
    points = positions[a] + t[:, None] * (positions[b] - positions[a])
    assert ((t >= 0) & (t <= 1)).all()
    for v in positions:  # the vertices themselves are samples
        assert np.linalg.norm(points - v, axis=1).min() < 1e-12
    along = np.sort(points[(np.abs(points[:, 1]) < 1e-12)][:, 0])  # the samples on the long edge, in order
    assert np.diff(np.unique(along)).max() <= SAMPLE_STEP_M + 1e-12
