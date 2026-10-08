"""Morph weights -> vertex positions, the way the web app poses head.glb.

GNM is linear, so a posed head is the template plus a weighted sum of target deltas. The deltas come from the
same source the export uses (export_glb.resolve_targets); `uv run verify` keeps the shipped .glb within 10 µm of
them. Two things the web app does that a plain sum does not:

  eyes   Each eyeball hangs off a pivot node (its GNM eye joint). The eye meshes carry only their change of shape
         (target delta minus the joint delta); the pivot moves by Σ weight × joint delta (Head.tsx, from the
         manifest's identity_pivot_basis), and gaze rotates the eye about it. `pivot_weights` lets a check use
         other weights for the pivot than for the mesh (the web app takes them from userValue, the mesh from
         effective).
  combos Mix sliders (head size, age, fine-tune controls) have no target of their own; their value is spread
         over real targets (sliders.json `combo` / `comboNeg`, lib/morphs/store.ts).
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

from ..export_glb import assign_vertices, load_config, resolve_targets
from ..gnm import GNM, REPO_DIR
from ..parts import EYE_PIVOTS, PARTS

SLIDERS_JSON = REPO_DIR / "web" / "src" / "data" / "sliders.json"
EYES = ("left_eye", "right_eye")


@dataclass
class HeadModel:
    gnm: GNM
    names: list[str]  # morph targets, in export order
    kinds: list[str]
    deltas: np.ndarray  # (N, V, 3) float32 metres at weight 1
    joint_deltas: np.ndarray  # (N, 2, 3) float32 metres at weight 1: how each target moves the two eye pivots
    owner: np.ndarray  # (V,) index into PARTS, -1 = not shipped
    eye: np.ndarray  # (V,) 0 = left eye, 1 = right eye, -1 = not an eye vertex
    pivot0: np.ndarray  # (2, 3) rest eye pivots
    sliders: dict[str, dict]  # sliders.json entries by target name

    @classmethod
    def load(cls, gnm: GNM | None = None) -> HeadModel:
        gnm = gnm or GNM.load()
        targets = resolve_targets(gnm, load_config())
        joints = [gnm.joint_names.index(EYE_PIVOTS[e]) for e in EYES]
        owner = assign_vertices(gnm, list(PARTS))
        eye = np.full(len(gnm.template), -1, np.int64)
        for p_i, p in enumerate(PARTS):
            if p.node in EYES:
                eye[owner == p_i] = EYES.index(p.node)
        doc = json.loads(SLIDERS_JSON.read_text())
        return cls(
            gnm=gnm,
            names=[t.name for t in targets],
            kinds=[t.kind for t in targets],
            deltas=np.stack([t.delta.astype(np.float32) for t in targets]),
            joint_deltas=np.stack([t.joint_delta[joints].astype(np.float32) for t in targets]),
            owner=owner,
            eye=eye,
            pivot0=gnm.joint_positions[joints].astype(np.float32),
            sliders={s["target"]: s for s in doc["sliders"] if s["kind"] != "pose"},
        )

    # --- weights ----------------------------------------------------------------------------------------------

    def vector(self, weights: dict[str, float]) -> np.ndarray:
        """{target: weight} -> (N,) in target order. Unknown names raise (typos would silently test nothing)."""
        w = np.zeros(len(self.names), np.float32)
        for t, v in weights.items():
            w[self.names.index(t)] += v
        return w

    def expand(self, values: dict[str, float]) -> dict[str, float]:
        """Slider values (mix sliders included) -> real target weights, like the store's combo layer.
        No clamping and no animation layers: for single-slider measurements only."""
        out: dict[str, float] = {}
        for target, x in values.items():
            s = self.sliders.get(target, {})
            if "combo" in s:
                spread = s["comboNeg"] if x < 0 and "comboNeg" in s else s["combo"]
                k = -x if x < 0 and "comboNeg" in s else x
                for t, cw in spread.items():
                    out[t] = out.get(t, 0.0) + k * cw
            else:
                out[target] = out.get(target, 0.0) + x
        return out

    # --- geometry ---------------------------------------------------------------------------------------------

    def pivots(self, w: np.ndarray) -> np.ndarray:
        """(2, 3) eye pivots for target weights `w` (N,)."""
        return self.pivot0 + np.tensordot(w, self.joint_deltas, axes=1)

    def positions(self, w: np.ndarray | dict, pivot_w: np.ndarray | dict | None = None,
                  gaze: np.ndarray | None = None) -> np.ndarray:
        """(V, 3) metres. `w` = target weights; `pivot_w` = weights for the eye pivots (default: w);
        `gaze` = (2, 3, 3) rotation per eye about its pivot (default: none)."""
        w = self.vector(w) if isinstance(w, dict) else w
        P = self.gnm.template + np.tensordot(w, self.deltas, axes=1)
        if pivot_w is None and gaze is None:
            return P  # pivot follows the mesh exactly: the plain sum is already right
        pw = w if pivot_w is None else (self.vector(pivot_w) if isinstance(pivot_w, dict) else pivot_w)
        moved = self.pivots(w)  # where the plain sum put the eye's own pivot
        target = self.pivots(pw)
        for e in range(2):
            idx = self.eye == e
            local = P[idx] - moved[e]
            if gaze is not None:
                local = local @ gaze[e].T
            P[idx] = target[e] + local
        return P
