/** @lane merge
 * @subject scripts/blender-preview.py
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodePng } from '../src/png.ts';
import { parsePreviewOptions, renderBuiltAsset, runPreview } from '../src/preview.ts';
import { blender, blenderIt } from './helpers/blender.ts';
import { framingGlb, smallFigureGlb } from './helpers/preview-framing-glb.ts';

// Real-Blender checks of the preview fit, measured from the rendered PNGs and from the script's own radii. The fit counts
// what a render shows: the clip's frames (the `reach` clip slides an arm 2 m out along X and back, which used to leave the
// cell mid-clip because the fit looked at one frame) and not the unit bone-shape sphere the glTF importer leaves hidden
// at the origin (which made every rigged figure sit small). Pixels are compared decoded: PNG bytes carry a date and a
// render time. The "old" numbers below were measured on the script before this change, on Blender 5.2.2 at 512 px.
const BODY = 'body-front,body-q34';
const ALL = 'body-front,body-side,body-q34';
const SIZE = 512;
const MARGIN = 2;
const script = resolve('scripts/blender-preview.py');
let root: string, runs = 0;
const models: Record<'reach' | 'rigged' | 'static', string> = { reach: '', rigged: '', static: '' };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-framing-'));
  models.reach = join(root, 'reach.glb'); await writeFile(models.reach, await framingGlb());
  models.rigged = join(root, 'rigged.glb'); await writeFile(models.rigged, await smallFigureGlb(true));
  models.static = join(root, 'static.glb'); await writeFile(models.static, await smallFigureGlb(false));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const rendered = new Map<string, Promise<string>>();
/** The preview output folder of one command, rendered once per test file (a fresh Blender run, no worker). */
function render(key: string, model: keyof typeof models, raw: Parameters<typeof parsePreviewOptions>[0]): Promise<string> {
  if (!rendered.has(key)) rendered.set(key, (async () => {
    const outDir = join(root, `out-${runs++}`);
    await runPreview(models[model], parsePreviewOptions({ views: BODY, size: SIZE, ...raw }), { outDir, queue: join(root, 'no-worker'), useWorker: false });
    return outDir;
  })());
  return rendered.get(key)!;
}

interface Radii { all: number; rest: number; union: number | null; excluded: string[] }
const probed = new Map<string, Radii>();
/** The fit's body radii for a model, from blender-preview.py's own functions (see the probe's header). */
function radii(model: keyof typeof models, clip?: string): Radii {
  const key = `${model}/${clip ?? ''}`;
  if (!probed.has(key)) {
    const run = spawnSync(blender!.command, ['-b', '--python', resolve('tests/helpers/preview-framing-probe.py'), '--', script, models[model], ...(clip ? [clip] : [])], { encoding: 'utf8', timeout: 120000 });
    const line = run.stdout.split(/\r?\n/).find(text => text.startsWith('FRAMING '));
    if (!line) throw new Error(`The fit probe printed no radii: ${run.stdout.slice(-400)} ${run.stderr.slice(-400)}`);
    probed.set(key, JSON.parse(line.slice('FRAMING '.length)));
  }
  return probed.get(key)!;
}

interface Box { x0: number; y0: number; x1: number; y1: number; width: number; height: number; margin: number; fill: number }
/** The subject's bounding box: the pixels that differ from the background colour (the corner pixel, within 3 levels). */
async function subject(file: string): Promise<Box & { rgba: Buffer }> {
  const { width, height, rgba } = decodePng(await readFile(file));
  const away = (i: number) => [0, 1, 2].some(k => Math.abs(rgba[i + k]! - rgba[k]!) > 3) || rgba[i + 3] !== rgba[3];
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (away((y * width + x) * 4)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  expect(x1, `${file} shows no subject`).toBeGreaterThanOrEqual(0);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return { x0, y0, x1, y1, width: w, height: h, margin: Math.min(x0, y0, width - 1 - x1, height - 1 - y1), fill: Math.max(w, h) / width, rgba };
}
const cell = (dir: string, pose: string, view: string) => subject(join(dir, `${pose}-${view}-matcap.png`));

blenderIt('fits one camera over the whole clip: no cell is cropped and the figure is not framed smaller than the clip needs', async () => {
  const clip = await render('reach8', 'reach', { clip: 'reach', phases: 8 });
  const fit = radii('reach', 'reach');
  // On the previous script the rest render of this figure filled 0.629 (front) and 0.768 (q34) of the cell. The arm
  // out makes the fit larger, so the first cell, the same rest pose, may fill that much less by the ratio of the old
  // fit radius to the new one, minus 5 points: the camera must not just zoom out.
  const old: Record<string, number> = { 'body-front': 0.629, 'body-q34': 0.768 };
  for (const view of BODY.split(',')) {
    const start = await cell(clip, 'reach-p0', view);
    const bound = old[view]! * fit.all / (fit.union ?? fit.all) - 0.05;
    expect(start.fill, `${view}: the first cell fills ${start.fill.toFixed(3)} of the cell, the union fit gives about ${(bound + 0.05).toFixed(3)}`).toBeGreaterThanOrEqual(bound);
    for (let phase = 0; phase < 8; phase++) {
      const box = await cell(clip, `reach-p${phase}`, view);
      expect(box.margin, `${view} phase ${phase} touches the cell border: the subject spans ${box.x0}..${box.x1} by ${box.y0}..${box.y1} of ${SIZE}`).toBeGreaterThanOrEqual(MARGIN);
    }
    // A limb that left the cell altogether touches no border: the figure must also be wider with the arm out than at rest.
    expect((await cell(clip, 'reach-p4', view)).width, `${view}: the arm is missing from the middle of the clip`).toBeGreaterThan(start.width * 1.3);
  }
}, 300000);

// The small rigged figure on the previous script: its rest render's longest box side in pixels and the box's aspect ratio
// (width over height); the importer's sphere, larger than the figure, set the fit then.
const OLD_RIGGED: Record<string, { side: number; aspect: number }> = {
  'body-front': { side: 173, aspect: 173 / 160 }, 'body-side': { side: 160, aspect: 70 / 160 }, 'body-q34': { side: 163, aspect: 156 / 163 },
};
/** The rise the removed sphere explains, at the rest render of a rigged figure, and an unchanged shape. */
function expectTighter(box: Box, view: string, fit: Radii) {
  const old = OLD_RIGGED[view]!;
  const bound = old.side * fit.all / fit.rest - 0.05 * SIZE;
  expect(Math.max(box.width, box.height), `${view}: the figure spans ${Math.max(box.width, box.height)} px; without the sphere it should span about ${Math.round(bound + 0.05 * SIZE)}`).toBeGreaterThanOrEqual(bound);
  const aspect = box.width / box.height;
  expect(Math.abs(aspect / old.aspect - 1), `${view}: the figure's aspect ratio is ${aspect.toFixed(3)}, it was ${old.aspect.toFixed(3)}`).toBeLessThan(0.04);
}

/** The rigged figure's radii, after checking that the fit set the importer's sphere aside and nothing else. */
function riggedFit(): Radii {
  const fit = radii('rigged');
  expect(fit.excluded, 'the fit should ignore the bone-shape sphere and no other object').toEqual(['Icosphere']);
  expect(fit.all / fit.rest, 'the sphere should be what inflated the old fit').toBeGreaterThan(1.5);
  return fit;
}

blenderIt('frames a rigged figure tighter, without its unrendered bone-shape sphere, and keeps its shape', async () => {
  const fit = riggedFit();
  const dir = await render('rigged-rest', 'rigged', { views: ALL });
  for (const view of ALL.split(',')) expectTighter(await cell(dir, 'rest', view), view, fit);
}, 300000);

blenderIt('gives the build stills the same tighter framing as a rest preview', async () => {
  const stage = join(root, 'stage');
  await mkdir(stage);
  await copyFile(models.rigged, join(stage, 'model.glb'));
  expect((await renderBuiltAsset(stage, { queue: join(root, 'no-worker'), useWorker: false })).files).toEqual(['front.png', 'side.png', 'perspective.png']);
  const dir = await render('rigged-rest', 'rigged', { views: ALL });
  const fit = riggedFit();
  for (const [view, file] of [['body-front', 'front.png'], ['body-side', 'side.png'], ['body-q34', 'perspective.png']] as const) {
    const still = await subject(join(stage, file));
    expect(still.rgba.equals((await cell(dir, 'rest', view)).rgba), `${file} differs from the ${view} rest render`).toBe(true);
    expectTighter(still, view, fit);
  }
}, 300000);

blenderIt('leaves a GLB with no skin and no armature exactly as it was', async () => {
  const fit = radii('static');
  // Nothing in it is hidden from render, so the fit is the same as before the sphere was excluded.
  expect(fit.excluded).toEqual([]);
  expect(fit.rest).toBe(fit.all);
  // Its subject boxes on the previous script, to the pixel (a cross-branch check compared every decoded pixel).
  const old: Record<string, [number, number, number, number]> = { 'body-front': [83, 94, 428, 417], 'body-side': [190, 100, 325, 415], 'body-q34': [130, 95, 433, 416] };
  const dir = await render('static-rest', 'static', { views: ALL });
  for (const view of ALL.split(',')) {
    const box = await cell(dir, 'rest', view);
    expect([box.x0, box.y0, box.x1, box.y1], `${view}: the subject box moved`).toEqual(old[view]);
  }
}, 300000);

blenderIt('gives the cells of one pose the same image whatever the phase count', async () => {
  const four = await render('reach4', 'reach', { clip: 'reach', phases: 4 });
  const eight = await render('reach8', 'reach', { clip: 'reach', phases: 8 });
  for (const view of BODY.split(',')) for (const phase of [0, 1, 2, 3]) {
    const a = await cell(four, `reach-p${phase}`, view), b = await cell(eight, `reach-p${phase * 2}`, view);
    expect(a.rgba.equals(b.rgba), `${view}: phase ${phase / 4} differs between --phases 4 and --phases 8`).toBe(true);
  }
}, 300000);

blenderIt('renders the rest render for a clip whose poses all equal the rest pose', async () => {
  const still = await render('still', 'reach', { clip: 'still', phases: 4 });
  const rest = await render('rest', 'reach', {});
  for (const view of BODY.split(',')) {
    const base = await cell(rest, 'rest', view);
    for (let phase = 0; phase < 4; phase++) {
      const box = await cell(still, `still-p${phase}`, view);
      expect(box.rgba.equals(base.rgba), `${view}: phase ${phase} of a clip that never moves differs from the rest render`).toBe(true);
    }
  }
}, 300000);

blenderIt('draws the wire shading from what a render shows, not from the unrendered bone-shape sphere', async () => {
  riggedFit();
  const matcap = await cell(await render('rigged-rest', 'rigged', { views: ALL }), 'rest', 'body-front');
  const wire = await subject(join(await render('rigged-wire', 'rigged', { views: 'body-front', shading: 'wire' }), 'rest-body-front-wire.png'));
  // The wire copies sit on the figure's own surface, so their box is the matcap box to within a pixel or two. A wire copy
  // of the sphere (larger than the figure, and outside the fitted bounds) widens it to 0..470 by 93..511 at 512 px.
  for (const [name, got, want] of [['left', wire.x0, matcap.x0], ['top', wire.y0, matcap.y0], ['right', wire.x1, matcap.x1], ['bottom', wire.y1, matcap.y1]] as const) {
    expect(Math.abs(got - want), `the wire render's ${name} edge is at ${got}, the matcap render's at ${want}: something else is drawn`).toBeLessThanOrEqual(2);
  }
}, 300000);

// The static figure's rest renders (body front, then the head views front, q34 and side) as a 64 px contact sheet, made by
// the script as it was before the fit looked at rendered objects or at a clip (from the main branch at 0.42.0, Blender
// 5.2.2). Regenerate it by previewing small-static (smallFigureGlb(false)) with `--views body-front,front,q34,side --size 64
// --sheet` on that script. The tolerance is for a different GPU's anti-aliasing; a moved or resized camera is far outside it.
const REFERENCE_TOLERANCE = 2;

blenderIt('renders a GLB with no skin and no armature, body and head views, pixel for pixel as the previous script did', async () => {
  const dir = await render('static-sheet', 'static', { views: 'body-front,front,q34,side', size: 64, sheet: true });
  const got = decodePng(await readFile(join(dir, 'sheet.png')));
  const want = decodePng(await readFile(resolve('tests/fixtures/preview-framing/static-rest-sheet.png')));
  expect([got.width, got.height]).toEqual([want.width, want.height]);
  let worst = 0, first = -1;
  for (let i = 0; i < got.rgba.length; i++) {
    const difference = Math.abs(got.rgba[i]! - want.rgba[i]!);
    if (difference > worst) worst = difference;
    if (difference > REFERENCE_TOLERANCE && first < 0) first = i;
  }
  const at = Math.floor(first / 4);
  expect(first, `pixel (${at % got.width}, ${Math.floor(at / got.width)}) channel ${first % 4} differs from the previous script's render by up to ${worst} levels`).toBe(-1);
}, 300000);

blenderIt('counts an object as rendered unless it is hidden from render, in a collection hidden from render, or out of the view layer', async () => {
  const probe = join(root, 'rendered-probe.py');
  await writeFile(probe, [
    'import importlib.util, json, sys',
    'import bpy',
    "script = sys.argv[sys.argv.index('--') + 1]",
    "spec = importlib.util.spec_from_file_location('blender_preview', script)",
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'bpy.ops.wm.read_factory_settings(use_empty=True)',
    'scene = bpy.context.scene',
    'def thing(name, collection=None):',
    '    obj = bpy.data.objects.new(name, bpy.data.meshes.new(name))',
    '    (collection or scene.collection).objects.link(obj)',
    '    return obj',
    "shown = thing('shown')",
    "unrendered = thing('unrendered'); unrendered.hide_render = True",
    "viewport_off = thing('viewportOff'); viewport_off.hide_viewport = True",
    "eye_closed = thing('eyeClosed'); eye_closed.hide_set(True)",
    "quiet = bpy.data.collections.new('quiet'); scene.collection.children.link(quiet); quiet.hide_render = True",
    "in_quiet = thing('inQuietCollection', quiet)",
    "excluded = bpy.data.collections.new('excluded'); scene.collection.children.link(excluded)",
    "out_of_layer = thing('outOfLayer', excluded); bpy.context.view_layer.layer_collection.children['excluded'].exclude = True",
    'everything = [shown, unrendered, viewport_off, eye_closed, in_quiet, out_of_layer]',
    "print('RENDERED ' + json.dumps({'kept': [o.name for o in module.rendered_only(everything)], 'none': [o.name for o in module.rendered_only([unrendered, in_quiet])]}))",
  ].join('\n'));
  const run = spawnSync(blender!.command, ['-b', '--python', probe, '--', script], { encoding: 'utf8', timeout: 120000 });
  const line = run.stdout.split(/\r?\n/).find(text => text.startsWith('RENDERED '));
  if (!line) throw new Error(`The probe printed nothing: ${run.stdout.slice(-400)} ${run.stderr.slice(-400)}`);
  const result = JSON.parse(line.slice('RENDERED '.length)) as { kept: string[]; none: string[] };
  // Made through bpy.data and never synced to the view layer, an object still counts. Hidden only in the viewport, a
  // render still shows it. With nothing shown, all of them are kept rather than none.
  expect(result.kept).toEqual(['shown', 'viewportOff', 'eyeClosed']);
  expect(result.none).toEqual(['unrendered', 'inQuietCollection']);
}, 120000);
