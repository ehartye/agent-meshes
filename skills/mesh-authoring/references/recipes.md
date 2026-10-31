# Recipes and Blender helpers

The `recipes/` folder of the source checkout holds editable starting points; the full text, parameters and checks are in
[recipes/README.md](../../../recipes/README.md). Copy a recipe from the source checkout into the project's authored
inputs and build it through the managed launcher; recipes are not in the managed runtime and are not CLI commands.

## Character and face (Blender)

- `stylized_character.py`: `build_character(parameters)` makes a named, metre-scale human or alien character (height 0.7 to 2.5 m, adult or child, female or male, optional `vacuum` suit and glass helmet); `geometry(parameters)` is the same shape without Blender.
- `stylized_walk.py`: `rig_character(...)` adds a 16-bone rig and an in-place `walk` clip, and a `jog` clip when `jog_duration` is given, to that character.
- `stylized_face.py`: `add_face(...)` gives the rigged character an `arkit-face/1` face on the MakeHuman hm08 head (`face: 'arkit'`, shaped by `face_shape`).
- `face_project.py` with `face-project.build.json`: an editable project entrypoint that composes the three modules above with an explicit `recipe=`; copy all of them together.

## Operations and sets (Node)

- `botanical_kit.mjs`: `foliageOperations({family, world, stage, seed, scale})` returns an operations array for plants (`hardware-peanut`, `soup-tomato`, `fern`, `lantern-reed`, `moss`), for `batch --dry-run` or `build`.
- `set-stats.mjs`: per-GLB triangle, material, pivot and height budget table for a set of static props; exits 1 when a flag fires.
- `set-sheet.mjs`: one labelled contact sheet of a set of GLBs from a shared fixed camera; needs the managed runtime.
- `lib/glb.mjs`: the GLB reader both set tools share; keep it beside them.

The creature kinds `biped`, `equine`, `vulpine`, `insectoid`, `arachnid` and `strandbeest` are not files: they are
`recipe <kind>` in the CLI (see [mesh-authoring](../SKILL.md)).

## Hanging cloth flaps

A garment panel that hangs below the waist and must clear the body through a baked walk is a hinged panel on
kinematic bones, not a cloth simulation. `agent_meshes_cloth_flap.rig_flaps(...)` adds the hinge bones and keys them
from the body's sampled clearance. Read
[Hanging cloth flaps](../../../scripts/blender_lib/README.md#hanging-cloth-flaps) for its arguments, the 85-degree
rejection and what it does not cover, and check the result with `check-garments` (see
[mesh-quality-review](../../mesh-quality-review/SKILL.md)).
