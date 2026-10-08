"""Shape guides: the little the pipeline still took from MakeHuman, saved once as this project's own data.

  pipeline/config/guides/brows/<id>.npz    a MakeHuman eyebrow card as fitted on the GNM head: positions (float32
                                           metres), uvs, triangles, and its painted alpha (uint8). brow_strands.py
                                           reads where hairs grow, how densely and which way they lie.
  pipeline/config/guides/beards/<id>.npz   a MakeHuman beard as fitted on the GNM head: its vertices (float32 metres).
                                           stubble.py and beard_strands.py read its outline (where it meets the skin)
                                           and how far it hangs.
  pipeline/config/guides/landmarks.json    named points on the aligned MakeHuman head (landmarks.LANDMARK_NAMES), which the
                                           glasses solver (glasses_fit.place_glasses) pairs with the GNM head's.

They derive from MakeHuman assets released to the public domain (CC0 1.0: the system eyebrows, the community
bodyparts05 beards); the files here are this project's (MIT) and are only read, never regenerated. brows.toml `guide`,
stubble.toml and beards.toml `guides` / `hang_guides` name them.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache

import numpy as np

from .gnm import PIPELINE_DIR

GUIDES_DIR = PIPELINE_DIR / "config" / "guides"


@dataclass(frozen=True)
class Card:
    """A painted card fitted on the GNM head."""

    positions: np.ndarray  # (N, 3) float32 metres, one row per split vertex
    uvs: np.ndarray  # (N, 2) glTF convention (v grows downwards, like image rows)
    triangles: np.ndarray  # (T, 3) vertex ids
    alpha: np.ndarray  # (H, W) uint8: the painted coverage


@cache
def brow_card(card_id: str) -> Card:
    with np.load(GUIDES_DIR / "brows" / f"{card_id}.npz") as f:
        return Card(f["positions"], f["uvs"], f["triangles"], f["alpha"])


@cache
def beard_guide(guide_id: str) -> np.ndarray:
    """(N, 3) float32 metres: the fitted beard's vertices on the GNM head."""
    with np.load(GUIDES_DIR / "beards" / f"{guide_id}.npz") as f:
        return f["positions"]


@cache
def mh_landmarks() -> dict[str, np.ndarray]:
    """name → (3,) float64 metres: the point on the aligned MakeHuman head."""
    data = json.loads((GUIDES_DIR / "landmarks.json").read_text())
    return {name: np.array(p, np.float64) for name, p in data["points"].items()}

