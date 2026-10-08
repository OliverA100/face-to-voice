"""`uv run skin-maps`: the skin's region maps and pore texture, all generated here (MIT).

skin_regions (RGBA, the skin UVs; R = the AO from `uv run bake-ao`, lightened inside the ears):
  G = redness (lips, nose, ears, cheeks, eyelids), B = oiliness (T-zone), A = thickness (1 − thinness: ears, nose
  wings and eyelids are thin; stored this way because basisu blanks the colour of texels whose alpha is 0).
  Values come per GNM vertex group (config/skin.toml), are smoothed over the mesh so regions fade into each other,
  then drawn into the UV layout (the same per-corner UVs head.glb ships).
skin_detail (grey, tileable): a height map of pores, fine criss-cross lines and soft grain. The shader lays it on the
  rest position from three sides (triplanar), so it needs no UVs and never stretches.
"""
from __future__ import annotations

import json
import time
import tomllib

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.sparse import coo_matrix, diags

from .bake import BAKE_DIR, TEXTURES_DIR, ktx2, load_config, read_grey, write_regions
from .gnm import GNM, PIPELINE_DIR, REPO_DIR

CONFIG = PIPELINE_DIR / "config" / "skin.toml"
LANDMARKS = REPO_DIR / "web" / "src" / "data" / "ageing.json"
CHANNELS = ("redness", "oiliness", "thinness")


def load_skin_config() -> dict:
    with open(CONFIG, "rb") as f:
        return tomllib.load(f)


def skin_triangles(gnm: GNM) -> np.ndarray:
    """Indices of the triangles in the shipped skin part (the AO bake's surface)."""
    return np.nonzero(gnm.vertex_groups["skin"][gnm.triangles].all(axis=1))[0]


def vertex_values(gnm: GNM, cfg: dict, name: str, tris: np.ndarray) -> np.ndarray:
    """(V,) 0..1 for one channel: first matching group wins, then neighbour-averaged over the skin."""
    table = cfg[name]
    V = len(gnm.template)
    val = np.full(V, float(table.get("default", 0.0)))
    done = np.zeros(V, bool)
    sharp_val = np.zeros(V)
    for group, x in table.items():
        if group in gnm.vertex_groups:
            m = gnm.vertex_groups[group] & ~done
            val[m], done = float(x), done | m
            if group in table.get("sharp", []):
                sharp_val[m] = float(x)
    if name == "thinness":  # soft spots round the nose wings (left landmark, mirrored)
        al = np.array(json.loads(LANDMARKS.read_text())["landmarks"]["alare_l"])
        r = cfg[name]["nostril_mm"] / 1000
        for side in (al, al * [-1, 1, 1]):
            d = np.linalg.norm(gnm.template - side, axis=1)
            val = np.maximum(val, cfg[name]["nostril"] * np.exp(-(d / r) ** 2))
    f = gnm.triangles[tris]
    i, j = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]]), np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    A = coo_matrix((np.ones(len(i)), (i, j)), shape=(V, V)).tocsr()
    A.data[:] = 1.0
    A = A + diags(np.ones(V))
    A = diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    for i in range(int(cfg["smooth"]["iterations"])):
        val = A @ val
        if i < int(table.get("sharp_iterations", 0)):
            sharp_val = A @ sharp_val
    return np.clip(np.maximum(val, sharp_val), 0, 1)


def rasterize(gnm: GNM, tris: np.ndarray, values: np.ndarray, size: int) -> np.ndarray:
    """(size, size, C) float: per-vertex values drawn into the UV layout (row = v · size, as the AO bake), the empty
    texels filled from the nearest drawn one (no dark seams once mipmapped)."""
    C = values.shape[1]
    img = np.zeros((size, size, C))
    hit = np.zeros((size, size), bool)
    uvs = gnm.triangle_uvs[tris] * size - 0.5  # texel centres at integers
    vals = values[gnm.triangles[tris]]  # (T, 3, C)
    for (a, b, c), va in zip(uvs, vals):
        lo = np.floor(np.minimum(np.minimum(a, b), c)).astype(int)
        hi = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int)
        lo, hi = np.clip(lo, 0, size - 1), np.clip(hi, 0, size - 1)
        xs, ys = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
        p = np.stack([xs.ravel(), ys.ravel()], 1).astype(float)
        v0, v1, v2 = b - a, c - a, p - a
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        w1 = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
        w2 = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
        w0 = 1 - w1 - w2
        inside = (w0 >= -1e-3) & (w1 >= -1e-3) & (w2 >= -1e-3)
        if not inside.any():
            continue
        px, py = p[inside, 0].astype(int), p[inside, 1].astype(int)
        img[py, px] = w0[inside, None] * va[0] + w1[inside, None] * va[1] + w2[inside, None] * va[2]
        hit[py, px] = True
    _, (iy, ix) = ndimage.distance_transform_edt(~hit, return_indices=True)
    return img[iy, ix]


def detail_height(cfg: dict, seed: int = 3) -> np.ndarray:
    """(size, size) 0..1, 0.5 = flat: pores (round dips), fine criss-cross lines, soft grain. Tileable: pores wrap
    round the edges and the lines and grain are band-passed noise made with an FFT (periodic by construction)."""
    d = cfg["detail"]
    n = int(d["size"])
    rng = np.random.default_rng(seed)
    h = np.zeros((n, n))
    yy, xx = np.mgrid[0:n, 0:n]
    # pores: Gaussian dips, a little elongated, wrapped round the tile edges
    r0, r1 = d["pore_radius_px"]
    for _ in range(int(d["pores"])):
        cx, cy, r = rng.uniform(0, n), rng.uniform(0, n), rng.uniform(r0, r1)
        dx = (xx - cx + n / 2) % n - n / 2
        dy = (yy - cy + n / 2) % n - n / 2
        near = (np.abs(dx) < 4 * r) & (np.abs(dy) < 4 * r)
        h[near] -= np.exp(-(dx[near] ** 2 + (0.8 * dy[near]) ** 2) / (r * r)) * rng.uniform(0.6, 1.0)
    h /= max(1e-9, -h.min())

    def band(fx_scale: float, fy_scale: float, angle: float, f0: float, width: float) -> np.ndarray:
        f = np.fft.fftfreq(n)
        FX, FY = np.meshgrid(f, f)
        c, s = np.cos(angle), np.sin(angle)
        u, v = (c * FX + s * FY) * fx_scale, (-s * FX + c * FY) * fy_scale
        rad = np.sqrt(u * u + v * v)
        spec = np.exp(-((rad - f0) / width) ** 2)
        noise = np.fft.fft2(rng.standard_normal((n, n)))
        out = np.real(np.fft.ifft2(noise * spec))
        return out / np.abs(out).max()

    # fine lines: two families of thin, elongated ridges crossing at ~70°
    lines = sum(np.abs(band(1.0, 6.0, a, 0.06, 0.02)) for a in (0.35, 0.35 + 1.22))
    lines = -(lines / lines.max()) ** 2
    grain = band(1.0, 1.0, 0.0, 0.015, 0.012)
    h = h + d["lines"] * lines + d["grain"] * grain
    h = (h - h.mean()) / (np.abs(h - h.mean()).max() * 2.0)
    return np.clip(0.5 + h, 0, 1)


def main() -> None:
    cfg, bake_cfg = load_skin_config(), load_config()
    t = time.time()
    gnm = GNM.load()
    tris = skin_triangles(gnm)
    values = np.stack([vertex_values(gnm, cfg, c, tris) for c in CHANNELS], 1)
    ao_png = BAKE_DIR / "ao.png"
    if not ao_png.exists():
        raise SystemExit(f"{ao_png} is missing: run `uv run bake-ao` first (it keeps the AO for this step)")
    ao = read_grey(ao_png)
    size = ao.shape[0]
    ears = vertex_values(gnm, {"ears": {"ears": 1.0}, "smooth": cfg["smooth"]}, "ears", tris)
    gba = rasterize(gnm, tris, np.column_stack([values, ears]), size)
    gba, ear = gba[..., :3], gba[..., 3]
    ao = 1.0 - (1.0 - ao) * (1.0 - ear * (1.0 - cfg["ao"]["ear_strength"]))  # lighter AO in the ears
    for i, c in enumerate(CHANNELS):
        Image.fromarray((gba[..., i] * 255 + 0.5).astype(np.uint8)).save(BAKE_DIR / f"{c}.png")
    sizes = write_regions((ao * 255 + 0.5).astype(np.uint8), bake_cfg, gba)
    for name, nbytes in sizes.items():
        print(f"  web/public/textures/{name}: {nbytes / 1000:.0f} KB")
    h = detail_height(cfg)
    png = BAKE_DIR / "skin_detail.png"
    Image.fromarray((h * 255 + 0.5).astype(np.uint8)).save(png)
    nbytes = ktx2(png, TEXTURES_DIR / "skin_detail.ktx2", uastc=True)
    print(f"  web/public/textures/skin_detail.ktx2: {nbytes / 1000:.0f} KB (tile {cfg['detail']['tile_mm']} mm)")
    print(f"done in {time.time() - t:.1f} s (previews in {BAKE_DIR.relative_to(REPO_DIR)})")
