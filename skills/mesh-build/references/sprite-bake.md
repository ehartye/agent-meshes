# Bake a clip into a sprite sheet

Entry: [mesh-build](../SKILL.md).

## Bake a clip into a sprite sheet

`bake` renders one clip of a rigged GLB from several directions and packs the frames into a sheet and an
Aseprite-format atlas that Phaser and other 2D engines load unchanged. It needs Chromium and no Blender. Choose it only
when a rigged model must show many facings; for a small cast, drawing sprites directly is cheaper (see the 2D route in
[mesh-tool-selection](../../mesh-tool-selection/SKILL.md)).

```text
mesh bake knight.glb --clip walk
mesh bake knight.glb --clip walk --directions 4 --phases 6 --cell 64 --out art/knight
```

The README section "Sprite bake" lists the flags, defaults, ranges, output files and error codes; `mesh bake --help`
is the authority. The success line is one JSON line: `output`, `files`, `size`, `frames`, `sheetSha256`, `atlasSha256`.
Look at `sheet.png` before using it, at 1x and enlarged.

## Fit and reduction

- The camera is orthographic at 15 degrees elevation. It is fitted once, to the rest pose, as the largest square frame
  over every direction with 1.25 padding, and never refitted per pose, so the scale is the same in every cell.
- Direction `k` is azimuth `k * 360 / directions` degrees, 0 looking from +Z toward the model. Phase `p` is rendered at
  `length * p / phases`; the end of the clip is not rendered, so a loop does not repeat its first pose.
- Each cell is rendered at 8 times the cell size with no antialiasing, then reduced by taking the centre pixel of each
  8 by 8 block. Alpha is snapped to 0 or 255 at 128, and a transparent pixel is 0, 0, 0, 0. No palette is applied.
- The asymmetric test fixture puts the body mass left of centre in `dir-0`, right of centre in `dir-4`, on the right
  half in `dir-2` and on the left half in `dir-6`. Check the order against your model's facing axis before mapping
  directions to headings.

## A clipped cell

`BAKE_CELL_CLIPPED` means an opaque pixel touches a cell border, so a pose reaches outside the frame fitted to the
rest pose. The message names the direction, phase and clip, and nothing is written. Fix it in this order:

1. If the pose only grazes the border, raise `--cell`. The frame in metres does not change, but one border pixel then
   covers a smaller slice of it, so a pose that just reaches the edge can clear.
2. If it reaches well past the border (the frame has 1.25 padding around the rest pose), keep the clip inside the rest
   bounds: reduce the swing of the named part at the named phase, or model the rest pose with that part extended so the
   fit includes the reach.
3. Bake again.

## Check the atlas with agent-sprites

The atlas follows the agent-sprites atlas contract. When a checkout of agent-sprites is available, set
`AGENT_MESHES_SPRITES_VERIFY` to its `scripts/sprite.js` and run:

```text
node <path in AGENT_MESHES_SPRITES_VERIFY> verify art/knight/atlas.json --expect-tags dir-0,dir-1,dir-2,dir-3,dir-4,dir-5,dir-6,dir-7
```

A pass prints `PASS: 64 atlas frames` for the defaults; an `--expect-tags` name the atlas lacks, such as `dir-8`,
exits 1. The repository's own contract test restates these rules and does not need the variable; the optional test
skips when it is unset.

## What is guaranteed

`atlas.json` depends only on the GLB and the flags and is the same everywhere, with no plugin version, timestamp or
path (`manifest.json` holds the version). The sheet is byte-identical from run to run in one environment (same
machine, Node and Chromium); pixels can differ on another GPU or Chrome build. Never commit a hash of the sheet as an
expected value. In Phaser every tag loads with `repeat 0`, so the game sets its own looping.
