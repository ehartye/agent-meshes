"""Prints the preview fit's body radii for a GLB as one JSON line, read from blender-preview.py's own functions:
blender -b --python preview-framing-probe.py -- <blender-preview.py> <model.glb> [<clip>]

`all` counts every mesh object as the fit did before it ignored helper objects, `rest` and `union` count what a render
shows, at rest and over the clip's sampled frames. A script that lacks a function reports null for what needs it."""
import importlib.util
import json
import sys
from pathlib import Path

import bpy

script, model, *clip = sys.argv[sys.argv.index('--') + 1:]
spec = importlib.util.spec_from_file_location('blender_preview', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

objects = module.build_objects(Path(model))
armatures = [o for o in objects if o.type == 'ARMATURE']
meshes = [o for o in objects if o.type == 'MESH']
for armature in armatures: armature.data.pose_position = 'REST'
module.set_pose(meshes, {})
shown = getattr(module, 'rendered_only', lambda m: m)(meshes)
result = {'all': module.framing(meshes, None)['body'][1], 'rest': module.framing(shown, None)['body'][1], 'union': None, 'excluded': sorted(o.name for o in meshes if o not in shown)}
if clip and hasattr(module, 'clip_samples'):
    action = next(a for a in bpy.data.actions if a.name == clip[0])
    for armature in armatures:
        armature.data.pose_position = 'POSE'
        armature.animation_data_create()
        armature.animation_data.action = action
    result['union'] = module.framing(shown, None, module.clip_samples(*action.frame_range))['body'][1]
print('FRAMING ' + json.dumps(result))
