---
name: mesh-authoring
description: Author 3D models with agent-meshes as named parts through JSON operations in a durable workspace, including primitives, lathe and prism shapes, bone-anchored placement, organic shells, and the creature recipes.
when_to_use: Use when asked to make, model, or edit a 3D object, character, creature, prop, sculpture or machine as a GLB, to load a biped, equine, vulpine, insectoid, arachnid or strandbeest recipe, or when an agent-meshes operation fails validation.
---

# Mesh authoring

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

`capabilities` prints the versioned JSON schema, defaults and one example per operation. Run it
once and read it instead of guessing field names. Coordinates are meters, +Y up, rotations are
unit quaternions `[x,y,z,w]`.

## Operations

Write operations to a JSON file as an array and apply them with `batch` (atomic, one undo step).
`--dry-run` validates every intermediate state and reports the zero-based `operationIndex` that
fails, without changing anything. Always dry-run a batch you have not applied before.

| Operation | Purpose |
| --- | --- |
| `add` | A named part: `box`, `sphere`, `cylinder`, `cone`, `capsule`, `lathe` (unit `[radius,height]` profile), `prism` (unit `[x,y]` outline) or `group`; `size` scales the unit shape in meters, `segments` sets tessellation |
| `update`, `remove` | Edit or delete a part; `update` never renames; unbind before changing geometry |
| `shell.set`, `shell.remove` | Blend listed parts into one smooth surface (see mesh-believable) |
| `bone.*`, `bind`, `unbind`, `pose*`, `clip.*`, `assembly.copy` | Rigging and animation (see mesh-rigging) |

Parts nest with `parent`; a child's transform is relative to its parent part. `anchor: <bone>`
makes `position` and `rotation` relative to that bone's rest frame instead, which is how a hoof
or a hand is placed at the end of a limb without computing world coordinates. Names start with a
letter and contain letters, numbers, underscores, hyphens or dots, and are unique across parts and
bones. See [operations](references/operations.md) for a worked example of every operation.

## Recipes

`recipe <kind>` replaces the workspace project with a rigged, animated creature to edit further.
Pick the kind by body plan: a person, robot or figure is `biped`; a horse, deer, donkey, cow or
any hoofed animal is `equine`; a fox, dog, cat, wolf or any pawed animal is `vulpine`; a beetle,
ant or six-legged bug is `insectoid`; a spider is `arachnid`; a walking machine is `strandbeest`.
Resize and recolor parts afterward to turn the fox into a cat or the horse into a deer. Options: `--gaits walk,trot,gallop`
(quadrupeds), `--shell` (quadrupeds; one smooth skin with lathe hooves), `--leg-phases <json>`
(insectoid; one clip per named set of six touchdown phases), `--pairs`, `--spacing`, `--patterns <json>`
(strandbeest; Jansen's real linkage). Recipes are deterministic project data, so a variation is
the recipe plus a batch of edits, kept as files so it can be rebuilt. To deliver a recipe-based
model, `save <name>.mesh.json` from the workspace and point `build.json` at it with
`"project":"<name>.mesh.json"` (see mesh-build).

`recipe`, `state`, `save` and `open` print the whole project (a recipe is a few hundred kilobytes
of JSON on one line). Redirect that output to a file or trim it. `inspect` without a selector is
also one long line: counts first, then every part, bone and clip; read the counts, and use a
selector such as `inspect clip:walk` for one item.

## Working method

1. Sketch the model as a short list of named parts with rough sizes and positions in meters,
   grounded at y = 0.
2. Write the batch, dry-run it, apply it, then `inspect` to confirm names and counts.
3. Export and verify (`export`, `verify`) or run an isolated build for renders; read
   [mesh-build](../mesh-build/SKILL.md). Look at the renders before calling the model done:
   the validator proves structure, not looks. Read [mesh-believable](../mesh-believable/SKILL.md)
   when the model looks blocky, floating or lumpy.
4. Keep the batch files and any `build.json` in the project so the model is reproducible.
