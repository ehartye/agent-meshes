#!/usr/bin/env node
// A library of Adobe Mixamo downloads and a registry of what is in it. The library can be any directory the owner keeps
// them in, such as a private repository cloned on each of their machines. Nothing here copies an FBX into agent-meshes:
// every write refuses a library inside an agent-meshes checkout.
//
// Layout: `mixamo/clips/<id>.fbx|.gif|.json` for anything with a motion take, `mixamo/characters/<id>.*` for a mesh
// with only a rest take. The `.json` sidecar (schema agent-meshes/mixamo-asset/1) holds the title, tags, note and
// motion summary; the registry in the managed home merges the sidecars and refreshes when any FBX or sidecar changes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

export const REGISTRY_SCHEMA = 'agent-meshes/mixamo-registry/3';
export const ASSET_SCHEMA = 'agent-meshes/mixamo-asset/1';
export const REGISTRY_FILE = 'mixamo-registry.json';
export const TERMS = 'Adobe Mixamo files are licensed to the Adobe account that downloaded them. Use them in your own work; do not redistribute the files or commit them to agent-meshes.';
export const KINDS = ['clip', 'clip-with-skin', 'character'];
const KTIME_PER_SECOND = 46186158000;
/** A take this long or shorter is a rest pose (one frame at 30 fps is 0.033 s). */
const REST_TAKE_SECONDS = 0.05;

/** The folder: AGENT_MESHES_MIXAMO_DIR, else `mixamo` in the managed home (AGENT_MESHES_HOME, else ~/.agent-meshes). */
export function mixamoDir(env = process.env) {
  if (env.AGENT_MESHES_MIXAMO_DIR) return resolve(env.AGENT_MESHES_MIXAMO_DIR);
  return join(env.AGENT_MESHES_HOME ? resolve(env.AGENT_MESHES_HOME) : join(homedir(), '.agent-meshes'), 'mixamo');
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slug = text => text.normalize('NFKD').replace(/[^\w\s().-]/g, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Walk a binary FBX's node records. `visit(name, properties, depth)` returns false to skip a node's children.
 *  An array property is `{ array, count, encoding, start, stored }`; `decodeArray` reads its values. */
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
      // Arrays are not decoded here; only the motion summary needs any, and it decodes them on demand.
      const count = bytes.readUInt32LE(at), encoding = bytes.readUInt32LE(at + 4), stored = bytes.readUInt32LE(at + 8);
      return [{ array: type, count, encoding, start: at + 12, stored }, at + 12 + stored];
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

/** The values of an FBX array property as numbers, stored raw (encoding 0) or zlib-compressed (encoding 1). */
export function decodeArray(bytes, array) {
  let raw = bytes.subarray(array.start, array.start + array.stored);
  if (array.encoding === 1) raw = inflateSync(raw);
  else if (array.encoding !== 0) throw new Error(`unknown FBX array encoding ${array.encoding}`);
  const size = { f: 4, d: 8, l: 8, i: 4, b: 1 }[array.array], read = {
    f: at => raw.readFloatLE(at), d: at => raw.readDoubleLE(at), l: at => Number(raw.readBigInt64LE(at)), i: at => raw.readInt32LE(at), b: at => raw[at],
  }[array.array];
  if (raw.length < array.count * size) throw new Error('FBX array is shorter than its count');
  const out = new Array(array.count);
  for (let i = 0; i < array.count; i++) out[i] = read(i * size);
  return out;
}

const label = value => typeof value === 'string' ? value.split('\u0000')[0] : '';

/** What the registry records about one FBX: clips and their length, the skeleton, whether a skinned mesh is inside. */
export function describeFbx(bytes) {
  const clips = [], bones = new Set(); let creator = null, meshes = 0, stack = null, object = null, prefix = null;
  const version = walkFbx(bytes, (name, properties, depth) => {
    if (depth === 0) { stack = null; object = null; return ['FBXHeaderExtension', 'Objects'].includes(name); }
    if (name === 'Creator' && typeof properties[0] === 'string') creator = properties[0];
    if (depth === 1) {
      stack = null; object = name;
      const [, text, kind] = properties, title = label(text);
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

/** `character` (a mesh, and every take one frame or shorter), `clip-with-skin` (a mesh and a longer take) or `clip`. */
export function assetKind({ hasMesh, clips }) {
  if (!hasMesh) return 'clip';
  return (clips ?? []).every(take => (take.seconds ?? 0) <= REST_TAKE_SECONDS) ? 'character' : 'clip-with-skin';
}

/** How the hips move over the longest take, from the Hips `Lcl Translation` curves. Mixamo files are Y up in
 *  centimetres (GlobalSettings UnitScaleFactor scales other units). Travel is the horizontal (X, Z) distance from the
 *  first key to the last; rise and drop are relative to the first key. A take without hips curves is in place. */
export function motionSummary(bytes) {
  const models = new Map(), stacks = new Map(), layers = new Set(), curveNodes = new Map(), curves = new Map(), links = [];
  let top = null, object = null, stack = null, curve = null, unit = 1;
  walkFbx(bytes, (name, properties, depth) => {
    if (depth === 0) { top = name; return ['GlobalSettings', 'Objects', 'Connections'].includes(name); }
    if (top === 'Connections') { if (name === 'C') links.push([properties[0], String(properties[1]), String(properties[2]), properties[3]]); return false; }
    if (top === 'GlobalSettings') { if (name === 'P' && properties[0] === 'UnitScaleFactor') unit = Number(properties[4]) || 1; return true; }
    if (depth === 1) {
      object = name; stack = null; curve = null;
      const [id, text, kind] = properties, key = String(id), title = label(text);
      if (name === 'Model' && kind === 'LimbNode') models.set(key, title);
      else if (name === 'AnimationStack') { stack = { seconds: null }; stacks.set(key, stack); return true; }
      else if (name === 'AnimationLayer') layers.add(key);
      else if (name === 'AnimationCurveNode') curveNodes.set(key, title);
      else if (name === 'AnimationCurve') { curve = { times: [], values: [] }; curves.set(key, curve); return true; }
      return false;
    }
    if (object === 'AnimationStack') { if (stack && name === 'P' && properties[0] === 'LocalStop') stack.seconds = Number(properties[4]) / KTIME_PER_SECOND; return true; }
    if (curve && depth === 2 && properties[0]?.array) {
      if (name === 'KeyValueFloat') curve.values = decodeArray(bytes, properties[0]);
      else if (name === 'KeyTime') curve.times = decodeArray(bytes, properties[0]).map(time => time / KTIME_PER_SECOND);
    }
    return false;
  });
  // The hips: the bone named Hips (after any prefix), else the first bone.
  let hips = new Set([...models].filter(([, name]) => name.split(':').pop() === 'Hips').map(([id]) => id));
  if (!hips.size && models.size) hips = new Set([models.keys().next().value]);
  // The longest take, and the curve nodes of its layers; without that wiring, every curve node.
  const [take, info] = [...stacks].reduce((best, item) => (item[1].seconds ?? 0) > (best[1]?.seconds ?? -1) ? item : best, [null, null]);
  const takeLayers = new Set(links.filter(([type, child, parent]) => type === 'OO' && parent === take && layers.has(child)).map(([, child]) => child));
  const inTake = new Set(links.filter(([type, child, parent]) => type === 'OO' && takeLayers.has(parent) && curveNodes.has(child)).map(([, child]) => child));
  const candidates = inTake.size ? inTake : new Set(curveNodes.keys());
  const translation = new Set(links.filter(([type, child, parent, property]) => type === 'OP' && candidates.has(child) && curveNodes.get(child) === 'T' && hips.has(parent) && property === 'Lcl Translation').map(([, child]) => child));
  const axes = {};
  for (const [type, child, parent, property] of links) {
    if (type !== 'OP' || !translation.has(parent) || !curves.has(child)) continue;
    const axis = String(property ?? '').slice(-1).toLowerCase(), { values, times } = curves.get(child);
    if (!'xyz'.includes(axis) || !axis || !values.length || (axes[axis] && axes[axis].values.length >= values.length)) continue;
    axes[axis] = { values: values.map(value => value * unit), times };
  }
  let seconds = info?.seconds ?? null;
  if (seconds === null) { const times = Object.values(axes).flatMap(axis => axis.times); seconds = times.length ? Math.max(...times) - Math.min(...times) : 0; }
  seconds = Math.round(seconds * 1000) / 1000;
  const first = axis => axes[axis] ? axes[axis].values[0] : 0, last = axis => axes[axis] ? axes[axis].values.at(-1) : 0;
  const extreme = (axis, pick) => axes[axis] ? axes[axis].values.reduce((a, b) => pick(a, b)) : 0;
  const span = axis => extreme(axis, Math.max) - extreme(axis, Math.min);
  const travelCm = Math.hypot(last('x') - first('x'), last('z') - first('z')), rangeCm = Math.hypot(span('x'), span('z'));
  const riseCm = axes.y ? extreme('y', Math.max) - first('y') : 0, dropCm = axes.y ? first('y') - extreme('y', Math.min) : 0;
  const inPlace = travelCm < 15 && rangeCm < 30, hipsRiseCm = Math.round(riseCm), hipsDropCm = Math.round(dropCm);
  const parts = [inPlace ? 'in place' : `root motion · travels ${(travelCm / 100).toFixed(1)} m`];
  if (hipsRiseCm >= 5) parts.push(`hips rise ${hipsRiseCm} cm`);
  if (hipsDropCm >= 5) parts.push(`hips drop ${hipsDropCm} cm`);
  parts.push(`${seconds.toFixed(1)} s`);
  return { seconds, travelMeters: Math.round(travelCm) / 100, inPlace, hipsRiseCm, hipsDropCm, summary: parts.join(' · ') };
}

/** Kind tags, the first match on the clip name (case-insensitive) wins. */
const KIND_TAGS = [
  ['roll', ['roll']],
  ['transitions', [' to ', 'equip', 'disarm']],
  ['hit-and-death', ['hit', 'death', 'dying', 'knocked', 'impact']],
  ['magic', ['spell', 'cast', 'magic']],
  ['melee', ['slash', 'stab', 'punch', 'kick', 'attack', 'combo', 'sword']],
  ['ranged', ['shoot', 'rifle', 'pistol', 'bow', 'throw']],
  ['jump', ['jump', 'dodge']],
  ['locomotion', ['walk', 'run', 'jog', 'sprint', 'strafe', 'crouch', 'swim', 'climb']],
  ['idle', ['idle', 'breath', 'stand']],
];
/** Tags as stored: lower-case kebab, unique, sorted. */
export const normalizeTags = tags => [...new Set((tags ?? []).map(tag => String(tag).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean))].sort();
/** The suggested tags for an import: one kind tag from the name, and `in-place`/`root-motion` (or `character`). */
export function suggestTags(title, kind, motion) {
  const name = ` ${String(title).toLowerCase()} `;
  const tags = [KIND_TAGS.find(([, words]) => words.some(word => name.includes(word)))?.[0] ?? 'pose-or-emote'];
  if (kind === 'character') tags.push('character');
  else if (motion) tags.push(motion.inPlace ? 'in-place' : 'root-motion');
  return normalizeTags(tags);
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

const POINTER = 'version https://git-lfs.github.com/spec/';
const POINTER_REASON = 'a Git LFS pointer, not the file: run "git lfs pull" in its repository';
/** Bone-name prefixes of Mixamo's own skeleton: `mixamorig`, and `mixamorig1`, `mixamorig2` ... on later downloads. */
export const MIXAMO_SKELETON = /^mixamorig\d*$/;

/** Every FBX under the folder with its size and modification time, skipping dot folders such as `.git`, and node_modules. */
export async function fbxFiles(folder, base = folder) {
  const found = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) { if (!entry.name.startsWith('.') && entry.name !== 'node_modules') found.push(...await fbxFiles(path, base)); }
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.fbx') found.push({ file: relative(base, path).split(sep).join('/'), ...await stampOf(path) });
  }
  return found;
}
const stampOf = async path => { const info = await stat(path, { bigint: true }); return { bytes: Number(info.size), mtimeMs: Number(info.mtimeNs / 1000000n) }; };
/** The sidecar beside an FBX: the same path with `.json` for the extension. */
const sidecarOf = file => file.replace(/\.fbx$/i, '.json');
/** The size and time of every sidecar beside one of these FBX files, so a pulled tag change refreshes the registry. */
async function sidecarFiles(directory, files) {
  const found = [];
  for (const { file } of files) {
    const path = join(directory, sidecarOf(file));
    try { const info = await stat(path, { bigint: true }); if (info.isFile()) found.push({ file: sidecarOf(file), bytes: Number(info.size), mtimeMs: Number(info.mtimeNs / 1000000n) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return found;
}
async function readSidecar(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return data && typeof data === 'object' && data.schema === ASSET_SCHEMA ? data : null;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
/** The fields an entry takes from its sidecar, or from the header and file name when it has none. */
function sidecarFields(meta, file, facts) {
  return {
    kind: KINDS.includes(meta?.kind) ? meta.kind : assetKind(facts),
    title: typeof meta?.title === 'string' && meta.title.trim() ? meta.title : basename(file, extname(file)),
    tags: normalizeTags(Array.isArray(meta?.tags) ? meta.tags : []),
    note: typeof meta?.note === 'string' ? meta.note : '',
    motion: meta?.motion && typeof meta.motion === 'object' ? meta.motion : null,
    preview: typeof meta?.preview === 'string' && meta.preview ? basename(meta.preview) : null,
  };
}

/** The managed home: AGENT_MESHES_HOME, else ~/.agent-meshes. */
const managedHome = env => env.AGENT_MESHES_HOME ? resolve(env.AGENT_MESHES_HOME) : join(homedir(), '.agent-meshes');
/** The registry lives in the managed home, never inside the folder, so the folder can be any directory, a repository included. */
export const registryFile = (env = process.env) => join(managedHome(env), REGISTRY_FILE);
const facts = ({ fbxVersion, creator, skeleton, bones, hasMesh, clips }) => ({ fbxVersion, creator, skeleton, bones, hasMesh, clips });

/** Read every FBX under the folder, merge each one's sidecar, and write the registry. Identical files are listed once,
 *  and files that are not on Mixamo's skeleton are skipped with the reason. `reuse` is an earlier registry of the same
 *  folder: an FBX whose size and modification time are unchanged keeps what that registry read, without being read
 *  again. Sidecars are always read. */
export async function scanMixamo(directory, env = process.env, { reuse = null } = {}) {
  directory = resolve(directory ?? mixamoDir(env));
  await mkdir(directory, { recursive: true });
  const known = new Map((reuse?.directory === directory ? [...reuse.entries, ...reuse.skipped] : []).map(item => [item.file, item]));
  const entries = [], skipped = [], seen = new Map(), ids = new Set(), files = await fbxFiles(directory);
  for (const stamp of files) {
    const { file } = stamp, old = known.get(file);
    let hash, read = null, problem = null;
    if (old && old.bytes === stamp.bytes && old.mtimeMs === stamp.mtimeMs) {
      hash = old.sha256; problem = old.problem ?? null; read = problem ? null : facts(old);
    } else {
      const bytes = await readFile(join(directory, file)); hash = sha256(bytes);
      if (bytes.subarray(0, POINTER.length).toString('latin1') === POINTER) problem = POINTER_REASON;
      else try { read = describeFbx(bytes); } catch (error) { problem = error.message; }
    }
    if (!problem && !MIXAMO_SKELETON.test(read.skeleton ?? '')) problem = `not on the Mixamo skeleton (bone prefix: ${read.skeleton ?? 'none'})`;
    // Skipped files keep what was read, so an unchanged one is not read again on the next scan.
    if (problem) { skipped.push({ ...stamp, sha256: hash, reason: problem, problem, ...(read ?? {}) }); continue; }
    if (seen.has(hash)) { skipped.push({ ...stamp, sha256: hash, reason: `the same bytes as ${seen.get(hash)}`, ...read }); continue; }
    seen.set(hash, file);
    let id = slug(basename(file)) || 'clip';
    // A second file of the same name is told apart by its folder, then by a number.
    if (ids.has(id) && dirname(file) !== '.') id = `${slug(dirname(file))}-${id}`;
    for (let n = 2, stem = id; ids.has(id); n++) id = `${stem}-${n}`;
    ids.add(id);
    entries.push({ id, ...stamp, sha256: hash, ...read, ...sidecarFields(await readSidecar(join(directory, sidecarOf(file))), file, read) });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const sidecars = await sidecarFiles(directory, files);
  const registry = { schema: REGISTRY_SCHEMA, source: 'Adobe Mixamo', terms: TERMS, directory, entries, skipped, sidecars };
  const target = registryFile(env), staging = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(staging, `${JSON.stringify(registry, null, 1)}\n`);
  await rename(staging, target);
  return { directory, registry: target, entries: entries.length, skipped: skipped.map(({ file, reason }) => ({ file, reason })) };
}

async function readRegistry(env) {
  let registry;
  try { registry = JSON.parse(await readFile(registryFile(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return registry.schema === REGISTRY_SCHEMA ? registry : null;
}

/** The registry of the folder. When the folder's FBX files or sidecars differ from it (after a pull, an add or an edit
 *  by hand), or it describes another folder, the folder is scanned again first; unchanged FBX files are not read again. */
export async function mixamoRegistry(directory, env = process.env) {
  directory = resolve(directory ?? mixamoDir(env));
  try { await stat(directory); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No Mixamo folder at ${directory}: set AGENT_MESHES_MIXAMO_DIR, or add downloads with "mixamo-library.mjs add <file>"`);
    throw error;
  }
  const registry = await readRegistry(env);
  if (registry?.directory === directory) {
    const same = (listed, found) => { const map = new Map(listed.map(item => [item.file, `${item.bytes}:${item.mtimeMs}`])); return found.length === map.size && found.every(item => map.get(item.file) === `${item.bytes}:${item.mtimeMs}`); };
    const files = await fbxFiles(directory);
    if (same([...registry.entries, ...registry.skipped], files) && same(registry.sidecars ?? [], await sidecarFiles(directory, files))) return registry;
  }
  await scanMixamo(directory, env, { reuse: registry });
  return readRegistry(env);
}

/** The absolute path of one registered file, after checking its bytes still match the registry. */
export async function mixamoPath(id, directory, env = process.env) {
  directory = resolve(directory ?? mixamoDir(env));
  const entry = (await mixamoRegistry(directory, env)).entries.find(item => item.id === id);
  if (!entry) throw new Error(`Unknown Mixamo entry: ${id} (see "list")`);
  const path = resolve(directory, entry.file);
  if (sha256(await readFile(path)) !== entry.sha256) throw new Error(`${entry.file} changed since it was registered; run "scan"`);
  return path;
}

/** Refuse a library that is, or is inside, the working tree of an agent-meshes repository: a folder holding `.git`
 *  whose package.json or .claude-plugin/plugin.json is named agent-meshes. Every write to the library checks this. */
export function assertNotMeshesCheckout(directory) {
  const start = resolve(directory);
  const named = path => { try { return JSON.parse(readFileSync(path, 'utf8'))?.name; } catch { return null; } };
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, '.git')) && [join(at, 'package.json'), join(at, '.claude-plugin', 'plugin.json')].some(path => named(path) === 'agent-meshes')) {
      throw new Error(`Refusing to write the Mixamo library at ${start}: it is inside the agent-meshes checkout ${at}. Mixamo files are never kept in an agent-meshes checkout; set AGENT_MESHES_MIXAMO_DIR to a folder outside it, such as a private repository of your own.`);
    }
    if (dirname(at) === at) return;
  }
}

/** The preview renderer used when none is injected: `renderClipPreview` from src/animation-preview.ts, loaded only
 *  when a preview is first needed, with one preview session for the batch when the module offers one. */
function defaultRenderer() {
  let ready = null;
  const load = async () => {
    const module = await import('../src/animation-preview.ts');
    const session = typeof module.createPreviewSession === 'function' ? await module.createPreviewSession() : null;
    return { module, session };
  };
  return {
    render: async path => { ready ??= load(); const { module, session } = await ready; return module.renderClipPreview(path, session ? { session } : {}); },
    close: async () => { if (!ready) return; try { const { session } = await ready; await session?.close?.(); } catch { /* the render already reported it */ } },
  };
}

const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
/** The inputs behind one source: an FBX, the FBX members of a zip, or every FBX under a folder. */
async function expand(source) {
  let info;
  try { info = await stat(source); } catch (error) { if (error.code === 'ENOENT') return { error: 'no such file or folder' }; throw error; }
  const kind = extname(source).toLowerCase();
  if (info.isDirectory()) return { files: (await fbxFiles(source)).map(({ file }) => ({ source: join(source, file), name: basename(file), read: () => readFile(join(source, file)) })) };
  if (kind === '.fbx') return { files: [{ source, name: basename(source), read: () => readFile(source) }] };
  if (kind === '.zip') {
    let members;
    try { members = unzipFbx(await readFile(source)); } catch (error) { return { error: error.message }; }
    return { files: members.map(member => ({ source: join(source, member.name), name: basename(member.name.replace(/\\/g, '/')), read: async () => member.bytes })) };
  }
  return { error: 'expected an .fbx file, a .zip archive or a folder' };
}

/** Import downloads (FBX files, zip archives, folders) into the library layout. Each FBX is rejected (with the reason),
 *  reported as a duplicate of the entry with the same bytes, or copied in with a preview GIF, its motion summary and a
 *  sidecar of suggested tags plus `tags`. `render(fbxPath)` resolves to `{ gif }`; a render error leaves `preview: null`
 *  and the message in the result. Sources are left alone. Resolves to `{ results, registry }`. */
export async function importAssets(sources, { directory, env = process.env, tags = [], render, onProgress } = {}) {
  directory = resolve(directory ?? mixamoDir(env));
  if (!sources?.length) throw new Error('add <file.fbx | pack.zip | folder> ...');
  assertNotMeshesCheckout(directory);
  await mkdir(directory, { recursive: true });
  let registry = await mixamoRegistry(directory, env);
  const bySha = new Map(registry.entries.map(entry => [entry.sha256, entry.id])), ids = new Set(registry.entries.map(entry => entry.id));
  const taken = id => ids.has(id) || ['clips', 'characters'].some(folder => ['fbx', 'json', 'gif'].some(ext => existsSync(join(directory, 'mixamo', folder, `${id}.${ext}`))));
  const extra = normalizeTags(tags), results = [];
  const fallback = render ? null : defaultRenderer(), renderer = render ?? fallback.render;
  const report = result => { results.push(result); onProgress?.(result); };
  const one = async ({ source, name, read }) => {
    const bytes = Buffer.from(await read()), hash = sha256(bytes);
    if (bytes.subarray(0, POINTER.length).toString('latin1') === POINTER) return { source, status: 'rejected', reason: POINTER_REASON };
    let header;
    try { header = describeFbx(bytes); } catch (error) { return { source, status: 'rejected', reason: error.message }; }
    if (!MIXAMO_SKELETON.test(header.skeleton ?? '')) return { source, status: 'rejected', reason: `not on the Mixamo skeleton (bone prefix: ${header.skeleton ?? 'none'})` };
    if (bySha.has(hash)) return { source, status: 'duplicate', id: bySha.get(hash) };
    const kind = assetKind(header), title = basename(name, extname(name));
    let id = slug(name) || 'clip';
    for (let n = 2, stem = id; taken(id); n++) id = `${stem}-${n}`;
    const folder = join(directory, 'mixamo', kind === 'character' ? 'characters' : 'clips'), fbxPath = join(folder, `${id}.fbx`);
    await mkdir(folder, { recursive: true });
    await writeFile(fbxPath, bytes);
    bySha.set(hash, id); ids.add(id);
    let motion = null;
    try { motion = motionSummary(bytes); } catch { /* a header that reads but curves that do not: no summary */ }
    let preview = null, previewError = null;
    try { const { gif } = await renderer(fbxPath); await writeFile(join(folder, `${id}.gif`), gif); preview = `${id}.gif`; }
    catch (error) { previewError = error?.message ?? String(error); }
    await writeJson(join(folder, `${id}.json`), {
      schema: ASSET_SCHEMA, id, kind, title, sourceName: name, sha256: hash, importedAt: new Date().toISOString(),
      tags: normalizeTags([...suggestTags(title, kind, motion), ...extra]), note: '', motion, preview,
    });
    return { source, status: 'imported', id, kind, ...(previewError ? { previewError } : {}) };
  };
  try {
    for (const source of sources.map(path => resolve(path))) {
      const { files, error } = await expand(source);
      if (error) { report({ source, status: 'rejected', reason: error }); continue; }
      for (const file of files) report(await one(file));
    }
  } finally { await fallback?.close(); }
  if (results.some(result => result.status === 'imported')) { await scanMixamo(directory, env, { reuse: registry }); registry = await readRegistry(env); }
  return { results, registry };
}

/** Change the sidecars of these entries and refresh the registry. An FBX added by hand gets its first sidecar here. */
async function editSidecars(ids, { directory, env = process.env } = {}, change) {
  directory = resolve(directory ?? mixamoDir(env));
  assertNotMeshesCheckout(directory);
  const registry = await mixamoRegistry(directory, env);
  const entries = [...new Set(ids)].map(id => registry.entries.find(item => item.id === id) ?? (() => { throw new Error(`Unknown Mixamo entry: ${id} (see "list")`); })());
  for (const entry of entries) {
    const path = join(directory, sidecarOf(entry.file));
    let meta = await readSidecar(path);
    if (!meta) {
      let motion = null;
      try { motion = motionSummary(await readFile(join(directory, entry.file))); } catch { /* no summary */ }
      meta = { schema: ASSET_SCHEMA, id: entry.id, kind: entry.kind, title: entry.title, sourceName: basename(entry.file), sha256: entry.sha256, importedAt: new Date().toISOString(), tags: entry.tags ?? [], note: entry.note ?? '', motion, preview: entry.preview ?? null };
    }
    const next = await change(meta, entry, path);
    if (next) await writeJson(path, { ...next, tags: normalizeTags(next.tags) });
  }
  await scanMixamo(directory, env, { reuse: registry });
  const fresh = await readRegistry(env);
  return { entries: entries.map(entry => fresh.entries.find(item => item.id === entry.id)).filter(Boolean), registry: fresh };
}

/** Add and remove tags on several entries. */
export function setTags(ids, add = [], remove = [], options = {}) {
  const drop = new Set(normalizeTags(remove));
  return editSidecars(ids, options, meta => ({ ...meta, tags: normalizeTags([...(meta.tags ?? []), ...add]).filter(tag => !drop.has(tag)) }));
}
/** Give an entry a new title; its id never changes. */
export function setTitle(id, title, options = {}) {
  const text = String(title ?? '').trim();
  if (!text) return Promise.reject(new Error('a title cannot be empty'));
  return editSidecars([id], options, meta => ({ ...meta, title: text }));
}
/** Set an entry's note ('' clears it). */
export function setNote(id, note, options = {}) {
  return editSidecars([id], options, meta => ({ ...meta, note: String(note ?? '') }));
}
/** Delete entries from the library: the FBX, its preview GIF and its sidecar. */
export async function removeAssets(ids, options = {}) {
  const removed = [];
  const { registry } = await editSidecars(ids, options, async (meta, entry, path) => {
    const folder = dirname(path), fbx = join(dirname(path), basename(entry.file));
    for (const file of new Set([fbx, path, join(folder, `${basename(entry.file, extname(entry.file))}.gif`), ...(meta.preview ? [join(folder, basename(meta.preview))] : [])])) await rm(file, { force: true });
    removed.push(entry.id);
    return null;
  });
  return { removed, registry };
}

/** Copy downloads into the library through `importAssets`, then report as the registry scan did. */
export async function addMixamo(sources, directory, env = process.env, options = {}) {
  const { results, registry } = await importAssets(sources, { directory, env, ...options });
  const copied = results.filter(result => result.status === 'imported').map(result => registry.entries.find(entry => entry.id === result.id)?.file).filter(Boolean);
  return { copied, directory: registry.directory, registry: registryFile(env), entries: registry.entries.length, skipped: registry.skipped.map(({ file, reason }) => ({ file, reason })), results };
}

async function main() {
  const [command = 'list', ...args] = process.argv.slice(2), json = args.includes('--json'), rest = [];
  let tags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--tags') { tags = String(args[++i] ?? '').split(',').filter(Boolean); continue; }
    rest.push(args[i]);
  }
  if (command === 'dir') console.log(mixamoDir());
  else if (command === 'registry') console.log(registryFile());
  else if (command === 'refresh') {
    const registry = await mixamoRegistry();
    console.log(JSON.stringify({ directory: registry.directory, registry: registryFile(), entries: registry.entries.length, skipped: registry.skipped.length }, null, 2));
  }
  else if (command === 'scan') console.log(JSON.stringify(await scanMixamo(), null, 2));
  else if (command === 'add') {
    const { results, registry } = await importAssets(rest, { tags });
    console.log(JSON.stringify({ directory: registry.directory, registry: registryFile(), entries: registry.entries.length, results }, null, 2));
  }
  else if (command === 'path') console.log(await mixamoPath(rest[0] ?? ''));
  else if (command === 'list') {
    const registry = await mixamoRegistry();
    if (json) console.log(JSON.stringify(registry, null, 2));
    else for (const entry of registry.entries) console.log([entry.id, entry.kind, entry.motion?.summary ?? (entry.clips.map(clip => `${clip.seconds ?? '?'}s`).join(',') || 'no clip'), entry.tags.join(',') || '-', entry.file].join('\t'));
  } else throw new Error('Usage: node scripts/mixamo-library.mjs dir | registry | refresh | add <file.fbx | pack.zip | folder> ... [--tags a,b] | scan | list [--json] | path <id>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
