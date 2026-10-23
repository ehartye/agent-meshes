---
name: mesh-rigging
description: Rig and animate agent-meshes models with bone hierarchies, rigid, linear or weighted bindings, two-link IK posing, mirrored assemblies, keyframed clips such as walk cycles, idles and gaits, and ARKit face rigs for talking heads (eyelids, eye bones, a toothed puppet jaw, the arkit-face/1 contract).
when_to_use: Use when a model needs a skeleton, when parts should move with joints, when asked for a walk, trot, gallop, idle, sway, flap, wave or any animation clip in a GLB, when a clip plays wrong, feet slide, or limbs pop, or when a head needs blendshapes, blinking or squinting lids, gaze, emotions or a talking jaw with teeth.
---

# Mesh rigging and animation

For native Blender skeletons, weights, modifiers and actions, read the
[Blender Python API reference](../../scripts/blender_lib/references/blender-api.md).
For background execution and completion checks, read the
[Blender CLI reference](../../scripts/blender_lib/references/blender-cli.md).

For human/animal motion donors, rigging templates, portable retargeting and
skinning backends, read the [organized rig library](../../scripts/blender_lib/references/rig-library.md).

Before placing character joints or binding skin/garments, read the
[construction checklist](../../scripts/blender_lib/references/character-construction.md).
Use anatomical bend locations and explicit donor regions; preserve approved proportions.
Use the [mannequin library](../../scripts/blender_lib/references/mannequin-library.md)
for shipped human/alien reference GLBs and donor-selection limits. Read
[character craft](../../scripts/blender_lib/references/character-craft.md) when a
pivot, body plan or deforming surface needs construction decisions. For clip/manual
gaze ownership and exported/native motion evidence, use
[consumer patterns](../../scripts/blender_lib/references/consumer-patterns.md).

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

**Axes and signs.** Models are right-handed with +Y up, and the `biped` recipe faces +Z (the glTF front);
its `_L` parts sit at -X and its `_R` parts at +X. A rotation follows the right-hand rule, so +X tips +Y
toward +Z. A limb hangs down from its joint, so on the biped:

| Joint | Rotation about X | Result |
|---|---|---|
| Arm or hip (`arm_*`, `leg_*_hip`) | negative | swings the limb forward (+Z) |
| Arm or hip | positive | swings it back |
| Knee (`leg_*_knee`) | positive | bends the knee and swings the foot back |
| Chest | positive | leans the body forward |

`{"op":"pose","name":"arm_R","rotation":[-0.2588,0,0,0.9659]}` swings the right arm 30° forward. Clip
keys use the same signs. Check a recipe other than the biped with one `pose` and `inspect` before keying.

**Biped names.** Bones: `root` (the pelvis, which carries the body bob), `chest`, `head`, `arm_L|R`,
`elbow_L|R`, and per leg `leg_L|R_hip`, `leg_L|R_knee` and `leg_L|R_ankle`. `leg_L_foot`, `hand_L` and the
other limb pieces are parts bound to those bones, not bones. The ankle bone rests 0.10 m above the floor and
the foot's lowest vertex about 0.02 m above it, so track a sole by following the ankle and offsetting down
to the floor. `_L` parts sit at -X, which is the character's anatomical right.

`clip.set` writes the whole clip at once: a `duration` and one track per bone and property with
keys at strictly increasing times from 0 through the duration. First and last keys equal make a
seamless loop. Tracks are offsets from rest, so an untracked bone stays put.

## Locomotion that reads right

- Clips are in place: stance feet move backward at a uniform speed while lifted feet return
  forward, and the game moves the root. Ground speed is `stride / (stance fraction × duration)`.
- Measure slide without a browser: `mesh gait model.glb --clip walk --travel-speed <mps>`. `skate` is the
  largest planted-sole speed over the ground as a fraction of travel speed (0.1 or less reads as planted);
  `stanceSpeedRatio` is about 1 when the clip's design speed equals the speed the game moves the character.
  Without `--travel-speed`, `stride.travelSpeed` is the clip's own design speed. The `biped` recipe's walk is
  planted at a design speed of 0.70 m/s; the same clip moved at 0.99 m/s measured `skate` 0.32. Match the
  speeds by setting the playback rate to travel speed over design speed, or by changing the clip duration.
  The biped recipe does the second for you: `recipe biped --gaits walk,run --speed '{"walk":0.99,"run":3.5}'`
  sets each cycle to stride / (stance fraction × speed) (0.3 to 4 s), and `mesh gait` then reports that speed as the clip's own.
  `gait` reads the recipe's bone names; its humanoid checks (spine flex, hands, `--gait walk`) do not apply.
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

## Faces: choose the motion and consumer contract first

A face can be static, rigid mechanical parts, a small custom morph set, or a
complete talking-head rig. Ask which expressions and engine behavior the brief
actually needs. Select the authoring route through
[mesh-tool-selection](../mesh-tool-selection/SKILL.md), then read
[face design and composition](references/face-design.md) for failure diagnosis,
helper choices and ownership. A Blender implementation can use individual helpers;
blendshapes alone do not require `arkit-face/1` or the hm08 head topology.

Keep design constants, references, landmark placement and the editable entrypoint
in the consuming project. Import version-pinned shared mechanics for geometry and
Blender adaptation. Deliver the exported GLB to the app; the app does not execute
these Python helpers at runtime. Vendor the complete dependency/data/license set
only when deliberately taking ownership of a fork or archive.

When the consumer needs the supported 21-morph/eye-bone contract, read the
[optional arkit-face/1 profile](references/arkit-face.md). It retains the detailed
helper and verifier rules. Those contract checks gate our supported implementation;
cast dimensions, palettes and hood/face proportions remain example choices.
Verify the exported asset in its actual consumer, including rest and intermediate
poses; a well-formed GLB or a passing example suite does not establish visual
quality or that the guidance saves time on a different brief.
