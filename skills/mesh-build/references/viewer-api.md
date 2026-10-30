# MeshViewer runtime

`mesh viewer <file.js>` writes one script that defines `window.MeshViewer`. `preview.html` from a
build uses the same runtime. Nothing is fetched from the network.

## mount(container, options) → Promise<viewer>

Fills the container and follows its size. Options:

| Option | Meaning |
| --- | --- |
| `glb` | GLB bytes (`ArrayBuffer`/`Uint8Array`) or a base64 string (works from `file://`) |
| `autoplay` | Start the first clip; default follows `prefers-reduced-motion` |
| `background` | CSS color (default `#dce7eb`), or `null` for transparent; the default applies only when the option is omitted |
| `orbit` | Mouse/touch orbit controls (default true) |
| `floor` | Draw the ground plane (default true; see "Floor, background and camera defaults") |
| `projection` | `perspective` (default) or `orthographic`; see "Projection" |
| `view` | `front`, `back`, `left`, `right` (`side` is its alias), `top`, `bottom`, `perspective`, or `{position:[x,y,z], target:[x,y,z]}` |
| `outline`, `outlineColor` | Ink outline thickness in meters behind every opaque part (glass gets none: its hull would show through), and its color |
| `quality` | `'high'` (default), `'fast'`, or `{preset?, antialias?, pixelRatio?, shadows?, environment?}` |

The scene has a procedural room environment plus key and fill lights with soft shadows. Shells
carry ambient occlusion in their vertex colors, so crevices read dark without textures.

`quality` trades image quality for frame time. `high` is antialiased, uses the device pixel ratio
up to 2, lights with the room environment map and casts 2048² soft shadows. `fast` turns off MSAA,
the shadow map and the environment map and renders at pixel ratio 1; painted surfaces keep nearly
the same exposure, metals lose their reflections. Fields override the preset: `antialias` (fixed
at creation), `pixelRatio` (0.25 to 4), `shadows` (`true`, `false` or a power-of-two map size 256
to 8192) and `environment`. Under headless software GL at 1280×720, three 12.5k-vertex skinned
heads with 25 morphs render at a ~17 ms median with `fast` and ~100 ms with `high`
(`node scripts/check-stage-perf-browser.mjs`).

## Floor, background and camera defaults

Labels: [tested] ran in Chromium with `node scripts/check-viewer-browser.mjs`; [documented] read in
the 0.34.0 source (`src/web/room.ts`, `viewer.ts`, `stage.ts`), not run.

- [tested] `floor` is on unless `floor: false`, and `background` is `#dce7eb` unless it is given.
  A transparent capture needs an explicit `background: null`; an omitted `background` is not transparent.
- [tested] The floor is a plane, not a disc: a 200 by 200 m `PlaneGeometry` laid flat at y = -0.012,
  receiving the model's shadow. With a background color it is a `MeshStandardMaterial` of that same
  color (roughness 1). With `background: null` it is a `ShadowMaterial` at opacity 0.18, so it draws
  only the shadow.
- [tested] A transparent capture with the defaults except `background: null` therefore carries a
  grey shadow under the model; `floor: false` removes the plane and that shadow.
- [documented] `quality: {shadows: false}` (and the `fast` preset) also removes the shadow, because the
  key light stops casting; the transparent plane then draws nothing visible.
- [documented] The camera is a `PerspectiveCamera` with a 38 degree vertical field of view, near 0.01
  and far 200 or more. `orbit` is on and the viewer's `view` defaults to `perspective`
  (`mountStage` defaults to `front`).

## Projection

`projection` takes `perspective` (default) or `orthographic` on `mount` and `mountStage`.

- [tested] Omitting it and passing `'perspective'` give the same camera (type, position, projection
  matrix equal to a 38 degree `PerspectiveCamera`) and the same screenshot and ID-render pixels. A
  one-off comparison against the 0.34.0 runtime (default, transparent, outlined and top views) gave
  identical screenshots; that comparison is not part of the script.
- [tested] `orthographic` makes `camera` a `THREE.OrthographicCamera` (no `fov`; the frame is set by
  `left`, `right`, `top`, `bottom` and `zoom`). The typed handle is
  `THREE.PerspectiveCamera | THREE.OrthographicCamera`.
- [tested] Parallel projection: the model's pixel size is identical whatever the camera distance
  (perspective changes it). `view(name)` and `frame()` size the frustum so every corner of the bounds
  fits with the same `padding`, and reset `zoom` to 1; the camera distance only has to clear the
  model. `view({position, target})` keeps the current size, and sizes an orthographic camera that
  has never been fitted from that direction. A container resize keeps the half-height and changes
  the width. `idRender` uses the same projection and restores the camera.
- [documented] three's `OrbitControls` zooms an orthographic camera through `zoom`, so the mouse wheel
  changes the scale rather than the distance.
- [tested] Any other value (`'isometric'`, `'Orthographic'`, `null`, a number) throws
  `Unknown projection "isometric"; use one of perspective, orthographic` before a canvas or WebGL
  context is created.

For a flat, fixed-camera capture of one model, use `{projection: 'orthographic', background: null,
floor: false, view: 'front'}`.

## Puppet API

Names are the part, bone and clip names from the project.

| Member | Meaning |
| --- | --- |
| `bones`, `parts`, `clips` | Arrays of names |
| `setPose(bone, {rotation?, position?, scale?})` | Offsets from rest and from any playing clip; `rotation` is XYZ Euler degrees, `position` meters, `scale` multiplies the bone and everything it carries |
| `setPoses({bone: pose, ...})` | Several offsets in one call; all are validated before any changes |
| `aimBone(bone, [x, y, z], {maxYaw?, maxPitch?})` | Turn a bone's forward axis (+Z) at a world point as a rotation offset over rest and clip; returns `{yaw, pitch, clamped}` in degrees (yaw toward the bone's +X, pitch toward its +Y), clamped to the limits. Position and scale offsets stay |
| `getPose(bone)`, `resetPose(bone?)` | Read or clear offsets (all bones when omitted) |
| `setMorph(name, target, weight)`, `setMorphs({name: {target: weight}})`, `getMorph(name, target)`, `resetMorph(name?, target?)` | Morph overrides after clip sampling; `getMorph` reads the effective weight. `name` is a part or a multi-primitive glTF mesh (below). `setMorphs` validates everything before changing anything |
| `morphGroups`, `morphTargets(name)` | Names of multi-primitive glTF meshes; the morph target names of a part or such a mesh |
| `sync()` | Apply pending changes now (see "Driving a face every frame") |
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
| `onFrame(fn)` | Per-frame callback before the render, returns an unsubscribe function; drive faces here |
| `resize()`, `dispose()` | Handle a container resize by hand; release the WebGL context (`forceContextLoss`) and remove the canvas |
| `renderer`, `scene`, `camera`, `controls` | The underlying three.js objects; `camera` is perspective unless `projection: 'orthographic'` |

## Driving a face every frame

Setters are cheap: `setPose`, `setPoses`, `aimBone`, `setMorph`, `setMorphs`, `resetPose`,
`resetMorph`, `seek` and `play` only record their input. The whole rest + clip + offset application
runs once per model per frame, just before the render, however many setters ran. Every puppet
reader applies pending changes first, so `getMorph`, `bone`, `object`, `root`, `observe`,
`worldPoint`, `bounds`, `idRender` and `screenshot` always see the latest writes. Only three.js
objects you kept from earlier (a bone or mesh reference) lag until the next frame; call `sync()`
before reading them directly. Skinned meshes are drawn without frustum culling (their bounding
sphere would go stale as they move), and `bounds()` refreshes their sphere.

A glTF mesh with several primitives (a face whose skin, lids, teeth, tongue and mouth cavity are
material slots of one mesh sharing the ARKit morph names) loads as a group named after its node,
with one three.js mesh per primitive (`face` holds `face_1`, `face_2`, …). The morph API takes the
group's name: `setMorph('face', 'jawOpen', w)` moves every primitive that has `jawOpen`, and
`getMorph('face', …)` reads it back. A primitive's own part name still addresses only that primitive.

```js
stage.onFrame(() => {
  for (const name of stage.models) {
    const head = stage.model(name);
    head.setMorphs({ face: { jawOpen: weights.jawOpen, mouthSmileLeft: weights.smile } });
    head.aimBone('eye_L', speakerMouth, { maxYaw: 30, maxPitch: 20 });
    head.aimBone('eye_R', speakerMouth, { maxYaw: 30, maxPitch: 20 });
  }
});
```

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
**Glass** (a slot blended below full opacity, glTF `alphaMode: BLEND`, or transmissive) is left out
unless a `parts` or `materials` key names it, even when `other` has a color, so the pixels count
what is seen through it: a face behind a helmet visor counts as the face. Name the glass to count
the glass itself; it then draws as an opaque occluder in its color.
Colors must be `#rrggbb`. A key that matches nothing throws, listing the names that exist, so a
typo cannot silently count zero pixels. Outline hulls and the floor are not drawn.
`screenshot({id: options})` returns the same render as a PNG data URL, and
`MeshViewer.countColors(image)` returns `{'#rrggbb': pixels}`.

```js
const count = await page.evaluate(() => {
  const hero = stage.model('hero');
  hero.setMorph('face', 'eyeBlinkLeft', 1);
  const image = stage.idRender({ models: ['hero'], materials: { iris: '#0000ff', skin: '#ff0000' }, width: 512, height: 512 });
  return MeshViewer.countColors(image)['#0000ff'] ?? 0;   // 0 when the lid covers the iris
});
```

## mountStage(container, options) → Promise<stage>

Several models in one renderer, scene, camera, room and floor. Each model has its own placement and
its own independent puppet.

```js
const stage = await MeshViewer.mountStage(el, {
  models: {
    hero: { glb: heroBase64, position: [-0.6, 0, 0], rotation: [0, 10, 0] },
    robot: { glb: robotBytes, position: [0.6, 0, 0], scale: 1.1 },
  },
  background: '#f4efe6', view: 'front',
});
const hero = stage.model('hero'), robot = stage.model('robot');
hero.setMorph('face', 'jawOpen', 0.6);           // only the hero's jaw moves
const target = hero.worldPoint('jaw', [0, 0, 0.1]); // world-space [x, y, z]
robot.aimBone('eye_R', target, { maxYaw: 30 });    // the robot looks at the hero's mouth
stage.frame();                                   // fit all models; stage.frame({model: 'hero'}) fits one
```

Stage options: `models` (`{name: {glb, position?, rotation?, scale?, autoplay?}}`; names are a
letter then up to 63 letters, digits, `_` or `-`), `autoplay`, `background`, `orbit`, `floor`,
`view` (default `front`), `projection`, `outline`, `outlineColor`, `quality` (as for `mount`). The
`background` (`#dce7eb`) and `floor` (on) defaults and the floor plane are the ones described above,
and `projection` behaves as for `mount` with a stage fit (padding default 1.1). Placement `rotation` is XYZ Euler degrees and
`scale` is a positive number or triple. Unknown option names, invalid placements and duplicate
names are rejected with a message before any WebGL context is created.

| Member | Meaning |
| --- | --- |
| `models` | Model names in the order they were added |
| `model(name)` | The model: the full puppet API above, plus `name`, `group`, `setPlacement(placement)` (omitted fields keep their value), `getPlacement()`, `worldPoint(node, point?)`, `observe(anchors)` in world space and `bounds()`. `aimBone` takes world points, so one model can look at another |
| `add(name, {glb, ...placement})`, `remove(name)` | Load another model later (a promise), or release one; a handle used after `remove` (or `dispose`) throws |
| `sync()` | Apply every model's pending changes now; the render loop does this once per frame |
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
