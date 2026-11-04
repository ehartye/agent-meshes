/** @lane merge
 * @subject agent-meshes bake --viewer
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { bakeSprites, parseBakeOptions } from '../src/sprite-bake.ts';

// The `--viewer` option of `bake`: viewer.html written last, `files.viewer` after `contact`, nothing else moved. The
// fixture is the small rigged figure of tests/sprite-bake.test.ts, built from core operations and the Node exporter, so
// no Blender is needed and no binary is committed; the bake needs Chromium, so these tests run alone.
const run = promisify(execFile);
const script = resolve('scripts/agent-meshes.mjs');
const DURATION = 1.2, KEYS = 12;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const sway: Clip = {
  name: 'sway', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'rotation', keys: times.map((time, i) => ({ time, value: aboutZ(i === KEYS ? 0 : 25 * Math.sin(2 * Math.PI * time / DURATION)) })) },
  ],
};
// `sway` stays inside the rest bounds; `overreach` slides the shoulder 0.6 m out, so the arm tip leaves them and the bake
// fails BAKE_CELL_CLIPPED only after every cell is rendered, which is the failure that matters for "writes no viewer.html".
const overreach: Clip = {
  name: 'overreach', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'position', keys: times.map((time, i) => ({ time, value: [i === KEYS ? 0 : 0.6 * Math.sin(Math.PI * time / DURATION), 0, 0] as [number, number, number] })) },
  ],
};

function fixtureProject(): Project {
  let project = createProject('sprite-fixture');
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
  return { ...project, clips: [sway, overreach] };
}

// Records the name of every file written through node:fs/promises, in order, and passes the call on unchanged.
const written = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, writeFile: ((path: Parameters<typeof real.writeFile>[0], ...rest: unknown[]) => { written.push(String(path)); return (real.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest); }) as typeof real.writeFile };
});

// Wraps the page generator: it behaves as the real one unless a test turns `fail` on, and counts its calls.
const composer = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../src/sprite-viewer.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/sprite-viewer.ts')>();
  return { ...real, composeViewer: ((...args: Parameters<typeof real.composeViewer>) => { composer.calls++; if (composer.fail) throw new Error('compose failed'); return real.composeViewer(...args); }) as typeof real.composeViewer };
});

let root: string, glbPath: string;
let runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-bake-viewer-'));
  glbPath = join(root, 'figure.glb');
  await writeFile(glbPath, Buffer.from(await exportGLB(fixtureProject())));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

type Outcome = { code: number; stdout: string; stderr: string };
const bake = (...args: string[]): Promise<Outcome> => run(process.execPath, [script, 'bake', ...args], { timeout: 110_000, windowsHide: true }).then(
  out => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
  (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
const outDir = () => join(root, `out-${runs++}`);
const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
const read = async (dir: string, name: string) => readFile(join(dir, name));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const small = { clip: 'sway', directions: 2, phases: 3, cell: 16 };
const smallArgs = ['--clip', 'sway', '--directions', '2', '--phases', '3', '--cell', '16'];
const footerSha = (html: string) => /data-role="footer-sha"[^>]*>([0-9a-f]+)</.exec(html)?.[1];

describe('the viewer option is checked before Chromium starts', () => {
  for (const value of ['yes', 'true', 1, 0, null, {}])
    it(`refuses viewer ${JSON.stringify(value)} with CLI_ARGUMENT_ERROR naming --viewer`, () => {
      expect(() => parseBakeOptions({ clip: 'sway', viewer: value as boolean })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringContaining('--viewer') }));
    });

  it('sets viewer in the settings only when it is true', () => {
    expect(parseBakeOptions({ clip: 'sway', viewer: true }).viewer).toBe(true);
    for (const viewer of [undefined, false]) expect(Object.keys(parseBakeOptions({ clip: 'sway', viewer }))).not.toContain('viewer');
    expect(Object.keys(parseBakeOptions({ clip: 'sway' }))).not.toContain('viewer');
  });
});

describe('bakeSprites with viewer', () => {
  it('writes viewer.html last, lists it after contact, and leaves the other files as they are without the option', async () => {
    const plain = outDir(), withViewer = outDir(), both = outDir(), off = outDir();
    const without = await bakeSprites(glbPath, { ...small, out: plain });
    const result = await bakeSprites(glbPath, { ...small, out: withViewer, viewer: true });
    const bothResult = await bakeSprites(glbPath, { ...small, out: both, contactSheet: true, viewer: true });
    const offResult = await bakeSprites(glbPath, { ...small, out: off, viewer: false });
    expect(Object.keys(without.files)).toEqual(['sheet', 'atlas', 'manifest']);
    expect(Object.keys(offResult.files)).toEqual(['sheet', 'atlas', 'manifest']);
    expect(Object.keys(result.files)).toEqual(['sheet', 'atlas', 'manifest', 'viewer']);
    expect(result.files.viewer).toBe('viewer.html');
    expect(Object.keys(bothResult.files)).toEqual(['sheet', 'atlas', 'manifest', 'contact', 'viewer']);
    expect(await list(plain)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    expect(await list(off)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    expect(await list(withViewer)).toEqual(['atlas.json', 'manifest.json', 'sheet.png', 'viewer.html']);
    expect(await list(both)).toEqual(['atlas.json', 'contact.png', 'manifest.json', 'sheet.png', 'viewer.html']);
    for (const dir of [withViewer, both, off]) for (const name of ['sheet.png', 'atlas.json', 'manifest.json'])
      expect((await read(dir, name)).equals(await read(plain, name)), `${dir} ${name}`).toBe(true);
    for (const name of ['atlas.json', 'manifest.json']) expect((await read(withViewer, name)).toString('utf8')).not.toContain('viewer');
    // The page is the one the generator composes for this bake: the footer shows the result's sheet hash.
    const page = (await read(withViewer, 'viewer.html')).toString('utf8');
    expect(footerSha(page)).toBe(result.sheetSha256.slice(0, 12));
    expect(footerSha(page)).toBe(sha(await read(withViewer, 'sheet.png')).slice(0, 12));
    expect(page).toContain('sheet.png');
  }, 180_000);

  it('writes viewer.html after every other file', async () => {
    const dir = outDir();
    written.length = 0;
    await bakeSprites(glbPath, { ...small, out: dir, contactSheet: true, viewer: true });
    expect(written.filter(path => path.startsWith(dir)).map(path => basename(path))).toEqual(['sheet.png', 'atlas.json', 'manifest.json', 'contact.png', 'viewer.html']);
  }, 120_000);

  it('leaves a viewer.html from an earlier bake in the folder, byte for byte, after a plain bake', async () => {
    const dir = outDir(), options = { ...small, out: dir };
    await bakeSprites(glbPath, { ...options, viewer: true });
    const before = await read(dir, 'viewer.html');
    const plain = await bakeSprites(glbPath, options);
    expect(Object.keys(plain.files)).toEqual(['sheet', 'atlas', 'manifest']);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png', 'viewer.html']);
    expect((await read(dir, 'viewer.html')).equals(before)).toBe(true);
  }, 120_000);

  it('writes nothing, viewer.html included, when a cell clips after every cell is rendered', async () => {
    const dir = outDir();
    await expect(bakeSprites(glbPath, { ...small, phases: 4, clip: 'overreach', out: dir, viewer: true })).rejects.toMatchObject({ code: 'BAKE_CELL_CLIPPED' });
    expect(await list(dir)).toEqual([]);
  }, 120_000);

  it('composes the page before it creates the folder, so a page that cannot be composed leaves no folder and no file', async () => {
    const dir = join(outDir(), 'not-yet'), before = composer.calls;
    written.length = 0;
    composer.fail = true;
    try { await expect(bakeSprites(glbPath, { ...small, out: dir, viewer: true })).rejects.toThrow('compose failed'); }
    finally { composer.fail = false; }
    expect(composer.calls).toBe(before + 1);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(written.filter(path => path.startsWith(dir))).toEqual([]);
  }, 120_000);

  it('with one direction writes the page for that facing and leaves the other files as a plain bake', async () => {
    const dir = outDir(), plain = outDir();
    const result = await bakeSprites(glbPath, { ...small, directions: 1, out: dir, viewer: true });
    await bakeSprites(glbPath, { ...small, directions: 1, out: plain });
    expect(Object.keys(result.files)).toEqual(['sheet', 'atlas', 'manifest', 'viewer']);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png', 'viewer.html']);
    for (const name of ['sheet.png', 'atlas.json', 'manifest.json']) expect((await read(dir, name)).equals(await read(plain, name)), name).toBe(true);
    expect(JSON.parse((await read(dir, 'manifest.json')).toString('utf8')).directions).toBe(1);
    expect(footerSha((await read(dir, 'viewer.html')).toString('utf8'))).toBe(result.sheetSha256.slice(0, 12));
  }, 120_000);

  it('with --anchor feet gives the page its pivot toggle and the pivot of the manifest, and a bake without the anchor has neither', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { ...small, out: dir, anchor: 'feet', viewer: true });
    const page = (await read(dir, 'viewer.html')).toString('utf8');
    const { anchor } = JSON.parse((await read(dir, 'manifest.json')).toString('utf8'));
    expect(anchor).toMatchObject({ name: 'feet' });
    expect(page).toContain('data-role="pivot-toggle"');
    expect(page).toContain(`"pivot":{"x":${anchor.x},"y":${anchor.y}}`);
    const none = outDir();
    await bakeSprites(glbPath, { ...small, out: none, viewer: true });
    const plainPage = (await read(none, 'viewer.html')).toString('utf8');
    expect(plainPage).not.toContain('data-role="pivot-toggle"');
    expect(plainPage).toContain('"pivot":null');
  }, 180_000);
});

describe('agent-meshes bake --viewer', () => {
  it('writes the four files, prints viewer after the existing keys, and shows the sheet hash in the page footer', async () => {
    const dir = outDir();
    const outcome = await bake(glbPath, ...smallArgs, '--viewer', '--out', dir);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png', 'viewer.html']);
    const result = JSON.parse(outcome.stdout.trim());
    expect(Object.keys(result)).toEqual(['output', 'files', 'size', 'frames', 'sheetSha256', 'atlasSha256']);
    expect(result.files).toEqual({ sheet: 'sheet.png', atlas: 'atlas.json', manifest: 'manifest.json', viewer: 'viewer.html' });
    expect(Object.keys(result.files)).toEqual(['sheet', 'atlas', 'manifest', 'viewer']);
    expect(footerSha((await read(dir, 'viewer.html')).toString('utf8'))).toBe(result.sheetSha256.slice(0, 12));
  }, 120_000);

  it('with --contact-sheet as well lists both, viewer after contact, and the three fixed files match a bake without either flag', async () => {
    const both = outDir(), plain = outDir();
    const outcome = await bake(glbPath, ...smallArgs, '--contact-sheet', '--viewer', '--out', both);
    expect(outcome.code, outcome.stderr).toBe(0);
    const plainOutcome = await bake(glbPath, ...smallArgs, '--out', plain);
    expect(plainOutcome.code, plainOutcome.stderr).toBe(0);
    expect(await list(both)).toEqual(['atlas.json', 'contact.png', 'manifest.json', 'sheet.png', 'viewer.html']);
    expect(Object.keys(JSON.parse(outcome.stdout).files)).toEqual(['sheet', 'atlas', 'manifest', 'contact', 'viewer']);
    expect(await list(plain)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    expect(Object.keys(JSON.parse(plainOutcome.stdout).files)).toEqual(['sheet', 'atlas', 'manifest']);
    for (const name of ['sheet.png', 'atlas.json', 'manifest.json']) expect((await read(both, name)).equals(await read(plain, name)), name).toBe(true);
  }, 180_000);

  it('takes no value: a stray value is rejected by the command parser and nothing is written', async () => {
    const dir = outDir();
    const outcome = await bake(glbPath, ...smallArgs, '--viewer', 'yes', '--out', dir);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toMatch(/too many arguments/i);
    expect(await list(dir)).toEqual([]);
  }, 120_000);

  it('writes no viewer.html when the bake fails after every cell is rendered', async () => {
    const dir = outDir();
    const outcome = await bake(glbPath, '--clip', 'overreach', '--directions', '2', '--phases', '4', '--cell', '16', '--viewer', '--out', dir);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('BAKE_CELL_CLIPPED');
    expect(await list(dir)).toEqual([]);
  }, 120_000);

  it('names the flag and the file in its help, with no value and the sheet beside the page', async () => {
    const help = (await run(process.execPath, [script, 'bake', '--help'], { windowsHide: true })).stdout.replace(/\s+/g, ' ');
    for (const text of ['--viewer', 'viewer.html', 'takes no value', 'needs sheet.png beside it']) expect(help).toContain(text);
    expect(help).not.toContain('--viewer <');
  }, 60_000);
});
