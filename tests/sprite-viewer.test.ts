/** @lane merge
 * @subject src/sprite-viewer.ts
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserLaunchOptions } from '../src/browser.ts';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { decodePng } from '../src/png.ts';
import { buildAtlas, type Atlas, type SpriteManifest } from '../src/sprite-atlas.ts';
import { bakeSprites } from '../src/sprite-bake.ts';
import { composeViewer, jsonForScript } from '../src/sprite-viewer.ts';

// The fixture is a small rigged figure that differs left to right (a long arm on +X, a stub on -X) and front to back
// (a nose on +Z), so no two facings match; it is built from core operations and the Node exporter, so no Blender is needed
// and no binary is committed. It is baked once plain and once with the feet pivot, 8 facings of 4 phases each.
const DURATION = 1.2, KEYS = 12, PHASES = 4, DIRECTIONS = 8;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const sway: Clip = {
  name: 'sway', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'rotation', keys: times.map((time, i) => ({ time, value: aboutZ(i === KEYS ? 0 : 25 * Math.sin(2 * Math.PI * time / DURATION)) })) },
    { bone: 'root', property: 'position', keys: times.map((time, i) => ({ time, value: [0, i === KEYS ? 0 : 0.02 * Math.sin(2 * Math.PI * time / DURATION), 0] as [number, number, number] })) },
  ],
};
function fixtureProject(): Project {
  let project = createProject('viewer-fixture');
  const part = (name: string, size: [number, number, number], position: [number, number, number], bone: string) => {
    project = applyOperation(project, { op: 'add', part: { name, geometry: { type: 'box', size }, position } });
    project = applyOperation(project, { op: 'bind', name, binding: { type: 'rigid', bone } });
  };
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'shoulder', parent: 'root', position: [0.25, 0.7, 0] } });
  part('body', [0.5, 0.8, 0.3], [0, 0.4, 0], 'root');
  part('head', [0.3, 0.3, 0.3], [0, 0.95, 0], 'root');
  part('nose', [0.1, 0.1, 0.25], [0, 0.95, 0.2], 'root');
  part('stub', [0.1, 0.1, 0.1], [-0.3, 0.7, 0], 'root');
  part('arm', [0.6, 0.12, 0.12], [0.55, 0.7, 0], 'shoulder');
  return { ...project, clips: [sway] };
}

interface Bake { dir: string; atlas: Atlas; manifest: SpriteManifest; sheetSha256: string; sheet: Buffer; html: string; page: string }
let root: string, browser: Browser, plain: Bake, feet: Bake;

/** Bake the fixture, then write a page composed from that bake's own atlas and manifest beside a copy of its sheet. */
async function bake(name: string, extra: { anchor?: 'feet' }): Promise<Bake> {
  const dir = join(root, name);
  const result = await bakeSprites(join(root, 'figure.glb'), { clip: 'sway', out: dir, directions: DIRECTIONS, phases: PHASES, ...extra });
  const atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8')) as Atlas;
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as SpriteManifest;
  const html = composeViewer(atlas, manifest, 'sheet.png', result.sheetSha256);
  const page = join(root, `page-${name}`);
  await writeShown(page, html, join(dir, 'sheet.png'));
  return { dir, atlas, manifest, sheetSha256: result.sheetSha256, sheet: await readFile(join(dir, 'sheet.png')), html, page: join(page, 'viewer.html') };
}
async function writeShown(dir: string, html: string, sheet: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await copyFile(sheet, join(dir, 'sheet.png'));
  await writeFile(join(dir, 'viewer.html'), html);
  return join(dir, 'viewer.html');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-viewer-'));
  await writeFile(join(root, 'figure.glb'), Buffer.from(await exportGLB(fixtureProject())));
  plain = await bake('plain', {});
  feet = await bake('feet', { anchor: 'feet' });
  browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
}, 300_000);
afterAll(async () => { await browser?.close(); await rm(root, { recursive: true, force: true }); });

interface Opened { page: Page; context: BrowserContext; problems: string[]; requests: string[]; dialogs: string[] }
/** Open a page from file:// in an offline context; collects console errors, page errors, failed requests, every request URL and dialogs. */
async function open(file: string, options: { colorScheme?: 'dark' | 'light'; clock?: boolean; reducedMotion?: 'reduce' | 'no-preference'; viewport?: { width: number; height: number } } = {}): Promise<Opened> {
  const { clock, ...contextOptions } = options;
  const context = await browser.newContext({ offline: true, viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 1, ...contextOptions });
  // A fake clock makes the page's requestAnimationFrame and performance.now advance only on page.clock.runFor, so timing is exact.
  if (clock) { await context.clock.install({ time: 0 }); await context.clock.pauseAt(1000); }
  const page = await context.newPage();
  const problems: string[] = [], requests: string[] = [], dialogs: string[] = [];
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => problems.push(`requestfailed: ${request.url()}`));
  page.on('request', request => requests.push(request.url()));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.waitForFunction(() => { const c = document.querySelector('[data-role="sprite"]') as HTMLCanvasElement | null; return !!c && c.width > 0; });
  return { page, context, problems, requests, dialogs };
}
const role = (name: string) => `[data-role="${name}"]`;
const text = (page: Page, name: string) => page.locator(role(name)).first().textContent();
// A Step that ends playback writes the readout in a later task (setTimeout 0), so a read straight after the click can
// see the frame before the step. Timers of one delay run in the order they were queued: once this one has run, any
// readout write queued before the read has landed.
// Use steppedFrame for a read straight after such a click on a page with the real clock (a page with an installed
// clock never runs the timer).
const frameIndex = async (page: Page) => Number(await text(page, 'frame-index'));
const steppedFrame = async (page: Page) => {
  await page.evaluate(() => new Promise(done => setTimeout(done, 0)));
  return frameIndex(page);
};
const sizeOf = (page: Page, selector: string) => page.locator(selector).evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return [r.width, r.height]; }));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('the viewer plays a baked loop from file://', () => {
  it('opens clean and offline, lists 8 facings and All facings, and plays only the chosen facing', async () => {
    const { page, context, problems, requests } = await open(plain.page);
    try {
      expect(problems).toEqual([]);
      expect(requests.every(url => url.startsWith('file:') || url.startsWith('data:'))).toBe(true);
      const options = await page.locator(`${role('facing')} option`).evaluateAll(list => list.map(o => [(o as HTMLOptionElement).value, o.textContent]));
      expect(options).toHaveLength(DIRECTIONS + 1);
      expect(options[0][1]).toBe('All facings');
      expect(options.slice(1).map(o => o[0])).toEqual(Array.from({ length: DIRECTIONS }, (_, k) => `dir-${k}`));

      await page.selectOption(role('facing'), 'dir-3');
      const seen = new Set<number>();
      for (let i = 0; i < 24; i++) { seen.add(await frameIndex(page)); await page.waitForTimeout(50); }
      expect(seen.size).toBeGreaterThan(1);
      for (const index of seen) { expect(index).toBeGreaterThanOrEqual(0); expect(index).toBeLessThan(PHASES); }
      expect(await text(page, 'frame-count')).toBe(String(PHASES));
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('pauses, steps forward and back by exactly one with wrap, and holds a clicked strip frame', async () => {
    const { page, context } = await open(plain.page);
    try {
      await page.selectOption(role('facing'), 'dir-2');
      await page.click(role('play'));
      expect(await text(page, 'status')).toBe('paused');
      const held = await frameIndex(page);
      await page.waitForTimeout(600);
      expect(await frameIndex(page)).toBe(held);

      let expected = held;
      for (let i = 0; i < PHASES + 1; i++) { await page.click(role('step-forward')); expected = (expected + 1) % PHASES; expect(await frameIndex(page)).toBe(expected); }
      await page.click(role('strip-frame') + '[data-frame="0"]');
      expect(await frameIndex(page)).toBe(0);
      await page.click(role('step-back'));
      expect(await frameIndex(page)).toBe(PHASES - 1);
      await page.click(role('step-forward'));
      expect(await frameIndex(page)).toBe(0);

      await page.click(role('strip-frame') + '[data-frame="2"]');
      await page.waitForTimeout(500);
      expect(await frameIndex(page)).toBe(2);
      expect(await page.locator(`${role('strip-frame')}[aria-current="true"]`).getAttribute('data-frame')).toBe('2');

      await page.click(role('play'));
      expect(await text(page, 'status')).toBe('playing');
      const seen = new Set<number>();
      for (let i = 0; i < 24; i++) { seen.add(await frameIndex(page)); await page.waitForTimeout(50); }
      expect(seen.size).toBeGreaterThan(1);
    } finally { await context.close(); }
  }, 60_000);

  it('draws the cell of the chosen facing and frame, pixel for pixel at 1 times', async () => {
    const { page, context } = await open(plain.page);
    try {
      const cell = plain.manifest.cell, image = decodePng(plain.sheet);
      const cellOf = (direction: number, phase: number) => {
        const out = Buffer.alloc(cell * cell * 4);
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) Buffer.from(image.rgba.subarray(((direction * cell + y) * image.width + phase * cell + x) * 4, ((direction * cell + y) * image.width + phase * cell + x) * 4 + 4)).copy(out, (y * cell + x) * 4);
        return out;
      };
      await page.selectOption(role('scale'), '1');
      for (const [direction, phase] of [[3, 2], [6, 1]]) {
        await page.selectOption(role('facing'), `dir-${direction}`);
        await page.click(role('strip-frame') + `[data-frame="${phase}"]`);
        await page.waitForFunction(c => (document.querySelector('[data-role="sprite"]') as HTMLCanvasElement).width === c, cell);
        // A canvas that drew a file:// image is tainted and cannot be read back, so the cell is read from a screenshot of it.
        const readDrawn = async () => {
          const shot = (await page.locator(role('sprite')).screenshot()).toString('base64');
          const rgb = await page.evaluate(b64 => new Promise<number[]>((done, fail) => {
            const image = new Image();
            image.onload = () => { const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const x = c.getContext('2d')!; x.drawImage(image, 0, 0); done([image.width, image.height, ...x.getImageData(0, 0, image.width, image.height).data]); };
            image.onerror = () => fail(new Error('screenshot did not decode'));
            image.src = `data:image/png;base64,${b64}`;
          }), shot);
          return { width: rgb[0], height: rgb[1], rgba: rgb.slice(2) };
        };
        const expected = cellOf(direction, phase);
        // The sheet loads after the first paint, so wait until the opaque pixels of the expected cell are on the canvas.
        const opaqueMatches = async () => {
          const got = await readDrawn();
          let wrong = 0;
          for (let i = 0; i < expected.length; i += 4) if (expected[i + 3] === 255 && (got.rgba[i] !== expected[i] || got.rgba[i + 1] !== expected[i + 1] || got.rgba[i + 2] !== expected[i + 2])) wrong++;
          return wrong;
        };
        await expect.poll(opaqueMatches, { timeout: 10_000 }).toBe(0);
        const drawn = await readDrawn();
        expect([drawn.width, drawn.height]).toEqual([cell, cell]);
        const stage = await page.locator(role('sprite-box')).evaluate(e => getComputedStyle(e).backgroundColor);
        expect(stage).toBe('rgb(230, 226, 210)');
        let opaque = 0;
        for (let i = 0; i < expected.length; i += 4) {
          const want = expected[i + 3] === 255 ? [...expected.subarray(i, i + 3)] : [230, 226, 210];
          if (expected[i + 3] === 255) opaque++;
          expect(drawn.rgba.slice(i, i + 3), `pixel ${i / 4}`).toEqual(want);
        }
        expect(opaque).toBeGreaterThan(50);
        // The fixture differs between facings, so a page that drew another row would fail the comparison above.
        expect(cellOf(direction, phase).equals(cellOf((direction + 1) % DIRECTIONS, phase))).toBe(false);
      }
    } finally { await context.close(); }
  }, 60_000);

  it('sets the drawn size to the chosen multiple of the cell size, and holds one strip entry per phase and a four-frame seam', async () => {
    const { page, context } = await open(plain.page);
    try {
      const cell = plain.manifest.cell;
      await page.selectOption(role('facing'), 'dir-1');
      for (const scale of [1, 2, 4, 8]) {
        await page.selectOption(role('scale'), String(scale));
        await page.waitForFunction(([c, s]) => (document.querySelector('[data-role="sprite"]') as HTMLCanvasElement).style.width === `${c * s}px`, [cell, scale]);
        expect(await sizeOf(page, role('sprite'))).toEqual([[cell * scale, cell * scale]]);
        expect(await page.locator(role('sprite')).evaluate((e: HTMLElement) => [e.style.width, e.style.height])).toEqual([`${cell * scale}px`, `${cell * scale}px`]);
        // The sprite sits on a whole CSS pixel, so at this device pixel ratio of 1 the browser does not resample it (a fractional ratio would).
        const at = await page.locator(role('sprite')).evaluate(e => { const r = e.getBoundingClientRect(); return [r.left, r.top]; });
        expect(at.map(Number.isInteger)).toEqual([true, true]);
        // The strips are drawn at the chosen scale too, with no cap.
        expect(await sizeOf(page, role('strip-frame') + ' canvas')).toEqual(Array.from({ length: PHASES }, () => [cell * scale, cell * scale]));
      }
      expect(await page.locator(role('strip-frame')).evaluateAll(list => list.map(e => e.getAttribute('data-frame')))).toEqual(['0', '1', '2', '3']);
      expect(await page.locator(role('seam-frame')).evaluateAll(list => list.map(e => e.getAttribute('data-frame')))).toEqual([String(PHASES - 2), String(PHASES - 1), '0', '1']);
      expect(await page.locator(role('strips')).evaluate(e => e.hasAttribute('hidden'))).toBe(false);
      expect(await page.locator(role('pivot')).count()).toBe(0);
      expect(await page.locator(role('pivot-toggle')).count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);

  it('draws all 8 facings at the chosen scale, 8 times included, and hides the strips', async () => {
    const { page, context } = await open(plain.page);
    try {
      const cell = plain.manifest.cell;
      await page.selectOption(role('facing'), 'all');
      for (const scale of [1, 2, 4, 8]) {
        await page.selectOption(role('scale'), String(scale));
        await page.waitForFunction(([c, s]) => { const t = document.querySelectorAll('[data-role="facing-tile"]'); return t.length > 0 && [...t].every(e => (e as HTMLElement).style.width === `${c * s}px`); }, [cell, scale]);
        expect(await sizeOf(page, role('facing-tile'))).toEqual(Array.from({ length: DIRECTIONS }, () => [cell * scale, cell * scale]));
      }
      expect(await page.locator(role('strips')).evaluate(e => e.hasAttribute('hidden'))).toBe(true);
      expect(await page.locator(role('strips')).isVisible()).toBe(false);
      expect(await page.locator(role('sprite')).isVisible()).toBe(false);
      expect(await page.locator(role('all-note')).isVisible()).toBe(true);
      // Back to one facing shows the strips again.
      await page.selectOption(role('facing'), 'dir-0');
      expect(await page.locator(role('strips')).isVisible()).toBe(true);
      expect(await page.locator(role('facing-tile')).count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);

  it('follows the facing when the pivot slice has a key for each direction', async () => {
    // The plain bake's sheet under an atlas whose pivot moves one pixel right with every direction, as --anchor origin writes it.
    const { cell, directions, phases } = plain.manifest;
    const pivots = Array.from({ length: directions }, (_, k) => ({ x: 10 + k, y: 20 }));
    const atlas = buildAtlas({ cell, directions, phases, clipDurationMs: plain.manifest.clip.durationMs }, pivots);
    const shown = await writeShown(join(root, 'page-turning'), composeViewer(atlas, plain.manifest, 'sheet.png', plain.sheetSha256), join(plain.dir, 'sheet.png'));
    const { page, context } = await open(shown);
    try {
      for (const k of [0, 5, 7]) {
        await page.selectOption(role('facing'), `dir-${k}`);
        await page.waitForFunction(x => document.querySelector('[data-role="pivot"]')?.getAttribute('data-x') === String(x), 10 + k);
        expect(await page.locator(role('pivot')).getAttribute('data-y')).toBe('20');
      }
    } finally { await context.close(); }
  }, 60_000);

  it('draws the pivot at the one slice cell pixel on every frame of every facing, and offers the control only with the slice', async () => {
    const { page, context } = await open(feet.page);
    try {
      const { x, y } = feet.manifest.anchor!, cell = feet.manifest.cell;
      expect(feet.atlas.meta.slices).toHaveLength(1);
      expect(feet.atlas.meta.slices![0].keys[0].pivot).toEqual({ x, y });
      expect(await page.locator(role('pivot-toggle')).isChecked()).toBe(true);
      for (const scale of [1, 4]) {
        await page.selectOption(role('scale'), String(scale));
        for (const facing of ['dir-0', 'dir-5']) {
          await page.selectOption(role('facing'), facing);
          if (await text(page, 'status') === 'playing') await page.click(role('play'));
          await page.click(role('strip-frame') + '[data-frame="0"]');
          for (let step = 0; step < PHASES; step++) {
            expect(await frameIndex(page)).toBe(step);
            await page.waitForFunction(([c, s]) => (document.querySelector('[data-role="sprite"]') as HTMLCanvasElement).style.width === `${c * s}px`, [cell, scale]);
            const where = await page.evaluate(() => {
              const marks = document.querySelectorAll('[data-role="pivot"]');
              const sprite = document.querySelector('[data-role="sprite"]')!.getBoundingClientRect();
              const r = marks.length === 1 ? marks[0].getBoundingClientRect() : undefined;
              return { count: marks.length, left: r ? r.left - sprite.left : -1, top: r ? r.top - sprite.top : -1, width: r?.width, height: r?.height };
            });
            expect(where, `${facing} frame ${step} at ${scale}x`).toEqual({ count: 1, left: x * scale, top: y * scale, width: scale, height: scale });
            await page.click(role('step-forward'));
          }
        }
      }
      // The toggle removes the overlay and brings it back.
      await page.uncheck(role('pivot-toggle'));
      expect(await page.locator(role('pivot')).count()).toBe(0);
      await page.check(role('pivot-toggle'));
      expect(await page.locator(role('pivot')).count()).toBe(1);
      // All facings draws the pivot into every tile instead of one overlay.
      await page.selectOption(role('facing'), 'all');
      expect(await page.locator(role('pivot')).count()).toBe(0);
    } finally { await context.close(); }
  }, 120_000);

  it('uses 150 ms for a frame with no duration', async () => {
    const stripped = structuredClone(plain.atlas);
    stripped.frames.forEach((frame, i) => { if (i % 2) delete (frame as Partial<typeof frame>).duration; else frame.duration = 0; });
    const file = await writeShown(join(root, 'page-nodur'), composeViewer(stripped, plain.manifest, 'sheet.png', plain.sheetSha256), join(plain.dir, 'sheet.png'));
    const { page, context } = await open(file);
    try {
      await page.click(role('play'));
      for (let phase = 0; phase < PHASES; phase++) { await page.click(role('strip-frame') + `[data-frame="${phase}"]`); expect(await text(page, 'frame-ms')).toBe('150'); }
    } finally { await context.close(); }
  }, 60_000);
});

/** A page composed from an edited copy of the plain bake's atlas, beside that bake's sheet. */
async function pageFor(name: string, edit: (atlas: Atlas, manifest: SpriteManifest) => void): Promise<string> {
  const atlas = structuredClone(plain.atlas), manifest = structuredClone(plain.manifest);
  edit(atlas, manifest);
  return writeShown(join(root, `page-${name}`), composeViewer(atlas, manifest, 'sheet.png', plain.sheetSha256), join(plain.dir, 'sheet.png'));
}
/** Focus nothing, so a key goes to the document. */
const release = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-role') ?? document.activeElement?.tagName ?? '');
const status = (page: Page) => text(page, 'status');

describe('the viewer answers the keyboard', () => {
  it('toggles play on Space from the document, from a stepped or held button and from the play button itself, once each', async () => {
    const { page, context, problems } = await open(plain.page);
    try {
      await release(page);
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('paused');
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');

      // After a click on Step the button keeps focus; Space must still toggle play and not click Step again.
      await page.click(role('step-forward'));
      expect(await focused(page)).toBe('step-forward');
      expect(await status(page)).toBe('paused');
      const stepped = await steppedFrame(page);
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('paused');
      expect(stepped).toBeLessThan(PHASES);

      // The same after a click on a frame of the strip, and on Step back; a paused press must not step the frame.
      await page.click(role('strip-frame') + '[data-frame="2"]');
      expect(await focused(page)).toBe('strip-frame');
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');
      await page.click(role('step-back'));
      expect(await focused(page)).toBe('step-back');
      expect(await status(page)).toBe('paused');
      const held = await steppedFrame(page);
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('paused');
      expect(await frameIndex(page)).toBe(held);

      // On the play button the browser clicks it itself: one toggle for one press, not two.
      await page.focus(role('play'));
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('paused');
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('steps one frame on the arrow keys with wrap, pauses when it steps, and leaves a modified arrow alone', async () => {
    const { page, context } = await open(plain.page);
    try {
      await page.selectOption(role('facing'), 'dir-4');
      await page.click(role('strip-frame') + '[data-frame="0"]');
      await release(page);
      await page.keyboard.press('ArrowLeft');
      expect(await frameIndex(page)).toBe(PHASES - 1);
      await page.keyboard.press('ArrowRight');
      expect(await frameIndex(page)).toBe(0);
      for (let i = 1; i <= PHASES + 1; i++) { await page.keyboard.press('ArrowRight'); expect(await frameIndex(page)).toBe(i % PHASES); }
      const at = await frameIndex(page);
      await page.keyboard.press('Control+ArrowRight');
      await page.keyboard.press('Alt+ArrowLeft');
      expect(await frameIndex(page)).toBe(at);
      expect(await status(page)).toBe('paused');

      // An arrow key while playing pauses on the next frame.
      await page.keyboard.press('Space');
      expect(await status(page)).toBe('playing');
      await page.keyboard.press('ArrowRight');
      expect(await status(page)).toBe('paused');
    } finally { await context.close(); }
  }, 60_000);

  it('picks a facing on the digits 1 to 8 and ignores 0, 9, a modified digit and a digit typed into the facing list', async () => {
    const { page, context } = await open(plain.page);
    try {
      await release(page);
      const scale = await page.locator(role('scale')).inputValue();
      for (let digit = 1; digit <= DIRECTIONS; digit++) {
        await page.keyboard.press(String(digit));
        expect(await page.locator(role('facing')).inputValue()).toBe(`dir-${digit - 1}`);
        expect(await text(page, 'facing-label')).toContain(`dir-${digit - 1} (`);
      }
      for (const key of ['0', '9', 'Control+2']) { await page.keyboard.press(key); expect(await page.locator(role('facing')).inputValue()).toBe(`dir-${DIRECTIONS - 1}`); }
      await page.focus(role('facing'));
      await page.keyboard.press('2');
      expect(await page.locator(role('facing')).inputValue()).toBe(`dir-${DIRECTIONS - 1}`);
      // The digits pick a facing; the page has no scale key, and the scale list is its own control.
      expect(await page.locator(role('scale')).inputValue()).toBe(scale);
    } finally { await context.close(); }
  }, 60_000);
});

describe('the speed and backdrop controls', () => {
  it('plays at the chosen speed: the clip time is the speed times the clock', async () => {
    expect(plain.atlas.frames.every(frame => frame.duration === 300)).toBe(true);
    // [speed, milliseconds on the clock, frame], each at least one animation frame from an edge of a 300 ms frame.
    for (const [speed, ms, frame] of [[0.25, 1000, 0], [0.5, 1000, 1], [1, 1000, 3], [2, 350, 2], [1, 350, 1]]) {
      const { page, context } = await open(plain.page, { clock: true });
      try {
        await page.selectOption(role('speed'), String(speed));
        await page.clock.runFor(ms);
        expect(await frameIndex(page), `${speed}x after ${ms} ms`).toBe(frame);
      } finally { await context.close(); }
    }
  }, 120_000);

  it('paints the stage behind the sprite, the strip and the tiles in the chosen backdrop', async () => {
    const { page, context } = await open(plain.page);
    try {
      const stage = () => page.locator(role('sprite-box')).evaluate(e => { const s = getComputedStyle(e); return [s.backgroundColor, s.backgroundImage]; });
      expect((await stage())[0]).toBe('rgb(230, 226, 210)');
      expect(await page.locator('body').getAttribute('data-backdrop')).toBe('neutral');
      for (const [value, color] of [['green', 'rgb(123, 191, 106)'], ['grey', 'rgb(201, 201, 201)'], ['dark', 'rgb(16, 16, 16)']]) {
        await page.selectOption(role('backdrop'), value);
        expect(await page.locator('body').getAttribute('data-backdrop')).toBe(value);
        expect((await stage())[0]).toBe(color);
      }
      await page.selectOption(role('backdrop'), 'checker');
      expect((await stage())[1]).toContain('conic-gradient');
      await page.selectOption(role('backdrop'), 'neutral');
      expect((await stage())[0]).toBe('rgb(230, 226, 210)');
      await page.selectOption(role('backdrop'), 'dark');
      expect(await page.locator(`${role('strip-frame')} .cellbox`).evaluateAll(list => list.map(e => getComputedStyle(e).backgroundColor))).toEqual(Array.from({ length: PHASES }, () => 'rgb(16, 16, 16)'));
      await page.selectOption(role('facing'), 'all');
      expect(await page.locator(`${role('facing-tile')}`).evaluateAll(list => list.map(e => getComputedStyle(e.parentElement!).backgroundColor))).toEqual(Array.from({ length: DIRECTIONS }, () => 'rgb(16, 16, 16)'));
    } finally { await context.close(); }
  }, 60_000);
});

describe('the viewer takes an atlas of any shape', () => {
  const noMath = async (page: Page) => expect(await page.locator('body').innerText()).not.toMatch(/NaN|Infinity|undefined/);

  it('plays an atlas with 1 phase on the one frame, steps and holds it, and shows a seam of that frame', async () => {
    const file = await pageFor('one-phase', (atlas, manifest) => {
      atlas.frames = atlas.frames.filter((_, i) => i % PHASES === 0);
      atlas.meta.frameTags = atlas.frames.map((_, k) => ({ name: `dir-${k}`, from: k, to: k, direction: 'forward' as const }));
      manifest.phases = 1;
    });
    const { page, context, problems } = await open(file, { clock: true });
    try {
      await page.clock.runFor(2000);
      expect(await frameIndex(page)).toBe(0);
      expect(await text(page, 'frame-count')).toBe('1');
      expect(await page.locator(role('strip-frame')).count()).toBe(1);
      expect(await page.locator(role('seam-frame')).evaluateAll(list => list.map(e => e.getAttribute('data-frame')))).toEqual(['0', '0', '0', '0']);
      for (const control of ['step-forward', 'step-back']) { await page.click(role(control)); expect(await frameIndex(page)).toBe(0); }
      await release(page);
      await page.keyboard.press('ArrowRight');
      expect(await frameIndex(page)).toBe(0);
      await page.click(role('strip-frame'));
      await page.click(role('play'));
      await page.clock.runFor(1000);
      expect(await frameIndex(page)).toBe(0);
      expect(await text(page, 'frame-ms')).toBe('300');
      await page.selectOption(role('facing'), 'all');
      await page.clock.runFor(500);
      expect(await page.locator(role('facing-tile')).count()).toBe(DIRECTIONS);
      await noMath(page);
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('plays an atlas with 1 direction, offers it and All facings, and ignores the digits beyond it', async () => {
    const file = await pageFor('one-direction', (atlas, manifest) => {
      atlas.frames = atlas.frames.slice(0, PHASES);
      atlas.meta.frameTags = [{ name: 'dir-0', from: 0, to: PHASES - 1, direction: 'forward' }];
      manifest.directions = 1;
    });
    const { page, context, problems } = await open(file, { clock: true });
    try {
      const options = await page.locator(`${role('facing')} option`).evaluateAll(list => list.map(o => (o as HTMLOptionElement).value));
      expect(options).toEqual(['all', 'dir-0']);
      expect(await text(page, 'facing-label')).toBe('dir-0 (0 deg)');
      expect(await text(page, 'meta')).toContain('1 facing /');
      await release(page);
      for (const key of ['2', '8', '1']) { await page.keyboard.press(key); expect(await page.locator(role('facing')).inputValue()).toBe('dir-0'); }
      await page.clock.runFor(700);
      expect(await frameIndex(page)).toBe(2);
      expect(await text(page, 'frame-count')).toBe(String(PHASES));
      await page.selectOption(role('facing'), 'all');
      await page.clock.runFor(100);
      expect(await page.locator(role('facing-tile')).count()).toBe(1);
      await noMath(page);
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('plays an atlas with no frameTags as one facing over every frame', async () => {
    const file = await pageFor('no-tags', atlas => { delete (atlas.meta as Partial<typeof atlas.meta>).frameTags; });
    const { page, context, problems } = await open(file, { clock: true });
    try {
      const total = plain.atlas.frames.length;
      const options = await page.locator(`${role('facing')} option`).evaluateAll(list => list.map(o => (o as HTMLOptionElement).value));
      expect(options).toEqual(['all', 'dir-0']);
      expect(await text(page, 'frame-count')).toBe(String(total));
      expect(await page.locator(role('strip-frame')).count()).toBe(total);
      await page.clock.runFor(1000);
      expect(await frameIndex(page)).toBe(3);
      await page.click(role('strip-frame') + '[data-frame="0"]');
      await page.click(role('step-back'));
      expect(await frameIndex(page)).toBe(total - 1);
      await page.selectOption(role('facing'), 'all');
      await page.clock.runFor(100);
      expect(await page.locator(role('facing-tile')).count()).toBe(1);
      await noMath(page);
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('advances a frame with no duration after 150 ms, not before', async () => {
    const file = await pageFor('fallback-timing', atlas => { for (const frame of atlas.frames) delete (frame as Partial<typeof frame>).duration; });
    const { page, context } = await open(file, { clock: true });
    try {
      // [milliseconds to run, frame]: the loop is 4 x 150 ms, every checkpoint at least 20 ms from a frame edge.
      let total = 0;
      for (const [ms, frame] of [[130, 0], [40, 1], [110, 1], [40, 2], [120, 2], [30, 3], [120, 3], [40, 0]]) {
        await page.clock.runFor(ms);
        total += ms;
        expect(await frameIndex(page), `${total} ms into the loop`).toBe(frame);
      }
    } finally { await context.close(); }
  }, 60_000);
});

describe('the viewer reads out the frame without reading out the playback', () => {
  it('turns the frame readout into a polite live region only while paused, and labels the drawing surface', async () => {
    const { page, context } = await open(plain.page);
    try {
      const live = () => page.locator(role('counter')).getAttribute('aria-live');
      expect(await live()).toBe('off');
      await page.click(role('play'));
      expect(await live()).toBe('polite');
      await page.click(role('step-forward'));
      expect(await live()).toBe('polite');
      await page.click(role('play'));
      expect(await live()).toBe('off');
      expect(await page.locator(role('sprite')).getAttribute('aria-label')).toMatch(/sprite/i);
      expect(await page.locator(role('sprite')).getAttribute('role')).toBe('img');
    } finally { await context.close(); }
  }, 60_000);
});

describe('the clip name cannot break out of the page', () => {
  const HOSTILE = '</script><img src=x onerror=alert(1)>';
  const withName = (name: string): SpriteManifest => ({ ...plain.manifest, clip: { ...plain.manifest.clip, name } });
  const dataOf = (html: string) => html.split('<script type="application/json" id="viewer-data">')[1].split('</script>')[0];

  it('keeps the page whole, raises no dialog, shows the name as text and leaves no raw < in the embedded JSON', async () => {
    const hostile = composeViewer(plain.atlas, withName(HOSTILE), 'sheet.png', plain.sheetSha256);
    const calm = composeViewer(plain.atlas, withName('walk'), 'sheet.png', plain.sheetSha256);
    expect(dataOf(hostile)).not.toContain('<');
    expect(JSON.parse(dataOf(hostile)).manifest.clip.name).toBe(HOSTILE);
    expect(hostile.split('</script').length).toBe(calm.split('</script').length);

    const open2 = async (html: string, name: string) => open(await writeShown(join(root, `page-${name}`), html, join(plain.dir, 'sheet.png')));
    const a = await open2(calm, 'calm'), b = await open2(hostile, 'hostile');
    try {
      expect(await b.page.locator('script').count()).toBe(await a.page.locator('script').count());
      expect(await b.page.locator('img').count()).toBe(0);
      expect(await text(b.page, 'clip-name')).toBe(HOSTILE);
      expect(await b.page.title()).toContain(HOSTILE);
      await b.page.waitForTimeout(300);
      expect(b.dialogs).toEqual([]);
      expect(b.problems).toEqual([]);
    } finally { await a.context.close(); await b.context.close(); }
  }, 60_000);

  it('escapes <, >, &, U+2028 and U+2029 in anything embedded, and writes the value back unchanged', () => {
    const nasty = 'a<b>c&d\u2028e\u2029f';
    const json = jsonForScript({ nasty });
    for (const raw of ['<', '>', '&', '\u2028', '\u2029']) expect(json).not.toContain(raw);
    expect(JSON.parse(json).nasty).toBe(nasty);
    const html = composeViewer(plain.atlas, withName(nasty), 'sheet.png', plain.sheetSha256);
    for (const raw of ['<', '>', '&', '\u2028', '\u2029']) expect(dataOf(html)).not.toContain(raw);
  });

  it('refuses a malformed digest, a sheet name with a path, and an atlas without frames', () => {
    expect(() => composeViewer(plain.atlas, plain.manifest, 'sheet.png', 'abc')).toThrow(/64 lowercase hex/);
    for (const name of ['', '../sheet.png', 'a/b.png', 'c:sheet.png', 'a\\b.png']) expect(() => composeViewer(plain.atlas, plain.manifest, name, plain.sheetSha256)).toThrow(/bare file name/);
    expect(() => composeViewer({ ...plain.atlas, frames: [] }, plain.manifest, 'sheet.png', plain.sheetSha256)).toThrow(/no frames/);
  });
});

describe('the viewer carries the agent meshes brand and nothing from outside', () => {
  it('shows the wordmark, one inline mark, the tokens, a dark override and the footer with the first 12 hex of the sheet digest', async () => {
    const html = plain.html;
    expect(sha(plain.sheet)).toBe(plain.sheetSha256);
    expect(plain.manifest.sheet.sha256).toBe(plain.sheetSha256);
    const root1 = html.match(/:root\{([^}]*)\}/)![1];
    for (const token of ['--paper:#f5f2e8', '--ink:#202b2a', '--cobalt:#2e4be8', '--leaf:#d8e7a1', '--muted:#65706b', '--line:#d1d3c8']) expect(root1).toContain(token);
    expect(root1).toContain("'Pixelify Sans',ui-monospace,Consolas,monospace");
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html.match(/<svg/g)).toHaveLength(1);

    const { page, context } = await open(plain.page);
    try {
      expect(await page.locator('svg').count()).toBe(1);
      expect(await page.locator('body').innerText()).toContain('agent meshes');
      expect(await page.locator('footer').innerText()).toContain('Made with agent meshes');
      const shown = await text(page, 'footer-sha');
      expect(shown).toBe(plain.sheetSha256.slice(0, 12));
      expect(shown).toMatch(/^[0-9a-f]{12}$/);
      expect(await page.locator('body').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(245, 242, 232)');
      const square = await page.locator(role('status-dot')).evaluate(e => { const r = e.getBoundingClientRect(); return [r.width, r.height, getComputedStyle(e).borderRadius]; });
      expect(square).toEqual([9, 9, '0px']);
    } finally { await context.close(); }
    const dark = await open(plain.page, { colorScheme: 'dark' });
    try { expect(await dark.page.locator('body').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(22, 28, 27)'); } finally { await dark.context.close(); }
  }, 60_000);

  it('holds no address, style import, font file, url(), namespace, eval, inline handler, innerHTML or working-directory path', () => {
    for (const html of [plain.html, feet.html]) {
      const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
      expect(html).not.toMatch(/http/i);
      expect(html).not.toContain('@import');
      expect(html).not.toContain('@font-face');
      expect(html).not.toMatch(/url\((?!\s*['"]?data:)/);
      expect(html).not.toContain('xmlns');
      expect(html).not.toMatch(/\beval\b|new Function|innerHTML|insertAdjacentHTML|document\.write/);
      expect(markup).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
      for (const path of [process.cwd(), root, process.cwd().replaceAll('\\', '/')]) expect(html).not.toContain(path);
    }
  });
});

describe('the viewer is deterministic', () => {
  it('gives identical bytes for the same inputs, and different bytes for a different sheet digest', () => {
    const again = composeViewer(structuredClone(plain.atlas), structuredClone(plain.manifest), 'sheet.png', plain.sheetSha256);
    expect(again).toBe(plain.html);
    expect(composeViewer(plain.atlas, plain.manifest, 'sheet.png', plain.sheetSha256)).toBe(composeViewer(plain.atlas, plain.manifest, 'sheet.png', plain.sheetSha256));
    expect(composeViewer(plain.atlas, plain.manifest, 'sheet.png', 'f'.repeat(64))).not.toBe(plain.html);
    expect(feet.html).not.toBe(plain.html);
  });
});

describe('the viewer starts still when the system asks for reduced motion', () => {
  const live = (page: Page) => page.locator(role('counter')).getAttribute('aria-live');
  const dot = (page: Page) => page.locator(role('status-dot')).getAttribute('data-state');

  it('opens paused on frame 0 with a polite readout, holds still for a second, and plays when asked', async () => {
    const { page, context, problems } = await open(plain.page, { reducedMotion: 'reduce' });
    try {
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      expect(await text(page, 'status')).toBe('paused');
      expect(await dot(page)).toBe('paused');
      expect(await text(page, 'play')).toBe('Play');
      expect(await live(page)).toBe('polite');
      expect(await frameIndex(page)).toBe(0);
      await page.waitForTimeout(1000);
      expect(await frameIndex(page)).toBe(0);
      expect(await text(page, 'status')).toBe('paused');

      await page.click(role('play'));
      expect(await text(page, 'status')).toBe('playing');
      expect(await dot(page)).toBe('playing');
      expect(await text(page, 'play')).toBe('Pause');
      expect(await live(page)).toBe('off');
      await expect.poll(() => frameIndex(page), { timeout: 3000 }).not.toBe(0);
      expect(problems).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('steps from the still start without playing first', async () => {
    const { page, context } = await open(plain.page, { reducedMotion: 'reduce' });
    try {
      await page.click(role('step-forward'));
      expect(await frameIndex(page)).toBe(1);
      expect(await text(page, 'status')).toBe('paused');
      expect(await live(page)).toBe('polite');
      await page.click(role('step-back'));
      await page.click(role('step-back'));
      expect(await frameIndex(page)).toBe(PHASES - 1);
    } finally { await context.close(); }
  }, 60_000);

  it('plays at load when the system states no preference', async () => {
    const { page, context } = await open(plain.page, { reducedMotion: 'no-preference' });
    try {
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
      expect(await text(page, 'status')).toBe('playing');
      expect(await dot(page)).toBe('playing');
      expect(await text(page, 'play')).toBe('Pause');
      expect(await live(page)).toBe('off');
      await expect.poll(() => frameIndex(page), { timeout: 3000 }).not.toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});

describe('the loop point mark stays attached to the first frame of the seam', () => {
  const SEAM_GAP = 14;

  for (const width of [1500, 390]) {
    it(`sits directly before the first frame inside its figure at ${width} px wide, on one row or wrapped`, async () => {
      const { page, context } = await open(plain.page, { viewport: { width, height: 1200 } });
      try {
        await page.selectOption(role('facing'), 'dir-1');
        const seen = await page.evaluate(() => {
          const figures = [...document.querySelectorAll('[data-role="seam-frame"]')] as HTMLElement[];
          const marks = [...document.querySelectorAll('[data-role="loop-mark"]')] as HTMLElement[];
          const third = figures[2], mark = marks[0];
          const box = (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          return {
            figures: figures.length, marks: marks.length,
            hidden: mark?.getAttribute('aria-hidden'), text: mark?.textContent,
            inThird: !!mark && third.contains(mark), inOthers: figures.filter((f, i) => i !== 2 && !!mark && f.contains(mark)).length,
            siblings: document.querySelectorAll('.wrapmark').length,
            tops: figures.map(f => f.getBoundingClientRect().top),
            mark: mark ? box(mark) : null, figure: box(third), canvas: box(third.querySelector('canvas')!),
          };
        });
        expect(seen.figures).toBe(4);
        expect(seen.marks).toBe(1);
        expect(seen.siblings).toBe(0);
        expect(seen.hidden).toBe('true');
        expect(seen.text).toBe('loop point');
        expect(seen.inThird).toBe(true);
        expect(seen.inOthers).toBe(0);
        // The strip wraps at 390 px (four 192 px cells do not fit a row) and stays on one row at 1500.
        if (width === 390) expect(seen.tops[0]).not.toBe(seen.tops[2]); else expect(seen.tops[0]).toBe(seen.tops[2]);
        const mark = seen.mark!;
        expect(mark.top).toBeGreaterThanOrEqual(seen.figure.top - 0.5);
        expect(mark.bottom).toBeLessThanOrEqual(seen.figure.bottom + 0.5);
        expect(mark.right).toBeLessThanOrEqual(seen.canvas.left + 0.01);
        expect(seen.canvas.left - mark.right).toBeLessThanOrEqual(SEAM_GAP + 1);
        expect(mark.left).toBeGreaterThanOrEqual(seen.figure.left - 0.5);
        expect(await page.locator(role('seam-frame')).evaluateAll(list => list.map(e => e.getAttribute('data-frame')))).toEqual([String(PHASES - 2), String(PHASES - 1), '0', '1']);
        expect(await page.locator(`${role('seam-frame')} figcaption`).allTextContents()).toEqual([`frame ${PHASES - 2}`, `frame ${PHASES - 1} (last)`, 'frame 0 (first)', 'frame 1']);
      } finally { await context.close(); }
    }, 60_000);
  }

  for (const width of [1400, 1401]) {
    it(`puts all four seam canvases on whole-pixel left positions at ${width} px, the mark column included`, async () => {
      const { page, context } = await open(plain.page, { viewport: { width, height: 1200 } });
      try {
        await page.selectOption(role('facing'), 'dir-1');
        const lefts = await page.locator(`${role('seam-frame')} canvas`).evaluateAll(list => list.map(e => e.getBoundingClientRect().left));
        expect(lefts).toHaveLength(4);
        expect(lefts.filter(left => !Number.isInteger(left)), `canvas lefts ${lefts.join(', ')}`).toEqual([]);
        const markWidth = await page.locator(role('loop-mark')).evaluate(e => e.getBoundingClientRect().width);
        expect(Number.isInteger(markWidth), `mark width ${markWidth}`).toBe(true);
      } finally { await context.close(); }
    }, 60_000);
  }

  it('keeps one mark through a facing change and an All facings round trip, and none while All facings shows', async () => {
    const { page, context } = await open(plain.page);
    try {
      expect(await page.locator(role('loop-mark')).count()).toBe(1);
      await page.selectOption(role('facing'), 'all');
      expect(await page.locator(role('loop-mark')).count()).toBe(0);
      await page.selectOption(role('facing'), 'dir-5');
      expect(await page.locator(role('loop-mark')).count()).toBe(1);
      expect(await page.locator(`${role('seam-frame')}:nth-child(3) ${role('loop-mark')}`).count()).toBe(1);
    } finally { await context.close(); }
  }, 60_000);
});

describe('the page is centred on a wide window without blurring a whole-pixel canvas', () => {
  const PAGE_MAX = 1240;
  const whole = (values: number[]) => values.every(Number.isInteger);
  /** The sheet cell of a facing and phase, each pixel repeated scale times across and down. */
  const scaledCell = (direction: number, phase: number, scale: number) => {
    const cell = plain.manifest.cell, image = decodePng(plain.sheet), size = cell * scale;
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const from = (((direction * cell + Math.floor(y / scale)) * image.width) + phase * cell + Math.floor(x / scale)) * 4;
      Buffer.from(image.rgba.subarray(from, from + 4)).copy(out, (y * size + x) * 4);
    }
    return out;
  };
  /** The element screenshot of a canvas, decoded in the page (a canvas that drew a file:// image cannot be read back). */
  const shotOf = async (page: Page, selector: string) => {
    const shot = (await page.locator(selector).screenshot()).toString('base64');
    const rgb = await page.evaluate(b64 => new Promise<number[]>((done, fail) => {
      const image = new Image();
      image.onload = () => { const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const x = c.getContext('2d')!; x.drawImage(image, 0, 0); done([image.width, image.height, ...x.getImageData(0, 0, image.width, image.height).data]); };
      image.onerror = () => fail(new Error('screenshot did not decode'));
      image.src = `data:image/png;base64,${b64}`;
    }), shot);
    return { width: rgb[0], height: rgb[1], rgba: rgb.slice(2) };
  };
  const placed = (page: Page, selector: string) => page.locator(selector).evaluateAll(list => list.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top]; }).flat());

  for (const width of [390, 1400, 1401, 1500]) {
    it(`${width < PAGE_MAX ? 'starts the page at the left edge' : 'centres the page on whole pixels'} at ${width} px, with whole-pixel canvases drawn exactly`, async () => {
      const { page, context } = await open(plain.page, { viewport: { width, height: 1200 } });
      try {
        const sides = await page.locator('.page').evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: document.documentElement.clientWidth - r.right, width: r.width }; });
        if (width > PAGE_MAX) {
          expect(sides.width).toBe(PAGE_MAX);
          expect(whole([sides.left, sides.right])).toBe(true);
          expect(Math.abs(sides.left - sides.right)).toBeLessThanOrEqual(1);
          expect(sides.left).toBeGreaterThan(0);
        } else {
          expect(sides.left).toBe(0);
        }

        // One facing: the sprite, the strip and the seam canvases sit on whole pixels, and the sprite is the scaled cell.
        await page.selectOption(role('facing'), 'dir-3');
        await page.click(role('strip-frame') + '[data-frame="2"]');
        const scale = Number(await page.locator(role('scale')).inputValue()), cell = plain.manifest.cell;
        await page.waitForFunction(([c, s]) => (document.querySelector('[data-role="sprite"]') as HTMLCanvasElement).style.width === `${c * s}px`, [cell, scale]);
        expect(whole(await placed(page, role('sprite')))).toBe(true);
        expect(whole(await placed(page, role('sprite-box')))).toBe(true);
        const expected = scaledCell(3, 2, scale);
        const wrong = async () => {
          const got = await shotOf(page, role('sprite'));
          if (got.width !== cell * scale || got.height !== cell * scale) return -1;
          let count = 0;
          for (let i = 0; i < expected.length; i += 4) {
            const want = expected[i + 3] === 255 ? [...expected.subarray(i, i + 3)] : [230, 226, 210];
            if (got.rgba[i] !== want[0] || got.rgba[i + 1] !== want[1] || got.rgba[i + 2] !== want[2]) count++;
          }
          return count;
        };
        // The sheet loads after the first paint, so poll until the drawn pixels settle.
        await expect.poll(wrong, { timeout: 10_000 }).toBe(0);
        const drawn = await shotOf(page, role('sprite'));
        expect([drawn.width, drawn.height]).toEqual([cell * scale, cell * scale]);

        // All facings: every tile canvas sits on whole pixels.
        await page.selectOption(role('facing'), 'all');
        await page.waitForFunction(([c, s]) => { const t = document.querySelectorAll('[data-role="facing-tile"]'); return t.length > 0 && [...t].every(e => (e as HTMLElement).style.width === `${c * s}px`); }, [cell, scale]);
        const tiles = await placed(page, role('facing-tile'));
        expect(tiles).toHaveLength(DIRECTIONS * 2);
        expect(whole(tiles)).toBe(true);
      } finally { await context.close(); }
    }, 90_000);
  }
});

describe('a held Space key toggles play once', () => {
  const statusOf = (page: Page) => text(page, 'status');
  /** Every Space keydown the document sees, after the page's own handler has run. */
  const logKeys = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __keys: Array<{ repeat: boolean; prevented: boolean; target: string }> };
    w.__keys = [];
    document.addEventListener('keydown', e => { if (e.code === 'Space') w.__keys.push({ repeat: e.repeat, prevented: e.defaultPrevented, target: (e.target as HTMLElement).getAttribute('data-role') ?? '' }); });
  });
  const keys = (page: Page) => page.evaluate(() => (window as unknown as { __keys: Array<{ repeat: boolean; prevented: boolean; target: string }> }).__keys);

  it('ignores the auto-repeat of Space on a focused Step button, only cancels its default, and toggles again on a new press', async () => {
    const { page, context } = await open(plain.page);
    try {
      await logKeys(page);
      await page.focus(role('step-forward'));
      expect(await statusOf(page)).toBe('playing');
      await page.keyboard.down('Space');
      expect(await statusOf(page)).toBe('paused');
      const held = await frameIndex(page);
      await page.keyboard.down('Space');
      expect(await statusOf(page)).toBe('paused');
      expect(await text(page, 'play')).toBe('Play');
      await page.keyboard.up('Space');
      expect(await statusOf(page)).toBe('paused');
      expect(await frameIndex(page)).toBe(held);
      expect(await keys(page)).toEqual([
        { repeat: false, prevented: true, target: 'step-forward' },
        { repeat: true, prevented: true, target: 'step-forward' },
      ]);

      await page.keyboard.press('Space');
      expect(await statusOf(page)).toBe('playing');
    } finally { await context.close(); }
  }, 60_000);

  it('ignores the auto-repeat of Space with nothing focused, so a held key toggles once', async () => {
    const { page, context } = await open(plain.page);
    try {
      await release(page);
      await page.keyboard.down('Space');
      for (let i = 0; i < 3; i++) await page.keyboard.down('Space');
      await page.keyboard.up('Space');
      expect(await statusOf(page)).toBe('paused');
    } finally { await context.close(); }
  }, 60_000);

  it('leaves the play button to the browser: one click for a held press, and another for the next press', async () => {
    const { page, context } = await open(plain.page);
    try {
      await logKeys(page);
      await page.focus(role('play'));
      expect(await statusOf(page)).toBe('playing');
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.up('Space');
      expect(await statusOf(page)).toBe('paused');
      await page.keyboard.press('Space');
      expect(await statusOf(page)).toBe('playing');
      expect((await keys(page)).every(k => !k.prevented)).toBe(true);
    } finally { await context.close(); }
  }, 60_000);
});

describe('the frame readout is announced after the live region opens', () => {
  interface Seen { kind: 'live' | 'text'; value: string | null; batch: number }
  /** Watches the counter and records, for every mutation, its kind, the aria-live value and the callback batch it arrived in. */
  const watch = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __seen: Seen[] };
    w.__seen = [];
    let batch = 0;
    const counter = document.querySelector('[data-role="counter"]')!;
    new MutationObserver(list => {
      batch++;
      for (const record of list) w.__seen.push({ kind: record.type === 'attributes' ? 'live' : 'text', value: record.type === 'attributes' ? (record.target as Element).getAttribute('aria-live') : null, batch });
    }).observe(counter, { attributes: true, attributeFilter: ['aria-live'], childList: true, characterData: true, subtree: true });
  });
  const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
  const clear = (page: Page) => page.evaluate(() => { (window as unknown as { __seen: Seen[] }).__seen.length = 0; });
  const liveSeen = async (page: Page) => (await seen(page)).some(r => r.kind === 'live');

  it('does not touch aria-live while playing, and on Step sets it to polite in an earlier task than the frame text', async () => {
    const { page, context } = await open(plain.page);
    try {
      await watch(page);
      await page.waitForTimeout(1000);
      const playing = await seen(page);
      expect(playing.filter(r => r.kind === 'live')).toEqual([]);
      expect(playing.some(r => r.kind === 'text')).toBe(true);

      await clear(page);
      await page.click(role('step-forward'));
      await expect.poll(() => liveSeen(page), { timeout: 5000 }).toBe(true);
      await page.waitForTimeout(200);
      const after = await seen(page);
      const live = after.filter(r => r.kind === 'live');
      expect(live.map(r => r.value)).toEqual(['polite']);
      const first = live[0].batch;
      const texts = after.filter(r => r.kind === 'text' && r.batch >= first);
      expect(texts.length).toBeGreaterThan(0);
      for (const record of texts) expect(record.batch, 'the frame text lands after the attribute, in another task').toBeGreaterThan(first);

      // The final values are the held frame in a polite region, and the strip agrees with the readout.
      expect(await page.locator(role('counter')).getAttribute('aria-live')).toBe('polite');
      const held = await page.locator(`${role('strip-frame')}[aria-current="true"]`).getAttribute('data-frame');
      expect(await text(page, 'frame-index')).toBe(held);
      expect(await text(page, 'frame-count')).toBe(String(PHASES));
      expect(await text(page, 'frame-ms')).toBe('300');
    } finally { await context.close(); }
  }, 60_000);

  it('does the same for a clicked strip frame and for an arrow key while playing', async () => {
    const { page, context } = await open(plain.page);
    try {
      // The strip click picks a frame other than the one showing, so the readout changes and its text write exists to be ordered.
      const acts = [async () => { await page.click(role('strip-frame') + `[data-frame="${((await frameIndex(page)) + 2) % PHASES}"]`); }, async () => { await release(page); await page.keyboard.press('ArrowRight'); }];
      for (const act of acts) {
        if (await text(page, 'status') === 'paused') await page.click(role('play'));
        expect(await page.locator(role('counter')).getAttribute('aria-live')).toBe('off');
        await watch(page);
        await act();
        await expect.poll(() => liveSeen(page), { timeout: 5000 }).toBe(true);
        await page.waitForTimeout(200);
        const after = await seen(page);
        const first = after.find(r => r.kind === 'live')!;
        expect(first.value).toBe('polite');
        const texts = after.filter(r => r.kind === 'text' && r.batch >= first.batch);
        expect(texts.length, 'the readout text is written, so the ordering check has something to order').toBeGreaterThan(0);
        for (const record of texts) expect(record.batch).toBeGreaterThan(first.batch);
      }
    } finally { await context.close(); }
  }, 60_000);

  it('leaves aria-live alone on a Step that is already paused', async () => {
    const { page, context } = await open(plain.page, { reducedMotion: 'reduce' });
    try {
      await watch(page);
      await page.click(role('step-forward'));
      await page.click(role('step-forward'));
      const after = await seen(page);
      expect(after.filter(r => r.kind === 'live')).toEqual([]);
      expect(after.some(r => r.kind === 'text')).toBe(true);
      expect(await frameIndex(page)).toBe(2);
    } finally { await context.close(); }
  }, 60_000);

  it('opens with aria-live polite under reduced motion and rewrites nothing while idle', async () => {
    const { page, context } = await open(plain.page, { reducedMotion: 'reduce' });
    try {
      await watch(page);
      await page.waitForTimeout(500);
      expect(await seen(page)).toEqual([]);
      expect(await page.locator(role('counter')).getAttribute('aria-live')).toBe('polite');
    } finally { await context.close(); }
  }, 60_000);
});

describe('a deferred frame readout writes the state of the moment it runs', () => {
  const readout = (page: Page) => text(page, 'frame-index');
  const shownFrame = (page: Page) => page.locator(`${role('strip-frame')}[aria-current="true"]`).getAttribute('data-frame');
  /** Let the zero-delay timer of a pending readout write fire, without reaching the next animation frame. */
  const settle = (page: Page) => page.clock.runFor(5);

  it('holds the readout at the old text under a fake clock until the clock runs, while status, button and frame move at once', async () => {
    const { page, context } = await open(plain.page, { clock: true });
    try {
      await page.clock.runFor(100);
      expect(await readout(page)).toBe('0');
      await page.click(role('step-forward'));
      expect(await text(page, 'status')).toBe('paused');
      expect(await text(page, 'play')).toBe('Play');
      expect(await shownFrame(page)).toBe('1');
      expect(await readout(page), 'the readout write waits for a later task').toBe('0');
      await settle(page);
      expect(await readout(page)).toBe('1');
      expect(await text(page, 'frame-ms')).toBe('300');
      expect(await text(page, 'status')).toBe('paused');
    } finally { await context.close(); }
  }, 60_000);

  // A Playwright click moves a fake clock on by a millisecond and so runs a pending zero-delay timer; keys and a select do not.
  // That is why the actions between the queued write and the settle below are keys and a select.
  it('does not overwrite a Step made after a pause with the frame it was queued for', async () => {
    const { page, context } = await open(plain.page, { clock: true });
    try {
      await page.clock.runFor(100);
      await page.click(role('step-forward'));
      expect(await readout(page)).toBe('0');
      await page.keyboard.press('Space');
      expect(await text(page, 'status')).toBe('playing');
      await page.keyboard.press('Space');
      expect(await text(page, 'status')).toBe('paused');
      expect(await readout(page), 'the queued write has not run yet').toBe('0');
      await page.keyboard.press('ArrowRight');
      expect(await readout(page), 'a Step while paused writes at once').toBe('2');
      await settle(page);
      expect(await readout(page), 'the earlier queued write must not bring back frame 1').toBe('2');
      expect(await shownFrame(page)).toBe('2');
      expect(await text(page, 'frame-ms')).toBe('300');
    } finally { await context.close(); }
  }, 60_000);

  it('shows the frame of the facing and the Step that are current when it runs, after a facing change', async () => {
    const { page, context } = await open(plain.page, { clock: true });
    try {
      await page.clock.runFor(100);
      await page.click(role('step-forward'));
      expect(await readout(page)).toBe('0');
      await page.selectOption(role('facing'), 'dir-4');
      expect(await text(page, 'facing-label')).toContain('dir-4');
      expect(await readout(page), 'a facing change writes the held frame at once').toBe('1');
      await release(page);
      await page.keyboard.press('ArrowRight');
      expect(await readout(page)).toBe('2');
      await settle(page);
      expect(await readout(page)).toBe('2');
      expect(await shownFrame(page)).toBe('2');
      expect(await text(page, 'frame-count')).toBe(String(PHASES));
    } finally { await context.close(); }
  }, 60_000);
});
