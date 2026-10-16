# Blender Python API and Meshes helpers

`bpy` is Blender's Python API, executed inside Blender. The [CLI reference](blender-cli.md)
covers starting that process. Meshes' [helper API](../README.md) wraps selected
authoring tasks; it does not replace `bpy` or expose every native capability through JSON.

## Find the right API

| Work | Start here |
| --- | --- |
| Objects, meshes, UV/color attributes and materials | `bpy.data`, mesh/attribute data APIs; helper “Creating geometry” and “Image materials with authored UVs” |
| Skeleton fitting and weighted skin | Helper “Fitting a reference rig” and “Selecting anatomical skin sources”; `Armature`, `Bone`, `PoseBone`, vertex groups |
| Clothing topology, weights and posed fitting | Helper “Cutting weighted clothing”, “Relaxing garment skin weights” and “Fitting garment offsets through animation” |
| Clips, keyframes and exported animation ownership | `Action` slots/layers, F-curves, NLA tracks; helper export animation-mode contract |
| Evaluated pose/geometry measurements | Scene frame/subframe, dependency graph and evaluated objects; sample actual exported skin independently |
| Facial shapes and coordinated jaw/eyes | Helper “Face-rig helpers”; retain its explicit morph and deformation contract |
| Static props | Helper “Static props”; avoid unnecessary armature/face operations |

Read the named section of the helper README before reimplementing a supported
operation. Resolve helpers from the executing package, not a sibling checkout or
an arbitrary user path. A vendored helper must record its source/version.

## Data API, operators and coordinate ownership

Prefer direct data APIs for deterministic creation and inspection. `bpy.ops` can
depend on active object, selection, object/edit/pose mode and editor context.
When an operator is necessary, establish its context and restore caller-owned
state in `finally`. Inspect its RNA signature rather than guessing parameter names:

```python
import bpy
print(bpy.app.version_string)
print(bpy.types.ArmatureModifier.bl_rna.properties.keys())
print(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
```

Blender uses Z-up; Meshes JSON uses Y-up. Record the source, skeleton, armature-local,
object and exported/world frames. `bone.matrix_local`, `pose_bone.matrix_basis` and
`pose_bone.matrix` are different transforms. Compare world positions using the
armature object's transform. Do not assume a donor animation's rest frame matches
another library simply because bone names match.

Set `scene.frame_set(frame, subframe=...)` and update evaluation when measuring.
Read evaluated dependency-graph objects for modifier/pose output, release temporary
evaluated meshes, and preserve action, slot, NLA state and original frame. Do not
mistake raw mesh vertices for a posed surface.

## Useful native capabilities, with delivery limits

Native RNA inspection on Blender 5.2.2 LTS confirmed these interfaces exist. That
probe establishes availability, not effectiveness on a particular character.

| Capability | Appropriate investigation | What must still be checked |
| --- | --- | --- |
| Armature `use_deform_preserve_volume` | Compare joint volume loss in native poses | Destination skinning must reproduce the intended deformation; a native checkbox is not a portable GLB deformation solver |
| Corrective Smooth (`rest_source`, bind, factor/iterations) | Diagnose pose-induced surface distortion after binding | Rest/bind topology, intended boundaries and actual exported poses; smoothing cannot construct a missing vest shoulder |
| Shrinkwrap (target, offset, wrap method) | Fit a deliberate garment region to a target surface | Anatomical target restrictions, layer order and clearance across motion; nearest surface can select an unrelated limb |
| Data Transfer (vertex-data type and mapping) | Transfer appropriate attributes/weights from an explicit donor | Frames, donor regions, normalized influences and cross-limb leakage |
| F-curves, keyframes and modifiers | Inspect interpolation, timing, loop seams and trajectory changes | Resampled exported motion, contact velocity and real-speed playback; smoothing a curve may erase a strike or foot plant |
| Action slots/layers and NLA | Keep object, armature and morph animation ownership explicit | Version-specific access and actual exporter mode/track naming; source animation UI organization is not exported clip identity |

The pinned 5.2.2 exporter skin collector emits joints and inverse bind matrices;
it does not serialize the entire Blender modifier stack as a runtime solver.
Treat baked mesh changes, bone animation and morph animation as distinct delivery
choices and compare native and reimported/exported poses. Do not enable every
modifier because it is available. Identify the source defect first.

## Character diagnosis

Use construction geometry for fit: seat a hat against forehead/temple/skull
landmarks and inspect ears, rear and underside; construct a vest surface over the
shoulder crest to the back with actual neck and armhole boundaries. Then transfer
consistent anatomical weights and inspect required poses. More roughness or
normal detail cannot supply missing cloth structure.

For motion, inspect pelvis/foot trajectories, loop position and velocity seams,
contact intervals and transitions before changing playback rate. Measure native
bones, exported skinned soles and game-world support separately. A correct donor
cycle or bone-direction residual cannot prove live foot contact, acting cadence,
weapon grip or strike timing. See [consumer patterns](consumer-patterns.md) and
the [construction checklist](character-construction.md).

Official navigation: [Blender Python API](https://docs.blender.org/api/current/),
[API gotchas](https://docs.blender.org/api/current/info_gotchas.html).
Source inspection used Blender tag `v5.2.2`, commit
`d13f752e3b9c4f8c261cda552b1021f8bcc0382c`: `MOD_armature.cc`,
`MOD_correctivesmooth.cc`, and glTF export `skins.py`. Future-version API links
require checking against the selected runtime; this reference claims no general
modifier-to-glTF parity.
