"""`uv run render`: PNGs of every exported component at its slider extremes, for the naming step.

For each target in the manifest we render the head at slider min / mid / max (normally -3σ / 0 /
+3σ) from the front and, optionally, a three-quarter view. The camera frames the face region the
component belongs to (whole head, eyes, mouth) so subtle changes stay visible at 784 px, and
teeth/tongue components are rendered with the jaw opened by a context pose.

Output: out/renders/<component>/<view>_<sample>.png   (sample = min | mid | max)
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

from .export_glb import MANIFEST, assign_triangles, assign_vertices, load_config, vertex_normals
from .gnm import GNM, OUT_DIR
from .parts import MATERIALS, PARTS

RENDERS_DIR = OUT_DIR / "renders"
SIZE = 784  # multiple of 28 px: Claude bills exactly (784/28)^2 = 784 tokens per image
SAMPLES = ("min", "mid", "max")
VIEWS = ("front", "quarter")

# Camera framing per GNM region: (focal point, distance) in metres with a 28° vertical FOV.
# Eyes sit at y≈0.30, the mouth at y≈0.20, the nose tip at z≈0.15.
FRAMING: dict[str, tuple[tuple[float, float, float], float]] = {
    "head": ((0.0, 0.245, 0.04), 0.86),  # whole head with neck
    "eyes": ((0.0, 0.302, 0.09), 0.30),  # both eyes
    "left_eye_region": ((0.0, 0.302, 0.09), 0.34),  # both eyes, so left/right asymmetry is obvious
    "right_eye_region": ((0.0, 0.302, 0.09), 0.34),
    "pupils": ((0.0, 0.302, 0.09), 0.24),
    "lower_face_region": ((0.0, 0.215, 0.08), 0.46),  # nose to chin
    "teeth": ((0.0, 0.205, 0.10), 0.30),
    "tongue": ((0.0, 0.205, 0.10), 0.30),
    "preset": ((0.0, 0.245, 0.04), 0.86),
}


class HeadRenderer:
    """One off-screen pyvista plotter with a PolyData per part; update points + normals per frame."""

    def __init__(self, gnm: GNM, size: int = SIZE):
        import pyvista as pv  # imported lazily: VTK is slow to import

        self.gnm = gnm
        self.pv = pv
        owner = assign_vertices(gnm, list(PARTS))
        tri_owner = assign_triangles(owner, gnm.triangles, len(PARTS))
        self.triangles = gnm.triangles[tri_owner >= 0]  # everything shipped, for normals
        self.plotter = pv.Plotter(off_screen=True, window_size=(size, size))
        self.plotter.set_background("#2b2b2b")
        self.meshes = []
        self._part_actors = []
        self._overlays: list = []
        self._heat_mesh = None
        self._heat_actor = None
        normals = vertex_normals(gnm.template, self.triangles)
        for i, part in enumerate(PARTS):
            tris = gnm.triangles[tri_owner == i]
            faces = np.hstack([np.full((len(tris), 1), 3, np.int64), tris]).ravel()
            mesh = pv.PolyData(gnm.template.copy(), faces)
            mesh.point_data["Normals"] = normals.copy()
            mesh.point_data.active_normals_name = "Normals"
            actor = self.plotter.add_mesh(mesh, color=MATERIALS[part.material][0], specular=0.15, specular_power=20)
            self.meshes.append(mesh)
            self._part_actors.append(actor)
        self.plotter.remove_all_lights()
        for pos, intensity in [((0.6, 0.9, 1.2), 1.0), ((-0.9, 0.4, 0.8), 0.5), ((0.0, 0.6, -1.0), 0.4)]:
            self.plotter.add_light(pv.Light(position=pos, focal_point=(0, 0.27, 0.05), intensity=intensity, positional=False))
        self.plotter.camera.view_angle = 28

    def set_shape(self, coefficients: dict[str, float]) -> None:
        """coefficients are in σ units ({component: sigma})."""
        self.set_positions(self.gnm.vertices(coefficients))

    def set_positions(self, positions: np.ndarray) -> None:
        """Show any (V, 3) vertex array (e.g. template + a semantic slider's delta)."""
        normals = vertex_normals(positions, self.triangles)
        for mesh in self.meshes + ([self._heat_mesh] if self._heat_mesh is not None else []):
            mesh.points = positions
            mesh.point_data["Normals"] = normals

    def frame(self, region: str, view: str) -> None:
        focal, distance = FRAMING.get(region, FRAMING["head"])
        self.look(focal, distance, 40.0 if view == "quarter" else 0.0)

    def look(self, focal: tuple[float, float, float], distance: float, yaw_deg: float = 0.0) -> None:
        """Camera at `distance` from `focal`, turned `yaw_deg` towards the head's left (+X); 90 = profile."""
        yaw = math.radians(yaw_deg)
        cam = self.plotter.camera
        cam.focal_point = focal
        cam.position = (focal[0] + distance * math.sin(yaw), focal[1], focal[2] + distance * math.cos(yaw))
        cam.up = (0.0, 1.0, 0.0)

    # --- overlays (landmark markers, displacement heat maps) ---------------------------------------

    def add_points(self, points: np.ndarray, colour: str, size: float = 10.0, labels: list[str] | None = None,
                   font_size: int = 14) -> None:
        """Round markers (optionally labelled) drawn on top of the head until clear_overlays()."""
        cloud = self.pv.PolyData(np.asarray(points, np.float32))
        if labels:
            actor = self.plotter.add_point_labels(
                cloud, labels, point_color=colour, point_size=size, render_points_as_spheres=True,
                font_size=font_size, text_color="white", shape_color="#111111", shape_opacity=0.55,
                always_visible=True, margin=2)
        else:
            actor = self.plotter.add_mesh(cloud, color=colour, point_size=size, render_points_as_spheres=True)
        self._overlays.append(actor)

    def clear_overlays(self) -> None:
        for actor in self._overlays:
            self.plotter.remove_actor(actor)
        self._overlays.clear()

    def show_heat(self, values: np.ndarray | None, clim: tuple[float, float] = (0.0, 1.0), cmap: str = "inferno") -> None:
        """Colour the skin by a per-vertex scalar (None = back to the normal materials)."""
        if self._heat_mesh is None:
            skin = next(i for i, p in enumerate(PARTS) if p.name == "skin")
            self._heat_mesh = self.meshes[skin].copy()
            self._heat_mesh.point_data["heat"] = np.zeros(self._heat_mesh.n_points, np.float32)
            self._heat_actor = self.plotter.add_mesh(self._heat_mesh, scalars="heat", cmap=cmap, clim=clim,
                                                     show_scalar_bar=False, specular=0.1)
        on = values is not None
        if on:
            self._heat_mesh.point_data["heat"] = np.asarray(values, np.float32)
            self._heat_actor.mapper.scalar_range = clim
        self._heat_actor.SetVisibility(on)
        for actor in self._part_actors:
            actor.SetVisibility(not on)

    def screenshot(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.plotter.render()  # screenshot() alone returns the previous frame
        self.plotter.screenshot(str(path))


def sample_weights(name: str, cfg: dict) -> dict[str, float]:
    lo, hi = cfg["export"].get("ranges", {}).get(name, [-1.0, 1.0])
    return {"min": float(lo), "mid": float((lo + hi) / 2), "max": float(hi)}


def render_targets(names: list[str] | None, views: tuple[str, ...], force: bool = False) -> list[dict]:
    cfg = load_config()
    manifest = json.loads(MANIFEST.read_text())
    targets = {t["name"]: t for t in manifest["targets"]}
    scales = {t["name"]: float(t["scale"]) for t in manifest["targets"]}
    names = names or list(targets)
    unknown = [n for n in names if n not in targets]
    if unknown:
        raise SystemExit(f"not in the manifest (run `uv run export` first?): {unknown}")
    context = cfg.get("render", {}).get("context", {})

    renderer = None
    t0 = time.time()
    done = []
    for name in names:
        t = targets[name]
        weights = sample_weights(name, cfg)
        files = {(v, s): RENDERS_DIR / name / f"{v}_{s}.png" for v in views for s in SAMPLES}
        if not force and all(p.exists() for p in files.values()):
            done.append({"name": name, "files": {f"{v}_{s}": str(p) for (v, s), p in files.items()}, "cached": True})
            continue
        if renderer is None:
            print("loading GNM + VTK …")
            renderer = HeadRenderer(GNM.load())
        base = {k: float(w) * scales[k] for k, w in context.get(t["region"], {}).items() if k != name}
        for s, w in weights.items():
            coeffs = dict(base)
            coeffs[name] = coeffs.get(name, 0.0) + w * scales[name]
            renderer.set_shape(coeffs)
            for v in views:
                renderer.frame(t["region"], v)
                renderer.screenshot(files[(v, s)])
        done.append({"name": name, "files": {f"{v}_{s}": str(p) for (v, s), p in files.items()}, "cached": False})
        print(f"  rendered {name} ({len(views) * len(SAMPLES)} images)")
    fresh = sum(1 for d in done if not d["cached"])
    print(f"{len(done)} components ready ({fresh} rendered, {len(done) - fresh} cached) in {time.time() - t0:.1f} s -> {RENDERS_DIR}")
    return done


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", help="comma-separated component names (default: every exported target)")
    p.add_argument("--views", default="front", help="comma-separated: front,quarter (default: front)")
    p.add_argument("--force", action="store_true", help="re-render even if the PNGs exist")
    return p.parse_args(argv)


def main() -> None:
    args = parse_args()
    names = [n.strip() for n in args.only.split(",")] if args.only else None
    views = tuple(v.strip() for v in args.views.split(",") if v.strip())
    for v in views:
        if v not in VIEWS:
            raise SystemExit(f"unknown view {v!r}; choose from {VIEWS}")
    render_targets(names, views, force=args.force)


if __name__ == "__main__":
    main()
