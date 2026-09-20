---
name: mesh-rigging
description: Rig and animate agent-meshes models with bone hierarchies, rigid, linear or weighted bindings, two-link IK posing, mirrored assemblies, and keyframed clips such as walk cycles, idles and gaits.
when_to_use: Use when a model needs a skeleton, when parts should move with joints, when asked for a walk, trot, gallop, idle, sway, flap, wave or any animation clip in a GLB, or when a clip plays wrong, feet slide, or limbs pop.
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

Export and verify, then build with renders and read the contact sheet for each clip (one row of
frames per clip) before calling the animation done. The validator proves the GLB is well formed;
only the frames show whether the gait is convincing.
