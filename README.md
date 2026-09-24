# Agent Meshes

Named-part 3D authoring for coding agents, with a live browser workbench. Requires Node.js 24 or later.

## Agent workspace

Use a durable workspace without starting a server. Commands share the same validated authoring engine as the browser:

```powershell
node scripts/agent-meshes.mjs capabilities
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox recipe vulpine
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox inspect
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox inspect bone:leg_L_front_elbow
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox batch edits.json --dry-run
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox --expect-revision 1 batch edits.json
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox undo
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox redo
node scripts/agent-meshes.mjs --workspace .agent-meshes/fox export fox.glb
```

`capabilities` returns versioned JSON schemas, defaults, constraints and operation examples without a running server. `inspect` summarizes named parts, bones, bindings and clip/key counts; `part:`, `bone:` and `clip:` selectors include one exact entity. A batch file contains an operation array. `--dry-run` runs the same state-dependent validation as a real batch, reports named additions/removals/changes, and leaves revision and undo history intact. Use its base revision with `--expect-revision` to reject edits planned against stale state.

Workspace `state` and mutation responses contain `{project, revision, undo, redo}`. Each failure writes a JSON error record to stderr with a stable code, message, zero-based failing operation index and validation fields where available; failures exit nonzero. Workspace state lives in `workspace.sqlite`, using Node's bundled SQLite with transactions and crash recovery. Confirmed edits are committed before success is returned. Undo/redo survive commands and restarts, bounded to 20 steps and 16 MiB of history. Corrupt or unknown workspace state is rejected without replacement. Use current Node 24 LTS (tested 24.21) or Node 26 for clean machine-readable stderr; early Node 24 releases also print runtime experimental warnings. Project JSON remains the portable exchange format: use `save file.mesh.json` and `open file.mesh.json`.

`--workspace <directory> serve` opens a live editor backed by the same workspace. CLI and browser changes share serialized database transactions; the editor observes external workspace revisions. `--workspace` and an explicit `--url` are mutually exclusive. `serve --project` is a separate, in-memory mode and cannot be combined with a workspace. Existing HTTP command responses keep their project shape; workspace servers additionally return the `x-agent-meshes-revision` header on mutations and project reads. `GET /api/workspace` reports durability/revision/history, `GET /api/capabilities` exposes contracts, and `POST /api/plan` accepts `{operations:[...]}` for a nonmutating dry run.

Includes five editable, rigged low-poly characters: **Copper courier** (biped walk), **Amber horse** (equine walk/trot), **Ember fox** (vulpine walk/trot), **Jade scarab** (six-leg tripod gait), and **Indigo weaver** (eight-leg alternating gait). No Blender installation is needed. Horses and foxes can also carry a **gallop** with a true suspension phase: `recipe equine --gaits walk,trot,gallop` chooses which clips a quadruped recipe generates (default `walk,trot`, so the bundled examples are unchanged). `--shell` blends the whole animal into one smooth skin with lathe hooves; eyes and nostrils stay crisp on top. `recipe strandbeest --pairs 3` builds Theo Jansen's walking machine from his published rod lengths: each leg uses his eleven-rod linkage, with an unfolded upper triangle and the outer foot rod h joining the knee to the foot. The analytic foot path has a long, nearly level lower sweep and a lifted return. The recipe bakes 60 crank samples per turn into ordinary position/rotation tracks; interpolation between keys is not an exact linkage constraint. Existing saved projects keep their previous geometry until regenerated. `--pairs` counts crank positions along the shaft (default 3, at most 5), and each position carries four legs: left and right, and on each side a front-facing leg (`leg_L_1f_*`) and its back-facing mirror (`leg_L_1b_*`) driven by the same crank pin, so the feet straddle the axle and the body stands over them. `--spacing` sets the distance between positions and `--patterns '{"turn":[0,0.33,0.67]}'` makes one clip per named set of crank offsets (one per position), for comparing timings. The scarab takes `--leg-phases '{"tripod":[0,0.5,0,0.5,0,0.5],"ripple":[0,0.17,0.33,0.5,0.67,0.83]}'`: one clip per entry, each a touchdown phase per leg in order L1 L2 L3 R1 R2 R3, for comparing leg timings.

```powershell
npm ci
npm run build
npm start
```

Open the loopback URL printed by the server (normally http://127.0.0.1:3388). Add primitives, select named parts, edit their dimensions and positions, orbit or select a fixed camera view, and undo/redo edits. Open and Save project buttons load/download portable JSON. The live editing state is in memory; save your project before stopping the server. Use `serve --project path.json` to reopen saved work on startup.

Choose a creature in the left sidebar to load its model, rig and looping clip. Loading replaces the active project in one undoable action; save edits before moving between examples. Playback starts automatically unless reduced motion is enabled. Pause to inspect a pose, enable Skeleton → Show, or select a joint to edit it.

`npm run examples` writes a static creature gallery to `artifacts/creatures`: the five animated viewers, editable project downloads and GLB exports. It needs no server-side code and does not expose the editing API, so any static file server can publish it. For example, to share it on a private Tailscale network:

```powershell
tailscale serve --bg --https=<port> <path-to-this-repo>\artifacts\creatures
```

For an editing server behind a trusted private reverse proxy, `serve --public-origin <https-origin>` permits that exact browser origin while other origins remain rejected. The server still binds to loopback. Give a remote editor its own port rather than sharing the gallery's. Anyone who can reach the proxy shares the one active project, so let the proxy (for example Tailscale) control network access.

In another terminal:

```powershell
node scripts/agent-meshes.mjs new robot
node scripts/agent-meshes.mjs op '{"op":"add","part":{"name":"body","geometry":{"type":"box","size":[1,2,1]},"position":[0,1,0]}}'
node scripts/agent-meshes.mjs save robot.mesh.json
node scripts/agent-meshes.mjs state
node scripts/agent-meshes.mjs recipe biped
```

Geometry types are `box`, `sphere`, `cylinder`, `cone`, `capsule`, `lathe`, `prism` and `group`. `size` is the bounding box of the shape in meters. A `lathe` revolves a `profile` of `[radius, height]` points (radius 0 to 0.5, height -0.5 to 0.5) around y, for vases, birds and turned forms. A `prism` extrudes an `outline` of `[x, y]` points (each within -0.5 to 0.5) along z, for flat cut-outs and silhouettes:

```json
[
  {"op":"add","part":{"name":"vase","geometry":{"type":"lathe","size":[0.4,1.2,0.4],"segments":32,"profile":[[0.15,-0.5],[0.5,-0.1],[0.3,0.3],[0.2,0.5]]}}},
  {"op":"add","part":{"name":"star","geometry":{"type":"prism","size":[1,1,0.05],"outline":[[0,0.5],[0.5,0.1],[0.3,-0.5],[-0.3,-0.5],[-0.5,0.1]]}}}
]
```

Separate primitives read as floating pieces on an animal or a figure. A **shell** blends a set of parts into one smooth surface that replaces them when rendered or exported:

```json
{"op":"shell.set","shell":{"name":"skin","parts":["body","neck","head","leg_upper","leg_lower","hoof"],"blend":0.12,"resolution":48}}
```

`blend` is how far two members reach toward each other before they merge, in meters; `resolution` is the number of grid cells along the longest axis (16 to 96). The shell takes its colors from the members that own each point, so a red head and a brown body fade into each other at the neck; `colorBlend` (meters, default half of `blend`) is the width of that fade, and `"colorBlend":0` gives hard-edged patches by member ownership (a Niki de Saint Phalle Nana, a piebald horse) without changing how the skin follows the bones. Members must all be rigid-bound (the shell is then skinned, each point following the bones of the parts that own it) or all unbound (a static mesh). Members stay editable as parts; `shell.remove` shows them individually again. Lathe, prism and every primitive have a signed distance function, so all of them can be members. An optional `cut` lists parts subtracted from the surface with the same `blend`, so a cylinder through a torso carves a Henry Moore hole and a sphere inside a bowl hollows it: `{"op":"shell.set","shell":{"name":"figure","parts":["torso","hip"],"cut":["hole"],"blend":0.08,"resolution":48}}`. Cutters are hidden like members, add no color or bone weight, cannot also be members, and must be rigid-bound or unbound (the hole is carved where the cutter sits at rest, whatever the members' binding). The cut is baked when the shell is meshed, at authoring or export time; a viewer cannot move a cutter at run time, so export one model per hole size and switch between them.

A part or a shell can carry a surface finish: `"material":{"metalness":1,"roughness":0.1}` is polished chrome (a Koons balloon dog), `{"metalness":0,"roughness":0.65}` is the default matte paint, and both values run 0 to 1; the finish is written into the GLB and the viewer can switch it at runtime with `setMaterial(part, {metalness, roughness})`.

A shell or a part can wear a painted **pattern**: `"pattern":{"type":"dots","color":"#ffffff","size":0.12}` on a `shell.set` shell or on an `add`/`update` part (`{"pattern":null}` in `update` removes it). `type` is `dots` (spots within 0.3 of a lattice spaced by `size`), `stripes` (bands `size/2` wide across `axis`, default `y`) or `checks` (`size` squares on the two axes perpendicular to `axis`); `offset` shifts it in meters. The pattern is a pure function of the world-space point, so it does not swim across member seams and looks the same in the workbench, the GLB and the browser. It is baked into vertex colors after the member blend and before ambient occlusion; the un-patterned base colors travel with the mesh as `COLOR_1` (rgb plus the occlusion shade), which is how the viewer's `setPattern` re-bakes a new pattern instantly, without a remesh, and `setPattern(name, null)` restores the original look exactly.

A part can be placed relative to a bone instead of the world: `{"op":"add","part":{"name":"ring","anchor":"hand","position":[0,-0.5,0],...}}` interprets `position` and `rotation` in the `hand` bone's rest frame and stores the world result, so a part meant to hang from a bone never needs the bone's world position copied by hand.

The CLI prints JSON and exits nonzero on failures. `batch operations.json` applies an array of operations atomically, with one undo step. `open`, `save`, `undo`, and `redo` share the browser's active project. `--url` chooses an already-running server; identity checks prevent edits against an unrelated service. Run `node scripts/agent-meshes.mjs --help` for commands. Names start with a letter and contain letters, numbers, underscores, hyphens or dots. Transforms use meters and Y-up coordinates; rotations are unit quaternions `[x,y,z,w]`.

Development: run the API with `npm start`, then `npm run dev` for Vite's live reload. `npm test`, `npm run typecheck`, and `npm run build` verify the code. `npx playwright install chromium` then `node scripts/check-browser.mjs` exercise the built workbench and write a screenshot under `artifacts/`.

## Claude Code plugin

The repository is also a Claude Code plugin, listed in the [Hartye marketplace](https://github.com/ehartye/hartye-claude-plugins): `/plugin marketplace add ehartye/hartye-claude-plugins`, then `/plugin install agent-meshes@hartye-plugins`. The plugin cache is a bare checkout, so run `/agent-meshes:mesh-setup` once after installing or updating: it copies the runtime to `~/.agent-meshes/releases/<version-hash-platform>`, installs dependencies, builds the workbench, installs Chromium for renders, links the CLI and records a receipt (`npm run setup` does the same from a checkout). Skills (`mesh-setup`, `mesh-authoring`, `mesh-rigging`, `mesh-build`, `mesh-believable`) run every command through `scripts/run-managed.js`, which refuses a missing or modified release instead of falling back to PATH. `AGENT_MESHES_HOME` moves the managed home. Node.js 24 or newer is required; Blender stays optional and setup reports where it found one.

## Rigging

Bones form an arbitrary hierarchy; there is no fixed limb count. In the browser, add bones under Skeleton, select a bone, bind the selected mesh part, then enter joint rotations in degrees under Pose. Reset all poses returns to the saved rest rig. The skeleton overlay helps inspect joint placement.

The same operations work through `op` or a batch file:

```json
[
  {"op":"bone.add","bone":{"name":"hip","position":[0,1,0]}},
  {"op":"bone.add","bone":{"name":"knee","parent":"hip","position":[0,-0.5,0]}},
  {"op":"bind","name":"body","binding":{"type":"rigid","bone":"hip"}},
  {"op":"pose","name":"knee","rotation":[0.3826834324,0,0,0.9238795325]}
]
```

Bindings support `rigid` (one bone), `linear` (two bones, local `axis`, ascending `[start,end]` range), or `weights` (one to four named `bones` and one normalized weight row per geometry vertex). A linear binding interpolates from the first bone to the second across the range. Geometry uses subdivided primitives so weights can deform a surface. Explicit weight row counts must match the actual generated geometry.

`bone.update` edits rest `position`, quaternion `rotation`, or `parent`. `bone.mirror` takes a subtree `name`, a new name `prefix`, and `axis` (`x`, `y`, or `z`) and reflects the subtree in its parent's local coordinates. `bone.remove` refuses referenced bones or parents with children. `pose.reset` restores all poses. `unbind` takes the part `name`. Unbind affected parts before changing bound geometry or the rest skeleton, then bind again; ordinary posing retains the bind pose. Undo/redo and project JSON include all rig state.

`node scripts/check-rig-browser.mjs` checks weighted posing, recoloring a bound part, and rest-pose reset in Chromium.

## Animation and delivery

Use New clip to capture a two-second starting pose, scrub to a time, adjust joints, then Key pose to record the visible pose. Play, pause and frame-step inspect the result. Recording at either endpoint also updates the opposite endpoint for a seamless loop. CLI `clip.set` accepts a complete clip with any duration from 0.05 to 120 seconds:

```json
{"op":"clip.set","clip":{"name":"sway","duration":2,"tracks":[{"bone":"hip","property":"rotation","keys":[{"time":0,"value":[0,0,0,1]},{"time":1,"value":[0,0,0.258819,0.965926]},{"time":2,"value":[0,0,0,1]}]}]}}
```

Track `property` is `rotation` (quaternion offset from rest rotation) or `position` (XYZ offset from rest position). Key times strictly increase from zero through the full duration. `clip.remove` takes a clip `name`. Previewing a clip starts untracked bones at rest, matching exported playback.

```powershell
node scripts/agent-meshes.mjs export model.glb
node scripts/agent-meshes.mjs verify model.glb
node scripts/agent-meshes.mjs view review
```

GLB includes named meshes, materials, skeletons, weights and clips. Export uses the rest rig, independent of the editor's current pose. Skinned mesh transforms are baked and skinned nodes placed at scene root to follow glTF semantics; the bone hierarchy and editable source project remain intact. The exported model is checked with Khronos glTF Validator; structural validity alone does not certify a convincing gait.

For a repeatable build, save `build.json` beside your source project:

```json
{"version":1,"project":"source.mesh.json","output":"dist"}
```

Or use `{"version":1,"name":"creature","operations":"operations.json","output":"dist"}` for a JSON array of authoring operations. Paths resolve relative to the config. Run `node scripts/agent-meshes.mjs build build.json`. It produces editable project JSON, `model.glb`, validation report, front/side/perspective PNGs, a contact sheet per clip, and `preview.html`. The self-contained preview loads the actual GLB and works offline, with orbit, playback, scrub and download. PNGs use the exported rest rig and clips; direct `view` also supports inspecting a saved authoring pose.

Rendering requires the built workbench (`npm run build`) and Chromium (`npx playwright install chromium`). `build build.json --no-preview` produces the project, GLB and validation report without a browser. `--no-preview-page` keeps the PNG renders and contact sheets but skips the 1 MB `preview.html`, for pipelines that embed the GLB in their own page. Each build uses isolated state, stages and verifies outputs, then replaces only a directory marked as owned by that config. Extra files, symlinks, and concurrent builds are rejected. Failures preserve the last published build. After a crashed process, check that it has stopped before manually removing the adjacent `.agent-meshes.lock` file.

`node scripts/check-animated-build.mjs` exercises rendered builds and offline exported playback. `node scripts/check-animation-browser.mjs` then verifies scrubbing, key recording and pose editing in the workbench. These write ignored evidence under `artifacts/`.

## Optional Blender stage

Blender-authored assets can use the same isolated build command with a Python source instead of a primitive project:

```json
{"version":1,"name":"Bird","blender":{"script":"source/make_bird.py"},"output":"generated"}
```

The source defines `build()` returning a nonempty list of Blender objects, including at least one mesh. The runner starts an empty scene, adds the source's directory and `scripts/blender_lib` to Python's import path, calls `build()`, and exports the returned objects with named shape keys, their authored rest weights, materials, skins and animations. Source scripts are trusted Python code. The helper API is documented in [scripts/blender_lib/README.md](scripts/blender_lib/README.md). A config accepts exactly one of `project`, `operations`, or `blender`; authored builds cannot also request `refine` because modifiers belong in their source.

Authored rigs can use `bind_skin(mesh, armature, weights)` to validate and normalize
at most four explicit bone influences per vertex before creating a binding. It
preserves the mesh world transform and rejects conflicting bindings; the pure
`normalize_skin_weights` helper also runs without Blender. Include the armature
alongside the mesh in `build()`'s returned list. The helper does not infer weights
or generate animation. `node scripts/check-authored-skin-browser.mjs` proves the
actual Blender export deforms in the offline public viewer.

`node scripts/agent-meshes.mjs build build.json` produces `model.glb`, `verification.json`, `authoring.json` (entry script path and SHA-256, Blender version, mesh count), and an offline `preview.html` of the actual exported GLB. Authored builds do not create a primitive `.mesh.json`, workbench PNGs, or contact sheets. `--no-preview` or `--no-preview-page` omits their preview page; neither path needs Chromium. The Python source and its sibling modules remain the editable source. Entry-script provenance does not hash imported dependencies. Failed authoring, validation, or preview generation preserves the last published output through the same locking and staging checks as project builds. The runner handles ordinary and Microsoft Store Blender launchers, reports Python errors, and stops a hung process after ten minutes.

`node scripts/agent-meshes.mjs refine model.glb smooth.glb --subdivide 1 --noise 0.004 --noise-scale 0.05 --only robin` rounds primitives into organic forms with a subdivision surface and, if asked, adds a feather- or fur-like displacement from a procedural clouds texture, while keeping bones, skins, vertex colors and clips. It runs Blender headless through `scripts/blender-refine.py`; Blender is found on PATH, in the usual install folders, in the Microsoft Store app alias, or from `AGENT_MESHES_BLENDER`. Primitive builds without refinement do not need Blender, and the refine test skips when it is absent. A build config can ask for the pass with `"refine":{"subdivide":1,"noise":0.003,"noiseScale":0.04,"only":["robin"]}`; the refined GLB is verified again, and a build that asks for refinement fails when Blender is missing rather than shipping a coarser model. Renders and contact sheets still come from the unrefined project.

## Unreal import check

`verify-unreal` imports a GLB into a scratch Unreal Engine project headlessly, through Interchange (the engine's glTF translator), and prints a JSON report of what Unreal made of it:

```powershell
node scripts/agent-meshes.mjs verify-unreal head.glb --contract arkit-face/1
node scripts/agent-meshes.mjs verify-unreal robot.glb --expect-morphs smile,blink --expect-bones hip,knee --json
```

The report lists the created assets by class (SkeletalMesh, Skeleton, materials, textures, animations, PhysicsAsset, StaticMesh) and, for each skeletal mesh, its morph target names (`SkeletalMesh.get_all_morph_target_names()`), its bone names (the Skeleton's reference pose through `AnimPoseExtensions.get_reference_pose` / `get_bone_names`), the LOD count and vertices per LOD. It also lists the `Error:` and `Warning:` lines Unreal logged during the import, the log file path and the engine version. `--contract arkit-face/1` requires one SkeletalMesh that carries all 21 required ARKit morph names verbatim and whose own skeleton has the `head`, `eye_L` and `eye_R` bones, exactly one SkeletalMesh and one Skeleton in the import (the contract's single skin), and zero import errors. `--expect-morphs` and `--expect-bones` add names for any model; they too must all be on one SkeletalMesh. Morphs on one SkeletalMesh and bones on another never pass, because Unreal cannot move that morph-bearing mesh with that rig. Missing names are listed in `failures`, with a hint when Unreal kept a name with different case or the GLB never had it. The command exits 1 when anything fails. It prints the report pretty-printed and writes progress to stderr. `--json` prints one compact line and no progress. `--timeout <seconds>` (default 1800) stops a stuck editor, and `--log <file>` moves the Unreal log. The required arkit-face names live in `src/arkit-face.ts`, exported for reuse so other verifiers can share the one copy.

Unreal is found from `AGENT_MESHES_UNREAL` (the engine directory, such as `C:/Program Files/Epic Games/UE_5.7`, or `UnrealEditor-Cmd` itself; an invalid value is an error, not a fallback), then the Epic launcher's `LauncherInstalled.dat`, then `UE_*` folders under the usual Epic Games roots. The newest engine wins. Without an engine the command fails with `UNREAL_NOT_FOUND`. The command runs `UnrealEditor-Cmd <project> -run=pythonscript -script=scripts/unreal-verify-import.py -unattended -nullrhi -nosplash -nopause -nosound -notraceserver`. The scratch project enables `PythonScriptPlugin` and the Interchange plugins. It is created once per engine version under `%LOCALAPPDATA%/agent-meshes/unreal/<version>/` (or `AGENT_MESHES_UNREAL_CACHE`), and the last 20 logs are kept beside it. Each run clears `/Game/Verify` first and afterwards, so assets left by a killed run never leak into the next report. It holds a `verify.lock`. A lock whose process has died is replaced, and a live one makes the next run wait for up to ten minutes. Paths reach Unreal with forward slashes, because UE reads `-script=` with backslash escapes, and they may contain spaces. On timeout or Ctrl+C the whole editor process tree is killed, and the temporary request and report files are always deleted.

**What this proves, and what it does not.** It proves that UE's Interchange importer accepts the GLB and creates a SkeletalMesh whose morph target and bone names match, with no import errors. It does not render, animate or play the asset at runtime (`-nullrhi` has no GPU), drive morphs from an AnimBP or Live Link, or check materials visually. Treat those as unverified until someone opens the asset in the editor. It was verified against UE 5.7.3 on Windows. The macOS and Linux search paths exist but have not been run. Known behavior: Unreal drops a morph target that moves no vertex used by a triangle, so a dead shape shows up here as a missing name. Blender-exported skins log the benign warning `Node [...] with a skinned mesh is not root`.

**Skins and SkeletalMeshes.** Interchange builds one SkeletalMesh and one Skeleton per glTF skin. A mesh node with morph targets but no `skin` still becomes a SkeletalMesh, because morphs need one, but on a made-up one-bone skeleton named after the node (for example `Head_<hash>`). An unskinned mesh without morphs becomes a StaticMesh. So a head whose face mesh was left out of the skin imports as two SkeletalMeshes: the eyeballs with `head`/`eye_L`/`eye_R` and no morphs, and the face with every morph and one fake bone. No Unreal asset has both. `verify-unreal` therefore checks the expectations against one SkeletalMesh, the one carrying the most expected morphs, never against names pooled from several. It also reads the GLB's skins before starting Unreal (`preflight.skins`: each skin's joint names and the mesh nodes bound to it, and every mesh node's skin and morph count). A failure names the cause it finds there: no skin at all, a morph-bearing mesh node that is not skinned, or meshes bound to different skins. For a GLB with no skin, the missing `head` bone is reported as a missing skin, not as a spelling problem with the made-up `Head` bone. Bind every mesh, morph-bearing or not, to one skin.

**Shared morph names across glTF meshes.** UE 5.7's glTF parser (`Engine/Plugins/Interchange/Runtime/Source/Parsers/GLTFCore/Private/GLTF/GLTFAsset.cpp`, around lines 322–374) keeps a mesh's `extras.targetNames` only if every name is unique across *all* meshes in the file. If one name appears on two meshes, for example `jawOpen` on a Face mesh and on a separate lower-teeth mesh, it discards every morph name in the file and renames them all `<file>_mesh_<m>_<i>_MorphTarget`. The Interchange option `bMergeMorphTargetsWithSameName` does not prevent this. It also drops one mesh's names if a name repeats inside that mesh or if the number of names differs from the number of targets. three.js keeps the names in all of these cases, so a head can work on the web and still lose every name in Unreal. The workaround is to build all morph-bearing parts (face, lids, lips, teeth, tongue, mouth cavity) as **one glTF mesh with one primitive per material**. Every primitive carries every target, with zero deltas where a part does not move. In Blender, that means one object with several materials. Morph-free parts, such as eyeballs, can stay separate meshes. Before starting Unreal, `verify-unreal` reads the GLB's JSON and audits the morph names of each mesh (`preflight.morphNames` in the report). When Unreal's names show the `_MorphTarget` fallback, the report gives one failure that names the cause and the fix. It does not list every contract morph as missing. Contract morphs that the GLB never had are still listed, marked "the GLB has no morph target with this name". If the audit finds a problem that Unreal tolerated, it goes in `warnings`. The audit needs no engine: `auditMorphNames(bytes)` in `src/gltf-morphs.ts` is exported for reuse. When Unreal imports nothing, for example from a corrupt file, the report gives that one failure with Unreal's import errors, not a list of missing names. The GLB is imported from a temporary copy named after the sanitized asset name, because Unreal names meshes after the source file and renames names that contain spaces or punctuation a second time. Unreal runs with `-notraceserver`, so it does not start an `UnrealTraceServer`.

`tests/unreal-integration.test.ts` runs the real import whenever Unreal is installed (set `AGENT_MESHES_SKIP_UNREAL=1` to skip it). CI has no Unreal and runs only the report, log-parsing and contract unit tests.

## Embedding a model in your own page

`node scripts/agent-meshes.mjs viewer lib/mesh-viewer.js` writes the standalone viewer runtime: one script, no build step, no network. It defines `window.MeshViewer`. `preview.html` is built on the same runtime.

```html
<div id="stage" style="height:420px"></div>
<script id="glb" type="text/plain">...base64 GLB...</script>
<script src="lib/mesh-viewer.js"></script>
<script>
  MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent }).then(viewer => {
    viewer.setPose('head', { rotation: [0, 30, 0] });   // XYZ Euler degrees, offset from rest and any clip
    viewer.setColor('body', '#e6a23c');
    viewer.play('trot');
  });
</script>
```

`mount(container, options)` fills the container and follows its size. `glb` is bytes or a base64 string, which works from `file://` where `fetch` does not. Options: `autoplay` (default follows `prefers-reduced-motion`), `background` (`null` for transparent), `orbit`, `floor`, `view` (`front`, `back`, `left`, `right` or its alias `side`, `top`, `bottom`, `perspective` or `{position, target}`; an unknown name throws an `Error` listing these), and `outline` (an ink outline of that thickness in meters behind every part, with `outlineColor`). The scene is lit by a procedural room environment plus a key and fill light, with soft shadows; shells carry ambient occlusion baked into their vertex colors from the distance field, so crevices read dark without any texture.

The viewer exposes the puppet by name: `bones`, `parts`, `clips`; `setPose(bone, {rotation?, position?, scale?})` (scale multiplies the bone and everything it carries, so a longer leg moves its foot), `setPoses({bone: pose})`, `aimBone(bone, worldPoint, {maxYaw?, maxPitch?})` (turns the bone's +Z at a world point and returns `{yaw, pitch, clamped}`), `getPose`, `resetPose(bone?)`; `setColor`, `getColor`, `setVisible`; `setPattern(name, pattern | null)`, `getPattern(name)` (re-bake a dots/stripes/checks pattern on a shell or part from its kept base colors; a flat part moves its color into the vertices the first time, after which `setColor` tints it like a shell); `play(clip?)`, `pause`, `playing`, `clip`, `time`, `duration`, `speed`, `seek`; plus `view`, `frame`, `setBackground`, `screenshot`, `idRender` (see below), `onFrame`, `sync`, `resize`, `dispose` (which also releases the WebGL context), and the underlying `renderer`, `scene`, `camera`, `controls`. Pose offsets compose on top of clip playback each frame. Setters only record their input: the whole pose and morph application runs once per frame before the render (or at the first read, since every getter, `observe`, `bounds` and `idRender` applies pending changes first), so a page can write dozens of morphs and poses per frame to several heads cheaply; call `sync()` before reading a bone or mesh you kept from earlier. The `quality` option (`'high'` default, `'fast'`, or `{preset?, antialias?, pixelRatio?, shadows?, environment?}`) trades image quality for frame time; `fast` turns off MSAA, shadows and the environment map at pixel ratio 1. `node scripts/check-viewer-browser.mjs` verifies the runtime in Chromium.

`viewer.observe({hoof: {node: 'leg_L_front_hoof', point: [0, 0, 0]}}, relativeTo?)`
returns frozen numeric points in world coordinates, or relative to another uniquely named node.
These are local node anchors, not deformed mesh vertices or inferred ground contacts. Missing or
ambiguous names, non-finite points and singular relative frames reject. A batch supports up to
4096 anchors and updates ancestor/descendant matrices once.

`const sampler = viewer.createPoseSampler()` creates an independent authored rig for measurements
or rendering with a separate scene/camera. Call
`sampler.sample({clip: 'gallop', time: 0.2, poses: {}, morphs: []})`, then `sampler.observe(...)`.
Every sample starts from authored values captured before the live puppet's first clip; omitted
controls reset, `clip: null` selects rest, and finite times wrap in either direction. Optional
`poses` maps bone names to the same pose offsets; `morphs` contains `{part, target, weight}` entries.
The complete input validates before replacing the last sample, then applies in one batch.

The sampler exposes its detached `root` for a separate renderer; it never seeks or pauses the live
puppet or touches a renderer/camera. Its transforms, skeletons and materials are independent.
Geometry and textures remain borrowed read-only: live vertex-color/geometry edits are visible
through those shared objects, and later live scene additions are omitted. All skinned bones must
be descendants of the imported scene, as in ordinary GLB scenes. Dispose the sampler when done;
this releases its materials and skeleton textures, never the borrowed geometry or image textures.
`node scripts/check-pose-sampler-browser.mjs [model.glb]` verifies twelve offline rendered exposures
and unchanged live pose, playback, camera and pixels.

Authored GLBs retain every material slot. `setColor(part, hex, slot?)` and `setMaterial(part, {metalness?, roughness?}, slot?)` update all slots when `slot` is omitted; `getColor(part, slot?)` and `getMaterial(part, slot?)` read the first slot by default. Slots are zero-based and isolated from other parts. `setPattern` rejects multi-material parts before changing them, so group colors remain intact.

Playback supports imported position, rotation, scale and morph-weight tracks, restoring authored values when switching to a clip that leaves them unanimated. `setMorph(part, targetName, weight)` overrides a named morph after clip sampling, and `setMorphs({part: {target: weight}})` sets many at once, validating all of them first. A glTF mesh with several primitives (skin, lids and teeth as material slots of one mesh, sharing morph names) loads as a group of per-primitive meshes; its node name (listed in `morphGroups`) addresses the morphs of every primitive at once, and `morphTargets(name)` lists a part's or group's target names; `getMorph(part, targetName)` reads its effective weight. Weights must be finite and may extend beyond 0..1. `resetMorph(part?, targetName?)` clears one target, one part, or all overrides, revealing the current clip or authored rest weights. Target names are available through `object(part).morphTargetDictionary`; `bounds()` measures the currently visible, morphed and skinned surface.

`MeshViewer.createPlanarLinkage(spec)` creates a stateless analytic 2D mechanism without a
renderer or physics engine. The same factory is available from `src/mechanisms/planar-linkage.ts`:

```js
const linkage = MeshViewer.createPlanarLinkage({
  fixed: { O: [0, 0], P: [2, 0] },
  crank: { name: 'C', center: 'O', radius: 1 },
  joints: [{ name: 'J', a: 'P', b: 'C', ra: 2, rb: 2, branch: 1 }],
});
const { points, minimumBranchGap } = linkage.sample(Math.PI / 3);
// points.J is the intersection of circles (P, 2) and (C, 2).
```

Use consistent units and radians. Intersections are ordered: their centers must already exist.
`branch: 1` chooses the left side of the directed line from `a` to `b`; `-1` chooses its right.
The crank starts on positive X and rotates counterclockwise. Each sample detaches and deeply
freezes a new numeric point record with a null prototype, independent of previous calls. The
factory also detaches its input. `minimumBranchGap` measures the closest pair of alternate
intersections, or is `null` for a crank without intersections. Callers own timing, phase offsets,
traces and rendering; a Y-aligned planar rod can use `rotation.z = Math.atan2(-dx, dy)`.

Bounds are 1–32 fixed points, one crank, 0–64 intersections, coordinates within ±1e6, radii
1e-6..1e6 and angles within ±1e9 radians. Names are unique ASCII identifiers beginning with a
letter, at most 64 characters, with letters, digits, underscores, dots and hyphens thereafter.
Malformed or sparse graphs reject at creation. Sampling rejects unreachable, coincident or
near-tangent circles, out-of-range outputs, and coordinate precision loss (returned radii must
agree within 1e-8 relative error each). Normalized squared intersection height must exceed
128 × machine epsilon, so extremely ill-conditioned assemblies reject even if mathematically
possible. Failed samples leave other samples untouched. A valid graph does not guarantee closure
at every angle; this API does not simulate contact, load, collision or balance.
`node scripts/check-planar-linkage-browser.mjs` checks the bundled factory offline through a
complete corrected Jansen turn and records a rendered trace in `.agent-meshes/check-planar-linkage`.

`MeshViewer.createSweep(spec)` creates a runtime tube or elliptical strip with closed, flat-shaded caps. It returns `{geometry, update(spec), samplePath(u), length, dispose()}` and works without mounting a viewer or loading a GLB. The same factory is available from `src/render/sweep.ts` in Node. Assign its geometry to a Three mesh or an existing viewer part; the caller owns the material, mesh transform and eventual `dispose()` call.

```js
const form = MeshViewer.createSweep({
  centers: [[0,0,0], [0,1,0], [.3,2,0]],
  radii: [[.2,.1], [.3,.12], [.08,.04]],
  radialSegments: 24,
  initialNormal: [1,0,0],
  twist: [0, .1, .2] // radians per ring
});
const halfway = form.samplePath(.5); // position, unit tangent, segment, t
```

Centers and radii must have matching counts; a scalar radius makes a circular section. Coordinates, positive radii and twist must be finite. Parallel transport keeps the cross-section frame stable; provide an explicit `initialNormal` for a family of shapes, perpendicular to the initial direction when possible. If omitted, the chosen seed is retained across updates. `update` keeps the original ring/radial counts, index and attribute objects, recomputes normals and bounds, and rejects invalid changes before mutation. Omitted `radialSegments` retains its original value; omitted twist means zero twist. UVs run around the section and along normalized centerline distance, with matching normals across the UV seam and separate flat cap normals.

`samplePath(u)` accepts normalized **distance** in 0..1 and returns a fresh immutable `{position, tangent, segment, t}`; `segment` and `t` identify the original centerline interval for labels or markers. The path is piecewise linear. Repeated points, antiparallel cusps, degenerate frames, more than 4,096 rings, more than 256 radial segments, or more than one million vertices are rejected. These bounds do not prove non-self-intersection: round abrupt centerline corners and keep section radii small enough for the bend. Smooth frames cannot repair an intersecting surface, and interpolating two paths is a visual deformation rather than a physical unfolding simulation.

`MeshViewer.createCarver(options)` is a separate asynchronous path for interactive solid carving. It samples an immutable project's shell field inside explicit bounds, caches the requested resolutions in an inline Blob worker, and extracts a new indexed surface for each cutter. Existing shell renders/exports keep their current mesher. The body uses `shell.blend`; each request has an independent `cutBlend` for the opening's rounded rim.

```js
const carver = MeshViewer.createCarver({
  project, shell: project.shells[0],
  bounds: {min: [-2,-.1,-1], max: [2,2,1]},
  resolutions: [56,128],
  floorY: 0 // optional, immutable clipping plane retaining Y >= 0
});
const next = await carver.update({
  cutter: {center: [0,.8,0], radii: [.3,.2], halfLength: 1.2,
           rotation: [0,0,0,1]}, // cylinder local Z axis; unit quaternion
  resolution: 56, cutBlend: .05, removed: true
});
if (next) {
  sculpture.geometry.dispose();
  sculpture.geometry = next.geometry;
  // next.removed is the actual removed material, including the rounded rim.
  // Own/dispose it too; it can contain multiple connected pieces or be empty.
}
// Request the finer grid after input settles. A null cutter restores the body.
// Leave the last good geometry visible while a request is pending or fails.
carver.dispose();
```

Only one request runs at a time; one queued request is retained. Superseded requests and requests pending during `dispose()` resolve to `null`; invalid requests and worker errors reject. Invalid input does not supersede a valid active request. Returned geometry belongs to the caller: replacing/discarding it requires `dispose()`, and disposing the carver stops its worker without disposing previously returned meshes. A body or removed result can be empty: check `geometry.attributes.position.count === 0` and skip fitting/bounds calculations for it. The API never changes a camera, material, or scene. The standalone viewer embeds the worker and supports `file://` without network access; pages enforcing CSP must permit Blob workers. Node code can use `createSolid(field, {bounds,resolutions})` from `src/render/carving.ts` for the same synchronous kernel and typed-array results; its field function must remain immutable.

Bounds must enclose the full uncut body with a positive field at every grid boundary sample. One to three resolutions (integers 16–192) are allowed, with at most four million samples per grid and six million across cached grids. Extraction also limits vertices/triangles. Validation happens before grid allocation; finite field samples and boundary clearance are checked when sampling. `stats` reports sampling/extraction timings, cache reuse and sample count, not a manifold certificate. Consistent tetrahedra share crossing vertices and orient faces from the local field. Final Float32 coordinates are welded, collapsed faces removed, and every remaining edge must have one triangle in each direction; precision-unsafe results reject. Shading normals estimate the resulting cut-field gradient. This is sampled geometry: small features, critical topology transitions, very thin removed layers and non-distance input fields require consumer checks at their chosen resolutions. Connectivity, vertex-fan manifoldness, self-intersection and a single removed piece are not universal guarantees. Preview/final resolution and debounce policy belong to the exhibit; a slower refinement remains asynchronous and is not a 60 fps promise.

### Several models on one stage

`MeshViewer.mountStage(container, options)` puts several GLB models into one viewer: one renderer, scene, camera, room and floor, so a page with three characters opens one WebGL context, not three. Each model has its own placement and its own independent puppet.

```js
const stage = await MeshViewer.mountStage(document.getElementById('stage'), {
  models: {
    pip:  { glb: pipBase64,  position: [-0.6, 0, 0], rotation: [0, 10, 0] },
    bolt: { glb: boltBytes, position: [0.6, 0, 0], scale: 1.1 },
  },
  background: '#f4efe6',
});
const pip = stage.model('pip');
pip.setMorph('face', 'jawOpen', 0.6);            // Bolt's jaw stays shut
const mouth = pip.worldPoint('jaw', [0, 0, 0.1]); // world [x, y, z], through Pip's placement
stage.model('bolt').aimBone('eye_L', mouth, { maxYaw: 30, maxPitch: 20 }); // Bolt looks at Pip
stage.model('bolt').setPlacement({ rotation: [0, -15, 0] });
stage.frame();                                    // fit every model; stage.frame({model: 'pip'}) fits one
```

Options are `models` (`{name: {glb, position?, rotation?, scale?, autoplay?}}`), `autoplay`, `background`, `orbit`, `floor`, `view` (default `front`), `outline`, `outlineColor` and `quality`. Names are a letter followed by up to 63 letters, digits, `_` or `-`; `rotation` is XYZ Euler degrees; `scale` is a positive number or triple. Unknown options, bad placements and duplicate names are rejected, naming the problem, before a WebGL context is created. `stage.model(name)` has the whole puppet API (`setPose`, `setMorph`, `setColor`, `play` and the rest, scoped to that model) plus `setPlacement` (omitted fields keep their value), `getPlacement`, `worldPoint(node, point?)`, and `observe`/`bounds` in world space. Unknown names throw, listing the models, and a handle used after its model is removed throws. The stage also has `models`, `add(name, model)` (a promise) and `remove(name)`, `bounds(model?)`, `view(name | {position, target}, {model?, padding?})` and `frame({model?, padding?})` (named views fit every corner of the chosen bounds in the frustum), `screenshot`, `idRender`, `onFrame`, `setBackground`, `resize`, `dispose` and the underlying three.js objects. `node scripts/check-stage-browser.mjs` verifies it in Chromium with three models. `node scripts/check-stage-perf-browser.mjs` drives three skinned 12.5k-vertex heads (one glTF face mesh with six primitives sharing 25 ARKit morphs, plus two eye poses, every frame) at 1280×720 in headless Chromium with software GL and asserts a median frame ≤ 33 ms and p95 ≤ 50 ms with `quality: 'fast'` (measured 16.7 ms and 33.4 ms; the default `high` quality measures about 117 ms).

### ID render for pixel checks

`viewer.idRender(options)` and `stage.idRender(options)` render once with every surface replaced by an unlit flat color and return `{width, height, data}`: RGBA bytes, top row first. The render skips lighting, tone mapping, color-space conversion, fog, the environment and shadows, and it draws into a single-sampled target, so every pixel is exactly one requested color and no edge blends two. It uses the live morph weights, poses and skinning. Afterwards the original materials, visibility, background and camera aspect are restored, and the temporary materials and target are disposed.

```js
const image = stage.idRender({
  models: ['pip'],                                          // stage only; default all
  materials: { iris: '#0000ff', 'pip/skin': '#ff0000' },    // material name, optionally model-scoped
  parts: { 'teeth#0': '#00ff00' },                          // part, or part#slot
  background: '#000000', other: '#808080',                  // other: null hides unmatched surfaces
  width: 512, height: 512,
});
MeshViewer.countColors(image);   // {'#0000ff': 812, '#ff0000': 40110, ...}
```

Precedence is `part#slot`, then `part`, then material name, and a `model/` key beats an unscoped one. Unmatched surfaces take `other`, which defaults to the background color so they still occlude. Colors must be `#rrggbb`, and a key that matches nothing throws, listing the names that exist. Outline hulls and the floor are not drawn. `screenshot({id: options})` returns the same render as a lossless PNG data URL.

## Named-frame assemblies

`MeshViewer.createAssembly(spec)` controls a reversible assembly without owning a scene or
loading a physics engine. Node callers import it from `src/render/assembly.ts`. Pieces declare
their assembled and staged transforms; named joints declare matching local frames. Matrices
are sixteen column-major numbers, as returned by Three's `Matrix4.toArray()`.

```js
const assembly = MeshViewer.createAssembly({
  pieces: [
    {id: 'base', assembled: baseMatrix, staged: baseMatrix,
     explode: [0, 0, 0], fixed: true},
    {id: 'rail', assembled: railMatrix, staged: trayMatrix,
     explode: [.2, 0, 0]}
  ],
  joints: [{id: 'rail-to-base', child: 'rail', parent: 'base',
    childFrame: railSocketMatrix, parentFrame: baseSocketMatrix}]
});

const result = assembly.snap('rail'); // {ok:true}, or a blocked action
const state = assembly.snapshot();
// When the rendered piece is a direct child of the assembly coordinate frame:
railObject.matrixAutoUpdate = false;
railObject.matrix.fromArray(state.transforms.rail);
railObject.updateMatrixWorld(true);
```

Every movable piece needs a joint and an acyclic path to a fixed foundation. All named parents
must be connected before `snap(id)` can place a child. The first mating frame determines its
complete placement; every required secondary frame is checked before committing. Frames match
in position, orientation and scale, so author any intended face-to-face rotation into the local
frames. Constructor checks also require the declared assembled frames to coincide.

`remove(id)` refuses fixed pieces or supports with connected dependents. Blocked actions return
`{ok:false, reason, pieces}` with reason `missing-pieces`, `dependent-pieces`, `fixed-piece` or
`exploded-view`; they do not change state. Unknown names and malformed or numerically unsafe
input throw. `setExplode(0..1)` translates connected pieces by their authored offsets in assembly
coordinates for inspection; it preserves their logical connections, and snapping requires a
closed view. Loose pieces stay at their staged matrices. `reset()` restores fixed foundations,
staged pieces and zero explosion. `dispose()` is idempotent; other methods reject afterward.

Snapshots and `anchors()` return independent, deeply frozen numeric data. Snapshot `available`
lists dependency-ready loose pieces (close the exploded view before snapping); `missing` lists
each piece's absent parents. Anchors contain source/target points, their displayed gap and a
logical `joined` flag. They describe authored mating frames, not measured mesh contact or
structural strength. The caller owns picking, highlights, color, motion between placements and
all meshes/materials. No geometry or renderer is allocated or disposed by this controller.

`MeshViewer.solveFrame(sourceLocal, targetWorld, parentWorld?)` is the standalone alignment
primitive: `inverse(parentWorld) * targetWorld * inverse(sourceLocal)`. The parent defaults to
identity. Its frozen output retains reflections and shear; use the complete matrix with
`matrixAutoUpdate=false`, because decomposing to position/rotation/scale can lose shear.
All piece placements share one assembly coordinate frame. Convert to a different rendering
parent explicitly rather than assigning an assembly matrix as an unrelated local transform.

Limits are 128 pieces, 512 joints and 128 characters per nonempty name. Finite matrix/offset
components must stay within ±1e9; the linear matrix infinity norm must be at least 1e-9 and its
estimated condition number at most 1e8. Singular, inversion-overflow and unsafe output matrices
reject. Affine bottom-row roundoff up to 1e-12 is normalized to `[0,0,0,1]`; perspective matrices
reject. Mating agreement uses an absolute 1e-7 tolerance per matrix element. Invalid edits or
inconsistent secondary frames preserve the last state. These checks bound numerical work and
placement consistency; they do not detect geometry intersections, hidden gaps or weak joinery.

## Connected planar figure contours

The existing `MeshViewer` runtime also exposes a renderer-independent figure controller. It returns one connected 2D boundary, with elbows and knees solved from hand/foot targets. The fixed `dance-v1` profile supports open dance gestures; it is not an arbitrary rig, crossed-limb solver, or validated 3D extrusion.

```js
const figure = MeshViewer.createPlanarFigure({ leftHand: [-105, -123] });
function draw(snapshot) {
  path.setAttribute('d', 'M' + snapshot.points.map(p => p.join(',')).join('L') + 'Z');
  // Position handles and motion marks from snapshot.limbs[name].end, not the request.
}
draw(figure.snapshot());
draw(figure.setTargets({ leftHand: [-128, -70] }));
draw(figure.reset()); // this controller's creation pose
```

Coordinates are profile-local, X right and Y down. Apply placement/scale in the consumer renderer. `MeshViewer.planarFigureProfile` is deeply frozen and supplies the default targets, target rectangles and stable vertex count. Rectangles are `[minX, maxX, minY, maxY]`:

| Target | Rectangle | Bone lengths |
| --- | --- | --- |
| `leftHand` | `[-128, -58, -165, -70]` | 55, 49 |
| `rightHand` | `[58, 128, -165, -70]` | 55, 49 |
| `leftFoot` | `[-110, -30, 76, 146]` | 64, 60 |
| `rightFoot` | `[30, 110, 76, 146]` | 64, 60 |

Finite targets clamp to these rectangles before solving. Reach then clamps to 70% of the combined bone lengths through their sum minus 4; a fixed bend branch prevents joint flips. `snapshot.targets` contains the rectangle-clamped requests. `snapshot.limbs[name]` contains `root`, `joint`, actual `end`, `lengths`, and `constrained` (whether the actual endpoint differs from the submitted request). These are stylized proportion units, not anatomical measurements. Widths, attachment roots, head and torso are deliberately fixed. Joint fillets have radii greater than limb half-widths, keeping the inner bend from folding back.

Every update validates its entire 420-point contour before replacing the current state. Returned snapshots include actual point bounds and signed area, and are deeply frozen. Invalid input, unknown target keys or an invalid generated contour throw while retaining the last valid snapshot. `setTargets({})` is a no-op. Controllers retain only their creation and current states; no DOM, timers, Three objects, GPU resources or edit history exist, so there is no `dispose()` step. Consumers own any snapshots they choose to keep.

`MeshViewer.validatePlanarContour(points)` is also available for bounded simple polygons. It accepts 3..512 finite two-number points with coordinates within [-10000, 10000], implicit closure, either winding and straight subdivisions. It rejects edges <= 1e-7, area magnitude <= 1e-8, nonadjacent touching/crossing, and backtracking; geometric comparisons use a 1e-8 tolerance. It returns frozen signed area and bounds. This validates the boundary only; it does not promise safe thick stroke offsets, triangulated caps or watertight extrusion. Passing a repeated closing point is an error.

Tests cover all 256 simultaneous target-rectangle corners, seeded interior poses, a continuous gesture, fixed bone lengths, nonlocal intersections, mutation isolation and failed-update retention. The profile and output sample count are intentionally bounded; enlarging its pose domain requires new geometry and visual acceptance evidence.

## Optional hanging-mobile physics

```powershell
node scripts/agent-meshes.mjs mobile-physics lib/mobile-physics.js
```

This separate script defines `window.MobilePhysics` with `createHangingMobile(spec)` and `validateMobileSpec(spec)`. It embeds Rapier 3D **0.20.0** and its WASM for offline use, including `file://`; no renderer, network fetch or Three dependency is included. Load it only in pages that need physics. The default viewer and workbench do not import it. The CLI prints the output path and byte count, like `viewer <file>`.

A spec contains named rigid pieces, sampled wire paths, optional convex sheet contours and one connected suspension tree. Units are meters, kilograms and seconds, with Y up. Every piece starts at identity rotation; the controller places its local suspension anchor at its parent's local anchor. The root's `parent: null` attaches to the fixed ceiling at a world coordinate. For example:

```js
const wire = points => ({ points, radius: .0045, density: 7850 });
const spec = { nodes: [
  {
    name: 'bow',
    wires: [wire([[-.7,0,0], [0,.1,0], [.7,0,0]])],
    suspension: { parent: null, parentAnchor: [0,2.5,0], anchor: [0,.1,0] }
  },
  ...[-.7, .7].map((x, i) => ({
    name: i ? 'right' : 'left',
    wires: [wire([[0,0,0], [0,.25,0]])],
    leaf: {
      contour: [[0,0], [.2,-.2], [0,-.45], [-.2,-.2]],
      thickness: .0014, density: 2700, scaleRange: [1,1.65]
    },
    suspension: { parent: 'bow', parentAnchor: [x,0,0], anchor: [0,.25,0] }
  }))
] };
const mobile = await MobilePhysics.createHangingMobile(spec);
mobile.setLeafScale('left', 1.4);
mobile.applyGust({ direction: [0,0,1], strength: .7 });
mobile.advance(elapsedSeconds);       // consumer's animation loop
const snapshot = mobile.snapshot();   // immutable poses, geometry, masses, anchors
// Apply each named pose to a scene group. Build its wires/sheet from the same
// local geometry; scale only the sheet in XY by pose.scale, retaining thickness.
mobile.clearAccumulator();            // when pausing or hiding the page
mobile.reset();                       // original geometry, controls and solver state
mobile.dispose();                    // frees the engine world; safe to call twice
```

Typed interfaces are exported from [src/physics/mobile.ts](src/physics/mobile.ts). Sheet contours are ordered convex XY polygons, extruded equally on both sides of local Z = 0. `setLeafScale(name, scale)` scales XY about the local origin and recomputes mass/inertia from the same thickness and density. Attached wires stay fixed, so author the sheet's attachment at its local origin. The allowed `scaleRange` must contain 1; omitting it fixes the sheet at its authored size. Wire mass uses cylindrical segment volumes at the authored density; capsule inertia approximates each segment. Snapshot `mass` includes its wires and sheet, while `leafMass` reports only the sheet. Snapshot arrays and local geometry are immutable and contain no engine objects; positions/quaternions and both local/world joint anchors describe the current simulated state.

A wire piece can also declare `hanger: {wire: 1, path: sampledRail, initial: .5}`. The indicated wire must start at that normalized distance along the rail and end at the piece's suspension anchor. Author the rail along the supporting bow. `setHanger(name, u)` targets normalized **arclength** in 0..1, translating that complete hanger wire and its real joint anchor along the rail. Movement is limited to .008 m per physics step; snapshots include the updated wire geometry for rendering. Changing the anchor injects work into the simulation rather than prescribing a bar angle.

`advance(seconds)` runs fixed 1/120-second steps, at most eight per call, and returns the count. Excess elapsed time is discarded, so a stalled or hidden page cannot accumulate unlimited catch-up work. Pause, visibility and reduced-motion policy belong to the consumer. `applyGust` normalizes its nonzero direction and applies 0..2 N·s per exposed square meter at each leaf's area centroid. This is a short impulse approximation, not fluid simulation. Reset reconstructs the world, including warm-start solver state; failed reconstruction preserves the current world. All methods except idempotent `dispose()` reject after disposal.

Validation copies and freezes inputs before engine initialization/world allocation: 1–32 pieces, 0–8 wires per piece, 2–128 samples per path, at most 2048 wire segments, 3–128 points per convex leaf, one root, unique names, no cycles or unknown parents. Coordinates are finite within ±1000 m, radii/thickness .00001–1 m, density 1–50000 kg/m³, authored piece mass .000001–100000 kg, and leaf scale limits .1–4. Degenerate paths and concave/self-crossing contours reject. Invalid controls leave the current state untouched. Each piece needs physical geometry.

Leaf-to-leaf contacts use convex sheet colliders, four CCD substeps and 16 solver iterations. **Wire collisions are disabled**: wires contribute mass/inertia, while spherical joints represent their connections. Bows and hangers are rigid; damping, capsule inertia and gusts are approximations. Extreme contact configurations still require consumer testing, especially thin sheets at speed; this is not a general guarantee against tunneling, wire entanglement or self-intersection. The seven-leaf regression retains 14 bodies, 511 colliders and 13 joints and verifies real ancestor motion, mass/inertia, thin-sheet contact, reset/disposal and offline export. Hardware phone performance remains a consumer release check.

## Five animated examples

```powershell
npx playwright install chromium
npm run examples
npm run check:creatures
node scripts/check-recipe-browser.mjs
```

Open `artifacts/creatures/index.html` for the gallery, or a creature's `preview.html` for standalone offline playback. Each `artifacts/creatures/<kind>/` directory contains the editable `project.mesh.json`, animated `model.glb`, validation report, fixed views, and an eight-frame contact sheet for each gait. `artifacts/creature-sources/<kind>/` holds generated input and build config; copy that input to a new location to develop a variation without the recipe generator overwriting it. Artifacts are ignored by Git and rebuilt from the recipe source.

| Recipe / CLI name | Rig and motion |
| --- | --- |
| `biped` | Two legs, opposite arm swing, weighted upper legs, body bounce and head motion |
| `equine` | Shoulder/elbow/carpus and hip/stifle/hock chains, fetlocks/pasterns and hooves; walk and trot |
| `vulpine` | Shoulder/elbow/wrist and hip/stifle/hock chains ending in paws; walk and trot |
| `insectoid` | Six articulated legs; left-front/right-middle/left-rear form one tripod, the other three form its counterpart |
| `arachnid` | Eight legs with seven anatomical segments each; constrained hinges, low recovery arcs and staggered footfalls |

The deterministic recipes in `src/recipes/index.ts` generate ordinary project data. Leg rotations are baked at 60 samples/second (120 for quadrupeds); stance feet move uniformly backward for **in-place** locomotion, while lifted feet return forward. Biped and insectoid use a two-link IK solver. Quadrupeds solve the upper two links against articulated distal sections, with coupled recovery flex and level feet. The spider swings and lifts each leg primarily at the coxa next to the thorax. Five downstream joints retain their rest angles; one small patella adjustment maintains reach. Its wider, less fore/aft-splayed animated stance and hip-centred recovery arc reduce the need for leg bending. Root bob is compensated in the foot targets. Each clip has identical endpoint keys. The models travel forward when your game moves their root at the intended speed; the clips themselves do not contain forward root motion. For matching ground speed, use `stride / (stance fraction × clip duration)`: biped 0.699, horse walk/trot 0.365/1.071, fox walk/trot 0.347/0.938, insectoid 0.346 and arachnid 0.223 model units/second.

Quadruped walks use four separate footfalls (left hind, left fore, right hind, right fore). Trots pair opposite diagonals with overlapping support. Each species has its own stride, cadence, clearance and body rise. These are stylized, authored cycles, not motion capture or a balance simulation. The command `recipe quadruped` remains an alias for `recipe vulpine`; existing saved projects are unchanged. Both clips are available in each preview’s animation selector.

Each spider leg has **coxa → trochanter → femur → patella → tibia → metatarsus → tarsus**, with one named bone, rigid-bound visible section and animation track per segment. An additional unmeshed tip bone measures ground contact. The spider rig has 66 bones in total. All four leg pairs attach along the front body section (the thorax/prosoma), clear of the abdomen; a narrow pedicel connects the two body sections. Attachment tests check actual positions against the body shells. The sections remain independently editable, but the gait deliberately holds most joints still so the limb keeps its shape. Tests bound cumulative downstream flex as well as individual joint movement, and require the thorax joint to dominate both. Staggered swing timing keeps at least four feet supporting the body, and the lower recovery arc limits exaggerated stepping. This is a stylized seven-segment rig; its joint limits and gait parameters are authored for this model rather than measured from a species. Existing saved spider projects retain their previous animation; load `recipe arachnid` or choose Arachnid in the workbench to start from the revised template.

`check:creatures` validates all five GLBs and every clip, reloads them independently, checks actual animated skin vertices and loops, and opens every standalone preview in Chromium. Tests also check minimum supporting-foot counts and sub-frame ground contact. The examples use authored procedural rigs; automatic rigging of arbitrary imported meshes and destination-engine integration are outside this release.

Project design and delivery evidence are maintained in the owner's wiki under `wiki/authored/agent-meshes/`.

### Ideal planar belt drives

`MeshViewer.createBeltDrive({driver:{center:[0,0],radius:.18}, driven:{center:[1.2,0],radius:.36}, crossed:false})`
returns an immutable renderer-independent two-pulley model. Centers and pitch radii use the
same units. `ratio` is driven angle / driver angle; it is positive for an open belt and
negative for crossed routing. `sample(angle)` returns unwrapped driver/driven radians and
signed `beltTravel`. Positive angles are counterclockwise in the specified plane.

`segments` contains two exact tangent lines and two circular wrap arcs in closed path order.
`point(distance)` wraps a signed path distance and returns an immutable position/unit tangent;
`point(sample(angle).beltTravel)` follows the driving rim. Consumers own scene objects,
time and resources. Recreate the tiny model when changing radii or centers; the resulting
belt length changes too. There is no hidden tensioner, slip, thickness, friction, elasticity,
inertia or force simulation. A crossed path's intersection is a mathematical crossing.

Inputs require disjoint pitch circles, finite centers in ±1e6 and radii in1e-6..1e6, with
sufficient numerical separation and coordinate/radius precision. Angles/output angles are
bounded to ±1e9 and travel to ±1e12; distances that can no longer resolve phase reject.
Configuration arrays are copied, output data frozen, and samples have no retained state.
The distance-phase precision check can reject accumulated travel even when its angle sample
remains valid; consumers should bound or restart a long-running demonstration explicitly.
Run `node scripts/check-belt-drive-browser.mjs` for a real offline public-factory proof.
The helper preserves full turns for ratios; it never wraps the driver before deriving the
output. See `tests/belt-drive.test.ts` and the real viewer-bundle smoke test.
