"""eyelids.py: the open-edge loops lid_margins splits into lids, and the arc-length Polyline (pure helpers; the lid
geometry itself needs the GNM)."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from ftv_pipeline.eyelids import Polyline, boundary_loops  # export_glb's, as lid_margins uses it

from .conftest import needs_gnm


def grid_with_hole() -> np.ndarray:
    """A 4 × 4 vertex grid (3 × 3 quads) with the middle quad left out: two open loops, outer (12) and inner (4)."""
    tris = []
    for i in range(3):
        for j in range(3):
            if (i, j) == (1, 1):
                continue
            a, b, c, d = 4 * i + j, 4 * i + j + 1, 4 * (i + 1) + j + 1, 4 * (i + 1) + j
            tris += [(a, b, c), (a, c, d)]
    return np.array(tris)


def test_boundary_loops_finds_the_outer_rim_and_the_hole():
    loops = sorted(boundary_loops(grid_with_hole()), key=len)
    assert [len(loop) for loop in loops] == [4, 12]
    assert set(loops[0]) == {5, 6, 9, 10}
    assert set(loops[1]) == {0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15}
    edges = {tuple(sorted(e)) for e in np.sort(np.concatenate([grid_with_hole()[:, [0, 1]], grid_with_hole()[:, [1, 2]], grid_with_hole()[:, [2, 0]]]), axis=1)}
    for loop in loops:  # consecutive ids (and last → first) are mesh edges: the loop is chained, not just collected
        for a, b in zip(loop, loop[1:] + loop[:1]):
            assert tuple(sorted((a, b))) in edges


def test_polyline_is_addressed_by_arc_length():
    line = Polyline(np.array([[0, 0, 0], [3, 0, 0], [3, 1, 0]], float))  # 4 long
    assert line.length == 4.0
    np.testing.assert_allclose(line.at(np.array([0.0, 0.5, 0.875, 1.0])), [[0, 0, 0], [2, 0, 0], [3, 0.5, 0], [3, 1, 0]])
    np.testing.assert_allclose(line.at(np.array([-1.0, 2.0])), [[0, 0, 0], [3, 1, 0]])  # clamped to the ends


@needs_gnm
def test_lid_margins_on_the_gnm_head():
    from ftv_pipeline.eyelids import eye_joints, lid_margins
    from ftv_pipeline.gnm import GNM

    gnm = GNM.load()
    margins = lid_margins(SimpleNamespace(gnm=gnm))
    assert sorted(margins) == [("left", "lower"), ("left", "upper"), ("right", "lower"), ("right", "upper")]
    for (side, lid), ids in margins.items():
        x, y = gnm.template[ids, 0], gnm.template[ids, 1]
        assert (x.mean() > 0) == (side == "left")
        assert abs(x[0]) == np.abs(x).min() and abs(x[-1]) == np.abs(x).max()  # inner corner → outer corner
        other = gnm.template[margins[(side, "lower" if lid == "upper" else "upper")], 1]
        assert (y.mean() > other.mean()) == (lid == "upper")
    eyes = eye_joints(gnm)
    assert eyes.shape == (2, 3) and eyes[0, 0] > 0 > eyes[1, 0]  # left_eye on +x
