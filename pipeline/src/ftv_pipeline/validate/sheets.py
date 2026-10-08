"""Contact sheets for the validation reports (pyvista, headless): one row per slider or face, a few views each."""
from __future__ import annotations

from pathlib import Path

from .. import semantic
from ..gnm import OUT_DIR
from ..parts import PARTS
from ..render import FRAMING, HeadRenderer

OUT = OUT_DIR / "validation"
SECTIONS = {"semantic": "Shape sliders", "identity": "Advanced: raw head, eyeball and teeth", "expression": "Advanced: raw mouth, lids, tongue"}


def renderer(gnm, size: int) -> HeadRenderer:
    """HeadRenderer without the cornea: it is a clear shell in the app, but pyvista would paint it opaque black."""
    r = HeadRenderer(gnm, size=size)
    for actor, part in zip(r._part_actors, PARTS):
        if part.material == "cornea":
            actor.SetVisibility(False)
    return r


def _frame(target: str, kind: str, sem_cfg: dict) -> tuple[tuple, float, float]:
    """(focal, distance, yaw) that shows what this slider changes."""
    if kind == "semantic":
        s = next((s for s in sem_cfg["slider"] if semantic.TARGET_PREFIX + s["id"] == target), {})
        focal, dist = semantic.FRAMES[s.get("frame", "face")]
        return focal, dist, semantic.VIEW_YAW[s.get("view", "front")]
    region = target.rsplit("_", 1)[0]
    if region == "head":
        return FRAMING["head"][0], FRAMING["head"][1] * 0.8, 30.0
    focal, dist = FRAMING.get(region, FRAMING["head"])
    if region == "lower_face_region":
        return focal, dist, 25.0
    return focal, dist, 0.0


def range_sheets(model, ranges: dict, size: int = 230) -> list[Path]:
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.load_default(size=15)
    bold = ImageFont.load_default(size=18)
    sem_cfg = semantic.load_config()
    r = renderer(model.gnm, size)
    tile = OUT / "_tile.png"
    paths = []
    for kind, title in SECTIONS.items():
        items = [(t, v) for t, v in ranges.items() if v["kind"] == kind]
        if not items:
            continue
        label_w = 260
        sheet = Image.new("RGB", (label_w + 3 * size, 34 + len(items) * size), "#1f1f1f")
        d = ImageDraw.Draw(sheet)
        for c, head in enumerate(["−end", "average", "+end"]):
            d.text((label_w + c * size + 10, 8), head, fill="white", font=bold)
        d.text((10, 8), title, fill="white", font=bold)
        for i, (target, v) in enumerate(items):
            focal, dist, yaw = _frame(target, kind, sem_cfg)
            y0 = 34 + i * size
            for c, x in enumerate((v["min"], 0.0, v["max"])):
                w = model.vector(model.expand({target: x}))
                r.set_positions(model.positions(w))
                r.look(focal, dist, yaw)
                r.screenshot(tile)
                sheet.paste(Image.open(tile).convert("RGB"), (label_w + c * size, y0))
            s = v["sides"]
            lines = [v["name"], f"weights {v['min']:+.2f} / {v['max']:+.2f}", f"− {s['min']['limit']}"[:34], f"+ {s['max']['limit']}"[:34]]
            if v["own"]:
                oz = [s[k]["own_z"] for k in ("min", "max")]
                lines.append(f"own z {oz[0]:+.1f} / {oz[1]:+.1f}")
            lines = [t.replace("σ", " sd") for t in lines]  # the default PIL font has no σ
            for j, t in enumerate(lines):
                d.text((10, y0 + 12 + j * 22), t, fill="white" if j == 0 else "#cfcfcf", font=bold if j == 0 else font)
        path = OUT / f"ranges_{kind}.png"
        sheet.save(path)
        paths.append(path)
    tile.unlink(missing_ok=True)
    return paths
