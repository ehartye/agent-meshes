/** @lane merge
 * @subject scripts/blender-preview.py
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '../src/png.ts';
import { parsePreviewOptions, runPreview } from '../src/preview.ts';
import { blenderIt } from './helpers/blender.ts';
import { framingGlb, restRadius, unionRadius } from './helpers/preview-framing-glb.ts';

// Real-Blender checks of the preview fit over a clip, measured from the rendered PNGs. The `reach` clip slides an arm
// 2 m out along X and back; the fit used to be taken at one frame of the clip, so the arm left the cell in the middle
// of the clip. The checks: no cell is cropped, the figure is not framed smaller than the whole clip needs, and one
// camera serves every cell whatever the phase count.
const VIEWS = 'body-front,body-q34';
const SIZE = 512;
const MARGIN = 2;
let root: string, glb: string, runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-framing-'));
  glb = join(root, 'framing.glb');
  await writeFile(glb, await framingGlb());
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const rendered = new Map<string, Promise<string>>();
/** The preview output folder of one command, rendered once per test file (a fresh Blender run, no worker). */
function render(key: string, raw: Parameters<typeof parsePreviewOptions>[0]): Promise<string> {
  if (!rendered.has(key)) rendered.set(key, (async () => {
    const outDir = join(root, `out-${runs++}`);
    await runPreview(glb, parsePreviewOptions({ views: VIEWS, size: SIZE, ...raw }), { outDir, queue: join(root, 'no-worker'), useWorker: false });
    return outDir;
  })());
  return rendered.get(key)!;
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
const views = VIEWS.split(',');

blenderIt('fits one camera over the whole clip: no cell is cropped and the figure is not framed smaller than the clip needs', async () => {
  const clip = await render('reach8', { clip: 'reach', phases: 8 });
  const rest = await render('rest', {});
  for (const view of views) {
    const start = await cell(clip, 'reach-p0', view);
    const base = await cell(rest, 'rest', view);
    // The rest pose, and so the first cell, shows the same figure: with the arm out the camera backs off by the ratio of
    // the two fits' radii, so its fill must not fall further than 5 points below that (it did not just zoom out).
    const bound = base.fill * restRadius / unionRadius - 0.05;
    expect(start.fill, `${view}: the first cell fills ${start.fill.toFixed(3)} of the cell, the union fit gives about ${(bound + 0.05).toFixed(3)}`).toBeGreaterThanOrEqual(bound);
    let widest = 0;
    for (let phase = 0; phase < 8; phase++) {
      const box = await cell(clip, `reach-p${phase}`, view);
      expect(box.margin, `${view} phase ${phase} touches the cell border: the subject spans ${box.x0}..${box.x1} by ${box.y0}..${box.y1} of ${SIZE}`).toBeGreaterThanOrEqual(MARGIN);
      widest = Math.max(widest, box.width);
    }
    // A limb that left the cell altogether touches no border: the figure must also be wider with the arm out than at rest.
    const reach = await cell(clip, 'reach-p4', view);
    expect(reach.width, `${view}: the arm is missing from the middle of the clip`).toBeGreaterThan(start.width * 1.3);
    expect(widest).toBe(reach.width);
  }
}, 300000);

blenderIt('gives the cells of one pose the same image whatever the phase count', async () => {
  const four = await render('reach4', { clip: 'reach', phases: 4 });
  const eight = await render('reach8', { clip: 'reach', phases: 8 });
  for (const view of views) for (const phase of [0, 1, 2, 3]) {
    const a = await cell(four, `reach-p${phase}`, view), b = await cell(eight, `reach-p${phase * 2}`, view);
    expect(a.rgba.equals(b.rgba), `${view}: phase ${phase / 4} differs between --phases 4 and --phases 8`).toBe(true);
  }
}, 300000);

blenderIt('renders the rest render for a clip whose poses all equal the rest pose', async () => {
  const still = await render('still', { clip: 'still', phases: 4 });
  const rest = await render('rest', {});
  for (const view of views) {
    const base = await cell(rest, 'rest', view);
    for (let phase = 0; phase < 4; phase++) {
      const box = await cell(still, `still-p${phase}`, view);
      expect(box.rgba.equals(base.rgba), `${view}: phase ${phase} of a clip that never moves differs from the rest render`).toBe(true);
    }
  }
}, 300000);
