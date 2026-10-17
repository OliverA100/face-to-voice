"""random_split.py: a raw random face rewritten as Feature slider values plus a raw remainder."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from ftv_pipeline import random_split, semantic


def test_features_and_remainder_rebuild_the_raw_face(tiny_gnm, monkeypatch) -> None:
    monkeypatch.setattr(semantic, "load_config", dict)
    monkeypatch.setattr(semantic, "shipped_ids", lambda cfg: {"wide", "long"})
    sigma = 0.5
    raw_dirs = tiny_gnm.identity_basis * sigma  # what one unit of each raw slider moves
    A = np.array([[1.0, 0.4], [-0.3, 2.0]])  # two Features, each a mix of both raw directions
    feature_dirs = np.einsum("fr,rvd->fvd", A, raw_dirs)
    sol = SimpleNamespace(shipped=["head_000", "head_001"], ids=["wide", "long", "unshipped"],
                          delta=lambda gnm, k: feature_dirs[k])

    raw, feats, P, Q, stats = random_split.split_matrices(tiny_gnm, sol, sigma)

    assert raw == ["head_000", "head_001"]
    assert feats == ["sem_wide", "sem_long"]
    ext = tiny_gnm.vertex_groups["skin_exterior"]
    Raw = raw_dirs[:, ext].reshape(2, -1)
    M = feature_dirs[:, ext].reshape(2, -1)
    w = np.array([[0.3, -0.6], [-0.8, 0.1]])  # two draws
    np.testing.assert_allclose(w @ P @ M + w @ Q @ Raw, w @ Raw, atol=1e-4)
    np.testing.assert_allclose(P, np.linalg.inv(A), atol=1e-3)  # the Features can carry the whole face, so they do
    np.testing.assert_allclose(Q, 0.0, atol=1e-3)
    assert stats["features_share"] > 0.999
