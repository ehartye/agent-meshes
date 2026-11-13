#!/usr/bin/env node
// A local folder of Adobe Mixamo downloads and a registry of what is in it. The FBX files stay on the machine that
// downloaded them: this script never copies one into a package, a project or version control.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

export const REGISTRY_SCHEMA = 'agent-meshes/mixamo-registry/1';
export const REGISTRY_FILE = 'registry.json';
export const TERMS = 'Adobe Mixamo files are licensed to the Adobe account that downloaded them. Use them in your own work; do not redistribute the files or commit them to a repository.';
const KTIME_PER_SECOND = 46186158000;

/** The folder: AGENT_MESHES_MIXAMO_DIR, else `mixamo` in the managed home (AGENT_MESHES_HOME, else ~/.agent-meshes). */
export function mixamoDir(env = process.env) {
  if (env.AGENT_MESHES_MIXAMO_DIR) return resolve(env.AGENT_MESHES_MIXAMO_DIR);
  return join(env.AGENT_MESHES_HOME ? resolve(env.AGENT_MESHES_HOME) : join(homedir(), '.agent-meshes'), 'mixamo');
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slug = text => text.normalize('NFKD').replace(/[^\w\s().-]/g, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Walk a binary FBX's node records. `visit(name, properties, depth)` returns false to skip a node's children. */
export function walkFbx(bytes, visit) {
  if (bytes.length < 27 || bytes.subarray(0, 20).toString('latin1') !== 'Kaydara FBX Binary  ') throw new Error('not a binary FBX file');
  const version = bytes.readUInt32LE(23), wide = version >= 7500, head = wide ? 25 : 13;
  const word = offset => wide ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset);
  const property = offset => {
    const type = String.fromCharCode(bytes[offset]); let at = offset + 1;
    if (type === 'Y') return [bytes.readInt16LE(at), at + 2];
    if (type === 'C') return [bytes[at] !== 0, at + 1];
    if (type === 'I') return [bytes.readInt32LE(at), at + 4];
    if (type === 'F') return [bytes.readFloatLE(at), at + 4];
    if (type === 'D') return [bytes.readDoubleLE(at), at + 8];
    if (type === 'L') return [bytes.readBigInt64LE(at), at + 8];
    if (type === 'S' || type === 'R') { const length = bytes.readUInt32LE(at); at += 4; return [type === 'S' ? bytes.subarray(at, at + length).toString('utf8') : null, at + length]; }
    if ('fdlib'.includes(type)) {
      // Arrays are skipped: nothing the registry records lives in one.
      const count = bytes.readUInt32LE(at), encoding = bytes.readUInt32LE(at + 4), stored = bytes.readUInt32LE(at + 8);
      return [{ array: type, count, encoding }, at + 12 + stored];
    }
    throw new Error(`unknown FBX property type ${JSON.stringify(type)} at byte ${offset}`);
  };
  const node = (offset, depth) => {
    const end = word(offset), count = word(offset + (wide ? 8 : 4)), nameLength = bytes[offset + head - 1];
    if (end === 0) return 0;
    if (end > bytes.length || end <= offset) throw new Error(`FBX node at byte ${offset} ends outside the file`);
    const name = bytes.subarray(offset + head, offset + head + nameLength).toString('latin1');
    let at = offset + head + nameLength; const properties = [];
    for (let i = 0; i < count; i++) { const [value, next] = property(at); properties.push(value); at = next; }
    if (visit(name, properties, depth) !== false) while (at < end) { const next = node(at, depth + 1); if (!next) break; at = next; }
    return end;
  };
  let at = 27;
  while (at < bytes.length - head) { const next = node(at, 0); if (!next) break; at = next; }
  return version;
}

/** What the registry records about one FBX: clips and their length, the skeleton, whether a skinned mesh is inside. */
export function describeFbx(bytes) {
  const clips = [], bones = new Set(); let creator = null, meshes = 0, stack = null, object = null, prefix = null;
  const version = walkFbx(bytes, (name, properties, depth) => {
    if (depth === 0) { stack = null; object = null; return ['FBXHeaderExtension', 'Objects'].includes(name); }
    if (name === 'Creator' && typeof properties[0] === 'string') creator = properties[0];
    if (depth === 1) {
      stack = null; object = name;
      const [, label, kind] = properties, title = typeof label === 'string' ? label.split('\u0000')[0] : '';
      if (name === 'Model' && kind === 'LimbNode') { bones.add(title); return false; }
      if (name === 'Geometry' && kind === 'Mesh') { meshes++; return false; }
      if (name === 'AnimationStack') { stack = { name: title, seconds: null }; clips.push(stack); return true; }
      return name === 'SceneInfo' || name === 'Creator';
    }
    if (stack && name === 'P' && properties[0] === 'LocalStop') stack.seconds = Math.round(Number(properties[4]) / KTIME_PER_SECOND * 1000) / 1000;
    return object === 'AnimationStack' || object === 'SceneInfo';
  });
  for (const bone of bones) if (bone.includes(':')) { prefix = bone.slice(0, bone.indexOf(':')); break; }
  return { fbxVersion: version, creator, skeleton: prefix, bones: bones.size, hasMesh: meshes > 0, clips };
}

/** The .fbx members of a zip archive as [{ name, bytes }], stored or deflated; nothing else is read. */
export function unzipFbx(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive');
  const count = bytes.readUInt16LE(end + 10), out = []; let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('zip central directory is damaged');
    const method = bytes.readUInt16LE(at + 10), packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (extname(name).toLowerCase() !== '.fbx') continue;
    // A member may not leave the folder it is extracted into.
    if (name.split(/[\\/]/).some(part => part === '..') || /^([\\/]|[A-Za-z]:)/.test(name)) throw new Error(`zip member has an unsafe path: ${name}`);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), raw = bytes.subarray(data, data + packed);
    if (method !== 0 && method !== 8) throw new Error(`zip member ${name} uses unsupported compression ${method}`);
    const member = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (member.length !== size) throw new Error(`zip member ${name} has the wrong size`);
    out.push({ name, bytes: member });
  }
  return out;
}

async function fbxFiles(folder, base = folder) {
  const found = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await fbxFiles(path, base));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.fbx') found.push(relative(base, path).split(sep).join('/'));
  }
  return found;
}

/** Read every FBX under the folder and write registry.json beside them. Identical files are listed once. */
export async function scanMixamo(directory = mixamoDir()) {
  await mkdir(directory, { recursive: true });
  const entries = [], skipped = [], seen = new Map(), ids = new Set();
  for (const file of await fbxFiles(directory)) {
    const bytes = await readFile(join(directory, file)), hash = sha256(bytes);
    if (seen.has(hash)) { skipped.push({ file, reason: `the same bytes as ${seen.get(hash)}` }); continue; }
    let facts;
    try { facts = describeFbx(bytes); } catch (error) { skipped.push({ file, reason: error.message }); continue; }
    seen.set(hash, file);
    let id = slug(basename(file)) || 'clip';
    // A second file of the same name is told apart by its folder, then by a number.
    if (ids.has(id) && dirname(file) !== '.') id = `${slug(dirname(file))}-${id}`;
    for (let n = 2, stem = id; ids.has(id); n++) id = `${stem}-${n}`;
    ids.add(id);
    entries.push({ id, file, sha256: hash, bytes: bytes.length, ...facts });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const registry = { schema: REGISTRY_SCHEMA, source: 'Adobe Mixamo', terms: TERMS, entries };
  await writeFile(join(directory, REGISTRY_FILE), `${JSON.stringify(registry, null, 1)}\n`);
  return { directory, registry: join(directory, REGISTRY_FILE), entries: entries.length, skipped };
}

/** Copy downloads (FBX files, zip archives or folders of them) into the folder, then rescan. Sources are left alone. */
export async function addMixamo(sources, directory = mixamoDir()) {
  if (!sources.length) throw new Error('add <file.fbx | pack.zip | folder> ...');
  await mkdir(directory, { recursive: true });
  const copied = [];
  const place = async (target, write) => {
    try { await stat(target); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(target), { recursive: true }); await write(target); copied.push(relative(directory, target).split(sep).join('/'));
  };
  for (const source of sources.map(path => resolve(path))) {
    const info = await stat(source), kind = extname(source).toLowerCase();
    if (info.isDirectory()) for (const file of await fbxFiles(source)) await place(join(directory, basename(source), file), target => copyFile(join(source, file), target));
    else if (kind === '.fbx') await place(join(directory, basename(source)), target => copyFile(source, target));
    else if (kind === '.zip') for (const member of unzipFbx(await readFile(source))) await place(join(directory, basename(source, extname(source)), member.name), target => writeFile(target, member.bytes));
    else throw new Error(`${source}: expected an .fbx file, a .zip archive or a folder`);
  }
  return { copied, ...await scanMixamo(directory) };
}

export async function mixamoRegistry(directory = mixamoDir()) {
  let text;
  try { text = await readFile(join(directory, REGISTRY_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`No Mixamo registry in ${directory}: add downloads with "mixamo-library.mjs add <file>" or run "scan"`); throw error; }
  const registry = JSON.parse(text);
  if (registry.schema !== REGISTRY_SCHEMA) throw new Error(`${join(directory, REGISTRY_FILE)}: expected schema ${REGISTRY_SCHEMA}; run "scan"`);
  return registry;
}

/** The absolute path of one registered file, after checking its bytes still match the registry. */
export async function mixamoPath(id, directory = mixamoDir()) {
  const entry = (await mixamoRegistry(directory)).entries.find(item => item.id === id);
  if (!entry) throw new Error(`Unknown Mixamo entry: ${id} (see "list")`);
  const path = resolve(directory, entry.file);
  if (sha256(await readFile(path)) !== entry.sha256) throw new Error(`${entry.file} changed since it was registered; run "scan"`);
  return path;
}

async function main() {
  const [command = 'list', ...args] = process.argv.slice(2), json = args.includes('--json'), rest = args.filter(arg => arg !== '--json');
  if (command === 'dir') console.log(mixamoDir());
  else if (command === 'scan') console.log(JSON.stringify(await scanMixamo(), null, 2));
  else if (command === 'add') console.log(JSON.stringify(await addMixamo(rest), null, 2));
  else if (command === 'path') console.log(await mixamoPath(rest[0] ?? ''));
  else if (command === 'list') {
    const registry = await mixamoRegistry();
    if (json) console.log(JSON.stringify(registry, null, 2));
    else for (const entry of registry.entries) console.log([entry.id, entry.clips.map(clip => `${clip.seconds ?? '?'}s`).join(',') || 'no clip', `${entry.bones} bones`, entry.hasMesh ? 'mesh' : 'motion only', entry.file].join('\t'));
  } else throw new Error('Usage: node scripts/mixamo-library.mjs dir | add <file.fbx | pack.zip | folder> ... | scan | list [--json] | path <id>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
