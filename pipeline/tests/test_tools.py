from __future__ import annotations

from ftv_pipeline.render import sample_weights


def test_sample_weights() -> None:
    cfg = {"export": {"ranges": {"jaw": [0, 1]}}}
    assert sample_weights("jaw", cfg) == {"min": 0.0, "mid": 0.5, "max": 1.0}
    assert sample_weights("nose", cfg) == {"min": -1.0, "mid": 0.0, "max": 1.0}
