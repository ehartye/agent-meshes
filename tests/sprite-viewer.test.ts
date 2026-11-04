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
import type { Atlas, SpriteManifest } from '../src/sprite-atlas.ts';
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
async function open(file: string, options: { colorScheme?: 'dark' | 'light' } = {}): Promise<Opened> {
  const context = await browser.newContext({ offline: true, viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 1, ...options });
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
const frameIndex = async (page: Page) => Number(await text(page, 'frame-index'));
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
        await page.waitForTimeout(150);
        // A canvas that drew a file:// image is tainted and cannot be read back, so the cell is read from a screenshot of it.
        const shot = (await page.locator(role('sprite')).screenshot()).toString('base64');
        const rgb = await page.evaluate(b64 => new Promise<number[]>((done, fail) => {
          const image = new Image();
          image.onload = () => { const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const x = c.getContext('2d')!; x.drawImage(image, 0, 0); done([image.width, image.height, ...x.getImageData(0, 0, image.width, image.height).data]); };
          image.onerror = () => fail(new Error('screenshot did not decode'));
          image.src = `data:image/png;base64,${b64}`;
        }), shot);
        const drawn = { width: rgb[0], height: rgb[1], rgba: rgb.slice(2) };
        expect([drawn.width, drawn.height]).toEqual([cell, cell]);
        const stage = await page.locator(role('sprite-box')).evaluate(e => getComputedStyle(e).backgroundColor);
        expect(stage).toBe('rgb(230, 226, 210)');
        const expected = cellOf(direction, phase);
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
        // The sprite sits on a whole pixel, so the browser never resamples it.
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
