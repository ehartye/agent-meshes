# Editable concept recipes

These source recipes exercise the existing agent-meshes authoring interfaces.
They are editable starting points, not production assets or new CLI commands.
A consuming game project uses them as a visual acceptance fixture.
Recipes live in the source/plugin checkout's `recipes/` directory, not in the
immutable managed runtime. Copy them from that source location into authored
inputs; invoke all builds through the managed launcher as usual. These recipes
show particular constructions, proportions and palettes. Reuse the lesson that
fits a new brief rather than treating a passing study as a required design.
See [face design](../skills/mesh-rigging/references/face-design.md) and
[native build identity](../skills/mesh-build/references/native-build-identity.md)
for project ownership, selected helpers and declared dependency limitations.

## Reference heads

`heads/` holds three complete talking heads, each one Blender source and one build config:

| Head | Source | What it shows |
| --- | --- | --- |
| Pip | `heads/pip/pip_head.py` | An organic head on one continuous skin: an SDF blank with sculpted cheeks, eye holes, soft lips, a button nose, ears, freckles, brows laid on the skin and hair |
| Bolt | `heads/bolt/bolt_head.py` | A rigid mechanical head: camera-lens eyes behind shutter blades, riveted brow plates, and one rubber mouth aperture between metal parts |
| Mossjaw | `heads/mossjaw/mossjaw_head.py` | A wide creature head: large slit-pupil eyes, a heavy brow ridge, tooth rows and a low-hinged puppet jaw that stretches the throat |

Every head is built only from the shared face helpers (`agent_meshes_author`, `agent_meshes_face`) and declares the
`arkit-face/1` contract with `face_contract`. A source holds its character alone: proportions, colors, parameters and
emotion tuning. Rig logic that more than one head would need belongs in the helpers. Places where a source carries a
local stand-in for something the helpers lack are marked `TOOL-GAP`.

Copy one head's folder into the project's authored inputs, set the config's `output`, and build it:

```text
agent-meshes build heads/pip/build.json
agent-meshes verify <output>/model.glb --contract arkit-face/1
```

In this checkout the configs write to the ignored `artifacts/heads/<id>/` folder. A build takes about ten seconds for
Bolt and about a minute and a half for Pip and Mossjaw.

**Known contract failures.** The heads were written for shell lids and an earlier contract, and each reports failures
under checks added since:

- Pip: `eye-crease` and `lid-penetration` (shell lids), and `mouth-skin-intersection` (the front teeth cross the lip
  at `mouthFunnel`).
- Bolt: `attached-parts` (trim stands off the can) and `mouth-skin-intersection` (the mouth box crosses the chin plate).
- Mossjaw: `eye-crease` and `lid-penetration` (shell lids).

They call `eye_holes(..., style='shells')` to keep the look they were drawn with. New heads should take the default
continuous lids, which those eye checks expect. `tests/face-rig-blender.test.ts` builds all three and holds each
failure count as a ceiling; `python tests/reference_heads.py` checks the sources without Blender.

Use a head as a worked example of composing the helpers, not as a required style. See
[face design](../skills/mesh-rigging/references/face-design.md) for choosing the motion and contract first.

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
entry point; that lets the entry SHA256 cover the combined recipe and parameters.
A consuming project follows that approach. Generated copies are never hand-edited.
An entry hash alone does not cover external imports or donor data: prefer explicit
project imports and declared inputs in new integrations, with reviewed toolchain
pins. Generated combined files remain a supported compatibility route.

A build writes fixed PNG views of the built GLB for operations and Blender-authored assets alike: `front.png`,
`side.png` and `perspective.png`, plus one `<clip>-contact.png` contact sheet per animation clip (since 0.33.0; a
Blender-authored build renders them through Blender and needs no Chromium). `--no-preview-page` keeps those PNGs and
skips only the standalone `preview.html` (and removes an earlier one); `--no-preview` skips both. A consumer that wants
other cameras or sizes captures its exported GLBs with the viewer and saves those outside build-owned model folders.

## Static set tools

`set-sheet.mjs` and `set-stats.mjs` check a set of static GLBs (a chess set, a furniture kit) together. They are plain Node
scripts: copy or run them from the source checkout, no build step. `lib/glb.mjs` is the shared GLB reader (node matrices
applied to every vertex); keep it beside them.

```text
node recipes/set-stats.mjs [--max-tris N] [--budget <regex>=N ...] [--max-materials N] [--require-named-materials]
                           [--pivot bottom-centre|bottom|none] [--expect-height H] [--tolerance M] [--json] a.glb b.glb ...
node recipes/set-sheet.mjs [--out sheet.png] [--views front,side,q34,top] [--camera name=px,py,pz>tx,ty,tz]
                           [--target x,y,z --dist D] [--size WxH] [--crop-bottom F] [--supersample N] [--cell-scale S]
                           [--background css] [--label '{name} {view}' | --no-labels] [--frames dir] [--json] a.glb b.glb ...
```

- `set-stats` exits 1 when a flag fires (triangle budget, material count, unnamed or unused materials, the lowest point not on
  y = 0, the base centre off the origin, wrong height) and prints one `FLAG` line each. `--budget` matches the file path with a
  regex, first match wins, so one call covers pieces with different budgets.
- `set-sheet` gives every cell the same camera: 38 degree vertical field of view, target and distance from the union bounds of
  all models unless you pass them. Built-in views are `front` (from +Z), `side` (from +X), `q34`, `top`, `back` and `back-q34`.
  `--crop-bottom 0.3` keeps the lower 30% of each frame at twice the render size, for bases and plinth junctions. It needs the
  managed runtime (`mesh-setup`) for the viewer and Chromium; `--runtime-root` names an installed release explicitly.
- Both are covered by `tests/set-recipes.test.ts`.
