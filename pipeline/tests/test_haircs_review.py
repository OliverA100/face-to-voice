"""haircs_review.py: the selection's farthest-point sampling, its curly and extra picks, the generated labels and their
numbering."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ftv_pipeline import haircs_review
from ftv_pipeline.haircs_review import CURLY_QUOTA, EXTRA, farthest, names, number_duplicates


def test_farthest_starts_from_the_most_unusual_and_spreads():
    X = np.array([[0.0, 0.0], [0.1, 0.0], [0.0, 0.1], [5.0, 5.0], [-3.0, 0.0]])
    picks = farthest(X, 3)
    assert picks[0] == 3  # furthest from the mean
    assert picks[1] == 4  # then furthest from what is picked
    assert len(set(picks)) == 3


def test_farthest_keeps_everything_when_asked_for_more():
    assert farthest(np.zeros((2, 3)), 5) == [0, 1]


def test_farthest_grows_from_given_seeds():
    X = np.array([[0.0], [1.0], [2.0], [10.0]])
    assert farthest(X, 2, seed_idx=[0]) == [0, 3]


def test_number_duplicates_in_picker_order():
    styles = [{"label": "Shag"}, {"label": "Bob"}, {"label": "Shag"}, {"label": "Shag"}]
    number_duplicates(styles)
    assert [s["label"] for s in styles] == ["Shag", "Bob", "Shag 2", "Shag 3"]


def test_names_reads_the_measures():
    base = {"class": "bob", "len50": 15.0, "len90": 20.0, "asym": 0.0, "side": 0.0, "fringe": 0.0}
    picks = [{**base, "name": f"v0-{i:05d}", "curl": 1.0, "volume": 5.0} for i in range(8)]
    picks[0].update(curl=1.4, volume=9.0, fringe=0.1)  # curly, the fullest, with a fringe
    picks[1].update(curl=1.25, volume=1.0, asym=0.3)  # wavy, the sleekest, asymmetric
    labels = names(picks)
    assert labels["haircs-v0-00000"] == "Curly full bob with fringe"
    assert labels["haircs-v0-00001"] == "Wavy sleek asymmetric bob"
    assert labels["haircs-v0-00002"] == "Bob"


def _offline(monkeypatch, per_class: int) -> list[tuple[str, str]]:
    """HairCS's label tables and downloads replaced by `per_class` numbered styles per class; returns what was fetched."""
    fetched: list[tuple[str, str]] = []

    def rows(ver: str) -> list[dict]:
        return [{"number": f"{cls}{i:04d}", "class": cls} for cls in CURLY_QUOTA for i in range(per_class)]

    def fetch(ver: str, num: str) -> Path:
        fetched.append((ver, num))
        return Path(f"{ver}-{num}.npz")

    monkeypatch.setattr(haircs_review, "label_rows", rows)
    monkeypatch.setattr(haircs_review, "fetch_style", fetch)
    return fetched


def test_curly_picks_take_half_of_each_class_quota_from_v2_and_v3(monkeypatch):
    fetched = _offline(monkeypatch, per_class=40)
    picks = haircs_review.curly_picks()
    for cls, k in CURLY_QUOTA.items():
        mine = [p for p in picks if p["class"] == cls]
        assert len(mine) == 2 * max(1, round(k * 0.5))
        assert all(p["curly"] for p in mine)
    assert {v for v, _ in fetched} == {"v2", "v3"}
    assert len(set(fetched)) == len(fetched) == len(picks)  # spread through the list: no style twice
    assert picks[0]["name"] == "v2-" + fetched[0][1]


def test_extra_picks_sample_each_version_evenly(monkeypatch):
    fetched = _offline(monkeypatch, per_class=40)
    picks = haircs_review.extra_picks()
    assert [sum(p["variant"] == ver for p in picks) for ver in EXTRA] == list(EXTRA.values())
    assert len(set(fetched)) == len(fetched)


class _Response:
    def __init__(self, status: int, content: bytes):
        self.status_code, self.content = status, content

    def raise_for_status(self) -> None:
        import requests

        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")


def _serve(monkeypatch, tmp_path, status: int, content: bytes) -> list[str]:
    """HAIRCS_DIR in tmp_path; requests.get answers every URL with `status` and `content`; returns the URLs asked for."""
    for sub in ("data", "meta"):
        (tmp_path / sub).mkdir(exist_ok=True)
    monkeypatch.setattr(haircs_review, "HAIRCS_DIR", tmp_path)
    asked: list[str] = []

    def get(url, timeout):
        asked.append(url)
        return _Response(status, content)

    monkeypatch.setattr("requests.get", get)
    return asked


def _npz() -> bytes:
    import io

    buf = io.BytesIO()
    np.savez(buf, P=np.zeros((2, 4, 3), np.float32))
    return buf.getvalue()


def test_fetch_style_rejects_a_number_that_is_not_digits(tmp_path, monkeypatch):
    import pytest

    asked = _serve(monkeypatch, tmp_path, 200, _npz())
    with pytest.raises(ValueError, match="not a number"):
        haircs_review.fetch_style("v0", "../../escape")
    assert asked == [] and not (tmp_path / "escape.npz").exists()


def test_fetch_style_keeps_no_file_after_an_http_error_or_a_bad_download(tmp_path, monkeypatch):
    import pytest
    import requests

    _serve(monkeypatch, tmp_path, 404, b"Entry not found")
    with pytest.raises(requests.HTTPError):
        haircs_review.fetch_style("v0", "00001")
    _serve(monkeypatch, tmp_path, 200, b"<html>rate limited</html>")
    with pytest.raises(ValueError):  # not an .npz
        haircs_review.fetch_style("v0", "00001")
    assert list((tmp_path / "data").iterdir()) == []


def test_fetch_style_saves_a_good_download(tmp_path, monkeypatch):
    _serve(monkeypatch, tmp_path, 200, _npz())
    path = haircs_review.fetch_style("v0", "00001")
    assert path == tmp_path / "data" / "v0-00001.npz" and np.load(path)["P"].shape == (2, 4, 3)
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["v0-00001.npz"]


def test_label_rows_keeps_no_file_after_an_http_error(tmp_path, monkeypatch):
    import pytest
    import requests

    _serve(monkeypatch, tmp_path, 500, b"oops")
    with pytest.raises(requests.HTTPError):
        haircs_review.label_rows("v2")
    assert list((tmp_path / "meta").iterdir()) == []
    _serve(monkeypatch, tmp_path, 200, b"number,class\n00000,long\n")
    assert haircs_review.label_rows("v2") == [{"number": "00000", "class": "long"}]
