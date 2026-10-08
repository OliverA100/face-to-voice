"""validate/stress.py: gaze rotations and the per-family summary."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.validate.stress import gaze_rot, summarise


def test_gaze_rot():
    R = gaze_rot(20.0, 10.0)
    assert R.shape == (2, 3, 3)
    assert np.allclose(R[0] @ R[0].T, np.eye(3)) and np.allclose(R[0], R[1])
    assert (gaze_rot(0.0, 10.0)[0] @ [0, 0, 1])[1] < 0  # pitch > 0 looks down
    assert np.allclose(gaze_rot(90.0, 0.0)[0] @ [0, 0, 1], [1, 0, 0])  # yaw > 0 looks to +x


def test_summarise_counts_worst_and_report_only():
    rows = [{"family": "single", "id": "a", "fail": ["eye_lids"], "values": {"eye_lids": 1.5}, "report": ["folded"]},
            {"family": "single", "id": "b", "fail": ["eye_lids", "mouth_inside"], "values": {"eye_lids": 2.5, "mouth_inside": 0.3}},
            {"family": "single", "id": "c", "fail": [], "values": {}},
            {"family": "anim", "id": "d", "fail": ["eye_lids"], "values": {"eye_lids": 9.0}}]
    s = summarise(rows, "single")
    assert (s["tested"], s["broken"]) == (3, 2)
    assert s["checks"]["eye_lids"] == {"n": 2, "worst": 2.5, "worst_id": "b"}
    assert s["report_only"] == {"folded": 1}
    assert summarise(rows, "single", tested=100)["tested"] == 100


def test_summarise_addons_reads_the_measured_value():
    rows = [{"family": "addons", "id": "x", "fail": ["clipping"], "values": {"clip_mm": 1.2}},
            {"family": "addons", "id": "y", "fail": ["clipping"], "values": {"clip_mm": 3.4}}]
    assert summarise(rows, "addons")["checks"]["clipping"]["worst"] == pytest.approx(3.4)
