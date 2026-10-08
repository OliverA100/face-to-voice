"""Blender (headless) — bake ambient occlusion of the neutral head into the skin's UV layout.

Run through the pipeline: `uv run bake-ao` (ftv_pipeline/bake.py), which calls
    Blender -b --factory-startup -P blender/bake_ao.py -- <head.raw.glb> <out.png> <size> <distance_m> <samples>

Every head part (eyes, teeth, mouth) is in the scene as an occluder; the skin and the mouth sock (which shares the
skin's UV space) receive the bake. Cycles' AO bake uses the world's AO distance: how far a crease looks for cover.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
src, out, size, distance, samples = argv[0], argv[1], int(argv[2]), float(argv[3]), int(argv[4])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = samples
scene.world = bpy.data.worlds.new("bake") if scene.world is None else scene.world
scene.world.light_settings.distance = distance

meshes = [o for o in scene.objects if o.type == "MESH" and not o.name.startswith("cornea")]  # the clear shell casts no AO
receivers = [o for o in meshes if o.name.split(".")[0] in ("skin", "mouth")]
if not receivers:
    raise SystemExit(f"no skin/mouth objects in {src}: {[o.name for o in meshes]}")

image = bpy.data.images.new("ao", width=size, height=size, alpha=False, float_buffer=True)
image.colorspace_settings.name = "Non-Color"  # AO is data: saved without any view transform
for o in receivers:
    # Neutral shape: the importer adds the morph targets as shape keys at value 0, which is already the rest pose.
    for slot in o.material_slots:
        mat = slot.material.copy()
        slot.material = mat
        mat.use_nodes = True
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        mat.node_tree.nodes.active = node  # the bake writes into the active image node

bpy.ops.object.select_all(action="DESELECT")
for o in receivers:
    o.select_set(True)
bpy.context.view_layer.objects.active = receivers[0]
scene.render.bake.margin = 16
scene.render.bake.margin_type = "EXTEND"
bpy.ops.object.bake(type="AO", use_clear=True)

image.filepath_raw = out
image.file_format = "PNG"  # 16-bit linear greyscale; the pipeline blurs, packs and encodes it
scene.render.image_settings.color_depth = "16"
image.save()
print(f"baked AO {size}² (distance {distance} m, {samples} samples) -> {out}")
