"""Emotions: happy, sad, angry, … as GNM expression vectors, split into an upper and a lower face part.

Where the numbers come from (config/emotions.json):
  "labels"    GNM's ExpressionSampler, averaged per label (20 labels: HAPPY, SURPRISE, CORNERS_DOWN, …).
              Written by the one-off TensorFlow tool in tools/gnm_sampler; this module never needs TF.
  "emotions"  our recipes, hand-editable. GNM has no sad, angry or fear label, so each emotion is built
              per face part from:
                labels      weighted label means   {"HAPPY": 1.0}  (1.0 = one typical sample's strength)
                components  extra σ on single GNM components  {"left_eye_region_003": 0.5}
                goals       millimetre targets solved on that part's components, e.g.
                            {"inner_brow_raise": 3.0, "brow_knit": -2.5}; see MEASURES below
Parts (exact, because GNM is linear and the coefficient sets are disjoint):
  upper = left_eye_region_* + right_eye_region_* + pupils_*   (brows, lids, eyes)
  lower = lower_face_region_* + tongue_*                        (mouth, cheeks, jaw)
Each part becomes one morph target, emo_<id>_upper / emo_<id>_lower, with weight 1.0 = the full recipe.
While speaking the web app keeps the upper part and turns the lower part down, so visemes stay readable.

    uv run emotions [--labels-sheet]     resolve the recipes, write out/emotions/{report.md, sheet.png}
"""
from __future__ import annotations

import argparse
import json
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import semantic
from .export_glb import vertex_normals
from .gnm import GNM, OUT_DIR, PIPELINE_DIR

EMOTIONS_JSON = PIPELINE_DIR / "config" / "emotions.json"
EMO_OUT = OUT_DIR / "emotions"
TARGET_PREFIX = "emo_"
PARTS = {
    "upper": ("left_eye_region", "right_eye_region", "pupils"),
    "lower": ("lower_face_region", "tongue"),
}
GOAL_WEIGHT = 400.0  # how hard goals are met (vs. the N(0, 1) prior on the coefficients), per mm²
HOLD_WEIGHT = 100.0  # measurements that are NOT goals are held where the labels put them (lids don't collapse)
GOAL_COMPONENTS = 24  # goals are solved on the first N (smoothest) components of each region only: the
                      # high-order modes reach millimetre targets with many large σ and make creases
GOAL_MAX_SIGMA = 4.0  # cap on the Mahalanobis length of the solved extra (goals may then fall short)

# Expression measurements for recipe goals, on the landmarks of config/semantic_sliders.toml.
# "{s}" is expanded to _l and _r: a goal on a sided measure is applied to both eyes the same way.
MEASURES = {
    "inner_brow_raise": {"type": "axis", "axis": "y", "pairs": [["brow_inner{s}", "nasion"]]},
    "outer_brow_raise": {"type": "axis", "axis": "y", "pairs": [["brow_outer{s}", "nasion"]]},
    "brow_raise": {"type": "axis", "axis": "y", "pairs": [["brow{s}", "nasion"]]},
    "lid_aperture": {"type": "distance", "pairs": [["lid_upper{s}", "lid_lower{s}"]]},
    "brow_knit": {"type": "distance", "pairs": [["brow_inner_l", "brow_inner_r"]]},
    "lower_lid_raise": {"type": "axis", "axis": "y", "pairs": [["lid_lower{s}", "canthi{s}"]]},  # cheeks push the lower lid up
    # mouth (lower part)
    "corner_raise": {"type": "axis", "axis": "y", "pairs": [["cheilion_l", "subnasale"], ["cheilion_r", "subnasale"]]},
    "lip_part": {"type": "axis", "axis": "y", "pairs": [["stomion_upper", "stomion_lower"]]},  # gap between the lips
    "mouth_stretch": {"type": "distance", "pairs": [["cheilion_l", "cheilion_r"]]},
    "jaw_open": {"type": "axis", "axis": "y", "pairs": [["subnasale", "menton"]]},
    "upper_lip_raise": {"type": "axis", "axis": "y", "pairs": [["labrale_superius", "subnasale"]]},
    "lip_thickness": {"type": "axis", "axis": "y", "pairs": [["labrale_superius", "stomion_upper"], ["stomion_lower", "labrale_inferius"]]},
    "lip_protrude": {"type": "axis", "axis": "z", "pairs": [["labrale_superius", "subnasale"], ["labrale_inferius", "subnasale"]]},
    "mouth_shift": {"type": "axis", "axis": "x", "pairs": [["cheilion_l", "nasion"], ["cheilion_r", "nasion"]]},
    # one side only (a smirk, a raised brow, a wink): taken into a solve only by a recipe that names them, so they
    # never constrain the symmetric recipes
    **{f"{m}_{side}": {"type": t, **({"axis": ax} if ax else {}), "pairs": [[a.replace("{s}", "_" + side), b.replace("{s}", "_" + side)]]}
       for m, t, ax, a, b in (("inner_brow_raise", "axis", "y", "brow_inner{s}", "nasion"), ("outer_brow_raise", "axis", "y", "brow_outer{s}", "nasion"),
                              ("brow_raise", "axis", "y", "brow{s}", "nasion"), ("lid_aperture", "distance", None, "lid_upper{s}", "lid_lower{s}"),
                              ("lower_lid_raise", "axis", "y", "lid_lower{s}", "canthi{s}"), ("corner_raise", "axis", "y", "cheilion{s}", "subnasale"))
       for side in ("l", "r")},
}
ONE_SIDED = {k for k in MEASURES if k.endswith(("_l", "_r"))}


def load_doc(path: Path = EMOTIONS_JSON) -> dict:
    doc = json.loads(path.read_text())
    if "labels" not in doc:
        raise SystemExit("emotions.json has no sampler labels yet: cd tools/gnm_sampler && uv run sample-emotions")
    return doc


def part_mask(gnm: GNM, part: str) -> np.ndarray:
    return np.array([gnm.region_of(n) in PARTS[part] for n in gnm.expression_names])


def label_vector(doc: dict, name: str) -> np.ndarray:
    """A label's mean expression, rescaled to one typical sample's strength (the plain mean is washed out)."""
    lab = doc["labels"][name]
    v = np.asarray(lab["mean"], np.float64)
    if doc.get("strength", "sample") == "sample":
        v *= lab["median_sample_norm"] / max(lab["mean_norm"], 1e-9)
    return v


@dataclass
class Resolved:
    id: str
    label: str
    upper: np.ndarray  # (383,) σ, zero outside the upper part
    lower: np.ndarray  # (383,) σ, zero outside the lower part
    goals: dict  # measure -> (target mm, reached mm)


class GoalSolver:
    """Linearised expression measurements (mm per σ) over one part's components."""

    def __init__(self, gnm: GNM):
        cfg = semantic.load_config()
        lm = semantic.config_landmarks(cfg)
        normals = vertex_normals(gnm.template, gnm.triangles)
        self.gnm = gnm
        self.rows: dict[str, list[np.ndarray]] = {}
        self.measures: dict[str, list] = {}
        E = gnm.expression_basis.astype(np.float64) * 1000.0  # (383, V, 3) mm per σ
        for name, spec in MEASURES.items():
            sides = ("_l", "_r") if "{s}" in json.dumps(spec) else ("",)
            for s in sides:
                sided = json.loads(json.dumps(spec).replace("{s}", s))
                m = semantic.build_measure(sided, lm, gnm, normals)
                self.measures.setdefault(name, []).append(m)
                self.rows.setdefault(name, []).append(np.tensordot(E, m.grad / 1000.0, axes=([1, 2], [0, 1])))

    def change(self, name: str, coeffs: np.ndarray) -> float:
        """Mean change of a measurement (mm, both sides averaged) for an expression vector — exact geometry."""
        d = np.tensordot(coeffs.astype(np.float32), self.gnm.expression_basis, axes=1)
        T = self.gnm.template
        return float(np.mean([m.value(T + d) - m.value(T) for m in self.measures[name]]))

    def solve(self, goals: dict, base: np.ndarray, mask: np.ndarray, max_sigma: float, free: tuple[str, ...],
              allowed: np.ndarray) -> np.ndarray:
        """Extra coefficients on `mask` & `allowed` so that base + extra reaches the goal changes.

        Least squares with the N(0, 1) prior; the other measurements are held at what `base` gives them, except the
        `free` ones (a jaw that opens may part the lips); the extra is capped at max_sigma."""
        if not goals:
            return np.zeros_like(base)
        for name in (*goals, *free):
            if name not in self.rows:
                raise KeyError(f"unknown measure {name!r}; choose from {sorted(self.rows)}")
        use = mask & allowed
        rows, t, w = [], [], []
        for name, rs in self.rows.items():
            if name in free and name not in goals:
                continue
            if name in ONE_SIDED and name not in goals:
                continue  # one-sided measures only count where a recipe asks for them
            for row in rs:
                rows.append(row[use])
                if name in goals:
                    t.append(float(goals[name]) - float(row @ base))
                    w.append(GOAL_WEIGHT)
                else:
                    t.append(0.0)
                    w.append(HOLD_WEIGHT)
        A, t, W = np.array(rows), np.array(t), np.diag(w)
        x = np.linalg.solve(A.T @ W @ A + np.eye(use.sum()), A.T @ W @ t)
        length = float(np.linalg.norm(x))
        if length > max_sigma:
            x *= max_sigma / length
        out = np.zeros_like(base)
        out[use] = x
        return out


def resolve(gnm: GNM, doc: dict, solver: GoalSolver | None = None) -> list[Resolved]:
    solver = solver or GoalSolver(gnm)
    names = gnm.expression_names
    out = []
    for eid, rec in doc["emotions"].items():
        parts = {}
        reached = {}
        for part in ("upper", "lower"):
            spec = rec.get(part, {})
            mask = part_mask(gnm, part)
            v = np.zeros(len(names))
            for lab, w in spec.get("labels", {}).items():
                if lab not in doc["labels"]:
                    raise KeyError(f"{eid}.{part}: unknown label {lab!r}")
                v += float(w) * label_vector(doc, lab)
            for comp, w in spec.get("components", {}).items():
                v[names.index(comp)] += float(w)
            v *= mask  # keep only this part's coefficients: the split is exact
            n_comp = int(spec.get("goal_components", GOAL_COMPONENTS))  # more = finer shapes (e.g. an oblique sad brow)
            allowed = np.array([n.rsplit("_", 1)[1].isdigit() and int(n.rsplit("_", 1)[1]) < n_comp for n in names])
            v += solver.solve(spec.get("goals", {}), v, mask, float(spec.get("max_sigma", GOAL_MAX_SIGMA)), tuple(spec.get("free", [])), allowed)
            parts[part] = v
            for g, target in spec.get("goals", {}).items():
                reached[f"{part}.{g}"] = (float(target), solver.change(g, v))
        out.append(Resolved(eid, rec.get("label", eid.title()), parts["upper"], parts["lower"], reached))
    return out


# --- fine-tune controls (jaw open, smile, brows …): runtime mixes of the SHIPPED expression targets ----------------

CONTROLS_TOML = PIPELINE_DIR / "config" / "expression_controls.toml"
CONTROL_PREFIX = "fx_"
CONTROL_MAX_SIGMA = 6.0  # default cap on a control's direction (Mahalanobis length; `max_sigma` per control)


def load_controls(path: Path = CONTROLS_TOML) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def control_ends(c: dict) -> tuple[float, float]:
    """A control's (min, max) as configured, before slider_breaks.json pulls them in."""
    return float(c.get("min", -1.0)), float(c.get("max", 1.0))


def shipped_expression(gnm: GNM) -> tuple[list[str], dict[str, float]]:
    """The expression components head.glb ships, and the σ per morph weight 1.0 of each."""
    from .export_glb import load_config as load_components

    cfg = load_components()
    sigma = float(cfg["export"]["sigma_scale"])
    overrides = cfg["export"].get("scale_overrides", {})
    names = list(cfg["expression"]["components"])
    return names, {n: float(overrides.get(n, sigma)) for n in names}


def solve_controls(gnm: GNM, solver: GoalSolver | None = None) -> list[dict]:
    """Every control in config/expression_controls.toml as {id, name, …, combo | target, reached}.

    A control's direction is solved like an emotion goal (measurement goals at +1, the other measurements held,
    the prior), but only on the components head.glb ships, so the web app applies it as a mix of existing morph
    targets: exact, and no extra bytes."""
    solver = solver or GoalSolver(gnm)
    cfg = load_controls()
    shipped, scale = shipped_expression(gnm)
    names = gnm.expression_names
    allowed = np.array([n in shipped for n in names])
    out = []
    for c in cfg["control"]:
        entry = {k: c[k] for k in ("id", "name", "group", "low", "high") if k in c}
        entry["min"], entry["max"] = control_ends(c)
        if "target" in c:  # a raw shipped target as it is (pupil size)
            entry["target"] = c["target"]
            out.append(entry)
            continue
        mask = part_mask(gnm, c["part"])
        v = solver.solve(c["goals"], np.zeros(len(names)), mask, float(c.get("max_sigma", CONTROL_MAX_SIGMA)), tuple(c.get("free", [])), allowed)
        entry["combo"] = {n: round(float(v[i]) / scale[n], 5) for i, n in enumerate(names) if allowed[i] and abs(v[i]) > 1e-4}
        entry["reached"] = {g: (float(t), round(solver.change(g, v), 2)) for g, t in c["goals"].items()}
        if "goals_neg" in c:  # the -1 side has its own direction; comboNeg is applied as weight × |value|
            vn = solver.solve(c["goals_neg"], np.zeros(len(names)), mask, float(c.get("max_sigma", CONTROL_MAX_SIGMA)), tuple(c.get("free_neg", [])), allowed)
            entry["comboNeg"] = {n: round(float(vn[i]) / scale[n], 5) for i, n in enumerate(names) if allowed[i] and abs(vn[i]) > 1e-4}
            entry["reached_neg"] = {g: (float(t), round(solver.change(g, vn), 2)) for g, t in c["goals_neg"].items()}
            entry["vector_neg"] = vn
        entry["sigma"] = round(float(np.linalg.norm(v)), 2)
        entry["vector"] = v
        out.append(entry)
    return out


def emotion_targets(gnm: GNM, doc: dict | None = None) -> list[tuple[str, np.ndarray]]:
    """[(emo_<id>_<part>, (V,3) delta at weight 1.0)] for export_glb."""
    doc = doc or load_doc()
    out = []
    for r in resolve(gnm, doc):
        for part in ("upper", "lower"):
            coeffs = getattr(r, part).astype(np.float32)
            out.append((f"{TARGET_PREFIX}{r.id}_{part}", np.tensordot(coeffs, gnm.expression_basis, axes=1)))
    return out


# --- report + sheets ------------------------------------------------------------------------------


def label_table(gnm: GNM, doc: dict) -> str:
    up, lo = part_mask(gnm, "upper"), part_mask(gnm, "lower")
    lines = ["| GNM label | strength σ (one sample) | mean σ | upper-face share | lower-face share |", "|---|---:|---:|---:|---:|"]
    for name, lab in doc["labels"].items():
        v = label_vector(doc, name)
        e_up, e_lo = float(np.sum(v[up] ** 2)), float(np.sum(v[lo] ** 2))
        tot = max(e_up + e_lo, 1e-12)
        lines.append(f"| {name} | {lab['median_sample_norm']:.2f} | {lab['mean_norm']:.2f} | {e_up / tot * 100:.0f}% | {e_lo / tot * 100:.0f}% |")
    return "\n".join(lines)


def write_report(gnm: GNM, doc: dict, res: list[Resolved], path: Path) -> str:
    lines = ["# Emotions", "", f"GNM ExpressionSampler labels ({len(doc['labels'])}), commit {doc['sampler']['commit'][:8]}, "
             f"{doc['sampler']['samples_per_label']} samples each:", "", label_table(gnm, doc), "",
             "## Resolved emotions (weight 1.0)", "",
             "| emotion | upper σ | lower σ | max upper mm | max lower mm | goals (target → reached, mm) |", "|---|---:|---:|---:|---:|---|"]
    for r in res:
        du = np.linalg.norm(np.tensordot(r.upper.astype(np.float32), gnm.expression_basis, axes=1), axis=1).max() * 1000
        dl = np.linalg.norm(np.tensordot(r.lower.astype(np.float32), gnm.expression_basis, axes=1), axis=1).max() * 1000
        goals = ", ".join(f"{k} {t:+.1f}→{v:+.1f}" for k, (t, v) in r.goals.items()) or "—"
        lines.append(f"| {r.label} | {np.linalg.norm(r.upper):.2f} | {np.linalg.norm(r.lower):.2f} | {du:.1f} | {dl:.1f} | {goals} |")
    text = "\n".join(lines) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text


FRAMES = {"face": ((0.0, 0.262, 0.09), 0.40)}  # face only, tighter than semantic.FRAMES["face"]


def _tile(r, positions: np.ndarray, frame: str, yaw: float):
    from PIL import Image

    r.set_positions(positions)
    focal, dist = FRAMES[frame]
    r.look(focal, dist, yaw)
    tmp = EMO_OUT / "_tile.png"
    r.screenshot(tmp)
    img = Image.open(tmp).convert("RGB")
    tmp.unlink()
    return img


def render_sheet(gnm: GNM, res: list[Resolved], path: Path, size: int = 300) -> None:
    """Rows = emotions; columns = 0.5, 1.0 (front), 1.0 (¾), upper part only, lower part only."""
    from PIL import Image, ImageDraw

    r = semantic.head_renderer(gnm, size)
    cols = ["0.5", "1.0", "1.0 three-quarter", "upper part only", "lower part only"]
    label_w = 170
    sheet = Image.new("RGB", (label_w + len(cols) * size, 34 + (len(res) + 1) * size), "#1f1f1f")
    draw = ImageDraw.Draw(sheet)
    for c, head in enumerate(cols):
        draw.text((label_w + c * size + 10, 8), head, fill="white", font=semantic.label_font(17))
    E = gnm.expression_basis
    rows = [("Neutral", np.zeros(len(gnm.expression_names)), np.zeros(len(gnm.expression_names)))] + [(x.label, x.upper, x.lower) for x in res]
    for k, (label, up, lo) in enumerate(rows):
        du = np.tensordot(up.astype(np.float32), E, axes=1)
        dl = np.tensordot(lo.astype(np.float32), E, axes=1)
        T = gnm.template
        tiles = [(T + 0.5 * (du + dl), 0.0), (T + du + dl, 0.0), (T + du + dl, 35.0), (T + du, 0.0), (T + dl, 0.0)]
        y0 = 34 + k * size
        for c, (pos, yaw) in enumerate(tiles):
            sheet.paste(_tile(r, pos, "face", yaw), (label_w + c * size, y0))
        draw.text((14, y0 + 14), label, fill="white", font=semantic.label_font(22))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def render_controls(gnm: GNM, controls: list[dict], path: Path, size: int = 220) -> None:
    """One row per fine-tune control: min / 0 / max."""
    from PIL import Image, ImageDraw

    r = semantic.head_renderer(gnm, size)
    rows = [c for c in controls if "vector" in c]
    label_w = 190
    sheet = Image.new("RGB", (label_w + 3 * size, len(rows) * size), "#1f1f1f")
    draw = ImageDraw.Draw(sheet)
    for k, c in enumerate(rows):
        d = np.tensordot(c["vector"].astype(np.float32), gnm.expression_basis, axes=1)
        dn = np.tensordot(c["vector_neg"].astype(np.float32), gnm.expression_basis, axes=1) if "vector_neg" in c else None
        for col, w in enumerate((c["min"], 0.0, c["max"])):
            pos = gnm.template + (np.float32(-w) * dn if (w < 0 and dn is not None) else np.float32(w) * d)
            sheet.paste(_tile(r, pos, "face", 0.0), (label_w + col * size, k * size))
        draw.text((10, k * size + 10), c["name"].replace("↔", "<->"), fill="white", font=semantic.label_font(17))
        draw.text((10, k * size + 34), f"{c['min']:+g}: {c['low']}", fill="#cfcfcf", font=semantic.label_font(13))
        draw.text((10, k * size + 52), f"{c['max']:+g}: {c['high']}", fill="#cfcfcf", font=semantic.label_font(13))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def render_labels_sheet(gnm: GNM, doc: dict, path: Path, size: int = 260) -> None:
    """All GNM sampler labels at one typical sample's strength (reference for writing recipes)."""
    from PIL import Image, ImageDraw

    r = semantic.head_renderer(gnm, size)
    names = list(doc["labels"])
    cols = 5
    sheet = Image.new("RGB", (cols * size, ((len(names) + cols - 1) // cols) * size), "#1f1f1f")
    draw = ImageDraw.Draw(sheet)
    for i, n in enumerate(names):
        d = np.tensordot(label_vector(doc, n).astype(np.float32), gnm.expression_basis, axes=1)
        x0, y0 = (i % cols) * size, (i // cols) * size
        sheet.paste(_tile(r, gnm.template + d, "face", 0.0), (x0, y0))
        draw.text((x0 + 8, y0 + 6), n, fill="white", font=semantic.label_font(16))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--labels-sheet", action="store_true", help="also render every GNM label (out/emotions/labels.png)")
    p.add_argument("--no-sheet", action="store_true")
    p.add_argument("--controls", action="store_true", help="also report the fine-tune controls and render out/emotions/controls.png")
    p.add_argument("--size", type=int, default=300)
    args = p.parse_args(argv)
    t0 = time.time()
    gnm = GNM.load()
    doc = load_doc()
    res = resolve(gnm, doc)
    print(write_report(gnm, doc, res, EMO_OUT / "report.md"))
    print(f"resolved {len(res)} emotions in {time.time() - t0:.1f} s")
    if args.labels_sheet:
        render_labels_sheet(gnm, doc, EMO_OUT / "labels.png")
        print(f"-> {EMO_OUT / 'labels.png'}")
    if not args.no_sheet:
        render_sheet(gnm, res, EMO_OUT / "sheet.png", args.size)
        print(f"-> {EMO_OUT / 'sheet.png'}")
    if args.controls:
        controls = solve_controls(gnm)
        for c in controls:
            if "combo" in c:
                reached = ", ".join(f"{g} {t:+.1f}→{v:+.1f}" for g, (t, v) in {**c["reached"], **{f"(-1) {k}": x for k, x in c.get("reached_neg", {}).items()}}.items())
                print(f"  {c['name']:22s} {len(c['combo']):2d} targets  σ {c['sigma']:4.1f}  {reached}")
        render_controls(gnm, controls, EMO_OUT / "controls.png", 220)
        print(f"-> {EMO_OUT / 'controls.png'}")
