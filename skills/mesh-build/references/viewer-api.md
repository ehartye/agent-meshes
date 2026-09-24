# MeshViewer runtime

`mesh viewer <file.js>` writes one script that defines `window.MeshViewer`. `preview.html` from a
build uses the same runtime. Nothing is fetched from the network.

## mount(container, options) → Promise<viewer>

Fills the container and follows its size. Options:

| Option | Meaning |
| --- | --- |
| `glb` | GLB bytes (`ArrayBuffer`/`Uint8Array`) or a base64 string (works from `file://`) |
| `autoplay` | Start the first clip; default follows `prefers-reduced-motion` |
| `background` | CSS color, or `null` for transparent |
| `orbit` | Mouse/touch orbit controls (default true) |
| `floor` | Draw a ground disc with the shadow |
| `view` | `front`, `back`, `left`, `right` (`side` is its alias), `top`, `bottom`, `perspective`, or `{position:[x,y,z], target:[x,y,z]}` |
| `outline`, `outlineColor` | Ink outline thickness in meters behind every part, and its color |

The scene has a procedural room environment plus key and fill lights with soft shadows. Shells
carry ambient occlusion in their vertex colors, so crevices read dark without textures.

## Puppet API

Names are the part, bone and clip names from the project.

| Member | Meaning |
| --- | --- |
| `bones`, `parts`, `clips` | Arrays of names |
| `setPose(bone, {rotation?, position?, scale?})` | Offsets from rest and from any playing clip; `rotation` is XYZ Euler degrees, `position` meters, `scale` multiplies the bone and everything it carries |
| `getPose(bone)`, `resetPose(bone?)` | Read or clear offsets (all bones when omitted) |
| `setColor(part, css)`, `getColor(part)`, `setVisible(part, bool)` | Recolor or hide a part; hiding also hides its outline hull |
| `setMaterial(part, {metalness?, roughness?})` | Change a part's finish, each 0 to 1; omitted fields keep their value. `{metalness: 1, roughness: 0.1}` is chrome, `{metalness: 0, roughness: 0.65}` matte. Outline hulls are untouched |
| `getMaterial(part)` | The part's current `{metalness, roughness}`, as exported from the project |
| `setPattern(name, pattern or null)` | Re-bake a `{type:'dots'|'stripes'|'checks', color, size, axis?, offset?}` pattern into a shell's or part's vertex colors at bind-pose world points, instantly and without a remesh; `null` restores the un-patterned look exactly. Base colors are kept in the mesh's `COLOR_1`; a flat part gets them from its material color the first time, after which `setColor` tints it like a shell |
| `getPattern(name)` | The pattern baked into a shell or part, from the export or the last `setPattern`; `null` when plain |
| `play(clip?)`, `pause()`, `playing`, `clip`, `time`, `duration`, `speed`, `seek(seconds)` | Playback; clips are sampled directly, so `seek` then read works without a frame |
| `bounds()` | World-space `Box3` of the visible, posed, skinned geometry |
| `view(name or {position,target})`, `frame()` | Move the camera to one of the eight named views above (the model's `left` is -x, `right`/`side` +x, `front` +z) or an explicit position; `frame` fits the current bounds. An unknown name throws an `Error` that lists the valid names |
| `setBackground(css or null)`, `screenshot({id?})` | Change the background; PNG data URL of the current frame, or of an ID render |
| `idRender(options)` | Exact flat-color render for pixel checks; see below |
| `onFrame(fn)` | Per-frame callback, returns an unsubscribe function |
| `resize()`, `dispose()` | Handle a container resize by hand; release the WebGL context |
| `renderer`, `scene`, `camera`, `controls` | The underlying three.js objects |

## ID render (pixel checks)

`viewer.idRender(options)` (and `stage.idRender`) renders once with every surface replaced by an
unlit flat color and returns `{width, height, data}`: RGBA bytes, top row first. There is no
lighting, tone mapping, color-space conversion, fog, environment, shadow or multisampling, so every
pixel is exactly one of the requested colors. Current morph weights, poses and skinning are used.
Normal materials, visibility, background and camera aspect are restored before it returns.

| Option | Meaning |
| --- | --- |
| `materials` | `{materialName: '#rrggbb'}`; in a stage `model/materialName` limits a key to one model |
| `parts` | `{part: '#rrggbb'}` or `{'part#slot': '#rrggbb'}` for one zero-based slot; `model/part` in a stage |
| `background` | Clear color, default `#000000` |
| `other` | Color for unmatched surfaces (default: the background, so they still occlude), or `null` to hide them |
| `width`, `height` | Output pixels, 1 to 4096; default the viewer's CSS size |
| `models` | Stage only: render just these models |

Precedence is `part#slot`, then `part`, then material, and a `model/` key beats an unscoped one.
Colors must be `#rrggbb`. A key that matches nothing throws, listing the names that exist, so a
typo cannot silently count zero pixels. Outline hulls and the floor are not drawn.
`screenshot({id: options})` returns the same render as a PNG data URL, and
`MeshViewer.countColors(image)` returns `{'#rrggbb': pixels}`.

```js
const count = await page.evaluate(() => {
  const pip = stage.model('pip');
  pip.setMorph('face', 'eyeBlinkLeft', 1);
  const image = stage.idRender({ models: ['pip'], materials: { iris: '#0000ff', skin: '#ff0000' }, width: 512, height: 512 });
  return MeshViewer.countColors(image)['#0000ff'] ?? 0;   // 0 when the lid covers the iris
});
```

## mountStage(container, options) → Promise<stage>

Several models in one renderer, scene, camera, room and floor. Each model has its own placement and
its own independent puppet.

```js
const stage = await MeshViewer.mountStage(el, {
  models: {
    pip: { glb: pipBase64, position: [-0.6, 0, 0], rotation: [0, 10, 0] },
    bolt: { glb: boltBytes, position: [0.6, 0, 0], scale: 1.1 },
  },
  background: '#f4efe6', view: 'front',
});
const pip = stage.model('pip'), bolt = stage.model('bolt');
pip.setMorph('face', 'jawOpen', 0.6);           // only Pip's jaw moves
const target = pip.worldPoint('eye_L');          // world-space [x, y, z]
bolt.worldPoint('eye_R');                        // aim Bolt's eye bone at `target`
stage.frame();                                   // fit all models; stage.frame({model: 'pip'}) fits one
```

Stage options: `models` (`{name: {glb, position?, rotation?, scale?, autoplay?}}`; names are a
letter then up to 63 letters, digits, `_` or `-`), `autoplay`, `background`, `orbit`, `floor`,
`view` (default `front`), `outline`, `outlineColor`. Placement `rotation` is XYZ Euler degrees and
`scale` is a positive number or triple. Unknown option names, invalid placements and duplicate
names are rejected with a message before any WebGL context is created.

| Member | Meaning |
| --- | --- |
| `models` | Model names in the order they were added |
| `model(name)` | The model: the full puppet API above, plus `name`, `group`, `setPlacement(placement)` (omitted fields keep their value), `getPlacement()`, `worldPoint(node, point?)`, `observe(anchors)` in world space and `bounds()` |
| `add(name, {glb, ...placement})`, `remove(name)` | Load another model later (a promise), or release one |
| `bounds(model?)` | World `Box3` of all models, one name or a list |
| `view(name or {position,target}, {model?, padding?})`, `frame({model?, padding?})` | Named views fit every box corner in the frustum (padding default 1.1); `frame` keeps the current direction |
| `idRender(options)`, `screenshot({id?})` | As above; `models` limits the ID render to some models |
| `setBackground`, `onFrame(fn)`, `resize`, `dispose`, `renderer`, `scene`, `camera`, `controls` | As for `mount` |

## Scripted checks

Feet on the ground over a stride, using a Playwright page that loaded the viewer:

```js
const contact = await page.evaluate(async () => {
  const v = window.viewer; v.pause();
  const feet = v.bones.filter(name => /foot$/.test(name));
  let lowest = Infinity;
  for (let t = 0; t < v.duration; t += v.duration / 60) {
    v.seek(t);
    const box = v.bounds();
    lowest = Math.min(lowest, box.min.y);
  }
  return { feet, lowest };
});
```

A stance minimum below about -0.01 m sinks through the floor; above 0.01 m the model floats.
Reduced-motion users get `autoplay` false, so pages that need a moving model on load should call
`play` themselves and expose a pause control.
