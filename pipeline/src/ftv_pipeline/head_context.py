"""The GNM head the add-on tools work on: the model, the morph targets head.glb ships (shape and motion kinds) and the
skin surfaces."""
from __future__ import annotations

import functools
from dataclasses import dataclass

import numpy as np

from .export_glb import MOTION_KINDS, SHAPE_KINDS, load_config, resolve_targets
from .gnm import GNM
from .surface import Surface, gnm_surface


@dataclass
class HeadContext:
    gnm: GNM
    targets: list  # export_glb.Target: name, kind, scale (σ per weight 1.0), delta (V, 3) metres at weight 1.0

    @functools.cached_property
    def skin(self) -> Surface:
        """GNM skin without the ears: the default binding surface (as for hair)."""
        return gnm_surface(self.gnm)

    @functools.cached_property
    def skin_ears(self) -> Surface:
        """GNM skin with the ears: what assets are draped over and cleared from; glasses anchors."""
        return gnm_surface(self.gnm, ears=True)

    @functools.cached_property
    def deltas(self) -> dict[str, np.ndarray]:
        return {t.name: t.delta for t in self.targets}

    def head(self, weights: dict[str, float]) -> np.ndarray:
        """Head vertices for head.glb morph weights (any target: raw GNM, semantic or emotion)."""
        v = self.gnm.template.copy()
        for k, w in weights.items():
            if w:
                v += np.float32(w) * self.deltas[k]
        return v


def head_context() -> HeadContext:
    gnm = GNM.load()
    targets = [t for t in resolve_targets(gnm, load_config()) if t.kind in SHAPE_KINDS + MOTION_KINDS]
    return HeadContext(gnm, targets)
