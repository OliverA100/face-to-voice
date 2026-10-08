"""`uv run propose-visemes`: turn Claude's per-slider hints into starting viseme + blink presets.

Reads web/src/data/sliders.json (written by `name-sliders`) and writes web/src/data/visemes.json:

  visemes: { "aa": { "lower_face_region_000": -0.9, ... }, ... }   # morph weights per viseme
  roles:   { "blinkLeft": {...}, "blinkRight": {...}, "jawOpen": {...}, "pupils": {...} }

Every value is a morph weight (-1..1). These are only seeds: the web app's /dev/visemes page is
where the shapes get tuned by eye and written back to this file.
"""
from __future__ import annotations

import json

from .gnm import REPO_DIR
from .name_sliders import SLIDERS_JSON

VISEMES_JSON = REPO_DIR / "web" / "src" / "data" / "visemes.json"
VISEME_ORDER = ["pp", "ff", "th", "dd", "ss", "aa", "e", "i", "o", "u"]
STRENGTH = {"weak": 0.45, "medium": 0.75, "strong": 1.0}
STRENGTH_RANK = {"strong": 0, "medium": 1, "weak": 2}
TOP_HINTS = 3  # hints kept per viseme; more than that piles up unrelated PCA modes
MAX_TOTAL_WEIGHT = 2.0  # cap on the sum of |weights| in one preset


def _index(target: str) -> int:
    """Component index inside its region (lower index = more variance = stronger evidence)."""
    tail = target.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else -1


def _sign(direction: str) -> float:
    return 1.0 if direction == "positive" else -1.0


def propose(sliders: list[dict]) -> dict:
    # Visemes: collect every hint, keep the strongest few per viseme.
    hints: dict[str, list[tuple[int, int, str, float]]] = {v: [] for v in VISEME_ORDER}
    for s in sliders:
        for h in (s.get("ai") or {}).get("visemeHints", []):
            hints[h["viseme"]].append((STRENGTH_RANK[h["strength"]], _index(s["target"]), s["target"],
                                       round(_sign(h["direction"]) * STRENGTH[h["strength"]], 2)))
    visemes = {}
    for v, lst in hints.items():
        lst.sort()
        chosen = {target: w for _, _, target, w in lst[:TOP_HINTS]}
        total = sum(abs(w) for w in chosen.values())
        if total > MAX_TOTAL_WEIGHT:  # several strong modes together over-drive the mouth
            chosen = {t: round(w * MAX_TOTAL_WEIGHT / total, 2) for t, w in chosen.items()}
        visemes[v] = chosen

    # Roles: one component each, chosen by confidence then by variance rank.
    def pick(candidates: list[tuple[int, int, str, float]]) -> dict[str, float]:
        if not candidates:
            return {}
        candidates.sort()
        _, _, target, w = candidates[0]
        return {target: w}

    conf_rank = {"high": 0, "medium": 1, "low": 2}
    blink = {"left": [], "right": []}
    jaw = []
    pupils = {}
    for s in sliders:
        ai = s.get("ai") or {}
        conf = conf_rank.get(ai.get("confidence", "low"), 2)
        if ai.get("eyelidCloseDirection") in ("positive", "negative"):
            side = "left" if s["region"].startswith("left") else "right" if s["region"].startswith("right") else None
            if side:
                blink[side].append((conf, _index(s["target"]), s["target"], _sign(ai["eyelidCloseDirection"])))
        if s["region"] == "lower_face_region" and ai.get("openDirection") in ("positive", "negative") and ai.get("mouthRelevance") == "high":
            jaw.append((conf, _index(s["target"]), s["target"], _sign(ai["openDirection"])))
        if s["region"] == "pupils":
            pupils[s["target"]] = 1.0
    roles = {"blinkLeft": pick(blink["left"]), "blinkRight": pick(blink["right"]), "jawOpen": pick(jaw), "pupils": pupils}
    return {"visemes": visemes, "roles": roles}


def sheet_main() -> None:
    """`uv run viseme-sheet`: render every viseme/role preset to out/visemes_sheet.png."""
    from PIL import Image, ImageDraw

    from .export_glb import MANIFEST
    from .gnm import GNM, OUT_DIR
    from .render import HeadRenderer

    doc = json.loads(VISEMES_JSON.read_text())
    scales = {t["name"]: float(t["scale"]) for t in json.loads(MANIFEST.read_text())["targets"]}
    presets = {**{f"viseme {v}": w for v, w in doc["visemes"].items()}, **{f"role {r}": w for r, w in doc["roles"].items()}}
    renderer = HeadRenderer(GNM.load(), size=392)
    cell, cols = 392, 5
    rows = -(-len(presets) // cols)
    sheet = Image.new("RGB", (cols * cell, rows * cell), "black")
    draw = ImageDraw.Draw(sheet)
    for i, (label, weights) in enumerate(presets.items()):
        renderer.set_shape({k: w * scales[k] for k, w in weights.items()})
        renderer.frame("lower_face_region" if label.startswith("viseme") or "jaw" in label else "eyes", "front")
        path = OUT_DIR / "renders" / "_presets" / f"{label.replace(' ', '_')}.png"
        renderer.screenshot(path)
        sheet.paste(Image.open(path), ((i % cols) * cell, (i // cols) * cell))
        draw.text(((i % cols) * cell + 8, (i // cols) * cell + 8), f"{label}  ({len(weights)} comps)", fill="white")
    out = OUT_DIR / "visemes_sheet.png"
    sheet.save(out)
    print(f"wrote {out}")


def main() -> None:
    doc = json.loads(SLIDERS_JSON.read_text())
    out = propose(doc["sliders"])
    existing = json.loads(VISEMES_JSON.read_text()) if VISEMES_JSON.exists() else {}
    if existing.get("tuned"):
        print(f"{VISEMES_JSON.name} is marked as hand-tuned (\"tuned\": true); not overwriting. "
              "Delete that flag to regenerate the seeds.")
        return
    result = {
        "version": 1,
        "tuned": False,
        "note": "Seed values from Claude's slider hints (propose_visemes.py). Tune in the web app's /dev/visemes page, which writes back here and sets tuned=true.",
        **out,
    }
    VISEMES_JSON.write_text(json.dumps(result, indent=2) + "\n")
    empty = [v for v, w in out["visemes"].items() if not w]
    print(f"wrote {VISEMES_JSON.relative_to(REPO_DIR)}: "
          f"{sum(1 for v in out['visemes'].values() if v)}/{len(VISEME_ORDER)} visemes seeded"
          + (f" (no hints for: {', '.join(empty)})" if empty else "")
          + "; roles: " + ", ".join(f"{k}={len(v)}" for k, v in out["roles"].items()))


if __name__ == "__main__":
    main()
