from __future__ import annotations

import numpy as np

from ftv_pipeline.export_glb import assign_triangles, assign_vertices
from ftv_pipeline.parts import EYE_PIVOTS, MATERIALS, PARTS

from .conftest import needs_gnm


def test_parts_are_consistent() -> None:
    names = [p.name for p in PARTS]
    assert len(set(names)) == len(names)
    for p in PARTS:
        assert p.material in MATERIALS
        assert p.node == "head" or p.node in EYE_PIVOTS
    for colour, roughness in MATERIALS.values():
        assert colour.startswith("#") and len(colour) == 7
        assert 0.0 <= roughness <= 1.0


@needs_gnm
def test_every_skin_and_eye_vertex_has_one_part() -> None:
    from ftv_pipeline.gnm import GNM

    gnm = GNM.load()
    owner = assign_vertices(gnm, list(PARTS))
    for group in ("skin", "teeth", "tongue", "irises", "pupils", "scleras"):
        assert (owner[gnm.vertex_groups[group]] >= 0).all(), group
    tri_owner = assign_triangles(owner, gnm.triangles, len(PARTS))
    eyes = [i for i, p in enumerate(PARTS) if p.node != "head"]
    # an eye triangle never lands in a head part (the eyes rotate on their own pivots)
    eye_vertex = np.isin(owner, eyes)
    head_tris = ~np.isin(tri_owner, eyes) & (tri_owner >= 0)
    assert not eye_vertex[gnm.triangles[head_tris]].all(axis=1).any()
