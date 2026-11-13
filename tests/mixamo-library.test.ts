import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { addMixamo, describeFbx, mixamoDir, mixamoPath, mixamoRegistry, scanMixamo, slug, unzipFbx, REGISTRY_SCHEMA } from '../scripts/mixamo-library.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'mesh-mixamo-')); directories.push(path); return path; };

type Property = string | number | bigint;
type Node = { name: string; properties?: Property[]; children?: Node[] };
/** A binary FBX 7.4 file holding these nodes: enough of the format for the registry's reader. */
function fbx(nodes: Node[]): Buffer {
  const property = (value: Property) => {
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

it('adds files, folders and archives, lists identical bytes once and leaves the sources alone', async () => {
  const downloads = await temp(), folder = await temp();
  await writeFile(join(downloads, 'Standard Run.fbx'), clip(0.717));
  await writeFile(join(downloads, 'Standard Run copy.fbx'), clip(0.717));
  await writeFile(join(downloads, 'Pack.zip'), zip({ 'Standing Idle.fbx': clip(1.867), 'Standard Run.fbx': clip(0.733), 'readme.txt': Buffer.from('skip me') }));
  await mkdir(join(downloads, 'More'));
  await writeFile(join(downloads, 'More', 'Dying.fbx'), clip(4.333, { mesh: true }));
  await writeFile(join(downloads, 'More', 'broken.fbx'), 'text');
  const added = await addMixamo([join(downloads, 'Standard Run.fbx'), join(downloads, 'Standard Run copy.fbx'), join(downloads, 'Pack.zip'), join(downloads, 'More')], folder);
  expect(added.copied.sort()).toEqual(['More/Dying.fbx', 'More/broken.fbx', 'Pack/Standard Run.fbx', 'Pack/Standing Idle.fbx', 'Standard Run copy.fbx', 'Standard Run.fbx']);
  expect(added.skipped.map(item => item.file).sort()).toEqual(['More/broken.fbx', 'Standard Run.fbx']);
  const registry = await mixamoRegistry(folder);
  expect(registry.schema).toBe(REGISTRY_SCHEMA);
  expect(registry.terms).toMatch(/do not redistribute/);
  expect(registry.entries.map(entry => entry.id)).toEqual(['dying', 'standard-run', 'standard-run-copy', 'standing-idle']);
  expect(registry.entries.find(entry => entry.id === 'dying')).toMatchObject({ file: 'More/Dying.fbx', hasMesh: true, clips: [{ seconds: 4.333 }] });
  expect((await readFile(join(downloads, 'Standard Run.fbx'))).length).toBeGreaterThan(0);
  // A second add copies nothing and gives the same registry.
  const before = await readFile(join(folder, 'registry.json'), 'utf8');
  expect((await addMixamo([join(downloads, 'Pack.zip')], folder)).copied).toEqual([]);
  expect(await readFile(join(folder, 'registry.json'), 'utf8')).toBe(before);
});

it('gives a path only while the file still matches its registered bytes', async () => {
  const folder = await temp();
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  await expect(mixamoRegistry(folder)).rejects.toThrow('No Mixamo registry');
  expect((await scanMixamo(folder)).entries).toBe(1);
  expect(await mixamoPath('rifle-run', folder)).toBe(join(folder, 'Rifle Run.fbx'));
  await expect(mixamoPath('rifle-walk', folder)).rejects.toThrow('Unknown Mixamo entry');
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.9));
  await expect(mixamoPath('rifle-run', folder)).rejects.toThrow('changed since it was registered');
});

it('refuses an archive member that would leave the folder', () => {
  expect(() => unzipFbx(zip({ '../escape.fbx': clip(1) }))).toThrow('unsafe path');
  expect(unzipFbx(zip({ 'notes.txt': Buffer.from('x') }))).toEqual([]);
});

it('keeps Mixamo payloads out of the package: no FBX file is tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(file => /\.fbx$/i.test(file));
  expect(tracked).toEqual([]);
});

it('the Blender-side reader resolves the same folder, registry and checked path', async () => {
  const folder = await temp();
  await writeFile(join(folder, 'Rifle Run.fbx'), clip(0.717));
  await scanMixamo(folder);
  const script = [
    'import json, os, sys', `sys.path.insert(0, ${JSON.stringify(resolve('scripts/blender_lib'))})`, 'import agent_meshes_mixamo as m',
    'out = {"dir": str(m.mixamo_dir()), "ids": [e["id"] for e in m.registry()["entries"]], "path": str(m.clip_path("rifle-run"))}',
    'try: m.entry("nope")', 'except KeyError as error: out["unknown"] = str(error)', 'print(json.dumps(out))',
  ].join('\n');
  const python = spawnSync('python', ['-c', script], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_MIXAMO_DIR: folder } });
  expect(python.stderr).toBe('');
  const out = JSON.parse(python.stdout);
  expect(resolve(out.dir)).toBe(resolve(folder));
  expect(out.ids).toEqual(['rifle-run']);
  expect(resolve(out.path)).toBe(resolve(folder, 'Rifle Run.fbx'));
  expect(out.unknown).toMatch(/Unknown Mixamo entry: nope/);
});
