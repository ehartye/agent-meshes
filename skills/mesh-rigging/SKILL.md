---
name: mesh-rigging
description: Rig and animate agent-meshes models with bone hierarchies, rigid, linear or weighted bindings, two-link IK posing, mirrored assemblies, keyframed clips such as walk cycles, idles and gaits, and ARKit face rigs for talking heads (eyelids, eye bones, a toothed puppet jaw, the arkit-face/1 contract).
when_to_use: Use when a model needs a skeleton, when parts should move with joints, when asked for a walk, trot, gallop, idle, sway, flap, wave or any animation clip in a GLB, when a clip plays wrong, feet slide, or limbs pop, or when a head needs blendshapes, blinking or squinting lids, gaze, emotions or a talking jaw with teeth.
---

# Mesh rigging and animation

Load `mesh-setup` first. Commands run through the managed launcher (`mesh` below):
`node "<plugin-root>/scripts/run-managed.js" --workspace <dir> batch <file>`. Field shapes for
every operation are in [operations](../mesh-authoring/references/operations.md).

## Build the skeleton before binding

1. Add bones root-first: `bone.add` with `parent` and a `position` relative to the parent bone.
   Put each bone at the joint it rotates about, not at the center of the limb.
2. Model one side, then `bone.mirror` (bones only) or `assembly.copy` with `mirror` (bones,
   bound parts and clips) for the other side.
3. Bind each part: `rigid` for solid pieces, `linear` for a segment spanning two joints, a shell
   over rigid parts for a smooth skin. Groups cannot be bound. Unbind before editing bound
   geometry or the rest skeleton; ordinary posing keeps the bind pose.
4. `inspect bone:<name>` shows rest transforms, children and bound parts; use it to check the
   hierarchy before animating.

## Pose, then key

`pose` sets a quaternion offset from rest. Convert from degrees about one axis with
half-angle sine and cosine: 30° about x is `[0.2588, 0, 0, 0.9659]`. `pose.target` reaches a
world-space point with a three-bone chain and a `pole` that picks which way the middle joint
bends. Poses are for inspection and for reading values back with `inspect`; a clip stores them.

`clip.set` writes the whole clip at once: a `duration` and one track per bone and property with
keys at strictly increasing times from 0 through the duration. First and last keys equal make a
seamless loop. Tracks are offsets from rest, so an untracked bone stays put.

## Locomotion that reads right

- Clips are in place: stance feet move backward at a uniform speed while lifted feet return
  forward, and the game moves the root. Ground speed is `stride / (stance fraction × duration)`.
- Sample leg rotations densely (recipes bake at 60 samples per second, quadrupeds at 120) so
  feet stay planted; sparse keys make feet slide.
- Compensate root bob in the foot targets, otherwise the whole body floats. Check a stride by
  reading the foot bone's world y over the clip and requiring the stance minimum to stay within
  a centimeter of ground; the puppet API in [mesh-build](../mesh-build/SKILL.md) can do it.
- Order the footfalls: walk is a four-beat lateral sequence, trot pairs diagonals, gallop has a
  suspension phase. The quadruped recipes carry all three (`--gaits walk,trot,gallop`).
- Keep joint ranges anatomical. A knee that bends forward or a hoof that passes through the
  shin reads wrong even in a contact sheet.

## Start from a recipe when one fits

`recipe biped|equine|vulpine|insectoid|arachnid|strandbeest` produces a complete rig with
clips. Edit the result with batches rather than building a walk from nothing; a fox with a
different head is a `vulpine` recipe plus a few `update` and `add` operations.

## Verify

Export and verify, then build with renders and read the contact sheet for each clip (eight
perspective frames in two rows of four) before calling the animation done. The validator proves
the GLB is well formed; only the frames show whether the gait is convincing, and foot sliding
cannot be judged from a perspective sheet at all: run the stride check above for that.

## Talking-head face rigs

Faces with blendshapes are authored in Blender (a `build.json` with a `blender` script, see
mesh-build) with the face-rig helpers, which follow the `arkit-face/1` contract: one skin with
`head`, `eye_L` and `eye_R` (left is the character's left, +X), the 21 required ARKit morphs at
zero rest weight, and `extras.arkitFace` on the root. Read the "Face-rig helpers" section of
`<plugin-root>/scripts/blender_lib/README.md` for the API, and copy the working heads in
`<plugin-root>/tests/fixtures/face-rig/` (`test_head.py` with lids and a puppet jaw,
`test_robot.py` with shutters and a chin plate, `test_frog.py` with lid domes, brow ridges and
exposed fangs). The rules that are easy to get wrong:

- Morphs are linear: a lid swept across a round eye as one morph cuts into the eyeball
  mid-blink. Use `build_eye(..., style='lid')` (the lid radius is solved for 0.5 mm clearance at
  every weight) or `style='shutter'`; do not hand-roll lid morphs.
- A puppet jaw drops the chin, not only the lips. Hinge it at the back of the head, level with
  the mouth line (by the ears): `jaw = JawHinge.ear(head_vertices, mouth_z, half_width)`. A pivot
  in the middle of the head swings the chin back and up and only opens a hole at the lips. Drive
  `jawOpen` on every jaw-carried part from that one jaw: `add_jaw_open(skin, jaw, min_chin_drop=.1)`
  (rejects a chin that drops less than 10% of the head), and `rigid=True` for the lower teeth,
  tongue or a robot chin plate.
- Cut the lip seam with `slit_mouth` (it tags the upper and lower lip, so float rounding of the
  mouth line never hangs the upper lip on the jaw). Add a dark `mouth_cavity_geometry` bag fitted
  to the face with `surface=front_surface(skin_vertices, skin_faces)` so it never pokes through the
  cheeks, and make fangs or buck teeth with `exposed_teeth_geometry` (declared in `exposedTeeth`).
- Cut eye holes with `cut_hole` (a smooth rim), not `cut_faces` (stair steps). Brows on eye domes
  (a frog) are `brow_ridge_geometry` ridges that slide over the lid dome.
- Put every morph-bearing part in one mesh with `join_face_parts`: Unreal discards all morph
  names when a name repeats across glTF meshes. Keep only the eyeballs separate.
- Name teeth materials `teeth_upper` and `teeth_lower`, and write the extras with
  `face_contract(rig, objects, yaw_max, pitch_max, exposed_teeth=[...])`.
- Gaze is eye-bone rotation, not morphs: yaw about the eye bone's local Y, pitch about local X.

Check every build with `mesh verify <head>.glb --contract arkit-face/1` (mesh-build) and look at
blink, squint, jaw and emotion renders (front and three-quarter, jawOpen 0, .5 and 1) before calling
the head done.
