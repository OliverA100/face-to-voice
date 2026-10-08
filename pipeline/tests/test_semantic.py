"""Semantic slider measurements and solver pieces on synthetic geometry (no GNM download)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ftv_pipeline import semantic
from ftv_pipeline.export_glb import vertex_normals
from ftv_pipeline.gnm import GNM

from .conftest import needs_gnm

LANDMARKS = {"a": np.array([0]), "b": np.array([1]), "top": np.array([2, 3])}


def _measure(gnm: GNM, spec: dict) -> semantic.Measure:
    return semantic.build_measure(spec, LANDMARKS, gnm, vertex_normals(gnm.template, gnm.triangles))


def test_distance_and_axis_values(tiny_gnm: GNM) -> None:
    T = tiny_gnm.template
    assert _measure(tiny_gnm, {"type": "distance", "pairs": [["a", "b"]]}).value(T) == pytest.approx(1000.0)
    assert _measure(tiny_gnm, {"type": "axis", "axis": "y", "pairs": [["top", "a"]]}).value(T) == pytest.approx(1000.0)
    assert _measure(tiny_gnm, {"type": "normal", "groups": ["skin"]}).value(T) == 0.0
    terms = {"terms": [{"type": "distance", "pairs": [["a", "b"]]}, {"type": "axis", "axis": "y", "pairs": [["top", "a"]], "weight": -0.5}]}
    assert _measure(tiny_gnm, terms).value(T) == pytest.approx(500.0)


@pytest.mark.parametrize("spec", [
    {"type": "axis", "axis": "x", "pairs": [["b", "a"], ["top", "a"]]},
    {"type": "normal", "groups": ["skin"], "y": [0.5, 2.0]},
    {"type": "distance", "pairs": [["a", "top"]]},
    {"type": "balance", "a": {"type": "distance", "pairs": [["a", "b"]]}, "b": {"type": "distance", "pairs": [["a", "top"]]}},
])
def test_gradient_matches_the_measurement(tiny_gnm: GNM, spec: dict) -> None:
    """grad · D is the measurement's change for a small displacement D (exact for the linear kinds)."""
    T = tiny_gnm.template.astype(np.float64)
    D = np.random.default_rng(2).standard_normal(T.shape) * 1e-6
    m = _measure(tiny_gnm, spec)
    assert m.value(T + D) - m.value(T) == pytest.approx(float((m.grad * D).sum()), rel=1e-4, abs=1e-9)


def test_measure_errors(tiny_gnm: GNM) -> None:
    with pytest.raises(KeyError):
        _measure(tiny_gnm, {"type": "distance", "pairs": [["a", "nowhere"]]})
    with pytest.raises(ValueError, match="no vertex"):
        _measure(tiny_gnm, {"type": "normal", "groups": ["skin"], "y": [5.0, 6.0]})
    with pytest.raises(ValueError, match="unknown measure"):
        _measure(tiny_gnm, {"type": "curvature"})


def test_outside_weight_ramps_over_the_falloff(tiny_gnm: GNM) -> None:
    w = semantic.outside_weight(tiny_gnm, ["teeth"], falloff_mm=2000.0)
    assert w[4] == 0.0  # inside the region
    np.testing.assert_allclose(w[:4], np.linalg.norm(tiny_gnm.template[:4] - tiny_gnm.template[4], axis=1) / 2.0)
    banded = semantic.outside_weight(tiny_gnm, ["skin"], falloff_mm=1000.0, y_band=[0.5, 2.0])  # only the top edge
    assert banded[2] == banded[3] == 0.0 and banded[0] == banded[1] == 1.0


def test_direction_is_the_prior_weighted_gradient() -> None:
    """With N = I the direction is J_k itself, scaled so the feature sits at target_pop_sigma population σ."""
    Jk = np.array([3.0, 4.0, 0.0])
    sv = {"target_pop_sigma": 2.0, "max_sigma": 10.0}
    u = semantic._direction(np.eye(3), Jk, np.arange(3), {}, sv)
    np.testing.assert_allclose(u, 2.0 * Jk / 5.0)
    assert Jk @ u == pytest.approx(2.0 * np.linalg.norm(Jk))  # own change = 2 population σ (‖J_k‖ = 5 mm)
    capped = semantic._direction(np.eye(3), Jk, np.arange(3), {}, {**sv, "max_sigma": 1.0})
    assert np.linalg.norm(capped) == pytest.approx(1.0)
    only_first = semantic._direction(np.eye(3), Jk, np.array([0]), {"scale_sigma": 0.5}, sv)
    np.testing.assert_allclose(only_first, [0.5, 0.0, 0.0])


def test_quality() -> None:
    q = semantic._quality(np.array([1.0, 0.0]), np.array([2.0, 0.0]), np.array([[0.5, 1.0]]), np.zeros((0, 2)), np.eye(2))
    assert q == {"own": 2.0, "cross": 0.5, "outside": 1.0, "guard": 0.0}


def test_check_flags_each_gate() -> None:
    ok = {"id": "nose", "own_mm": 4.0, "cross_strict_mm": 0.5, "cross_strict_id": "jaw", "guards_mm": {"eyes": 0.1}, "lin_error": 0.01}
    assert semantic.check([ok]) == []
    bad = {**ok, "own_mm": 1.0, "guards_mm": {"eyes": 0.3}, "lin_error": 0.2}
    assert len(semantic.check([bad])) == 3


def test_load_config_validates(tmp_path: Path) -> None:
    path = tmp_path / "s.toml"
    path.write_text('[[slider]]\nid = "a"\n[[slider]]\nid = "a"\n')
    with pytest.raises(ValueError, match="duplicate"):
        semantic.load_config(path)
    path.write_text('[[slider]]\nid = "a"\nfree = ["b"]\n')
    with pytest.raises(ValueError, match="not a slider id"):
        semantic.load_config(path)
    path.write_text('[[slider]]\nid = "a"\nbake = "sometimes"\n')
    with pytest.raises(ValueError, match="bake"):
        semantic.load_config(path)


def test_write_landmarks_replaces_only_the_generated_block(tmp_path: Path) -> None:
    path = tmp_path / "s.toml"
    path.write_text("[solver]\nx = 1\n")
    semantic.write_landmarks({"nasion": semantic.Landmark([7], "deepest")}, path)
    semantic.write_landmarks({"nasion": semantic.Landmark([8, 9], "deepest")}, path)
    text = path.read_text()
    assert text.startswith("[solver]\nx = 1\n")
    assert text.count(semantic.LANDMARKS_BEGIN) == 1
    assert "nasion = [8, 9]" in text


def test_solution_combo_drops_zero_weights() -> None:
    sol = semantic.Solution(ids=["s"], names=["S"], components=["head_000", "head_001", "head_002"],
                            coefficients=np.array([[3.0, 0.0, 1.5]]), J=np.zeros((1, 3)), pop_sigma=np.ones(1),
                            shipped=["head_000", "head_001"])
    assert sol.combo(0, sigma_scale=3.0) == {"head_000": 1.0}


@needs_gnm
def test_landmark_rules_on_the_template() -> None:
    gnm = GNM.load()
    lm = semantic.propose_landmarks(gnm)
    for name in ("nasion", "pronasale", "menton", "alare_l", "alare_r"):
        assert name in lm
    # sided landmarks mirror each other across the midline (x → −x)
    left, right = (gnm.template[lm[f"exocanthion_{s}"].indices].mean(0) for s in "lr")
    np.testing.assert_allclose(left * [-1, 1, 1], right, atol=1e-4)
    # the profile reads top to bottom
    y = {n: gnm.template[lm[n].indices].mean(0)[1] for n in ("glabella", "nasion", "subnasale", "menton")}
    assert y["glabella"] > y["nasion"] > y["subnasale"] > y["menton"]
