# 2D engines: evidence for the route

Evidence behind the 2D engine row in the skill. Labels: [tested] ran on this repository; [documented] read in the
named file at the named version; [general] neither. Re-read a file if your version differs.

## Phaser has no model loader

- [documented] phaser 4.2.1 (`package.json`) has no glTF code. `src/loader/filetypes/index.js` and its folder hold 34
  loader file types (images, atlases, audio, tilemaps, text, video and others) and none is for glTF or GLB. A
  case-insensitive search of the whole package for "gltf" finds nothing. `src/loader/filetypes/BinaryFile.js` fetches
  raw bytes as an ArrayBuffer, so a GLB can be downloaded but nothing in the package draws it.
- [documented] agent-engine 0.21.0, `skills/phaser-rendering/references/mesh2d-and-triangle-batching.md` line 3:
  Mesh2D draws textured triangles in 2D and "has no 3D, bones or depth buffer".
- [general] Canvas 2D and Pixi are on the row because they also draw sprites. Their packages were not read here, so
  check the engine's loaders before assuming the same.

## The sprite route

- [documented] agent-sprites 0.95.0, `README.md` lines 444 and 502-504: the `character` source gives shared
  adult and child body profiles, and the `creature` source gives animals, insects, arachnids, birds and crawlers.
- [documented] agent-sprites 0.95.0, `skills/game-integration/SKILL.md` lines 182-197: an Aseprite atlas loads in
  Phaser with `load.aseprite`, then `anims.createFromAseprite`.
- [documented] agent-sprites 0.95.0, `skills/sprite-export/SKILL.md` line 3: its exporter is "not 3D mesh baking".

## Pre-rendering

- [documented] `src/cli.ts` registers capabilities, inspect, serve, new, recipe, state, op, batch, save, open, undo,
  redo, export, verify, silhouette, stats, diff, verify-unreal, gait, check-garments, refine, preview, viewer,
  mobile-physics, view, assemble, build and build-batch, and no `bake`.
- [documented] Capture paths such as `mesh preview --clip <name> --phases <count>` and `scripts/review-model.mjs` are
  review tools, not sprite exporters. `src/preview.ts` lines 62-71 set evenly spaced phases;
  `scripts/blender-preview.py` renders each selected view at every phase, sets `film_transparent = False` (line 237) and
  an 85 mm lens (`LENS`, lines 39, 122) and never selects an orthographic camera. `scripts/review-model.mjs` writes
  one image per azimuth for each pose and region, from a viewer with `floor:false` and a solid background (line 37), so
  an opaque canvas, and a `THREE.PerspectiveCamera` (`src/web/viewer.ts` lines 72-73). Both give opaque, perspective
  images.
- [tested] `tests/mesh-tool-selection-skill.test.ts` fails if `src/cli.ts` registers a `bake` command or if those
  scripts or `src/web/viewer.ts` change those settings, so the "no shipped command" wording in the skill cannot go
  stale silently. The bake check sees only that name, so re-read the command list whenever this file is edited.
- [general] Pre-rendering a rigged model to frames pays off for a rigid object that must show many facings, or a
  cast whose directions times animations times variants is too many to draw. For a small cast with a few facings,
  drawing it with agent-sprites is cheaper. A custom script must hold one orthographic camera, a transparent
  background and one scale for every frame, then be checked with `sprite-verification`.
