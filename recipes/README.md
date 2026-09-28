# Reproducible concept recipes

These source recipes exercise the existing agent-meshes authoring interfaces.
They are editable starting points, not production assets or new CLI commands.
The Space to Grow sibling project consumes them as a visual acceptance fixture.
Recipes live in the source/plugin checkout's `recipes/` directory, not in the
immutable managed runtime. Copy them from that source location into authored
inputs; invoke all builds through the managed launcher as usual.

## Stylized characters

`stylized_character.py` exposes two layers:

- `geometry(parameters)` returns deterministic, named, metre-scale Y-up meshes
  using only the Python standard library. This supports fast parameter and
  geometry checks without Blender.
- `build_character(parameters)` creates Blender objects using the managed
  `agent_meshes_author` helpers. It converts Y-up to Blender Z-up, converts sRGB
  palette values to linear RGB, orients faces, and fuses intersecting garment and
  hand pieces into continuous surfaces. Export remains the build runner's job.

An authored source file can define:

```python
from stylized_character import build_character

def build():
    return build_character({
        'height': 1.82, 'age': 'adult', 'presentation': 'female',
        'species': 'human', 'vacuum': False, 'skin': '#b97d57',
        'hair': '#363544', 'accent': '#d47d48', 'eyes': '#507d76',
    })
```

Place the recipe alongside that source, then use the usual build configuration:

```json
{"version":1,"name":"character-study","blender":{"script":"character.py"},"output":"generated"}
```

Inputs are validated before geometry construction. Height is 0.7–2.5 metres;
age is `adult` or `child`; presentation is `female` or `male`; species is `human`
or `alien`; vacuum is a boolean; colors are six-digit hex values. Presentation
controls a small set of body and hair proportions, not a general identity model.
Unknown keys reject to prevent silent typos. Defaults are in `DEFAULTS`.

Face anatomy uses one shaped surface for cheeks, chin, orbital recesses, nose
bridge and lips. Almond eye surfaces, eyelids, ear helices and hair remain named
meshes. Limbs taper through anatomical landmarks. Boots have a heel, instep,
forefoot and tapered toe. Children change proportions, not just overall scale.
Aliens add a third eye and sensory fronds. Suits use the same body plan.

The geometry builder produces a static base. The optional shared walk adapter
below adds a skeletal animation study; neither path is UV-unwrapped or designed
for facial deformation. The recipe removes only detached remesh chips with at
most 12 vertices, under two voxel widths and under 0.1% of the main component.
Larger disconnected pieces reject. The final union must be one closed component.
After fusion, jacket and trouser surfaces are limited to 6,000 triangles each;
each hand is limited to 1,600. The reduced mesh is checked again for connectivity
and closed edges. This bounds the cost of a multi-character review lineup.
Voxel fusion checks connectivity and closed edges; it
does not prove good animation topology. Eye and hair surfaces intentionally have
open boundaries. Fine fingers require a close camera; assess game-camera
readability before choosing a production mesh budget.

## Vacuum suit and glass helmet

`vacuum: True` keeps the same living head (face, eyes, lids, mouth, hair; every head part is
flagged `head: True`) and seats it in a hollow bubble helmet fitted to that head:

- `helmet_fit(points, neck_radius)` takes the head's points (plus the chin lowered by 12% of the
  head's half height, room for `jawOpen`) and finds the smallest round ellipsoid (longest radius at
  most 1.3 times the shortest) that keeps every point 2.2 cm (`HELMET_CLEARANCE`) inside it, with a
  neck opening cut just below the lowest point. The size therefore follows the head, not the
  height: a child's larger-for-its-size head gives a smaller helmet than an adult's, and an alien's
  wide, fronded head gives its own shape. `ellipsoid_clearance` is the exact point-to-surface
  distance it checks with.
- `vacuum_helmet(m, fit, s, colors, show)` builds `helmet-glass` (the bubble surface over the face:
  a window in front of a plane leaning back 12 degrees, placed from the head so every `show` point,
  the face, eyes and ears from the back of the ears forward, sits well in front of it and the rim
  never crosses an ear; its `fit['window']` records it; a glass `material` of opacity
  0.16, IOR 1.5, double-sided, which exports as glTF `alphaMode: BLEND`), `helmet-shell` (the crown
  and back, 9 mm thick, on the same ellipsoid so glass and shell share their edge), gold
  `helmet-rim` and `helmet-neck-ring` tubes, a `helmet-glint` reflection arc, teal radio pods with
  gold caps on the shell behind the rim at ear height (never over an ear), and `helmet-neck-seal`
  down to the suit. The glass part carries its `fit` (center, radii, cut, opening, window, achieved
  clearance) and `extras.encloses` (below).
- `fieldwork_suit(m, dims, colors)` and `fieldwork_colors(parts)` give the suit pressure-suit
  direction A, Fieldwork: cream suit, teal shoulder, elbow and knee pads and gloves, olive belt and
  thigh pouches, dark chest straps, a life-support backpack and olive-brown boots (`FIELDWORK`).

The helmet, head and hair all bind rigidly to the head bone (`stylized_walk.skin_weights`), so no
clip phase moves the face toward the glass; the neck seal blends from the chest to the head. Suit
kit rides the bone under it. The tests check 1.5 to 4 cm between face or hair and the actual glass
and shell triangles for the whole reference cast.

The glass also declares what it holds, as glTF node extras that `build_character` writes through
`agent_meshes_extras`: `encloses: {parts: [every head part], with: ['helmet-shell'], clearance:
0.015, maxClearance: 0.04}`. Every agent-meshes build (and `agent-meshes verify <glb>`) poses the
GLB at rest, at every keyframe and 24 phases of every clip, and with each morph target at full
weight, and fails if any head, ear or hair vertex comes within 1.5 cm of the bubble or leaves it, or
if the bubble is more than 4 cm from everything it holds (see `src/enclosure.ts`). A face rig that
adds morphs (blinks, `jawOpen`) or eye bones is checked the same way; one that adds or renames head
geometry must keep it in `parts` (flag it `head: True`) and pass its points to `helmet_fit`.

Run the pure geometry contract with `python tests/stylized_character.py`. Build
representatives of every body plan through Blender and inspect the exported GLB;
pure geometry checks do not test voxel fusion. Do not substitute a validator for
front, side, face and foot visual review.

## Shared character walk and light jog

`stylized_walk.py` adds body-plan-aware, in-place walk and light jog loops to these
characters. Keep it beside `stylized_character.py`, or embed both modules into a
single generated source before its `build()` entry point:

```python
from stylized_character import build_character, landmarks
from stylized_walk import rig_character

def build():
    definition = {'height': 1.22, 'age': 'child', 'presentation': 'female'}
    return rig_character(build_character(definition), landmarks(definition),
                         duration=1.1, jog_duration=.75)
```

`landmarks()` is shared by the anatomy and rig, so child proportions and alien
heads do not need hand-placed joints. The rig has 16 bones prefixed `rig-` to
avoid collisions with mesh names. Named garments use up to four normalized
bone influences; heads, hands, footwear and attached equipment use rigid skin
weights. Bindings are specific to the named output of this character recipe,
not an automatic rigger for arbitrary imported characters.

Pure helpers `rest_bones(layout)`, `gait_pose(layout, phase, gait)`, `walk_pose`,
`jog_pose`, `gait_rotations` and `skin_weights` expose reproducible measurements.
`gait_settings('walk'|'jog')` records dimensionless stride, stance and swing lift.
Walking uses 60% stance and a stride of 0.43 times leg length; jogging uses 42%
stance and a stride of 0.50 times leg length, with two short flight intervals.
Translate the actor by `leg_length * stride / (stance * duration)` metres/second
to hold world contacts still. Clips themselves stay in place.

Quintic swing trajectories match stance position, velocity and acceleration.
Two-link IK preserves limb lengths. The pelvis shifts laterally and rotates
against the chest; arms have elbow bend and phase-offset follow-through. The jog
adds forward lean and stronger lift. Explicit torso frames preserve axial twist
in Blender, which joint head/tail locations alone cannot represent. The shirt hem
follows the pelvis while the chest follows the spine. Boots rock from heel-led
landing through flat support to toe-off and recovery. `foot_target` compensates
the ankle around pivots derived from the actual outsole mesh, preserving ground
contact while the boot rotates. There are no separate toe joints, secondary hair
motion or facial animation.

`rig_character` bakes a `walk` action and, when `jog_duration` is provided, a `jog`
action at 60 Hz from frame zero with identical loop endpoints. Omitting
`jog_duration` preserves the single-clip API. Durations are 0.6–3 seconds and
round to the nearest even frame count, so both feet's touchdowns fall on keys.
Named NLA tracks retain both clips during GLB export.
Mesh objects retain Armature modifiers but are detached from the rig's object
parent so glTF skins export as scene roots without parent-transform warnings.
The returned list includes the rig; pass the complete list to the managed build.

Run `python tests/stylized_walk.py` for anatomy/height sweeps, contact position,
velocity and acceleration continuity, loop closure, segment lengths, torso and
elbow articulation, stance height and skin weights. Exported skinning still needs browser verification:
measure actual skinned outsole vertices at stance and compare both loop endpoints,
then inspect side-view frames. Pure joint targets cannot prove the exported mesh
follows them. The Space to Grow consumer keeps these checks in `scripts/check-motion.mjs`
and tests playback controls in `scripts/check-walk-ui.mjs`.

## Living faces

`stylized_face.py` gives these characters an `arkit-face/1` face. A definition with `face: 'arkit'` leaves the
static study face out of `build_character`, and `add_face(objects, definition)` adds the living one to the rigged
character, on the rig's `head` bone:

```python
definition = {'height': 1.82, 'age': 'adult', 'presentation': 'male', 'face': 'arkit',
              'face_shape': {'years': 38, 'jaw_width': 1.3, 'brow': 1.6, 'beard': 'beard', 'beard_color': '#4a3222'}}
objects = add_face(rig_character(build_character(definition), landmarks(definition), duration=1.1), definition)
```

The head is MakeHuman's CC0 hm08 head (see `agent_meshes_hm08` in `scripts/blender_lib/README.md`), shaped by age,
presentation, the committed stylize target and `face_shape`. The face is cropped under the chin and grafted onto the
body's neck, so the body, garments, gait rig and helmet fit are untouched. `face_shape` accepts:

- `years`, `stylize`, `cartoon`;
- `eye_size`, `eye_spacing`, `eye_tilt`;
- `nose`, `nose_length`, `nose_width`, `nose_bridge`;
- `mouth_width`, `lips`, `smile`;
- `jaw_width`, `chin`, `chin_width`, `cheeks`, `brow`;
- `beard` (`none`, `stubble`, `beard`) and `beard_color`.

`cartoon` (0 to 1.5, default 0) pushes the face past the stylize target toward big-eyed, simple, warm board faces:
eyes about 1.4 times larger at 1, a small soft nose, no eye bags, a rounder lower face, lids resting on the iris, a
slight resting smile, level arched brows and wider irises.

`SHAPE_RANGES` gives the ranges. Children default to 7 (female) and 9 (male) years. The first face of a character
takes 15 to 90 seconds to build, because a search picks the lid settings that close its eyes cleanly. Run
`python tests/stylized_face.py` for:

- parameter effects;
- smoothness at rest and in every morph;
- under-eye volume, blink closure and no flips;
- the open jaw's rounded D, the closed-lip smile and frown;
- the cartoon strength, a dark open mouth with both tooth rows, and no pocket showing at rest;
- the beard.

The design is `docs/design/parametric-head.md`.

## Botanical kit

`botanical_kit.mjs` exports `foliageOperations({family, world, stage, seed, scale})`.
Its result is an ordinary operations array for `batch --dry-run` and `build`.

Families: `hardware-peanut`, `soup-tomato`, `fern`, `lantern-reed`, `moss`.
Worlds: `home`, `upside`. Stages: `seedling`, `mature`. Integer `seed` changes
placement reproducibly; it never chooses a harvest outcome. Positive `scale`
changes the whole plant. Prefix names when combining plants in one project.
Wild plant families are scenery studies, not additional crop recipes.

## Rebuild evidence

Keep parameters, recipe version, source hash, build configuration, exported GLB
validation and fixed camera captures together. A consumer may generate a
self-contained authored file by copying the recipe and appending its `build()`
entry point; that lets the existing authored-source SHA256 cover the whole recipe
and parameters. Space to Grow follows that approach. Generated copies are never
hand-edited.

The current CLI creates fixed PNG views for operations assets but only an HTML
preview for Blender-authored assets. `--no-preview-page` therefore gives no PNGs
for authored assets. Consumers must capture their exported GLBs with the viewer;
Space to Grow saves those outside build-owned model folders. This is a known
workflow gap for a separate tool change, not a reason to manually patch renders.
