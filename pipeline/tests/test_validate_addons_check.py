"""validate/addons_check.py: the .strands.bin decoder against the pipeline's encoder, and the small helpers."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline.groom import QUANTUM_M, encode
from ftv_pipeline.validate.addons_check import _yz, decode_strands, worst_sinking


def test_decode_inverts_encode(tmp_path):
    rng = np.random.default_rng(1)
    steps = rng.normal(scale=0.002, size=(30, 12, 3))  # 30 strands of 12 points, ~2 mm steps
    strands = (np.array([0.0, 0.3, 0.05]) + np.cumsum(steps, axis=1)).astype(np.float32)
    path = tmp_path / "s.strands.bin"
    path.write_bytes(encode(SimpleNamespace(strands=strands, shade=np.full((30, 12), 0.5))))
    got = decode_strands(path)
    assert got.shape == strands.shape and got.dtype == np.float32
    assert np.abs(got - strands).max() <= QUANTUM_M  # quantised to 0.05 mm, nothing drifts along the strand


def test_decode_rejects_other_files(tmp_path):
    import gzip

    path = tmp_path / "x.bin"
    path.write_bytes(gzip.compress(b"NOPE" + bytes(40)))
    with pytest.raises(ValueError):
        decode_strands(path)


def test_worst_sinking():
    assert worst_sinking(np.array([1.0, -1.0, -2.0]), np.array([9.0, 0.5, 0.2])) == 1  # only points inside count
    assert worst_sinking(np.array([1.0, 2.0]), np.array([5.0, 5.0])) == -1


def test_yz_angle_about_x():
    assert _yz(np.array([0.0, 0.0, 1.0])) == pytest.approx(0.0)
    assert _yz(np.array([5.0, 1.0, 0.0])) == pytest.approx(np.pi / 2)  # x does not matter
