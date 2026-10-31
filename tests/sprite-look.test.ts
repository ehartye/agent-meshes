/** @lane merge
 * @subject src/sprite-look.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserLaunchOptions } from '../src/browser.ts';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { decodePng } from '../src/png.ts';
import { viewerScript } from '../src/preview-html.ts';
import { BANDED_FLOOR, bandLevels, BANDS_DEFAULT, lookScript, parseBands, parseLook, type SpriteLook } from '../src/sprite-look.ts';

// The fixture is one box with one flat base colour and no texture, built from core operations and the Node exporter, so
// no binary is committed. The page is the bake's own mount (an orthographic viewer with no antialiasing, a transparent
// background, no floor and no autoplay) with the look script applied after mount.
const COLOUR: [number, number, number] = [0xc0, 0x50, 0x30];
const CELL = 32, STAGE = CELL * 8;
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage{width:${STAGE}px;height:${STAGE}px}</style>
<div id="stage"></div><script id="glb" type="text/plain">@GLB@</script><script src="mesh-viewer.js"></script>
<script>window.ready = MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: null, floor: false, projection: 'orthographic', autoplay: false, orbit: false, quality: { pixelRatio: 1, shadows: false, antialias: false } }).then(v => (window.viewer = v));</script></html>`;

let root: string, browser: Browser;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-look-'));
  let project = createProject('look-fixture');
  project = applyOperation(project, { op: 'add', part: { name: 'block', geometry: { type: 'box', size: [1, 1, 1] }, position: [0, 0.5, 0], color: '#c05030' } });
  const glb = Buffer.from(await exportGLB(project));
  await writeFile(join(root, 'mesh-viewer.js'), await viewerScript());
  await writeFile(join(root, 'harness-box.html'), page.replace('@GLB@', () => glb.toString('base64')));
  // A sphere in the same colour: its faces turn smoothly away from the light, which a box's three flat faces cannot show.
  const ball = applyOperation(createProject('look-ball'), { op: 'add', part: { name: 'ball', geometry: { type: 'sphere', size: [1, 1, 1] }, position: [0, 0.5, 0], color: '#c05030' } });
  const ballGlb = Buffer.from(await exportGLB(ball));
  await writeFile(join(root, 'harness-ball.html'), page.replace('@GLB@', () => ballGlb.toString('base64')));
  browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
}, 120_000);
afterAll(async () => { await browser?.close(); await rm(root, { recursive: true, force: true }); });

/** Mount the fixture, apply a look script (none for lit), view the box from `azimuth` degrees and return the full render and its 8x reduction to a cell. */
async function render(script: string | undefined, azimuth = 45, model: 'box' | 'ball' = 'box'): Promise<{ opaque: Map<string, number>; reduced: Map<string, number>; rgba: Buffer }> {
  const context = await browser.newContext({ offline: true, viewport: { width: STAGE, height: STAGE }, deviceScaleFactor: 1 });
  try {
    const tab: Page = await context.newPage();
    await tab.goto(pathToFileURL(join(root, `harness-${model}.html`)).href, { waitUntil: 'load' });
    await tab.evaluate(() => (window as unknown as { ready: Promise<unknown> }).ready);
    if (script) await tab.evaluate(script);
    const url = await tab.evaluate(az => {
      const v = (window as unknown as { viewer: { view(s: unknown): void; frame(p: number): void; screenshot(): string } }).viewer;
      const a = az * Math.PI / 180, el = 15 * Math.PI / 180, c = [0, 0.5, 0], d = 4;
      v.view({ position: [Math.sin(a) * Math.cos(el) * d, c[1] + Math.sin(el) * d, Math.cos(a) * Math.cos(el) * d], target: c });
      v.frame(1.25);
      return v.screenshot();
    }, azimuth);
    const image = decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    expect([image.width, image.height]).toEqual([STAGE, STAGE]);
    const opaque = new Map<string, number>(), reduced = new Map<string, number>();
    const tally = (map: Map<string, number>, from: number) => { const key = [...image.rgba.subarray(from, from + 3)].join(','); map.set(key, (map.get(key) ?? 0) + 1); };
    for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i + 3] === 255) tally(opaque, i);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) { const at = ((y * 8 + 4) * STAGE + x * 8 + 4) * 4; if (image.rgba[at + 3] === 255) tally(reduced, at); }
    return { opaque, reduced, rgba: Buffer.from(image.rgba) };
  } finally { await context.close(); }
}
const colours = (map: Map<string, number>) => [...map.keys()];
const authored = COLOUR.join(',');

describe('the look script and its bounds', () => {
  it('returns nothing for lit and one expression per other look, and the script text parses', () => {
    expect(lookScript('lit')).toBeUndefined();
    expect(lookScript('lit', 5)).toBeUndefined();
    for (const look of ['unlit', 'banded'] as SpriteLook[]) {
      const script = lookScript(look)!;
      expect(script).toContain('window.viewer');
      expect(() => new Function(`return ${script};`)).not.toThrow();
    }
    expect(lookScript('banded', 4)).not.toBe(lookScript('banded', 3));
    expect(lookScript('banded')).toBe(lookScript('banded', BANDS_DEFAULT));
  });

  it('accepts 2 to 8 bands as a number or a digit string and defaults to 3', () => {
    expect(parseBands(undefined)).toBe(3);
    for (let n = 2; n <= 8; n++) { expect(parseBands(n)).toBe(n); expect(parseBands(String(n))).toBe(n); }
  });

  it('raises CLI_ARGUMENT_ERROR for a bands value of 1 or 9, and for anything that is not an integer', () => {
    for (const bad of [1, 9, 0, -3, 2.5, Number.NaN, '1', '9', '3.5', 'many', '']) {
      expect(() => parseBands(bad), String(bad)).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: `--bands must be an integer from 2 to 8, got ${bad}` }));
      expect(() => lookScript('banded', bad), String(bad)).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR' }));
    }
  });

  it('checks the look name', () => {
    expect(parseLook(undefined)).toBe('lit');
    for (const look of ['lit', 'unlit', 'banded']) expect(parseLook(look)).toBe(look);
    expect(() => parseLook('toon')).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR' }));
    expect(() => lookScript('toon' as SpriteLook)).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR' }));
  });

  it('steps from the ambient floor to full brightness in equal steps', () => {
    expect(bandLevels(2)).toEqual([BANDED_FLOOR, 1]);
    const levels = bandLevels(5);
    expect(levels[0]).toBe(BANDED_FLOOR);
    expect(levels[4]).toBe(1);
    for (let i = 1; i < 5; i++) expect(levels[i] - levels[i - 1]).toBeCloseTo((1 - BANDED_FLOOR) / 4, 12);
  });
});

describe('the looks rendered in Chromium', () => {
  it('lit renders with room lighting and no script touches it: the single colour is not the authored colour', async () => {
    const lit = await render(lookScript('lit'));
    expect(lit.opaque.size).toBeGreaterThan(0);
    expect(colours(lit.opaque)).not.toContain(authored);
    // The untouched render is deterministic, so a second mount gives the same pixels.
    expect((await render(undefined)).rgba.equals(lit.rgba)).toBe(true);
  }, 120_000);

  it('unlit gives every opaque pixel exactly the authored colour, at full size and after the 8x reduction', async () => {
    const unlit = await render(lookScript('unlit'));
    expect(colours(unlit.opaque)).toEqual([authored]);
    expect(unlit.opaque.get(authored)!).toBeGreaterThan(3000);
    expect(colours(unlit.reduced)).toEqual([authored]);
    expect(unlit.reduced.get(authored)!).toBeGreaterThan(50);
  }, 120_000);

  it('unlit would fail with tone mapping left on', async () => {
    const script = lookScript('unlit')!;
    const mutant = script.replace('material.toneMapped = false;', 'material.toneMapped = true;');
    expect(mutant).not.toBe(script);
    const toneMapped = await render(mutant);
    expect(colours(toneMapped.opaque)).not.toEqual([authored]);
  }, 120_000);

  it('unlit also keeps the colour when seen from another side and with the lights it removed gone', async () => {
    for (const azimuth of [0, 135, 200]) expect(colours((await render(lookScript('unlit'), azimuth)).opaque), String(azimuth)).toEqual([authored]);
  }, 120_000);

  it('banded gives more than one and at most N distinct opaque colours, each a band level of the authored colour', async () => {
    for (const bands of [3, 4]) {
      const banded = await render(lookScript('banded', bands));
      const levels = bandLevels(bands);
      expect(banded.opaque.size, `bands ${bands}`).toBeGreaterThan(1);
      expect(banded.opaque.size, `bands ${bands}`).toBeLessThanOrEqual(bands);
      expect(banded.reduced.size, `bands ${bands}`).toBeGreaterThan(1);
      expect(banded.reduced.size, `bands ${bands}`).toBeLessThanOrEqual(bands);
      // Each colour is the authored colour at one band level (in linear light, then the sRGB output), so its channels keep the authored order.
      for (const key of colours(banded.opaque)) {
        const [r, g, b] = key.split(',').map(Number);
        expect(r, key).toBeGreaterThanOrEqual(g);
        expect(g, key).toBeGreaterThanOrEqual(b);
        expect(r, key).toBeLessThanOrEqual(COLOUR[0]);
      }
      expect(levels.length).toBe(bands);
    }
  }, 120_000);

  it('banded with 2 bands still separates the faces of the box into two colours at most', async () => {
    const banded = await render(lookScript('banded', 2), 20);
    expect(banded.opaque.size).toBeGreaterThan(1);
    expect(banded.opaque.size).toBeLessThanOrEqual(2);
  }, 120_000);

  it('banded gives a sphere at most N colours, and would fail with a smooth gradient, which gives it many more', async () => {
    const script = lookScript('banded', 3)!;
    const stepped = await render(script, 45, 'ball');
    expect(stepped.opaque.size).toBeGreaterThan(1);
    expect(stepped.opaque.size).toBeLessThanOrEqual(3);
    expect(stepped.reduced.size).toBeLessThanOrEqual(3);
    expect(colours((await render(lookScript('unlit'), 45, 'ball')).opaque)).toEqual([authored]);
    const smooth = script.replace('float band = min(floor(lightFacing * 3.0), 3.0 - 1.0);', 'float band = lightFacing * (3.0 - 1.0);');
    expect(smooth).not.toBe(script);
    expect((await render(smooth, 45, 'ball')).opaque.size).toBeGreaterThan(20);
  }, 120_000);

  it('banded keeps the key light fixed to the camera: a cube seen from 45 and from 135 degrees gives the same pixels', async () => {
    const script = lookScript('banded', 3);
    const a = await render(script, 45), b = await render(script, 135), c = await render(script, 225);
    expect(b.rgba.equals(a.rgba)).toBe(true);
    expect(c.rgba.equals(a.rgba)).toBe(true);
    // The darkest band (the floor) is lighter than black: the ambient floor stops a face turned from the light going black.
    const darkest = colours(a.opaque).map(key => key.split(',').map(Number)).reduce((min, rgb) => (rgb[0] < min[0] ? rgb : min));
    expect(darkest[0]).toBeGreaterThan(0);
  }, 120_000);

  it('banded puts the highlight on the left of the camera: the left face is the brightest band', async () => {
    const { rgba } = await render(lookScript('banded', 3), 45);
    // Seen from 45 degrees the box shows a left face and a right face; the key light is up and to the left.
    const at = (x: number, y: number) => rgba[(y * STAGE + x) * 4];
    const row = STAGE / 2;
    expect(at(STAGE / 2 - 40, row)).toBeGreaterThan(at(STAGE / 2 + 40, row));
  }, 120_000);
});
