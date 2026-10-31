/** @lane merge
 * @subject src/sprite-atlas.ts
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/png.ts';
import { SPRITE_MANIFEST_FORMAT, buildAtlas, buildManifest, checkAtlasContract, serializeAtlas, sheetLayout, type Atlas, type ManifestInput } from '../src/sprite-atlas.ts';

const run = promisify(execFile);
const spec = { cell: 48, directions: 8, phases: 8, clipDurationMs: 1000 };
const tags = Array.from({ length: 8 }, (_, k) => `dir-${k}`);
const fresh = (): Atlas => buildAtlas(spec);

describe('layout and atlas', () => {
  it('lays 8 directions by 8 phases out as rows by columns', () => {
    const layout = sheetLayout(spec);
    expect([layout.width, layout.height, layout.frames.length]).toEqual([384, 384, 64]);
    expect(layout.frames[0]).toMatchObject({ index: 0, direction: 0, phase: 0, x: 0, y: 0 });
    expect(layout.frames[11]).toMatchObject({ index: 11, direction: 1, phase: 3, x: 144, y: 48 });
    expect(layout.frames[63]).toMatchObject({ direction: 7, phase: 7, x: 336, y: 336 });
  });

  it('builds the Aseprite atlas with 64 frames, exact rectangles and dir-0 to dir-7 tags', () => {
    const atlas = fresh();
    expect(atlas.frames).toHaveLength(64);
    expect(atlas.frames.map(f => f.filename)).toEqual(Array.from({ length: 64 }, (_, i) => String(i)));
    expect(atlas.frames[19]).toEqual({
      filename: '19', frame: { x: 144, y: 96, w: 48, h: 48 }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: 48, h: 48 }, sourceSize: { w: 48, h: 48 }, duration: 125,
    });
    expect(atlas.meta).toMatchObject({ app: 'agent-meshes', image: 'sheet.png', format: 'RGBA8888', size: { w: 384, h: 384 }, scale: '1' });
    expect(atlas.meta.frameTags).toEqual(Array.from({ length: 8 }, (_, k) => ({ name: `dir-${k}`, from: k * 8, to: k * 8 + 7, direction: 'forward' })));
    expect(Object.keys(atlas.meta)).toEqual(['app', 'image', 'format', 'size', 'scale', 'frameTags']);
  });

  it('rounds the frame duration from the clip duration over the phase count', () => {
    expect(buildAtlas({ ...spec, clipDurationMs: 1100 }).frames[0]!.duration).toBe(138); // 137.5 rounds up
    expect(buildAtlas({ ...spec, clipDurationMs: 833.3333 }).frames[0]!.duration).toBe(104);
  });

  it('has no version, timestamp or path in it', () => {
    const text = serializeAtlas(fresh());
    expect(text).not.toMatch(/version|time|date|generated|[A-Za-z]:[\\/]|\/(?:tmp|home|Users)\b|\\\\/i);
    expect(Object.keys(fresh().meta)).not.toContain('version');
  });

  it('serializes with a one-space indent and a trailing newline, identically every time', () => {
    const text = serializeAtlas(fresh());
    expect(text).toBe(JSON.stringify(fresh(), null, 1) + '\n');
    expect(text.endsWith('}\n')).toBe(true);
    expect(serializeAtlas(buildAtlas(spec))).toBe(text);
    expect(JSON.parse(text)).toEqual(fresh());
  });

  it.each([
    [{ cell: 0 }, /cell/], [{ directions: 0 }, /directions/], [{ phases: 0 }, /phases/],
    [{ cell: 48.5 }, /cell/], [{ directions: -1 }, /directions/], [{ phases: 2.5 }, /phases/],
    [{ clipDurationMs: 0 }, /clipDurationMs/], [{ clipDurationMs: Number.NaN }, /clipDurationMs/], [{ clipDurationMs: 3 }, /shorter than 1 ms/],
  ])('rejects the sheet spec %j', (change, message) => {
    const bad = { ...spec, ...change };
    expect(() => buildAtlas(bad)).toThrowError(expect.objectContaining({ code: 'SPRITE_SHEET_INVALID', message: expect.stringMatching(message) }));
    expect(() => sheetLayout(bad)).toThrow();
  });
});

describe('contract check', () => {
  it('passes a generated atlas, with and without the expected tags and an actual sheet size', () => {
    expect(checkAtlasContract(fresh())).toEqual([]);
    expect(checkAtlasContract(fresh(), { expectedTags: tags, sheet: { width: 384, height: 384 } })).toEqual([]);
    expect(checkAtlasContract(buildAtlas({ cell: 8, directions: 1, phases: 1, clipDurationMs: 90 }))).toEqual([]);
  });

  it('fails an expected tag the atlas lacks', () => {
    expect(checkAtlasContract(fresh(), { expectedTags: [...tags, 'dir-8'] })).toEqual(['The required tag "dir-8" is missing']);
  });

  it('fails a missing tag, because the frames it covered are then not in any tag', () => {
    const atlas = fresh();
    atlas.meta.frameTags.splice(7, 1);
    expect(checkAtlasContract(atlas)).toEqual(['The tags cover 56 of 64 frames; every frame must be in a tag']);
    const middle = fresh();
    middle.meta.frameTags.splice(3, 1);
    expect(checkAtlasContract(middle, { expectedTags: tags }).join('\n')).toMatch(/starts at frame 32 but frame 24 is the first one not yet covered[\s\S]*"dir-3" is missing/);
  });

  it('fails overlapping tags and tags that skip the first frame', () => {
    const overlap = fresh();
    overlap.meta.frameTags[1]!.from = 7;
    expect(checkAtlasContract(overlap).join('\n')).toMatch(/"dir-1"\) starts at frame 7/);
    const late = fresh();
    late.meta.frameTags[0]!.from = 1;
    expect(checkAtlasContract(late).join('\n')).toMatch(/"dir-0"\) starts at frame 1/);
  });

  it('fails a tag past the last frame and a duplicate tag name', () => {
    const range = fresh();
    range.meta.frameTags[7]!.to = 64;
    expect(checkAtlasContract(range).join('\n')).toMatch(/does not address existing frames/);
    const twin = fresh();
    twin.meta.frameTags[1]!.name = 'dir-0';
    expect(checkAtlasContract(twin).join('\n')).toMatch(/unique, non-empty name/);
  });

  it('fails a frame outside the sheet', () => {
    const atlas = fresh();
    atlas.frames[63]!.frame.x = 340;
    expect(checkAtlasContract(atlas)).toEqual(['frame 63 is not a whole rectangle inside the 384 by 384 sheet']);
    const below = fresh();
    below.frames[0]!.frame.y = -1;
    expect(checkAtlasContract(below)).toHaveLength(1);
  });

  it('fails a sheet size the atlas does not state', () => {
    expect(checkAtlasContract(fresh(), { sheet: { width: 384, height: 336 } }).join('\n')).toMatch(/meta\.size is 384 by 384 but the sheet is 384 by 336/);
  });

  it('fails a duplicate filename', () => {
    const atlas = fresh();
    atlas.frames[5]!.filename = '4';
    expect(checkAtlasContract(atlas)).toEqual(['frame 5 repeats the filename "4"']);
  });

  it('fails durations that are not positive integers', () => {
    for (const duration of [0, -125, 12.5, Number.NaN]) {
      const atlas = fresh();
      atlas.frames[2]!.duration = duration;
      expect(checkAtlasContract(atlas).join('\n')).toMatch(/frame 2 has duration .*positive integers/);
    }
  });

  it('fails a source rectangle that does not fit, and an empty atlas', () => {
    const atlas = fresh();
    atlas.frames[0]!.sourceSize = { w: 40, h: 48 };
    expect(checkAtlasContract(atlas).join('\n')).toMatch(/frame 0 has a spriteSourceSize that does not fit/);
    const empty = fresh();
    empty.frames = []; empty.meta.frameTags = [];
    expect(checkAtlasContract(empty)).toContain('The atlas has no frames');
  });
});

describe('manifest', () => {
  const sha = (c: string) => c.repeat(64);
  const input = (): ManifestInput => ({
    model: { sha256: sha('a') }, clip: { name: 'walk', durationMs: 1000 }, directions: 8, phases: 8, cell: 48,
    camera: { projection: 'orthographic', half: 0.9, elevationDeg: 15, centre: [0, 0.5, 0], distance: 4 },
    sheetSha256: sha('b'), atlasSha256: sha('c'), pluginVersion: '0.37.0',
  });

  it('builds a plain object in a fixed key order', () => {
    const manifest = buildManifest(input());
    expect(Object.keys(manifest)).toEqual(['format', 'pluginVersion', 'model', 'clip', 'directions', 'phases', 'cell', 'camera', 'sheet', 'atlas']);
    expect(manifest.format).toBe(SPRITE_MANIFEST_FORMAT);
    expect(manifest.sheet).toEqual({ file: 'sheet.png', width: 384, height: 384, sha256: sha('b') });
    expect(manifest.atlas).toEqual({ file: 'atlas.json', frames: 64, sha256: sha('c') });
    expect(Object.keys(manifest.camera)).toEqual(['centre', 'distance', 'elevationDeg', 'half', 'projection']);
    expect(JSON.stringify(manifest)).toBe(JSON.stringify(buildManifest(input())));
  });

  it('holds no timestamp and no path', () => {
    expect(JSON.stringify(buildManifest(input()))).not.toMatch(/time|date|generated|[A-Za-z]:[\\/]|\/(?:tmp|home|Users)\b|\\\\/i);
  });

  it('rejects a bad hash, an empty clip or version, and a bad sheet spec', () => {
    expect(() => buildManifest({ ...input(), sheetSha256: 'xyz' })).toThrowError(expect.objectContaining({ code: 'SPRITE_SHEET_INVALID' }));
    expect(() => buildManifest({ ...input(), model: { sha256: sha('A') } })).toThrow(/model SHA-256/);
    expect(() => buildManifest({ ...input(), clip: { name: '', durationMs: 1000 } })).toThrow(/clip name/);
    expect(() => buildManifest({ ...input(), pluginVersion: '' })).toThrow(/plugin version/);
    expect(() => buildManifest({ ...input(), cell: 0 })).toThrowError(expect.objectContaining({ code: 'SPRITE_SHEET_INVALID' }));
  });
});

describe('pivot slice', () => {
  const pivotSpec = { ...spec, cell: 48 };
  const withPivot = (): Atlas => buildAtlas(pivotSpec, { x: 24, y: 40 });

  it('writes one pivot slice with the whole cell as bounds when a pivot is given', () => {
    const atlas = withPivot();
    expect(atlas.meta.slices).toEqual([
      { name: 'pivot', color: '#0000ffff', keys: [{ frame: 0, bounds: { x: 0, y: 0, w: 48, h: 48 }, pivot: { x: 24, y: 40 } }] },
    ]);
    expect(Object.keys(atlas.meta)).toEqual(['app', 'image', 'format', 'size', 'scale', 'frameTags', 'slices']);
    expect(atlas.frames).toEqual(fresh().frames);
    expect(checkAtlasContract(atlas, { expectedTags: tags })).toEqual([]);
    expect(JSON.parse(serializeAtlas(atlas))).toEqual(atlas);
  });

  it('omits slices entirely, not as an empty list, without a pivot', () => {
    for (const atlas of [fresh(), buildAtlas(spec, undefined)]) {
      expect('slices' in atlas.meta).toBe(false);
      expect(Object.keys(atlas.meta)).toEqual(['app', 'image', 'format', 'size', 'scale', 'frameTags']);
      expect(serializeAtlas(atlas)).not.toMatch(/slices/);
    }
    expect(serializeAtlas(buildAtlas(spec, undefined))).toBe(serializeAtlas(fresh()));
  });

  it('accepts the corners of the cell as a pivot', () => {
    for (const pivot of [{ x: 0, y: 0 }, { x: 47, y: 47 }]) expect(checkAtlasContract(buildAtlas(pivotSpec, pivot))).toEqual([]);
  });

  it.each([
    [{ x: 48, y: 0 }], [{ x: 0, y: 48 }], [{ x: -1, y: 3 }], [{ x: 3, y: -1 }], [{ x: 2.5, y: 3 }], [{ x: Number.NaN, y: 3 }],
  ])('rejects the pivot %j when building the atlas', pivot => {
    expect(() => buildAtlas(pivotSpec, pivot)).toThrowError(expect.objectContaining({ code: 'SPRITE_SHEET_INVALID', message: expect.stringMatching(/pivot/) }));
  });

  it('fails a pivot outside the cell or off the pixel grid in the contract check', () => {
    for (const pivot of [{ x: 48, y: 5 }, { x: 5, y: 48 }, { x: -1, y: 5 }, { x: 5.5, y: 5 }]) {
      const atlas = withPivot();
      atlas.meta.slices![0]!.keys[0]!.pivot = pivot;
      expect(checkAtlasContract(atlas).join('\n')).toMatch(/slice 0 key 0 pivot .* is not an integer pixel inside the 48 by 48 cell/);
    }
  });

  it('fails a slice with the wrong name', () => {
    const atlas = withPivot();
    atlas.meta.slices![0]!.name = 'feet';
    expect(checkAtlasContract(atlas)).toEqual(['slice 0 is named "feet" but only "pivot" is supported']);
  });

  it('fails an empty slice list and a slice without keys', () => {
    const empty = withPivot();
    empty.meta.slices = [];
    expect(checkAtlasContract(empty)).toEqual(['meta.slices must be a non-empty array when present']);
    const keyless = withPivot();
    keyless.meta.slices![0]!.keys = [];
    expect(checkAtlasContract(keyless)).toEqual(['slice 0 needs at least one key']);
  });

  it('fails a frame key that is fractional, negative or repeated', () => {
    for (const frame of [0.5, -1, Number.NaN]) {
      const atlas = withPivot();
      atlas.meta.slices![0]!.keys[0]!.frame = frame;
      expect(checkAtlasContract(atlas).join('\n')).toMatch(/slice 0 key 0 needs a non-negative integer frame/);
    }
    const twin = withPivot();
    twin.meta.slices![0]!.keys.push({ ...twin.meta.slices![0]!.keys[0]! });
    expect(checkAtlasContract(twin)).toEqual(['slice 0 key 1 repeats frame 0']);
  });

  it('fails bounds that are fractional, empty or outside the sheet', () => {
    for (const bounds of [{ x: 0.5, y: 0, w: 48, h: 48 }, { x: 0, y: 0, w: 0, h: 48 }, { x: 0, y: 0, w: 385, h: 48 }, { x: 340, y: 0, w: 48, h: 48 }, { x: 0, y: -1, w: 48, h: 48 }]) {
      const atlas = withPivot();
      atlas.meta.slices![0]!.keys[0]!.bounds = bounds;
      expect(checkAtlasContract(atlas).join('\n')).toMatch(/slice 0 key 0 bounds are not a whole rectangle inside the 384 by 384 sheet/);
    }
  });
});

describe('optional manifest keys', () => {
  const sha = (c: string) => c.repeat(64);
  const base = (): ManifestInput => ({
    model: { sha256: sha('a') }, clip: { name: 'walk', durationMs: 1000 }, directions: 8, phases: 8, cell: 48,
    camera: { projection: 'orthographic', half: 0.9 },
    sheetSha256: sha('b'), atlasSha256: sha('c'), pluginVersion: '0.38.0',
  });
  const plain = ['format', 'pluginVersion', 'model', 'clip', 'directions', 'phases', 'cell', 'camera', 'sheet', 'atlas'];

  it('keeps the key list when every new input is left out or undefined', () => {
    const explicit = buildManifest({ ...base(), look: undefined, bands: undefined, palette: undefined, outline: undefined, anchor: undefined });
    expect(Object.keys(explicit)).toEqual(plain);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(buildManifest(base())));
    expect(JSON.stringify(explicit)).not.toMatch(/look|bands|palette|outline|anchor/);
  });

  it('writes each new key only when its input is given, after the existing keys', () => {
    const only = (extra: Partial<ManifestInput>) => Object.keys(buildManifest({ ...base(), ...extra }));
    expect(only({ look: 'unlit' })).toEqual([...plain, 'look']);
    expect(only({ bands: 3 })).toEqual([...plain, 'bands']);
    expect(only({ palette: { colors: 16, sha256: sha('d') } })).toEqual([...plain, 'palette']);
    expect(only({ outline: '#140c1c' })).toEqual([...plain, 'outline']);
    expect(only({ anchor: { name: 'feet', x: 24, y: 40 } })).toEqual([...plain, 'anchor']);
  });

  it('carries the values of all five keys in a fixed order', () => {
    const manifest = buildManifest({
      ...base(), anchor: { name: 'feet', x: 24, y: 40 }, outline: '#140c1c', palette: { colors: 16, sha256: sha('d') }, bands: 3, look: 'banded',
    });
    expect(Object.keys(manifest)).toEqual([...plain, 'look', 'bands', 'palette', 'outline', 'anchor']);
    expect(manifest).toMatchObject({ look: 'banded', bands: 3, palette: { colors: 16, sha256: sha('d') }, outline: '#140c1c', anchor: { name: 'feet', x: 24, y: 40 } });
    expect(JSON.stringify(manifest)).toBe(JSON.stringify(buildManifest({
      ...base(), look: 'banded', bands: 3, palette: { colors: 16, sha256: sha('d') }, outline: '#140c1c', anchor: { name: 'feet', x: 24, y: 40 },
    })));
  });

  it('writes a bands value of zero rather than dropping it', () => {
    expect(buildManifest({ ...base(), bands: 0 }).bands).toBe(0);
  });
});

// Optional: set AGENT_MESHES_SPRITES_VERIFY to the sprite.js script of a local agent-sprites checkout to run its verifier.
describe.skipIf(!process.env.AGENT_MESHES_SPRITES_VERIFY)('agent-sprites verify', () => {
  it('passes a generated atlas and fails a tag it lacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprite-atlas-'));
    try {
      const small = { ...spec, cell: 8 };
      const layout = sheetLayout(small);
      const rgba = Buffer.alloc(layout.width * layout.height * 4);
      for (const f of layout.frames) for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) rgba.set([200, 60 + f.direction * 20, 40 + f.phase * 20, 255], ((f.y + y) * layout.width + f.x + x) * 4);
      await writeFile(join(root, 'sheet.png'), encodePng(layout.width, layout.height, rgba));
      await writeFile(join(root, 'atlas.json'), serializeAtlas(buildAtlas(small)));
      const script = process.env.AGENT_MESHES_SPRITES_VERIFY!;
      const verify = (expected: string[]) => run(process.execPath, [script, 'verify', join(root, 'atlas.json'), '--expect-tags', expected.join(',')]);
      expect((await verify(tags)).stdout).toMatch(/PASS: 64 atlas frames/);
      await expect(verify([...tags, 'dir-8'])).rejects.toMatchObject({ code: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
