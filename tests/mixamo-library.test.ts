/** @lane merge
 * @subject scripts/blender_lib/agent_meshes_mixamo.py
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  addMixamo, assertNotMeshesCheckout, describeFbx, importAssets, mixamoDir, mixamoPath, mixamoRegistry, motionSummary, registryFile,
  removeAssets, scanMixamo, setNote, setTags, setTitle, slug, suggestTags, unzipFbx, REGISTRY_FILE, REGISTRY_SCHEMA,
} from '../scripts/mixamo-library.mjs';
import { animatedFbx, MIXAMO_BONES } from './helpers/animated-fbx.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'mesh-mixamo-')); directories.push(path); return path; };

type Property = string | number | bigint | Buffer;
type Node = { name: string; properties?: Property[]; children?: Node[] };
/** A binary FBX 7.4 file holding these nodes: enough of the format for the registry's reader. A Buffer property is
 *  written as it is, already encoded. */
function fbx(nodes: Node[]): Buffer {
  const property = (value: Property) => {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') { const text = Buffer.from(value, 'utf8'), head = Buffer.alloc(5); head.write('S'); head.writeUInt32LE(text.length, 1); return Buffer.concat([head, text]); }
    if (typeof value === 'bigint') { const out = Buffer.alloc(9); out.write('L'); out.writeBigInt64LE(value, 1); return out; }
    const out = Buffer.alloc(5); out.write('I'); out.writeInt32LE(value, 1); return out;
  };
  const encode = (node: Node, offset: number): Buffer => {
    const properties = Buffer.concat((node.properties ?? []).map(property)), name = Buffer.from(node.name, 'latin1');
    const head = Buffer.alloc(13); let at = offset + 13 + name.length + properties.length; const children: Buffer[] = [];
    for (const child of node.children ?? []) { const bytes = encode(child, at); children.push(bytes); at += bytes.length; }
    if (node.children) { children.push(Buffer.alloc(13)); at += 13; }
    head.writeUInt32LE(at, 0); head.writeUInt32LE((node.properties ?? []).length, 4); head.writeUInt32LE(properties.length, 8); head[12] = name.length;
    return Buffer.concat([head, name, properties, ...children]);
  };
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  ', 'latin1'); header[21] = 0x1a; header.writeUInt32LE(7400, 23);
  const parts: Buffer[] = [header]; let at = 27;
  for (const node of nodes) { const bytes = encode(node, at); parts.push(bytes); at += bytes.length; }
  return Buffer.concat([...parts, Buffer.alloc(13)]);
}
const clip = (seconds: number, { mesh = false, bones = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head'] } = {}) => fbx([
  { name: 'FBXHeaderExtension', children: [{ name: 'Creator', properties: ['FBX SDK/FBX Plugins version 2020.2'] }] },
  { name: 'Objects', children: [
    ...bones.map((bone, i) => ({ name: 'Model', properties: [BigInt(100 + i), `${bone}\u0000\u0001Model`, 'LimbNode'], children: [{ name: 'Version', properties: [232] }] })),
    ...(mesh ? [{ name: 'Geometry', properties: [900n, 'Body\u0000\u0001Geometry', 'Mesh'], children: [{ name: 'GeometryVersion', properties: [124] }] }] : []),
    { name: 'AnimationStack', properties: [500n, 'mixamo.com\u0000\u0001AnimStack', ''], children: [{ name: 'Properties70', children: [
      { name: 'P', properties: ['LocalStop', 'KTime', 'Time', '', BigInt(Math.round(seconds * 46186158000))] }] }] },
  ] },
]);
/** A zip archive of these members, deflated. */
function zip(members: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, bytes] of Object.entries(members)) {
    const packed = deflateRawSync(bytes), label = Buffer.from(name, 'utf8'), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(label.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(label.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, label, packed); central.push(entry, label); offset += 30 + label.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(members).length, 8); end.writeUInt16LE(Object.keys(members).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
/** A 1 x 1 GIF89a, as a stub renderer returns. */
const TINY_GIF = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
const stubRender = async () => ({ gif: new Uint8Array(TINY_GIF) });
/** Every file under a folder, relative and sorted. */
async function tree(folder: string, base = folder): Promise<string[]> {
  let names; try { names = await readdir(folder, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: string[] = [];
  for (const item of names) {
    const path = join(folder, item.name);
    if (item.isDirectory()) out.push(...await tree(path, base)); else out.push(relative(base, path).split('\\').join('/'));
  }
  return out.sort();
}
const sidecar = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 9\n';

it('places the folder by its own variable, then the managed home, then the user home', () => {
  expect(mixamoDir({ AGENT_MESHES_MIXAMO_DIR: 'X:/clips', AGENT_MESHES_HOME: 'X:/home' })).toBe(resolve('X:/clips'));
  expect(mixamoDir({ AGENT_MESHES_HOME: 'X:/home' })).toBe(join(resolve('X:/home'), 'mixamo'));
  expect(mixamoDir({}).replaceAll('\\', '/')).toMatch(/\/\.agent-meshes\/mixamo$/);
});

it('reads clips, their length, the skeleton and a mesh out of a binary FBX', () => {
  expect(describeFbx(clip(0.717))).toEqual({ fbxVersion: 7400, creator: 'FBX SDK/FBX Plugins version 2020.2', skeleton: 'mixamorig', bones: 3, hasMesh: false, clips: [{ name: 'mixamo.com', seconds: 0.717 }] });
  expect(describeFbx(clip(2, { mesh: true, bones: ['Hips'] }))).toMatchObject({ skeleton: null, bones: 1, hasMesh: true });
  expect(() => describeFbx(Buffer.from('not an fbx file at all, just some text'))).toThrow('not a binary FBX');
  expect(slug('Dual Weapon Combo (1).fbx')).toBe('dual-weapon-combo-1');
});

describe('the synthetic animated FBX helper', () => {
  it('loads in three.js FBXLoader with the Mixamo bones and a clip whose hips travel as asked', () => {
    const bytes = animatedFbx({ travel: 1.5, seconds: 2, mesh: true, restTake: true });
    const group = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    const bones: string[] = []; group.traverse(node => { if ((node as { isBone?: boolean }).isBone) bones.push(node.userData.originalName); });
    expect(bones).toEqual(MIXAMO_BONES.map(bone => `mixamorig:${bone}`));
    expect(group.animations.map(item => item.name)).toEqual(['Take 001', 'mixamo.com']);
    const motion = group.animations[1], hips = motion.tracks.find(track => track.name === 'mixamorigHips.position')!;
    expect(motion.duration).toBeCloseTo(2, 5);
    const z = (i: number) => hips.values[i * 3 + 2];
    expect(z(hips.times.length - 1) - z(0)).toBeCloseTo(150, 3);
    expect(hips.values[1]).toBeCloseTo(100, 3);
    expect(motion.tracks.some(track => track.name === 'mixamorigLeftUpLeg.quaternion')).toBe(true);
    expect(animatedFbx({ travel: 1.5, seconds: 2, mesh: true, restTake: true }).equals(bytes)).toBe(true);
  });

  it('is read by the registry reader as a Mixamo clip', () => {
    expect(describeFbx(animatedFbx({ seconds: 2 }))).toMatchObject({ skeleton: 'mixamorig', bones: MIXAMO_BONES.length, hasMesh: false, clips: [{ name: 'mixamo.com', seconds: 2 }] });
    expect(describeFbx(animatedFbx({ mesh: true, restTake: true, prefix: 'mixamorig1' }))).toMatchObject({ skeleton: 'mixamorig1', hasMesh: true, clips: [{ name: 'Take 001', seconds: 0.033 }, { name: 'mixamo.com', seconds: 2 }] });
    expect(describeFbx(animatedFbx({ prefix: '' })).skeleton).toBeNull();
  });
});

describe('motionSummary', () => {
  it('tells a walk with root motion from an idle in place', () => {
    const walk = motionSummary(animatedFbx({ travel: 1, seconds: 2 }));
    expect(walk).toMatchObject({ seconds: 2, inPlace: false });
    expect(walk.travelMeters).toBeGreaterThan(0.5);
    expect(walk.travelMeters).toBeCloseTo(1, 2);
    expect(walk.summary).toBe('root motion · travels 1.0 m · 2.0 s');
    const idle = motionSummary(animatedFbx({ travel: 0, seconds: 8.3 }));
    expect(idle).toMatchObject({ seconds: 8.3, travelMeters: 0, inPlace: true, summary: 'in place · 8.3 s' });
    expect(idle.hipsRiseCm).toBeCloseTo(2, 0);
    expect(idle.hipsDropCm).toBeCloseTo(2, 0);
  });

  it('reports a hips rise and drop of 5 cm or more and measures the longest take, not a rest take', () => {
    const jump = motionSummary(animatedFbx({ bob: 0.5, travel: 0.1, restTake: true, mesh: true }));
    expect(jump).toMatchObject({ seconds: 2, inPlace: true, hipsRiseCm: 50, hipsDropCm: 50, summary: 'in place · hips rise 50 cm · hips drop 50 cm · 2.0 s' });
    expect(motionSummary(animatedFbx({ travel: 2, restTake: true })).travelMeters).toBeCloseTo(2, 2);
  });

  it('decodes zlib-compressed curve arrays and treats a clip without hips curves as in place', () => {
    const floats = (values: number[]) => { const raw = Buffer.alloc(values.length * 4); values.forEach((v, i) => raw.writeFloatLE(v, i * 4)); return raw; };
    const array = (type: string, count: number, raw: Buffer) => {
      const packed = deflateSync(raw), head = Buffer.alloc(13); head.write(type); head.writeUInt32LE(count, 1); head.writeUInt32LE(1, 5); head.writeUInt32LE(packed.length, 9);
      return Buffer.concat([head, packed]);
    };
    const times = Buffer.alloc(16); times.writeBigInt64LE(0n, 0); times.writeBigInt64LE(46186158000n, 8);
    const curve = (id: bigint, values: number[]) => ({ name: 'AnimationCurve', properties: [id, '\u0000\u0001AnimCurve', ''], children: [
      { name: 'KeyTime', properties: [array('l', 2, times)] }, { name: 'KeyValueFloat', properties: [array('f', 2, floats(values))] }] });
    const bytes = fbx([
      { name: 'Objects', children: [
        { name: 'Model', properties: [10n, 'mixamorig:Hips\u0000\u0001Model', 'LimbNode'], children: [] },
        { name: 'AnimationStack', properties: [20n, 'mixamo.com\u0000\u0001AnimStack', ''], children: [{ name: 'Properties70', children: [
          { name: 'P', properties: ['LocalStop', 'KTime', 'Time', '', 46186158000n] }] }] },
        { name: 'AnimationLayer', properties: [21n, 'BaseLayer\u0000\u0001AnimLayer', ''] },
        { name: 'AnimationCurveNode', properties: [30n, 'T\u0000\u0001AnimCurveNode', ''] },
        curve(31n, [0, 300]), curve(32n, [100, 100]), curve(33n, [0, 400]),
      ] },
      { name: 'Connections', children: [
        { name: 'C', properties: ['OO', 10n, 0n] }, { name: 'C', properties: ['OO', 21n, 20n] }, { name: 'C', properties: ['OO', 30n, 21n] },
        { name: 'C', properties: ['OP', 30n, 10n, 'Lcl Translation'] },
        { name: 'C', properties: ['OP', 31n, 30n, 'd|X'] }, { name: 'C', properties: ['OP', 32n, 30n, 'd|Y'] }, { name: 'C', properties: ['OP', 33n, 30n, 'd|Z'] },
      ] },
    ]);
    expect(motionSummary(bytes)).toMatchObject({ seconds: 1, travelMeters: 5, inPlace: false, summary: 'root motion · travels 5.0 m · 1.0 s' });
    expect(motionSummary(clip(0.717))).toMatchObject({ seconds: 0.717, travelMeters: 0, inPlace: true, hipsRiseCm: 0, hipsDropCm: 0, summary: 'in place · 0.7 s' });
  });
});

it('suggests one kind tag from the name, in the stated order, and a motion tag', () => {
  const inPlace = { inPlace: true }, moving = { inPlace: false };
  // Without a motion summary there is no motion tag, so the kind tag is the only one.
  const kind = (name: string) => suggestTags(name, 'clip', null)[0];
  expect(suggestTags('Dodge Roll', 'clip', inPlace)).toEqual(['in-place', 'roll']);
  expect(kind('Idle To Walk')).toBe('transitions');
  expect(kind('Sword And Shield Equip')).toBe('transitions');
  expect(kind('Hit Reaction')).toBe('hit-and-death');
  expect(kind('Fireball CAST')).toBe('magic');
  expect(kind('Sword Slash')).toBe('melee');
  expect(kind('Rifle Run')).toBe('ranged');
  expect(kind('Jumping')).toBe('jump');
  expect(suggestTags('Walking', 'clip', moving)).toEqual(['locomotion', 'root-motion']);
  expect(kind('Breathing Idle')).toBe('idle');
  // Keywords match at the start of a word, not inside one: drunk is not run, elbow is not bow, broadcast is not cast.
  expect(kind('Drunk Idle Variation')).toBe('idle');
  expect(kind('Elbow Strike')).toBe('pose-or-emote');
  expect(kind('Broadcast Wave')).toBe('pose-or-emote');
  expect(kind('Toe Tap')).toBe('pose-or-emote');
  expect(suggestTags('Samba Dancing', 'clip-with-skin', moving)).toEqual(['pose-or-emote', 'root-motion']);
  expect(suggestTags('Y Bot', 'character', inPlace)).toEqual(['character', 'pose-or-emote']);
});

describe('importAssets', () => {
  it('imports a walk into the clip layout with a preview, a sidecar, its motion and suggested tags', async () => {
    const downloads = await temp(), library = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1, seconds: 2 }));
    const progress: unknown[] = [];
    const { results, registry } = await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, tags: ['Ronin Set', 'locomotion'], render: stubRender, onProgress: (result: unknown) => progress.push(result) });
    expect(results).toEqual([{ source: join(downloads, 'Walk.fbx'), status: 'imported', id: 'walk', kind: 'clip' }]);
    expect(progress).toEqual(results);
    expect(await tree(library)).toEqual(['mixamo/clips/walk.fbx', 'mixamo/clips/walk.gif', 'mixamo/clips/walk.json']);
    expect((await readFile(join(library, 'mixamo/clips/walk.gif'))).subarray(0, 6).toString('latin1')).toBe('GIF89a');
    const meta = await sidecar(join(library, 'mixamo/clips/walk.json'));
    expect(meta).toMatchObject({ schema: 'agent-meshes/mixamo-asset/1', id: 'walk', kind: 'clip', title: 'Walk', sourceName: 'Walk.fbx', note: '', preview: 'walk.gif',
      tags: ['locomotion', 'ronin-set', 'root-motion'], motion: { inPlace: false, seconds: 2 } });
    expect(meta.motion.travelMeters).toBeGreaterThan(0.5);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(meta.importedAt).toISOString()).toBe(meta.importedAt);
    expect(registry.schema).toBe('agent-meshes/mixamo-registry/3');
    expect(registry.entries).toEqual([expect.objectContaining({ id: 'walk', file: 'mixamo/clips/walk.fbx', kind: 'clip', title: 'Walk', tags: meta.tags, note: '', motion: meta.motion, preview: 'walk.gif', sha256: meta.sha256 })]);
    // The source is left alone.
    expect(await tree(downloads)).toEqual(['Walk.fbx']);
  });

  it('reports a duplicate by its bytes and rejects what it cannot use, writing nothing for either', async () => {
    const downloads = await temp(), library = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    await writeFile(join(downloads, 'Walk again.fbx'), animatedFbx({ travel: 1 }));
    await writeFile(join(downloads, 'Other Rig.fbx'), animatedFbx({ prefix: '' }));
    await writeFile(join(downloads, 'Notes.fbx'), 'just some text, not an FBX file');
    await writeFile(join(downloads, 'Pointer.fbx'), LFS_POINTER);
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    const before = await tree(library), registryBefore = await readFile(registryFile(env), 'utf8');
    let renders = 0;
    const { results } = await importAssets(['Walk.fbx', 'Walk again.fbx', 'Other Rig.fbx', 'Notes.fbx', 'Pointer.fbx'].map(name => join(downloads, name)),
      { directory: library, env, render: async () => { renders++; return stubRender(); } });
    expect(results.map(({ status, id, reason }: { status: string; id?: string; reason?: string }) => ({ status, id, reason }))).toEqual([
      { status: 'duplicate', id: 'walk', reason: undefined },
      { status: 'duplicate', id: 'walk', reason: undefined },
      { status: 'rejected', id: undefined, reason: 'not on the Mixamo skeleton (bone prefix: none)' },
      { status: 'rejected', id: undefined, reason: 'not a binary FBX file' },
      { status: 'rejected', id: undefined, reason: expect.stringMatching(/Git LFS pointer/) },
    ]);
    expect(renders).toBe(0);
    expect(await tree(library)).toEqual(before);
    expect(JSON.parse(await readFile(registryFile(env), 'utf8')).entries).toEqual(JSON.parse(registryBefore).entries);
  });

  it('detects a character and a clip with skin', async () => {
    const downloads = await temp(), library = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Y Bot.fbx'), animatedFbx({ mesh: true, seconds: 1 / 30 }));
    await writeFile(join(downloads, 'Sword Slash.fbx'), animatedFbx({ mesh: true, restTake: true, seconds: 1.5 }));
    const { results } = await importAssets([join(downloads, 'Y Bot.fbx'), join(downloads, 'Sword Slash.fbx')], { directory: library, env, render: stubRender });
    expect(results.map(({ status, id, kind }) => [status, id, kind])).toEqual([['imported', 'y-bot', 'character'], ['imported', 'sword-slash', 'clip-with-skin']]);
    expect(await tree(library)).toEqual(['mixamo/characters/y-bot.fbx', 'mixamo/characters/y-bot.gif', 'mixamo/characters/y-bot.json',
      'mixamo/clips/sword-slash.fbx', 'mixamo/clips/sword-slash.gif', 'mixamo/clips/sword-slash.json']);
    expect((await sidecar(join(library, 'mixamo/characters/y-bot.json'))).tags).toContain('character');
    expect((await sidecar(join(library, 'mixamo/characters/y-bot.json'))).tags).not.toContain('in-place');
    expect(await sidecar(join(library, 'mixamo/clips/sword-slash.json'))).toMatchObject({ kind: 'clip-with-skin', tags: ['in-place', 'melee'] });
  });

  it('numbers an id taken by different bytes, and imports zip members and folders', async () => {
    const downloads = await temp(), library = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await mkdir(join(downloads, 'Second'));
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    await writeFile(join(downloads, 'Second', 'walk.fbx'), animatedFbx({ travel: 2 }));
    await writeFile(join(downloads, 'Pack.zip'), zip({ 'Walk.fbx': animatedFbx({ travel: 3 }), 'Standing Idle.fbx': animatedFbx({ seconds: 3 }), 'readme.txt': Buffer.from('skip me') }));
    await writeFile(join(downloads, 'notes.txt'), 'not a download');
    const { results, registry } = await importAssets([join(downloads, 'Walk.fbx'), join(downloads, 'Second'), join(downloads, 'Pack.zip'), join(downloads, 'notes.txt')], { directory: library, env, render: stubRender });
    expect(results.map(({ status, id }: { status: string; id?: string }) => [status, id])).toEqual([
      ['imported', 'walk'], ['imported', 'walk-2'], ['imported', 'walk-3'], ['imported', 'standing-idle'], ['rejected', undefined]]);
    expect(results[4].reason).toMatch(/expected an \.fbx file, a \.zip archive or a folder/);
    expect(registry.entries.map((entry: { id: string }) => entry.id)).toEqual(['standing-idle', 'walk', 'walk-2', 'walk-3']);
    expect((await sidecar(join(library, 'mixamo/clips/walk-3.json'))).sourceName).toBe('Walk.fbx');
    expect((await sidecar(join(library, 'mixamo/clips/standing-idle.json'))).tags).toEqual(['idle', 'in-place']);
  });

  it('still imports a clip whose preview fails, with its motion and tags and no preview', async () => {
    const downloads = await temp(), library = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Run.fbx'), animatedFbx({ travel: 3 }));
    const { results } = await importAssets([join(downloads, 'Run.fbx')], { directory: library, env, render: async () => { throw new Error('no GPU here'); } });
    expect(results).toEqual([{ source: join(downloads, 'Run.fbx'), status: 'imported', id: 'run', kind: 'clip', previewError: 'no GPU here' }]);
    expect(await tree(library)).toEqual(['mixamo/clips/run.fbx', 'mixamo/clips/run.json']);
    expect(await sidecar(join(library, 'mixamo/clips/run.json'))).toMatchObject({ preview: null, tags: ['locomotion', 'root-motion'], motion: { inPlace: false } });
  });
});

describe('editing the library', () => {
  const library = async () => {
    const downloads = await temp(), directory = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    await writeFile(join(downloads, 'Breathing Idle.fbx'), animatedFbx({ seconds: 4 }));
    await importAssets([join(downloads, 'Walk.fbx'), join(downloads, 'Breathing Idle.fbx')], { directory, env, render: stubRender });
    return { directory, env };
  };

  it('adds and removes tags on several clips, and edits a title and a note without changing the id', async () => {
    const { directory, env } = await library();
    await setTags(['walk', 'breathing-idle'], ['Ronin', 'favourite'], ['in-place'], { directory, env });
    expect((await sidecar(join(directory, 'mixamo/clips/walk.json'))).tags).toEqual(['favourite', 'locomotion', 'ronin', 'root-motion']);
    expect((await sidecar(join(directory, 'mixamo/clips/breathing-idle.json'))).tags).toEqual(['favourite', 'idle', 'ronin']);
    await setTitle('walk', 'Forward Walk', { directory, env });
    await setNote('walk', 'Arms swing wide.', { directory, env });
    const registry = await mixamoRegistry(directory, env);
    expect(registry.entries.find((entry: { id: string }) => entry.id === 'walk')).toMatchObject({ id: 'walk', file: 'mixamo/clips/walk.fbx', title: 'Forward Walk', note: 'Arms swing wide.', tags: ['favourite', 'locomotion', 'ronin', 'root-motion'] });
    expect(await sidecar(join(directory, 'mixamo/clips/walk.json'))).toMatchObject({ id: 'walk', title: 'Forward Walk', note: 'Arms swing wide.' });
    await expect(setTags(['nope'], ['x'], [], { directory, env })).rejects.toThrow('Unknown Mixamo entry');
  });

  it('removes a clip with its preview and sidecar', async () => {
    const { directory, env } = await library();
    await removeAssets(['walk'], { directory, env });
    expect(await tree(directory)).toEqual(['mixamo/clips/breathing-idle.fbx', 'mixamo/clips/breathing-idle.gif', 'mixamo/clips/breathing-idle.json']);
    expect((await mixamoRegistry(directory, env)).entries.map((entry: { id: string }) => entry.id)).toEqual(['breathing-idle']);
  });
});

describe('the checkout guard', () => {
  it('refuses to import into or edit a library inside an agent-meshes checkout, and writes nothing', async () => {
    const downloads = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    for (const marker of ['package.json', '.claude-plugin/plugin.json']) {
      const checkout = await temp(), directory = join(checkout, 'deep', 'library');
      await mkdir(join(checkout, '.git'));
      await mkdir(join(checkout, '.claude-plugin'));
      await writeFile(join(checkout, marker), JSON.stringify({ name: 'agent-meshes' }));
      const before = await tree(checkout);
      await expect(importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: stubRender })).rejects.toThrow(/Mixamo files are never kept in an agent-meshes checkout/);
      await expect(setTags(['walk'], ['x'], [], { directory, env })).rejects.toThrow(/Mixamo files are never kept in an agent-meshes checkout/);
      await expect(removeAssets(['walk'], { directory, env })).rejects.toThrow(/never kept in an agent-meshes checkout/);
      expect(() => assertNotMeshesCheckout(directory)).toThrow(/never kept in an agent-meshes checkout/);
      expect(await tree(checkout)).toEqual(before);
      await expect(stat(registryFile(env))).rejects.toThrow();
    }
  });

  it('allows a library inside some other repository', async () => {
    const checkout = await temp(), downloads = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(checkout, '.git'), 'gitdir: elsewhere');
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'animation-library' }));
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    expect(() => assertNotMeshesCheckout(join(checkout, 'library'))).not.toThrow();
    expect((await importAssets([join(downloads, 'Walk.fbx')], { directory: checkout, env, render: stubRender })).results[0].status).toBe('imported');
  });
});

it('adds through the old wrapper, which keeps its shape and gains the results', async () => {
  const downloads = await temp(), folder = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  await writeFile(join(downloads, 'Standard Run.fbx'), clip(0.717));
  await writeFile(join(downloads, 'Standard Run copy.fbx'), clip(0.717));
  await writeFile(join(downloads, 'Pack.zip'), zip({ 'Standing Idle.fbx': clip(1.867), 'Standard Run.fbx': clip(0.733), 'readme.txt': Buffer.from('skip me') }));
  await mkdir(join(downloads, 'More'));
  await writeFile(join(downloads, 'More', 'Dying.fbx'), clip(4.333, { mesh: true }));
  await writeFile(join(downloads, 'More', 'broken.fbx'), 'text');
  const added = await addMixamo([join(downloads, 'Standard Run.fbx'), join(downloads, 'Standard Run copy.fbx'), join(downloads, 'Pack.zip'), join(downloads, 'More')], folder, env, { render: stubRender });
  expect(added.copied.sort()).toEqual(['mixamo/clips/dying.fbx', 'mixamo/clips/standard-run-2.fbx', 'mixamo/clips/standard-run.fbx', 'mixamo/clips/standing-idle.fbx']);
  expect(added.results.map((result: { status: string }) => result.status)).toEqual(['imported', 'duplicate', 'imported', 'imported', 'rejected', 'imported']);
  expect(added).toMatchObject({ directory: resolve(folder), registry: registryFile(env), entries: 4, skipped: [] });
  const registry = await mixamoRegistry(folder, env);
  expect(registry.schema).toBe(REGISTRY_SCHEMA);
  expect(registry.terms).toMatch(/do not redistribute/);
  expect(registry.entries.map((entry: { id: string }) => entry.id)).toEqual(['dying', 'standard-run', 'standard-run-2', 'standing-idle']);
  expect(registry.entries.find((entry: { id: string }) => entry.id === 'dying')).toMatchObject({ file: 'mixamo/clips/dying.fbx', kind: 'clip-with-skin', hasMesh: true, clips: [{ seconds: 4.333 }] });
  expect((await readFile(join(downloads, 'Standard Run.fbx'))).length).toBeGreaterThan(0);
  // A second add copies nothing and gives the same registry.
  const before = await readFile(registryFile(env), 'utf8');
  expect((await addMixamo([join(downloads, 'Pack.zip')], folder, env, { render: stubRender })).copied).toEqual([]);
  expect(await readFile(registryFile(env), 'utf8')).toBe(before);
});

it('keeps the registry in the managed home and registers only Mixamo-skeleton files, so the folder can be a repository', async () => {
  const folder = await temp(), home = await temp(), env = { AGENT_MESHES_HOME: home };
  await mkdir(join(folder, 'animations', 'idle'), { recursive: true });
  await mkdir(join(folder, '.git', 'lfs'), { recursive: true });
  await writeFile(join(folder, 'animations', 'idle', 'breathing-idle.fbx'), clip(9.917));
  await writeFile(join(folder, 'animations', 'idle', 'later-download.fbx'), clip(2, { bones: ['mixamorig1:Hips', 'mixamorig1:Spine'] }));
  await writeFile(join(folder, 'animations', 'idle', 'other-rig.fbx'), clip(1, { bones: ['Hips', 'Spine'] }));
  await writeFile(join(folder, 'animations', 'idle', 'not-pulled.fbx'), LFS_POINTER);
  await writeFile(join(folder, '.git', 'lfs', 'hidden.fbx'), clip(1));
  const registry = await mixamoRegistry(folder, env);
  expect(registryFile(env)).toBe(join(home, REGISTRY_FILE));
  expect(registry.directory).toBe(resolve(folder));
  expect(registry.entries.map(entry => [entry.id, entry.skeleton])).toEqual([['breathing-idle', 'mixamorig'], ['later-download', 'mixamorig1']]);
  expect(Object.fromEntries(registry.skipped.map(item => [item.file, item.reason]))).toEqual({
    'animations/idle/not-pulled.fbx': expect.stringMatching(/Git LFS pointer/),
    'animations/idle/other-rig.fbx': 'not on the Mixamo skeleton (bone prefix: none)',
  });
  // Nothing is written into the folder itself.
  expect((await readdir(folder)).sort()).toEqual(['.git', 'animations']);
});

it('registers an FBX added by hand, without a sidecar, with its kind from the header', async () => {
  const folder = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  await writeFile(join(folder, 'Dying.fbx'), clip(4.333, { mesh: true }));
  await writeFile(join(folder, 'T Pose.fbx'), clip(0.033, { mesh: true }));
  await writeFile(join(folder, 'Dying.gif'), TINY_GIF);
  await writeFile(join(folder, 'notes.json'), '{}');
  const registry = await mixamoRegistry(folder, env);
  expect(registry.entries.map(({ id, kind, title, tags, note, motion, preview }) => ({ id, kind, title, tags, note, motion, preview }))).toEqual([
    { id: 'dying', kind: 'clip-with-skin', title: 'Dying', tags: [], note: '', motion: null, preview: null },
    { id: 't-pose', kind: 'character', title: 'T Pose', tags: [], note: '', motion: null, preview: null },
  ]);
  expect(registry.skipped).toEqual([]);
});

it('refreshes the registry when the folder changes, as after a pull, and when it points at another folder', async () => {
  const folder = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  expect((await mixamoRegistry(folder, env)).entries.map(entry => entry.id)).toEqual(['rifle-run']);
  await writeFile(join(folder, 'Rifle Idle.fbx'), clip(2));
  expect((await mixamoRegistry(folder, env)).entries.map(entry => entry.id)).toEqual(['rifle-idle', 'rifle-run']);
  await rm(join(folder, 'Rifle Run.fbx'));
  expect((await mixamoRegistry(folder, env)).entries.map(entry => entry.id)).toEqual(['rifle-idle']);
  const other = await temp();
  await writeFile(join(other, 'Jump.fbx'), clip(1));
  expect((await mixamoRegistry(other, env)).entries.map(entry => entry.id)).toEqual(['jump']);
  await expect(mixamoRegistry(join(other, 'missing'), env)).rejects.toThrow('No Mixamo folder');
});

it('gives a path only while the file still matches its registered bytes', async () => {
  const folder = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  // A whole-second time survives being set again exactly.
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  await utimes(join(folder, 'Rifle Run.fbx'), 1700000000, 1700000000);
  expect(await mixamoPath('rifle-run', folder, env)).toBe(join(folder, 'Rifle Run.fbx'));
  await expect(mixamoPath('rifle-walk', folder, env)).rejects.toThrow('Unknown Mixamo entry');
  // Same size and time but different bytes: the registry looks current, and the path check catches it.
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.9));
  await utimes(join(folder, 'Rifle Run.fbx'), 1700000000, 1700000000);
  await expect(mixamoPath('rifle-run', folder, env)).rejects.toThrow('changed since it was registered');
  expect((await scanMixamo(folder, env)).entries).toBe(1);
  expect(await mixamoPath('rifle-run', folder, env)).toBe(join(folder, 'Rifle Run.fbx'));
});

it('refuses an archive member that would leave the folder', () => {
  expect(() => unzipFbx(zip({ '../escape.fbx': clip(1) }))).toThrow('unsafe path');
  expect(unzipFbx(zip({ 'notes.txt': Buffer.from('x') }))).toEqual([]);
});

it('keeps Mixamo payloads out of the package: no FBX file is tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(file => /\.fbx$/i.test(file));
  expect(tracked).toEqual([]);
});

it('the CLI adds with --tags, lists the new fields, and picks up a hand-edited sidecar without a scan', async () => {
  const downloads = await temp(), library = await temp(), home = await temp(), env = { AGENT_MESHES_HOME: home };
  await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
  await writeFile(join(downloads, 'Notes.fbx'), 'just text');
  await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
  const cli = (...args: string[]) => {
    const run = spawnSync('node', [resolve('scripts/mixamo-library.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_MIXAMO_DIR: library, AGENT_MESHES_HOME: home } });
    expect(run.stderr).toBe('');
    return JSON.parse(run.stdout);
  };
  // Neither a duplicate nor a rejection renders a preview, so the CLI's own renderer is never started here.
  const added = cli('add', join(downloads, 'Walk.fbx'), join(downloads, 'Notes.fbx'), '--tags', 'ronin,Favourite');
  expect(added.results.map(({ status, id, reason }: { status: string; id?: string; reason?: string }) => ({ status, id, reason }))).toEqual([
    { status: 'duplicate', id: 'walk', reason: undefined }, { status: 'rejected', id: undefined, reason: 'not a binary FBX file' }]);
  const listed = cli('list', '--json');
  expect(listed.schema).toBe('agent-meshes/mixamo-registry/3');
  const walk = listed.entries.find((entry: { id: string }) => entry.id === 'walk');
  expect(walk).toMatchObject({ kind: 'clip', note: '', preview: 'walk.gif', tags: ['locomotion', 'root-motion'], motion: { inPlace: false } });
  // A pulled tag change: the sidecar is edited by hand, and the next list shows it.
  const path = join(library, 'mixamo/clips/walk.json'), meta = await sidecar(path);
  await writeFile(path, `${JSON.stringify({ ...meta, tags: ['locomotion', 'pulled-tag', 'root-motion'] }, null, 2)}\n`);
  expect(cli('list', '--json').entries.find((entry: { id: string }) => entry.id === 'walk').tags).toEqual(['locomotion', 'pulled-tag', 'root-motion']);
});

it('the Blender-side reader resolves the same folder and registry, and refreshes it after the folder changes', async () => {
  const folder = await temp(), home = await temp();
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  const read = () => {
    const script = [
      'import json, os, sys', `sys.path.insert(0, ${JSON.stringify(resolve('scripts/blender_lib'))})`, 'import agent_meshes_mixamo as m',
      'out = {"dir": str(m.mixamo_dir()), "registry": str(m.registry_file()), "ids": [e["id"] for e in m.registry()["entries"]], "path": str(m.clip_path("rifle-run"))}',
      'try: m.entry("nope")', 'except KeyError as error: out["unknown"] = str(error)', 'print(json.dumps(out))',
    ].join('\n');
    const python = spawnSync('python', ['-c', script], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_MIXAMO_DIR: folder, AGENT_MESHES_HOME: home } });
    expect(python.stderr).toBe('');
    return JSON.parse(python.stdout);
  };
  // No scan has run: the reader builds the registry through Node.
  const first = read();
  expect(resolve(first.dir)).toBe(resolve(folder));
  expect(resolve(first.registry)).toBe(join(home, REGISTRY_FILE));
  expect(first.ids).toEqual(['rifle-run']);
  expect(resolve(first.path)).toBe(resolve(folder, 'Rifle Run.fbx'));
  expect(first.unknown).toMatch(/Unknown Mixamo entry: nope/);
  await writeFile(join(folder, 'Rifle Idle.fbx'), clip(2));
  expect(read().ids).toEqual(['rifle-idle', 'rifle-run']);
});

it('the Blender-side reader returns the sidecar fields and sees a pulled sidecar change', async () => {
  const downloads = await temp(), library = await temp(), home = await temp(), env = { AGENT_MESHES_HOME: home };
  await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
  await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
  const read = () => {
    const script = [
      'import json, sys', `sys.path.insert(0, ${JSON.stringify(resolve('scripts/blender_lib'))})`, 'import agent_meshes_mixamo as m',
      'e = m.entry("walk")', 'print(json.dumps({"schema": m.registry()["schema"], "tags": e["tags"], "kind": e["kind"], "title": e["title"], "note": e["note"], "preview": e["preview"], "inPlace": e["motion"]["inPlace"]}))',
    ].join('\n');
    const python = spawnSync('python', ['-c', script], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_MIXAMO_DIR: library, AGENT_MESHES_HOME: home } });
    expect(python.stderr).toBe('');
    return JSON.parse(python.stdout);
  };
  const path = join(library, 'mixamo/clips/walk.json'), meta = await sidecar(path);
  expect(read()).toEqual({ schema: 'agent-meshes/mixamo-registry/3', tags: meta.tags, kind: 'clip', title: 'Walk', note: '', preview: 'walk.gif', inPlace: false });
  await writeFile(path, `${JSON.stringify({ ...meta, tags: ['from-another-machine'] }, null, 2)}\n`);
  expect(read().tags).toEqual(['from-another-machine']);
});

describe('ids, interrupted imports and damaged sidecars', () => {
  const imported = async () => {
    const downloads = await temp(), directory = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: stubRender });
    return { downloads, directory, env };
  };

  it('keeps an imported id when a file of the same name is added by hand elsewhere', async () => {
    const { directory, env } = await imported();
    await mkdir(join(directory, 'animations'));
    await writeFile(join(directory, 'animations', 'walk.fbx'), animatedFbx({ travel: 2 }));
    const registry = await mixamoRegistry(directory, env);
    expect(registry.entries.find(entry => entry.id === 'walk')?.file).toBe('mixamo/clips/walk.fbx');
    const hand = registry.entries.find(entry => entry.file === 'animations/walk.fbx');
    expect(hand?.id).toBeDefined();
    expect(hand?.id).not.toBe('walk');
  });

  it('gives concurrent imports of different files with one name their own ids, each with its own sidecar', async () => {
    const downloads = await temp(), directory = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    const folders = ['a', 'b', 'c', 'd', 'e', 'f'], expected = ['walk', 'walk-2', 'walk-3', 'walk-4', 'walk-5', 'walk-6'];
    for (const [i, folder] of folders.entries()) { await mkdir(join(downloads, folder)); await writeFile(join(downloads, folder, 'Walk.fbx'), animatedFbx({ travel: i + 1 })); }
    const slow = async () => { await new Promise(done => setTimeout(done, 20)); return stubRender(); };
    const runs = await Promise.all(folders.map(folder => importAssets([join(downloads, folder, 'Walk.fbx')], { directory, env, render: slow })));
    expect(runs.map(run => run.results[0].id).sort()).toEqual(expected);
    for (const id of expected) {
      const meta = await sidecar(join(directory, `mixamo/clips/${id}.json`));
      expect(meta.id).toBe(id);
      expect(meta.sha256).toBe(createHash('sha256').update(await readFile(join(directory, `mixamo/clips/${id}.fbx`))).digest('hex'));
    }
    expect((await tree(directory)).filter(file => /\.tmp$|\/\./.test(file))).toEqual([]);
  });

  it('ignores dotted temporary files in the library, in Node and in the Python reader', async () => {
    const { directory, env } = await imported();
    await writeFile(join(directory, 'mixamo/clips/.walk-3.fbx'), animatedFbx({ travel: 3 }));
    await writeFile(join(directory, 'mixamo/clips/.walk-3.fbx.1234.tmp'), 'partial');
    expect((await mixamoRegistry(directory, env)).entries.map(entry => entry.file)).toEqual(['mixamo/clips/walk.fbx']);
    const script = [
      'import json, sys', `sys.path.insert(0, ${JSON.stringify(resolve('scripts/blender_lib'))})`, 'import agent_meshes_mixamo as m', 'from pathlib import Path',
      `print(json.dumps(m._describes(m._read(${JSON.stringify(env)}), Path(${JSON.stringify(directory)}))))`,
    ].join('\n');
    const python = spawnSync('python', ['-c', script], { encoding: 'utf8' });
    expect(python.stderr).toBe('');
    expect(JSON.parse(python.stdout)).toBe(true);
  });

  it('repairs a duplicate whose preview or sidecar is missing, keeping its tags, title and note', async () => {
    const downloads = await temp(), directory = await temp(), env = { AGENT_MESHES_HOME: await temp() };
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
    await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: async () => { throw new Error('no GPU here'); } });
    await setTags(['walk'], ['ronin'], [], { directory, env });
    await setTitle('walk', 'Forward Walk', { directory, env });
    const again = await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: stubRender });
    expect(again.results).toEqual([{ source: join(downloads, 'Walk.fbx'), status: 'duplicate', id: 'walk', repaired: ['preview'] }]);
    expect(await sidecar(join(directory, 'mixamo/clips/walk.json'))).toMatchObject({ preview: 'walk.gif', title: 'Forward Walk', tags: ['locomotion', 'ronin', 'root-motion'] });
    expect((await readFile(join(directory, 'mixamo/clips/walk.gif'))).subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(again.registry.entries[0]).toMatchObject({ id: 'walk', preview: 'walk.gif' });
    // A crash before the sidecar was written: the next import of the same bytes writes it.
    await rm(join(directory, 'mixamo/clips/walk.json'));
    let renders = 0;
    const third = await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: async () => { renders++; return stubRender(); } });
    expect(third.results).toEqual([{ source: join(downloads, 'Walk.fbx'), status: 'duplicate', id: 'walk', repaired: ['sidecar'] }]);
    expect(renders).toBe(0);
    expect(await sidecar(join(directory, 'mixamo/clips/walk.json'))).toMatchObject({ id: 'walk', kind: 'clip', title: 'Walk', sourceName: 'Walk.fbx', preview: 'walk.gif', tags: ['locomotion', 'root-motion'], motion: { inPlace: false } });
  });

  it('refuses to edit a clip whose sidecar is not valid JSON, and lists it with the error', async () => {
    const { downloads, directory, env } = await imported();
    const path = join(directory, 'mixamo/clips/walk.json'), broken = '<<<<<<< HEAD\n{"tags": ["a"]}\n=======\n';
    await writeFile(path, broken);
    const entry = (await mixamoRegistry(directory, env)).entries.find(item => item.id === 'walk');
    expect(entry?.sidecarError).toMatch(/not valid JSON/);
    for (const edit of [() => setTags(['walk'], ['x'], [], { directory, env }), () => setTitle('walk', 'New', { directory, env }), () => setNote('walk', 'n', { directory, env })]) {
      await expect(edit()).rejects.toThrow(/sidecar .*walk\.json is not valid JSON; fix or restore it/);
    }
    // Importing the same bytes again does not paper over it either.
    expect((await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: stubRender })).results[0]).toMatchObject({ status: 'duplicate', id: 'walk' });
    expect(await readFile(path, 'utf8')).toBe(broken);
  });
});

it('refuses a library reached through a junction or symlink into an agent-meshes checkout', async () => {
  const checkout = await temp(), elsewhere = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  await mkdir(join(checkout, '.git'));
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'agent-meshes' }));
  await mkdir(join(checkout, 'inner'));
  const link = join(elsewhere, 'library-link');
  symlinkSync(join(checkout, 'inner'), link, 'junction');
  expect(() => assertNotMeshesCheckout(link)).toThrow(/never kept in an agent-meshes checkout/);
  expect(() => assertNotMeshesCheckout(join(link, 'not', 'made', 'yet'))).toThrow(/never kept in an agent-meshes checkout/);
  await expect(setTags(['walk'], ['x'], [], { directory: link, env })).rejects.toThrow(/never kept in an agent-meshes checkout/);
});

it('the CLI add renders a real preview with the default renderer', async () => {
  const downloads = await temp(), library = await temp(), home = await temp();
  await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1, seconds: 2 }));
  const run = spawnSync('node', [resolve('scripts/mixamo-library.mjs'), 'add', join(downloads, 'Walk.fbx')], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_MIXAMO_DIR: library, AGENT_MESHES_HOME: home } });
  expect(run.stderr).toBe('');
  expect(JSON.parse(run.stdout).results).toEqual([{ source: join(downloads, 'Walk.fbx'), status: 'imported', id: 'walk', kind: 'clip' }]);
  expect((await sidecar(join(library, 'mixamo/clips/walk.json'))).preview).toBe('walk.gif');
  expect((await readFile(join(library, 'mixamo/clips/walk.gif'))).subarray(0, 6).toString('latin1')).toBe('GIF89a');
}, 120000);

it('removes staging files left by an import that died, and keeps those of a live one', async () => {
  const downloads = await temp(), directory = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  const clips = join(directory, 'mixamo', 'clips');
  await mkdir(clips, { recursive: true });
  // A process that has exited: its pid is not live.
  const dead = spawnSync('node', ['-e', '0']).pid!;
  const stale = join(clips, `.walk.fbx.${dead}.deadbeef.tmp`), own = join(clips, `.walk-9.fbx.${process.pid}.0badf00d.tmp`);
  const live = join(clips, `.run.json.${process.ppid}.12345678.tmp`), old = join(clips, `.run.gif.${process.ppid}.87654321.tmp`);
  const unrelated = join(clips, '.notes.tmp');
  for (const path of [stale, own, live, old, unrelated]) await writeFile(path, animatedFbx({ travel: 1 }));
  const hoursAgo = Date.now() / 1000 - 2 * 3600;
  await utimes(old, hoursAgo, hoursAgo);
  await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
  await importAssets([join(downloads, 'Walk.fbx')], { directory, env, render: stubRender });
  const left = (await readdir(clips)).filter(name => name.startsWith('.')).sort();
  expect(left).toEqual(['.notes.tmp', `.run.json.${process.ppid}.12345678.tmp`, `.walk-9.fbx.${process.pid}.0badf00d.tmp`].sort());
});

it.skipIf(process.platform !== 'win32')('treats a library path in another letter case as the same folder on Windows, without a rescan', async () => {
  const folder = await temp(), env = { AGENT_MESHES_HOME: await temp() };
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  await mixamoRegistry(folder, env);
  const before = await readFile(registryFile(env), 'utf8');
  const recased = folder.toUpperCase() === folder ? folder.toLowerCase() : folder.toUpperCase();
  expect((await mixamoRegistry(recased, env)).entries.map(entry => entry.id)).toEqual(['rifle-run']);
  // A rescan would rewrite the registry with the other spelling of the folder.
  expect(await readFile(registryFile(env), 'utf8')).toBe(before);
  // The Python reader refreshes through Node with the folder's real case; Node then reads the same registry.
  const script = [
    'import json, sys', `sys.path.insert(0, ${JSON.stringify(resolve('scripts/blender_lib'))})`, 'import agent_meshes_mixamo as m',
    `print(json.dumps([e["id"] for e in m.registry(${JSON.stringify(recased)}, ${JSON.stringify(env)})["entries"]]))`,
  ].join('\n');
  const python = spawnSync('python', ['-c', script], { encoding: 'utf8' });
  expect(python.stderr).toBe('');
  expect(JSON.parse(python.stdout)).toEqual(['rifle-run']);
  expect(await readFile(registryFile(env), 'utf8')).toBe(before);
});
