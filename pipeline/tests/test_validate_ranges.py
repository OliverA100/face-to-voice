"""validate/ranges.py: measurements in reference SD (with landmark-offset handling) and σ per morph weight."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ftv_pipeline.validate.anthro import Reference
from ftv_pipeline.validate.ranges import Ruler, sigma_per_weight


def ruler(base: dict[str, float], offset: dict[str, bool], advisory=()) -> Ruler:
    """A Ruler without a head model: only the reference maths."""
    r = Ruler.__new__(Ruler)
    r.ref = {"nose_width": Reference(35.0, 3.0, 25.0, 50.0, "min/max", "test"),
             "jaw_width": Reference(120.0, 8.0, 95.0, 150.0, "min/max", "test")}
    r.base, r.offset, r.advisory = base, offset, set(advisory)
    return r


def test_z_in_published_sd():
    r = ruler({"nose_width": 35.0}, {"nose_width": False})
    assert r.z("nose_width", 41.0) == pytest.approx(2.0)


def test_offset_landmarks_compare_changes():
    # GNM's jaw sits 20 mm off the published mean: a 16 mm change from GNM's average is +2 SD
    r = ruler({"jaw_width": 100.0}, {"jaw_width": True})
    assert r.as_reference("jaw_width", 116.0) == pytest.approx(136.0)
    assert r.z("jaw_width", 116.0) == pytest.approx(2.0)


def test_outside_needs_movement_and_skips_advisory():
    r = ruler({"nose_width": 35.0, "jaw_width": 120.0}, {"nose_width": False, "jaw_width": False})
    assert r.outside({"nose_width": 51.0, "jaw_width": 120.0}, moved_mm=0.5) == ["nose_width"]
    assert r.outside({"nose_width": 35.2}, moved_mm=0.5) == []  # barely moved: never blamed
    assert ruler({"nose_width": 35.0}, {"nose_width": False}, ["nose_width"]).outside({"nose_width": 60.0}, 0.5) == []


def test_sigma_per_weight():
    model = SimpleNamespace(sliders={"sem_nose_width": {"kind": "semantic"}, "head_003": {"kind": "identity"},
                                     "jaw_open": {"kind": "expression"}, "ctl_smile": {"kind": "control"}})
    rows = [{"id": "nose_width", "own_mm": -6.0, "pop_sigma_mm": 2.0}]
    got = sigma_per_weight(model, rows, sigma_scale=3.0, overrides={"head_003": 2.5})
    assert got == {"sem_nose_width": (3.0, "model"), "head_003": (2.5, "component"), "jaw_open": (3.0, "component")}
