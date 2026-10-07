---
name: mesh-build
description: Export, verify, render and deliver agent-meshes models as GLB with isolated build configs, fixed-view renders and clip contact sheets, offline preview pages, the embeddable MeshViewer runtime with its puppet API, multi-model stages and exact ID renders for pixel checks, fast Workbench previews of Blender-authored sources (matcap, wire, cavity, posed shape keys) with an optional persistent worker, the optional Blender refine stage, the headless Unreal import check, Blender-authored static props, and shared-camera contact sheets and budget stats for a set of GLBs.
when_to_use: Use when asked to export or verify a GLB, render or screenshot a model, produce a preview page, embed a 3D model in a web page, put several models on one page, count rendered pixels per part or material, set up a repeatable build.json, smooth and feather a model in Blender, preview a Blender-authored model quickly (matcap, wireframe, blink or jaw poses) without a full build, or check that a GLB imports into Unreal with its morphs and bones intact, author a static prop in Blender with booleans, compare or budget a set of GLBs (a chess set, a furniture kit), or bring a GLB into Unity.
---

# Mesh build and delivery

Load `mesh-setup` first. Commands run through the managed launcher
(`node "<plugin-root>/scripts/run-managed.js" ...`, written `mesh` below).

## One-off export

```text
mesh --workspace .agent-meshes/fox export fox.glb
mesh verify fox.glb
mesh --workspace .agent-meshes/fox view review/
```

`export` writes an animated GLB with named meshes, materials, skeleton, weights and clips from the
rest rig. `verify` runs the Khronos glTF Validator and exits nonzero on errors. A build already
runs it and writes the same report as `verification.json`, so `verify` after a build is redundant.
Zero errors and warnings is the bar; `UNUSED_OBJECT` infos about `TEXCOORD_0` are expected on
every part (the primitives carry UVs that no material samples). `view` renders
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
presets from `extras.arkitFace`). `--no-preview` skips the browser entirely; `--no-preview-page` keeps
the PNGs but skips the 1 MB preview page when your own page embeds the GLB. The output directory
is replaced only when it is marked as owned by that config, so never point `output` at a
directory holding other work. A failed build leaves the previous output in place; after a crash,
confirm the process is gone before removing the adjacent `.agent-meshes.lock`.

## Static props for a game engine: names, merge, budgets

For a static prop or a set of them, use `build.json` only; no workspace is needed.

- `material.name` (for example `PieceWhite`) becomes the glTF material name, and parts or shells with the same
  name, colour and finish share one exported material.
- `"merge":"byMaterial"` fuses every part into one mesh with one primitive per material. Part names are lost in
  the GLB, so use it only for deliverables nobody addresses part by part. Skinned or animated models are refused
  (`MERGE_NOT_STATIC`).
- A `shell.set` colour that looks tan or glossy next to lathe parts is the baked tint and occlusion multiplying the
  base colour; set `"vertexColors":false` (one member colour, no pattern) so it matches.
- State the numbers in the build: `"verify":{"maxTriangles":2500,"maxMaterials":2,"expectPivot":"bottom-center",
  "expectHeight":0.58}` or `mesh verify model.glb --max-triangles N --max-materials N --expect-pivot bottom-center
  --expect-height H [--tolerance m]`. Bounds are world-space from the final vertices, so rotated parts are measured
  correctly; do not read accessor min/max.
- `mesh silhouette model.glb --axis y --bins 80 --json` charts radius against height. `--lint` flags notches (a
  radius minimum with larger radii above and below; exit 1) and `--allow y0:y1` exempts intended collars. State the
  invariant first ("radius never grows above the plinth"), then lint it.
- Before a revert, `mesh stats model.glb` records triangles, materials, bounds and a profile hash; afterwards
  `mesh diff before.glb after.glb` proves nothing changed.

## Blender-authored static props

For a prop that needs real booleans, a carved slot, a fluted rim or a sculpted head, author it in Blender
and export one mesh with one named material. A 12-piece chess set was built this way; every rule below cost
a render round to learn. Reusable helpers are in `scripts/blender_lib/agent_meshes_props.py` (see its
section in [blender_lib](../../scripts/blender_lib/README.md)); `from agent_meshes_props import *` after adding
`scripts/blender_lib` to `sys.path`.

**Axes and export.** glTF is Y-up with the model facing +Z; Blender is Z-up with forward = -Y. Author in
Blender as (x, -z, y), that is glTF z = -Blender y (`P(x, y, z)` in the helper module), and export with
`export_yup=True`, so nothing is rotated afterwards. Export with `export_vertex_color='NONE'` (Blender before
4.2 spells it `export_colors=False`), `export_cameras=False`, `export_lights=False`, and `export_texcoords=False`
when nothing samples a texture. Give the mesh ONE named material (`static_material('PieceWhite', '#e9ddc2', .55)`)
and strip colour attributes (`finish_static`); a leftover `COLOR_0` multiplies the base colour in viewers.
`export_static_glb(path, objects)` has all of this.

**Boolean order that avoids ragged edges.**
1. Build the clean body (screw lathe, or metaball converted to a mesh).
2. Decimate the body FIRST, if it needs it. Decimating after a boolean roughens every cut edge.
3. Locally subdivide the triangles around each planned cut (`refine_near`), so the cutter lands in small even
   triangles, not needle fans.
4. Boolean with the EXACT solver.
5. Weld at 0.5 mm, dissolve degenerate faces, triangulate with beauty (`clean_after_boolean`).
6. Never decimate after the boolean.

Cut first and JOIN LAST (a plain join, no boolean). An exact boolean union of many small shells into a body once
returned only the shells, and joining shells before the cuts let later cuts swallow them. Compare triangle counts
before and after a union.

**Count real triangles.** Booleans leave n-gons, so Blender's polygon count under-reports. Count
`sum(len(p.vertices) - 2 for p in mesh.polygons)` (`count_tris`), or read the exported GLB with
`recipes/set-stats.mjs`. A body reported as 6,162 faces had more triangles than that.

**Metaballs (smooth fusion of ellipsoids) have a unit trap.** An isolated element's surface lies at
0.558 x `radius` x `size`, so `radius = max(semi) / 0.558` and each `size = semi / (0.558 * radius)`; `meta_ellipsoid`
does this. Fields ADD, so overlapping elements bulge: shrink radii about 15% where they overlap, and elements spaced
closer than about 2 radii fuse into one lump (separate tufts need separate shells). A capsule's `size_x` is an
ABSOLUTE half-length in metres, not scaled by radius (`meta_capsule`). For an unrotated element `size_y` and `size_z`
are Blender Y and Z, so an ellipsoid authored in glTF axes comes out with depth and height swapped unless you swap
them (the helper does); the mistake is invisible while members are nearly round and makes a neck paper-thin when
they are not. Coarser metaball `resolution` (0.0095 for a 0.4 m piece) is the practical triangle lever.

**Join order for tufts and other add-ons:** cuts first, join last. Tuft roots must start outside the surface, or the
visible part is a needle.

**Dispatching a bpy script.** Either way the result is a GLB you then `verify` and render:
- From a Node build script, run Blender directly and keep exporter control, which is what lets one script take a
  colour or variant argument:
  ```js
  import { execFileSync, spawnSync } from 'node:child_process';
  // setup --check exits 1 before the first install, so read stdout with spawnSync; `blender` is a path, null when absent.
  const check = spawnSync(process.execPath, [`${pluginRoot}/scripts/setup.js`, '--check', '--json'], { encoding: 'utf8' });
  const blender = process.env.AGENT_MESHES_BLENDER ?? JSON.parse(check.stdout).blender;
  if (!blender) throw new Error('Blender not found; see mesh-setup');
  execFileSync(blender, ['-b', '--python-exit-code', '1', '--python', 'knight_blender.py', '--', 'white', 'white_knight.glb'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ```
  `execFileSync` throws on a nonzero Blender exit; print `err.stdout` and `err.stderr` on failure. Blender exits 0 after
  a Python error unless you pass `--python-exit-code 1`, as above.
- Through `build.json`: `{"version":1,"name":"knight","blender":{"script":"knight.py"},"output":"dist"}`, where the
  source defines `build()` returning the list of bpy objects. It takes no arguments (generate one source per variant,
  or read an environment variable) and exports through the managed `export_glb`, then verifies and renders as for any build.

## Static sets: contact sheet and stats

Two recipes in `recipes/` check a SET of GLBs together. Run them with the plugin's Node; they need no build step.

```text
node "<plugin-root>/recipes/set-stats.mjs" --budget 'knight=6500' --max-tris 3700 --max-materials 1 \
  --require-named-materials --pivot bottom-centre *.glb
node "<plugin-root>/recipes/set-sheet.mjs" --out renders/sheet.png --views front,side,q34,top --cell-scale 0.5 *.glb
node "<plugin-root>/recipes/set-sheet.mjs" --out renders/bases.png --views front,side --crop-bottom 0.3 white_*.glb
```

`set-stats` prints real triangles, world size and bounds with every node matrix applied (a part exported as a
`matrix` node or rotated makes accessor min/max useless), the base centre (the pivot check), material names and
unused materials, and exits 1 with a `FLAG` line per violation. `set-sheet` draws one row per model and one column
per view from ONE camera shared by every cell (target and distance from the union bounds, or `--target` and
`--dist`), so a tall piece looks tall next to a short one, which per-model auto-framing hides. `--crop-bottom F`
keeps the lower fraction of each frame (bases, plinth junctions); `--camera name=px,py,pz>tx,ty,tz` adds a close-up
view. Both fail with a clear message when the managed runtime is missing; run `mesh-setup` first.

## Importing into Unity (glTFast)

Checked with glTFast 6.20.0; the agent-engine plugin's `engine-asset-import` skill has the full import detail.
agent-meshes exports each part as its own node with a `matrix` (not translation/rotation/scale), and glTFast
handles those nodes correctly; other importers may warn. glTF +Z forward stays +Z forward in Unity (glTFast
flips handedness for you). Verified with an orthographic top-down render of the imported pieces: a knight authored
facing +Z faces +Z in the scene. Every part is a node, so a prop of 15 parts becomes 15 child GameObjects; for a
static prop prefer one mesh with one material (the Blender route above) when the engine will instance many copies.

## Fast Blender previews while iterating

`mesh preview <build.json|source.py>` runs a Blender-authored source's `build()` headlessly and
renders Workbench PNGs from fixed cameras in the same run. It exports no GLB and starts no browser,
so use it for every look while you shape a model, and keep the full build for final checks.

```bash
mesh preview asset-src/mara/build.json --views head --shading matcap,wire,cavity   --pose rest --pose blink:eyeBlinkLeft=1,eyeBlinkRight=1 --pose jaw:jawOpen=1 --sheet
```

- **Views.** `front`, `q34`, `side`, `below`, `above`, `close` (eyes to mouth), `eyes`, `mouth`, `mouth-q34`
  and `back` frame the head, which is the mesh with face shape keys, or `--target <pattern>`. `body-front`, `body-q34`,
  `body-side` and `body-back` frame everything. `head` and `body` are aliases for those sets.
- **Shadings.**
  - `matcap` shows lumps and ripples.
  - `zebra` shows a reflection-stripe matcap; kinks in the stripes are curvature breaks.
  - `wire` shows edge flow over the matcap.
  - `cavity` shows creases and ridges.
  - `color` shows material colors.
  - `all` renders every shading.
- **Poses.** `--pose name:key=w,...` sets shape-key weights and can be repeated. `--shape` adds
  weights to every pose. Armatures stay in the rest pose unless you pass `--posed`.
- **Other options.** `--hide 'hair*'` leaves meshes out. `--size` sets the square size in pixels.
  `--sheet` adds `sheet.png`, with one row per pose.
- **Output.** Files are named `<pose>-<view>-<shading>.png`, plus a `preview.json` manifest, in
  `--out` (default `preview/` beside the source).

`mesh preview --worker` keeps one headless Blender running and waits on a queue folder. Later
`mesh preview` calls hand their job to it and skip Blender's startup, which is slow through the
Store launcher, and edited helper modules are re-read for each job. `--no-worker-use` forces a fresh
Blender run, and `mesh preview --stop-worker` stops the worker after its current job. Without a
worker, every preview runs a one-shot Blender. The build time of the source itself is not saved: a
character's face construction still takes its minute.

## Optional Blender refine

```json
{"version":1,"name":"robin","operations":"operations.json","output":"dist",
 "refine":{"subdivide":1,"noise":0.003,"noiseScale":0.04,"only":["robin"]}}
```

The `refine` block (or `mesh refine in.glb out.glb --subdivide 1 --noise 0.004 --noise-scale 0.05
--only robin`) runs Blender headless: subdivision surface with smooth shading, plus an optional
clouds-texture displacement for feathers or fur, keeping bones, skins, vertex colors and clips.
The refined GLB is verified again. A build that asks for refinement fails when Blender is
missing instead of shipping a coarser model. Renders still come from the unrefined project.
Subdivision multiplies vertex count by about four per level, so keep shell resolution modest
(around 44) on a model you will refine, and check the GLB size afterward.

## Garment penetration check

```text
mesh check-garments character.glb
mesh check-garments character.glb --clips jog --samples 32 --tolerance 0.003 --json
```

Samples every clip of a skinned GLB at evenly spaced phases (16 by default), poses each mesh as
three.js skins it, and reports every place one part pushes into another: a lifted thigh tearing
through a belt, a hand sinking into a hip, a boot cuff driving into the leg. A vertex counts when it
was outside another closed part at rest and is inside it by more than the tolerance (2 mm) at a
phase, so layers seated into the body at rest are never reported. Garments are `layer-*`, gloves,
boots and outsoles by default (`--garments <regex>`); garment-vs-garment, garment-vs-body and
garment self-folds (a surface folding through its own volume, measured against cloth more than
3 cm away along the rest surface, and at most the cloth over it along its normal) are checked.
The rest pose itself fails when two garments cross, each hiding a patch of the other's outward
surface (a trouser leg wider than the boot shaft round it shows through in jagged patches);
`--crossing-vertices` (8) and `--crossing-depth` (0.004 m) size that patch. `--ignore <regex>` leaves parts out. The JSON lists each
intrusion by clip, phase, part pair, vertex count, depth and the deepest vertex's rest and posed
position, plus the worst per pair; it exits 1 with one `FAIL` line per pair otherwise.

## Unreal import check

```text
mesh verify-unreal head.glb --contract arkit-face/1
mesh verify-unreal prop.glb --expect-morphs open,close --expect-bones lid --json
```

Imports the GLB headlessly into a cached scratch UE project through Interchange and prints a JSON
report: the assets by class, and per SkeletalMesh its morph target names, bone names and bone
parents, LOD and vertex counts, plus the import errors and warnings from the Unreal log (whose path
is in the report). `--contract arkit-face/1` requires ONE SkeletalMesh that has the 21 ARKit morph
names verbatim and whose own skeleton has `head` as its root with `eye_L`/`eye_R` as children of
`head`, only one SkeletalMesh and Skeleton in the import, and zero import errors. Every run, with or
without a contract, also fails when geometry vanished: fewer vertices reached Unreal than the GLB
renders (`geometry` in the report). It exits 1 and lists `failures` otherwise, naming the cause.
Unreal comes from `AGENT_MESHES_UNREAL` (the engine directory), the Epic launcher manifest or the
usual install roots. Without one the command fails with `UNREAL_NOT_FOUND`: say so rather than
claiming Unreal support. Later runs take seconds. A first run on a new engine can compile
shaders for minutes, so the default `--timeout` is 1800 s.

This proves the **import only**. Nothing is rendered or animated in Unreal. When you report it,
say "imports into UE 5.7 via Interchange with names intact", not "works in Unreal". A missing
morph often means a dead shape: Unreal drops morphs that move no triangle vertex.

**Never put one morph name on two glTF meshes.** If `jawOpen` is on a Face mesh and on a separate
Teeth mesh, UE 5.7's glTF parser (`GLTFAsset.cpp`) throws away *every* morph name in the file
and renames them all `<file>_mesh_<m>_<i>_MorphTarget`. Three.js is fine with this, but Unreal is
not, and no Interchange option (`bMergeMorphTargetsWithSameName` included) prevents it. Build all
morph-bearing geometry (face, lids, lips, teeth, tongue, mouth cavity) as **one glTF mesh with one
primitive per material**. In Blender, join those parts into one object with several materials,
and give every part every target (zero deltas where a part does not move). Morph-free parts such
as eyeballs can stay separate meshes. `verify-unreal` checks the GLB first, with no engine needed,
and reports this as one failure naming the shared morphs and meshes. A name repeated inside one
mesh, or an `extras.targetNames` count that differs from the target count, loses that mesh's names
the same way. The check lives in `src/gltf-morphs.ts` (`auditMorphNames`), exported for reuse.

**Bind every mesh to one skin.** Unreal makes one SkeletalMesh and Skeleton per glTF skin. A
morph-bearing mesh node with no `skin` becomes its own SkeletalMesh on a made-up one-bone
skeleton (`Head_<hash>`), apart from the eye rig, so the face cannot be moved by `head`/`eye_*`.
A GLB with no skin at all gets only that made-up bone. `verify-unreal` reads the GLB's skins
(`preflight.skins`, `src/gltf-skins.ts`) and names which of these it is. In Blender, parent every
mesh (face and eyeballs) to the one armature with an Armature modifier before exporting.

**Unbound meshes vanish from the import.** In a GLB that has a skin, Interchange silently drops
every mesh node with no `skin`, no morphs and no joint above it: no StaticMesh, no warning. The
easy mistake is building eyeballs with a `blender_lib` source and not passing them to `bind_skin`:
the head imports with no eyes. `verify-unreal` compares the GLB's welded vertex count with what
Unreal imported and fails naming the dropped nodes. Bind the eyeballs to the skin, 100% to
`eye_L`/`eye_R`. Eye bones must be children of `head` (a flat armature fails the hierarchy check),
and a GLB with two skins that Unreal happened to merge only warns.

## Embedding in a page

`mesh viewer lib/mesh-viewer.js` writes the standalone runtime: one script, no build step, no
network, defining `window.MeshViewer`. Inline the GLB as base64 so the page works from `file://`:

```html
<div id="stage" style="height:420px"></div>
<script id="glb" type="text/plain">...base64 GLB...</script>
<script src="lib/mesh-viewer.js"></script>
<script>
  MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent })
    .then(viewer => { viewer.play('walk'); viewer.setColor('body', '#e6a23c'); });
</script>
```

Read [viewer API](references/viewer-api.md) for mount options and the puppet API (`setPose`,
`setColor`, `setVisible`, `play`, `seek`, `bounds`, `screenshot`, `onFrame`) used for interactive
pages and for scripted checks such as measuring foot contact over a stride.

Several models on one page (a cast of characters, heads that look at each other) go on **one
stage**, not several `mount` calls: `MeshViewer.mountStage(el, {models: {pip: {glb, position}, bolt:
{glb, position, rotation, scale}}})` shares one renderer, camera and room, and `stage.model('pip')`
is that model's own puppet plus `setPlacement`, `getPlacement`, `worldPoint(node, point?)` and
`aimBone(bone, worldPoint, {maxYaw, maxPitch})` for pointing one model's eyes at another. Setters
(`setMorph`, `setMorphs`, `setPose`, `setPoses`, `aimBone`) are deferred to one application per
frame, so drive faces from `onFrame` freely; a multi-primitive glTF face is driven by its node
name (`setMorphs({face: {jawOpen: .4}})` reaches skin, lids and teeth); `quality: 'fast'` (no MSAA,
shadows or environment map, pixel ratio 1) is what holds 30 fps for three heads under software GL. `stage.frame({model?, padding?})` fits the whole
stage or one model. For pixel checks (is the iris hidden when blinking, did the teeth move),
use `idRender({materials: {iris: '#0000ff'}, parts: {'teeth#0': '#00ff00'}, width, height})`
on a viewer or a stage: every surface is drawn in one exact unlit color with the live morphs and
skinning, the pixels come back as RGBA, and `MeshViewer.countColors(image)` tallies them. The
viewer API reference has the key rules and a counting example.

## Done means looked at

A build is not done when `verification.json` reports zero errors. Open the PNGs and the contact
sheets and compare them with the intent. If something looks blocky, floating or lumpy, read
[mesh-believable](../mesh-believable/SKILL.md) before adjusting numbers at random.

## Face-rig contract check

```text
mesh verify head.glb --contract arkit-face/1
```

Checks everything computable in the `arkit-face/1` face-rig contract and prints a JSON report
(`checks`, `failures`, `warnings`, `measurements`): validator errors, the single skin with
`head`/`eye_L`/`eye_R`, eyeballs bound 100% to eye bones that pivot at their centers, the 21
required morph names (exact spelling, one glTF mesh per name), zero rest weights, every morph
moving at least 1 mm, no flipped triangles at 0.5/1 or across the emotion presets with
`jawOpen` = 1, lid clearance of eyeball radius + 0.5 mm at blink .25/.5/.75/1 alone and with
squint, eye coverage (front rays across each eyeball must all hit a lid or skin at blink 1 alone,
with squint 1 and with wide 1, and show nothing outside the neutral opening mid-blink or at
squint), oblique eye views (rays from the front, 3/4 at 35-45 degrees of yaw and 20 degrees above
and below, in every lid and emotion state, must never reach the socket or the inside of the head:
the lids must meet the skin all the way round, which `eye_hole` builds), no terraced socket
(`eye-crease`: at most one fold above each lid eye, its crease, and one below along radial lines out to
1.3 eyeball radii), lid follow (the upper
lid's edge moves at least 1.5 mm up at eyeLookUp = 1 and down at eyeLookDown = 1), opaque face
materials (an alpha-blended or masked lid, skin or tooth fails, and hides nothing in any ray
check), the `extras.arkitFace` schema and `exposedTeeth` (teeth that show at rest must be in
their own `teeth_exposed` material and declared; a row poking through the lips fails), the skull, teeth and every
morph-bearing part bound to `head` (a skull bound to an eye bone is named as such), upper teeth
fixed and lower teeth, tongue and cavity carried by `jawOpen`, the chin (the face's lowest point)
dropping by at least 10% of the face height at `jawOpen` = 1, the face above the upper teeth's
gum line staying put, and a mouth that opens (between the teeth rows the front view meets teeth,
tongue or cavity, not skin; a ray that passes the teeth into the head is see-through), and every
small part joined to the face (brows, ridges, nostrils) sitting on the skin at rest and at each
morph (`attached-parts`: no air gap along its length, not buried by a skin shape; a nostril on a nose
ball is judged against the ball). It exits 1 and prints
`FAIL <check>: <problem>` lines on stderr. Teeth are found by the materials `teeth_upper` and
`teeth_lower`. It does not render: a dark open mouth, gaze and shading still need looking at. `node <plugin-root>/scripts/check-face-rig-browser.mjs [test_head|test_robot|test_frog|test_kid]`
renders the helper-built test heads, including a jaw sheet (jawOpen 0, .5, 1 from the front,
three-quarter and close up) captioned with the measured chin drop.

File size: Blender's exporter writes a float-noise normal delta (about 1e-7) for every vertex of
every shape key, about 1.2 MB on a talking head. The Blender authoring stage (`export_glb`)
drops deltas under 1e-6 m (positions) and 1e-4 (normals) and stores the rest as sparse
accessors (`prune_glb_morphs`), so a head's morph data grows only with the vertices each shape
really moves. Keep each face GLB under 3 MB (E8).
