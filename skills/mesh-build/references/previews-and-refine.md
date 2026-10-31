# Blender previews, refine and the garment check

Entry: [mesh-build](../SKILL.md).

## Fast Blender previews while iterating

`mesh preview <build.json|source.py|model.glb|model.gltf>` renders Workbench PNGs from fixed cameras in one
headless Blender run. A Blender-authored source (a `build.json` with `blender.script`, or a `.py` file) has its
`build()` run first; a built `.glb` or `.gltf` is imported as it is (see [Preview a built GLB without
rebuilding](#preview-a-built-glb-without-rebuilding)). It writes no GLB of its own and starts no browser, so use it
for every look while you shape a model, and keep the full build for final checks.

```bash
mesh preview asset-src/head/build.json --views head --shading matcap,wire,cavity   --pose rest --pose blink:eyeBlinkLeft=1,eyeBlinkRight=1 --pose jaw:jawOpen=1 --sheet
```

- **Views.** `front`, `q34`, `side`, `below`, `above`, `close` (eyes to mouth), `eyes`, `mouth`, `mouth-q34`
  and `back` frame the head, which is the mesh with face shape keys, the mesh `--target <pattern>` matches, or else the top
  seventh of the body. `body-front`, `body-q34`,
  `body-side` and `body-back` frame everything. `head` and `body` are aliases for those sets.
- **Shadings.**
  - `matcap` shows lumps and ripples.
  - `zebra` shows a reflection-stripe matcap; kinks in the stripes are curvature breaks.
  - `wire` shows edge flow over the matcap.
  - `cavity` shows creases and ridges.
  - `color` shows material colors.
  - `vertex` shows the active RGB color attribute, for POINT or CORNER paint and imported GLBs.
  - `all` renders every shading.
- **Poses.** `--pose name:key=w,...` sets shape-key weights and can be repeated. `--shape` adds
  weights to every pose. Armatures stay in the rest pose unless you pass `--posed`.
- **Other options.** `--hide 'hair*'` leaves meshes out. `--size` sets the square size in pixels.
  `--sheet` adds `sheet.png`, with one row per pose.
- **Output.** Files are named `<pose>-<view>-<shading>.png`, plus a `preview.json` manifest, in
  `--out` (default `preview/` beside the source; pass `--out` yourself when the source sits in a build's `output`
  directory).

For paint inspection, use `--shading color,vertex --sheet`. Workbench vertex mode uses
`mesh.color_attributes.active_color_index`; `ACTIVE` GLB export uses `render_color_index`.
Align both explicitly when comparing source and export. Preview does not select another
layer or rewrite shaders. This is a lit RGB diagnostic: alpha masks, textures, shader
graphs and final engine appearance require their own checks. Defaults remain matcap.

`mesh preview --worker` keeps one headless Blender running and waits on a queue folder. Later
`mesh preview` calls hand their job to it and skip Blender's startup, which is slow through the
Store launcher, and edited helper modules are re-read for each job. `--no-worker-use` forces a fresh
Blender run, and `mesh preview --stop-worker` stops the worker after its current job. Without a
worker, every preview runs a one-shot Blender. The build time of the source itself is not saved: a
character's face construction still takes its minute.

## Preview a built GLB without rebuilding

`mesh preview` also takes a built `.glb` or `.gltf`. Use it for views and a contact sheet of a model that already
exists (from a build, an import or a download) when you do not want to rebuild it. `mesh view` is not that
command: it renders the workspace project and takes no GLB path.

```text
mesh preview model.glb --views body --sheet --out review/
mesh preview model.glb --views body-side --clip Walk --phases 8 --sheet --out review-walk/
```

Labels: [tested] ran on `scripts/reference-assets/rigs/fox.glb` in the 0.32.0 cycle; [documented] read in the named
file of the source (functions are named, not numbered, because line numbers drift); [general] neither.

- [documented] `.glb` and `.gltf` are accepted beside a Blender `build.json` and a `.py` source
  (`src/preview.ts`: `resolvePreviewSource`), and Blender imports the file with its glTF importer
  (`scripts/blender-preview.py`: `build_objects`). The run needs Blender and no Chromium.
- [tested] `mesh preview` of that GLB with `--sheet --out <dir>` exited 0 and wrote one PNG per view, `sheet.png` and
  `preview.json` into the directory.
- [tested] The default views `front,q34,side` framed the head and upper body of a whole animal and cut off its legs
  and tail; `--views body` (`body-front`, `body-q34`, `body-side`, `body-back`) framed all of it. [documented] The
  head is the mesh with an `eyeBlinkLeft` shape key, the mesh `--target` matches, or else the top seventh of the
  body (`scripts/blender-preview.py`: `framing`).
- [tested] `--clip Walk --phases 4 --views body-side --sheet` wrote `Walk-p0` to `Walk-p3` PNGs and a `sheet.png` with
  one posed row per phase. `--clip` with a name the file does not have exits 1 and lists the clips it has.
- [documented] With no `--out` the default is `preview/` beside the input, except when the input sits in a folder a build
  owns (it holds `.agent-meshes-build.json`, as `dist/` does): then the default is a sibling, so `dist/model.glb`
  previews into `dist-preview/` and the next `mesh build` still passes. Earlier versions wrote `dist/preview/`, which
  failed the next build with `BUILD_OUTPUT_UNOWNED_FILE` (`Unexpected directory "preview"`). `--out` always wins; pass it
  to choose the place yourself.
- [documented] `view` renders `currentProject()`, the workspace project (`src/cli.ts`: `currentProject` and the `view` command). [tested] `mesh view` run where no workspace or server exists exits 1 with the JSON error code
  `WORKBENCH_UNREACHABLE`, naming `--workspace` and `mesh preview <model.glb>`.
  Earlier versions failed with `fetch failed`. With no workspace,
  `view` needs `--workspace` or a running workbench; to look at a built model, use `mesh preview <model.glb>`.
- [general] This is Blender's Workbench shading of an imported glTF, not the three.js viewer's look. For the viewer's
  look, or a set compared from one camera, use the build previews or `recipes/set-sheet.mjs`.

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
