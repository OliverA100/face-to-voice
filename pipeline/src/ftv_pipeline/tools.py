"""Run the Node-based glTF tools pinned in pipeline/package.json (gltfpack, glTF-Transform)."""
from __future__ import annotations

import gzip
import subprocess
from pathlib import Path

import brotli

from .gnm import PIPELINE_DIR


def node_tool(name: str, *args, capture: bool = False) -> subprocess.CompletedProcess:
    if not (PIPELINE_DIR / "node_modules" / ".bin" / name).exists():
        raise RuntimeError(f"{name} is not installed: run `pnpm install` in {PIPELINE_DIR}")
    cmd = ["pnpm", "exec", name, *map(str, args)]
    return subprocess.run(cmd, cwd=PIPELINE_DIR, check=True, text=True, capture_output=capture)


def gltfpack(src: Path, dst: Path, *flags: str) -> None:
    node_tool("gltfpack", "-i", src, "-o", dst, *flags)


def gltf_transform(*args, capture: bool = True) -> subprocess.CompletedProcess:
    return node_tool("gltf-transform", *args, capture=capture)


def file_sizes(path: Path) -> dict[str, int]:
    """Bytes on disk and what the CDN would send with gzip / brotli."""
    raw = path.read_bytes()
    return {
        "raw": len(raw),
        "gzip": len(gzip.compress(raw, compresslevel=9)),
        "brotli": len(brotli.compress(raw, quality=11)),
    }


def fmt_mb(n: int) -> str:
    return f"{n / 1e6:.2f} MB"
