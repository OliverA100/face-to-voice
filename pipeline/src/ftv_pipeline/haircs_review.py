"""`uv run haircs-review select | build | apply <decisions.json>`: pick a varied set of HairCS styles, convert them for a
review in the app (dev builds only), then apply the keep/cut decisions made on /dev/hair-review.

select  measures every downloaded base style (pipeline/.cache/haircs/data/v0-*.npz): strand length (p25/p50/p90),
        volume (how far hair stands off the head), drop (how far below the jaw it reaches), curl (path ÷ chord),
        fringe (share of tips in front of the forehead), asymmetry (left/right mass) and side cover; standardises them
        and, per class, keeps the styles that are furthest apart (farthest-point sampling), so the set spans the range
        instead of repeating the common looks. Writes .cache/haircs/selection.json.
build   converts the selection to strands (fit onto GNM, stray cleanup), in parallel, into the gitignored
        web/public/models/hair/review/ with its own review.json (the app lists it in dev builds only).
apply   reads the decisions exported from /dev/hair-review ({"keep": [...], "cut": [...]}): kept review styles move
        into web/public/models/hair/haircs/ and the shipped index; cut styles leave the index (their files are deleted).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from .export_glb import MODELS_DIR
from .hair_index import HAIR_MODELS_DIR, INDEX
from .import_hair import HAIRCS_DIR, read_obj

HAIRCS_URL = "https://huggingface.co/datasets/HairCS2027/HairCS/resolve/main"
REVIEW_DIR = HAIR_MODELS_DIR / "review"
SELECTION = HAIRCS_DIR / "selection.json"
QUOTA = {"short": 70, "long": 55, "gather": 40, "bob": 30, "shoulder": 25}  # ~220 straight bases, the farthest apart
CURLY_QUOTA = {"short": 12, "long": 10, "gather": 6, "bob": 6, "shoulder": 6}  # + curly versions (v2/v3), spread by class
# Distinctive looks (the app builds characters, not averages): fuzz/scale (v1), curly + fuzz (v4) and cross-style blends
# (v5 bob/shoulder, v9 short, v11 long), sampled evenly through each version.
EXTRA = {"v1": 16, "v4": 16, "v5": 6, "v9": 10, "v11": 8}
EXTREMES_PER_FEATURE = 2  # per class, the top and bottom styles of every measure are always in
FEATURES = ["len25", "len50", "len90", "volume", "drop", "curl", "fringe", "asym", "side"]


def head_frame() -> tuple[np.ndarray, float, float]:
    """(head centre, scalp top y, chin y) of the HairCS head (metres, its own frame)."""
    v = read_obj(HAIRCS_DIR / "meta" / "head_with_uv.obj")[0]
    top = v[:, 1].max()
    head = v[v[:, 1] > top - 0.26]
    centre = np.array([0.0, top - 0.11, np.median(head[:, 2])])
    chin = top - 0.23
    return centre, top, chin


def describe(path: Path, centre, top, chin, n: int = 3000) -> dict:
    P = np.load(path)["P"].astype(np.float64)
    P = P[np.random.default_rng(0).choice(len(P), min(n, len(P)), replace=False)]
    seg = np.linalg.norm(np.diff(P, axis=1), axis=2)
    L = seg.sum(1) * 100  # cm
    chord = np.linalg.norm(P[:, -1] - P[:, 0], axis=1) * 100
    r = np.linalg.norm(P - centre, axis=2)
    tips = P[:, -1]
    front = (tips[:, 2] > centre[2] + 0.07) & (tips[:, 1] < top - 0.06) & (np.abs(tips[:, 0]) < 0.05)
    return {
        "len25": float(np.percentile(L, 25)), "len50": float(np.median(L)), "len90": float(np.percentile(L, 90)),
        "volume": float(np.percentile(r, 90) - np.percentile(r[:, 0], 50)) * 100,
        "drop": float(chin - tips[:, 1].min()) * 100,
        "curl": float(np.median(L / np.maximum(chord, 0.1))),
        "fringe": float(front.mean()),
        "asym": float(abs((tips[:, 0] > 0).mean() - 0.5)),
        "side": float(((np.abs(tips[:, 0]) > 0.07) & (tips[:, 1] < top - 0.08)).mean()),
    }


def farthest(X: np.ndarray, k: int, seed_idx: list[int] | None = None) -> list[int]:
    """Farthest-point sampling from the most unusual style (or from `seed_idx`): spreads the picks over the range."""
    if len(X) <= k:
        return list(range(len(X)))
    idx = list(seed_idx) if seed_idx else [int(np.argmax(np.linalg.norm(X - X.mean(0), axis=1)))]
    d = np.min(np.stack([np.linalg.norm(X - X[i], axis=1) for i in idx]), axis=0)
    while len(idx) < k:
        i = int(d.argmax())
        idx.append(i)
        d = np.minimum(d, np.linalg.norm(X - X[i], axis=1))
    return idx


def select() -> None:
    centre, top, chin = head_frame()
    with open(HAIRCS_DIR / "meta" / "v0.csv") as f:
        labels = {r["number"]: r["class"] for r in csv.DictReader(f)}
    rows = []
    files = sorted((HAIRCS_DIR / "data").glob("v0-*.npz"))
    for i, f in enumerate(files):
        num = f.stem.split("-")[1]
        try:
            rows.append({"name": f.stem, "class": labels.get(num, "?"), **describe(f, centre, top, chin)})
        except Exception as err:  # a truncated download: skip it, report it
            print("  skip", f.name, err)
        if i % 100 == 0:
            print(f"  measured {i}/{len(files)}", flush=True)
    X = np.array([[r[k] for k in FEATURES] for r in rows])
    Z = (X - X.mean(0)) / np.maximum(X.std(0), 1e-9)
    picks = []
    for cls, k in QUOTA.items():
        ids = [i for i, r in enumerate(rows) if r["class"] == cls]
        Zc = Z[ids]
        # the extremes of every measure first (longest, shortest, most voluminous, curliest, most asymmetric …)
        ext = sorted({int(j) for f in range(Zc.shape[1]) for j in (*np.argsort(Zc[:, f])[:EXTREMES_PER_FEATURE], *np.argsort(Zc[:, f])[-EXTREMES_PER_FEATURE:])})
        chosen = farthest(Zc, max(k, len(ext)), seed_idx=ext)
        # keep adding until every style of the class has a pick that looks close to it (nothing distinctive left out):
        # coverage radius = 1.5 × the class's median nearest-neighbour distance, at most 1.6 × the quota
        from scipy.spatial import cKDTree

        nn = np.median(cKDTree(Zc).query(Zc, k=2)[0][:, 1])
        while len(chosen) < int(1.6 * k):
            gap = cKDTree(Zc[chosen]).query(Zc)[0]
            if gap.max() <= 1.5 * nn:
                break
            chosen.append(int(gap.argmax()))
        print(f"  {cls}: {len(chosen)} picks (quota {k}, {len(ext)} extremes), widest gap now {cKDTree(Zc[chosen]).query(Zc)[0].max() / nn:.1f}× typical")
        picks += [rows[ids[j]] for j in chosen]
    picks += curly_picks() + extra_picks()
    SELECTION.write_text(json.dumps({"features": FEATURES, "measured": len(rows), "picks": picks}, indent=1))
    print(f"selected {len(picks)} of {len(rows)} → {SELECTION}")


def download(url: str, path: Path, timeout: int, check) -> None:
    """`url` into `path` once `check(tmp)` accepts it: an HTTP error, a bad file or an interrupted run never leaves a
    file under the cached name (the cache is only ever read, never re-fetched)."""
    import requests

    res = requests.get(url, timeout=timeout)
    res.raise_for_status()
    tmp = path.with_name(path.name + ".part")
    try:
        tmp.write_bytes(res.content)
        check(tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _check_labels(path: Path) -> None:
    with open(path) as f:
        head = csv.DictReader(f).fieldnames or []
    if not {"number", "class"} <= set(head):
        raise ValueError(f"{path.name}: not a HairCS label table (columns {head})")


def _check_strands(path: Path) -> None:
    with np.load(path, allow_pickle=False) as z:
        if z["P"].ndim != 3:
            raise ValueError(f"{path.name}: strands P has shape {z['P'].shape}")


def label_rows(ver: str) -> list[dict]:
    """HairCS's label table for one version (number, class …), fetched once into .cache/haircs/meta/."""
    path = HAIRCS_DIR / "meta" / f"{ver}.csv"
    if not path.exists():
        download(f"{HAIRCS_URL}/label/{ver}.csv", path, 60, _check_labels)
    with open(path) as f:
        return list(csv.DictReader(f))


def fetch_style(ver: str, num: str) -> Path:
    """One HairCS style's strands (.cache/haircs/data/<ver>-<num>.npz), fetched once."""
    if not re.fullmatch(r"\d+", num):  # from the remote label table: it names a local file
        raise ValueError(f"HairCS {ver} style number {num!r} is not a number")
    path = HAIRCS_DIR / "data" / f"{ver}-{num}.npz"
    if not path.exists():
        download(f"{HAIRCS_URL}/data/{ver}/{num}.npz", path, 300, _check_strands)
    return path


def curly_picks() -> list[dict]:
    """Curly styles from v2/v3 (HairCS's curl profiles), spread evenly through each class's list; fetched here."""
    out = []
    for ver, share in (("v2", 0.5), ("v3", 0.5)):
        by: dict[str, list[str]] = {}
        for r in label_rows(ver):
            by.setdefault(r["class"], []).append(r["number"])
        for cls, k in CURLY_QUOTA.items():
            nums = by.get(cls, [])
            n = max(1, round(k * share))
            picked = nums[len(nums) // (2 * n):: max(1, len(nums) // n)][:n]
            out.extend({"name": fetch_style(ver, num).stem, "class": cls, "curly": True} for num in picked)
    return out


def extra_picks() -> list[dict]:
    """Fuzz/scale, curly+fuzz and blend versions, spread evenly through each version's list (fetched here)."""
    out = []
    for ver, k in EXTRA.items():
        rows = label_rows(ver)
        picked = rows[len(rows) // (2 * k):: max(1, len(rows) // k)][:k]
        out.extend({"name": fetch_style(ver, r["number"]).stem, "class": r["class"], "variant": ver} for r in picked)
    return out


def _convert(job: tuple[str, str, int]) -> dict | None:
    name, cls, points = job
    out = subprocess.run([sys.executable, "-m", "ftv_pipeline.haircs_review", "_one", name, cls, str(points)],
                         capture_output=True, text=True, check=False)
    if out.returncode != 0:
        print("  failed", name, out.stderr[-400:])
        return None
    return json.loads(out.stdout.strip().splitlines()[-1])


def convert_one(name: str, cls: str, points: int) -> dict:
    """One style → review/<id>.strands.bin + review/thumbs/<id>.webp (pyvista thumb; the app captures real ones)."""
    from . import import_hair as ih
    from .export_groom import entry, thumbnail
    from .gnm import GNM
    from .groom import Groom, GroomSpec, encode, self_shadow

    gnm = GNM.load()
    strands, head_v, _ = ih.load_haircs(name, keep=12000)
    s, R, t = ih.fit_head(head_v, gnm)
    fitted = ih.fit_strands(strands, s, R, t, gnm, points, head_v=head_v)
    fitted, _ = ih.clean_strays(fitted, gnm)
    fitted = fitted[np.random.default_rng(7).permutation(len(fitted))]
    sid = f"haircs-{name}"
    spec = GroomSpec(id=sid, label=f"{cls} {name.split('-')[1]}", children=(0, 1, 2), child_radius_mm=1.2, natural=("#24190f", "#6e5038"))
    g = Groom(spec, fitted, self_shadow(fitted))
    data = encode(g)
    (REVIEW_DIR / "thumbs").mkdir(parents=True, exist_ok=True)
    (REVIEW_DIR / f"{sid}.strands.bin").write_bytes(data)
    th = thumbnail(g, gnm)
    th.replace(REVIEW_DIR / "thumbs" / th.name)
    e = entry(g, len(data))
    e.update({"file": f"hair/review/{sid}.strands.bin", "thumb": f"hair/review/thumbs/{sid}.webp", "pack": "haircs",
              "author": ih.AUTHORS["haircs"], "local": True, "review": {"class": cls}})
    return e


def build(workers: int = 6) -> None:
    sel = json.loads(SELECTION.read_text())["picks"]
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [(p["name"], p["class"], 16 if p["class"] == "short" else 20 if p["class"] in ("bob", "gather") else 24) for p in sel]
    done = []
    with ProcessPoolExecutor(workers) as pool:
        for i, e in enumerate(pool.map(_convert, jobs)):
            if e:
                done.append(e)
            if i % 10 == 0:
                print(f"  converted {i + 1}/{len(jobs)}", flush=True)
    (REVIEW_DIR / "review.json").write_text(json.dumps({"styles": done}, indent=1) + "\n")
    print(f"review set: {len(done)} styles → web/public/models/hair/review/ (gitignored)")


GROUP_OF_CLASS = {"short": "short", "bob": "bob", "shoulder": "shoulder", "long": "long", "gather": "tied"}
GROUP_ORDER = ["short", "bob", "shoulder", "long", "tied"]
# picker styles that are not HairCS review picks: (group, curly)
OTHER_GROUPS = {
    "bystedt-long": ("long", False), "bystedt-curly": ("shoulder", True), "bystedt-cyberpunk": ("short", False),
    "bystedt-braids": ("tied", False), "side_part": ("short", False),
    "haircs-v0-00681": ("short", False), "haircs-v0-00901": ("short", False), "haircs-v0-00518": ("short", False),
    "haircs-v0-00625": ("short", False), "haircs-v0-00255": ("bob", False), "haircs-v0-00008": ("shoulder", False),
    "haircs-v0-00355": ("short", False), "haircs-v0-00244": ("short", False), "haircs-v0-00697": ("short", False),
    "haircs-v0-00587": ("short", False), "haircs-v0-00871": ("short", False), "haircs-v0-00003": ("bob", False),
    "haircs-v0-00000": ("long", False), "haircs-v0-00195": ("long", False),
}
CURLY = 1.2  # path ÷ chord at or above which a style counts as wavy (and shows under the Curly filter); 1.35 = curly


def names(picks: list[dict]) -> dict[str, str]:
    """Readable labels from the measured features (they also reach the voice step: "hair: wavy full bob"), unique."""
    by_class: dict[str, list[dict]] = {}
    for p in picks:
        by_class.setdefault(p["class"], []).append(p)
    out: dict[str, str] = {}
    for cls, rows in by_class.items():
        vol = np.array([r["volume"] for r in rows])
        hi, lo = np.percentile(vol, 88), np.percentile(vol, 12)
        for r in rows:
            words = []
            if r["curl"] >= 1.35:
                words.append("curly")
            elif r["curl"] >= CURLY:
                words.append("wavy")
            if r["volume"] >= hi:
                words.append("full")
            elif r["volume"] <= lo:
                words.append("sleek")
            if r["asym"] >= 0.2:
                words.append("asymmetric")
            elif r["side"] >= 0.5 and cls != "short":
                words.append("side-swept")
            noun = {"short": "crop" if r["len50"] < 3.5 else "short cut" if r["len50"] < 8 else "shag",
                    "bob": "bob", "shoulder": "shoulder-length", "long": "very long" if r["len90"] > 60 else "long",
                    "gather": "tied back"}[cls]
            label = " ".join([*words, noun]) + (" with fringe" if r["fringe"] >= 0.05 else "")
            out[f"haircs-{r['name']}"] = label[0].upper() + label[1:]
    return out


def number_duplicates(styles: list[dict]) -> None:
    """Same label twice: "Shag", "Shag 2", "Shag 3" … in the order the picker shows them."""
    seen: dict[str, int] = {}
    for e in styles:
        base = e["label"]
        n = seen[base] = seen.get(base, 0) + 1
        if n > 1:
            e["label"] = f"{base} {n}"


def shot_thumb(sid: str, dst: Path) -> bool:
    """The picker thumbnail from the app's own ¾ shot (review/shots, made by the e2e capture), 128 px."""
    from PIL import Image

    src = REVIEW_DIR / "shots" / f"{sid}__threeQuarter.webp"
    if not src.exists():
        return False
    im = Image.open(src).convert("RGB")
    w, h = im.size
    im = im.crop((int(w * 0.14), int(h * 0.02), int(w * 0.86), int(h * 0.74))).resize((128, 128), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=86)
    return True


# Index fields a review set made by an older build may still carry; the shipped index no longer has them.
RETIRED_FIELDS = ("vertices", "triangles", "targets", "normalMap", "alphaCutoff", "lum")


def measured_picks(review: list[dict]) -> list[dict]:
    """The selection's picks plus the review styles added after `select` (the curly / fuzz / blend versions), each with
    its measured features (`describe`)."""
    picks = json.loads(SELECTION.read_text())["picks"]
    known = {f"haircs-{p['name']}" for p in picks}
    picks += [{"name": e["id"].removeprefix("haircs-"), "class": e.get("review", {}).get("class", "short")} for e in review if e["id"] not in known]
    centre, top, chin = head_frame()
    for p in picks:  # the later additions were never measured
        if "volume" not in p:
            p.update(describe(HAIRCS_DIR / "data" / f"{p['name']}.npz", centre, top, chin))
    return picks


def apply(decisions: Path) -> None:
    d = json.loads(decisions.read_text())
    keep, cut = set(d.get("keep", [])), set(d.get("cut", []))
    index = json.loads(INDEX.read_text())
    review = json.loads((REVIEW_DIR / "review.json").read_text())["styles"] if (REVIEW_DIR / "review.json").exists() else []
    picks = measured_picks(review)
    feats = {f"haircs-{p['name']}": p for p in picks}
    labels = names(picks)
    shipped_ids = {e["id"] for e in index["styles"]}
    moved = 0
    for e in review:
        if e["id"] in keep and e["id"] not in shipped_ids:
            shutil.copy2(REVIEW_DIR / f"{e['id']}.strands.bin", HAIR_MODELS_DIR / "haircs" / f"{e['id']}.strands.bin")
            cls = e.get("review", {}).get("class", feats.get(e["id"], {}).get("class", "short"))
            kept = {**e, "file": f"hair/haircs/{e['id']}.strands.bin", "thumb": f"hair/haircs/thumbs/{e['id']}.webp",
                    "label": labels.get(e["id"], e["label"]), "group": GROUP_OF_CLASS[cls], "curly": feats.get(e["id"], {}).get("curl", 1.0) >= CURLY}
            for key in ("local", "review", *RETIRED_FIELDS):
                kept.pop(key, None)
            index["styles"].append(kept)
            moved += 1
    removed = [e for e in index["styles"] if e["id"] in cut]
    for e in removed:
        for rel in (e["file"], e["thumb"]):
            (MODELS_DIR / rel).unlink(missing_ok=True)
    index["styles"] = [e for e in index["styles"] if e["id"] not in cut]
    for e in index["styles"]:
        if "group" not in e:
            e["group"], e["curly"] = OTHER_GROUPS.get(e["id"], ("short", False))
        if not shot_thumb(e["id"], MODELS_DIR / e["thumb"]):
            print("  no app shot for", e["id"], "(kept its old thumbnail)")
    length = {e["id"]: feats.get(e["id"], {}).get("len50", 0.0) for e in index["styles"]}
    index["styles"].sort(key=lambda e: (GROUP_ORDER.index(e["group"]), length[e["id"]]))
    number_duplicates(index["styles"])
    INDEX.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print(f"kept {moved} new styles, removed {len(removed)}; the picker now has {len(index['styles'])}: "
          f"{dict(Counter(e['group'] for e in index['styles']))}, curly/wavy {sum(e['curly'] for e in index['styles'])}")


def relabel() -> None:
    """Re-derive the generated labels of an applied index (after changing `names`)."""
    index = json.loads(INDEX.read_text())
    review = json.loads((REVIEW_DIR / "review.json").read_text())["styles"]
    labels = names(measured_picks(review))
    for e in index["styles"]:
        if e["id"] in labels and e["id"] not in OTHER_GROUPS and "type" not in e:  # named by hand (with a "type"): kept
            e["label"] = labels[e["id"]]
    number_duplicates(index["styles"])
    INDEX.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print("relabelled", sum(e["id"] in labels for e in index["styles"]))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "_one":
        print(json.dumps(convert_one(sys.argv[2], sys.argv[3], int(sys.argv[4]))))
        return
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["select", "build", "apply", "relabel"])
    ap.add_argument("decisions", nargs="?")
    args = ap.parse_args()
    {"select": select, "build": build, "relabel": relabel}.get(args.cmd, lambda: apply(Path(args.decisions)))()


if __name__ == "__main__":
    main()
