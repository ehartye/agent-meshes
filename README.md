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

Includes five editable, rigged low-poly characters: **Copper courier** (biped walk), **Amber horse** (equine walk/trot), **Ember fox** (vulpine walk/trot), **Jade scarab** (six-leg tripod gait), and **Indigo weaver** (eight-leg alternating gait). No Blender installation is needed. Horses and foxes can also carry a **gallop** with a true suspension phase: `recipe equine --gaits walk,trot,gallop` chooses which clips a quadruped recipe generates (default `walk,trot`, so the bundled examples are unchanged). `--shell` blends the whole animal into one smooth skin with lathe hooves; eyes and nostrils stay crisp on top. `recipe strandbeest --pairs 3` builds Theo Jansen's walking machine from his published rod lengths: each leg is his eleven-rod linkage solved every frame from one crank, mirrored pairs share a crankshaft with the cranks offset evenly, and the foot traces the real flat-bottomed Jansen curve. `--spacing` sets the distance between pairs and `--patterns '{"turn":[0,0.33,0.67]}'` makes one clip per named set of crank offsets, for comparing timings. The scarab takes `--leg-phases '{"tripod":[0,0.5,0,0.5,0,0.5],"ripple":[0,0.17,0.33,0.5,0.67,0.83]}'`: one clip per entry, each a touchdown phase per leg in order L1 L2 L3 R1 R2 R3, for comparing leg timings.

```powershell
npm ci
npm run build
npm start
```

Open the loopback URL printed by the server (normally http://127.0.0.1:3388). Add primitives, select named parts, edit their dimensions and positions, orbit or select a fixed camera view, and undo/redo edits. Open and Save project buttons load/download portable JSON. The live editing state is in memory; save your project before stopping the server. Use `serve --project path.json` to reopen saved work on startup.

Choose a creature in the left sidebar to load its model, rig and looping clip. Loading replaces the active project in one undoable action; save edits before moving between examples. Playback starts automatically unless reduced motion is enabled. Pause to inspect a pose, enable Skeleton → Show, or select a joint to edit it.

The HAL9000 creature gallery is available on the private tailnet at **https://hal9000.taila5c443.ts.net:8459/**. It serves the five animated viewers, editable project downloads and GLB exports directly from `artifacts/creatures`; it does not expose the editing API. Its route is:

```powershell
tailscale serve --bg --https=8459 C:\Users\ehart\repos\agent-meshes\artifacts\creatures
```

For an editing server behind a trusted private reverse proxy, `serve --public-origin <https-origin>` permits that exact browser origin while other origins remain rejected. The server still binds to loopback. This option is implemented and tested, but the remote editor is not deployed on HAL9000: automatic approval review blocked starting its process. The gallery route above is live and verified. A future editor deployment should use a separate available port and retain the gallery route. Tailscale controls network access; the editor shares one active project with devices allowed to reach it. No boot service is installed for the editor.

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

`blend` is how far two members reach toward each other before they merge, in meters; `resolution` is the number of grid cells along the longest axis (16 to 96). The shell takes its colors from the members that own each point, so a red head and a brown body fade into each other at the neck. Members must all be rigid-bound (the shell is then skinned, each point following the bones of the parts that own it) or all unbound (a static mesh). Members stay editable as parts; `shell.remove` shows them individually again. Lathe, prism and every primitive have a signed distance function, so all of them can be members.

A part can be placed relative to a bone instead of the world: `{"op":"add","part":{"name":"ring","anchor":"hand","position":[0,-0.5,0],...}}` interprets `position` and `rotation` in the `hand` bone's rest frame and stores the world result, so a part meant to hang from a bone never needs the bone's world position copied by hand.

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

Rendering requires the built workbench (`npm run build`) and Chromium (`npx playwright install chromium`). `build build.json --no-preview` produces the project, GLB and validation report without a browser. `--no-preview-page` keeps the PNG renders and contact sheets but skips the 1 MB `preview.html`, for pipelines that embed the GLB in their own page. Each build uses isolated state, stages and verifies outputs, then replaces only a directory marked as owned by that config. Extra files, symlinks, and concurrent builds are rejected. Failures preserve the last published build. After a crashed process, check that it has stopped before manually removing the adjacent `.agent-meshes.lock` file.

`node scripts/check-animated-build.mjs` exercises rendered builds and offline exported playback. `node scripts/check-animation-browser.mjs` then verifies scrubbing, key recording and pose editing in the workbench. These write ignored evidence under `artifacts/`.

## Optional Blender stage

`node scripts/agent-meshes.mjs refine model.glb smooth.glb --subdivide 1 --noise 0.004 --noise-scale 0.05 --only robin` rounds primitives into organic forms with a subdivision surface and, if asked, adds a feather- or fur-like displacement from a procedural clouds texture, while keeping bones, skins, vertex colors and clips. It runs Blender headless through `scripts/blender-refine.py`; Blender is found on PATH, in the usual install folders, in the Microsoft Store app alias, or from `AGENT_MESHES_BLENDER`. Nothing else in agent-meshes needs Blender, and the refine test skips when it is absent.

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

`mount(container, options)` fills the container and follows its size. `glb` is bytes or a base64 string, which works from `file://` where `fetch` does not. Options: `autoplay` (default follows `prefers-reduced-motion`), `background` (`null` for transparent), `orbit`, `floor`, `view` (`front`, `side`, `top`, `perspective` or `{position, target}`), and `outline` (an ink outline of that thickness in meters behind every part, with `outlineColor`). The scene is lit by a procedural room environment plus a key and fill light, with soft shadows; shells carry ambient occlusion baked into their vertex colors from the distance field, so crevices read dark without any texture.

The viewer exposes the puppet by name: `bones`, `parts`, `clips`; `setPose(bone, {rotation?, position?, scale?})` (scale multiplies the bone and everything it carries, so a longer leg moves its foot), `getPose`, `resetPose(bone?)`; `setColor`, `getColor`, `setVisible`; `play(clip?)`, `pause`, `playing`, `clip`, `time`, `duration`, `speed`, `seek`; plus `view`, `frame`, `setBackground`, `screenshot`, `onFrame`, `resize`, `dispose`, and the underlying `renderer`, `scene`, `camera`, `controls`. Pose offsets compose on top of clip playback each frame. `node scripts/check-viewer-browser.mjs` verifies the runtime in Chromium.

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
