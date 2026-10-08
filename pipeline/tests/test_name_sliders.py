"""name_sliders.py: entries from Claude's answers, the same-name clusters, and a full run (Claude mocked) that merges
into the shipped sliders.json without breaking the next `uv run export` / `update-sliders`."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from ftv_pipeline import name_sliders, sliders_json
from ftv_pipeline.export_glb import MANIFEST
from ftv_pipeline.name_sliders import RAW_KINDS, clusters_of, merge_sliders, slider_entry

TARGET = {"name": "lower_face_region_003", "kind": "expression", "region": "lower_face_region"}
AI = {"name": "Jaw open", "description": "Opens the jaw.", "low_label": "closed", "high_label": "open",
      "group": "jaw_chin", "confidence": "high", "mouth_relevance": "high", "open_direction": "positive",
      "eyelid_close_direction": "none", "viseme_hints": []}
CFG = {"export": {"ranges": {}}}


def test_slider_entry_without_and_with_claude() -> None:
    weights = {"min": 0.0, "mid": 0.5, "max": 1.0}
    bare = slider_entry(TARGET, weights, None)
    assert bare["name"] == "lower face region 003" and bare["ai"] is None and bare["default"] == 0.0
    named = slider_entry(TARGET, weights, AI)
    assert (named["name"], named["lowLabel"], named["group"]) == ("Jaw open", "closed", "jaw_chin")
    assert named["ai"]["rawName"] == "Jaw open" and named["ai"]["openDirection"] == "positive"
    assert slider_entry(TARGET, {"min": 0.5, "mid": 1.0, "max": 1.5}, None)["default"] == 0.5  # 0 is out of range


def test_clusters_are_raw_sliders_sharing_claudes_name() -> None:
    sliders = [{"kind": "identity", "name": "Head shape 1", "ai": {"rawName": "Jaw open"}},
               {"kind": "expression", "name": "Mouth 2", "ai": {"rawName": "jaw open "}},
               {"kind": "expression", "name": "Nose width", "ai": None},
               {"kind": "semantic", "name": "Nose width"}]  # generated from its config: never renamed here
    (cluster,) = clusters_of(sliders)
    assert [s["name"] for s in cluster] == ["Head shape 1", "Mouth 2"]


def test_merge_adds_missing_raw_sliders_and_bootstraps_an_empty_document() -> None:
    manifest = {"sigma_scale": 3.0, "targets": [TARGET, {"name": "sem_age", "kind": "semantic", "region": "semantic"}]}
    doc: dict = {}
    added = merge_sliders(doc, "claude-x", manifest, {TARGET["name"]: {"ok": True, "result": AI}}, CFG)
    assert added == 1 and doc["model"] == "claude-x" and doc["sigmaScale"] == 3.0
    assert [s["id"] for s in doc["sliders"]] == [TARGET["name"]]  # semantic targets are not named here


@pytest.fixture
def shipped(tmp_path: Path, monkeypatch) -> tuple[Path, dict]:
    """A copy of the shipped sliders.json as the tool's output, and the shipped manifest."""
    if not (sliders_json.SLIDERS_JSON.exists() and MANIFEST.exists()):
        pytest.skip("shipped sliders.json / head.manifest.json not found")
    path = tmp_path / "sliders.json"
    path.write_bytes(sliders_json.SLIDERS_JSON.read_bytes())
    monkeypatch.setattr(name_sliders, "SLIDERS_JSON", path)
    monkeypatch.setattr(name_sliders, "REPO_DIR", tmp_path)  # the paths it prints
    return path, json.loads(MANIFEST.read_text())


def test_full_run_merges_into_the_v2_document(shipped, monkeypatch) -> None:
    """`uv run name-sliders` with Claude, the renders and the config mocked."""
    path, manifest = shipped
    before = json.loads(path.read_text())
    asked: list[str] = []

    def fake_name_one(api, model, target, files, views, weights, max_tokens, usage) -> dict:
        asked.append(target["name"])
        name = "Head size" if target["name"] in ("head_000", "head_001") else f"Name of {target['name']}"
        return {"ok": True, "result": {**AI, "name": name}, "attempts": 1, "output_tokens": 1}

    def fake_disambiguate_cluster(api, model, cluster, usage):
        return {s["id"]: SimpleNamespace(name=f"Renamed {s['id']}") for s in cluster}

    monkeypatch.setattr(name_sliders, "client", lambda: None)
    monkeypatch.setattr(name_sliders, "load_config", lambda: CFG)
    monkeypatch.setattr(name_sliders, "render_targets", lambda names, views: [{"name": n, "files": {}} for n in names])
    monkeypatch.setattr(name_sliders, "name_one", fake_name_one)
    monkeypatch.setattr(name_sliders, "disambiguate_cluster", fake_disambiguate_cluster)
    monkeypatch.setattr(sys, "argv", ["name-sliders", "--model", "claude-test", "--workers", "2"])
    name_sliders.main()

    raw_targets = [t["name"] for t in manifest["targets"] if t["kind"] in RAW_KINDS]
    assert sorted(asked) == sorted(raw_targets)  # never the semantic or emotion targets
    after = json.loads(path.read_text())
    # the document stays v2: everything but the model and the raw sliders' `ai` blocks is untouched
    expected = copy.deepcopy(before)
    expected["model"] = "claude-test"
    for i, s in enumerate(expected["sliders"]):
        if s["kind"] in RAW_KINDS:
            s["ai"] = after["sliders"][i]["ai"]
    assert after == expected
    ai = {s["id"]: s["ai"] for s in after["sliders"] if s["kind"] in RAW_KINDS}
    assert ai["head_002"]["rawName"] == "Name of head_002" and ai["head_002"]["confidence"] == "high"
    assert "disambiguated" not in ai["head_002"]
    # the two that shared a name went through the rename pass (into rawName only)
    assert [ai[k]["rawName"] for k in ("head_000", "head_001")] == ["Renamed head_000", "Renamed head_001"]
    assert ai["head_000"]["disambiguated"] is True
    assert not clusters_of(after["sliders"])

    # The next export (sliders_json.update) starts from these raw sliders: the step a v1 rewrite broke.
    raw, groups = sliders_json.raw_sliders(after, SimpleNamespace(components=[]), float(after["sigmaScale"]))
    assert [s["id"] for s in raw] == raw_targets and groups


def test_a_run_with_no_answers_leaves_the_file_byte_identical(shipped) -> None:
    path, manifest = shipped
    data = path.read_bytes()
    failed = {t["name"]: {"ok": False, "error": "x"} for t in manifest["targets"]}
    assert name_sliders.write_sliders(path, "claude-test", manifest, failed, CFG) == 0
    assert path.read_bytes() == data


def test_only_rejects_targets_that_are_not_raw(shipped, monkeypatch) -> None:
    monkeypatch.setattr(name_sliders, "load_config", lambda: CFG)
    monkeypatch.setattr(sys, "argv", ["name-sliders", "--only", "sem_age", "--dry-run"])
    with pytest.raises(SystemExit, match="sem_age"):
        name_sliders.main()
