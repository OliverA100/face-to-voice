"""`uv run name-sliders`: ask Claude to name every raw GNM slider (identity and expression targets) from its renders.

Each component is sent as three (or six, with the quarter view) labelled images at slider
min / mid / max plus a short instruction; Claude answers with a validated JSON object (the
`SliderName` schema below) via structured outputs. Each answer is merged into the `ai` block of
that slider's entry in web/src/data/sliders.json (`ai.rawName` is Claude's name); everything else
in the file stays. The panel numbers raw sliders per area (sliders_json.py), so a run is followed
by `uv run update-sliders` (or `uv run export`) only when it adds a slider the file did not list.

Examples:
  uv run name-sliders --only head_000,lower_face_region_000 --pilot     # try 2 components, write out/pilot_<model>.json
  uv run name-sliders --model claude-sonnet-5 --pilot --only ...          # compare models
  uv run name-sliders                                                    # full run -> web/src/data/sliders.json
"""
from __future__ import annotations

import argparse
import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ValidationError

from .claude import DEFAULT_MODEL, Usage, client
from .export_glb import MANIFEST, load_config
from .gnm import OUT_DIR, REPO_DIR
from .render import RENDERS_DIR, SAMPLES, render_targets, sample_weights

SLIDERS_JSON = REPO_DIR / "web" / "src" / "data" / "sliders.json"
# The manifest kinds named here: the raw GNM components. Semantic, emotion, control and pose entries are generated from
# their configs by sliders_json.py.
RAW_KINDS = ("identity", "expression")

# --- what Claude must answer ----------------------------------------------------------------

Group = Literal[
    "head_shape", "forehead_brows", "eyes", "nose", "cheeks", "mouth_lips", "jaw_chin", "ears",
    "teeth", "tongue", "other",
]
Viseme = Literal["pp", "ff", "th", "dd", "ss", "aa", "e", "i", "o", "u"]


class VisemeHint(BaseModel):
    viseme: Viseme
    direction: Literal["positive", "negative"]  # which slider end resembles the viseme
    strength: Literal["weak", "medium", "strong"]


class SliderName(BaseModel):
    name: str  # 2-3 words, sentence case, e.g. "Jaw open"
    description: str  # one sentence
    low_label: str  # what the slider minimum looks like, 1-3 words
    high_label: str  # what the slider maximum looks like, 1-3 words
    group: Group
    mouth_relevance: Literal["none", "low", "high"]
    open_direction: Literal["positive", "negative", "none"]  # which end opens the jaw / mouth
    eyelid_close_direction: Literal["positive", "negative", "none"]  # which end closes the eyelids
    viseme_hints: list[VisemeHint]
    confidence: Literal["low", "medium", "high"]


SYSTEM_PROMPT = """You name sliders for a browser-based 3D face builder.

The images show a synthetic head from Google's GNM statistical head model. It is not a real person: it is the model's average head with ONE shape component pushed to its extremes. Each request shows the same component at the slider minimum, the neutral middle, and the slider maximum (normally -3, 0 and +3 standard deviations), from the front and sometimes also from a three-quarter view. Teeth and tongue components are shown with the jaw opened so the part is visible; ignore that opening, it is the same in all three images.

Your job is to say, in plain words a designer would print on a slider, what this component changes.

Rules:
- name: 2-3 words, sentence case, no anatomy jargon. Name the strongest visual effect ("Jaw open", "Nose width", "Brow height", "Lip corners up").
- low_label / high_label: 1-3 words for what the minimum and maximum look like ("narrow" / "wide", "closed" / "open").
- description: one sentence. If the component changes several things, name the strongest in `name` and mention the others here.
- group: the face area it mainly affects.
- mouth_relevance: how much the mouth shape changes (jaw, lips, teeth, tongue). high = the mouth is the main effect.
- open_direction: which slider end opens the jaw or parts the lips; "none" if the mouth does not open.
- eyelid_close_direction: which slider end closes the eyelids (a blink); "none" if the eyelids barely move.
- viseme_hints: only for components that reshape the mouth; list which speech mouth shapes an end of this slider resembles. Visemes: pp = lips pressed together (p, b, m); ff = lower lip under the upper teeth (f, v); th = tongue tip between the teeth; dd = teeth slightly apart, tongue up (d, t, n, l); ss = teeth together, lips spread (s, z, sh); aa = jaw open (ah); e = half open, lips spread (eh); i = lips wide, nearly closed (ee); o = rounded and open (oh); u = small rounded (oo). Leave the list empty when nothing resembles a viseme.
- confidence: how sure you are the name matches what the images show.
- Describe only shape. Never describe or guess age, gender, ethnicity, race or skin colour; the flat colours are a rendering choice.
- Use lower-case enum values exactly as listed."""


# --- request building -----------------------------------------------------------------------


def image_block(path: Path) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(path.read_bytes()).decode()},
    }


def build_content(target: dict, files: dict[str, Path], views: tuple[str, ...], weights: dict[str, float]) -> list[dict]:
    sigma = {s: round(w * float(target["scale"]), 1) for s, w in weights.items()}
    labels = {"min": f"slider minimum ({sigma['min']:+}σ)", "mid": f"neutral ({sigma['mid']:+}σ)", "max": f"slider maximum ({sigma['max']:+}σ)"}
    content: list[dict] = [{
        "type": "text",
        "text": f"Component `{target['name']}` ({target['kind']}, region {target['region']}, "
                f"largest vertex displacement {target['max_delta_mm']} mm at the slider maximum).",
    }]
    n = 1
    for view in views:
        for s in SAMPLES:
            content.append({"type": "text", "text": f"Image {n}: {view} view, {labels[s]}"})
            content.append(image_block(files[f"{view}_{s}"]))
            n += 1
    content.append({"type": "text", "text": "Name this slider."})
    return content


def name_one(api, model: str, target: dict, files: dict[str, Path], views: tuple[str, ...],
             weights: dict[str, float], max_tokens: int, usage: Usage) -> dict:
    """One structured-output request with one retry on truncation / invalid JSON."""
    content = build_content(target, files, views, weights)
    last_error = None
    for attempt, tokens in enumerate((max_tokens, max_tokens * 2)):
        try:
            response = api.messages.parse(
                model=model,
                max_tokens=tokens,
                system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": content}],
                output_format=SliderName,
                output_config={"effort": "high"},
            )
        except ValidationError as e:  # parse() throws on JSON that does not match the schema
            last_error = f"schema: {e.errors()[0].get('msg') if e.errors() else e}"
            continue
        usage.add(response.usage)
        if response.stop_reason in ("refusal", "max_tokens"):
            last_error = f"stop_reason={response.stop_reason}"
            continue
        parsed = response.parsed_output
        if parsed is None:
            last_error = "no parsed output"
            continue
        return {"ok": True, "result": parsed.model_dump(), "attempts": attempt + 1, "output_tokens": response.usage.output_tokens}
    return {"ok": False, "error": last_error, "attempts": 2}


# --- output ---------------------------------------------------------------------------------


def ai_block(ai: dict) -> dict:
    """Claude's reading of one slider, as stored in its entry's `ai`."""
    return {
        "rawName": ai["name"],
        "confidence": ai["confidence"], "mouthRelevance": ai["mouth_relevance"],
        "openDirection": ai["open_direction"], "eyelidCloseDirection": ai["eyelid_close_direction"],
        "visemeHints": ai["viseme_hints"],
    }


def slider_entry(target: dict, weights: dict[str, float], ai: dict | None) -> dict:
    """A new entry for a slider sliders.json does not list yet (update-sliders then names and groups it)."""
    entry = {
        "id": target["name"],
        "target": target["name"],
        "kind": target["kind"],
        "region": target["region"],
        "name": target["name"].replace("_", " "),
        "description": "",
        "lowLabel": "-",
        "highLabel": "+",
        "group": "other",
        "min": weights["min"],
        "max": weights["max"],
        "default": 0.0 if weights["min"] <= 0.0 <= weights["max"] else weights["min"],  # rest pose
        "hidden": False,
        "ai": None,
    }
    if ai:
        entry.update({
            "name": ai["name"], "description": ai["description"], "lowLabel": ai["low_label"],
            "highLabel": ai["high_label"], "group": ai["group"], "ai": ai_block(ai),
        })
    return entry


def merge_sliders(doc: dict, model: str, manifest: dict, results: dict[str, dict], cfg: dict) -> int:
    """Merge Claude's answers into a sliders.json document in place: an answered slider's `ai` block is replaced, the
    rest of its entry stays; raw sliders the document does not list are added (in manifest order, after every other
    entry). Returns how many were added."""
    listed = {s["id"]: s for s in doc.get("sliders", []) if s.get("kind") in RAW_KINDS}
    raw, added = [], 0
    for t in manifest["targets"]:
        if t["kind"] not in RAW_KINDS:
            continue
        r = results.get(t["name"])
        answer = r["result"] if r and r.get("ok") else None
        entry = listed.get(t["name"])
        if entry is None:
            entry = slider_entry(t, sample_weights(t["name"], cfg), answer)
            added += 1
        elif answer:
            entry["ai"] = ai_block(answer)
        raw.append(entry)
    doc["sliders"] = [s for s in doc.get("sliders", []) if s.get("kind") not in RAW_KINDS] + raw
    if any(r.get("ok") for r in results.values()):
        doc["model"] = model
    doc.setdefault("sigmaScale", manifest["sigma_scale"])
    return added


def write_sliders(path: Path, model: str, manifest: dict, results: dict[str, dict], cfg: dict) -> int:
    doc = json.loads(path.read_text()) if path.exists() else {}
    added = merge_sliders(doc, model, manifest, results, cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return added


# --- disambiguation: sliders that got the same name ------------------------------------------


class ClusterMember(BaseModel):
    id: str
    name: str
    low_label: str
    high_label: str
    description: str


class ClusterNames(BaseModel):
    members: list[ClusterMember]


DISAMBIGUATE_PROMPT = SYSTEM_PROMPT + """

Disambiguation task: several components received the same slider name. You will see each of them at its slider minimum and maximum (front view). Give each one a DIFFERENT name that says what sets it apart from the others in this set: which part of the face moves most (cheeks, jaw, chin, lip corners, lip centre, one side, brow), how strong or subtle it is, or the direction. Keep the naming rules. Return exactly one entry per component id, every id present, no two names alike."""


def raw_name(s: dict) -> str:
    """Claude's name for a raw slider (the panel shows a numbered one)."""
    return (s.get("ai") or {}).get("rawName") or s["name"]


def clusters_of(sliders: list[dict]) -> list[list[dict]]:
    """Raw sliders that share Claude's name (case and spacing ignored)."""
    groups: dict[str, list[dict]] = {}
    for s in sliders:
        if s.get("kind") in RAW_KINDS:
            groups.setdefault(raw_name(s).strip().lower(), []).append(s)
    return [g for g in groups.values() if len(g) > 1]


def disambiguate_cluster(api, model: str, cluster: list[dict], usage: Usage) -> dict[str, ClusterMember] | None:
    content: list[dict] = []
    n = 1
    for s in cluster:
        files = {k: RENDERS_DIR / s["id"] / f"front_{k}.png" for k in ("min", "max")}
        if not all(f.exists() for f in files.values()):
            return None
        content.append({"type": "text", "text": f"Component `{s['id']}` (current name: {raw_name(s)}). Image {n}: slider minimum. Image {n + 1}: slider maximum."})
        content.append(image_block(files["min"]))
        content.append(image_block(files["max"]))
        n += 2
    content.append({"type": "text", "text": f"Rename these {len(cluster)} sliders so that no two names are the same."})
    try:
        response = api.messages.parse(
            model=model, max_tokens=8192,
            system=[{"type": "text", "text": DISAMBIGUATE_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            output_format=ClusterNames, output_config={"effort": "high"},
        )
    except ValidationError:
        return None
    usage.add(response.usage)
    if response.stop_reason in ("refusal", "max_tokens") or response.parsed_output is None:
        return None
    members = {m.id: m for m in response.parsed_output.members}
    names = [m.name.strip().lower() for m in members.values()]
    if set(members) != {s["id"] for s in cluster} or len(set(names)) != len(names):
        return None
    return members


def disambiguate(path: Path, model: str, workers: int = 4) -> None:
    doc = json.loads(path.read_text())
    clusters = clusters_of(doc["sliders"])
    if not clusters:
        print("no duplicate names to disambiguate")
        return
    print(f"disambiguating {len(clusters)} clusters ({sum(len(c) for c in clusters)} sliders) …")
    api = client()
    usage = Usage(model)
    renamed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(disambiguate_cluster, api, model, c, usage): c for c in clusters}
        for fut in as_completed(futures):
            cluster = futures[fut]
            try:
                members = fut.result()
            except Exception as e:
                members = None
                print(f"  cluster {raw_name(cluster[0])!r}: {type(e).__name__}: {str(e)[:120]}")
            if not members:
                print(f"  cluster {raw_name(cluster[0])!r}: names left as they are")
                continue
            shared = raw_name(cluster[0])
            for s in cluster:
                # the new name goes into rawName, so a second pass catches collisions between clusters renamed apart
                s["ai"] = {**(s.get("ai") or {}), "rawName": members[s["id"]].name, "disambiguated": True}
                renamed += 1
            print(f"  {shared!r} -> " + ", ".join(repr(members[s["id"]].name) for s in cluster))
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    left = clusters_of(doc["sliders"])
    print(f"renamed {renamed} sliders; {usage.summary()}"
          + (f"; {sum(len(c) for c in left)} still share a name in {len(left)} cluster(s): run --disambiguate-only again" if left else "; all names unique"))


# --- CLI ------------------------------------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", help="comma-separated component names (default: every identity and expression target)")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--views", default="front", help="front or front,quarter (default: front)")
    p.add_argument("--max-tokens", type=int, default=4096, help="per request; doubled on the retry")
    p.add_argument("--workers", type=int, default=5, help="requests in flight")
    p.add_argument("--pilot", action="store_true", help="write out/pilot_<model>.json instead of sliders.json")
    p.add_argument("--dry-run", action="store_true", help="render + build requests, call nothing")
    p.add_argument("--no-disambiguate", action="store_true", help="skip the second pass that renames same-named sliders")
    p.add_argument("--disambiguate-only", action="store_true", help="only run the rename pass on the existing sliders.json")
    args = p.parse_args()
    if args.disambiguate_only:
        disambiguate(SLIDERS_JSON, args.model)
        return

    cfg = load_config()
    manifest = json.loads(MANIFEST.read_text())
    targets = {t["name"]: t for t in manifest["targets"]}
    names = [n.strip() for n in args.only.split(",")] if args.only else [n for n, t in targets.items() if t["kind"] in RAW_KINDS]
    other = [n for n in names if targets.get(n, {}).get("kind") not in RAW_KINDS]
    if other:
        raise SystemExit(f"not a raw identity/expression target in the manifest: {other}")
    views = tuple(v.strip() for v in args.views.split(","))
    files = {d["name"]: {k: Path(v) for k, v in d["files"].items()} for d in render_targets(names, views)}

    if args.dry_run:
        n_images = len(names) * len(views) * len(SAMPLES)
        print(f"dry run: {len(names)} components, {n_images} images ≈ {n_images * 784 + len(names) * 900} input tokens")
        return

    api = client()
    usage = Usage(args.model)
    results: dict[str, dict] = {}
    t0 = time.time()
    print(f"naming {len(names)} components with {args.model} ({args.workers} in flight) …")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(name_one, api, args.model, targets[n], files[n], views, sample_weights(n, cfg), args.max_tokens, usage): n
            for n in names
        }
        for fut in as_completed(futures):
            n = futures[fut]
            try:
                results[n] = fut.result()
            except Exception as e:  # network / API errors after the SDK's own retries
                results[n] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
            r = results[n]
            if r["ok"]:
                a = r["result"]
                print(f"  {n:24s} -> {a['name']!r:28s} [{a['group']}, {a['confidence']}, {a['low_label']} → {a['high_label']}]")
            else:
                print(f"  {n:24s} -> FAILED: {r['error']}")

    ok = sum(1 for r in results.values() if r["ok"])
    print(f"\n{ok}/{len(names)} named in {time.time() - t0:.0f} s; {usage.summary()}")
    if args.pilot:
        out = OUT_DIR / f"pilot_{args.model}.json"
        out.write_text(json.dumps({"model": args.model, "views": views, "results": results, "usage": usage.__dict__}, indent=2) + "\n")
        print(f"pilot results -> {out}")
    else:
        added = write_sliders(SLIDERS_JSON, args.model, manifest, results, cfg)
        print(f"merged into {SLIDERS_JSON.relative_to(REPO_DIR)}"
              + (f"; {added} new slider(s): run `uv run update-sliders` to number and group them" if added else ""))
        if not args.no_disambiguate and not args.only:
            disambiguate(SLIDERS_JSON, args.model, workers=min(args.workers, 4))


if __name__ == "__main__":
    main()
