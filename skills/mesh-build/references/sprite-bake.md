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
mesh bake knight.glb --clip walk --viewer
mesh bake knight.glb --clip walk --elevation 30 --pixels-per-metre 32 --cell 64 --anchor feet
mesh bake house.glb --clip idle --directions 1 --azimuth 270 --oblique 45,0.5 --pixels-per-metre 20 --cell 512 --anchor origin
```

The README section "Sprite bake" lists the flags, defaults, ranges, output files and error codes; `mesh bake --help`
is the authority. The success line is one JSON line: `output`, `files`, `size`, `frames`, `sheetSha256`, `atlasSha256`;
`files` gains `contact` only with `--contact-sheet` and `viewer` only with `--viewer`. Look at `sheet.png` before using
it, at 1x and enlarged, or add `--contact-sheet` and review the whole bake in one image. A walk cycle is judged in
motion, so add `--viewer` and play the loop.

Four flags answer common requests. `--elevation` matches the camera to the game's ground ("Camera elevation" below).
`--pixels-per-metre` gives a whole cast one sprite scale ("Sprite scale" below).
`--contact-sheet` writes `contact.png`, the sheet enlarged 4 times for review ("Contact sheet" below). `--viewer`
writes `viewer.html`, a page that plays the baked loop ("Viewer" below).

## Palette, outline, look and anchor

Four optional flags shape the sheet to a game's palette and sprite look. With none of the optional flags, these four and
the scale, contact sheet and viewer after them, the sheet and atlas are byte-identical to the 0.39.2 output in the same
environment, and the manifest differs only in `pluginVersion`.

| Flag | Values | Default |
| --- | --- | --- |
| `--palette <file>` | a `.gpl` file, or any other extension as a hex list; 1 to 256 colours | none |
| `--outline <#rrggbb\|auto>` | a hex colour, or `auto` for the palette's darkest colour (needs `--palette`) | none |
| `--look <lit\|unlit\|banded>` | room lighting, flat colour, hard-banded key light | `lit` |
| `--bands <count>` | integer 2 to 8, only with `--look banded` | 3 |
| `--anchor <feet\|origin>` | `feet` or `origin` | none |

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
  without `--palette`, an `--outline` colour not in the palette, or an `--anchor` other than `feet` or `origin`.

## Camera elevation

`--elevation <degrees>` sets how high the camera sits above the horizon. The default, 15, is a side-on view that suits a
platformer or a flat backdrop. A game that draws its ground from above needs the sprites baked from the same angle, or
they look as if they stand more upright than the floor they walk on.

- **Value.** A number from 0 to 89, decimals allowed (`26.565`); plain digits with an optional fraction, as for
  `--pixels-per-metre`. Anything else is `CLI_ARGUMENT_ERROR` with `--elevation must be a number of degrees from 0 to
  89, got <value>`, raised before Chromium starts, with nothing written. Straight down (90) is not accepted.
- **Choosing it.** A camera at elevation `e` draws a metre of ground depth `sin(e)` as tall as a metre of width. Read
  the ratio off the game's floor tile: a 2:1 isometric (dimetric) diamond, 64 by 32 pixels, is `sin(e) = 0.5`, so
  `--elevation 30`. A 3:2 floor is about 42, and true isometric is 35.264.
- **Height.** A metre of height is drawn `cos(e)` as tall: 0.966 at 15, 0.866 at 30, 0.707 at 45. Use that factor, not
  0.966, in the arithmetic of "Sprite scale" when the elevation is set.
- **Fit and pivot.** The fit, every cell and the `--anchor feet` pivot use the set elevation. A steeper camera sees more
  of the top of the model, so a fitted frame and the pivot row both change; bake a cast with one elevation.
- **Manifest.** `camera.elevationDeg` records the value; the key was already there holding 15, so no key is added and
  `--elevation 15` gives the same three files as no flag.
- **Directions.** Azimuths are unchanged: direction `k` is still `k * 360 / directions` degrees from +Z. For a diamond
  floor, bake 8 directions and map the row to the screen heading in the game.
- **Not reviewed.** The `banded` key light stays fixed to the camera, up and to the left, at every elevation; how its
  bands read from a steep camera has not been judged.

## Oblique view, start azimuth, origin pivot and large cells

Use these when a 2D game draws its world in an oblique projection (walls square on, the ground running off at a slant),
when it needs one chosen facing, or when a building is larger than a character cell.

| Flag | Values | Default |
| --- | --- | --- |
| `--oblique <angle,ratio>` | angle 0 to 360 degrees, ratio 0.01 to 2; not with `--elevation` | none |
| `--azimuth <degrees>` | -360 to 360, from +Z toward +X | 0 |
| `--anchor origin` | the model origin (0, 0, 0) as the pivot | none |
| `--cell <pixels>` | 8 to 512 | 48 |

- **Oblique.** The camera is level. The plane facing it is drawn square on, verticals stay vertical, and a metre of depth
  behind the centre is drawn `ratio` metres long at `angle` degrees on screen (0 right, 90 up): `45,0.5` is a cabinet
  view, `45,1` a cavalier one. To match a game, take the game's screen vector for one metre of depth: its direction is the
  angle and its length, in metres at the sprite scale, the ratio. Do not fake the view by scaling or shearing a root bone:
  that shears the normals, so the banded light lands on the wrong faces, and it leaves the picture off centre.
- **Frame.** Each direction's frame is centred on the picture of the model at rest, so a model that is tall at one end
  still uses the whole cell. `camera.frameCentreM` in the manifest holds, for each direction, where the middle of the
  frame sits across and up from the picture of `camera.centreM`.
- **Azimuth.** Direction `k` looks from `azimuth + k * 360 / directions` degrees. For one facing use `--directions 1`
  and the azimuth of the side the camera stands on: 0 is +Z, 90 is +X, 180 is -Z, 270 is -X.
- **Origin pivot.** `--anchor origin` gives the pixel of the model origin, which is what a game uses when it places a
  building by the point it was modelled around. Off the centre axis the pixel differs per direction: read the slice key
  of that direction's first frame, or `anchor.byDirection` in the manifest. With `--oblique`, `--anchor feet` is also
  per direction.
- **Large cells.** A cell renders at 8 times its edge, so `--cell 512` is a 4096 pixel render and takes about four times
  as long as 256. At 20 pixels a metre a 512 cell holds a picture 25.6 m across. Prefer the smallest cell the largest
  model of a set fits, with one `--pixels-per-metre` for the whole set.
- **Not verified.** An oblique bake of a skinned character through a whole walk cycle, and `--oblique` with `--look lit`
  (the room lighting), were not looked at: only rigid models under the banded look were.

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
  `cos(15 degrees)`, about 0.966, as tall (the cosine of `--elevation` when that is set), so a game that reads the value
  as a height scale is off by about 3.4 percent at the default.
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

## Viewer

`--viewer` is off by default. With it the bake writes one more file, `viewer.html`, after the others in the same folder
(after `contact.png` when `--contact-sheet` is also set). It plays the baked loop, so you can judge the motion and not
only the still: a pop at the loop seam, a foot that slides, a facing that jumps. Open it in a browser. It needs
`sheet.png` beside it, so keep the two together, and it works from `file://`, offline: it loads no font and makes no
network request. Without the sheet it shows a notice that it could not load it.

- **Facing.** The picker lists "All facings" first, then one entry per `dir-n` tag; `dir-0` is selected when the page
  opens. "All facings" plays every facing at once at the chosen scale and hides the frame strip and the loop-seam strip (it says so on the page).
- **Playback.** Scale 1, 2, 4 or 8 times, drawn by nearest neighbour; it starts at the largest of these that keeps the
  cell within 256 pixels. Speed 0.25, 0.5, 1 or 2 times. Backdrop neutral, green, light grey, near black or checker.
  Pause and play, and step back and forward, one frame each, wrapping at the ends. Each frame lasts its `duration` in
  the atlas, or 150 ms when it has none. The page plays when it opens, except when the system asks for reduced motion:
  then it opens paused on frame 0, with the button reading "Play", and Play still starts it. The setting is read once,
  when the page loads.
- **Frame strip.** One entry per phase of the chosen facing with the current frame marked; click one to hold it. Frame
  numbers on the page count inside the facing, from 0 to phases minus 1.
- **Loop seam.** The last two frames and the first two of the chosen facing side by side, with a "loop point" mark
  directly before the first frame, also when the strip wraps onto several rows. The step across that mark is the one
  that can pop.
- **Pivot.** Only when the bake used `--anchor feet`: a "Show pivot" box, ticked by default, marks the pivot pixel on
  every frame, the strips and the "All facings" tiles included. Without the slice there is no box and no mark.
- **Keys.** Space pauses and plays, the left and right arrows step, and 1 to 8 pick `dir-0` to `dir-7`. A held Space
  toggles once, not on every key repeat. A number key does nothing when the bake has fewer facings than that number.
  Keys are ignored while a menu or the "Show pivot" box has focus and with Ctrl, Meta or Alt held. There is no key for
  "All facings".
- **Header and footer.** The header shows the clip name, the facings, the phases, the cell size and the loop length from
  the manifest. The footer shows the first 12 hex digits of the sheet's SHA-256, so you can match the page to a sheet.
  The clip name comes from the GLB and is shown as text, never as markup.
- **Review only.** `viewer.html` is not for the engine. It is not recorded in `manifest.json` or `atlas.json`, so
  `sheet.png`, `atlas.json` and `manifest.json` are the same bytes with and without the flag, and the `files` object of
  the success line lists it as `viewer`, after `contact`, only with the flag. The flag takes no value.
- **Stale file.** A bake without the flag neither updates nor removes a `viewer.html` an earlier bake left in the
  folder, so the page may belong to an older sheet. Delete it yourself, or bake with the flag again.

## Fit and reduction

- The camera is orthographic at 15 degrees elevation, or at `--elevation` degrees. It is fitted once, to the rest pose, as the largest square frame
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
- `BAKE_ANCHOR_OUTSIDE`: the `--anchor` pivot falls outside the cell. Raise `--cell` or leave `--anchor` out.
- `CLI_ARGUMENT_ERROR`: a bad flag value, checked before Chromium starts; see "Argument errors" above. It also covers a
  `--pixels-per-metre` outside 1 to 1024 or not a number, an `--elevation` outside 0 to 89 or not a number, a `--contact-sheet` image over 134,217,728 pixels, and a value
  given to `--viewer`.

## What is guaranteed

`atlas.json` depends only on the GLB and the flags and holds no plugin version, timestamp or path (`manifest.json`
holds the version). The sheet is byte-identical from run to run in one environment (same machine, Node and Chromium),
and so is `contact.png`, which is made from the sheet's bytes alone. `viewer.html` is made from the atlas, the manifest
and the sheet's hash alone, with no clock, so the same bake gives the same page. Sheet pixels can differ on another GPU
or Chrome build, so never commit a hash of the sheet as an expected value. In Phaser every tag loads with `repeat 0`, so
the game sets its own looping.
