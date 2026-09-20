---
name: mesh-build
description: Export, verify, render and deliver agent-meshes models as GLB with isolated build configs, fixed-view renders and clip contact sheets, offline preview pages, the embeddable MeshViewer runtime with its puppet API, and the optional Blender refine stage.
when_to_use: Use when asked to export or verify a GLB, render or screenshot a model, produce a preview page, embed a 3D model in a web page, set up a repeatable build.json, or smooth and feather a model in Blender.
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

## Done means looked at

A build is not done when `verification.json` reports zero errors. Open the PNGs and the contact
sheets and compare them with the intent. If something looks blocky, floating or lumpy, read
[mesh-believable](../mesh-believable/SKILL.md) before adjusting numbers at random.
