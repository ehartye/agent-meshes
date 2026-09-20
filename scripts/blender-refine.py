"""Headless Blender stage: smooth and enrich an agent-meshes GLB, keeping its skeleton and clips.

    blender -b --python scripts/blender-refine.py -- input.glb output.glb [--subdivide N] [--noise STRENGTH] [--noise-scale S] [--only name,name]

Subdivision Surface rounds the primitives into organic forms; an optional displacement from a
procedural clouds texture adds a feather or fur-like surface. Modifiers are applied on export,
before skinning, so bone weights and animations survive. Vertex colors (shell colors and baked
occlusion) are exported as the active color attribute.
"""
import argparse
import sys

import bpy


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--subdivide', type=int, default=1)
    p.add_argument('--noise', type=float, default=0.0)
    p.add_argument('--noise-scale', type=float, default=0.12)
    p.add_argument('--only', default='', help='comma-separated mesh names to refine; others pass through')
    return p.parse_args(argv)


def move_before_armature(obj, modifier):
    """Modifiers apply in order; deformation must stay last so refinements happen in rest space."""
    names = [m.name for m in obj.modifiers]
    armature = next((i for i, m in enumerate(obj.modifiers) if m.type == 'ARMATURE'), None)
    if armature is None:
        return
    index = names.index(modifier.name)
    if index > armature:
        obj.modifiers.move(index, armature)


def main():
    args = parse()
    only = {name for name in args.only.split(',') if name}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)
    refined = 0
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH' or (only and obj.name not in only):
            continue
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        if args.subdivide > 0:
            mod = obj.modifiers.new('Subdivision', 'SUBSURF')
            mod.levels = args.subdivide
            mod.render_levels = args.subdivide
            move_before_armature(obj, mod)
        if args.noise > 0:
            texture = bpy.data.textures.new(f'{obj.name}_feathers', 'CLOUDS')
            texture.noise_scale = args.noise_scale
            texture.noise_depth = 3
            mod = obj.modifiers.new('Feathers', 'DISPLACE')
            mod.texture = texture
            mod.strength = args.noise
            mod.mid_level = 0.5
            mod.direction = 'NORMAL'
            move_before_armature(obj, mod)
        refined += 1
    export = dict(filepath=args.output, export_format='GLB', export_apply=True, export_animations=True, export_skins=True, export_yup=True)
    try:
        bpy.ops.export_scene.gltf(**export, export_vertex_color='ACTIVE')
    except TypeError:
        bpy.ops.export_scene.gltf(**export)
    print(f'REFINED {refined} meshes -> {args.output}')
    return refined


if __name__ == '__main__':
    # The Windows Store build launches detached, so the caller learns the outcome from these files.
    import json, traceback
    output_path = parse().output
    try:
        count = main()
        with open(output_path + '.done', 'w', encoding='utf-8') as handle:
            json.dump({'ok': True, 'meshes': count, 'blender': bpy.app.version_string}, handle)
    except Exception:
        with open(output_path + '.done', 'w', encoding='utf-8') as handle:
            json.dump({'ok': False, 'error': traceback.format_exc()}, handle)
        raise
