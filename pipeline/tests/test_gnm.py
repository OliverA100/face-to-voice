from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.gnm import EXPECTED, GNM

from .conftest import needs_gnm


def test_vertices_is_the_linear_model(tiny_gnm: GNM) -> None:
    g = tiny_gnm
    np.testing.assert_array_equal(g.vertices({}), g.template)
    v = g.vertices({"head_000": 2.0, "lower_face_region_000": -0.5, "head_001": 0.0})
    expected = g.template + 2.0 * g.identity_basis[0] - 0.5 * g.expression_basis[0]
    np.testing.assert_allclose(v, expected, rtol=0, atol=1e-6)


def test_component_lookup(tiny_gnm: GNM) -> None:
    g = tiny_gnm
    assert g.kind_of("head_001") == "identity"
    assert g.kind_of("lower_face_region_000") == "expression"
    with pytest.raises(KeyError):
        g.kind_of("nose_999")
    np.testing.assert_array_equal(g.delta("head_001"), g.identity_basis[1])
    np.testing.assert_array_equal(g.joint_delta("head_001"), g.joint_identity_basis[1])
    np.testing.assert_array_equal(g.joint_delta("lower_face_region_000"), np.zeros((4, 3)))


def test_regions(tiny_gnm: GNM) -> None:
    assert GNM.region_of("lower_face_region_004") == "lower_face_region"
    assert GNM.region_of("tongue_mean") == "tongue"
    assert tiny_gnm.components_by_region() == {"head": ["head_000", "head_001"], "lower_face_region": ["lower_face_region_000"]}


def test_mask_intersects_and_excludes(tiny_gnm: GNM) -> None:
    np.testing.assert_array_equal(tiny_gnm.mask("skin", "skin_exterior"), [True, True, True, True, False])
    np.testing.assert_array_equal(tiny_gnm.mask("skin", exclude=("skin_exterior",)), [False] * 5)


@needs_gnm
def test_cached_model_layout() -> None:
    g = GNM.load()  # checks the sha256 and the layout against EXPECTED itself
    assert len(g.template) == EXPECTED["vertices"]
    assert g.triangle_uvs is not None and g.triangle_uvs.shape == (EXPECTED["triangles"], 3, 2)
    # GNM's mirror table is an involution: every vertex's partner points back at it
    np.testing.assert_array_equal(g.mirror[g.mirror], np.arange(len(g.template)))
