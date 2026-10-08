"""`uv run stubble`: stubble and five-o'clock shadow, drawn in the skin shader (MIT, generated here).

Each style is a coverage mask in the skin's UV layout (web/public/models/addons/facialHair/<id>.ktx2, R = 0…1). Its
outline comes from where the MakeHuman beards meet the skin (the "shape guides": full beard + moustache for a full
stubble, chin + moustache for a goatee): every GNM skin vertex within a few millimetres of a guide's roots is
covered, the edge fades out over the next few, lips and nostrils stay bare, and low-frequency noise makes it patchy
(denser on the chin and upper lip, thinner high on the cheeks). The shader (web/src/lib/skinShader.ts) lays a tileable
follicle texture (textures/stubble_detail.ktx2) over it and tints it with the facial hair colour, so it follows the
jaw and the lips through speech and emotions for free: it is the skin.
Styles and lengths: config/stubble.toml.
"""
from __future__ import annotations

import json
import time
import tomllib

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from .addon_fit import ADDONS_MODELS_DIR
from .bake import BAKE_DIR, TEXTURES_DIR, ktx2
from .gnm import PIPELINE_DIR, REPO_DIR
from .guides import beard_guide
from .head_context import head_context
from .skin_maps import rasterize, skin_triangles
from .surface import signed_distance

CONFIG = PIPELINE_DIR / "config" / "stubble.toml"
MODELS = ADDONS_MODELS_DIR / "facialHair"
LANDMARKS = REPO_DIR / "web" / "src" / "data" / "ageing.json"


def picker_order(ids: list[str]) -> list[str]:
    """The facial hair picker's order (beards.toml [picker].order: stubble, short beards, full beards, along the jaw,
    the chin, moustaches); styles it does not name follow, in the order given. Used by stubble.py and beard_strands.py,
    which both write the index."""
    order = tomllib.loads((PIPELINE_DIR / "config" / "beards.toml").read_text()).get("picker", {}).get("order", [])
    named = [i for i in order if i in ids]
    return named + [i for i in ids if i not in named]


def guide_roots(ctx, ids: list[str], within_m: float = 0.004) -> np.ndarray:
    """Points of the guide beards (MakeHuman beards as fitted on the head, guides.py) that lie on the skin (their roots),
    GNM template space."""
    pts = []
    for sid in ids:
        p = beard_guide(sid).astype(np.float64)
        pts.append(p[signed_distance(p, ctx.skin) < within_m])
    return np.vstack(pts)


def smooth(gnm, tris, val: np.ndarray, iterations: int) -> np.ndarray:
    from scipy.sparse import coo_matrix, diags

    V = len(val)
    f = gnm.triangles[tris]
    i = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]])
    j = np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    A = coo_matrix((np.ones(len(i)), (i, j)), shape=(V, V)).tocsr()
    A.data[:] = 1.0
    A = A + diags(np.ones(V))
    A = diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    for _ in range(iterations):
        val = A @ val
    return val


def noise3(p: np.ndarray, scale_m: float, seed: int) -> np.ndarray:
    """Smooth value noise in 0..1 at points p (metres), features about `scale_m` across."""
    rng = np.random.default_rng(seed)
    q = p / scale_m
    i = np.floor(q).astype(int)
    f = q - i
    f = f * f * (3 - 2 * f)
    table = rng.random((64, 64, 64))

    def h(dx, dy, dz):
        return table[(i[:, 0] + dx) % 64, (i[:, 1] + dy) % 64, (i[:, 2] + dz) % 64]

    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * h(dx, dy, dz)
    return out


def mask(gnm, tris, roots: np.ndarray, cfg: dict, keep=None, moustache: bool = True) -> np.ndarray:
    """(V,) coverage 0..1 per GNM vertex."""
    P = gnm.template
    d, _ = cKDTree(roots).query(P)
    inner, outer = cfg["edge_mm"][0] / 1000, cfg["edge_mm"][1] / 1000
    cov = np.clip((outer - d) / (outer - inner), 0, 1)
    cov = cov * cov * (3 - 2 * cov)
    if moustache:  # the MakeHuman moustache starts ~5 mm under the nose: grow it up to the nose's base
        L = json.loads(LANDMARKS.read_text())["landmarks"]
        al, sub_y, lip_y = np.array(L["alare_l"]), L["subnasale"][1], L["labrale_superius"][1]
        zone = (np.abs(P[:, 0]) < al[0] + 0.002) & (P[:, 1] > lip_y) & (P[:, 1] < sub_y + 0.002) & (P[:, 2] > 0.1)
        cov = np.maximum(cov, zone * np.clip((al[0] + 0.004 - np.abs(P[:, 0])) / 0.006, 0, 1))
    if keep is not None:
        cov *= keep
    for g in ("upper_lip", "lower_lip"):  # the lips themselves stay bare
        cov[gnm.vertex_groups[g] > 0.5] = 0
    cov = smooth(gnm, tris, cov, int(cfg["smooth"]))
    ears = smooth(gnm, tris, (gnm.vertex_groups["ears"] > 0.5).astype(float), 3)
    cov *= 1 - np.clip(ears * 2.0, 0, 1)  # the sideburn stops in front of the ear; the ear stays bare
    patch = noise3(P, cfg["patch_mm"] / 1000, 1) * 0.6 + noise3(P, cfg["patch_mm"] / 2500, 2) * 0.4
    cov *= np.clip(1 - cfg["patchiness"] + cfg["patchiness"] * 1.6 * patch, 0, 1)
    # the outline a barber would shave: the nose stays bare (the moustache stops at its base), and on the cheeks the
    # beard ends at a line from the sideburn down to just above the mouth corner
    L = json.loads(LANDMARKS.read_text())["landmarks"]
    mouth_y = L["cheilion_l"][1]
    nose = smooth(gnm, tris, (gnm.vertex_groups["nose_region"] > 0.5).astype(float), 2)
    base = L["subnasale"][1] + 0.0025  # the nose itself stays bare; the cut sits on the underside of its base, so the
    # mask's soft transition faces down, out of sight, and the moustache starts right under the nose
    cov *= 1 - np.clip(nose * 2.0, 0, 1) * np.clip((P[:, 1] - base) / 0.003, 0, 1)
    # beside the nose: the moustache's top edge curves down under the nostril wings (a parabola from just under the
    # nose in the middle), so no hair climbs up either side of the nose; it acts only near the nose, the beard's own
    # outline (from the guides) is kept everywhere else
    ax = np.abs(P[:, 0])
    sub_y, al = L["subnasale"][1], np.array(L["alare_l"])
    top_mid = sub_y - cfg["nose_gap_mm"] / 1000
    top_wing = sub_y - cfg["wing_gap_mm"] / 1000
    k = (top_mid - top_wing) / (al[0] + 0.002) ** 2
    top = top_mid - k * ax ** 2
    near = np.clip(1 - (ax - (al[0] + cfg["nose_reach_mm"][0] / 1000)) / (cfg["nose_reach_mm"][1] / 1000), 0, 1)
    near *= np.clip((P[:, 2] - 0.06) / 0.02, 0, 1) * np.clip((P[:, 1] - (mouth_y + 0.002)) / 0.004, 0, 1)  # face front, above the mouth
    cov *= 1 - near * (1 - np.clip((top - P[:, 1]) / 0.002 + 0.5, 0, 1))
    if "cheek_line_mm" in cfg:  # a groomed beard (the shell styles): a clean cheek line and neckline, softened
        corner_x, corner_y = L["cheilion_l"][0] + 0.004, mouth_y + cfg["cheek_line_mm"][0] / 1000
        side_x, side_y = 0.066, mouth_y + cfg["cheek_line_mm"][1] / 1000
        t = np.clip((ax - corner_x) / (side_x - corner_x), 0, 1)
        line_y = corner_y + (side_y - corner_y) * (t * (2 - t))  # bows out a little over the cheekbone
        cut = np.clip((line_y - P[:, 1]) / (cfg["edge_soft_mm"] / 1000) + 0.5, 0, 1)
        w = np.clip((ax - corner_x) / 0.012, 0, 1) * (P[:, 2] > 0.0)
        cov *= 1 - (w * w * (3 - 2 * w)) * (1 - cut)
        # neckline: from under the chin, curving up under the jaw towards the ear
        men = L["menton"]
        neck_y = men[1] - cfg["neckline_mm"][0] / 1000 + (cfg["neckline_mm"][1] / 1000) * np.clip(ax / 0.06, 0, 1) ** 2
        under = np.clip((men[2] + 0.01 - P[:, 2]) / 0.02, 0, 1)  # the underside of the jaw and the neck, not the chin's front
        cut = np.clip((P[:, 1] - neck_y) / (cfg["edge_soft_mm"] / 1000) + 0.5, 0, 1)
        cov *= 1 - under * (1 - cut)
    # denser on the chin and the upper lip, thinner high on the cheeks
    high = np.clip((P[:, 1] - (mouth_y + 0.02)) / 0.03, 0, 1) * (np.abs(P[:, 0]) > 0.025)
    cov *= 1 - cfg["cheek_thin"] * high
    for g in ("upper_lip", "lower_lip"):
        cov[gnm.vertex_groups[g] > 0.5] = 0
    return np.clip(cov, 0, 1)


def follicles(cfg: dict, seed: int = 9) -> np.ndarray:
    """Tileable (size²) 0..1: short dark dashes, the hair stubs seen from outside (pointing down), wrapped round the
    tile edges."""
    n = int(cfg["size"])
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n))
    yy, xx = np.mgrid[0:n, 0:n]
    for _ in range(int(cfg["count"])):
        cx, cy = rng.uniform(0, n), rng.uniform(0, n)
        r = rng.uniform(*cfg["radius_px"])
        ang = rng.normal(np.pi / 2, 0.35)
        dx = (xx - cx + n / 2) % n - n / 2
        dy = (yy - cy + n / 2) % n - n / 2
        near = (np.abs(dx) < 4 * r * cfg["stretch"]) & (np.abs(dy) < 4 * r * cfg["stretch"])
        u = dx[near] * np.cos(ang) + dy[near] * np.sin(ang)
        v = -dx[near] * np.sin(ang) + dy[near] * np.cos(ang)
        out[near] = np.maximum(out[near], np.exp(-(u / (r * cfg["stretch"])) ** 2 - (v / r) ** 2) * rng.uniform(0.6, 1.0))
    return out


def main() -> None:
    cfg = tomllib.loads(CONFIG.read_text())
    t0 = time.time()
    ctx = head_context()
    gnm = ctx.gnm
    tris = skin_triangles(gnm)
    ao_size = 1024  # 1 texel ≈ 0.4 mm on the face: the strip under the nose is only a couple of mm
    guides = {}
    index_path = MODELS / "index.json"
    index = json.loads(index_path.read_text())
    entries = {e["id"]: e for e in index["styles"]}
    for sid, st in cfg["style"].items():
        key = tuple(st["guides"])
        if key not in guides:
            guides[key] = guide_roots(ctx, list(key))
        keep = None
        if "keep_within_x_mm" in st:  # a goatee: only the middle of the chin and the upper lip
            x = np.abs(gnm.template[:, 0]) * 1000
            keep = np.clip((st["keep_within_x_mm"] + 6 - x) / 6, 0, 1)
        cov = mask(gnm, tris, guides[key], {**cfg["mask"], **st.get("mask", {})}, keep, "moustache" in key)
        img = rasterize(gnm, tris, cov[:, None], ao_size)[..., 0]
        BAKE_DIR.mkdir(parents=True, exist_ok=True)  # previews: only bake-ao made it before
        png = BAKE_DIR / f"stubble-{sid}.png"
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(png)
        n = ktx2(png, MODELS / f"{sid}.ktx2", uastc=False, quality=200)
        e = entries.get(sid, {})
        e.update({"id": sid, "label": st["label"], "file": f"addons/facialHair/{sid}.ktx2", "thumb": f"addons/facialHair/thumbs/{sid}.webp",
                  "vertices": 0, "triangles": 0, "bytes": n, "targets": 0, "author": "face-to-voice (generated)", "pack": "generated",
                  "natural": st.get("natural", "#2a1c14"), "lum": {"median": 0.05, "p98": 0.2}, "alphaCutoff": 0, "tint": True,
                  "kind": "stubble", "stubble": {"length": st["length"], "shadow": st["shadow"], "root": st.get("root", "#1a120c"), "tip": st.get("tip", "#3d2b1f")}})
        entries[sid] = e
        print(f"  {sid}: {n / 1000:.1f} KB, covered vertices {int((cov > 0.3).sum())}")
    index["styles"] = [entries[i] for i in picker_order(list(dict.fromkeys([e["id"] for e in index["styles"]] + list(cfg["style"]))))]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    for sid, st in cfg.get("beard", {}).items():  # short beards drawn as shells (lib/beardShells.ts): R = coverage, G = length
        key = tuple(st["guides"])
        if key not in guides:
            guides[key] = guide_roots(ctx, list(key))
        keep = None
        if "keep_within_x_mm" in st:
            x = np.abs(gnm.template[:, 0]) * 1000
            keep = np.clip((st["keep_within_x_mm"] + 6 - x) / 6, 0, 1)
        cov = mask(gnm, tris, guides[key], {**cfg["mask"], **st.get("mask", {})}, keep, "moustache" in key)
        L = json.loads(LANDMARKS.read_text())["landmarks"]
        y = gnm.template[:, 1]
        lower = np.clip((L["cheilion_l"][1] - y) / 0.04, 0, 1)  # longer on the chin and jaw than on the cheeks and lip
        length = np.clip(st.get("cheek_length", 0.65) + (1 - st.get("cheek_length", 0.65)) * lower, 0, 1)
        img = rasterize(gnm, tris, np.column_stack([cov, length, np.zeros_like(cov)]), 256)
        png = MODELS / f"{sid}.png"
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(png, optimize=True)
        n = png.stat().st_size
        e = entries.get(sid, {})
        e.update({"id": sid, "label": st["label"], "file": f"addons/facialHair/{sid}.png", "thumb": f"addons/facialHair/thumbs/{sid}.webp",
                  "vertices": 0, "triangles": 0, "bytes": n, "targets": 0, "author": "face-to-voice (generated)", "pack": "generated",
                  "natural": "#2a1c14", "lum": {"median": 0.05, "p98": 0.2}, "alphaCutoff": 0, "tint": True, "kind": "shells",
                  "shells": {"lengthMm": st["length_mm"], "gravity": st.get("gravity", 0.4), "density": st.get("density", 1.0),
                             "shadow": st.get("shadow", 0.5), "root": st.get("root", "#1a120c"), "tip": st.get("tip", "#4a3524")}})
        entries[sid] = e
        print(f"  {sid}: {n / 1000:.1f} KB (shells, {st['length_mm']} mm)")
    ours = set(cfg["style"]) | set(cfg.get("beard", {}))
    # dropped from this config: only our own kinds (the strand beards are generated too, by beard_strands.py)
    for e in [e for e in index["styles"] if e.get("kind") in ("stubble", "shells") and e["id"] not in ours]:
        for rel in (e["file"], e["thumb"]):
            (ADDONS_MODELS_DIR.parent / rel).unlink(missing_ok=True)
        entries.pop(e["id"], None)
        print("  removed", e["id"])
    index["styles"] = [entries[i] for i in picker_order([e["id"] for e in index["styles"] if e["id"] in entries] + [i for i in entries if i not in {e["id"] for e in index["styles"]}])]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    det = follicles(cfg["follicles"])
    png = BAKE_DIR / "stubble_detail.png"
    Image.fromarray((det * 255 + 0.5).astype(np.uint8)).save(png)
    n = ktx2(png, TEXTURES_DIR / "stubble_detail.ktx2", uastc=True)
    print(f"  textures/stubble_detail.ktx2: {n / 1000:.0f} KB; done in {time.time() - t0:.0f} s")
