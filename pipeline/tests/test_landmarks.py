"""landmarks.py: the midline profile ray cast and the eye-centre helper on synthetic geometry."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline.landmarks import _eye_centres, midline_profile


def slanted_sheet() -> SimpleNamespace:
    """A sheet across the midline, z = 0.1 + 0.1·y for y in [0, 0.2] (x in [-0.05, 0.05]), as a Surface-like object (depth varies < 3 cm, like a face)."""
    xs, ys = np.linspace(-0.05, 0.05, 5), np.linspace(0.0, 0.2, 9)
    pos = np.array([[x, y, 0.1 + 0.1 * y] for y in ys for x in xs])
    tris = []
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            a, b, c, d = j * 5 + i, j * 5 + i + 1, (j + 1) * 5 + i + 1, (j + 1) * 5 + i
            tris += [(a, b, c), (a, c, d)]
    return SimpleNamespace(positions=pos, triangles=np.array(tris))


def test_midline_profile_follows_the_surface():
    ys = np.linspace(0.01, 0.19, 10)
    np.testing.assert_allclose(midline_profile(slanted_sheet(), ys), 0.1 + 0.1 * ys, atol=1e-12)


def test_midline_profile_fills_gaps_from_neighbours():
    sheet = slanted_sheet()
    # cut a slot across y 0.075…0.125 (like the gap between the lips): rays there miss the sheet
    keep = [t for t in sheet.triangles if not (0.075 < sheet.positions[t, 1].mean() < 0.125)]
    sheet.triangles = np.array(keep)
    ys = np.array([0.05, 0.1, 0.15])
    z = midline_profile(sheet, ys)
    assert z[1] == pytest.approx((z[0] + z[2]) / 2)  # interpolated across the gap


def test_eye_centres_names_the_plus_x_eye_left():
    a = np.array([[0.02, 0.3, 0.1], [0.04, 0.32, 0.12]])
    b = a * [-1, 1, 1]
    for left, right in ((a, b), (b, a)):
        out = _eye_centres(left, right)
        np.testing.assert_allclose(out["eye_left"], [0.03, 0.31, 0.11])
        np.testing.assert_allclose(out["eye_right"], [-0.03, 0.31, 0.11])
