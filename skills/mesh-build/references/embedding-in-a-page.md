# Embedding a model in a page

Entry: [mesh-build](../SKILL.md).

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

Read [viewer API](viewer-api.md) for mount options and the puppet API (`setPose`,
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
