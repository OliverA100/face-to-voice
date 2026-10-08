from __future__ import annotations

import numpy as np

from ftv_pipeline import emotions
from ftv_pipeline.gnm import GNM

from .conftest import needs_gnm


def test_one_sided_measures_are_the_sided_copies() -> None:
    assert {"corner_raise_l", "corner_raise_r", "brow_raise_l", "lid_aperture_r"} <= emotions.ONE_SIDED
    assert not any("{s}" in str(emotions.MEASURES[m]) for m in emotions.ONE_SIDED)
    assert emotions.MEASURES["inner_brow_raise_l"]["pairs"] == [["brow_inner_l", "nasion"]]
    assert "axis" not in emotions.MEASURES["lid_aperture_l"]


def test_part_mask_splits_by_region(tiny_gnm: GNM) -> None:
    np.testing.assert_array_equal(emotions.part_mask(tiny_gnm, "lower"), [True])
    np.testing.assert_array_equal(emotions.part_mask(tiny_gnm, "upper"), [False])


def test_label_vector_rescales_to_one_sample() -> None:
    doc = {"labels": {"HAPPY": {"mean": [3.0, 4.0], "mean_norm": 5.0, "median_sample_norm": 10.0}}}
    np.testing.assert_allclose(emotions.label_vector(doc, "HAPPY"), [6.0, 8.0])
    np.testing.assert_allclose(emotions.label_vector({**doc, "strength": "mean"}, "HAPPY"), [3.0, 4.0])


def test_control_ends() -> None:
    assert emotions.control_ends({}) == (-1.0, 1.0)
    assert emotions.control_ends({"min": 0, "max": 2}) == (0.0, 2.0)


@needs_gnm
def test_emotion_parts_are_disjoint_and_goals_move_the_right_way() -> None:
    """Each part only moves its own coefficients, and every sizeable goal moves its measurement the right way."""
    gnm = GNM.load()
    up, lo = emotions.part_mask(gnm, "upper"), emotions.part_mask(gnm, "lower")
    assert not (up & lo).any()
    for r in emotions.resolve(gnm, emotions.load_doc()):
        assert not r.upper[~up].any() and not r.lower[~lo].any()
        for goal, (target, reached) in r.goals.items():
            if abs(target) >= 1.0:
                assert np.sign(reached) == np.sign(target), (r.id, goal)
