"""`uv run eye-maps`: the iris texture, generated here (MIT), no photo.

iris.ktx2 (512², linear): the iris disc of GNM's radial eye UVs (centre 0.5, iris edge at UV radius 0.185 → the
texture's edge; the pupil, drawn by the shader, at 0.052 → PUPIL here).
  R = brightness (×2 in the shader, so 0.5 = the chosen eye colour as is), G = warm zone (the pupillary zone inside the
  collarette, where many irises are amber or lighter), B = unused.
The pattern is drawn in polar coordinates (angle × radius) and then unrolled into the disc: ~1500 wavy light fibres
over a darker base, a zigzag collarette, dark crypts beside it, broken contraction furrows in the outer zone, a soft
dark limbal ring and the pupillary ruff. Tweak in config/eyes.toml.
"""
from __future__ import annotations

import time
import tomllib

import numpy as np
from PIL import Image
from scipy import ndimage

from .bake import BAKE_DIR, TEXTURES_DIR, ktx2
from .gnm import PIPELINE_DIR, REPO_DIR

CONFIG = PIPELINE_DIR / "config" / "eyes.toml"
PUPIL = 0.052 / 0.185  # the pupil radius as a fraction of the iris radius (lib/eyeShader.ts EYE_LOOK)


def polar_pattern(cfg: dict, A: int = 2048, R: int = 384, seed: int = 11) -> tuple[np.ndarray, np.ndarray]:
    """(R, A) brightness and warm mask over t = 0 (pupil edge) … 1 (iris edge), angle 0 … 2π (wraps)."""
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 1, R)[:, None]
    ang = np.linspace(0, 1, A, endpoint=False)[None, :]

    def smooth_noise(scale_a: int, scale_r: int) -> np.ndarray:
        g = rng.standard_normal((scale_r, scale_a))
        g = np.concatenate([g, g[:, :1]], 1)  # wrap round the angle
        z = ndimage.zoom(g, (R / scale_r, (A + A / scale_a) / (scale_a + 1)), order=3)[:R, :A]
        return z / (np.abs(z).max() + 1e-9)

    # fibres: light strands from the pupil out to the edge, wavy, of varied brightness, width and length
    fib = np.zeros((R, A))
    rows = np.arange(R)
    for _ in range(int(cfg["fibres"])):
        a0 = rng.uniform(0, A)
        amp = rng.uniform(1.5, 6)
        freq = rng.uniform(1.0, 3.0)
        ph = rng.uniform(0, 6.28)
        t0 = rng.uniform(0, 0.35) if rng.random() < 0.5 else 0.0
        t1 = rng.uniform(0.55, 1.0)
        width = rng.uniform(0.7, 2.2)
        bright = rng.uniform(0.35, 1.0)
        tt = rows / (R - 1)
        on = (tt >= t0) & (tt <= t1)
        centre = a0 + amp * np.sin(freq * tt * 6.28 + ph) + rng.uniform(-3, 3) * tt
        fade = np.clip(np.minimum(tt - t0, t1 - tt) / 0.06, 0, 1)
        for dx in range(-4, 5):
            col = (np.floor(centre).astype(int) + dx) % A
            w = np.exp(-((np.floor(centre) + dx - centre) ** 2) / (width * width))
            fib[rows[on], col[on]] += (bright * w * fade)[on]
    fib = np.clip(fib / np.percentile(fib, 99.5), 0, 1)
    base = 0.55 + 0.25 * smooth_noise(64, 12)
    bright = base * (1 - cfg["fibre_contrast"]) + cfg["fibre_contrast"] * (0.35 + 1.05 * fib)
    # collarette: a zigzag ring; inside it the pupillary zone (warm mask)
    zig = cfg["collarette_at"] + 0.04 * np.sin(ang * 6.2832 * 13 + 2.5 * smooth_noise(24, 1)[0]) + 0.025 * smooth_noise(80, 1)[0]
    inner = 1.0 / (1.0 + np.exp((t - zig) / 0.012))
    collar = np.exp(-((t - zig) / 0.03) ** 2)
    bright = bright * (1 + cfg["collarette"] * collar * (0.6 + fib))
    # crypts: dark lens-shaped pits just outside the collarette, longer along the radius
    crypt = np.zeros((R, A))
    for _ in range(int(cfg["crypts"])):
        ca, ct = rng.uniform(0, A), rng.uniform(0.05, 0.3)
        za = np.interp(ca, np.arange(A), zig[0]) + ct
        sa, sr = rng.uniform(6, 18), rng.uniform(0.03, 0.08)
        da = (ang * A - ca + A / 2) % A - A / 2
        crypt = np.maximum(crypt, np.exp(-(da / sa) ** 2 - ((t - za) / sr) ** 2) * rng.uniform(0.5, 1.0))
    bright *= 1 - cfg["crypt_depth"] * crypt
    # contraction furrows: broken concentric rings in the outer zone
    rings = 0.5 + 0.5 * np.cos(t * 6.2832 * cfg["furrows"] + 1.5 * smooth_noise(10, 3))
    broken = np.clip(smooth_noise(20, 4) * 1.5 + 0.2, 0, 1)
    bright *= 1 - cfg["furrow_depth"] * (rings ** 6) * broken * np.clip((t - 0.5) / 0.2, 0, 1)
    # limbal ring and pupillary ruff
    bright *= 1 - cfg["limbal"] * np.clip((t - 0.72) / 0.28, 0, 1) ** 1.5
    bright *= 1 - 0.65 * np.exp(-(t / 0.035) ** 2) * (0.8 + 0.2 * np.cos(ang * 6.2832 * 40))
    return np.clip(bright, 0, 2), inner * np.ones_like(bright)


def unroll(polar: np.ndarray, size: int) -> np.ndarray:
    """Polar (t × angle) → the iris disc in a size² square (outside the disc: the edge value)."""
    R, A = polar.shape
    y, x = np.mgrid[0:size, 0:size]
    u, v = (x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1
    rho = np.sqrt(u * u + v * v)
    t = np.clip((rho - PUPIL) / (1 - PUPIL), 0, 1) * (R - 1)
    # angle as the shader measures it: atan(v, u) on UVs (rows run with v)
    a = (np.arctan2(v, u) / (2 * np.pi)) % 1.0 * A
    wrapped = np.concatenate([polar, polar[:, :1]], 1)
    return ndimage.map_coordinates(wrapped, [t, a], order=1)


def main() -> None:
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)["iris"]
    t0 = time.time()
    bright, warm = polar_pattern(cfg)
    size = int(cfg["size"])
    rgba = np.zeros((size, size, 4), np.uint8)
    rgba[..., 0] = np.clip(unroll(bright, size) / 2 * 255 + 0.5, 0, 255)
    rgba[..., 1] = np.clip(unroll(warm, size) * 255 + 0.5, 0, 255)
    rgba[..., 3] = 255
    BAKE_DIR.mkdir(parents=True, exist_ok=True)
    png = BAKE_DIR / "iris.png"
    Image.fromarray(rgba).save(png)
    n = ktx2(png, TEXTURES_DIR / "iris.ktx2", uastc=True)
    print(f"  web/public/textures/iris.ktx2: {n / 1000:.0f} KB ({size}²) in {time.time() - t0:.1f} s; preview {png.relative_to(REPO_DIR)}")
