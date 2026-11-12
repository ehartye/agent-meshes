# Recipes and Blender helpers

The `recipes/` folder of the source checkout holds editable starting points; the full text, parameters and checks are in
[recipes/README.md](../../../recipes/README.md). Copy a recipe from the source checkout into the project's authored
inputs and build it through the managed launcher; recipes are not in the managed runtime and are not CLI commands.

## Reference heads (Blender)

Each is one source and a `build.json` in its own folder, built only from `agent_meshes_author` and `agent_meshes_face`,
declaring `arkit-face/1`. Copy the folder and set the config's `output`.

- `heads/pip/pip_head.py`: an organic head on one continuous skin, with sculpted cheeks, soft lips, ears, brows laid on the skin and hair.
- `heads/bolt/bolt_head.py`: a rigid mechanical head with shutter-blade eyes, brow plates and one rubber mouth aperture.
- `heads/mossjaw/mossjaw_head.py`: a wide creature head with slit-pupil eyes, a brow ridge, tooth rows and a low-hinged puppet jaw.

All three report known `arkit-face/1` failures under newer checks; [recipes/README.md](../../../recipes/README.md#reference-heads) lists them.

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
