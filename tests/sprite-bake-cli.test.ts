/** @lane merge
 * @subject agent-meshes bake
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';

// Drives `agent-meshes bake` end to end through the real entry point. The fixture (the same small asymmetric rigged
// figure as tests/sprite-bake.test.ts) comes from core operations and the Node exporter, so no Blender is needed.
const run = promisify(execFile);
const script = resolve('scripts/agent-meshes.mjs');
const DURATION = 1.2, KEYS = 12;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const clips: Clip[] = [
  { name: 'sway', duration: DURATION, tracks: [{ bone: 'shoulder', property: 'rotation', keys: times.map((time, i) => ({ time, value: aboutZ(i === KEYS ? 0 : 25 * Math.sin(2 * Math.PI * time / DURATION)) })) }] },
  { name: 'overreach', duration: DURATION, tracks: [{ bone: 'shoulder', property: 'position', keys: times.map((time, i) => ({ time, value: [i === KEYS ? 0 : 0.6 * Math.sin(Math.PI * time / DURATION), 0, 0] as [number, number, number] })) }] },
  { name: 'still', duration: 0.05, tracks: [{ bone: 'shoulder', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.05, value: [0, 0, 0, 1] }] }] },
];

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
  return { ...project, clips };
}

/** The schema refuses a zero-length clip, so the `still` clip is written valid and its key times are then zeroed in the bytes. */
function withZeroLengthClip(bytes: Uint8Array): Buffer {
  const copy = Uint8Array.from(bytes), doc = readGLB(copy);
  const animation = (doc.json as { animations: { name: string; samplers: { input: number }[] }[] }).animations.find(a => a.name === 'still')!;
  for (const sampler of animation.samplers) {
    const accessor = doc.json.accessors![sampler.input] as { bufferView: number; byteOffset?: number; count: number }, view = doc.json.bufferViews![accessor.bufferView];
    const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    doc.bin!.fill(0, at, at + accessor.count * 4);
  }
  return Buffer.from(copy);
}

let root: string, glbPath: string;
let runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-bake-cli-'));
  glbPath = join(root, 'figure.glb');
  await writeFile(glbPath, withZeroLengthClip(await exportGLB(fixtureProject())));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

type Outcome = { code: number; stdout: string; stderr: string };
const bake = (...args: string[]): Promise<Outcome> => run(process.execPath, [script, 'bake', ...args], { timeout: 110_000, windowsHide: true }).then(
  out => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
  (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
const outDir = () => join(root, `out-${runs++}`);
const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failure = (outcome: Outcome) => JSON.parse(outcome.stderr.trim().split('\n').at(-1)!) as { ok: boolean; error: { code: string; message: string } };

/** One bake at the defaults, shared by the tests that only read its output. */
let shared: Promise<{ dir: string; outcome: Outcome }> | undefined;
const defaultBake = () => shared ??= (async () => { const dir = outDir(); return { dir, outcome: await bake(glbPath, '--clip', 'sway', '--out', dir) }; })();

describe('agent-meshes bake', () => {
  it('writes exactly sheet.png, atlas.json and manifest.json and prints one JSON line about them', async () => {
    const { dir, outcome } = await defaultBake();
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    const lines = outcome.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]);
    expect(result).toMatchObject({ files: { sheet: 'sheet.png', atlas: 'atlas.json', manifest: 'manifest.json' }, size: { w: 384, h: 384 }, frames: 64 });
    expect(result.sheetSha256).toBe(sha(await readFile(join(dir, 'sheet.png'))));
    expect(result.atlasSha256).toBe(sha(await readFile(join(dir, 'atlas.json'))));
    const atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8'));
    expect(atlas.frames).toHaveLength(64);
    expect(atlas.meta.frameTags.map((tag: { name: string }) => tag.name)).toEqual(Array.from({ length: 8 }, (_, k) => `dir-${k}`));
  }, 120_000);

  it('gives the same sheet and atlas bytes on a second run and overwrites the earlier files', async () => {
    const { dir } = await defaultBake();
    const before = { sheet: await readFile(join(dir, 'sheet.png')), atlas: await readFile(join(dir, 'atlas.json')), manifest: await readFile(join(dir, 'manifest.json')) };
    const again = await bake(glbPath, '--clip', 'sway', '--out', dir);
    expect(again.code, again.stderr).toBe(0);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    expect(before.sheet.equals(await readFile(join(dir, 'sheet.png')))).toBe(true);
    expect(before.atlas.equals(await readFile(join(dir, 'atlas.json')))).toBe(true);
    expect(before.manifest.equals(await readFile(join(dir, 'manifest.json')))).toBe(true);
  }, 120_000);

  it('honours --directions, --phases and --cell and defaults --out to <glb name>-sprites beside the GLB', async () => {
    const outcome = await bake(glbPath, '--clip', 'sway', '--directions', '4', '--phases', '3', '--cell', '16');
    expect(outcome.code, outcome.stderr).toBe(0);
    const result = JSON.parse(outcome.stdout);
    expect(result).toMatchObject({ size: { w: 48, h: 64 }, frames: 12, output: join(root, 'figure-sprites') });
    expect(await list(join(root, 'figure-sprites'))).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    const atlas = JSON.parse(await readFile(join(root, 'figure-sprites', 'atlas.json'), 'utf8'));
    expect(atlas.meta.frameTags).toEqual([0, 1, 2, 3].map(k => ({ name: `dir-${k}`, from: k * 3, to: k * 3 + 2, direction: 'forward' })));
    expect(atlas.frames[0].duration).toBe(400);
  }, 120_000);

  it('states every flag, default and error code in its help', async () => {
    const help = (await run(process.execPath, [script, 'bake', '--help'], { windowsHide: true })).stdout.replace(/\s+/g, ' ');
    for (const text of ['--clip <name>', '--directions <count>', '--phases <count>', '--cell <pixels>', '--out <directory>', '(default: "8")', '(default: "48")',
      'CLIP_NOT_FOUND', 'NO_CLIPS', 'BAKE_CLIP_EMPTY', 'BAKE_CELL_CLIPPED', 'CLI_ARGUMENT_ERROR', 'dir-0', 'sheet.png', 'atlas.json', 'manifest.json']) expect(help).toContain(text);
  });
});

describe('agent-meshes bake failures exit 1 and write nothing', () => {
  const cases: { name: string; args: string[]; code: string; message: RegExp }[] = [
    { name: 'an unknown clip', args: ['--clip', 'run'], code: 'CLIP_NOT_FOUND', message: /No clip named run; clips: sway, overreach, still/ },
    { name: 'a zero-length clip', args: ['--clip', 'still'], code: 'BAKE_CLIP_EMPTY', message: /still/ },
    { name: '--cell 4', args: ['--clip', 'sway', '--cell', '4'], code: 'CLI_ARGUMENT_ERROR', message: /--cell must be an integer from 8 to 256, got 4/ },
    { name: '--directions 0', args: ['--clip', 'sway', '--directions', '0'], code: 'CLI_ARGUMENT_ERROR', message: /--directions must be an integer from 1 to 32, got 0/ },
    { name: '--phases 65', args: ['--clip', 'sway', '--phases', '65'], code: 'CLI_ARGUMENT_ERROR', message: /--phases must be an integer from 1 to 64/ },
    { name: 'a missing --clip', args: [], code: 'CLI_ARGUMENT_ERROR', message: /--clip/ },
    { name: 'a clip that swings past the rest bounds', args: ['--clip', 'overreach'], code: 'BAKE_CELL_CLIPPED', message: /direction \d+ \(dir-\d+.*phase \d+, clip overreach/ },
  ];
  for (const { name, args, code, message } of cases) {
    it(`reports ${code} for ${name}`, async () => {
      const dir = outDir();
      const outcome = await bake(glbPath, ...args, '--out', dir);
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe('');
      const body = failure(outcome);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toMatch(message);
      expect(await list(dir)).toEqual([]);
    }, 120_000);
  }

  it('reports NO_CLIPS for a GLB with no animation', async () => {
    const still = join(root, 'static.glb'), dir = outDir();
    await writeFile(still, await exportGLB({ ...fixtureProject(), clips: [] }));
    const outcome = await bake(still, '--clip', 'sway', '--out', dir);
    expect(outcome.code).toBe(1);
    expect(failure(outcome).error.code).toBe('NO_CLIPS');
    expect(await list(dir)).toEqual([]);
  });
});

// Optional: set AGENT_MESHES_SPRITES_VERIFY to the sprite.js script of a local agent-sprites checkout to run its verifier.
describe.skipIf(!process.env.AGENT_MESHES_SPRITES_VERIFY)('agent-sprites verify of a baked sheet', () => {
  it('passes the 64 frames and dir-0 to dir-7, and fails a tag the sheet lacks', async () => {
    const { dir } = await defaultBake();
    const sprite = process.env.AGENT_MESHES_SPRITES_VERIFY!, tags = Array.from({ length: 8 }, (_, k) => `dir-${k}`);
    const verify = (expected: string[]) => run(process.execPath, [sprite, 'verify', join(dir, 'atlas.json'), '--expect-tags', expected.join(',')]);
    expect((await verify(tags)).stdout).toMatch(/PASS: 64 atlas frames/);
    await expect(verify([...tags, 'dir-8'])).rejects.toMatchObject({ code: 1 });
  }, 120_000);
});
