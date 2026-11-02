# 2D engines: evidence for the route

Evidence behind the 2D engine row in the skill. Labels: [tested] ran on this repository; [documented] read in the
named file at the named version; [general] neither. Re-read a file if your version differs.

## Phaser has no model loader

- [documented] phaser 4.2.1 (`package.json`) has no glTF code. `src/loader/filetypes/index.js` and its folder hold 34
  loader file types (images, atlases, audio, tilemaps, text, video and others) and none is for glTF or GLB. A
  case-insensitive search of the whole package for "gltf" finds nothing. `src/loader/filetypes/BinaryFile.js` fetches
  raw bytes as an ArrayBuffer, so a GLB can be downloaded but nothing in the package draws it.
- [documented] agent-phaser 0.1.11, `skills/engine-phaser/references/loading-assets.md` section "Choosing a format":
  Phaser 4.2.1 has no glTF or GLB loader, and `Mesh2D` is 2D. After an upgrade, list the `src/loader/filetypes` folder
  of the installed phaser package again; that section holds the command.
- [general] Canvas 2D and Pixi packages were not read here; they also draw sprites, so check their loaders.

## The sprite route

- [documented] agent-sprites 0.100.0, `README.md` section "Build a repeatable asset project": the `character` source
  gives shared adult and child body profiles, and the `creature` source gives animals, insects, arachnids, birds and
  crawlers. Its skills `sprite-character`, `sprite-editing` and `game-integration` hold the recipes.
- [documented] agent-sprites 0.100.0, `skills/game-integration/SKILL.md` section "Phaser (proven wiring)": an Aseprite
  atlas loads in Phaser with `load.aseprite`, then `anims.createFromAseprite`.
- [documented] agent-sprites 0.100.0, `skills/sprite-export/SKILL.md` front matter description: its exporter is "not 3D
  mesh baking".

## Pre-rendering

- [documented] `src/cli.ts` registers `bake`: `agent-meshes bake <glb> --clip <name>` writes a sprite sheet, an Aseprite
  atlas with a `dir-N` tag per facing and a manifest.
- [documented] `mesh preview --clip <name> --phases <count>` and `scripts/review-model.mjs` are review tools,
  not sprite exporters. `src/preview.ts` lines 62-71 set evenly spaced phases;
  `scripts/blender-preview.py` renders each selected view at every phase, sets `film_transparent = False` (line 237) and
  an 85 mm lens (`LENS`, lines 39, 122) and never selects an orthographic camera. `scripts/review-model.mjs` writes
  one image per azimuth for each pose and region, from a viewer with `floor:false` and a solid background (`defaults`
  there), so an opaque canvas unless a config sets `background: null`, and a `THREE.PerspectiveCamera`
  (`createCamera` in `src/web/room.ts`). Both give perspective images, opaque by default.
- [tested] `tests/sprite-bake.test.ts` bakes an asymmetric rigged fixture: a 384 by 384 sheet with alpha 0 or 255 only,
  64 frames, tags `dir-0` to `dir-7`, and the same bytes on a second run.
- [general] No threshold for "many" facings, and no figure for where pre-rendering beats drawing, appears in what was
  read, and none was measured here. Pre-rendering suits a rigid object that must show many facings, or a cast too large
  to draw; a small cast with a few facings is cheaper to draw with agent-sprites. `bake` holds one orthographic camera,
  a transparent background and one scale for every frame.
