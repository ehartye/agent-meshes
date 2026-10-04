---
name: mesh-authoring
description: Author 3D models with agent-meshes as named parts through JSON operations in a durable workspace, including primitives, lathe and prism shapes, bone-anchored placement, organic shells, and the creature recipes.
when_to_use: Use when asked to make, model, or edit a 3D object, character, creature, prop, sculpture or machine as a GLB, to load a biped, equine, vulpine, insectoid, arachnid or strandbeest recipe, or when an agent-meshes operation fails validation.
---

# Mesh authoring

For skinned characters, clothing or hair, read the
[construction checklist](../../scripts/blender_lib/references/character-construction.md)
before authoring. Preserve approved proportions and define ownership before binding.

Load `mesh-setup` and pass its check before the first command in a session. Every command below
runs through the managed launcher, written here as `mesh`:

```text
node "<plugin-root>/scripts/run-managed.js" --workspace <dir> <command> ...
```

Resolve `<plugin-root>` from this loaded skill (two parents up). Read
[CLI setup](references/cli-setup.md) for checked shell helpers. Stop after a failed command; the
CLI prints one JSON line and exits nonzero with `error` and details.

## Workspace

`--workspace <dir>` keeps the project on disk with undo history and a revision counter; no server
runs. Use one workspace per model, inside the project you are working in (for example
`.agent-meshes/<name>`), and keep it out of version control. `--expect-revision <n>` refuses a
mutation when someone else changed the workspace first.

```text
mesh --workspace .agent-meshes/fox recipe vulpine --gaits walk,trot
mesh --workspace .agent-meshes/fox inspect                 # parts, bones, clips summary
mesh --workspace .agent-meshes/fox inspect part:head       # or bone:<name>, clip:<name>
mesh --workspace .agent-meshes/fox batch edits.json --dry-run
mesh --workspace .agent-meshes/fox batch edits.json
mesh --workspace .agent-meshes/fox undo
mesh --workspace .agent-meshes/fox save fox.mesh.json
mesh --workspace .agent-meshes/fox export fox.glb
```

`capabilities` prints the versioned JSON schema, defaults and one example per operation (about 40 KB
on one line). Read one contract instead of the whole dump with `capabilities lathe`,
`capabilities prism` or `capabilities shell.set`; it prints that geometry's or operation's
conventions, schema and examples. Coordinates are meters, +Y up, rotations are unit quaternions
`[x,y,z,w]` or, easier, `rotationEuler: [x,y,z]` degrees (three.js XYZ order: world z first, then y,
then x; positive angles are right-handed, so +x rotation takes +y toward +z). Give one, not both.

## Operations

Write operations to a JSON file as an array and apply them with `batch` (atomic, one undo step).
`--dry-run` validates every intermediate state and reports the zero-based `operationIndex` that
fails, without changing anything. Always dry-run a batch you have not applied before.

| Operation | Purpose |
| --- | --- |
| `add` | A named part: `box`, `sphere`, `cylinder`, `cone`, `capsule`, `lathe` (`[radius,height]` profile), `prism` (`[x,y]` outline) or `group`; `size` scales the unit shape in meters, `segments` is the facet count around round shapes (a box ignores it) |
| `update`, `remove` | Edit or delete a part; `update` never renames; unbind before changing geometry |
| `shell.set`, `shell.remove` | Blend listed parts into one smooth surface (see mesh-believable) |
| `bone.*`, `bind`, `unbind`, `pose*`, `clip.*`, `assembly.copy` | Rigging and animation (see mesh-rigging) |

Parts nest with `parent`; a child's transform is relative to its parent part. `anchor: <bone>`
makes `position` and `rotation` relative to that bone's rest frame instead, which is how a hoof
or a hand is placed at the end of a limb without computing world coordinates. Names start with a
letter and contain letters, numbers, underscores, hyphens or dots, and are unique across parts and
bones. See [operations](references/operations.md) for a worked example of every operation.

## Turned and extruded shapes

Static props (a chess set, a tower, a column) need only `add` operations in a `build.json`
`operations` file; no workspace is required. The conventions that used to be found by experiment:

- **Unit lathe profile** (default): radius 0 to 0.5 and height -0.5 to 0.5, world radius
  `r * size[0]` (not `size[0] / 2`), height `h * size[1]`, centred on the part origin so the
  bottom is at `-size[1] / 2`. A zero-radius first or last point closes the cap.
- **Real units**: `"profileUnits":"metres"` takes `[radius, height]` in meters with height up from
  the part origin (start at 0 and the part stands on its origin) and ignores `size`. Prefer it for
  anything measured; it needs no normalise-and-offset helper.
- **Hard edges**: `"corners":[2,3]` splits normals at those profile points, so a ledge, collar or
  step is crisp while the surface between corners stays smooth around the circumference. It adds
  one vertex ring per corner and no triangles. Do not fake a corner with two points 0.4 mm apart.
- **Sectors**: `"angleRange":[45,90]` revolves one capped sector (a merlon, a wedge, an annular
  segment when the profile has an inner radius). With the same `segments` and `startAngle` as a
  full lathe it shares that lathe's vertex angles and sits exactly flush when its range ends are on
  the grid; pick `segments` divisible by the sector fraction (48 for eighths).
- **Horizontal prisms**: `"axis":"y"` with `"outlineUnits":"metres"` extrudes an `[x,z]` outline
  upward from the origin to `size[1]`; no quaternion math. `"bevel":0.004` chamfers the caps. The
  default prism outline is size-normalised (-0.5 to 0.5), which is what the "outline points must be
  within -0.5 to 0.5" error means.
- Shells cannot include parts that use these options.

When an operation fails the message names the zero-based operation index, the part, the field path,
the value and a hint; fix that one operation rather than guessing.

## Recipes

`recipe <kind>` replaces the workspace project with a rigged, animated creature to edit further.
Pick the kind by body plan: a person, robot or figure is `biped`; a horse, deer, donkey, cow or
any hoofed animal is `equine`; a fox, dog, cat, wolf or any pawed animal is `vulpine`; a beetle,
ant or six-legged bug is `insectoid`; a spider is `arachnid`; a walking machine is `strandbeest`.
Resize and recolor parts afterward to turn the fox into a cat or the horse into a deer. Options: `--gaits walk,trot,gallop`
(quadrupeds), `--shell` (quadrupeds; one smooth skin with lathe hooves), `--leg-phases <json>`
(insectoid; one clip per named set of six touchdown phases), `--pairs`, `--spacing`, `--patterns <json>`
(strandbeest; Jansen's real linkage: `--pairs` counts crank positions, at most 5, and each position
carries four legs, `leg_L_1f_*` front-facing and `leg_L_1b_*` back-facing on each side, so the feet
straddle the crankshaft). Recipes are deterministic project data, so a variation is
the recipe plus a batch of edits, kept as files so it can be rebuilt. To deliver a recipe-based
model, `save <name>.mesh.json` from the workspace and point `build.json` at it with
`"project":"<name>.mesh.json"` (see mesh-build).

A **talking head or any face with blendshapes** (blink, squint, gaze, emotions, a jaw with
teeth) is not a recipe or a JSON-operations model: author it in Blender with the face-rig
helpers and check it against the `arkit-face/1` contract. Read the face-rig section of
[mesh-rigging](../mesh-rigging/SKILL.md) first.
In Blender sources, `material(name, '#e8a27c', emission='#ffaa00')` takes sRGB hex colors straight
from a concept sheet (or linear tuples) and can glow (lens glass, a bulb). **Glass** is
`material(name, '#eaf6ff', roughness=.04, opacity=.16, ior=1.5)` (alphaMode BLEND, double-sided by
default; `transmission=1` for KHR_materials_transmission); in the operation model it is
`material: {opacity, transmission, ior, doubleSided}` ([operations](references/operations.md)).
The character recipe's vacuum suit shows the pattern: a helmet fitted to the head it holds
(`helmet_fit`), clear glass over a living face, an opaque shell and rims (recipes/README.md).

`recipe`, `state`, `save` and `open` print the whole project (a recipe is a few hundred kilobytes
of JSON on one line). Redirect that output to a file or trim it. `inspect` without a selector is
also one long line: counts first, then every part, bone and clip; read the counts, and use a
selector such as `inspect clip:walk` for one item.

## Static props and sets: use build.json only

A deliverable static prop, or a set of them (chess pieces, a furniture kit, props in colour variants), needs no
workspace, no `batch` and no undo history. Skip everything above `Operations` that mentions `--workspace`:

1. Write the operations in code, one function per piece, and emit `ops.json` plus a `build.json` per output.
2. `mesh build <dir>/build.json --no-preview` (about a second per piece) writes `dist/model.glb` and
   `verification.json`. Add `--preview` only for a final look.
3. Check the whole set at once with `recipes/set-stats.mjs` and `recipes/set-sheet.mjs` (see
   [mesh-build](../mesh-build/SKILL.md)); never judge a set from per-model auto-framed renders.

Parametrised variants come from one JS function, not from `build.json`, which has no variables or templating.
Generate the operations per variant and write one config for each:

```js
// pieces.mjs: the single source of truth. pieceOps(type, colour) returns agent-meshes operations.
const colours = { white: { color: '#e9ddc2', roughness: 0.55 }, black: { color: '#2a1d16', roughness: 0.45 } };
// A lathe from a profile in real metres [[radius, y], ...] with y from 0. The unit-profile convention is hidden here:
// radius = r * size[0] (NOT size[0] / 2), the part origin is the lathe centre, so its bottom is at -size[1] / 2.
function lathe(name, prof, mat, segments = 32) {
  const D = 2 * Math.max(...prof.map(p => p[0])), ymin = Math.min(...prof.map(p => p[1])), H = Math.max(...prof.map(p => p[1])) - ymin;
  return { op: 'add', part: { name, geometry: { type: 'lathe', size: [D, H, D], profile: prof.map(([r, y]) => [r / D, (y - ymin) / H - 0.5]), segments },
                              position: [0, ymin + H / 2, 0], ...mat } };
}
export const pieceOps = (type, colour) => pieces[type]({ color: colours[colour].color, material: { metalness: 0, roughness: colours[colour].roughness } });

// build.mjs: for each type x colour write work/<colour>_<type>/{ops.json,build.json}, then run the build.
fs.writeFileSync(join(dir, 'ops.json'), JSON.stringify(pieceOps(type, colour)));
fs.writeFileSync(join(dir, 'build.json'), JSON.stringify({ version: 1, name: `${colour}_${type}`, operations: 'ops.json', output: 'dist' }));
execFileSync('node', [runManaged, 'build', join(dir, 'build.json'), '--no-preview']);
```

Keep a shared piece (a base moulding, a collar) as a function returning profile points, so every piece composes the
same shape. Confirm which piece is the outlier with a side-by-side lineup before refactoring all of them.

**Materials (0.14.0 and later).** Give a part `material.name`; parts with the same name, colour and finish share one exported
glTF material, so a rook is no longer 7 materials. For a flat-colour prop:
- Name the material on every part (`"material": {"name": "PieceWhite", ...}`) and the GLB carries one named material.
- Add `"merge": "byMaterial"` to the build config to fuse the static parts into one mesh with one primitive per material
  (named parts are lost in the GLB; a model with bound parts or clips is refused with `MERGE_NOT_STATIC`).
- A `shell.set` surface bakes tint and ambient occlusion into `COLOR_0`/`COLOR_1`, which multiplies the base colour (ivory
  comes out tan). Set `vertexColors: false` on the shell, or leave the shell out of flat-colour props.
- Check the result with `verify model.glb --max-materials 1` or `set-stats.mjs --max-materials 1 --require-named-materials`.

Before 0.14.0 none of these fields exist (every part exported its own unnamed material), so check `capabilities` and
`package.json` before relying on them; on an older release, post-process the GLB (keep `materials[0]`, name it, point every
primitive at 0, delete `COLOR_0`/`COLOR_1`) or use the Blender route in mesh-build "Blender-authored static props".

## Working method

1. Sketch the model as a short list of named parts with rough sizes and positions in meters,
   grounded at y = 0.
2. Write the batch, dry-run it, apply it, then `inspect` to confirm names and counts.
3. Export and verify (`export`, `verify`) or run an isolated build for renders; read
   [mesh-build](../mesh-build/SKILL.md). Look at the renders before calling the model done:
   the validator proves structure, not looks. Read [mesh-believable](../mesh-believable/SKILL.md)
   when the model looks blocky, floating or lumpy.
4. Keep the batch files and any `build.json` in the project so the model is reproducible.
