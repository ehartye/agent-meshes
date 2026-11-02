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
mesh bake knight.glb --clip walk --cell 64 --pixels-per-metre 32 --anchor feet --contact-sheet
```

The README section "Sprite bake" lists the flags, defaults, ranges, output files and error codes; `mesh bake --help`
is the authority. The success line is one JSON line: `output`, `files`, `size`, `frames`, `sheetSha256`, `atlasSha256`;
`files` gains `contact` only with `--contact-sheet`. Look at `sheet.png` before using it, at 1x and enlarged, or add
`--contact-sheet` and review the whole bake in one image.

Two flags answer common requests. `--pixels-per-metre` gives a whole cast one sprite scale ("Sprite scale" below).
`--contact-sheet` writes `contact.png`, the sheet enlarged 4 times for review ("Contact sheet" below).

## Palette, outline, look and anchor

Four optional flags shape the sheet to a game's palette and sprite look. With none of the optional flags, these four and
the scale and contact sheet after them, the sheet and atlas are byte-identical to the 0.39.2 output in the same
environment, and the manifest differs only in `pluginVersion`.

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

## Sprite scale

`--pixels-per-metre <n>` sets the scale of the sprite instead of fitting the camera to each model. Use it when a cast
must share one scale, so a 1.1 m goblin and a 1.8 m knight differ in height on screen by the ratio of their heights.
Without it every model is fitted to its own cell, its rest bounds filling about 80 percent of the frame (the 1.25
padding) whatever its size; the silhouette itself can be smaller.

- **Value.** A number from 1 to 1024, decimals allowed (`24.5`); default none, which keeps the fitted camera. On the
  command line it is plain digits with an optional fraction: `32`, `24.5` and `007` pass; `.5`, `5.`, `+5`, `1e2` and
  `0x10` do not. Anything else, and any value below 1 or above 1024, is `CLI_ARGUMENT_ERROR` with
  `--pixels-per-metre must be a number from 1 to 1024, got <value>`, raised before Chromium starts, with nothing written.
- **Frame.** `half = cell / (2 * pixelsPerMetre)` metres each side of the rest-bounds centre, so `--cell 64
  --pixels-per-metre 40` and `--cell 32 --pixels-per-metre 20` both give `halfExtentM` 0.8. The centre, camera distance,
  near and far planes are computed as before.
- **Vertical metre.** The scale is exact across the frame, in horizontal metres. A metre of height is drawn
  `cos(15 degrees)`, about 0.966, as tall, so a game that reads the value as a height scale is off by about 3.4 percent.
- **No padding.** The 1.25 padding is not applied, so a model that fills its cell touches the border. The manifest
  still records `padding` 1.25; the real frame is `halfExtentM`.
- **With `--cell`.** `--cell` fixes how many pixels the frame has and the scale fixes how many metres they cover.
  Unlike the fitted bake, raising `--cell` with a set scale enlarges the frame in metres.
- **A cast.** Bake every model with the same `--cell` and the same value. Each model is centred on its own rest bounds,
  so add `--anchor feet` and give each sprite its own origin. The pivot follows the scale (it is computed from the
  recorded `halfExtentM`), and `BAKE_ANCHOR_OUTSIDE` is still fixed by raising `--cell`.
- **Choosing a value.** Bake the largest model plain, read `camera.halfExtentM` from its `manifest.json`, take
  `cell / (2 * halfExtentM)` and round down. A lower value widens the frame; a higher one enlarges the sprites and can
  clip them ("A clipped cell").
- **From a height.** An upright figure is about `height in metres * scale * 0.966` pixels tall, 0.966 being the vertical
  metre above: a 1.8 m figure at a scale of 32 is about 56 pixels (1.8 * 32 * 0.966). The arm swing and other parts can
  reach past the standing height, so check for `BAKE_CELL_CLIPPED` and raise `--cell` or lower the scale.
- **Reading it back.** With the flag, `camera.pixelsPerMetre` in `manifest.json` is the exact value as parsed. Without
  it, `cell / (2 * halfExtentM)` gives the scale only approximately, because the manifest rounds `halfExtentM` to 6
  decimals (at 1024 with `--cell 8` it reads about 1024.06).

## Contact sheet

`--contact-sheet` is off by default. With it the bake writes a fourth file, `contact.png`, after the other three in the
same folder, so one image shows the whole bake. Look for a limb cut at a cell edge, a pivot that jumps between phases,
and a facing in the wrong cell; rows are directions and columns are phases. It is 4 times the cell, so judge pixel
detail from `sheet.png` at 8x, not from the contact sheet.

- **Layout.** The finished sheet (after the palette and outline) with every cell scaled 4 times by nearest neighbour,
  one row per direction and one column per phase, and a 4-pixel gutter of opaque mid-grey (128, 128, 128, 255) between
  neighbouring cells and none around the grid. It is `phases * (4 * cell) + (phases - 1) * 4` pixels wide and
  `directions * (4 * cell) + (directions - 1) * 4` tall: 1564 by 1564 at the defaults.
- **Transparency.** Cell pixels are copied unchanged, so a transparent pixel stays 0, 0, 0, 0 and the viewer's own
  background shows through the cell; the gutter marks the cell edges. There are no labels.
- **Review only.** `contact.png` is not for the engine. It is not recorded in `manifest.json` or `atlas.json`, and the
  `files` object of the success line lists it as `contact` only with the flag.
- **Size limit.** At most 134,217,728 pixels (16384 by 8192). A larger image, such as `--cell 256 --directions 8
  --phases 16` (16444 by 8220), is `CLI_ARGUMENT_ERROR` before Chromium starts; lower `--cell`, `--phases` or
  `--directions`. The flag takes no value.
- **Stale file.** A bake without the flag neither updates nor removes a `contact.png` an earlier bake left in the
  folder, so the file may be out of date. Delete it yourself, or bake with the flag again.

## Fit and reduction

- The camera is orthographic at 15 degrees elevation. It is fitted once, to the rest pose, as the largest square frame
  over every direction with 1.25 padding, and never refitted per pose, so the scale is the same in every cell. With
  `--pixels-per-metre` nothing is fitted: the frame is set from the scale as in "Sprite scale", and it is still the same
  in every cell.
- Direction `k` is azimuth `k * 360 / directions` degrees, 0 looking from +Z toward the model. Phase `p` is rendered at
  `length * p / phases`; the end of the clip is not rendered, so a loop does not repeat its first pose.
- Each cell is rendered at 8 times the cell size with no antialiasing, then reduced by taking the centre pixel of each
  8 by 8 block. Alpha is snapped to 0 or 255 at 128, and a transparent pixel is 0, 0, 0, 0. The palette, outline and look flags act
  around this step as described above.
- The asymmetric test fixture puts the body mass left of centre in `dir-0`, right of centre in `dir-4`, on the right
  half in `dir-2` and on the left half in `dir-6`. Check the order against your model's facing axis before mapping
  directions to headings.

## A clipped cell

`BAKE_CELL_CLIPPED` means an opaque pixel touches a cell border, so a pose reaches outside the frame. The message names
the direction, phase and clip, and nothing is written. Without `--pixels-per-metre` the frame was fitted to the rest
pose, and the message contains "Keep the clip inside the rest bounds, or raise --cell if it only grazes the border".
Fix it in this order:

1. If the pose only grazes the border, raise `--cell`. The frame in metres does not change, but one border pixel then
   covers a smaller slice of it, so a pose that just reaches the edge can clear.
2. If it reaches well past the border (the frame has 1.25 padding around the rest pose), keep the clip inside the rest
   bounds: reduce the swing of the named part at the named phase, or model the rest pose with that part extended so the
   fit includes the reach.
3. Bake again.

With `--pixels-per-metre` nothing was fitted and there is no padding, so the message names the set scale and contains
"Lower --pixels-per-metre or raise --cell to widen the frame". Raising `--cell` here enlarges the frame in metres, so
either change widens it:

1. Lower `--pixels-per-metre`, which widens the frame in every cell. If the cast shares a scale, lower it for the whole
   cast.
2. Or raise `--cell`, keeping the scale, at the cost of a bigger sheet.
3. If the pose reaches well past the rest bounds, reshape the clip as above. Bake again.

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
- `BAKE_CELL_CLIPPED`: an opaque pixel touches a cell border; see "A clipped cell". With `--pixels-per-metre` the
  message names the set scale and says to lower it or raise `--cell`. Nothing is written.
- `BAKE_ANCHOR_OUTSIDE`: the `--anchor feet` pivot falls outside the cell. Raise `--cell` or leave `--anchor` out.
- `CLI_ARGUMENT_ERROR`: a bad flag value, checked before Chromium starts; see "Argument errors" above. It also covers a
  `--pixels-per-metre` outside 1 to 1024 or not a number, and a `--contact-sheet` image over 134,217,728 pixels.

## What is guaranteed

`atlas.json` depends only on the GLB and the flags and holds no plugin version, timestamp or path (`manifest.json`
holds the version). The sheet is byte-identical from run to run in one environment (same machine, Node and Chromium),
and so is `contact.png`, which is made from the sheet's bytes alone. Sheet pixels can differ on another GPU or Chrome
build, so never commit a hash of the sheet as an expected value. In Phaser every tag loads with `repeat 0`, so the game
sets its own looping.
