/** @lane merge
 * @subject src/sprite-bake-batch.ts
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { bakeBatch, readBakeList, type BakeBatchEntry } from '../src/sprite-bake-batch.ts';
import { bakeSprites } from '../src/sprite-bake.ts';

// Two small rigged figures from core operations and the Node exporter (no Blender, no committed binary): a box with a
// swinging arm, in two sizes. `sway` stays inside the rest bounds; `overreach` slides the arm out of them, so it clips.
const run = promisify(execFile);
const script = resolve('scripts/agent-meshes.mjs');
const DURATION = 1.2, KEYS = 12;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const clips: Clip[] = [
  { name: 'sway', duration: DURATION, tracks: [{ bone: 'shoulder', property: 'rotation', keys: times.map((time, i) => ({ time, value: aboutZ(i === KEYS ? 0 : 25 * Math.sin(2 * Math.PI * time / DURATION)) })) }] },
  { name: 'overreach', duration: DURATION, tracks: [{ bone: 'shoulder', property: 'position', keys: times.map((time, i) => ({ time, value: [i === KEYS ? 0 : 0.6 * Math.sin(Math.PI * time / DURATION), 0, 0] as [number, number, number] })) }] },
];
function figure(name: string, height: number): Project {
  let project = createProject(name);
  const part = (part: string, size: [number, number, number], position: [number, number, number], bone: string) => {
    project = applyOperation(project, { op: 'add', part: { name: part, geometry: { type: 'box', size }, position } });
    project = applyOperation(project, { op: 'bind', name: part, binding: { type: 'rigid', bone } });
  };
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'shoulder', parent: 'root', position: [0.25, height * 0.8, 0] } });
  part('body', [0.5, height, 0.3], [0, height / 2, 0], 'root');
  part('nose', [0.1, 0.1, 0.25], [0, height * 0.9, 0.2], 'root');
  part('arm', [0.6, 0.12, 0.12], [0.55, height * 0.8, 0], 'shoulder');
  return { ...project, clips };
}

let root: string, runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-bake-batch-'));
  await mkdir(join(root, 'models'));
  await writeFile(join(root, 'models', 'short.glb'), Buffer.from(await exportGLB(figure('short', 0.8))));
  await writeFile(join(root, 'models', 'tall.glb'), Buffer.from(await exportGLB(figure('tall', 1.4))));
  await writeFile(join(root, 'four.hex'), '#101820\n#f2aa4c\n#5b8c5a\n#e8e8e8\n');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** Write a list file in its own folder beside copies of nothing: paths in it are relative to `root`. */
async function listFile(list: unknown): Promise<string> {
  const file = join(root, `list-${runs++}.json`);
  await writeFile(file, typeof list === 'string' ? list : JSON.stringify(list));
  return file;
}
const three = async (dir: string) => ({ sheet: await readFile(join(dir, 'sheet.png')), atlas: await readFile(join(dir, 'atlas.json')), manifest: await readFile(join(dir, 'manifest.json')) });
const files = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
const statuses = (bakes: BakeBatchEntry[]) => bakes.map(entry => entry.status);

describe('a bake list is checked before Chromium starts', () => {
  it('reads defaults, entry values and null, and resolves paths from the folder of the list', async () => {
    const planned = await readBakeList(await listFile({
      version: 1, defaults: { clip: 'sway', cell: 32, phases: 2, directions: 4, look: 'banded', palette: 'four.hex' },
      bakes: [
        { glb: 'models/short.glb' },
        { glb: 'models/tall.glb', out: 'sprites/tall', cell: 64, look: 'unlit', palette: null },
        { glb: 'models/tall.glb', out: 'sprites/tall-three', directions: null, yaws: [0, 270, 315], clip: 'overreach' },
      ],
    }));
    expect(planned.map(plan => [plan.glb, plan.output])).toEqual([
      [join(root, 'models', 'short.glb'), join(root, 'models', 'short-sprites')],
      [join(root, 'models', 'tall.glb'), join(root, 'sprites', 'tall')],
      [join(root, 'models', 'tall.glb'), join(root, 'sprites', 'tall-three')],
    ]);
    expect(planned[0].settings).toMatchObject({ clip: 'sway', cell: 32, phases: 2, directions: 4, look: 'banded', bands: 3, paletteFile: join(root, 'four.hex') });
    expect(planned[1].settings).toMatchObject({ cell: 64, look: 'unlit', directions: 4 });
    expect(Object.keys(planned[1].settings)).not.toContain('palette');
    expect(planned[2].settings).toMatchObject({ clip: 'overreach', yaws: [0, 270, 315], directions: 3, cell: 32 });
  });

  it('refuses a list that is not the documented shape, naming the fault', async () => {
    const entry = { glb: 'models/short.glb', clip: 'sway' };
    const cases: [unknown, RegExp][] = [
      ['{ not json', /cannot be read as JSON/],
      [[entry], /must be an object/],
      [{ bakes: [entry] }, /needs "version": 1, got undefined/],
      [{ version: 2, bakes: [entry] }, /needs "version": 1, got 2/],
      [{ version: 1, bakes: [] }, /bakes must be a list of 1 to 1000 entries/],
      [{ version: 1, bakes: [entry], extra: true }, /unknown key "extra"/],
      [{ version: 1, defaults: { glb: 'x.glb' }, bakes: [entry] }, /defaults has an unknown key "glb"/],
      [{ version: 1, bakes: [{ ...entry, pixelsPerMeter: 20 }] }, /bakes\[0\] has an unknown key "pixelsPerMeter"/],
      [{ version: 1, bakes: [entry, { clip: 'sway' }] }, /bakes\[1\]\.glb must be the path of a GLB file/],
      [{ version: 1, bakes: [entry, { ...entry, out: '' }] }, /bakes\[1\]\.out must be a folder path/],
      [{ version: 1, bakes: [entry, { glb: 'models/short.glb', clip: 'overreach' }] }, /bakes\[1\] and bakes\[0\] both write to .*short-sprites.* Give each entry its own "out"/],
    ];
    for (const [list, message] of cases) await expect(readBakeList(await listFile(list)), String(message)).rejects.toMatchObject({ code: 'BAKE_LIST_INVALID', message: expect.stringMatching(message) });
    await expect(readBakeList(join(root, 'no-such-list.json'))).rejects.toMatchObject({ code: 'BAKE_LIST_INVALID' });
  });

  it('refuses the whole list for one bad option, naming the entry, and neither bakes nor starts the browser', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    try {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ cell: 4 }, /^bakes\[1\] \(models\/tall\.glb\): --cell must be an integer from 8 to 512, got 4$/],
        [{ clip: null }, /^bakes\[1\] \(models\/tall\.glb\): --clip <name> is required$/],
        [{ yaws: '0,90', directions: 2 }, /^bakes\[1\] .*cannot be combined with --directions/],
        [{ palette: 'missing.hex' }, /^bakes\[1\] \(models\/tall\.glb\): /],
      ];
      for (const [bad, message] of cases) {
        const good = join(root, `refused-${runs++}`);
        const list = await listFile({ version: 1, defaults: { clip: 'sway' }, bakes: [{ glb: 'models/short.glb', out: good }, { glb: 'models/tall.glb', out: `${good}-b`, ...bad }] });
        await expect(bakeBatch(list), String(message)).rejects.toMatchObject({ message: expect.stringMatching(message) });
        expect(await files(good)).toEqual([]);
      }
      await expect(bakeBatch(await listFile({ version: 1, bakes: [{ glb: 'models/tall.glb', clip: 'sway', cell: 4 }] }))).rejects.toMatchObject({ code: 'CLI_ARGUMENT_ERROR' });
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
  });
});

describe('a batch bake', () => {
  const defaults = { cell: 32, phases: 2, directions: 2 };
  const entries = [
    { glb: 'models/short.glb', clip: 'sway', out: 'batch/short' },
    { glb: 'models/tall.glb', clip: 'sway', out: 'batch/tall', look: 'banded', palette: 'four.hex', outline: 'auto', anchor: 'feet', contactSheet: true, viewer: true },
    { glb: 'models/tall.glb', clip: 'sway', out: 'batch/tall-oblique', directions: null, yaws: '0,270,315', oblique: '45,0.5', anchor: 'origin', pixelsPerMetre: 16 },
  ];
  let list: string, first: Awaited<ReturnType<typeof bakeBatch>>, launches = 0, seen: [string, number, number][] = [];
  beforeAll(async () => {
    list = await listFile({ version: 1, defaults, bakes: entries });
    const launch = vi.spyOn(chromium, 'launch');
    try {
      first = await bakeBatch(list, { onEntry: (entry, done, total) => { seen.push([entry.status, done, total]); } });
      launches = launch.mock.calls.length;
    } finally { launch.mockRestore(); }
  }, 180_000);

  it('bakes every entry in one browser and reports each as it finishes', () => {
    expect(first).toMatchObject({ ok: true, list, total: 3, baked: 3, skipped: 0, failed: 0 });
    expect(launches).toBe(1);
    expect(seen).toEqual([['baked', 1, 3], ['baked', 2, 3], ['baked', 3, 3]]);
    expect(first.bakes.map(entry => [entry.index, entry.glb, entry.clip, entry.output])).toEqual([
      [0, join(root, 'models', 'short.glb'), 'sway', join(root, 'batch', 'short')],
      [1, join(root, 'models', 'tall.glb'), 'sway', join(root, 'batch', 'tall')],
      [2, join(root, 'models', 'tall.glb'), 'sway', join(root, 'batch', 'tall-oblique')],
    ]);
    expect(first.bakes[0]).toMatchObject({ size: { w: 64, h: 64 }, frames: 4, files: { sheet: 'sheet.png', atlas: 'atlas.json', manifest: 'manifest.json' } });
    expect(first.bakes[2]).toMatchObject({ size: { w: 64, h: 96 }, frames: 6 });
  });

  it('writes for each entry the same bytes as a single bake of that model with those options', async () => {
    const singles: [number, Parameters<typeof bakeSprites>[1]][] = [
      [0, { clip: 'sway', ...defaults }],
      [1, { clip: 'sway', ...defaults, look: 'banded', palette: join(root, 'four.hex'), outline: 'auto', anchor: 'feet', contactSheet: true, viewer: true }],
      [2, { clip: 'sway', cell: 32, phases: 2, yaws: '0,270,315', oblique: '45,0.5', anchor: 'origin', pixelsPerMetre: 16 }],
    ];
    for (const [index, options] of singles) {
      const alone = join(root, `alone-${index}`), batch = first.bakes[index].output;
      await bakeSprites(first.bakes[index].glb, { ...options, out: alone });
      expect(await files(batch), `entry ${index}`).toEqual(await files(alone));
      const a = await three(alone), b = await three(batch);
      expect(b.sheet.equals(a.sheet), `sheet of entry ${index}`).toBe(true);
      expect(b.atlas.equals(a.atlas), `atlas of entry ${index}`).toBe(true);
      expect(b.manifest.equals(a.manifest), `manifest of entry ${index}`).toBe(true);
      for (const extra of (await files(alone)).filter(name => name === 'contact.png' || name === 'viewer.html'))
        expect((await readFile(join(batch, extra))).equals(await readFile(join(alone, extra))), `${extra} of entry ${index}`).toBe(true);
    }
    expect(await files(first.bakes[1].output)).toEqual(['atlas.json', 'contact.png', 'manifest.json', 'sheet.png', 'viewer.html']);
  }, 180_000);

  it('skips every finished entry on a second run without starting the browser, and leaves the files alone', async () => {
    const before = await three(first.bakes[1].output);
    const launch = vi.spyOn(chromium, 'launch');
    try {
      const again = await bakeBatch(list);
      expect(again).toMatchObject({ ok: true, baked: 0, skipped: 3, failed: 0 });
      expect(again.bakes.map(entry => [entry.sheetSha256, entry.atlasSha256])).toEqual(first.bakes.map(entry => [entry.sheetSha256, entry.atlasSha256]));
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
    const after = await three(first.bakes[1].output);
    expect(after.sheet.equals(before.sheet) && after.atlas.equals(before.atlas) && after.manifest.equals(before.manifest)).toBe(true);
  }, 180_000);

  it('bakes again only the entries whose model, options or files changed, and all of them with force', async () => {
    // Each change is made to a copy of the finished run, so the cases do not depend on one another.
    const fresh = async () => {
      const name = `resume-${runs++}`, bakes = entries.map(entry => ({ ...entry, out: entry.out.replace('batch/', `${name}/`) }));
      for (const [k, entry] of bakes.entries()) {
        await mkdir(join(root, entry.out), { recursive: true });
        for (const file of await files(first.bakes[k].output)) await writeFile(join(root, entry.out, file), await readFile(join(first.bakes[k].output, file)));
      }
      return { name, bakes };
    };
    const rerun = async (bakes: unknown[], extra: Record<string, unknown> = {}, options = {}) => statuses((await bakeBatch(await listFile({ version: 1, defaults: { ...defaults, ...extra }, bakes }), options)).bakes);

    let copy = await fresh();
    expect(await rerun(copy.bakes)).toEqual(['skipped', 'skipped', 'skipped']);
    // A changed option of one entry, and a changed default that reaches the two entries that use it.
    expect(await rerun(copy.bakes.map((entry, k) => (k === 0 ? { ...entry, look: 'unlit' } : entry)))).toEqual(['baked', 'skipped', 'skipped']);
    expect(await rerun(copy.bakes, { directions: 3 })).toEqual(['baked', 'baked', 'skipped']);

    copy = await fresh();
    // A sheet that no longer matches its manifest, a missing atlas, and a review file that was asked for and is gone.
    await writeFile(join(root, copy.bakes[0].out, 'sheet.png'), Buffer.from('not the sheet'));
    await rm(join(root, copy.bakes[2].out, 'atlas.json'));
    await rm(join(root, copy.bakes[1].out, 'viewer.html'));
    expect(await rerun(copy.bakes)).toEqual(['baked', 'baked', 'baked']);
    expect(await rerun(copy.bakes)).toEqual(['skipped', 'skipped', 'skipped']);

    copy = await fresh();
    // A changed model: the same list, with the first entry pointing at a GLB of other bytes.
    await writeFile(join(root, 'models', 'changing.glb'), await readFile(join(root, 'models', 'short.glb')));
    const moved = copy.bakes.map((entry, k) => (k === 0 ? { ...entry, glb: 'models/changing.glb' } : entry));
    expect(await rerun(moved)).toEqual(['skipped', 'skipped', 'skipped']);
    await writeFile(join(root, 'models', 'changing.glb'), Buffer.from(await exportGLB(figure('short', 0.9))));
    expect(await rerun(moved)).toEqual(['baked', 'skipped', 'skipped']);
    // A manifest from another version is not this bake.
    const manifestPath = join(root, copy.bakes[1].out, 'manifest.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replace(/"pluginVersion": "[^"]+"/, '"pluginVersion": "0.0.1"'));
    expect(await rerun(moved)).toEqual(['skipped', 'baked', 'skipped']);
    expect(await rerun(moved, {}, { force: true })).toEqual(['baked', 'baked', 'baked']);
  }, 300_000);

  it('records an entry that fails, bakes the rest and reports the run as not ok', async () => {
    const name = `failing-${runs++}`;
    const result = await bakeBatch(await listFile({
      version: 1, defaults,
      bakes: [
        { glb: 'models/short.glb', clip: 'overreach', out: `${name}/clipped` },
        { glb: 'models/missing.glb', clip: 'sway', out: `${name}/missing` },
        { glb: 'models/short.glb', clip: 'no-such-clip', out: `${name}/no-clip` },
        { glb: 'models/tall.glb', clip: 'sway', out: `${name}/good` },
      ],
    }));
    expect(result).toMatchObject({ ok: false, total: 4, baked: 1, skipped: 0, failed: 3 });
    expect(statuses(result.bakes)).toEqual(['failed', 'failed', 'failed', 'baked']);
    expect(result.bakes[0].error).toMatchObject({ code: 'BAKE_CELL_CLIPPED' });
    expect(result.bakes[1].error).toMatchObject({ code: 'ENOENT' });
    expect(result.bakes[2].error).toMatchObject({ code: 'CLIP_NOT_FOUND' });
    for (const failed of ['clipped', 'missing', 'no-clip']) expect(await files(join(root, name, failed)), failed).toEqual([]);
    expect(await files(join(root, name, 'good'))).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
  }, 180_000);
});

describe('agent-meshes bake-batch', () => {
  type Outcome = { code: number; stdout: string; stderr: string };
  const batch = (...args: string[]): Promise<Outcome> => run(process.execPath, [script, 'bake-batch', ...args], { timeout: 170_000, windowsHide: true }).then(
    out => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  const lines = (text: string) => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

  it('prints one line per entry on stderr and the summary on stdout, skips on a second run, bakes again with --force and exits 1 when an entry fails', async () => {
    const name = `cli-${runs++}`;
    const list = await listFile({ version: 1, defaults: { clip: 'sway', cell: 32, phases: 2, directions: 1 }, bakes: [{ glb: 'models/short.glb', out: `${name}/short` }, { glb: 'models/tall.glb', out: `${name}/tall`, azimuth: 432 }] });
    const first = await batch(list);
    expect(first.code, first.stderr).toBe(0);
    expect(lines(first.stderr).map(line => [line.bake, line.of, line.status, line.output])).toEqual([[1, 2, 'baked', join(root, name, 'short')], [2, 2, 'baked', join(root, name, 'tall')]]);
    const summary = lines(first.stdout);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ ok: true, total: 2, baked: 2, skipped: 0, failed: 0 });
    expect(JSON.parse(await readFile(join(root, name, 'tall', 'manifest.json'), 'utf8')).camera.azimuthDeg).toBe(72);

    const second = await batch(list);
    expect(second.code, second.stderr).toBe(0);
    expect(lines(second.stdout)[0]).toMatchObject({ ok: true, baked: 0, skipped: 2 });
    expect(lines(second.stderr).map(line => line.status)).toEqual(['skipped', 'skipped']);
    expect(lines((await batch(list, '--force')).stdout)[0]).toMatchObject({ ok: true, baked: 2, skipped: 0 });

    const failing = await batch(await listFile({ version: 1, defaults: { cell: 32, phases: 2, directions: 1 }, bakes: [{ glb: 'models/short.glb', clip: 'overreach', out: `${name}/clipped` }, { glb: 'models/tall.glb', clip: 'sway', out: `${name}/after` }] }));
    expect(failing.code).toBe(1);
    expect(lines(failing.stdout)[0]).toMatchObject({ ok: false, baked: 1, failed: 1 });
    expect(lines(failing.stderr).map(line => [line.status, line.error?.code])).toEqual([['failed', 'BAKE_CELL_CLIPPED'], ['baked', undefined]]);

    const refused = await batch(await listFile({ version: 3, bakes: [] }));
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(lines(refused.stderr).at(-1)).toMatchObject({ ok: false, error: { code: 'BAKE_LIST_INVALID' } });
  }, 300_000);

  it('documents the list, the skip rule and --force in --help', async () => {
    const help = (await run(process.execPath, [script, 'bake-batch', '--help'], { windowsHide: true })).stdout.replace(/\s+/g, ' ');
    for (const text of ['"version": 1', 'defaults', 'pixelsPerMetre', 'null to drop a default', 'paths from the folder of the list file', 'BAKE_LIST_INVALID', 'is skipped when its folder already holds the same bake', 'resumed by running the same command again', '--force', 'exits 1']) expect(help, text).toContain(text);
  }, 60_000);
});
