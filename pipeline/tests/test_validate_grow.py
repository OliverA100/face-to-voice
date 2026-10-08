"""validate/grow.py: a face only adds crossings when it fails a check the limiter guards (as in vlimits and stress)."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline.validate import grow


class _Model:
    names = ("head_000",)
    sliders = frozenset()

    def expand(self, w: dict) -> dict:
        return w

    def vector(self, w: dict) -> np.ndarray:
        return np.array([w.get("head_000", 0.0)])

    def positions(self, vec: np.ndarray) -> np.ndarray:
        return np.zeros((3, 3))

    def pivots(self, vec: np.ndarray) -> np.ndarray:
        return np.zeros((2, 3))


@pytest.mark.parametrize(("failing", "breaks"), [
    (["eye_pivot"], []),  # reported, never guarded by the limiter
    (["symmetry", "folded"], []),
    (["eye_pivot", "eye_through"], ["eye_through"]),
])
def test_only_guarded_checks_add_crossings(monkeypatch, failing: list[str], breaks: list[str]) -> None:
    checks = ["eye_pivot", "eye_through", "symmetry", "folded"]
    checker = SimpleNamespace(run=lambda P, piv: {k: SimpleNamespace(fail=k in failing) for k in checks})
    limiter = SimpleNamespace(tris_from_break=lambda ch, P, piv: [7, 9])
    monkeypatch.setattr(grow, "_ctx", {"m": _Model(), "ch": checker, "vl": limiter})
    bad, tris = grow._one({"head_000": 1.0, "not_a_target": 2.0})
    assert bad == breaks
    assert tris == ([7, 9] if breaks else [])
