"""Blender (headless) — evaluate hair curve objects (geometry nodes applied) and save their strands, the growth
(scalp) mesh and the head they sit on, all in world space, to an .npz for the pipeline (import_hair.py).

    Blender -b <file.blend> -P blender/export_curves.py -- <out.npz> <scene> <curves object> [<curves object> ...]

The head is found as the mesh named "head" instanced at the style's offset: the scene's collection instance empties
("<Style> head") carry that offset, so the script also saves every empty's location for the pipeline to pick from.
"""
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1 :]
out, scene_name, names = argv[0], argv[1], argv[2:]
scene = bpy.data.scenes[scene_name]
depsgraph = scene.view_layers[0].depsgraph  # background mode has no window to switch scenes with
depsgraph.update()

points, counts, sources = [], [], []
growth = None
for name in names:
    obj = bpy.data.objects[name]
    ev = obj.evaluated_get(depsgraph)
    data = ev.data
    pos = np.array([p.vector[:] for p in data.attributes["position"].data], np.float64)
    mw = np.array(ev.matrix_world)
    pos = pos @ mw[:3, :3].T + mw[:3, 3]
    sizes = np.array([c.points_length for c in data.curves], np.int64)
    points.append(pos)
    counts.append(sizes)
    sources += [name] * len(sizes)
    if growth is None and obj.data.surface is not None:
        surf = obj.data.surface.evaluated_get(depsgraph)
        m = surf.to_mesh()
        gv = np.array([v.co[:] for v in m.vertices], np.float64)
        gw = np.array(surf.matrix_world)
        gv = gv @ gw[:3, :3].T + gw[:3, 3]
        gt = np.array([p.vertices[:] for p in m.polygons if len(p.vertices) == 3] + [
            t for p in m.polygons if len(p.vertices) == 4 for t in ((p.vertices[0], p.vertices[1], p.vertices[2]), (p.vertices[0], p.vertices[2], p.vertices[3]))
        ], np.int64)
        growth = (gv, gt)
        surf.to_mesh_clear()
    print(f"{name}: {len(sizes)} curves, {len(pos)} points (evaluated)")

head = bpy.data.objects["head"]
hm = head.evaluated_get(depsgraph).to_mesh()
hv = np.array([v.co[:] for v in hm.vertices], np.float64)
hw = np.array(head.matrix_world)
hv = hv @ hw[:3, :3].T + hw[:3, 3]
ht = []  # polygons fanned into triangles
for p in hm.polygons:
    v = p.vertices
    ht.extend((v[0], v[k], v[k + 1]) for k in range(1, len(v) - 1))
eyes = bpy.data.objects.get("eyes")  # eyeballs: anchors for fitting brows and lashes precisely
ev_ = eyes.evaluated_get(depsgraph).to_mesh() if eyes else None
eyes_v = np.array([v.co[:] for v in ev_.vertices], np.float64) @ np.array(eyes.matrix_world)[:3, :3].T + np.array(eyes.matrix_world)[:3, 3] if eyes else np.zeros((0, 3))
empties = {o.name: o.location[:] for o in scene.objects if o.type == "EMPTY"}
np.savez_compressed(
    out,
    points=np.concatenate(points), counts=np.concatenate(counts), sources=np.array(sources),
    growth_v=growth[0] if growth else np.zeros((0, 3)), growth_t=growth[1] if growth else np.zeros((0, 3), np.int64),
    head_v=hv, head_t=np.array(ht, np.int64), eyes_v=eyes_v,
    empty_names=np.array(list(empties)), empty_locs=np.array(list(empties.values()), np.float64),
)
print("saved", out)
