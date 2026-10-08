"""`uv run bake-ao`: ambient occlusion of the neutral head, baked in Blender into the skin's UV layout.

Two bakes are combined: a broad one (how much sky a point sees within `broad_m`: eye sockets, under the nose and
jaw, the ear bowl) and a tight one (`crease_m`: lip line, nostril rims, eyelid folds). The result goes into the R
channel of `skin_regions` (skin_maps.py fills G = redness, B = oiliness, A = thickness) as KTX2 at two sizes, so the
low quality tier downloads the small one. Settings in config/bake.toml; Blender runs headless (blender/bake_ao.py).

Needs Blender (macOS: /Applications/Blender.app, else `blender` on PATH, or set BLENDER) and basisu (Homebrew).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
import tomllib
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from .export_glb import RAW_GLB
from .gnm import OUT_DIR, PIPELINE_DIR, REPO_DIR

CONFIG = PIPELINE_DIR / "config" / "bake.toml"
BAKE_DIR = OUT_DIR / "bake"
TEXTURES_DIR = REPO_DIR / "web" / "public" / "textures"
SCRIPTS = PIPELINE_DIR / "blender"


def blender() -> str:
    for cand in (os.environ.get("BLENDER"), shutil.which("blender"), "/Applications/Blender.app/Contents/MacOS/Blender"):
        if cand and Path(cand).exists():
            return cand
    raise SystemExit("Blender not found: install it or set BLENDER=/path/to/blender")


def run_blender(script: str, *args) -> None:
    cmd = [blender(), "-b", "--factory-startup", "-P", str(SCRIPTS / script), "--", *map(str, args)]
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)  # failures are reported below, with the log
    if r.returncode != 0 or "Error" in r.stderr:
        raise SystemExit(f"blender {script} failed:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")


def read_grey(path: Path) -> np.ndarray:
    """A baked PNG (8 or 16 bit, grey or RGB) as float 0..1."""
    im = Image.open(path)
    a = np.asarray(im).astype(np.float64)
    if a.ndim == 3:
        a = a[..., 0]
    return a / (65535.0 if a.max() > 255 else 255.0)


def ktx2(png: Path, out: Path, *, linear: bool = True, uastc: bool = False, quality: int = 128) -> int:
    """Encode with basisu: ETC1S (small, fine for smooth data) or UASTC (sharper, bigger), full mip chain."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["basisu", "-ktx2", "-mipmap", "-quiet", "-no_stats", "-file", str(png), "-output_file", str(out)]
    cmd += ["-linear"] if linear else ["-srgb"]
    cmd += ["-uastc", "-uastc_rdo_l", "1.0"] if uastc else ["-q", str(quality), "-comp_level", "4"]
    subprocess.run(cmd, check=True, capture_output=True)
    return out.stat().st_size


def load_config() -> dict:
    with open(CONFIG, "rb") as f:
        return tomllib.load(f)


def bake_ao(cfg: dict) -> np.ndarray:
    a = cfg["ao"]
    size = int(a["bake_size"])
    if not RAW_GLB.exists():
        raise SystemExit(f"{RAW_GLB} is missing: run `uv run export` first")
    BAKE_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for name in ("broad", "crease"):
        png = BAKE_DIR / f"ao_{name}.png"
        t = time.time()
        run_blender("bake_ao.py", RAW_GLB, png, size, a[f"{name}_m"], a["samples"])
        out[name] = read_grey(png)
        print(f"  {name}: {a[f'{name}_m'] * 1000:.0f} mm, {size}², {a['samples']} samples, {time.time() - t:.1f} s")
    # Combine: AO = broad^gamma_broad · crease^gamma_crease, then a light blur against Monte-Carlo noise.
    ao = out["broad"] ** a["broad_gamma"] * out["crease"] ** a["crease_gamma"]
    img = Image.fromarray(np.clip(ao * 255 + 0.5, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(a["blur_px"] * size / 1024)))


def write_regions(ao: np.ndarray, cfg: dict, gba: np.ndarray) -> dict:
    """Pack skin_regions RGBA: R = AO; G = redness, B = oiliness, A = thickness from skin_maps.py (`gba` = redness,
    oiliness, thinness, 0..1, same size as `ao`)."""
    h, w = ao.shape
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[..., 0] = ao
    rgba[..., 1:3] = np.clip(gba[..., :2] * 255 + 0.5, 0, 255).astype(np.uint8)
    # A is stored as thickness (1 − thinness) and never reaches 0: basisu drops the colour of fully transparent
    # texels, which would blank the AO wherever the skin is not thin.
    rgba[..., 3] = np.clip(255 - gba[..., 2] * 254 + 0.5, 1, 255).astype(np.uint8)
    sizes = {}
    for size in cfg["regions"]["sizes"]:
        png = BAKE_DIR / f"skin_regions@{size}.png"
        Image.fromarray(rgba).resize((size, size), Image.LANCZOS).save(png)
        name = "skin_regions.ktx2" if size == max(cfg["regions"]["sizes"]) else f"skin_regions@{size}.ktx2"
        sizes[name] = ktx2(png, TEXTURES_DIR / name, uastc=cfg["regions"]["codec"] == "uastc", quality=int(cfg["regions"]["etc1s_quality"]))
    return sizes


def main() -> None:
    cfg = load_config()
    t = time.time()
    print("baking AO in Blender …")
    ao = bake_ao(cfg)
    Image.fromarray(ao).save(BAKE_DIR / "ao.png")
    # skin_regions also carries the skin maps (G, B, A) and the ears' lighter AO: skin_maps.py packs it
    from .skin_maps import main as skin_maps

    skin_maps()
    print(f"done in {time.time() - t:.1f} s (preview {BAKE_DIR.relative_to(REPO_DIR) / 'ao.png'})")
