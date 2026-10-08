from __future__ import annotations

from ftv_pipeline.propose_visemes import MAX_TOTAL_WEIGHT, TOP_HINTS, propose


def _slider(target: str, region: str, **ai) -> dict:
    return {"target": target, "region": region, "ai": ai}


def test_viseme_hints_keep_the_strongest_few_and_cap_the_total() -> None:
    hint = {"viseme": "aa", "direction": "positive"}
    sliders = [_slider(f"lower_face_region_00{i}", "lower_face_region", visemeHints=[{**hint, "strength": "strong"}])
               for i in range(5)]
    sliders.append(_slider("lower_face_region_009", "lower_face_region",
                           visemeHints=[{"viseme": "pp", "direction": "negative", "strength": "weak"}]))
    out = propose(sliders)
    aa = out["visemes"]["aa"]
    assert list(aa) == [f"lower_face_region_00{i}" for i in range(TOP_HINTS)]  # lower index = more variance first
    assert sum(abs(w) for w in aa.values()) <= MAX_TOTAL_WEIGHT + 0.015  # rounded to 2 decimals
    assert out["visemes"]["pp"] == {"lower_face_region_009": -0.45}
    assert out["visemes"]["o"] == {}


def test_roles_pick_one_component_by_confidence() -> None:
    sliders = [
        _slider("left_eye_region_003", "left_eye_region", eyelidCloseDirection="positive", confidence="medium"),
        _slider("left_eye_region_007", "left_eye_region", eyelidCloseDirection="negative", confidence="high"),
        _slider("right_eye_region_001", "right_eye_region", eyelidCloseDirection="positive", confidence="high"),
        _slider("lower_face_region_002", "lower_face_region", openDirection="negative", mouthRelevance="high"),
        _slider("lower_face_region_000", "lower_face_region", openDirection="positive", mouthRelevance="low"),
        _slider("pupils_000", "pupils"),
    ]
    roles = propose(sliders)["roles"]
    assert roles == {"blinkLeft": {"left_eye_region_007": -1.0}, "blinkRight": {"right_eye_region_001": 1.0},
                     "jawOpen": {"lower_face_region_002": -1.0}, "pupils": {"pupils_000": 1.0}}
