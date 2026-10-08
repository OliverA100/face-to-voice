from __future__ import annotations

from types import SimpleNamespace

import pytest

from ftv_pipeline.age import age_combo


def test_age_combo_expands_sliders_into_real_targets() -> None:
    """Baked sliders are targets of their own; runtime sliders and controls expand into the targets they mix."""
    sol = SimpleNamespace(ids=["nose", "head_size"], baked=[True, False],
                          combo=lambda k, sigma_scale: {"head_000": 0.5, "head_001": -0.25})
    controls = [{"id": "smile", "combo": {"lower_face_region_000": 1.0, "head_000": 0.1}},
                {"id": "pupils", "target": "pupils_000"}]
    cfg = {"shape": {"nose": 0.4, "head_size": 2.0}, "controls": {"smile": -0.5, "pupils": 0.2}}
    assert age_combo(sol, controls, 3.0, cfg) == {
        "sem_nose": 0.4, "head_000": 0.95, "head_001": -0.5, "lower_face_region_000": -0.5, "pupils_000": 0.2,
    }


def test_age_combo_rejects_unknown_sliders() -> None:
    sol = SimpleNamespace(ids=["nose"], baked=[True])
    with pytest.raises(KeyError, match="not a semantic slider"):
        age_combo(sol, [], 3.0, {"shape": {"chin": 1.0}})
