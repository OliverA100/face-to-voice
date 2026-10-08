"""fx-reach searches each side of a fine-tune control along the way that side really moves the face."""
from types import SimpleNamespace

import numpy as np

from ftv_pipeline.validate.fx_reach import control_direction
from ftv_pipeline.validate.model import HeadModel


def _model():
    m = SimpleNamespace(
        names=["a", "b"],
        sliders={"fx_mirror": {"combo": {"a": 1.0}}, "fx_two_way": {"combo": {"a": 1.0}, "comboNeg": {"b": 0.5}}},
    )
    m.vector = lambda w: HeadModel.vector(m, w)
    m.expand = lambda v: HeadModel.expand(m, v)
    return m


def test_negative_side_goes_the_negative_way():
    m = _model()
    np.testing.assert_allclose(control_direction(m, "fx_mirror", 1), [1, 0])
    np.testing.assert_allclose(control_direction(m, "fx_mirror", -1), [-1, 0])  # the combo reversed
    np.testing.assert_allclose(control_direction(m, "fx_two_way", -1), [0, 0.5])  # its own comboNeg
