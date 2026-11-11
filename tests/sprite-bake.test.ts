/** @lane merge
 * @subject src/sprite-bake.ts
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import type { Clip, Project } from '../src/core/types.ts';
import { exportGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';
import { decodePng } from '../src/png.ts';
import { bakeClipInfo, bakeSprites, feetPivot, harness, parseBakeOptions, reduceCell, touchesBorder } from '../src/sprite-bake.ts';
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

/** One bake at the defaults, shared by the tests that only read its output. A failed bake rejects for each of them. */
let defaults: Promise<{ dir: string; result: Awaited<ReturnType<typeof bakeSprites>> }> | undefined;
const defaultBake = () => defaults ??= (async () => { const dir = outDir(); return { dir, result: await bakeSprites(glbPath, { clip: 'sway', out: dir }) }; })();
/** The bake that clips (`overreach` leaves the rest bounds), shared by the tests that read its error and its empty folder. */
let clipped: Promise<{ dir: string; error: unknown }> | undefined;
const clippedBake = () => clipped ??= (async () => {
  const dir = outDir();
  return { dir, error: await bakeSprites(glbPath, { clip: 'overreach', out: dir, directions: 2, phases: 4, cell: 16 }).then(() => undefined, (caught: unknown) => caught) };
})();

describe('bake the asymmetric fixture at the defaults', () => {
  it('writes the three files, with the same bytes on a second run in this environment', async () => {
    const { dir: first, result: a } = await defaultBake(), second = outDir();
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
    const { dir } = await defaultBake();
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
    const { dir } = await defaultBake();
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
    const { dir } = await defaultBake();
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
    const { dir, error } = await clippedBake();
    expect(error).toMatchObject({
      code: 'BAKE_CELL_CLIPPED', message: expect.stringMatching(/direction 0 \(dir-0.*phase 1, clip overreach/),
    });
    expect(await files(dir)).toEqual([]);
  }, 120_000);
});

describe('the bake harness mount options', () => {
  // The centre-pixel reduction hides the edge difference antialiasing makes, so the pixel tests cannot catch it being turned on.
  // Read the options object the harness passes to MeshViewer.mount and pin it.
  const mountOptions = (): Record<string, unknown> => {
    const page = harness(384).replace('@GLB@', 'AAAA');
    const literal = /MeshViewer\.mount\(document\.getElementById\('stage'\), (\{.*\})\)\.then/s.exec(page)?.[1];
    expect(literal).toBeTruthy();
    return new Function('document', `return (${literal});`)({ getElementById: () => ({ textContent: 'AAAA' }) });
  };

  it('mounts the viewer without antialiasing, shadows or any scene dressing', () => {
    const options = mountOptions();
    expect(options).toMatchObject({ background: null, floor: false, projection: 'orthographic', autoplay: false, orbit: false });
    expect(options.quality).toEqual({ pixelRatio: 1, shadows: false, antialias: false });
  });
});

// The options added in 0.38.0 (palette, outline, look, bands, anchor). Renders use 4 directions and 2 phases to stay quick.
const SMALL = { directions: 4, phases: 2 } as const;
const DAWN = ['#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161', '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6'];
const hexOf = (rgba: Uint8Array, i: number) => '#' + [0, 1, 2].map(k => rgba[i + k].toString(16).padStart(2, '0')).join('');
/** Every cell of a decoded sheet as its pixels, row-major by cell index. */
function cellsOf(image: { rgba: Uint8Array; width: number; height: number }, cell: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let row = 0; row < image.height / cell; row++) for (let column = 0; column < image.width / cell; column++) {
    const pixels = new Uint8Array(cell * cell * 4);
    for (let y = 0; y < cell; y++) pixels.set(image.rgba.subarray(((row * cell + y) * image.width + column * cell) * 4, ((row * cell + y) * image.width + (column + 1) * cell) * 4), y * cell * 4);
    out.push(pixels);
  }
  return out;
}
/** The pivot by projecting the ground point through a hand-built orthographic camera (dir-0, from +Z) with unit right and up axes, not by the closed form in the source. */
function projectedGroundPixel(manifest: { cell: number; camera: { elevationDeg: number; halfExtentM: number; centreM: number[]; groundYM: number } }): { x: number; y: number } {
  const { elevationDeg, halfExtentM, centreM, groundYM } = manifest.camera, e = elevationDeg * Math.PI / 180;
  const back = [0, Math.sin(e), Math.cos(e)];                       // from the target toward the camera
  const right = [1, 0, 0];                                          // world up x back, normalised: +X
  const up = [0, back[2], -back[1]];                                // back x right, unit length: (0, cos e, -sin e)
  const offset = [0, groundYM - centreM[1], 0];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sx = dot(offset, right) / halfExtentM, sy = dot(offset, up) / halfExtentM;
  // Continuous position from the top-left corner of the cell; the pixel whose centre sample is nearest is the floor.
  return { x: Math.floor((1 + sx) / 2 * manifest.cell), y: Math.floor((1 - sy) / 2 * manifest.cell) };
}
/** A cone with its point down on the vertical axis through the bounds centre, turning about that axis: the lowest point is a known tip. */
async function tipFixture(): Promise<Buffer> {
  let project = createProject('tip-fixture');
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'add', part: { name: 'spike', geometry: { type: 'lathe', size: [1, 1, 1], segments: 16, profileUnits: 'metres', profile: [[0, 0], [0.3, 0.15], [0.3, 0.5], [0, 0.5]] }, position: [0, 0, 0] } });
  project = applyOperation(project, { op: 'bind', name: 'spike', binding: { type: 'rigid', bone: 'root' } });
  const about = (degrees: number): [number, number, number, number] => [0, Math.sin(degrees * Math.PI / 360), 0, Math.cos(degrees * Math.PI / 360)];
  const turn: Clip = { name: 'turn', duration: 1, tracks: [{ bone: 'root', property: 'rotation', keys: [0, 0.5, 1].map((time, i) => ({ time, value: about(i === 1 ? 30 : 0) })) }] };
  return Buffer.from(await exportGLB({ ...project, clips: [turn] }));
}

const baked = new Map<string, Promise<{ dir: string; sheet: ReturnType<typeof decodePng>; manifest: any; atlas: Atlas }>>();
/** One bake per distinct option set, shared by the tests below that only read its output. A failed bake rejects for each of them. */
const bakeWith = (key: string, options: Record<string, unknown>) => {
  if (!baked.has(key)) baked.set(key, (async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, ...options });
    const out = await read(dir);
    return { dir, sheet: decodePng(out.sheet), manifest: JSON.parse(out.manifest.toString('utf8')), atlas: JSON.parse(out.atlas.toString('utf8')) as Atlas };
  })());
  return baked.get(key)!;
};
/** The bake with `SMALL` and no other option: the reference every option below is compared with. */
const plainBake = () => bakeWith('plain', {});

describe('a bake with none of the 0.38.0 options is the 0.37.0 bake', () => {
  it('keeps the 0.37.0 key lists: no slices, no look, palette, outline or anchor, no extra camera value', async () => {
    const { dir } = await plainBake();
    const { atlas, manifest } = await read(dir);
    expect(Object.keys((JSON.parse(atlas.toString('utf8')) as Atlas).meta)).toEqual(['app', 'image', 'format', 'size', 'scale', 'frameTags']);
    const parsed = JSON.parse(manifest.toString('utf8'));
    expect(Object.keys(parsed)).toEqual(['format', 'pluginVersion', 'model', 'clip', 'directions', 'phases', 'cell', 'camera', 'sheet', 'atlas']);
    expect(Object.keys(parsed.camera)).toEqual(['centreM', 'distanceM', 'elevationDeg', 'halfExtentM', 'padding', 'projection', 'supersample']);
  }, 120_000);

  it('gives the same sheet, atlas and manifest bytes when every new option is passed as unset', async () => {
    const { dir: plain } = await plainBake(), unset = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: unset, ...SMALL, palette: undefined, outline: undefined, look: undefined, bands: undefined, anchor: undefined });
    const a = await read(plain), b = await read(unset);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(b.manifest.equals(a.manifest)).toBe(true);
  }, 120_000);

  it('renders --look lit exactly as the default and records only the look in the manifest', async () => {
    const { dir: plain } = await plainBake(), lit = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: lit, ...SMALL, look: 'lit' });
    const a = await read(plain), b = await read(lit);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(JSON.parse(b.manifest.toString('utf8'))).toEqual({ ...JSON.parse(a.manifest.toString('utf8')), look: 'lit' });
  }, 120_000);
});

describe('the 0.38.0 options are checked before Chromium starts', () => {
  const palettes: Record<string, string> = {};
  beforeAll(async () => {
    const write = async (name: string, text: string) => { palettes[name] = join(root, name); await writeFile(palettes[name], text); };
    await write('dawn.hex', DAWN.join('\n') + '\n');
    await write('dawn-notes.hex', `; DB16\n\n${DAWN.slice(0, 3).join('\n')}\n`);
    await write('mono.hex', '#000000\n#808080\n#ffffff\n');
    await write('broken.hex', '#000000\n#808080\nnot-a-colour\n');
    await write('empty.hex', '; nothing here\n');
    await write('dawn.gpl', `GIMP Palette\nName: dawn\n#\n${DAWN.map(h => `${parseInt(h.slice(1, 3), 16)} ${parseInt(h.slice(3, 5), 16)} ${parseInt(h.slice(5, 7), 16)} c${h}`).join('\n')}\n`);
  });

  it('resolves the options: --outline auto is the darkest palette colour, a hex outline is lowercased, --bands defaults to 3 with banded', () => {
    expect(parseBakeOptions({ clip: 'sway', palette: palettes['dawn.hex'], outline: 'auto' })).toMatchObject({ outline: '#140c1c', outlineColor: [20, 12, 28] });
    expect(parseBakeOptions({ clip: 'sway', palette: palettes['dawn.gpl'], outline: 'auto' }).outline).toBe('#140c1c');
    expect(parseBakeOptions({ clip: 'sway', outline: '#AABBCC' })).toMatchObject({ outline: '#aabbcc', outlineColor: [170, 187, 204] });
    expect(parseBakeOptions({ clip: 'sway', palette: palettes['dawn.hex'], outline: '#D04648' }).outline).toBe('#d04648');
    expect(parseBakeOptions({ clip: 'sway', look: 'banded' })).toMatchObject({ look: 'banded', bands: 3 });
    expect(parseBakeOptions({ clip: 'sway', look: 'banded', bands: '8' })).toMatchObject({ bands: 8 });
    expect(parseBakeOptions({ clip: 'sway', look: 'unlit', anchor: 'feet' })).toMatchObject({ look: 'unlit', anchor: 'feet' });
    expect(parseBakeOptions({ clip: 'sway' })).toEqual({ clip: 'sway', directions: 8, phases: 8, cell: 48, out: undefined });
  });

  const cases: { name: string; options: () => Record<string, unknown>; message: RegExp }[] = [
    { name: '--bands without --look banded', options: () => ({ bands: 3 }), message: /--bands needs --look banded/ },
    { name: '--bands with --look unlit', options: () => ({ look: 'unlit', bands: '4' }), message: /--bands needs --look banded/ },
    { name: '--bands 9', options: () => ({ look: 'banded', bands: 9 }), message: /--bands must be an integer from 2 to 8, got 9/ },
    { name: '--bands 1', options: () => ({ look: 'banded', bands: 1 }), message: /--bands must be an integer from 2 to 8/ },
    { name: '--look dark', options: () => ({ look: 'dark' }), message: /--look must be one of lit, unlit, banded, got dark/ },
    { name: '--outline auto without --palette', options: () => ({ outline: 'auto' }), message: /--outline auto needs --palette/ },
    { name: '--outline that is not a colour', options: () => ({ outline: 'black' }), message: /--outline must be #rrggbb or auto, got black/ },
    { name: '--outline #112233 with a palette that lacks it', options: () => ({ palette: palettes['dawn.hex'], outline: '#112233' }), message: /--outline #112233 is not a colour of the palette/ },
    { name: 'a missing palette file', options: () => ({ palette: join(root, 'missing.hex') }), message: /Cannot read the palette file/ },
    { name: 'an invalid palette line', options: () => ({ palette: palettes['broken.hex'] }), message: /line 3/ },
    { name: 'a palette with no colours', options: () => ({ palette: palettes['empty.hex'] }), message: /holds no colours/ },
    { name: '--anchor head', options: () => ({ anchor: 'head' }), message: /--anchor must be feet, got head/ },
  ];
  for (const { name, options, message } of cases) {
    it(`rejects ${name} with CLI_ARGUMENT_ERROR, writes nothing and never launches the browser`, async () => {
      const launch = vi.spyOn(chromium, 'launch'), dir = outDir();
      try {
        await expect(bakeSprites(glbPath, { clip: 'sway', out: dir, ...options() })).rejects.toMatchObject({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringMatching(message) });
        expect(launch).not.toHaveBeenCalled();
        expect(await files(dir)).toEqual([]);
      } finally { launch.mockRestore(); }
    });
  }

  it('accepts a hex list with comments and a .gpl palette of the same colours', () => {
    expect(parseBakeOptions({ clip: 'sway', palette: palettes['dawn-notes.hex'] }).palette?.hex).toEqual(DAWN.slice(0, 3));
    expect(parseBakeOptions({ clip: 'sway', palette: palettes['dawn.gpl'] }).palette?.hex).toEqual(DAWN);
  });
});

describe('palette, outline, look and anchor on the asymmetric fixture', () => {
  const CELL = 48;
  let dawn: string;
  const sheetOf = async (dir: string) => decodePng(await readFile(join(dir, 'sheet.png')));
  beforeAll(async () => { dawn = join(root, 'dawn-render.hex'); await writeFile(dawn, DAWN.join('\n') + '\n'); });

  /** Byte offsets of the opaque pixels of a cell that have a transparent 4-neighbour or sit on the cell edge. */
  const boundary = (pixels: Uint8Array): number[] => {
    const out: number[] = [];
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < CELL && y < CELL && pixels[(y * CELL + x) * 4 + 3] === 255;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++)
      if (opaque(x, y) && !(opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1))) out.push((y * CELL + x) * 4);
    return out;
  };

  it('snaps every opaque pixel of the sheet to a palette colour and uses more than one of them', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, palette: dawn });
    const { rgba } = await sheetOf(dir), seen = new Set<string>();
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 255) { expect(DAWN).toContain(hexOf(rgba, i)); seen.add(hexOf(rgba, i)); }
      else expect([...rgba.subarray(i, i + 4)]).toEqual([0, 0, 0, 0]);
    }
    expect(seen.size).toBeGreaterThan(1);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.palette).toMatchObject({ colors: 16, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(manifest).not.toHaveProperty('outline');
  }, 120_000);

  it('outlines the silhouette in a hex colour with no palette: every edge pixel is the outline colour, and the model is untouched inside', async () => {
    const { dir: plain } = await plainBake(), dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, outline: '#ff00ff' });
    const before = cellsOf(await sheetOf(plain), CELL), after = cellsOf(await sheetOf(dir), CELL);
    for (const [i, pixels] of after.entries()) {
      const edge = boundary(pixels);
      expect(edge.length).toBeGreaterThan(20);
      for (const at of edge) expect(hexOf(pixels, at), `cell ${i}`).toBe('#ff00ff');
      // Every pixel the plain bake had opaque keeps its colour; the outline only adds pixels around it.
      for (let at = 0; at < pixels.length; at += 4) if (before[i][at + 3] === 255) expect([...pixels.subarray(at, at + 4)]).toEqual([...before[i].subarray(at, at + 4)]);
    }
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ outline: '#ff00ff' });
  }, 120_000);

  it('outlines with --outline auto in the darkest palette colour, so the whole sheet stays in the palette', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, palette: dawn, outline: 'auto' });
    const image = await sheetOf(dir);
    for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i + 3] === 255) expect(DAWN).toContain(hexOf(image.rgba, i));
    for (const [i, pixels] of cellsOf(image, CELL).entries()) for (const at of boundary(pixels)) expect(hexOf(pixels, at), `cell ${i}`).toBe('#140c1c');
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ outline: '#140c1c' });
  }, 120_000);

  it('lets the outline reach the cell border ring, which is not a clipped cell because the check is made before the outline', async () => {
    const small = 12, plain = outDir(), outlinedDir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: plain, ...SMALL, cell: small });
    await bakeSprites(glbPath, { clip: 'sway', out: outlinedDir, ...SMALL, cell: small, outline: '#ff00ff' });
    const ring = (x: number, y: number) => x === 0 || y === 0 || x === small - 1 || y === small - 1;
    const count = (image: { rgba: Uint8Array; width: number; height: number }, magenta: boolean) => {
      let n = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const at = (y * image.width + x) * 4;
        if (ring(x % small, y % small) && image.rgba[at + 3] === 255 && (hexOf(image.rgba, at) === '#ff00ff') === magenta) n++;
      }
      return n;
    };
    const unoutlined = await sheetOf(plain);
    expect(count(unoutlined, true) + count(unoutlined, false)).toBe(0);
    const outlined = await sheetOf(outlinedDir);
    expect(count(outlined, true)).toBeGreaterThan(0);
    expect(count(outlined, false)).toBe(0);
  }, 120_000);

  it('writes the pivot slice at the pixel the ground point projects to, in one slice for every cell', async () => {
    const dir = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, anchor: 'feet' });
    const atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8')) as Atlas, manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(Object.keys(atlas.meta)).toEqual(['app', 'image', 'format', 'size', 'scale', 'frameTags', 'slices']);
    expect(atlas.meta.slices).toHaveLength(1);
    const [slice] = atlas.meta.slices!;
    expect(slice).toMatchObject({ name: 'pivot', color: '#0000ffff' });
    expect(slice.keys).toHaveLength(1);
    expect(slice.keys[0]).toMatchObject({ frame: 0, bounds: { x: 0, y: 0, w: CELL, h: CELL } });
    const expected = projectedGroundPixel(manifest);
    expect(slice.keys[0].pivot).toEqual(expected);
    expect(feetPivot({ cell: CELL, elevationDeg: manifest.camera.elevationDeg, halfExtentM: manifest.camera.halfExtentM, centreYM: manifest.camera.centreM[1], groundYM: manifest.camera.groundYM })).toEqual(expected);
    expect(manifest.anchor).toEqual({ name: 'feet', x: expected.x, y: expected.y });
    expect(checkAtlasContract(atlas)).toEqual([]);
    // The figure stands on y = 0, and the camera's ground height is the rest bounds' lowest point.
    expect(manifest.camera.groundYM).toBeCloseTo(0, 5);
  }, 120_000);

  it('puts the pivot on the lowest point of a pointed model in every direction and phase', async () => {
    const tip = join(root, 'tip.glb'), dir = outDir();
    await writeFile(tip, await tipFixture());
    await bakeSprites(tip, { clip: 'turn', out: dir, directions: 4, phases: 3, anchor: 'feet' });
    const atlas = JSON.parse(await readFile(join(dir, 'atlas.json'), 'utf8')) as Atlas, manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const pivot = atlas.meta.slices![0].keys[0].pivot;
    expect(pivot).toEqual(projectedGroundPixel(manifest));
    const cells = cellsOf(await sheetOf(dir), CELL);
    expect(cells).toHaveLength(12);
    for (const [i, pixels] of cells.entries()) {
      let lowest = -1;
      const columns: number[] = [];
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (pixels[(y * CELL + x) * 4 + 3] === 255) { if (y > lowest) { lowest = y; columns.length = 0; } if (y === lowest) columns.push(x); }
      expect(Math.abs(lowest - pivot.y), `cell ${i} lowest row ${lowest}, pivot ${pivot.y}`).toBeLessThanOrEqual(1);
      expect(Math.min(...columns.map(x => Math.abs(x - pivot.x))), `cell ${i} columns ${columns}`).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('renders --look unlit and --look banded differently from lit and from each other, and records them', async () => {
    const dirs = { lit: (await plainBake()).dir, unlit: outDir(), banded: outDir() };
    await bakeSprites(glbPath, { clip: 'sway', out: dirs.unlit, ...SMALL, look: 'unlit' });
    await bakeSprites(glbPath, { clip: 'sway', out: dirs.banded, ...SMALL, look: 'banded', bands: 4 });
    const sheets = { lit: await readFile(join(dirs.lit, 'sheet.png')), unlit: await readFile(join(dirs.unlit, 'sheet.png')), banded: await readFile(join(dirs.banded, 'sheet.png')) };
    expect(sheets.unlit.equals(sheets.lit)).toBe(false);
    expect(sheets.banded.equals(sheets.lit)).toBe(false);
    expect(sheets.banded.equals(sheets.unlit)).toBe(false);
    expect(JSON.parse(await readFile(join(dirs.unlit, 'manifest.json'), 'utf8'))).toMatchObject({ look: 'unlit' });
    expect(JSON.parse(await readFile(join(dirs.banded, 'manifest.json'), 'utf8'))).toMatchObject({ look: 'banded', bands: 4 });
  }, 120_000);

  it('gives identical bytes for all three files on two runs with every option together', async () => {
    const first = outDir(), second = outDir();
    const all = { clip: 'sway', ...SMALL, palette: dawn, outline: 'auto', look: 'banded', bands: 4, anchor: 'feet' };
    await bakeSprites(glbPath, { ...all, out: first });
    await bakeSprites(glbPath, { ...all, out: second });
    const a = await read(first), b = await read(second);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(b.manifest.equals(a.manifest)).toBe(true);
    expect(JSON.parse(a.manifest.toString('utf8'))).toMatchObject({ look: 'banded', bands: 4, outline: '#140c1c', palette: { colors: 16 }, anchor: { name: 'feet' } });
  }, 120_000);
});

// The scale option added in 0.40.0 (pixelsPerMetre). The value checks and the pivot arithmetic are pure; one shared set of small
// bakes carries the camera, pixel and pivot checks.
describe('the pixelsPerMetre option is checked before Chromium starts', () => {
  const accepted: [number | string, number][] = [[1, 1], ['1', 1], ['1.0', 1], [32, 32], ['32', 32], [' 24.5 ', 24.5], ['007', 7], [1024, 1024], ['1024', 1024]];
  for (const [value, expected] of accepted)
    it(`accepts ${JSON.stringify(value)} as ${expected}`, () => {
      expect(parseBakeOptions({ clip: 'sway', pixelsPerMetre: value }).pixelsPerMetre).toBe(expected);
    });

  const refused: unknown[] = [0, '0', '0.0', 0.5, '0.5', 0.999, '0.999', '0.001', -1, '-5', '+5', '.5', '5.', '5 5', 1024.5, '1024.5', '1025', Number.NaN, Number.POSITIVE_INFINITY, '', '  ', 'fast', '1e2', '0x10', '3,5', true, null, {}];
  for (const [index, value] of refused.entries())
    it(`refuses the bad scale ${index} (${typeof value} ${JSON.stringify(value) ?? String(value)}) with CLI_ARGUMENT_ERROR`, () => {
      expect(() => parseBakeOptions({ clip: 'sway', pixelsPerMetre: value as number })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringMatching(/--pixels-per-metre must be a number from 1 to 1024, got /) }));
    });

  it('leaves the key out of the settings when the option is unset', () => {
    expect(Object.keys(parseBakeOptions({ clip: 'sway' }))).not.toContain('pixelsPerMetre');
    expect(Object.keys(parseBakeOptions({ clip: 'sway', pixelsPerMetre: undefined }))).not.toContain('pixelsPerMetre');
  });

  it('rejects a bad scale from bakeSprites, writes nothing and never launches the browser', async () => {
    const launch = vi.spyOn(chromium, 'launch'), dir = outDir();
    try {
      await expect(bakeSprites(glbPath, { clip: 'sway', out: dir, pixelsPerMetre: 0 })).rejects.toMatchObject({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringMatching(/--pixels-per-metre must be a number from 1 to 1024, got 0/) });
      expect(launch).not.toHaveBeenCalled();
      expect(await files(dir)).toEqual([]);
    } finally { launch.mockRestore(); }
  });
});

describe('the feet pivot follows a set scale', () => {
  it('refuses a frame too narrow for the pivot and places it inside a wider one', () => {
    const input = { cell: 48, elevationDeg: 15, centreYM: 0.55, groundYM: 0 };
    expect(() => feetPivot({ ...input, halfExtentM: 0.24 })).toThrow(expect.objectContaining({ code: 'BAKE_ANCHOR_OUTSIDE' }));
    const pivot = feetPivot({ ...input, halfExtentM: 0.8 });
    expect(pivot).toEqual({ x: 24, y: Math.floor(24 + 0.55 * Math.cos(15 * Math.PI / 180) * 30) });
    expect(pivot.y).toBeLessThan(48);
  });
});

describe('a bake with a set scale', () => {
  /** Opaque pixel extent across the first cell (direction 0, phase 0): the largest column minus the smallest, plus one. */
  const extentX = (image: { rgba: Uint8Array; width: number }, cell: number) => {
    let low = cell, high = -1;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) if (image.rgba[(y * image.width + x) * 4 + 3] === 255) { low = Math.min(low, x); high = Math.max(high, x); }
    return high - low + 1;
  };

  it('replaces the fitted half extent by cell / (2 * scale) and keeps the centre and distance, recording the scale between padding and projection', async () => {
    const plain = await plainBake(), a = await bakeWith('c64-p40', { cell: 64, pixelsPerMetre: 40 }), b = await bakeWith('c32-p20', { cell: 32, pixelsPerMetre: 20 });
    expect(a.manifest.camera).toMatchObject({ pixelsPerMetre: 40, halfExtentM: 0.8, padding: 1.25, distanceM: plain.manifest.camera.distanceM, centreM: plain.manifest.camera.centreM });
    expect(Object.keys(a.manifest.camera)).toEqual(['centreM', 'distanceM', 'elevationDeg', 'halfExtentM', 'padding', 'pixelsPerMetre', 'projection', 'supersample']);
    expect(b.manifest.camera.halfExtentM).toBe(0.8);
    expect(Object.keys(plain.manifest.camera)).toEqual(['centreM', 'distanceM', 'elevationDeg', 'halfExtentM', 'padding', 'projection', 'supersample']);
    expect(plain.manifest.camera.halfExtentM).not.toBe(0.8);
  }, 120_000);

  it('draws the figure at the set scale: 1.2 m across is 48 pixels at 40 and 24 at 20, and the fitted bake follows its own half extent', async () => {
    const plain = await bakeWith('plain-cell64', { cell: 64 }), high = await bakeWith('c64-p40', { cell: 64, pixelsPerMetre: 40 }), low = await bakeWith('c64-p20', { cell: 64, pixelsPerMetre: 20 });
    // The plain bake confirms the 1.2 m: its scale is cell / (2 * halfExtentM) pixels per metre.
    expect(Math.abs(extentX(plain.sheet, 64) - 64 / (2 * plain.manifest.camera.halfExtentM) * 1.2)).toBeLessThanOrEqual(2);
    expect(Math.abs(extentX(high.sheet, 64) - 48)).toBeLessThanOrEqual(2);
    expect(Math.abs(extentX(low.sheet, 64) - 24)).toBeLessThanOrEqual(2);
  }, 120_000);

  it('writes the pivot where the set scale projects the ground point, and the manifest anchor agrees', async () => {
    const { atlas, manifest } = await bakeWith('c64-p40-feet', { cell: 64, pixelsPerMetre: 40, anchor: 'feet' });
    const expected = projectedGroundPixel(manifest);
    expect(atlas.meta.slices![0].keys[0].pivot).toEqual(expected);
    expect(expected.y).toBe(Math.floor(32 + (manifest.camera.centreM[1] - manifest.camera.groundYM) * Math.cos(15 * Math.PI / 180) * 40));
    expect(manifest.anchor).toEqual({ name: 'feet', ...expected });
    expect(Object.keys(manifest.camera)).toEqual(['centreM', 'distanceM', 'elevationDeg', 'groundYM', 'halfExtentM', 'padding', 'pixelsPerMetre', 'projection', 'supersample']);
  }, 120_000);

  it('gives the same bytes as no option when the scale is passed as unset', async () => {
    const { dir: plain } = await plainBake(), unset = outDir();
    await bakeSprites(glbPath, { clip: 'sway', out: unset, ...SMALL, pixelsPerMetre: undefined });
    const a = await read(plain), b = await read(unset);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(b.manifest.equals(a.manifest)).toBe(true);
  }, 120_000);

  it('refuses a frame narrower than the figure with advice to lower the scale or raise --cell, and writes nothing', async () => {
    const dir = outDir();
    await expect(bakeSprites(glbPath, { clip: 'sway', out: dir, ...SMALL, cell: 48, pixelsPerMetre: 100 })).rejects.toMatchObject({
      code: 'BAKE_CELL_CLIPPED',
      message: 'Cell for direction 0 (dir-0, 0 degrees), phase 0, clip sway has opaque pixels on its border, so the model reaches outside the frame set by --pixels-per-metre 100 at --cell 48. Lower --pixels-per-metre or raise --cell to widen the frame. Nothing was written.',
    });
    expect(await files(dir)).toEqual([]);
  }, 120_000);

  it('keeps the fitted wording of the clipped-cell message when no scale is set', async () => {
    const { dir, error } = await clippedBake();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Cell for direction 0 (dir-0, 0 degrees), phase 1, clip overreach has opaque pixels on its border, so the model reaches outside the frame fitted to its rest pose. Keep the clip inside the rest bounds, or raise --cell if it only grazes the border. Nothing was written.');
    expect((error as Error).message).not.toContain('--pixels-per-metre');
    expect(await files(dir)).toEqual([]);
  }, 120_000);
});

// The contact sheet option added in 0.40.0 (contactSheet). The value and size checks are pure; one small bake carries the
// end-to-end checks.
describe('the contactSheet option is checked before Chromium starts', () => {
  it('refuses a contact sheet over 134,217,728 pixels, naming the option, the size and the options to lower, and accepts the same bake without it', () => {
    const big = { clip: 'sway', cell: 256, directions: 8, phases: 16 };
    expect(() => parseBakeOptions({ ...big, contactSheet: true })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringMatching(/--contact-sheet.*16444 by 8220.*--cell.*--phases.*--directions/) }));
    expect(() => parseBakeOptions(big)).not.toThrow();
    expect(parseBakeOptions({ ...big, contactSheet: false })).not.toHaveProperty('contactSheet');
  });

  it('accepts a contact sheet of 67,568,400 pixels', () => {
    expect(parseBakeOptions({ clip: 'sway', cell: 256, directions: 8, phases: 8, contactSheet: true }).contactSheet).toBe(true);
  });

  for (const value of ['yes', 1, 0, null, 'true', {}])
    it(`refuses contactSheet ${JSON.stringify(value)} with CLI_ARGUMENT_ERROR`, () => {
      expect(() => parseBakeOptions({ clip: 'sway', contactSheet: value as boolean })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringContaining('--contact-sheet') }));
    });

  it('leaves the key out of the settings when the option is unset or false', () => {
    expect(Object.keys(parseBakeOptions({ clip: 'sway' }))).not.toContain('contactSheet');
    expect(Object.keys(parseBakeOptions({ clip: 'sway', contactSheet: undefined }))).not.toContain('contactSheet');
    expect(Object.keys(parseBakeOptions({ clip: 'sway', contactSheet: false }))).not.toContain('contactSheet');
  });

  it('rejects an oversize contact sheet from bakeSprites, writes nothing and never launches the browser', async () => {
    const launch = vi.spyOn(chromium, 'launch'), dir = outDir();
    try {
      await expect(bakeSprites(glbPath, { clip: 'sway', out: dir, cell: 256, directions: 8, phases: 16, contactSheet: true })).rejects.toMatchObject({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringContaining('16444 by 8220') });
      expect(launch).not.toHaveBeenCalled();
      expect(await files(dir)).toEqual([]);
    } finally { launch.mockRestore(); }
  });
});

describe('a bake with a contact sheet', () => {
  it('writes contact.png after the three files, with every sheet cell as a 4 times block and grey gutters, and leaves the other three files as they are', async () => {
    const plain = outDir(), withContact = outDir(), unset = outDir(), off = outDir(), options = { clip: 'sway', directions: 2, phases: 3, cell: 16 };
    await bakeSprites(glbPath, { ...options, out: plain });
    const result = await bakeSprites(glbPath, { ...options, out: withContact, contactSheet: true });
    await bakeSprites(glbPath, { ...options, out: unset, pixelsPerMetre: undefined, contactSheet: undefined });
    await bakeSprites(glbPath, { ...options, out: off, contactSheet: false });
    expect(Object.keys(result.files)).toEqual(['sheet', 'atlas', 'manifest', 'contact']);
    expect(result.files.contact).toBe('contact.png');
    expect(await files(withContact)).toEqual(['atlas.json', 'contact.png', 'manifest.json', 'sheet.png']);
    const a = await read(plain), b = await read(withContact);
    expect(b.sheet.equals(a.sheet)).toBe(true);
    expect(b.atlas.equals(a.atlas)).toBe(true);
    expect(b.manifest.equals(a.manifest)).toBe(true);
    for (const key of ['contact', 'pixelsPerMetre']) { expect(b.atlas.toString('utf8')).not.toContain(key); expect(b.manifest.toString('utf8')).not.toContain(key); }
    // Unset and false change nothing: the same three files, and no fourth.
    for (const dir of [unset, off]) {
      expect(await files(dir)).toEqual(['atlas.json', 'manifest.json', 'sheet.png']);
      const c = await read(dir);
      expect(c.sheet.equals(a.sheet) && c.atlas.equals(a.atlas) && c.manifest.equals(a.manifest)).toBe(true);
    }

    const sheet = decodePng(a.sheet), contact = decodePng(await readFile(join(withContact, 'contact.png')));
    expect([contact.width, contact.height]).toEqual([3 * 64 + 2 * 4, 2 * 64 + 4]);
    const at = (image: { rgba: Uint8Array; width: number }, x: number, y: number) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
    for (let y = 0; y < contact.height; y++) for (let x = 0; x < contact.width; x++) {
      const column = Math.floor(x / 68), row = Math.floor(y / 68), inX = x - column * 68, inY = y - row * 68;
      if (inX >= 64 || inY >= 64) expect(at(contact, x, y), `gutter ${x},${y}`).toEqual([128, 128, 128, 255]);
      else expect(at(contact, x, y), `cell ${row},${column} at ${x},${y}`).toEqual(at(sheet, column * 16 + Math.floor(inX / 4), row * 16 + Math.floor(inY / 4)));
    }
  }, 120_000);

  it('leaves a contact.png from an earlier bake in the folder, byte for byte, after a plain bake', async () => {
    const dir = outDir(), options = { clip: 'sway', directions: 2, phases: 2, cell: 16, out: dir };
    await bakeSprites(glbPath, { ...options, contactSheet: true });
    const before = await readFile(join(dir, 'contact.png'));
    const plain = await bakeSprites(glbPath, options);
    expect(Object.keys(plain.files)).toEqual(['sheet', 'atlas', 'manifest']);
    expect(await files(dir)).toEqual(['atlas.json', 'contact.png', 'manifest.json', 'sheet.png']);
    expect((await readFile(join(dir, 'contact.png'))).equals(before)).toBe(true);
  }, 120_000);

  it('writes nothing, contact.png included, when a cell clips', async () => {
    const dir = outDir();
    await expect(bakeSprites(glbPath, { clip: 'overreach', out: dir, directions: 2, phases: 4, cell: 16, contactSheet: true })).rejects.toMatchObject({ code: 'BAKE_CELL_CLIPPED' });
    expect(await files(dir)).toEqual([]);
  }, 120_000);
});

// The elevation option: the camera height above the horizon, 15 degrees unless set. The value checks are pure; three small
// bakes carry the manifest, pixel and pivot checks.
describe('the elevation option is checked before Chromium starts', () => {
  const accepted: [number | string, number][] = [[0, 0], ['0', 0], [15, 15], ['30', 30], [' 26.565 ', 26.565], ['045', 45], [89, 89], ['89', 89]];
  for (const [value, expected] of accepted)
    it(`accepts ${JSON.stringify(value)} as ${expected}`, () => {
      expect(parseBakeOptions({ clip: 'sway', elevation: value }).elevation).toBe(expected);
    });

  const refused: unknown[] = [-1, '-5', '+5', '.5', '5.', 89.5, '89.5', 90, '90', 180, Number.NaN, Number.POSITIVE_INFINITY, '', '  ', 'steep', '1e1', '0x10', '3,5', true, null, {}];
  for (const [index, value] of refused.entries())
    it(`refuses the bad elevation ${index} (${typeof value} ${JSON.stringify(value) ?? String(value)}) with CLI_ARGUMENT_ERROR`, () => {
      expect(() => parseBakeOptions({ clip: 'sway', elevation: value as number })).toThrow(expect.objectContaining({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringMatching(/--elevation must be a number of degrees from 0 to 89, got /) }));
    });

  it('leaves the key out of the settings when the option is unset', () => {
    expect(Object.keys(parseBakeOptions({ clip: 'sway' }))).not.toContain('elevation');
    expect(Object.keys(parseBakeOptions({ clip: 'sway', elevation: undefined }))).not.toContain('elevation');
  });

  it('rejects a bad elevation from bakeSprites, writes nothing and never launches the browser', async () => {
    const launch = vi.spyOn(chromium, 'launch'), dir = outDir();
    try {
      await expect(bakeSprites(glbPath, { clip: 'sway', out: dir, elevation: 90 })).rejects.toMatchObject({ code: 'CLI_ARGUMENT_ERROR', message: '--elevation must be a number of degrees from 0 to 89, got 90' });
      expect(launch).not.toHaveBeenCalled();
      expect(await files(dir)).toEqual([]);
    } finally { launch.mockRestore(); }
  });
});

describe('a bake with a set elevation', () => {
  const OPTIONS = { clip: 'sway', ...SMALL, cell: 64, pixelsPerMetre: 40, anchor: 'feet' } as const;
  const bakedAt = new Map<number | undefined, Promise<{ sheet: Buffer; atlas: Buffer; manifest: Buffer; image: ReturnType<typeof decodePng>; parsed: any; atlasJson: Atlas }>>();
  /** One bake per elevation, shared by the two tests below, which only read its output. A failed bake rejects for both. */
  const bakeAt = (elevation: number | undefined) => {
    if (!bakedAt.has(elevation)) bakedAt.set(elevation, (async () => {
      const dir = outDir();
      await bakeSprites(glbPath, { ...OPTIONS, out: dir, elevation });
      const out = await read(dir);
      return { ...out, image: decodePng(out.sheet), parsed: JSON.parse(out.manifest.toString('utf8')), atlasJson: JSON.parse(out.atlas.toString('utf8')) as Atlas };
    })());
    return bakedAt.get(elevation)!;
  };
  /** Rows of the first cell (direction 0, phase 0) that hold an opaque pixel: the figure's height on screen. */
  const extentY = (image: { rgba: Uint8Array; width: number }, cell: number) => {
    let low = cell, high = -1;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) if (image.rgba[(y * image.width + x) * 4 + 3] === 255) { low = Math.min(low, y); high = Math.max(high, y); }
    return high - low + 1;
  };

  it('gives the same three files for 15 as for no option, records a set value under the existing key, and draws a steeper view shorter', async () => {
    const plain = await bakeAt(undefined), fifteen = await bakeAt(15), steep = await bakeAt(60);
    expect(fifteen.sheet.equals(plain.sheet)).toBe(true);
    expect(fifteen.atlas.equals(plain.atlas)).toBe(true);
    expect(fifteen.manifest.equals(plain.manifest)).toBe(true);
    expect(plain.parsed.camera.elevationDeg).toBe(15);
    expect(steep.parsed.camera.elevationDeg).toBe(60);
    expect(Object.keys(steep.parsed.camera)).toEqual(Object.keys(plain.parsed.camera));
    expect(steep.parsed.camera).toMatchObject({ halfExtentM: 0.8, centreM: plain.parsed.camera.centreM, distanceM: plain.parsed.camera.distanceM });
    // The 1.1 m figure is 0.3 m deep: height * cos(e) + depth * sin(e) falls from about 46 pixels at 15 degrees to about 32 at 60.
    const low = extentY(plain.image, 64), high = extentY(steep.image, 64);
    expect(low).toBeGreaterThan(40);
    expect(high).toBeLessThan(low - 8);
    expect(high).toBeGreaterThan(20);
  }, 120_000);

  it('places the feet pivot where an independent projection at that elevation puts the ground point', async () => {
    const steep = await bakeAt(60), plain = await bakeAt(undefined);
    const expected = projectedGroundPixel(steep.parsed);
    expect(steep.parsed.anchor).toEqual({ name: 'feet', ...expected });
    expect(steep.atlasJson.meta.slices![0].keys[0].pivot).toEqual(expected);
    expect(expected.y).toBe(Math.floor(32 + (steep.parsed.camera.centreM[1] - steep.parsed.camera.groundYM) * Math.cos(60 * Math.PI / 180) * 40));
    expect(expected.y).toBeLessThan(plain.parsed.anchor.y);
  }, 120_000);
});
