"""validate/model.py: mix sliders spread like the web store, and the eye pivots posed like Head.tsx."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline.validate.model import HeadModel


def model() -> HeadModel:
    """3 targets, 3 vertices: vertex 1 is the left eye (pivot at +x), vertex 2 the right eye."""
    T = np.array([[0.0, 0, 0], [1.0, 0, 0], [-1.0, 0, 0]])
    deltas = np.zeros((3, 3, 3), np.float32)
    deltas[0, :, 0] = 1.0  # target a: everything +x
    joints = np.zeros((3, 2, 3), np.float32)
    joints[0, 0, 1] = 1.0  # target a: the left eye's pivot +y
    sliders = {"mix": {"combo": {"a": 0.5, "b": 1.0}, "comboNeg": {"c": 2.0}}, "plain": {"combo": {"b": 1.0}}}
    return HeadModel(gnm=SimpleNamespace(template=T), names=["a", "b", "c"], kinds=["identity"] * 3, deltas=deltas,
                     joint_deltas=joints, owner=np.zeros(3, int), eye=np.array([-1, 0, 1]),
                     pivot0=np.array([[1.0, 0, 0], [-1.0, 0, 0]], np.float32), sliders=sliders)


def test_expand_spreads_mix_sliders():
    m = model()
    assert m.expand({"mix": 1.0}) == {"a": 0.5, "b": 1.0}
    assert m.expand({"mix": -0.5}) == {"c": 1.0}  # the negative side has its own spread
    assert m.expand({"plain": -1.0}) == {"b": -1.0}  # no comboNeg: the same spread, signed
    assert m.expand({"a": 0.3, "mix": 1.0}) == {"a": 0.8, "b": 1.0}


def test_vector_adds_and_rejects_typos():
    m = model()
    assert m.vector({"a": 1.0, "c": -2.0}).tolist() == [1.0, 0.0, -2.0]
    with pytest.raises(ValueError):
        m.vector({"typo": 1.0})


def test_positions_move_eyes_with_their_own_pivot_weights():
    m = model()
    w = m.vector({"a": 1.0})
    plain = m.positions(w)
    assert np.allclose(plain, m.gnm.template + np.array([1.0, 0, 0]))
    # the eye pivots held at rest: the left eye drops back by its pivot's own move, the rest is the plain sum
    held = m.positions(w, pivot_w=np.zeros(3, np.float32))
    assert np.allclose(held[0], plain[0]) and np.allclose(held[2], plain[2])
    assert np.allclose(held[1], plain[1] - np.array([0.0, 1, 0]))
    # gaze turns each eye about its pivot
    yaw = np.array([[0.0, 0, 1], [0, 1, 0], [-1, 0, 0]])  # 90° about y
    turned = m.positions(w, gaze=np.stack([yaw, yaw]))
    assert np.allclose(turned[0], plain[0])
    assert np.allclose(turned[1], m.pivots(w)[0] + yaw @ (plain[1] - m.pivots(w)[0]))
