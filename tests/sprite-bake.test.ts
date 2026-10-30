/** @lane merge
 * @subject src/sprite-bake.ts
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';
import { decodePng } from '../src/png.ts';
import { bakeClipInfo, bakeSprites, parseBakeOptions, reduceCell, touchesBorder } from '../src/sprite-bake.ts';
import { checkAtlasContract, type Atlas } from '../src/sprite-atlas.ts';

// The fixture is a small rigged figure that differs left to right (a long arm on +X, a stub on -X) and front to back
// (a nose on +Z), built from core operations and the Node exporter, so no Blender is needed and no binary is committed.
// `sway` stays inside the rest bounds; `overreach` slides the shoulder 0.6 m out, so the arm tip leaves them.
const DURATION = 1.2, KEYS = 12;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const sway: Clip = {
  name: 'sway', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'rotation', keys: times.map((time, i) => ({ time, value: aboutZ(i === KEYS ? 0 : 25 * Math.sin(2 * Math.PI * time / DURATION)) })) },
    { bone: 'root', property: 'position', keys: times.map((time, i) => ({ time, value: [0, i === KEYS ? 0 : 0.02 * Math.sin(2 * Math.PI * time / DURATION), 0] as [number, number, number] })) },
  ],
};
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

let root: string, glbPath: string, glb: Buffer;
let runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-bake-'));
  glbPath = join(root, 'figure.glb');
  glb = Buffer.from(await exportGLB(fixtureProject()));
  await writeFile(glbPath, glb);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const outDir = () => join(root, `out-${runs++}`);
const files = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
const read = async (dir: string) => ({ sheet: await readFile(join(dir, 'sheet.png')), atlas: await readFile(join(dir, 'atlas.json')), manifest: await readFile(join(dir, 'manifest.json')) });
/** Mean x of the opaque pixels of one cell, measured from the cell centre: negative is left of centre. */
function centroidX(rgba: Uint8Array, width: number, cell: number, direction: number, phase: number): number {
  let count = 0, sum = 0;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++)
    if (rgba[((direction * cell + y) * width + phase * cell + x) * 4 + 3] === 255) { count++; sum += x; }
  expect(count, `direction ${direction} phase ${phase} has no opaque pixels`).toBeGreaterThan(0);
  return sum / count - (cell - 1) / 2;
}

describe('bake the asymmetric fixture at the defaults', () => {
  it('writes the three files, with the same bytes on a second run in this environment', async () => {
    const first = outDir(), second = outDir();
    const a = await bakeSprites(glbPath, { clip: 'sway', out: first });
    const b = await bakeSprites(glbPath, { clip: 'sway', out: second });
    expect(await files(first)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
    const x = await read(first), y = await read(second);
    expect(x.sheet.equals(y.sheet)).toBe(true);
    expect(x.atlas.equals(y.atlas)).toBe(true);
    expect(x.manifest.equals(y.manifest)).toBe(true);
    expect(a).toMatchObject({ output: first, files: { sheet: 'sheet.png', atlas: 'atlas.json', manifest: 'manifest.json' }, size: { w: 384, h: 384 }, frames: 64, sheetSha256: sha(x.sheet), atlasSha256: sha(x.atlas) });
    expect([b.sheetSha256, b.atlasSha256]).toEqual([a.sheetSha256, a.atlasSha256]);
  }, 120_000);

  it('makes a 384 by 384 sheet, an atlas of 64 frames with dir-0 to dir-7 tags, and a manifest that records the bake', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir });
    const { sheet, atlas: atlasBytes, manifest: manifestBytes } = await read(dir);
    const image = decodePng(sheet);
    expect([image.width, image.height]).toEqual([384, 384]);
    const atlas = JSON.parse(atlasBytes.toString('utf8')) as Atlas;
    expect(atlas.frames).toHaveLength(64);
    expect(atlas.meta.frameTags.map(tag => tag.name)).toEqual(Array.from({ length: 8 }, (_, k) => `dir-${k}`));
    expect(atlas.frames.every(frame => frame.duration === 150)).toBe(true);
    expect(checkAtlasContract(atlas, { sheet: { width: 384, height: 384 }, expectedTags: atlas.meta.frameTags.map(tag => tag.name) })).toEqual([]);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    expect(manifest).toMatchObject({
      model: { sha256: sha(glb) }, clip: { name: 'sway', durationMs: 1200 }, directions: 8, phases: 8, cell: 48,
      camera: { projection: 'orthographic', elevationDeg: 15, padding: 1.25 },
      sheet: { file: 'sheet.png', width: 384, height: 384, sha256: sha(sheet) }, atlas: { file: 'atlas.json', frames: 64, sha256: sha(atlasBytes) },
    });
    expect(manifest.camera.halfExtentM).toBeGreaterThan(0);
    // No timestamp, absolute path or temp path in either text file.
    for (const text of [atlasBytes.toString('utf8'), manifestBytes.toString('utf8')]) {
      expect(text).not.toContain(root);
      expect(text).not.toMatch(/[A-Za-z]:[\\/]|\\\\|\/tmp|T\d\d:\d\d/);
    }
    expect(atlasBytes.toString('utf8')).not.toMatch(/version/i);
  }, 120_000);

  it('gives every pixel alpha 0 or 255 and the colour 0, 0, 0 to every transparent pixel', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir });
    const { rgba } = decodePng(await readFile(join(dir, 'sheet.png')));
    let opaque = 0, clear = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3];
      expect(alpha === 0 || alpha === 255).toBe(true);
      if (alpha === 255) opaque++;
      else { clear++; expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([0, 0, 0]); }
    }
    expect(opaque).toBeGreaterThan(5000);
    expect(clear).toBeGreaterThan(50000);
  }, 120_000);

  it('orders the directions by azimuth from +Z: dir-0 and dir-4 mirror left to right, and dir-2 and dir-6 differ', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir });
    const { rgba, width } = decodePng(await readFile(join(dir, 'sheet.png')));
    const at = (direction: number) => centroidX(rgba, width, 48, direction, 0);
    // The arm reaches toward +X, and the frame is centred on the rest bounds, so the body mass sits left of centre when
    // +X is on the right (dir-0, looking from +Z) and right of centre from the opposite side (dir-4).
    expect(at(0)).toBeLessThan(-3);
    expect(at(4)).toBeGreaterThan(3);
    expect(Math.abs(at(0) + at(4))).toBeLessThan(1.5);
    // Seen from +X and from -X the arm is end on; the nose on +Z puts the mass on opposite sides.
    expect(at(2)).toBeGreaterThan(1);
    expect(at(6)).toBeLessThan(-1);
  }, 120_000);

  it('keeps the same scale in every cell: the fitted frame does not follow the pose', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, directions: 2, phases: 4, cell: 32 });
    const { rgba, width } = decodePng(await readFile(join(dir, 'sheet.png')));
    // The root bobs 2 cm and the arm swings about a fixed shoulder, so the body never changes size: its mass per cell stays near constant.
    const mass = (direction: number, phase: number) => { let n = 0; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (rgba[((direction * 32 + y) * width + phase * 32 + x) * 4 + 3] === 255) n++; return n; };
    for (let direction = 0; direction < 2; direction++) {
      const counts = [0, 1, 2, 3].map(phase => mass(direction, phase));
      expect(Math.max(...counts) / Math.min(...counts), counts.join(',')).toBeLessThan(1.25);
    }
  }, 120_000);
});

describe('bake without a browser', () => {
  it('reads the clip names and length from the GLB and raises the clip errors', () => {
    expect(bakeClipInfo(glb, 'sway')).toMatchObject({ names: ['sway', 'overreach'] });
    expect(bakeClipInfo(glb, 'sway').durationSeconds).toBeCloseTo(1.2, 5);
    expect(() => bakeClipInfo(glb, 'run')).toThrow(/No clip named run; clips: sway, overreach/);
    expect(() => bakeClipInfo(glb, 'run')).toThrow(expect.objectContaining({ code: 'CLIP_NOT_FOUND' }));
  });

  it('raises NO_CLIPS for a GLB with no animation and BAKE_CLIP_EMPTY for a clip whose times are all zero', async () => {
    const still = Buffer.from(await exportGLB({ ...fixtureProject(), clips: [] }));
    expect(() => bakeClipInfo(still, 'sway')).toThrow(expect.objectContaining({ code: 'NO_CLIPS' }));
    // The schema refuses a zero-length clip, so write one by zeroing the key times of a valid clip.
    const copy = Uint8Array.from(glb), doc = readGLB(copy);
    const animation = (doc.json as { animations: { name: string; samplers: { input: number }[] }[] }).animations.find(a => a.name === 'sway')!;
    for (const sampler of animation.samplers) {
      const accessor = doc.json.accessors![sampler.input] as { bufferView: number; byteOffset?: number; count: number }, view = doc.json.bufferViews![accessor.bufferView];
      const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      doc.bin!.fill(0, at, at + accessor.count * 4);
    }
    expect(() => bakeClipInfo(copy, 'sway')).toThrow(expect.objectContaining({ code: 'BAKE_CLIP_EMPTY' }));
  });

  it('checks the flag ranges and defaults', () => {
    expect(parseBakeOptions({ clip: 'sway' })).toMatchObject({ directions: 8, phases: 8, cell: 48 });
    expect(parseBakeOptions({ clip: 'sway', directions: '32', phases: '64', cell: '256' })).toMatchObject({ directions: 32, phases: 64, cell: 256 });
    expect(parseBakeOptions({ clip: 'sway', directions: 1, phases: 1, cell: 8 })).toMatchObject({ directions: 1, phases: 1, cell: 8 });
    for (const bad of [{ directions: 0 }, { directions: 33 }, { directions: '2.5' }, { phases: 0 }, { phases: 65 }, { cell: 7 }, { cell: 4 }, { cell: 257 }, { cell: 'big' }, { cell: '-8' }, { cell: Number.NaN }])
      expect(() => parseBakeOptions({ clip: 'sway', ...bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR' }));
    expect(() => parseBakeOptions({ clip: '' })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR' }));
  });

  it('reduces a render by the centre pixel of each 8 by 8 block and snaps alpha at 128', () => {
    const cell = 2, render = 16, rgba = Buffer.alloc(render * render * 4);
    const put = (x: number, y: number, pixel: number[]) => rgba.set(pixel, (y * render + x) * 4);
    put(4, 4, [10, 20, 30, 200]);   // block (0, 0): centre, alpha 200 -> opaque
    put(0, 0, [255, 255, 255, 255]); // a corner of block (0, 0) is ignored
    put(12, 4, [90, 91, 92, 127]);  // block (1, 0): centre, alpha 127 -> transparent, colour cleared
    put(4, 12, [50, 60, 70, 128]);  // block (0, 1): centre, alpha 128 -> opaque
    put(5, 12, [1, 1, 1, 255]);     // beside the centre: ignored
    const out = reduceCell(rgba, cell);
    expect([...out.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect([...out.subarray(8, 12)]).toEqual([50, 60, 70, 255]);
    expect([...out.subarray(12, 16)]).toEqual([0, 0, 0, 0]);
    expect(() => reduceCell(rgba.subarray(4), cell)).toThrow(/needs/);
  });

  it('finds an opaque pixel on the outer ring and nowhere else', () => {
    const cell = 8, pixels = Buffer.alloc(cell * cell * 4);
    expect(touchesBorder(pixels, cell)).toBe(false);
    pixels[(3 * cell + 3) * 4 + 3] = 255;
    expect(touchesBorder(pixels, cell)).toBe(false);
    for (const [x, y] of [[0, 3], [7, 3], [3, 0], [3, 7]]) {
      const copy = Buffer.from(pixels); copy[(y * cell + x) * 4 + 3] = 255;
      expect(touchesBorder(copy, cell), `${x},${y}`).toBe(true);
    }
  });

  it('refuses a clip that swings past the rest bounds, naming the direction, phase and clip, and writes nothing', async () => {
    const dir = outDir();
    await expect(bakeSprites(glbPath, { clip: 'overreach', out: dir, directions: 2, phases: 4, cell: 16 })).rejects.toMatchObject({
      code: 'BAKE_CELL_CLIPPED', message: expect.stringMatching(/direction 0 \(dir-0.*phase 1, clip overreach/),
    });
    expect(await files(dir)).toEqual([]);
  }, 120_000);
});
