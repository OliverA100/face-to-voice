"""The pure transforms behind web/src/data/sliders.json (nothing here writes the real file)."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline import sliders_json


def _raw(sid: str, region: str, kind: str = "identity") -> dict:
    return {"id": sid, "target": sid, "kind": kind, "region": region, "name": sid}


def test_raw_sliders_are_numbered_per_area() -> None:
    doc = {"sliders": [_raw("lower_face_region_000", "lower_face_region"), _raw("lower_face_region_001", "lower_face_region"),
                       _raw("teeth_000", "teeth"), _raw("pupils_000", "pupils"), _raw("sem_nose", "semantic", "semantic")]}
    raw, groups = sliders_json.raw_sliders(doc, sol=None, sigma_scale=3.0)
    assert [s["name"] for s in raw] == ["Mouth 1", "Mouth 2", "Teeth", "Pupils"]  # an area with one slider has no number
    assert {s["section"] for s in raw} == {"advanced"}
    assert raw[3]["description"].startswith("Pupil size")
    assert [g["id"] for g in groups] == ["raw_mouth", "raw_eyeballs", "raw_teeth"]  # RAW_AREAS order, present areas only


def test_raw_sliders_reject_unknown_regions() -> None:
    with pytest.raises(ValueError, match="not one of"):
        sliders_json.raw_sliders({"sliders": [_raw("emo_happy_upper", "emotion_upper", "emotion")]}, None, 3.0)


def test_raw_description_lists_the_largest_unusual_effects() -> None:
    sol = SimpleNamespace(components=["head_000"], names=["Nose width", "Jaw width", "Face height"],
                          J=np.array([[1.0], [-0.9], [0.1]]), pop_sigma=np.array([1.0, 0.5, 1.0]))
    text = sliders_json.raw_description(sol, "head_000", sigma_scale=3.0)
    assert text.endswith("nose width +3 mm, jaw width −3 mm.")  # ranked by how unusual, listed by size; 0.3 mm is too small
    assert "only slightly" in sliders_json.raw_description(sol, "head_000", sigma_scale=0.1)
    assert sliders_json.raw_description(sol, "head_999", 3.0) == "Moves several features of the head at once."


def test_apply_ranges(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ranges, breaks = tmp_path / "ranges.json", tmp_path / "breaks.json"
    ranges.write_text(json.dumps({"a": {"min": -2.0, "max": 1.5}, "b": {"min": -1.0, "max": 1.0}}))
    breaks.write_text(json.dumps({"a": {"max": {"end": 1.23456}}, "b": {"min": {"end": -3.0}}}))
    monkeypatch.setattr(sliders_json, "RANGES_JSON", ranges)
    monkeypatch.setattr(sliders_json, "BREAKS_JSON", breaks)
    entries = [{"target": "a", "min": -1.0, "max": 1.0}, {"target": "b", "min": -1.0, "max": 1.0},
               {"target": "c", "min": -1.0, "max": 1.0}]
    assert sliders_json.apply_ranges(entries) == 2
    assert entries[0] == {"target": "a", "min": -2.0, "max": 1.235}  # break pulls the end in, rounded
    assert entries[1] == {"target": "b", "min": -1.0, "max": 1.0}  # a break beyond the range changes nothing
    assert entries[2] == {"target": "c", "min": -1.0, "max": 1.0}
