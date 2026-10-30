---
name: mesh-build
description: Export, verify, render and deliver GLBs with agent-meshes. Use for repeatable Blender builds, slow unchanged builds or cache misses, shared configs and batches, generated mesh arrays and vertex colours, configured Unreal static-prop, collision or character import checks, model previews and web viewers.
when_to_use: Use when asked to set up build.json, avoid repeated Blender launches or hashing, reuse a rollback, share pins or defaults, keep scripts beside assets with a shared library, diagnose environment-driven rebuilds, consume audit receipts, commit or ignore build output or fix line-ending rebuilds, preserve UV/RGBA arrays or wear masks, match project import settings, check a built GLB against an engine's import contract (size, axes, collision, Nanite, UV precision, morphs, bones), render or screenshot a model, preview bpy sources quickly, produce an offline preview or multi-model stage, count pixels per part, embed MeshViewer, refine a model, compare GLB budgets. Performing the import into Unity, Godot or Unreal is agent-engine:engine-asset-import or agent-unreal:unreal-import. Choose mesh-tool-selection first only when the authoring or engine route is unsettled.
---

# Mesh build and delivery

For Blender process flags, background Python jobs and Windows Store completion,
read the [Blender CLI reference](../../scripts/blender_lib/references/blender-cli.md).
For native `bpy`, modifiers, animation and helper selection, read the
[Blender Python API reference](../../scripts/blender_lib/references/blender-api.md).

Before delivering to another app or engine, read
[consumer patterns](../../scripts/blender_lib/references/consumer-patterns.md).
Record the exact nodes, material roles, sockets, clip/morph controls, frames and
budgets the consumer addresses; check them on the final optimized output. For
reference-rig and motion review, use the shipped
[neutral mannequins](../../scripts/blender_lib/references/mannequin-library.md)
and existing comparison viewer.

The [organized rig library](../../scripts/blender_lib/references/rig-library.md)
adds nine donor banks, rigging tools and a protected offline demo generator.

Load `mesh-setup` first. Commands run through the managed launcher
(`node "<plugin-root>/scripts/run-managed.js" ...`, written `mesh` below).

To look at a GLB that already exists without rebuilding it, run `mesh preview model.glb --out <folder>`; `mesh view`
takes no GLB. Read [Preview a built GLB without rebuilding](references/previews-and-refine.md#preview-a-built-glb-without-rebuilding).

## Find the relevant build guidance

Keep editable recipes in the project; apps consume the exported GLB. For a native
Blender task, read the matching reference before changing its build contract:

| Task or symptom | Direct reference |
| --- | --- |
| Establish inputs, donor pins or a reproducible toolchain | [Declare and pin a native build](references/native-build-identity.md#declare-and-pin-a-native-build) |
| Skip unchanged generation or reuse a rollback | [Incremental generation and bounded history](references/native-build-identity.md#enable-incremental-generation) |
| Repeated config settings or tool hashing across assets | [Shared defaults (`extends`) and `build-batch`](references/native-build-identity.md#share-defaults-and-build-a-batch-0230-and-later) |
| Unexpected rebuild or no cache hit | [Miss reasons and changed components](references/native-build-identity.md#diagnose-a-native-miss-0230-and-later); for environment changes, [declare the actual child environment](references/native-build-identity.md#declare-blenders-environment-0240-and-later) |
| Nested asset configs need a shared library | [Explicit project root and path rules](references/native-build-identity.md#share-inputs-under-an-explicit-project-root-0240-and-later) |
| Undeclared-read warning or strict-audit failure | [Read-audit coverage and limits](references/native-build-identity.md#observe-project-reads-0220-and-later) |
| Commit or parse an authoring receipt | [Portable schema-2 receipts versus full local diagnostics](references/native-build-identity.md#keep-audit-receipts-portable-0240-and-later) |
| Commit or ignore build output, a plain build fails with `BUILD_OUTPUT_FILE_MISSING` ("Missing owned build file"), or the same script behaves differently on another machine's line endings | [Committing build output](references/native-build-identity.md#committing-build-output) |
| Preserve RGB/alpha masks or omit unused vertex colours | [Vertex-colour export controls](../../scripts/blender_lib/README.md#vertex-colors-in-glb-exports) |
| Build geometry from vertices/faces, corner UVs and colour masks | [Mesh-from-arrays helper and V-origin contract](../../scripts/blender_lib/README.md#meshes-from-arrays) |
| Unreal static prop has wrong size/axes, collision or Nanite/UV settings; match project import options | [Static-prop measurements, import options and axis calibration](references/unreal-static-props.md) |

Reuse skips only native Blender generation; current validation, limits and requested
previews still run. Unreal import and cook are separate consumer stages. Compiling
Python cannot prove complete dependencies or replace an exported-asset check.

## One-off export

```text
mesh --workspace .agent-meshes/fox export fox.glb
mesh verify fox.glb
mesh --workspace .agent-meshes/fox view review/
```

`export` writes an animated GLB with named meshes, materials, skeleton, weights and clips from the
rest rig. **Node layout:** the scene has exactly one root node, an identity-transform wrapper named
after the project (`mesh new <name>`, the recipe's name, or a build config's `name`, else the config
file name); parts are its children, nested by `parent`. A `group` part becomes an empty named node
with its transform, which is how sockets and attachment points are exported; a game looks them up by
node name under the wrapper. Each glTF mesh carries its part's name as well as its node (0.15.0 and
later; before that only nodes were named), a shell's mesh carries the shell name, and a merged GLB's
one mesh carries the project name. So name the workspace after the asset (`mesh new hull-dart`) when
the root name matters. `verify` runs the Khronos glTF Validator and exits nonzero on errors. A build already
runs it and writes the same report as `verification.json`, so `verify` after a build is redundant.
Zero errors and warnings is the bar; `UNUSED_OBJECT` infos about `TEXCOORD_0` are expected on
every part (the primitives carry UVs that no material samples). `verify` also lints a static model
for detached parts: every mesh part's world-space triangles (rotations and parent groups applied) are
measured against every other part, and a part or group of touching parts more than 0.01 m from the
rest is reported in `detached.findings` and as a `WARN DETACHED_PART: ...` line naming the parts, the
nearest part and the gap in metres; the exit code is unchanged. `--max-gap 0.01` turns it into a
budget that fails (with `--warn-only` honoured), and `--allow-detached halo,orb` exempts parts that
float on purpose. A build records the same report as `detached` in `verification.json` and lists the
findings under `warnings` in its result. Skinned or animated GLBs are skipped (`detached.skipped`), and
a merged GLB has one mesh, so lint before merging (0.15.0 and later; older releases run the validator
only). `view` renders
front, side and perspective PNGs plus one contact sheet per clip into a directory; look at them.
`view --views front,side,top,perspective` picks the views; the default is front, side and perspective.

For a deliberate delivery review or recurring anatomy/clothing defects, use
[mesh-quality-review](../mesh-quality-review/SKILL.md) for reference fidelity, a full orbit
and head-to-toe detail coverage.

**Glass survives every stage.** A part (or Blender `material(..., opacity=.16)`) with opacity below
1 exports as `alphaMode: BLEND` with the opacity in the base color alpha, `transmission` as
`KHR_materials_transmission`, `ior` as `KHR_materials_ior`, `doubleSided` as `doubleSided`; the
validator passes all of them with no warnings. three.js's GLTFLoader (the viewer, a stage, or a
plain three.js page) loads BLEND as transparent without depth writes, so the face behind a visor
still draws; the viewer and stage also stop glass casting shadows and skip its outline hull
(`userData.glass` marks it). The workbench's fixed-view renders use the same finish. In an ID
render, glass is left out unless a `parts` or `materials` key names it, so the pixels count what is
seen through it; named glass draws as an opaque occluder. `verify-unreal` lists every glass
material in `report.glass` and fails if Interchange imported one opaque (glTF BLEND becomes an
`MI_Default_Blend` instance, transmission `M_Transmission`, both `BLEND_TRANSLUCENT`; checked with
UE 5.7.3). `node scripts/check-glass-browser.mjs [model.glb]` proves the viewer, stage, a plain
three.js page, the ID-render rule and the workbench renders in Chromium, and with a GLB counts the
face pixels seen through its glass from the front, side and three-quarter views.

**Enclosures hold what they declare at every pose.** A node whose glTF extras say
`"encloses": {"parts": [...], "clearance": 0.015, "maxClearance": 0.04, "with": ["helmet-shell"]}`
(from Blender: `obj['agent_meshes_extras'] = json.dumps({...})`) is checked by `build` and by
`verify <glb>`: every vertex of every named part, posed as three.js poses it (skin and morphs) at
rest, at each keyframe and 24 phases of every clip and with each morph target at full weight, must
stay `clearance` metres inside the node's surface plus the `with` meshes; `maxClearance` also fails
an enclosure far bigger than what it holds. Failures name the part, the pose and the millimetres
(`helmet-glass: left-ear pokes 3.2 mm outside the glass at clip walk @ 0.45 s`), and
`verification.json` keeps the report. Inside is judged from the enclosure's centroid (it must be
star-shaped, as bubbles and domes are); an open neck is not glass.

## Repeatable build

Keep a `build.json` beside the source in the project:

```json
{"version":1,"name":"fox","operations":"operations.json","output":"dist"}
```

`operations` is a JSON array of authoring operations (or use `"project":"fox.mesh.json"` for a
saved project). Paths resolve relative to the config. `mesh build build.json` produces, in an
isolated state, `project.mesh.json`, `model.glb`, `verification.json`, `front.png`, `side.png`,
`perspective.png`, `<clip>.png` contact sheets, and a self-contained offline `preview.html` with
orbit, playback and scrub (and, for a model with morphs, a slider per morph and the emotion
presets from `extras.arkitFace`). Renders and the preview page are on by default (`--preview` and
`--preview-page` say so explicitly); `--no-preview` writes no renders and no preview page and `--no-preview-page`
keeps the PNGs but skips the 1 MB preview page when your own page embeds the GLB. Skipping previews also
removes the ones an earlier build left in the folder (see below). The output directory is the
`output` field of the config (`build` has no `--out`). A build replaces that whole directory, so it
creates a missing one, adopts an empty one, and replaces one only when its marker names that config.
A directory holding other work is refused with `BUILD_OUTPUT_NOT_OWNED`, which names the directory and what
it holds; set `output` to a different directory or move the files. A failed build leaves the previous output
in place; after a crash, confirm the process is gone before removing the adjacent `.agent-meshes.lock`.

**A rebuild removes earlier previews it does not write again.** The swap deletes every earlier file, so a build that
writes fewer previews than the one before it (`--no-preview`, `--no-preview-page`, or a model with fewer clips)
deletes the old ones. A preview is a file whose name ends `.png` in any case, or exactly `preview.html`. When that
happens the build still succeeds and returns the warning `BUILD_PREVIEWS_REMOVED`, which lists the removed files in
the order the earlier `.agent-meshes-build.json` listed them. It is keyed on the removal, not on the flag: a
`--no-preview` build into a folder that held no previews warns nothing, and a build without the flag that drops a
preview warns. It reads the earlier marker, so a folder with no marker, an unreadable marker or an adopted empty
folder gets no warning, and no warning does not prove nothing was removed. Do not restore removed previews from
version control: they are stale and sit beside a marker that does not list them, so the next build refuses with
`BUILD_OUTPUT_UNOWNED_FILE`. Delete them and rebuild with previews on. `--if-changed` and `--force` apply to native
`blender.script` builds only, so a project or operations build cannot use them to keep earlier previews.

## Done means looked at

A build is not done when `verification.json` reports zero errors. Open the PNGs and the contact
sheets and compare them with the intent. If something looks blocky, floating or lumpy, read
[mesh-believable](../mesh-believable/SKILL.md) before adjusting numbers at random.

## More build guidance

| You are about to | Read |
| --- | --- |
| Name a static prop, merge or budget it, or judge a set | [Static props for a game engine: names, merge and budgets](references/static-props-names-and-budgets.md) |
| Author a static prop in Blender | [Blender-authored static props](references/blender-static-props.md) |
| Look at an existing GLB without rebuilding it, preview a bpy source quickly, refine a model or check garment penetration | [Blender previews, refine and the garment check](references/previews-and-refine.md) |
| Check an import into Unity or Unreal | [Engine import checks: Unity and Unreal](references/engine-import-checks.md) |
| Embed a model or a stage in a page | [Embedding a model in a page](references/embedding-in-a-page.md) |
| Look up MeshViewer mount options, the puppet API or `bounds()` | [Viewer API](references/viewer-api.md) |
| Verify a face rig against its contract | [Face-rig contract check](references/face-rig-contract-check.md) |
