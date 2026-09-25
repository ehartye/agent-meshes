---
name: mesh-build
description: Export, verify, render and deliver agent-meshes models as GLB with isolated build configs, fixed-view renders and clip contact sheets, offline preview pages, the embeddable MeshViewer runtime with its puppet API, multi-model stages and exact ID renders for pixel checks, the optional Blender refine stage, and the headless Unreal import check.
when_to_use: Use when asked to export or verify a GLB, render or screenshot a model, produce a preview page, embed a 3D model in a web page, put several models on one page, count rendered pixels per part or material, set up a repeatable build.json, smooth and feather a model in Blender, or check that a GLB imports into Unreal with its morphs and bones intact.
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

## Repeatable build

Keep a `build.json` beside the source in the project:

```json
{"version":1,"name":"fox","operations":"operations.json","output":"dist"}
```

`operations` is a JSON array of authoring operations (or use `"project":"fox.mesh.json"` for a
saved project). Paths resolve relative to the config. `mesh build build.json` produces, in an
isolated state, `project.mesh.json`, `model.glb`, `verification.json`, `front.png`, `side.png`,
`perspective.png`, `<clip>.png` contact sheets, and a self-contained offline `preview.html` with
orbit, playback and scrub. `--no-preview` skips the browser entirely; `--no-preview-page` keeps
the PNGs but skips the 1 MB preview page when your own page embeds the GLB. The output directory
is replaced only when it is marked as owned by that config, so never point `output` at a
directory holding other work. A failed build leaves the previous output in place; after a crash,
confirm the process is gone before removing the adjacent `.agent-meshes.lock`.

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
squint), the `extras.arkitFace` schema and `exposedTeeth` (teeth that show at rest must be
declared), the skull, teeth and every
morph-bearing part bound to `head` (a skull bound to an eye bone is named as such), upper teeth
fixed and lower teeth, tongue and cavity carried by `jawOpen`, the chin (the face's lowest point)
dropping by at least 10% of the face height at `jawOpen` = 1, the face above the upper teeth's
gum line staying put, and a mouth that opens (between the teeth rows the front view meets teeth,
tongue or cavity, not skin; a ray that passes the teeth into the head is see-through). It exits 1 and prints
`FAIL <check>: <problem>` lines on stderr. Teeth are found by the materials `teeth_upper` and
`teeth_lower`. It does not render: a dark open mouth, gaze and shading still need looking at. `node <plugin-root>/scripts/check-face-rig-browser.mjs [test_head|test_robot|test_frog]`
renders the helper-built test heads, including a jaw sheet (jawOpen 0, .5, 1 from the front,
three-quarter and close up) captioned with the measured chin drop.
