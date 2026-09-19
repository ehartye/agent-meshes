# Agent Meshes

Named-part 3D authoring for coding agents, with a live browser workbench. Requires Node.js 24 or later.

```powershell
npm ci
npm run build
npm start
```

Open the loopback URL printed by the server (normally http://127.0.0.1:3388). Add primitives, select named parts, edit their dimensions and positions, orbit or select a fixed camera view, and undo/redo edits. Open and Save project buttons load/download portable JSON. The live editing state is in memory; save your project before stopping the server. Use `serve --project path.json` to reopen saved work on startup.

In another terminal:

```powershell
node scripts/agent-meshes.mjs new robot
node scripts/agent-meshes.mjs op '{"op":"add","part":{"name":"body","geometry":{"type":"box","size":[1,2,1]},"position":[0,1,0]}}'
node scripts/agent-meshes.mjs save robot.mesh.json
node scripts/agent-meshes.mjs state
```

The CLI prints JSON and exits nonzero on failures. `batch operations.json` applies an array of operations atomically, with one undo step. `open`, `save`, `undo`, and `redo` share the browser's active project. `--url` chooses an already-running server; identity checks prevent edits against an unrelated service. Run `node scripts/agent-meshes.mjs --help` for commands. Names start with a letter and contain letters, numbers, underscores, hyphens or dots. Transforms use meters and Y-up coordinates; rotations are unit quaternions `[x,y,z,w]`.

Development: run the API with `npm start`, then `npm run dev` for Vite's live reload. `npm test`, `npm run typecheck`, and `npm run build` verify the code. `npx playwright install chromium` then `node scripts/check-browser.mjs` exercise the built workbench and write a screenshot under `artifacts/`.

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

Rendering requires the built workbench (`npm run build`) and Chromium (`npx playwright install chromium`). `build build.json --no-preview` produces the project, GLB and validation report without a browser. Each build uses isolated state, stages and verifies outputs, then replaces only a directory marked as owned by that config. Extra files, symlinks, and concurrent builds are rejected. Failures preserve the last published build. After a crashed process, check that it has stopped before manually removing the adjacent `.agent-meshes.lock` file.

`node scripts/check-animated-build.mjs` exercises rendered builds and offline exported playback. `node scripts/check-animation-browser.mjs` then verifies scrubbing, key recording and pose editing in the workbench. These write ignored evidence under `artifacts/`.

Project design and the animated biped/quadruped/insectoid/arachnid acceptance bar are maintained in the owner's wiki under `wiki/authored/agent-meshes/`. The four creature recipes follow as the next feature.
