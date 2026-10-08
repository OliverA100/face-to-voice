from __future__ import annotations

import gzip
from pathlib import Path

from ftv_pipeline.render import sample_weights
from ftv_pipeline.tools import file_sizes, fmt_mb


def test_file_sizes(tmp_path: Path) -> None:
    path = tmp_path / "x.bin"
    path.write_bytes(b"ab" * 5000)
    sizes = file_sizes(path)
    assert sizes["raw"] == 10_000
    assert sizes["gzip"] == len(gzip.compress(b"ab" * 5000, compresslevel=9))
    assert 0 < sizes["brotli"] < 100


def test_fmt_mb() -> None:
    assert fmt_mb(3_456_789) == "3.46 MB"


def test_sample_weights() -> None:
    cfg = {"export": {"ranges": {"jaw": [0, 1]}}}
    assert sample_weights("jaw", cfg) == {"min": 0.0, "mid": 0.5, "max": 1.0}
    assert sample_weights("nose", cfg) == {"min": -1.0, "mid": 0.0, "max": 1.0}
