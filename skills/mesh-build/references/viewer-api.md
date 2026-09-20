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
| `view` | `front`, `side`, `top`, `perspective`, or `{position:[x,y,z], target:[x,y,z]}` |
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
| `play(clip?)`, `pause()`, `playing`, `clip`, `time`, `duration`, `speed`, `seek(seconds)` | Playback; clips are sampled directly, so `seek` then read works without a frame |
| `bounds()` | World-space `Box3` of the visible, posed, skinned geometry |
| `view(name or {position,target})`, `frame()` | Move the camera; `frame` fits the current bounds |
| `setBackground(css or null)`, `screenshot()` | Change the background; PNG data URL of the current frame |
| `onFrame(fn)` | Per-frame callback, returns an unsubscribe function |
| `resize()`, `dispose()` | Handle a container resize by hand; release the WebGL context |
| `renderer`, `scene`, `camera`, `controls` | The underlying three.js objects |

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
