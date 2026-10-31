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
mesh bake knight.glb --clip walk --palette art/dawnbringer16.hex --outline auto --look banded --anchor feet
```

The README section "Sprite bake" lists the flags, defaults, ranges, output files and error codes; `mesh bake --help`
is the authority. The success line is one JSON line: `output`, `files`, `size`, `frames`, `sheetSha256`, `atlasSha256`.
Look at `sheet.png` before using it, at 1x and enlarged.

## Palette, outline, look and anchor

Four optional flags shape the sheet to a game's palette and sprite look. With none of them the sheet and atlas are
byte-identical to the 0.37.0 output and the manifest differs only in `pluginVersion`.

| Flag | Values | Default |
| --- | --- | --- |
| `--palette <file>` | a `.gpl` file, or any other extension as a hex list; 1 to 256 colours | none |
| `--outline <#rrggbb\|auto>` | a hex colour, or `auto` for the palette's darkest colour (needs `--palette`) | none |
| `--look <lit\|unlit\|banded>` | room lighting, flat colour, hard-banded key light | `lit` |
| `--bands <count>` | integer 2 to 8, only with `--look banded` | 3 |
| `--anchor <feet>` | only `feet` | none |

- **Order per cell.** Render under the look, reduce, check the border, snap the palette, then outline. The border check
  sees the model's silhouette before the outline, so `BAKE_CELL_CLIPPED` keeps its meaning and the outline may sit on
  the border ring.
- **Palette file.** A `.gpl` extension is a GIMP palette; anything else is a hex list, one `#rrggbb` per line, blank
  lines ignored, lines starting with `;` comments. Duplicates are dropped keeping the first. Each alpha-255 pixel
  becomes the nearest colour in OKLab, a tie going to the earlier entry; alpha and transparent pixels are untouched. Every
  opaque pixel of the sheet, the outline included, is a palette colour.
- **Outline.** One pixel wide, outer silhouette only: a transparent pixel with an opaque 4-neighbour becomes the outline
  colour at alpha 255, and neighbours outside the cell count as transparent. There are no inner lines. With `--palette`
  a hex colour must be in the palette.
- **Look.** `unlit` is each part's base colour, texture and vertex colour with no light and no tone mapping, so a
  single-colour part is exactly that sRGB colour. `banded` is one key light fixed relative to the camera (up and to the
  left), an ambient floor, a stepped gradient of `--bands` steps, no environment and no tone mapping, so the highlight
  stays on the same side in every direction. Emissive is dropped, and materials with the unlit extension are not banded.
- **Pivot.** `--anchor feet` writes one atlas slice named `pivot` (colour `#0000ffff`, one key at frame 0, bounds the
  whole cell) with the pivot in pixels from the cell's top-left, y down. It is the cell pixel that contains the ground
  point, the point below the rest-bounds centre at the lowest bounds height, the same pixel in every cell, and the
  manifest camera gains `groundYM`. `BAKE_ANCHOR_OUTSIDE` means it falls outside the cell; raise `--cell`. Phaser
  ignores slices, so the game calls `setOrigin`; the Unity and Godot loaders in agent-sprites can honour the slice.
- **Manifest.** `look`, `bands`, `palette` (colour count and a SHA-256 of the colour list), `outline` (the resolved
  colour) and `anchor` appear only when their flag is used.
- **Argument errors.** `CLI_ARGUMENT_ERROR` before Chromium starts and nothing written: a bad value, an unreadable
  palette file or a bad palette line (named by line number), `--bands` without `--look banded`, `--outline auto`
  without `--palette`, an `--outline` colour not in the palette, or an `--anchor` other than `feet`.

## Fit and reduction

- The camera is orthographic at 15 degrees elevation. It is fitted once, to the rest pose, as the largest square frame
  over every direction with 1.25 padding, and never refitted per pose, so the scale is the same in every cell.
- Direction `k` is azimuth `k * 360 / directions` degrees, 0 looking from +Z toward the model. Phase `p` is rendered at
  `length * p / phases`; the end of the clip is not rendered, so a loop does not repeat its first pose.
- Each cell is rendered at 8 times the cell size with no antialiasing, then reduced by taking the centre pixel of each
  8 by 8 block. Alpha is snapped to 0 or 255 at 128, and a transparent pixel is 0, 0, 0, 0. The palette, outline and look flags act
  around this step as described above.
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

The atlas follows the agent-sprites atlas contract. The CLI never runs that check and never reads
`AGENT_MESHES_SPRITES_VERIFY`; this repository's tests read that variable, and their optional agent-sprites test runs
`sprite.js verify` when it is set to the `scripts/sprite.js` of an agent-sprites checkout (it skips when unset). To
check a bake yourself, run the same verifier from your own checkout:

```text
node <checkout>/scripts/sprite.js verify art/knight/atlas.json --expect-tags dir-0,dir-1,dir-2,dir-3,dir-4,dir-5,dir-6,dir-7
```

For a palette bake add `--max-colors N` (the palette size) and `--outline-colors <hex>` (the outline colour); every
visible boundary pixel must then be opaque and in that list. The verifier does not read slices.

A pass prints `PASS: 64 atlas frames` for the defaults; an `--expect-tags` name the atlas lacks, such as `dir-8`,
exits 1. The repository's own contract test restates these rules and does not need the variable.

## Error codes

Every bake error is a JSON error with a `code`:

- `CLIP_NOT_FOUND`: `--clip` names no clip in the GLB; the message lists the clips it has.
- `NO_CLIPS`: the GLB has no animation clip.
- `BAKE_CLIP_EMPTY`: the clip has zero duration, so there are no phases to render. Pick another clip or re-export it
  with keys that span time.
- `BAKE_CELL_CLIPPED`: an opaque pixel touches a cell border; see "A clipped cell". Nothing is written.
- `BAKE_ANCHOR_OUTSIDE`: the `--anchor feet` pivot falls outside the cell. Raise `--cell` or leave `--anchor` out.
- `CLI_ARGUMENT_ERROR`: a bad flag value, checked before Chromium starts; see "Argument errors" above.

## What is guaranteed

`atlas.json` depends only on the GLB and the flags and is the same everywhere, with no plugin version, timestamp or
path (`manifest.json` holds the version). The sheet is byte-identical from run to run in one environment (same
machine, Node and Chromium); the palette snap is deterministic for a given Node; pixels can differ on another GPU or Chrome build. Never commit a hash of the sheet as an
expected value. In Phaser every tag loads with `repeat 0`, so the game sets its own looping.
