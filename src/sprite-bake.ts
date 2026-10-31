import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { browserLaunchOptions } from './browser.ts';
import { readAccessor, readGLB } from './gltf-read.ts';
import { decodePng, encodePng } from './png.ts';
import { viewerScript } from './preview-html.ts';
import { assertSheetSpec, buildAtlas, buildManifest, checkAtlasContract, serializeAtlas, SPRITE_ATLAS_IMAGE, type SheetSpec, type SlicePivot } from './sprite-atlas.ts';
import { lookScript, parseBands, parseLook, type SpriteLook } from './sprite-look.ts';
import { outlineCell } from './sprite-outline.ts';
import { darkestColor, paletteManifest, readPalette, snapToPalette, type Palette } from './sprite-palette.ts';

/**
 * Bake one clip of a rigged GLB into a sprite sheet a 2D engine loads unchanged: `sheet.png`, an Aseprite-format
 * `atlas.json` with one frame tag per direction, and a `manifest.json` that records how the sheet was made.
 *
 * The camera is orthographic and fitted once, at rest, from the model's bounds, so the scale is the same in every cell.
 * Each cell is rendered at 8 times its size with no antialiasing and reduced by taking the centre pixel of every 8 by 8
 * block; alpha is then snapped to 0 or 255 and a transparent pixel is 0, 0, 0, 0. A cell with an opaque pixel on its
 * outer ring fails the whole bake (`BAKE_CELL_CLIPPED`) and nothing is written.
 *
 * Optional passes, all off by default (a bake with none of them is the 0.37.0 output): `look` (`unlit` or `banded`)
 * replaces the room lighting before the fit; after the border check `palette` snaps every opaque pixel to the palette,
 * then `outline` adds a one-pixel outer outline; `anchor: 'feet'` writes the ground point as a pivot slice. Every option is
 * checked before the browser starts and any fault raises `CLI_ARGUMENT_ERROR`.
 */
export const BAKE_DEFAULTS = { directions: 8, phases: 8, cell: 48 } as const;
export const BAKE_LIMITS = { directions: [1, 32], phases: [1, 64], cell: [8, 256] } as const;
/** Render size over cell size: each cell pixel is the centre of an 8 by 8 block. */
export const BAKE_SUPERSAMPLE = 8;
/** Camera height above the horizon, in degrees. */
export const BAKE_ELEVATION_DEG = 15;
/** Margin of the rest fit: the frame is this much larger than the rest bounds need. */
export const BAKE_PADDING = 1.25;
const ALPHA_THRESHOLD = 128;
const OUTPUT_NAMES = { sheet: SPRITE_ATLAS_IMAGE, atlas: 'atlas.json', manifest: 'manifest.json' } as const;

export interface BakeOptions {
  clip: string;
  /** Integer 1 to 32; default 8. Strings are accepted so command-line values pass straight through. */
  directions?: number | string;
  /** Integer 1 to 64; default 8. */
  phases?: number | string;
  /** Cell edge in pixels, an integer 8 to 256; default 48. */
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
  /** `feet` writes the ground point of the rest bounds as the atlas pivot slice. */
  anchor?: string;
}
export interface BakeSettings {
  clip: string; directions: number; phases: number; cell: number; out?: string;
  /** Each of these is set only when the matching option was given. */
  look?: SpriteLook; bands?: number; palette?: Palette; paletteFile?: string; outline?: string; outlineColor?: [number, number, number]; anchor?: 'feet';
}
export interface BakeResult {
  /** Absolute output folder. */
  output: string;
  /** The three files, relative to `output`. */
  files: { sheet: string; atlas: string; manifest: string };
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

/** Check the command's options before any file or browser is touched. Raises `CLI_ARGUMENT_ERROR`. */
export function parseBakeOptions(options: BakeOptions): BakeSettings {
  if (typeof options.clip !== 'string' || !options.clip) throw code('--clip <name> is required', 'CLI_ARGUMENT_ERROR');
  if (options.out !== undefined && (typeof options.out !== 'string' || !options.out)) throw code('--out must be a folder path', 'CLI_ARGUMENT_ERROR');
  const settings: BakeSettings = { clip: options.clip, directions: integerOption('directions', options.directions), phases: integerOption('phases', options.phases), cell: integerOption('cell', options.cell), out: options.out };
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
  if (options.anchor !== undefined) {
    if (options.anchor !== 'feet') throw code(`--anchor must be feet, got ${options.anchor}`, 'CLI_ARGUMENT_ERROR');
    settings.anchor = 'feet';
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

interface Fit { centre: [number, number, number]; distance: number; half: number; groundY: number; durationSeconds: number }
interface ViewerLike {
  duration: number;
  bounds(): { min: { y: number; distanceTo(v: unknown): number; clone(): unknown }; max: unknown; getCenter(target: unknown): { toArray(): number[] } };
  camera: { top: number; bottom: number; left: number; right: number; zoom: number; near: number; far: number; updateProjectionMatrix(): void };
  view(spec: { position: number[]; target: number[] }): void;
  frame(padding: number): void;
  play(name: string): void; pause(): void; seek(time: number): void;
  screenshot(): string;
}

/** The page the bake renders in; exported so a test can pin the mount options without launching Chromium. */
export const harness = (render: number) => `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage{width:${render}px;height:${render}px}</style>
<div id="stage"></div><script id="glb" type="text/plain">@GLB@</script><script src="mesh-viewer.js"></script>
<script>window.ready = MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: null, floor: false, projection: 'orthographic', autoplay: false, orbit: false, quality: { pixelRatio: 1, shadows: false, antialias: false } }).then(v => (window.viewer = v));</script></html>`;

/** Bake one clip of a rigged GLB. See the module comment for the pipeline and the error codes. */
export async function bakeSprites(glbPath: string, options: BakeOptions): Promise<BakeResult> {
  const settings = parseBakeOptions(options);
  const { clip, directions, phases, cell } = settings;
  const source = resolve(glbPath);
  const glb = await readFile(source);
  const { durationSeconds: nodeDuration } = bakeClipInfo(glb, clip);
  assertSheetSpec({ cell, directions, phases, clipDurationMs: nodeDuration * 1000 });
  const output = resolve(settings.out ?? join(dirname(source), `${basename(source, extname(source))}-sprites`));
  const render = cell * BAKE_SUPERSAMPLE;

  const work = await mkdtemp(join(tmpdir(), 'agent-meshes-bake-'));
  let cells: Buffer[] = [];
  let fit: Fit = { centre: [0, 0, 0], distance: 0, half: 0, groundY: 0, durationSeconds: 0 };
  try {
    await writeFile(join(work, 'mesh-viewer.js'), await viewerScript());
    await writeFile(join(work, 'harness.html'), harness(render).replace('@GLB@', () => glb.toString('base64')));
    const browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
    try {
      const context = await browser.newContext({ offline: true, viewport: { width: render, height: render }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(work, 'harness.html')).href, { waitUntil: 'load' });
      await page.evaluate(() => (window as unknown as { ready: Promise<unknown> }).ready);
      // The look edits the mounted scene in place, before the fit; `lit` has no script and the render is untouched.
      const look = lookScript(settings.look ?? 'lit', settings.bands);
      if (look) await page.evaluate(look);
      // Fit once, at rest: the largest square half extent over every direction, with the camera a fixed distance out.
      fit = await page.evaluate(({ directions, elevation, padding }) => {
        const v = (window as unknown as { viewer: ViewerLike }).viewer;
        const box = v.bounds(), centre = box.getCenter(box.min.clone());
        const diagonal = Math.max(box.min.distanceTo(box.max), 1e-3), distance = diagonal * 2, c = centre.toArray();
        const el = elevation * Math.PI / 180;
        let half = 0;
        for (let k = 0; k < directions; k++) {
          const az = k / directions * 2 * Math.PI;
          v.view({ position: [c[0] + Math.sin(az) * Math.cos(el) * distance, c[1] + Math.sin(el) * distance, c[2] + Math.cos(az) * Math.cos(el) * distance], target: c });
          v.frame(padding);
          half = Math.max(half, v.camera.top);
        }
        const camera = v.camera;
        camera.zoom = 1; camera.top = half; camera.bottom = -half; camera.left = -half; camera.right = half;
        camera.near = distance * 0.05; camera.far = distance * 3;
        camera.updateProjectionMatrix();
        return { centre: c as [number, number, number], distance, half, groundY: box.min.y, durationSeconds: 0 };
      }, { directions, elevation: BAKE_ELEVATION_DEG, padding: BAKE_PADDING });
      fit.durationSeconds = await page.evaluate(name => { const v = (window as unknown as { viewer: ViewerLike }).viewer; v.play(name); v.pause(); return v.duration; }, clip);
      if (!(fit.durationSeconds > 0)) throw code(`Clip ${clip} has zero duration, so there are no phases to bake`, 'BAKE_CLIP_EMPTY');
      cells = [];
      for (let d = 0; d < directions; d++) for (let p = 0; p < phases; p++) {
        const url = await page.evaluate(({ d, p, directions, phases, elevation, centre, distance }) => {
          const v = (window as unknown as { viewer: ViewerLike }).viewer;
          const az = d / directions * 2 * Math.PI, el = elevation * Math.PI / 180;
          v.seek(v.duration * p / phases);
          v.view({ position: [centre[0] + Math.sin(az) * Math.cos(el) * distance, centre[1] + Math.sin(el) * distance, centre[2] + Math.cos(az) * Math.cos(el) * distance], target: centre });
          return v.screenshot();
        }, { d, p, directions, phases, elevation: BAKE_ELEVATION_DEG, centre: fit.centre, distance: fit.distance });
        const image = decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        if (image.width !== render || image.height !== render) throw code(`The render for direction ${d}, phase ${p} is ${image.width} by ${image.height}, not ${render} by ${render}`, 'BAKE_RENDER_FAILED');
        const reduced = reduceCell(image.rgba, cell);
        if (touchesBorder(reduced, cell))
          throw code(`Cell for direction ${d} (dir-${d}, ${+(d * 360 / directions).toFixed(3)} degrees), phase ${p}, clip ${clip} has opaque pixels on its border, so the model reaches outside the frame fitted to its rest pose. Keep the clip inside the rest bounds, or raise --cell if it only grazes the border. Nothing was written.`, 'BAKE_CELL_CLIPPED');
        // The border check is on the model alone; the palette snap and the outline come after it.
        let finished = reduced;
        if (settings.palette) finished = snapToPalette(finished, settings.palette);
        if (settings.outlineColor) finished = outlineCell(finished, cell, settings.outlineColor);
        cells.push(finished);
      }
    } finally { await browser.close(); }
  } finally { await rm(work, { recursive: true, force: true }); }

  // Everything is in memory and every cell passed: pack the sheet and write.
  const spec: SheetSpec = { cell, directions, phases, clipDurationMs: Number((fit.durationSeconds * 1000).toFixed(3)) };
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  // The pivot comes from the same rounded numbers the manifest records, so it can be recomputed from the manifest alone.
  const pivot = settings.anchor ? feetPivot({ cell, elevationDeg: BAKE_ELEVATION_DEG, halfExtentM: round(fit.half), centreYM: round(fit.centre[1]), groundYM: round(fit.groundY) }) : undefined;
  const atlas = buildAtlas(spec, pivot);
  const width = phases * cell, height = directions * cell, sheet = Buffer.alloc(width * height * 4);
  cells.forEach((pixels, i) => {
    const row = Math.floor(i / phases), column = i % phases;
    for (let y = 0; y < cell; y++) pixels.copy(sheet, ((row * cell + y) * width + column * cell) * 4, y * cell * 4, (y + 1) * cell * 4);
  });
  const problems = checkAtlasContract(atlas, { sheet: { width, height }, expectedTags: Array.from({ length: directions }, (_, k) => `dir-${k}`) });
  if (problems.length) throw code(`The generated atlas breaks the atlas contract: ${problems.join('; ')}`, 'BAKE_ATLAS_INVALID');
  const png = encodePng(width, height, sheet), atlasText = serializeAtlas(atlas);
  const sheetSha256 = sha256(png), atlasSha256 = sha256(atlasText);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const manifest = buildManifest({
    model: { sha256: sha256(glb) }, clip: { name: clip, durationMs: spec.clipDurationMs }, directions, phases, cell,
    camera: { projection: 'orthographic', elevationDeg: BAKE_ELEVATION_DEG, padding: BAKE_PADDING, supersample: BAKE_SUPERSAMPLE, halfExtentM: round(fit.half), distanceM: round(fit.distance), centreM: fit.centre.map(round), ...(pivot ? { groundYM: round(fit.groundY) } : {}) },
    sheetSha256, atlasSha256, pluginVersion: version,
    ...(settings.look !== undefined ? { look: settings.look } : {}),
    ...(settings.bands !== undefined ? { bands: settings.bands } : {}),
    ...(settings.palette ? { palette: paletteManifest(settings.palette) } : {}),
    ...(settings.outline ? { outline: settings.outline } : {}),
    ...(pivot ? { anchor: { name: 'feet', x: pivot.x, y: pivot.y } } : {}),
  });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, OUTPUT_NAMES.sheet), png);
  await writeFile(join(output, OUTPUT_NAMES.atlas), atlasText);
  await writeFile(join(output, OUTPUT_NAMES.manifest), `${JSON.stringify(manifest, null, 1)}\n`);
  return { output, files: { ...OUTPUT_NAMES }, size: { w: width, h: height }, frames: atlas.frames.length, sheetSha256, atlasSha256 };
}
