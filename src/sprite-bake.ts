import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { browserLaunchOptions } from './browser.ts';
import { readAccessor, readGLB } from './gltf-read.ts';
import { decodePng, encodePng } from './png.ts';
import { viewerScript } from './preview-html.ts';
import { assertSheetSpec, buildAtlas, buildManifest, checkAtlasContract, serializeAtlas, SPRITE_ATLAS_IMAGE, SPRITE_MANIFEST_FORMAT, type SheetSpec, type SlicePivot, type SpriteManifest } from './sprite-atlas.ts';
import { lookScript, parseBands, parseLook, type SpriteLook } from './sprite-look.ts';
import { CONTACT_MAX_PIXELS, composeContactSheet, contactSize } from './sprite-contact.ts';
import { outlineCell } from './sprite-outline.ts';
import { darkestColor, paletteManifest, readPalette, snapToPalette, type Palette } from './sprite-palette.ts';
import { composeViewer } from './sprite-viewer.ts';

/**
 * Bake one clip of a rigged GLB into a sprite sheet a 2D engine loads unchanged: `sheet.png`, an Aseprite-format
 * `atlas.json` with one frame tag per direction, and a `manifest.json` that records how the sheet was made.
 *
 * The camera is orthographic and fitted once, at rest, from the model's bounds, so the scale is the same in every cell.
 * Each cell is rendered at 8 times its size with no antialiasing and reduced by taking the centre pixel of every 8 by 8
 * block; alpha is then snapped to 0 or 255 and a transparent pixel is 0, 0, 0, 0. A cell with an opaque pixel on its
 * outer ring fails the whole bake (`BAKE_CELL_CLIPPED`) and nothing is written.
 *
 * With `pixelsPerMetre` the half extent is set from the scale (`cell / (2 * pixelsPerMetre)`, no padding) instead of fitted.
 * With `contactSheet` a fourth file, `contact.png`, is written after the three: the sheet scaled 4 times for review (see sprite-contact.ts).
 * With `viewer` a last file, `viewer.html`, is written after `contact.png`: a page that plays the loop from `sheet.png` beside it (see sprite-viewer.ts).
 * With `elevation` the camera sits that many degrees above the horizon instead of 15: the fit, every cell and the feet pivot use it, and the manifest
 * records it as `camera.elevationDeg`, the key that already held 15. A vertical metre is drawn `cos(elevation)` as tall and a metre of ground depth
 * `sin(elevation)` as tall, so 30 degrees matches a 2:1 isometric floor.
 * With `oblique` the camera is level and depth is drawn by a shear in the projection (a cabinet or cavalier view): the frame of each direction is
 * centred on the picture of the model at rest, and the manifest records `camera.projection: 'oblique'`, the angle, the ratio and `camera.frameCentreM`.
 * With `azimuth` direction 0 looks from that many degrees from +Z toward +X; any finite angle is taken and wrapped into 0 to 360.
 * With `yaws` the rows are a list of chosen azimuths instead of an even ring, recorded as `camera.yawsDeg`.
 * `anchor: 'origin'` writes the model origin as the pivot, one slice key per direction when the directions disagree.
 * A third argument shares one running browser between bakes (see sprite-bake-batch.ts); the files are the same bytes either way.
 * Neither `contactSheet` nor `viewer` is recorded in the atlas or the manifest, which are the same bytes with and without them, and a `contact.png` or `viewer.html` left by an earlier bake is never removed.
 *
 * Optional passes, all off by default (a bake with none of them is the 0.37.0 output): `look` (`unlit` or `banded`)
 * replaces the room lighting before the fit; after the border check `palette` snaps every opaque pixel to the palette,
 * then `outline` adds a one-pixel outer outline; `anchor: 'feet'` writes the ground point as a pivot slice. Every option is
 * checked before the browser starts and any fault raises `CLI_ARGUMENT_ERROR`.
 */
export const BAKE_DEFAULTS = { directions: 8, phases: 8, cell: 48 } as const;
export const BAKE_LIMITS = { directions: [1, 32], phases: [1, 64], cell: [8, 512] } as const;
/** Inclusive range of `pixelsPerMetre`: below 1 the frame is wider than `cell` metres and the sprite would be a few pixels. */
export const BAKE_PIXELS_PER_METRE_LIMITS = [1, 1024] as const;
/** Render size over cell size: each cell pixel is the centre of an 8 by 8 block. */
export const BAKE_SUPERSAMPLE = 8;
/** Default camera height above the horizon, in degrees; `elevation` replaces it for one bake. */
export const BAKE_ELEVATION_DEG = 15;
/** Inclusive range of `elevation` in degrees: 0 is level with the model; 90 (straight down) has no defined up direction, so the range stops at 89. */
export const BAKE_ELEVATION_LIMITS = [0, 89] as const;
/** An angle in degrees wrapped into 0 (included) to 360 (excluded): 432 is 72, -90 is 270 and 360 is 0. */
export const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;
/** Ranges of the two numbers of `oblique`: the screen angle of the depth axis in degrees, and the length a metre of depth is drawn at. */
export const BAKE_OBLIQUE_LIMITS = { angle: [0, 360], ratio: [0.01, 2] } as const;
export const BAKE_ANCHORS = ['feet', 'origin'] as const;
export type BakeAnchor = (typeof BAKE_ANCHORS)[number];
/** An oblique view: the plane facing the camera is drawn square on, and depth runs off at `angleDeg` on screen, `ratio` as long. */
export interface BakeOblique { angleDeg: number; ratio: number }
/** Margin of the rest fit: the frame is this much larger than the rest bounds need. */
export const BAKE_PADDING = 1.25;
const ALPHA_THRESHOLD = 128;
const OUTPUT_NAMES = { sheet: SPRITE_ATLAS_IMAGE, atlas: 'atlas.json', manifest: 'manifest.json' } as const;
const CONTACT_NAME = 'contact.png';
const VIEWER_NAME = 'viewer.html';

export interface BakeOptions {
  clip: string;
  /** Integer 1 to 32; default 8. Strings are accepted so command-line values pass straight through. */
  directions?: number | string;
  /** Integer 1 to 64; default 8. */
  phases?: number | string;
  /** Cell edge in pixels, an integer 8 to 512; default 48. */
  cell?: number | string;
  /** Output folder; default `<glb stem>-sprites` beside the GLB. */
  out?: string;
  /** A palette file: `.gpl` (GIMP palette) or a hex list of `#rrggbb` lines. Every opaque pixel is snapped to it in OKLab. */
  palette?: string;
  /** `#rrggbb`, or `auto` for the palette's darkest colour (needs `palette`). With a palette the colour must be in it. */
  outline?: string;
  /** `lit` (default, the room lighting), `unlit` (flat albedo) or `banded` (one key light in hard steps). */
  look?: string;
  /** Light steps of `banded`, an integer 2 to 8, default 3; valid only with `look: 'banded'`. */
  bands?: number | string;
  /** `feet` writes the ground point under the centre of the rest bounds as the atlas pivot slice; `origin` writes the model's origin (0, 0, 0), one key per direction when they differ. */
  anchor?: string;
  /** Sets the sprite scale instead of fitting the camera: a number (or numeric text) from 1 to 1024; default none (fitted). */
  pixelsPerMetre?: number | string;
  /** Camera height above the horizon in degrees: a number (or numeric text) from 0 to 89; default 15. */
  elevation?: number | string;
  /** Where direction 0 looks from, in degrees from +Z toward +X: any finite number (or numeric text), wrapped into 0 to 360; default 0. The other directions follow it evenly. */
  azimuth?: number | string;
  /** The azimuth of every row, as `"0,270,315"` or a list of numbers: 1 to 32 finite angles, each wrapped into 0 to 360, no two the same. Row k is tag `dir-k`. It replaces the even ring, so it is not valid with `directions` or `azimuth`. */
  yaws?: string | readonly number[];
  /** An oblique view as `"<angle>,<ratio>"` (or the two numbers): the camera is level, the plane facing it is drawn square on, and a metre of depth is drawn `ratio` long at `angle` degrees on screen (0 right, 90 up). Not valid with `elevation`. */
  oblique?: string | BakeOblique;
  /** `true` also writes `contact.png`, the sheet scaled 4 times with a grey gutter between cells, for review; `false` is the same as unset. */
  contactSheet?: boolean;
  /** `true` also writes `viewer.html`, a page that plays the baked loop from `sheet.png` beside it, after every other file; `false` is the same as unset. */
  viewer?: boolean;
}
export interface BakeSettings {
  clip: string; directions: number; phases: number; cell: number; out?: string;
  /** Each of these is set only when the matching option was given. */
  look?: SpriteLook; bands?: number; palette?: Palette; paletteFile?: string; outline?: string; outlineColor?: [number, number, number]; anchor?: BakeAnchor; pixelsPerMetre?: number; elevation?: number; azimuth?: number; yaws?: number[]; oblique?: BakeOblique; contactSheet?: true; viewer?: true;
}
export interface BakeResult {
  /** Absolute output folder. */
  output: string;
  /** The files, relative to `output`: the three of the bake, then `contact` only with `contactSheet`, then `viewer` only with `viewer`. */
  files: { sheet: string; atlas: string; manifest: string; contact?: string; viewer?: string };
  size: { w: number; h: number };
  frames: number;
  sheetSha256: string;
  atlasSha256: string;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const code = (message: string, errorCode: string) => Object.assign(new Error(message), { code: errorCode });

function integerOption(name: 'directions' | 'phases' | 'cell', value: number | string | undefined): number {
  if (value === undefined) return BAKE_DEFAULTS[name];
  const [min, max] = BAKE_LIMITS[name];
  const number = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(number) || number < min || number > max) throw code(`--${name} must be an integer from ${min} to ${max}, got ${value}`, 'CLI_ARGUMENT_ERROR');
  return number;
}

/** The scale as a number: a finite number, or text of digits with an optional fraction ("007", "24.5"), from 1 to 1024. */
function pixelsPerMetreOption(value: unknown): number {
  const [min, max] = BAKE_PIXELS_PER_METRE_LIMITS;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!(number >= min && number <= max)) throw code(`--pixels-per-metre must be a number from ${min} to ${max}, got ${String(value)}`, 'CLI_ARGUMENT_ERROR');
  return number;
}

/** The camera elevation as a number of degrees: a finite number, or text of digits with an optional fraction ("30", "26.565"), from 0 to 89. */
function elevationOption(value: unknown): number {
  const [min, max] = BAKE_ELEVATION_LIMITS;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!(number >= min && number <= max)) throw code(`--elevation must be a number of degrees from ${min} to ${max}, got ${String(value)}`, 'CLI_ARGUMENT_ERROR');
  return number;
}

/** An angle as a finite number, or text of an optional minus sign, digits and an optional fraction; anything else is NaN. */
const angleValue = (value: unknown): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : Number.NaN;
};

/** The start azimuth as a number of degrees: any finite number, or text of an optional minus sign, digits and an optional fraction, wrapped into 0 to 360. */
function azimuthOption(value: unknown): number {
  const number = angleValue(value);
  if (Number.isNaN(number)) throw code(`--azimuth must be a finite number of degrees (any angle; it is wrapped into 0 to 360), got ${String(value)}`, 'CLI_ARGUMENT_ERROR');
  return wrapDegrees(number);
}

/** The row azimuths as numbers of degrees: text `"0,270,315"` or a list, 1 to 32 finite angles, each wrapped into 0 to 360, no two the same. */
function yawsOption(value: unknown): number[] {
  const [min, max] = BAKE_LIMITS.directions;
  const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const parts: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const yaws = parts.map(part => angleValue(part));
  if (yaws.length < min || yaws.length > max || yaws.some(Number.isNaN))
    throw code(`--yaws must be a comma-separated list of ${min} to ${max} finite numbers of degrees (any angle; each is wrapped into 0 to 360), for example 0,270,315, got ${shown}`, 'CLI_ARGUMENT_ERROR');
  const wrapped = yaws.map(wrapDegrees);
  const repeat = wrapped.findIndex((yaw, k) => wrapped.indexOf(yaw) !== k);
  if (repeat >= 0) throw code(`--yaws lists the azimuth ${wrapped[repeat]} twice (rows ${wrapped.indexOf(wrapped[repeat])} and ${repeat} after wrapping into 0 to 360), got ${shown}. Each row must be a different direction.`, 'CLI_ARGUMENT_ERROR');
  return wrapped;
}

/** The oblique view as two numbers: text `"<angle>,<ratio>"` or an object, the angle from 0 to 360 degrees and the ratio from 0.01 to 2. */
function obliqueOption(value: unknown): BakeOblique {
  const { angle: [angleMin, angleMax], ratio: [ratioMin, ratioMax] } = BAKE_OBLIQUE_LIMITS;
  let angleDeg = Number.NaN, ratio = Number.NaN;
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(value.trim());
    if (match) { angleDeg = Number(match[1]); ratio = Number(match[2]); }
  } else if (value && typeof value === 'object') {
    const given = value as { angleDeg?: unknown; ratio?: unknown };
    if (typeof given.angleDeg === 'number' && typeof given.ratio === 'number') { angleDeg = given.angleDeg; ratio = given.ratio; }
  }
  if (!(angleDeg >= angleMin && angleDeg <= angleMax && ratio >= ratioMin && ratio <= ratioMax))
    throw code(`--oblique must be <angle>,<ratio>: the screen angle of the depth axis in degrees from ${angleMin} to ${angleMax} and the drawn length of a metre of depth from ${ratioMin} to ${ratioMax} (45,0.5 is a cabinet view), got ${typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)}`, 'CLI_ARGUMENT_ERROR');
  return { angleDeg, ratio };
}

/** Check the command's options before any file or browser is touched. Raises `CLI_ARGUMENT_ERROR`. */
export function parseBakeOptions(options: BakeOptions): BakeSettings {
  if (typeof options.clip !== 'string' || !options.clip) throw code('--clip <name> is required', 'CLI_ARGUMENT_ERROR');
  if (options.out !== undefined && (typeof options.out !== 'string' || !options.out)) throw code('--out must be a folder path', 'CLI_ARGUMENT_ERROR');
  const settings: BakeSettings = { clip: options.clip, directions: integerOption('directions', options.directions), phases: integerOption('phases', options.phases), cell: integerOption('cell', options.cell), out: options.out };
  if (options.yaws !== undefined) {
    settings.yaws = yawsOption(options.yaws);
    if (options.directions !== undefined) throw code(`--yaws lists the directions itself, one row for each angle, so it cannot be combined with --directions (got --directions ${options.directions}). Leave --directions out.`, 'CLI_ARGUMENT_ERROR');
    if (options.azimuth !== undefined) throw code(`--yaws gives the azimuth of every row, so it cannot be combined with --azimuth (got --azimuth ${options.azimuth}). Leave --azimuth out and put the angle in the list.`, 'CLI_ARGUMENT_ERROR');
    settings.directions = settings.yaws.length;
  }
  if (options.palette !== undefined) {
    if (typeof options.palette !== 'string' || !options.palette) throw code('--palette must be a palette file path', 'CLI_ARGUMENT_ERROR');
    settings.palette = readPalette(options.palette);
    settings.paletteFile = options.palette;
  }
  if (options.look !== undefined) settings.look = parseLook(options.look);
  if (options.bands !== undefined) {
    const bands = parseBands(options.bands);
    if (settings.look !== 'banded') throw code(`--bands needs --look banded (got ${options.bands} with --look ${settings.look ?? 'lit'})`, 'CLI_ARGUMENT_ERROR');
    settings.bands = bands;
  } else if (settings.look === 'banded') settings.bands = parseBands(undefined);
  if (options.outline !== undefined) {
    if (typeof options.outline !== 'string') throw code('--outline must be #rrggbb or auto', 'CLI_ARGUMENT_ERROR');
    let hex: string;
    if (options.outline === 'auto') {
      if (!settings.palette) throw code("--outline auto needs --palette <file>, because it uses the palette's darkest colour", 'CLI_ARGUMENT_ERROR');
      hex = darkestColor(settings.palette);
    } else {
      if (!/^#[0-9a-fA-F]{6}$/.test(options.outline)) throw code(`--outline must be #rrggbb or auto, got ${options.outline}`, 'CLI_ARGUMENT_ERROR');
      hex = options.outline.toLowerCase();
      if (settings.palette && !settings.palette.hex.includes(hex)) throw code(`--outline ${hex} is not a colour of the palette ${settings.paletteFile}; use a palette colour or --outline auto, so every opaque pixel stays in the palette`, 'CLI_ARGUMENT_ERROR');
    }
    settings.outline = hex;
    settings.outlineColor = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  if (options.pixelsPerMetre !== undefined) settings.pixelsPerMetre = pixelsPerMetreOption(options.pixelsPerMetre);
  if (options.elevation !== undefined) settings.elevation = elevationOption(options.elevation);
  if (options.azimuth !== undefined) settings.azimuth = azimuthOption(options.azimuth);
  if (options.oblique !== undefined) {
    settings.oblique = obliqueOption(options.oblique);
    if (settings.elevation !== undefined) throw code(`--oblique draws the model from level, so it cannot be combined with --elevation (got --elevation ${settings.elevation}). Leave --elevation out; the oblique angle and ratio place the depth axis.`, 'CLI_ARGUMENT_ERROR');
  }
  if (options.contactSheet !== undefined && typeof options.contactSheet !== 'boolean') throw code(`--contact-sheet takes no value (contactSheet is true or false), got ${String(options.contactSheet)}`, 'CLI_ARGUMENT_ERROR');
  if (options.contactSheet) {
    const { width, height } = contactSize(settings);
    if (width * height > CONTACT_MAX_PIXELS)
      throw code(`--contact-sheet would make an image of ${width} by ${height} pixels, over the ${CONTACT_MAX_PIXELS} pixel limit (16384 by 8192). Lower --cell, --phases or --directions, or leave --contact-sheet out.`, 'CLI_ARGUMENT_ERROR');
    settings.contactSheet = true;
  }
  if (options.viewer !== undefined && typeof options.viewer !== 'boolean') throw code(`--viewer takes no value (viewer is true or false), got ${String(options.viewer)}`, 'CLI_ARGUMENT_ERROR');
  if (options.viewer) settings.viewer = true;
  if (options.anchor !== undefined) {
    if (!(BAKE_ANCHORS as readonly string[]).includes(options.anchor)) throw code(`--anchor must be feet or origin, got ${options.anchor}`, 'CLI_ARGUMENT_ERROR');
    settings.anchor = options.anchor as BakeAnchor;
  }
  return settings;
}

/**
 * The feet pivot as a cell pixel, from the numbers the manifest records. The camera orbits the vertical axis through the
 * rest-bounds centre, so the ground point (below that centre, at the lowest bounds height) is `centreYM - groundYM` below the
 * camera target. An orthographic camera at elevation `e` shows a vertical offset `d` as `d * cos(e)` on screen, and the frame
 * spans `2 * halfExtentM` over `cell` pixels, so the point lies `cell / 2` across and `cell / 2 * (1 + d * cos(e) / half)` down,
 * measured from the top-left corner of the cell. The reduction samples the centre of each 8 by 8 block, so cell pixel `j`
 * stands for the point `j + 0.5`, and the pivot is the pixel whose sample is nearest the ground point: `floor` of each
 * coordinate (rounding the coordinate less one half, half up). It is the pixel the foot's lowest point renders in.
 */
export function feetPivot(input: { cell: number; elevationDeg: number; halfExtentM: number; centreYM: number; groundYM: number }): SlicePivot {
  const { cell, elevationDeg, halfExtentM, centreYM, groundYM } = input;
  const down = (centreYM - groundYM) * Math.cos(elevationDeg * Math.PI / 180);
  const x = Math.floor(cell / 2), y = Math.floor(cell / 2 * (1 + down / halfExtentM));
  if (!(x >= 0 && x < cell && y >= 0 && y < cell))
    throw code(`The feet pivot falls at ${x}, ${y}, outside the ${cell} by ${cell} cell, so --anchor feet cannot place it. Raise --cell or leave --anchor out.`, 'BAKE_ANCHOR_OUTSIDE');
  return { x, y };
}

/**
 * Where a point of the model lands in a cell, for any camera the bake can set: `pointM` and `centreM` in metres, the camera
 * looking at `centreM` from `azimuthDeg` (from +Z toward +X). With `oblique` the camera is level and a metre of depth behind
 * the centre moves the point `ratio` metres along the screen angle; otherwise the camera sits `elevationDeg` above the horizon.
 * `frameCentreM` is where the middle of the frame sits, across and up from the picture of `centreM` (an oblique bake centres
 * the frame on the picture of the model; default 0, 0).
 * The pixel is the one whose sample is nearest, as in `feetPivot`. Raises `BAKE_ANCHOR_OUTSIDE` when it is outside the cell.
 */
export function anchorPivot(input: { cell: number; halfExtentM: number; elevationDeg: number; azimuthDeg: number; oblique?: BakeOblique; centreM: readonly number[]; pointM: readonly number[]; frameCentreM?: readonly number[]; name?: string }): SlicePivot {
  const { cell, halfExtentM, centreM, pointM } = input;
  const az = input.azimuthDeg * Math.PI / 180, el = input.elevationDeg * Math.PI / 180;
  const v = [pointM[0] - centreM[0], pointM[1] - centreM[1], pointM[2] - centreM[2]];
  const right = v[0] * Math.cos(az) - v[2] * Math.sin(az);
  // How far the point is behind the centre, along the level direction the camera looks in.
  const behind = -(v[0] * Math.sin(az) + v[2] * Math.cos(az));
  let across = right, up: number;
  if (input.oblique) {
    const angle = input.oblique.angleDeg * Math.PI / 180;
    across += behind * input.oblique.ratio * Math.cos(angle);
    up = v[1] + behind * input.oblique.ratio * Math.sin(angle);
  } else up = v[1] * Math.cos(el) + behind * Math.sin(el);
  const [frameX, frameY] = input.frameCentreM ?? [0, 0];
  const x = Math.floor(cell / 2 * (1 + (across - frameX) / halfExtentM)), y = Math.floor(cell / 2 * (1 - (up - frameY) / halfExtentM));
  if (!(x >= 0 && x < cell && y >= 0 && y < cell))
    throw code(`The ${input.name ?? 'anchor'} pivot falls at ${x}, ${y}, outside the ${cell} by ${cell} cell, so --anchor ${input.name ?? 'origin'} cannot place it. Raise --cell or leave --anchor out.`, 'BAKE_ANCHOR_OUTSIDE');
  return { x, y };
}

interface GlbAnimation { name?: string; samplers?: { input: number }[] }

/** The clip's name and length in seconds, read from the GLB with no renderer. Raises `NO_CLIPS`, `CLIP_NOT_FOUND` and `BAKE_CLIP_EMPTY`. */
export function bakeClipInfo(glb: Uint8Array, clip: string): { names: string[]; durationSeconds: number } {
  const doc = readGLB(glb);
  const animations = ((doc.json as { animations?: GlbAnimation[] }).animations ?? []);
  // The viewer names an unnamed animation by its index, as the glTF loader does.
  const names = animations.map((animation, index) => animation.name || `animation_${index}`);
  if (!names.length) throw code('The GLB has no animation clips to bake', 'NO_CLIPS');
  const index = names.indexOf(clip);
  if (index < 0) throw code(`No clip named ${clip}; clips: ${names.join(', ')}`, 'CLIP_NOT_FOUND');
  let durationSeconds = 0;
  for (const sampler of animations[index].samplers ?? []) for (const time of readAccessor(doc, sampler.input).data) durationSeconds = Math.max(durationSeconds, time);
  if (!(durationSeconds > 0)) throw code(`Clip ${clip} has zero duration, so there are no phases to bake`, 'BAKE_CLIP_EMPTY');
  return { names, durationSeconds };
}

/** Reduce a render of `cell * 8` pixels square to `cell` pixels: the centre pixel of each 8 by 8 block, alpha snapped to 0 or 255 at 128, transparent pixels 0, 0, 0. */
export function reduceCell(rgba: Uint8Array, cell: number): Buffer {
  const render = cell * BAKE_SUPERSAMPLE;
  if (rgba.length !== render * render * 4) throw code(`A cell render of ${cell * BAKE_SUPERSAMPLE} pixels square needs ${render * render * 4} bytes, got ${rgba.length}`, 'BAKE_RENDER_FAILED');
  const out = Buffer.alloc(cell * cell * 4);
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const from = ((y * BAKE_SUPERSAMPLE + BAKE_SUPERSAMPLE / 2) * render + x * BAKE_SUPERSAMPLE + BAKE_SUPERSAMPLE / 2) * 4, to = (y * cell + x) * 4;
    if (rgba[from + 3] >= ALPHA_THRESHOLD) { out[to] = rgba[from]; out[to + 1] = rgba[from + 1]; out[to + 2] = rgba[from + 2]; out[to + 3] = 255; }
  }
  return out;
}

/** True when any pixel on the outermost ring of a reduced cell is opaque. */
export function touchesBorder(cellRgba: Uint8Array, cell: number): boolean {
  for (let k = 0; k < cell; k++)
    for (const [x, y] of [[k, 0], [k, cell - 1], [0, k], [cell - 1, k]]) if (cellRgba[(y * cell + x) * 4 + 3] !== 0) return true;
  return false;
}

/** `frames` is set by an oblique bake only: for each direction, where the middle of the frame sits across and up from the picture of `centre`. */
interface Fit { centre: [number, number, number]; distance: number; half: number; groundY: number; durationSeconds: number; frames?: [number, number][] }
interface MatrixLike { clone(): MatrixLike; set(...values: number[]): MatrixLike; multiply(other: MatrixLike): MatrixLike; copy(other: MatrixLike): MatrixLike; invert(): MatrixLike }
interface VectorLike { x: number; y: number; z: number; applyMatrix4(matrix: unknown): VectorLike }
interface MeshLike { isMesh?: boolean; visible: boolean; matrixWorld: unknown; geometry?: { attributes: { position?: { count: number } } }; getVertexPosition(index: number, target: VectorLike): VectorLike }
interface ViewerLike {
  duration: number;
  bounds(): { min: { y: number; distanceTo(v: unknown): number; clone(): VectorLike; toArray(): number[] }; max: { toArray(): number[] }; getCenter(target: unknown): { toArray(): number[] } };
  camera: {
    top: number; bottom: number; left: number; right: number; zoom: number; near: number; far: number; updateProjectionMatrix(): void;
    projectionMatrix: MatrixLike; projectionMatrixInverse: MatrixLike;
  };
  view(spec: { position: number[]; target: number[] }): void;
  scene: { updateMatrixWorld(force?: boolean): void; traverse(visit: (object: MeshLike) => void): void };
  frame(padding: number): void;
  play(name: string): void; pause(): void; seek(time: number): void;
  screenshot(): string;
}

/** The page the bake renders in; exported so a test can pin the mount options without launching Chromium. */
export const harness = (render: number) => `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage{width:${render}px;height:${render}px}</style>
<div id="stage"></div><script id="glb" type="text/plain">@GLB@</script><script src="mesh-viewer.js"></script>
<script>window.ready = MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: null, floor: false, projection: 'orthographic', autoplay: false, orbit: false, quality: { pixelRatio: 1, shadows: false, antialias: false } }).then(v => (window.viewer = v));</script></html>`;

/** The end of the `BAKE_CELL_CLIPPED` message: with a set scale nothing was fitted, so the advice is to lower the scale or raise `--cell`. */
const clippedAdvice = (settings: BakeSettings) => settings.pixelsPerMetre === undefined
  ? 'fitted to its rest pose. Keep the clip inside the rest bounds, or raise --cell if it only grazes the border. Nothing was written.'
  : `set by --pixels-per-metre ${settings.pixelsPerMetre} at --cell ${settings.cell}. Lower --pixels-per-metre or raise --cell to widen the frame. Nothing was written.`;

/** The camera values a bake takes from its options alone, as the manifest records them; the fitted values are added by the bake. */
function cameraSettings(settings: BakeSettings): Record<string, number | string | number[]> {
  const oblique = settings.oblique;
  return {
    projection: oblique ? 'oblique' : 'orthographic', elevationDeg: oblique ? 0 : settings.elevation ?? BAKE_ELEVATION_DEG,
    ...(settings.azimuth !== undefined ? { azimuthDeg: settings.azimuth } : {}), ...(settings.yaws ? { yawsDeg: [...settings.yaws] } : {}),
    ...(oblique ? { obliqueAngleDeg: oblique.angleDeg, obliqueRatio: oblique.ratio } : {}), padding: BAKE_PADDING, supersample: BAKE_SUPERSAMPLE,
    ...(settings.pixelsPerMetre !== undefined ? { pixelsPerMetre: settings.pixelsPerMetre } : {}),
  };
}
/** Camera keys of the manifest that come from fitting the model, not from the options. */
const FITTED_CAMERA_KEYS = ['halfExtentM', 'distanceM', 'centreM', 'frameCentreM', 'groundYM'];
const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Everything that decides the bytes of a bake, apart from the code itself: the model, the plugin version and the options.
 * `manifestFingerprint` reads the same value back from a written manifest, so two equal strings mean that manifest was
 * written for this model with these options by this version.
 */
export function bakeFingerprint(settings: BakeSettings, modelSha256: string, version: string): string {
  return JSON.stringify({
    format: SPRITE_MANIFEST_FORMAT, pluginVersion: version, model: modelSha256, clip: settings.clip, directions: settings.directions, phases: settings.phases, cell: settings.cell,
    camera: sorted(cameraSettings(settings)), look: settings.look ?? null, bands: settings.bands ?? null, palette: settings.palette ? sorted(paletteManifest(settings.palette)) : null,
    outline: settings.outline ?? null, anchor: settings.anchor ?? null,
  });
}
/** The fingerprint of the bake that wrote `manifest`; see `bakeFingerprint`. A value that is not a bake manifest gives a string no bake has. */
export function manifestFingerprint(manifest: SpriteManifest): string {
  const camera = manifest?.camera && typeof manifest.camera === 'object' ? manifest.camera : {};
  return JSON.stringify({
    format: manifest?.format, pluginVersion: manifest?.pluginVersion, model: manifest?.model?.sha256, clip: manifest?.clip?.name, directions: manifest?.directions, phases: manifest?.phases, cell: manifest?.cell,
    camera: sorted(Object.fromEntries(Object.entries(camera).filter(([key]) => !FITTED_CAMERA_KEYS.includes(key)))), look: manifest?.look ?? null, bands: manifest?.bands ?? null,
    palette: manifest?.palette ? sorted(manifest.palette) : null, outline: manifest?.outline ?? null, anchor: manifest?.anchor?.name ?? null,
  });
}
/** The version of this package, which every manifest records. */
export const pluginVersion = async (): Promise<string> => (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** A running browser that several bakes share. Each bake opens its own context in it and closes that context; the owner closes the browser. */
export interface BakeSession { browser: Browser }

/** Bake one clip of a rigged GLB. See the module comment for the pipeline and the error codes. With a `session` the bake renders in its browser instead of starting one. */
export async function bakeSprites(glbPath: string, options: BakeOptions, session?: BakeSession): Promise<BakeResult> {
  const settings = parseBakeOptions(options);
  const { clip, directions, phases, cell } = settings;
  const source = resolve(glbPath);
  const glb = await readFile(source);
  const { durationSeconds: nodeDuration } = bakeClipInfo(glb, clip);
  assertSheetSpec({ cell, directions, phases, clipDurationMs: nodeDuration * 1000 });
  const output = resolve(settings.out ?? join(dirname(source), `${basename(source, extname(source))}-sprites`));
  const render = cell * BAKE_SUPERSAMPLE;
  // An oblique view is drawn from level: the depth axis is placed by the shear, not by raising the camera.
  const oblique = settings.oblique ?? null;
  const elevation = oblique ? 0 : settings.elevation ?? BAKE_ELEVATION_DEG;
  const azimuth = settings.azimuth ?? 0;
  // The azimuth of every row, in degrees for the pivots and messages and in radians for the camera. The even ring keeps the
  // arithmetic it has always had, so its pixels do not move.
  const azimuthsDeg = settings.yaws ?? Array.from({ length: directions }, (_, k) => azimuth + k * 360 / directions);
  const azimuths = settings.yaws ? settings.yaws.map(yaw => yaw * Math.PI / 180) : Array.from({ length: directions }, (_, k) => azimuth * Math.PI / 180 + k / directions * 2 * Math.PI);

  const work = await mkdtemp(join(tmpdir(), 'agent-meshes-bake-'));
  let cells: Buffer[] = [];
  let fit: Fit = { centre: [0, 0, 0], distance: 0, half: 0, groundY: 0, durationSeconds: 0 };
  try {
    await writeFile(join(work, 'mesh-viewer.js'), await viewerScript());
    await writeFile(join(work, 'harness.html'), harness(render).replace('@GLB@', () => glb.toString('base64')));
    const browser = session?.browser ?? await chromium.launch({ headless: true, ...browserLaunchOptions() });
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    try {
      context = await browser.newContext({ offline: true, viewport: { width: render, height: render }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(work, 'harness.html')).href, { waitUntil: 'load' });
      await page.evaluate(() => (window as unknown as { ready: Promise<unknown> }).ready);
      // The look edits the mounted scene in place, before the fit; `lit` has no script and the render is untouched.
      const look = lookScript(settings.look ?? 'lit', settings.bands);
      if (look) await page.evaluate(look);
      // Fit once, at rest: the largest square half extent over every direction, with the camera a fixed distance out.
      // With a set scale the half extent is not fitted: the frame spans `cell` pixels at `pixelsPerMetre`, with no padding.
      const setHalf = settings.pixelsPerMetre === undefined ? null : cell / (2 * settings.pixelsPerMetre);
      fit = await page.evaluate(({ azimuths, elevation, oblique, padding, setHalf }) => {
        const v = (window as unknown as { viewer: ViewerLike }).viewer;
        const box = v.bounds(), centre = box.getCenter(box.min.clone());
        const diagonal = Math.max(box.min.distanceTo(box.max), 1e-3), distance = diagonal * 2, c = centre.toArray();
        const el = elevation * Math.PI / 180, directions = azimuths.length;
        const shearX = oblique ? oblique.ratio * Math.cos(oblique.angleDeg * Math.PI / 180) : 0, shearY = oblique ? oblique.ratio * Math.sin(oblique.angleDeg * Math.PI / 180) : 0;
        let half = 0;
        // An oblique picture is not centred on the picture of the box centre: a tall part at one end pulls it to a side.
        // So the frame of each direction is centred on the picture of the model itself at rest, vertex by vertex.
        const frames: [number, number][] = [];
        const points: number[] = [];
        if (oblique) {
          const at = box.min.clone();
          v.scene.updateMatrixWorld(true);
          v.scene.traverse(object => {
            const count = object.isMesh && object.visible ? object.geometry?.attributes.position?.count ?? 0 : 0;
            for (let i = 0; i < count; i++) { object.getVertexPosition(i, at).applyMatrix4(object.matrixWorld); points.push(at.x - c[0], at.y - c[1], at.z - c[2]); }
          });
        }
        for (let k = 0; k < directions && (oblique || setHalf === null); k++) {
          const az = azimuths[k];
          if (oblique) {
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (let i = 0; i < points.length; i += 3) {
              const behind = -(points[i] * Math.sin(az) + points[i + 2] * Math.cos(az));
              const across = points[i] * Math.cos(az) - points[i + 2] * Math.sin(az) + behind * shearX, up = points[i + 1] + behind * shearY;
              x0 = Math.min(x0, across); x1 = Math.max(x1, across); y0 = Math.min(y0, up); y1 = Math.max(y1, up);
            }
            if (!points.length) x0 = x1 = y0 = y1 = 0;
            frames.push([Math.round((x0 + x1) / 2 * 1e6) / 1e6, Math.round((y0 + y1) / 2 * 1e6) / 1e6]);
            if (setHalf === null) half = Math.max(half, (x1 - x0) / 2 * padding, (y1 - y0) / 2 * padding, 1e-3);
          } else {
            v.view({ position: [c[0] + Math.sin(az) * Math.cos(el) * distance, c[1] + Math.sin(el) * distance, c[2] + Math.cos(az) * Math.cos(el) * distance], target: c });
            v.frame(padding);
            half = Math.max(half, v.camera.top);
          }
        }
        if (setHalf !== null) half = setHalf;
        const camera = v.camera;
        camera.zoom = 1; camera.top = half; camera.bottom = -half; camera.left = -half; camera.right = half;
        camera.near = distance * 0.05; camera.far = distance * 3;
        camera.updateProjectionMatrix();
        if (oblique) {
          // Shear view space about the plane through the centre (z = -distance): a point `d` behind it moves d * ratio along
          // the screen angle. The shear is part of the projection, so normals, and with them the lighting, are untouched.
          const refresh = camera.updateProjectionMatrix.bind(camera);
          const shear = camera.projectionMatrix.clone().set(1, 0, -shearX, -shearX * distance, 0, 1, -shearY, -shearY * distance, 0, 0, 1, 0, 0, 0, 0, 1);
          const apply = () => { refresh(); camera.projectionMatrix.multiply(shear); camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert(); };
          camera.updateProjectionMatrix = apply;
          apply();
        }
        return { centre: c as [number, number, number], distance, half, groundY: box.min.y, durationSeconds: 0, ...(oblique ? { frames } : {}) };
      }, { azimuths, elevation, oblique, padding: BAKE_PADDING, setHalf });
      fit.durationSeconds = await page.evaluate(name => { const v = (window as unknown as { viewer: ViewerLike }).viewer; v.play(name); v.pause(); return v.duration; }, clip);
      if (!(fit.durationSeconds > 0)) throw code(`Clip ${clip} has zero duration, so there are no phases to bake`, 'BAKE_CLIP_EMPTY');
      cells = [];
      for (let d = 0; d < directions; d++) for (let p = 0; p < phases; p++) {
        const url = await page.evaluate(({ p, phases, elevation, az, centre, distance, half, frame }) => {
          const v = (window as unknown as { viewer: ViewerLike }).viewer;
          const el = elevation * Math.PI / 180;
          if (frame) {
            const camera = v.camera;
            camera.left = frame[0] - half; camera.right = frame[0] + half; camera.bottom = frame[1] - half; camera.top = frame[1] + half;
            camera.updateProjectionMatrix();
          }
          v.seek(v.duration * p / phases);
          v.view({ position: [centre[0] + Math.sin(az) * Math.cos(el) * distance, centre[1] + Math.sin(el) * distance, centre[2] + Math.cos(az) * Math.cos(el) * distance], target: centre });
          return v.screenshot();
        }, { p, phases, elevation, az: azimuths[d], centre: fit.centre, distance: fit.distance, half: fit.half, frame: fit.frames?.[d] ?? null });
        const image = decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        if (image.width !== render || image.height !== render) throw code(`The render for direction ${d}, phase ${p} is ${image.width} by ${image.height}, not ${render} by ${render}`, 'BAKE_RENDER_FAILED');
        const reduced = reduceCell(image.rgba, cell);
        if (touchesBorder(reduced, cell))
          throw code(`Cell for direction ${d} (dir-${d}, ${+wrapDegrees(azimuthsDeg[d]).toFixed(3)} degrees), phase ${p}, clip ${clip} has opaque pixels on its border, so the model reaches outside the frame ${clippedAdvice(settings)}`, 'BAKE_CELL_CLIPPED');
        // The border check is on the model alone; the palette snap and the outline come after it.
        let finished = reduced;
        if (settings.palette) finished = snapToPalette(finished, settings.palette);
        if (settings.outlineColor) finished = outlineCell(finished, cell, settings.outlineColor);
        cells.push(finished);
      }
    } finally { if (session) await context?.close().catch(() => undefined); else await browser.close(); }
  } finally { await rm(work, { recursive: true, force: true }); }

  // Everything is in memory and every cell passed: pack the sheet and write.
  const spec: SheetSpec = { cell, directions, phases, clipDurationMs: Number((fit.durationSeconds * 1000).toFixed(3)) };
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  // The pivot comes from the same rounded numbers the manifest records, so it can be recomputed from the manifest alone.
  // With the camera on the vertical axis through the centre, the feet are the same pixel in every direction. The origin is
  // not on that axis, and an oblique frame is centred per direction, so those pivots are worked out for each direction.
  const centreM = fit.centre.map(round), perDirection = settings.anchor === 'origin' || (settings.anchor === 'feet' && oblique !== null);
  const feet = settings.anchor === 'feet' && !oblique ? feetPivot({ cell, elevationDeg: elevation, halfExtentM: round(fit.half), centreYM: centreM[1], groundYM: round(fit.groundY) }) : undefined;
  const each = perDirection ? Array.from({ length: directions }, (_, k) => anchorPivot({
    cell, halfExtentM: round(fit.half), elevationDeg: elevation, azimuthDeg: azimuthsDeg[k], oblique: oblique ?? undefined, centreM, frameCentreM: fit.frames?.[k],
    pointM: settings.anchor === 'origin' ? [0, 0, 0] : [centreM[0], round(fit.groundY), centreM[2]], name: settings.anchor,
  })) : undefined;
  const pivot = feet ?? each?.[0];
  const atlas = buildAtlas(spec, each ?? feet);
  const width = phases * cell, height = directions * cell, sheet = Buffer.alloc(width * height * 4);
  cells.forEach((pixels, i) => {
    const row = Math.floor(i / phases), column = i % phases;
    for (let y = 0; y < cell; y++) pixels.copy(sheet, ((row * cell + y) * width + column * cell) * 4, y * cell * 4, (y + 1) * cell * 4);
  });
  const problems = checkAtlasContract(atlas, { sheet: { width, height }, expectedTags: Array.from({ length: directions }, (_, k) => `dir-${k}`) });
  if (problems.length) throw code(`The generated atlas breaks the atlas contract: ${problems.join('; ')}`, 'BAKE_ATLAS_INVALID');
  const png = encodePng(width, height, sheet), atlasText = serializeAtlas(atlas);
  // The review image is built from the same buffer as the sheet and before any file is written, so a failure still writes nothing.
  const contact = settings.contactSheet ? composeContactSheet(sheet, { cell, directions, phases }) : undefined;
  const contactPng = contact ? encodePng(contact.width, contact.height, contact.rgba) : undefined;
  const sheetSha256 = sha256(png), atlasSha256 = sha256(atlasText);
  const version = await pluginVersion();
  const manifest = buildManifest({
    model: { sha256: sha256(glb) }, clip: { name: clip, durationMs: spec.clipDurationMs }, directions, phases, cell,
    camera: { ...cameraSettings(settings), ...(oblique ? { frameCentreM: (fit.frames ?? []).flat() } : {}), halfExtentM: round(fit.half), distanceM: round(fit.distance), centreM: fit.centre.map(round), ...(settings.anchor === 'feet' ? { groundYM: round(fit.groundY) } : {}) },
    sheetSha256, atlasSha256, pluginVersion: version,
    ...(settings.look !== undefined ? { look: settings.look } : {}),
    ...(settings.bands !== undefined ? { bands: settings.bands } : {}),
    ...(settings.palette ? { palette: paletteManifest(settings.palette) } : {}),
    ...(settings.outline ? { outline: settings.outline } : {}),
    ...(pivot && settings.anchor ? { anchor: { name: settings.anchor, x: pivot.x, y: pivot.y, ...(each && each.some(o => o.x !== pivot.x || o.y !== pivot.y) ? { byDirection: each.map(o => [o.x, o.y]) } : {}) } } : {}),
  });
  // The page is composed here, from the same atlas, manifest and sheet hash that are written, so a failure still writes nothing.
  const viewerHtml = settings.viewer ? composeViewer(atlas, manifest, OUTPUT_NAMES.sheet, sheetSha256) : undefined;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, OUTPUT_NAMES.sheet), png);
  await writeFile(join(output, OUTPUT_NAMES.atlas), atlasText);
  await writeFile(join(output, OUTPUT_NAMES.manifest), `${JSON.stringify(manifest, null, 1)}\n`);
  if (contactPng) await writeFile(join(output, CONTACT_NAME), contactPng);
  if (viewerHtml !== undefined) await writeFile(join(output, VIEWER_NAME), viewerHtml);
  return { output, files: { ...OUTPUT_NAMES, ...(contactPng ? { contact: CONTACT_NAME } : {}), ...(viewerHtml !== undefined ? { viewer: VIEWER_NAME } : {}) }, size: { w: width, h: height }, frames: atlas.frames.length, sheetSha256, atlasSha256 };
}
