"""export_groom.py: the Natural swatch colour (a mix of a groom's root and tip colours)."""
from __future__ import annotations

from ftv_pipeline.export_groom import mix_hex


def test_mix_hex():
    assert mix_hex("#000000", "#ffffff", 0.0) == "#000000"
    assert mix_hex("#000000", "#ffffff", 1.0) == "#ffffff"
    assert mix_hex("#102030", "#305070", 0.5) == "#203850"
