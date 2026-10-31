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
import { decodePng } from '../src/png.ts';

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

// The 0.38.0 flags: --palette, --outline, --look, --bands and --anchor, through the real entry point.
const DAWN = ['#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161', '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6'];
const CELL = 48;
let dawn: string, broken: string;
const hexOf = (rgba: Uint8Array, i: number) => '#' + [0, 1, 2].map(k => rgba[i + k].toString(16).padStart(2, '0')).join('');
const readOutput = async (dir: string) => ({ sheet: await readFile(join(dir, 'sheet.png')), atlas: await readFile(join(dir, 'atlas.json')), manifest: await readFile(join(dir, 'manifest.json')) });
/** The pivot by projecting the ground point through a hand-built orthographic camera (dir-0, from +Z) from the manifest's camera values. */
function projectedGroundPixel(manifest: { cell: number; camera: { elevationDeg: number; halfExtentM: number; centreM: number[]; groundYM: number } }): { x: number; y: number } {
  const { elevationDeg, halfExtentM, centreM, groundYM } = manifest.camera, e = elevationDeg * Math.PI / 180;
  const back = [0, Math.sin(e), Math.cos(e)], right = [back[2], 0, 0];
  const up = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
  const offset = [0, groundYM - centreM[1], 0];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { x: Math.floor((1 + dot(offset, right) / halfExtentM) / 2 * manifest.cell), y: Math.floor((1 - dot(offset, up) / halfExtentM) / 2 * manifest.cell) };
}

describe('agent-meshes bake with --palette, --outline, --look, --bands and --anchor', () => {
  beforeAll(async () => {
    dawn = join(root, 'dawn.hex');
    broken = join(root, 'broken.hex');
    await writeFile(dawn, `${DAWN.join('\n')}\n`);
    await writeFile(broken, '#000000\n#808080\nnot-a-colour\n');
  });
  const everyFlag = () => ['--phases', '2', '--palette', dawn, '--outline', 'auto', '--look', 'banded', '--bands', '4', '--anchor', 'feet'];
  const cached = new Map<string, Promise<{ dir: string; outcome: Outcome }>>();
  /** One bake per distinct argument list, shared by the tests that only read its output. */
  const baked = (key: string, args: () => string[]) => {
    if (!cached.has(key)) cached.set(key, (async () => { const dir = outDir(); return { dir, outcome: await bake(glbPath, '--clip', 'sway', '--out', dir, ...args()) }; })());
    return cached.get(key)!;
  };

  it('prints the same success keys as before, and writes a sheet of palette colours with the darkest colour on every edge', async () => {
    const { dir, outcome } = await baked('all', everyFlag);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(Object.keys(JSON.parse(outcome.stdout))).toEqual(['output', 'files', 'size', 'frames', 'sheetSha256', 'atlasSha256']);
    expect(await list(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    const image = decodePng(await readFile(join(dir, 'sheet.png')));
    for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i + 3] === 255) expect(DAWN).toContain(hexOf(image.rgba, i));
    // Every opaque pixel with a transparent 4-neighbour, or on the edge of its cell, is the outline colour.
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < image.width && y < image.height && image.rgba[(y * image.width + x) * 4 + 3] === 255;
    const inCell = (x: number, y: number, dx: number, dy: number) => Math.floor((x + dx) / CELL) === Math.floor(x / CELL) && Math.floor((y + dy) / CELL) === Math.floor(y / CELL);
    let edges = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (!opaque(x, y)) continue;
      const solid = ([[-1, 0], [1, 0], [0, -1], [0, 1]] as const).every(([dx, dy]) => inCell(x, y, dx, dy) && opaque(x + dx, y + dy));
      if (!solid) { edges++; expect(hexOf(image.rgba, (y * image.width + x) * 4), `${x},${y}`).toBe('#140c1c'); }
    }
    expect(edges).toBeGreaterThan(100);
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ look: 'banded', bands: 4, outline: '#140c1c', palette: { colors: 16 }, anchor: { name: 'feet' } });
  }, 120_000);

  it('writes the pivot slice at the pixel an independent projection of the manifest camera gives, as one slice for every cell', async () => {
    const { dir } = await baked('all', everyFlag);
    const atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8')), manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(atlas.meta.slices).toHaveLength(1);
    expect(atlas.meta.slices[0]).toMatchObject({ name: 'pivot', color: '#0000ffff' });
    expect(atlas.meta.slices[0].keys).toEqual([{ frame: 0, bounds: { x: 0, y: 0, w: CELL, h: CELL }, pivot: projectedGroundPixel(manifest) }]);
    expect(manifest.anchor).toEqual({ name: 'feet', ...projectedGroundPixel(manifest) });
  }, 120_000);

  it('gives identical bytes for all three files on two runs with every flag', async () => {
    const { dir } = await baked('all', everyFlag);
    const second = await baked('all-again', everyFlag);
    expect(second.outcome.code, second.outcome.stderr).toBe(0);
    const a = await readOutput(dir), b = await readOutput(second.dir);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(b.manifest.equals(a.manifest)).toBe(true);
  }, 120_000);

  it('renders --look unlit and --look banded --bands 4 differently from the lit sheet, and --look lit like no flag', async () => {
    const lit = await baked('lit', () => ['--phases', '2']), litFlag = await baked('lit-flag', () => ['--phases', '2', '--look', 'lit']);
    const unlit = await baked('unlit', () => ['--phases', '2', '--look', 'unlit']), banded = await baked('banded', () => ['--phases', '2', '--look', 'banded', '--bands', '4']);
    for (const { outcome } of [lit, litFlag, unlit, banded]) expect(outcome.code, outcome.stderr).toBe(0);
    const sheet = (dir: string) => readFile(join(dir, 'sheet.png'));
    const reference = await sheet(lit.dir);
    expect((await sheet(litFlag.dir)).equals(reference)).toBe(true);
    expect((await sheet(unlit.dir)).equals(reference)).toBe(false);
    expect((await sheet(banded.dir)).equals(reference)).toBe(false);
    expect((await sheet(banded.dir)).equals(await sheet(unlit.dir))).toBe(false);
  }, 120_000);

  it('leaves the manifest of a bake without the flags free of the new keys', async () => {
    const { dir } = await baked('lit', () => ['--phases', '2']);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8'));
    for (const key of ['look', 'bands', 'palette', 'outline', 'anchor']) expect(manifest).not.toHaveProperty(key);
    expect(manifest.camera).not.toHaveProperty('groundYM');
    expect(atlas.meta).not.toHaveProperty('slices');
  }, 120_000);

  it('states every new flag, its values, defaults and ranges in its help', async () => {
    const help = (await run(process.execPath, [script, 'bake', '--help'], { windowsHide: true })).stdout.replace(/\s+/g, ' ');
    for (const text of ['--palette <file>', '--outline <colour>', '--look <name>', '--bands <count>', '--anchor <name>', '.gpl', 'hex list', '#rrggbb', 'auto', 'lit', 'unlit', 'banded',
      'an integer from 2 to 8', '(default: 3)', 'feet', 'BAKE_ANCHOR_OUTSIDE', 'before Chromium starts']) expect(help).toContain(text);
  });
});

describe('agent-meshes bake rejects bad 0.38.0 flags before Chromium starts and writes nothing', () => {
  const cases: { name: string; args: () => string[]; message: RegExp }[] = [
    { name: '--bands 3 without --look banded', args: () => ['--bands', '3'], message: /--bands needs --look banded/ },
    { name: '--bands 9', args: () => ['--look', 'banded', '--bands', '9'], message: /--bands must be an integer from 2 to 8, got 9/ },
    { name: '--outline auto without --palette', args: () => ['--outline', 'auto'], message: /--outline auto needs --palette/ },
    { name: '--outline #112233 with a palette that lacks it', args: () => ['--palette', dawn, '--outline', '#112233'], message: /--outline #112233 is not a colour of the palette/ },
    { name: 'a missing palette file', args: () => ['--palette', join(root, 'no-such-palette.hex')], message: /Cannot read the palette file/ },
    { name: 'an invalid palette line', args: () => ['--palette', broken], message: /line 3/ },
    { name: '--anchor head', args: () => ['--anchor', 'head'], message: /--anchor must be feet, got head/ },
    { name: '--look dark', args: () => ['--look', 'dark'], message: /--look must be one of lit, unlit, banded/ },
  ];
  for (const { name, args, message } of cases) {
    it(`exits 1 with CLI_ARGUMENT_ERROR for ${name}`, async () => {
      const dir = outDir(), started = Date.now();
      const outcome = await bake(glbPath, '--clip', 'sway', '--out', dir, ...args());
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe('');
      const body = failure(outcome);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(body.error.message).toMatch(message);
      expect(await list(dir)).toEqual([]);
      // Node starting and the options being refused; a Chromium launch alone takes longer than this.
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 120_000);
  }
});

// Optional: needs the same AGENT_MESHES_SPRITES_VERIFY script as above. A palette-less fixture of eight colours would pass
// --max-colors 16 on its own, so this one paints every part a different colour and rounds the head and body, which shade smoothly, so the lit render has more than 16.
describe.skipIf(!process.env.AGENT_MESHES_SPRITES_VERIFY)('agent-sprites verify of a bake with a palette, an outline and an anchor', () => {
  const tags = Array.from({ length: 8 }, (_, k) => `dir-${k}`).join(',');
  const sprite = () => process.env.AGENT_MESHES_SPRITES_VERIFY!;
  const verify = (dir: string, ...extra: string[]) => run(process.execPath, [sprite(), 'verify', join(dir, 'atlas.json'), '--expect-tags', tags, ...extra]);
  const colours = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#ecf0f1'];
  let coloured: string, palette: string;
  const bakeColoured = async (...args: string[]) => {
    const dir = outDir(), outcome = await bake(coloured, '--clip', 'sway', '--phases', '2', '--out', dir, ...args);
    expect(outcome.code, outcome.stderr).toBe(0);
    return dir;
  };
  beforeAll(async () => {
    const project = fixtureProject();
    coloured = join(root, 'coloured.glb');
    palette = join(root, 'dawn16.hex');
    await writeFile(coloured, await exportGLB({ ...project, parts: project.parts.map((part, i) => ({ ...part, color: colours[i % colours.length], geometry: part.name === 'head' || part.name === 'body' ? { ...part.geometry, type: 'sphere' as const } : part.geometry })) }));
    await writeFile(palette, `${DAWN.join('\n')}\n`);
  });

  it('passes --max-colors 16 and --outline-colors with the darkest palette colour, and 8 direction tags', async () => {
    const dir = await bakeColoured('--palette', palette, '--outline', 'auto');
    const result = await verify(dir, '--max-colors', '16', '--outline-colors', DAWN[0]);
    expect(result.stdout).toMatch(/PASS: 16 atlas frames/);
  }, 120_000);

  it('fails --max-colors 16 and --outline-colors for the same bake without the flags', async () => {
    const dir = await bakeColoured();
    await expect(verify(dir, '--max-colors', '16')).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/palette-budget/) });
    await expect(verify(dir, '--outline-colors', DAWN[0])).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/outline-gap/) });
  }, 120_000);

  it('still passes verify with --anchor feet', async () => {
    const dir = await bakeColoured('--anchor', 'feet');
    expect((await verify(dir)).stdout).toMatch(/PASS: 16 atlas frames/);
    expect(JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8')).meta.slices).toHaveLength(1);
  }, 120_000);
});
