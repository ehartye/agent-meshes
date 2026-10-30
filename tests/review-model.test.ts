import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportGLB } from '../src/export.ts';
import type { Project } from '../src/core/types.ts';

// Drives scripts/review-model.mjs end to end, so it needs the same Chromium as the other browser tests.
const run = promisify(execFile);
const script = new URL('../scripts/review-model.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const project = {
  version: 1, name: 'review-block',
  parts: [{ name: 'block', geometry: { type: 'box', size: [1, 1, 1], segments: 12 }, color: '#8f8f8f', position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null }],
  bones: [], clips: [], shells: [],
} as unknown as Project;
const region = { name: 'top', center: [0, 0.5, 0], radius: 0.5, elevation: 0 };

let root: string;
let runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-model-'));
  await writeFile(join(root, 'model.glb'), await exportGLB(project));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** Write a config next to the model, run the script and return its output directory or its failure. */
async function review(extra: Record<string, unknown>) {
  const name = `run-${runs++}`;
  await writeFile(join(root, `${name}.json`), JSON.stringify({ model: 'model.glb', output: name, ...extra }));
  const result = await run(process.execPath, [script, join(root, `${name}.json`)], { timeout: 110_000 }).then(
    out => ({ ok: true as const, out: out.stdout }), (error: { stderr?: string; message: string }) => ({ ok: false as const, out: error.stderr ?? error.message }));
  const dir = join(root, name);
  const files = await readdir(dir).catch(() => [] as string[]);
  const manifest = files.includes('manifest.json') ? JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) : null;
  return { ...result, dir, files, captures: files.filter(f => f.endsWith('.png') && f.includes('--') && !f.endsWith('-sheet.png')), manifest };
}
/** Width, height and the first pixel of an 8-bit RGBA PNG. The first pixel of row 0 is unaffected by the row filter. */
async function png(path: string) {
  const bytes = await readFile(path);
  expect([bytes[24], bytes[25]]).toEqual([8, 6]);
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length;) { const length = bytes.readUInt32BE(at); if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length)); at += length + 12; }
  const raw = inflateSync(Buffer.concat(idat));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), corner: [...raw.subarray(1, 5)] };
}

describe('review-model capture controls', () => {
  it('keeps today\'s output when none of the new keys is set', async () => {
    const r = await review({});
    expect(r.ok, r.out).toBe(true);
    expect(r.captures).toHaveLength(8);
    expect(r.captures.every(f => f.startsWith('rest--body--'))).toBe(true);
    for (const file of r.captures) expect(await png(join(r.dir, file))).toMatchObject({ width: 720, height: 720 });
    expect((await png(join(r.dir, r.captures[0]))).corner).toEqual([0xe1, 0xe6, 0xe8, 255]);
    const html = await readFile(join(r.dir, 'viewer.html'), 'utf8');
    expect(html).toContain('#stage{width:720px;height:720px}');
    expect(html).toContain("background:'#e1e6e8'");
    for (const key of ['background', 'size', 'bodyCapture']) expect(r.manifest).not.toHaveProperty(key);
    expect(r.manifest.captures).toHaveLength(8);
  }, 120_000);

  it('size sets every capture to a square of that many pixels and records it with the background', async () => {
    const r = await review({ size: 128, background: '#ff0000', angles: [0, 90] });
    expect(r.ok, r.out).toBe(true);
    expect(r.captures).toHaveLength(2);
    for (const file of r.captures) {
      const image = await png(join(r.dir, file));
      expect(image).toMatchObject({ width: 128, height: 128 });
      expect(image.corner[0]).toBeGreaterThan(250); expect(image.corner[1]).toBeLessThan(5); expect(image.corner[3]).toBe(255);
    }
    expect(r.manifest).toMatchObject({ size: 128, background: '#ff0000' });
    expect(r.manifest).not.toHaveProperty('bodyCapture');
  }, 120_000);

  it('background null leaves the corner pixel transparent', async () => {
    const r = await review({ background: null, angles: [0] });
    expect(r.ok, r.out).toBe(true);
    expect((await png(join(r.dir, r.captures[0]))).corner[3]).toBe(0);
    expect(r.manifest.background).toBeNull();
  }, 120_000);

  it('bodyCapture false with one region writes no body files and lists only the region', async () => {
    const r = await review({ bodyCapture: false, regions: [region], angles: [0, 180] });
    expect(r.ok, r.out).toBe(true);
    expect(r.files.filter(f => f.includes('--body--'))).toEqual([]);
    expect(r.captures.sort()).toEqual(['rest--top--0.png', 'rest--top--180.png']);
    expect(r.manifest.captures.map((c: { region: string }) => c.region)).toEqual(['top', 'top']);
    expect(r.manifest.bodyCapture).toBe(false);
  }, 120_000);

  it.each([
    ['no regions', { bodyCapture: false }, /bodyCapture.*regions/],
    ['empty regions', { bodyCapture: false, regions: [] }, /bodyCapture.*regions/],
    ['a pose that drops its regions', { bodyCapture: false, regions: [region], poses: [{ name: 'rest', regions: false }] }, /bodyCapture.*regions|regions.*bodyCapture/],
  ])('bodyCapture false is refused when it would leave nothing to capture: %s', async (_name, extra, message) => {
    const r = await review(extra);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
    expect(r.files).toEqual([]);
  });

  it.each([
    ['size 0', { size: 0 }, /size must be a whole number/],
    ['size 4097', { size: 4097 }, /size must be a whole number/],
    ['fractional size', { size: 12.5 }, /size must be a whole number/],
    ['string size', { size: '128' }, /size must be a whole number/],
    ['bodyCapture string', { bodyCapture: 'no' }, /bodyCapture must be true or false/],
    ['unknown colour name', { background: 'not-a-colour' }, /background must be null/],
    ['non-string background', { background: 5 }, /background must be null/],
    ['injected background', { background: "red'});alert(1);//" }, /background must be null/],
  ])('rejects %s before writing anything', async (_name, extra, message) => {
    const r = await review(extra);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
    expect(r.files).toEqual([]);
  });
});
