import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AuthorOptions } from './author.ts';
import type { BlenderLocation } from './refine.ts';

export const nativeCacheFiles = ['.agent-meshes-blender-cache.json', '.agent-meshes-blender-cache.bin'] as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byteDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(':');
const portable = (name: string) => name.split(sep).join('/');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  schema: z.literal('agent-meshes/native-blender-cache@1'), key: sha,
  outputSha256: sha, blender: z.string().min(1), meshes: z.number().int().positive(),
}).strict();
type Record = z.infer<typeof recordSchema>;
interface Snapshot { path: string; metadata: string; sha256?: string }

async function batches<T, U>(items: T[], action: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = [];
  for (let start = 0; start < items.length; start += 8) result.push(...await Promise.all(items.slice(start, start + 8).map(action)));
  return result;
}
async function hashFile(path: string): Promise<Snapshot> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error(`Unsupported linked/non-file runtime input: ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (metadata(before) !== metadata(after)) throw new Error(`Runtime input changed while hashing: ${path}`);
  return { path, metadata: metadata(after), sha256: hash.digest('hex') };
}
async function tree(root: string): Promise<Snapshot[]> {
  const result: Snapshot[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) throw new Error('Linked Blender runtime is not eligible for reuse');
    if (!info.isDirectory()) { result.push({ path, metadata: metadata(info) }); return; }
    result.push({ path, metadata: metadata(info) });
    for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return result;
}
async function runtimeRoot(command: string): Promise<string | undefined> {
  const parent = dirname(command);
  const root = /[\\/]Contents[\\/]MacOS$/.test(parent) ? dirname(parent) : parent;
  // A distro executable directory is not its complete runtime. Only recognize
  // the co-located archive layout (or its macOS application-bundle equivalent).
  for (const resources of [root, join(root, 'Resources')]) {
    const names = await readdir(resources).catch(() => [] as string[]);
    for (const version of names.filter(name => /^\d+\.\d+$/.test(name))) {
      const directories = await Promise.all(['scripts', 'datafiles', 'python'].map(async name => {
        const info = await lstat(join(resources, version, name)).catch(() => undefined);
        return info?.isDirectory() && !info.isSymbolicLink();
      }));
      if (directories.every(Boolean)) return root;
    }
  }
}

export interface NativeCache {
  launch: AuthorOptions;
  read: (output: string) => Promise<{ bytes: Buffer; blender: string; meshes: number } | undefined>;
  write: (stage: string, bytes: Uint8Array, result: { blender: string; meshes: number }) => Promise<void>;
  assertUnchanged: () => Promise<void>;
}
interface NativeIdentity { script: string; configFile: string; inputs: { path: string; sha256: string }[]; config: unknown; helpers: unknown }

/** Opt-in owner-declared dependency contract; never inferred from an old receipt. */
export async function prepareNativeCache(location: BlenderLocation | null, identity: NativeIdentity, output: string, stage: string): Promise<{ cache?: NativeCache; reason: string }> {
  const environment = { ...process.env };
  if (Object.keys(environment).some(name => environment[name] && (/^BLENDER_/i.test(name) || /^(PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|PYTHONPYCACHEPREFIX|AGENT_MESHES_DEV_LIB)$/i.test(name)))) return { reason: 'external-runtime-override' };
  const helperRoot = fileURLToPath(new URL('../scripts/blender_lib/', import.meta.url));
  let helperFiles: Snapshot[];
  try { helperFiles = await tree(helperRoot); }
  catch { return { reason: 'unsupported-shared-python-runtime' }; }
  if (helperFiles.some(file => file.path.endsWith('.pyc') && !relative(helperRoot, file.path).split(sep).includes('__pycache__'))) return { reason: 'bytecode-only-helper' };
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const declared = new Set(identity.inputs.map(file => pathKey(resolve(dirname(identity.configFile), file.path))));
  for (const entry of await readdir(dirname(identity.script), { withFileTypes: true })) {
    if (!/^agent_meshes_/.test(entry.name) || (!entry.isDirectory() && !/\.(py|pyc)$/.test(entry.name))) continue;
    const path = join(dirname(identity.script), entry.name, ...(entry.isDirectory() ? ['__init__.py'] : []));
    if (!declared.has(pathKey(path))) return { reason: 'undeclared-local-helper-override' };
  }
  if (!location || location.detached) return { reason: 'unsupported-blender-launcher' };
  const command = await realpath(location.command).catch(() => undefined);
  if (!command) return { reason: 'unreadable-blender-runtime' };
  const root = await runtimeRoot(command);
  if (!root) return { reason: 'unsupported-blender-layout' };
  const overlap = relative(root, output);
  const reverse = relative(output, root);
  const contained = (path: string) => !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
  if (contained(overlap) || contained(reverse)) throw new Error('Build output cannot overlap the Blender installation');
  let snapshots: Snapshot[];
  try {
    const listing = await tree(root);
    const hashed = await batches(listing, async item => {
      const info = await lstat(item.path);
      return info.isDirectory() ? item : hashFile(item.path);
    });
    snapshots = hashed;
  } catch (error) {
    if (/changed while hashing/.test(String(error))) throw error;
    return { reason: 'unsupported-blender-runtime-files' };
  }
  const implementation = await Promise.all(['build.ts', 'author.ts', 'build-native-cache.ts'].map(name => hashFile(fileURLToPath(new URL(name, import.meta.url)))));
  const cwd = process.cwd();
  const key = digest({
    policy: 'declared-inputs-complete/factory-startup/fresh-python-source@2', identity, cwd, helperRoot,
    environment: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
    node: process.version, platform: process.platform, arch: process.arch,
    command, runtime: snapshots.map(item => ({ path: portable(relative(root, item.path)), sha256: item.sha256 ?? 'directory' })),
    implementation: implementation.map(item => item.sha256),
  });
  async function plainBytes(path: string): Promise<Buffer> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Native cache must use regular files without links');
    const bytes = await readFile(path);
    if (metadata(before) !== metadata(await lstat(path, { bigint: true }))) throw new Error('Native cache changed while reading');
    return bytes;
  }
  const cache: NativeCache = {
    launch: { blender: { ...location, command }, env: environment, cwd, factoryStartup: true, pythonCachePrefix: join(stage, '.agent-meshes-python-imports') },
    read: async directory => {
      let record: Record;
      try {
        const parsed = recordSchema.safeParse(JSON.parse((await plainBytes(join(directory, nativeCacheFiles[0]))).toString('utf8')));
        if (!parsed.success || parsed.data.key !== key) return;
        record = parsed.data;
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      let bytes: Buffer;
      try { bytes = await plainBytes(join(directory, nativeCacheFiles[1])); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (byteDigest(bytes) !== record.outputSha256) return;
      return { bytes, blender: record.blender, meshes: record.meshes };
    },
    write: async (stage, bytes, result) => {
      const record: Record = { schema: 'agent-meshes/native-blender-cache@1', key, outputSha256: byteDigest(bytes), blender: result.blender, meshes: result.meshes };
      // Exclusive creation in the private stage cannot follow a decorator's link
      // or overwrite a file it created. The output transaction publishes both.
      await writeFile(join(stage, nativeCacheFiles[1]), bytes, { flag: 'wx' });
      await writeFile(join(stage, nativeCacheFiles[0]), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    },
    assertUnchanged: async () => {
      const current = await tree(root);
      if (current.length !== snapshots.length || current.some((item, index) => item.path !== snapshots[index].path || item.metadata !== snapshots[index].metadata)) throw new Error('Blender runtime changed during build');
      const shared = await tree(helperRoot);
      if (shared.length !== helperFiles.length || shared.some((item, index) => item.path !== helperFiles[index].path || item.metadata !== helperFiles[index].metadata)) throw new Error('Shared Python runtime changed during build');
      for (const expected of implementation) if (metadata(await lstat(expected.path, { bigint: true })) !== expected.metadata) throw new Error('Native build implementation changed during build');
    },
  };
  return { cache, reason: 'no-matching-native-cache' };
}
