import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AuthorOptions } from './author.ts';
import type { BlenderLocation } from './refine.ts';
import { readAuditSchema, type ReadAudit } from './build-read-audit.ts';
import type { NativeBuildSession } from './build-session.ts';
import { prepareBuildEnvironment } from './build-environment.ts';

export const nativeCacheFiles = ['.agent-meshes-blender-cache.json', '.agent-meshes-blender-cache.bin'] as const;
export const nativeCacheLimits = { entries: 4, bytes: 256 * 1024 * 1024 } as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byteDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(':');
const portable = (name: string) => name.split(sep).join('/');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const componentsSchema = z.object({ inputs: sha, tools: sha, runtime: sha, environment: sha, cwd: sha, location: sha, platform: sha, policy: sha }).strict();
type Components = z.infer<typeof componentsSchema>;
export interface NativeCacheLookup { value?: { bytes: Buffer; blender: string; meshes: number; readAudit: ReadAudit }; reason: string; changedComponents?: (keyof Components)[] }
const entrySchema = z.object({
  key: sha, components: componentsSchema,
  outputSha256: sha, blender: z.string().min(1), meshes: z.number().int().positive(),
  readAudit: readAuditSchema.refine(report => report.status === 'clean' && report.installed && !report.truncated && report.unresolvedEvents === 0 && report.undeclaredReads.length === 0),
}).strict();
const recordSchema = entrySchema.extend({ schema: z.literal('agent-meshes/native-blender-cache@3'), history: z.array(z.unknown()).max(nativeCacheLimits.entries - 1) }).strict();
type Entry = z.infer<typeof entrySchema>;
type Record = Entry & { schema: 'agent-meshes/native-blender-cache@3'; history: Entry[] };
const historyFile = (key: string) => `.agent-meshes-blender-${key}.bin`;
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
  read: (output: string) => Promise<NativeCacheLookup>;
  write: (stage: string, bytes: Uint8Array, result: { blender: string; meshes: number; readAudit: ReadAudit }) => Promise<string[]>;
  assertUnchanged: () => Promise<void>;
}
interface NativeIdentity { script: string; configFile: string; inputRoot?: string; inputs: { path: string; sha256: string }[]; config: unknown; configurations?: { path: string; sha256: string }[]; helpers: unknown }

/** Opt-in owner-declared dependency contract; never inferred from an old receipt. */
export async function prepareNativeCache(location: BlenderLocation | null, identity: NativeIdentity, output: string, stage: string, session?: NativeBuildSession, launchEnvironment = prepareBuildEnvironment()): Promise<{ cache?: NativeCache; reason: string }> {
  if (process.permission) return { reason: 'unsupported-node-permission-mode' };
  const environment = launchEnvironment.env;
  if (Object.keys(environment).some(name => environment[name] && (/^BLENDER_/i.test(name) || /^(PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|PYTHONPYCACHEPREFIX|AGENT_MESHES_DEV_LIB)$/i.test(name)))) return { reason: 'external-runtime-override' };
  const helperRoot = fileURLToPath(new URL('../scripts/blender_lib/', import.meta.url));
  let helperFiles: Snapshot[];
  try { helperFiles = await tree(helperRoot); }
  catch { return { reason: 'unsupported-shared-python-runtime' }; }
  if (helperFiles.some(file => file.path.endsWith('.pyc') && !relative(helperRoot, file.path).split(sep).includes('__pycache__'))) return { reason: 'bytecode-only-helper' };
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const declared = new Set(identity.inputs.map(file => pathKey(resolve(identity.inputRoot ?? dirname(identity.configFile), file.path))));
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
  const captureRuntime = async () => {
    const listing = await tree(root);
    return batches(listing, async item => {
      const info = await lstat(item.path);
      return info.isDirectory() ? item : hashFile(item.path);
    });
  };
  const validateRuntime = async (expected: Snapshot[]) => {
    const current = await tree(root);
    if (current.length !== expected.length || current.some((item, index) => item.path !== expected[index].path || item.metadata !== expected[index].metadata)) throw new Error('Blender runtime changed during build');
  };
  try {
    snapshots = session ? await session.get('blenderRuntime', command, captureRuntime, validateRuntime) : await captureRuntime();
  } catch (error) {
    if (/changed while hashing|runtime changed|BUILD_SESSION_/.test(String(error))) throw error;
    return { reason: 'unsupported-blender-runtime-files' };
  }
  const captureImplementation = () => Promise.all(['build.ts', 'author.ts', 'build-provenance.ts', 'build-read-audit.ts', 'build-native-cache.ts', 'build-session.ts', 'build-batch.ts', 'build-config.ts', 'build-environment.ts'].map(name => hashFile(fileURLToPath(new URL(name, import.meta.url)))));
  const validateImplementation = async (expected: Snapshot[]) => {
    for (const file of expected) if (metadata(await lstat(file.path, { bigint: true })) !== file.metadata) throw new Error('Native build implementation changed during build');
  };
  const implementation = session ? await session.get('nativeImplementation', fileURLToPath(new URL('./', import.meta.url)), captureImplementation, validateImplementation) : await captureImplementation();
  const cwd = process.cwd();
  // Exact digests are authoritative; component names only explain misses.
  const components: Components = {
    inputs: digest({ config: identity.config, ...(identity.configurations ? { configurations: identity.configurations } : {}), inputs: identity.inputs }),
    tools: digest({ helpers: identity.helpers, implementation: implementation.map(item => item.sha256) }),
    runtime: digest(snapshots.map(item => ({ path: portable(relative(root, item.path)), sha256: item.sha256 ?? 'directory' }))),
    environment: digest({ contract: launchEnvironment.contract, values: Object.entries(environment).filter(([,value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }),
    cwd: digest(cwd), location: digest({ script: identity.script, configFile: identity.configFile, ...(identity.inputRoot ? { inputRoot: identity.inputRoot } : {}), helperRoot, command, root }),
    platform: digest({ node: process.version, platform: process.platform, arch: process.arch }),
    policy: digest('declared-inputs-complete/factory-startup/fresh-python-source/declared-env/root-scope/component-key/history@5'),
  };
  const key = digest(components);
  async function plainBytes(path: string): Promise<Buffer> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Native cache must use regular files without links');
    const bytes = await readFile(path);
    if (metadata(before) !== metadata(await lstat(path, { bigint: true }))) throw new Error('Native cache changed while reading');
    return bytes;
  }
  const isValidEntry = (entry: Entry) => entry.key === digest(entry.components);
  async function previousRecord(directory: string): Promise<{ record?: Record; reason?: string }> {
    try {
      const raw = JSON.parse((await plainBytes(join(directory, nativeCacheFiles[0]))).toString('utf8'));
      if (raw && typeof raw === 'object' && /^agent-meshes\/native-blender-cache@[12]$/.test(raw.schema)) return { reason: 'legacy-cache-record' };
      const parsed = recordSchema.safeParse(raw);
      if (!parsed.success || !isValidEntry(parsed.data)) return { reason: 'cache-record-invalid' };
      const history: Entry[] = [], seen = new Set([parsed.data.key]);
      for (const candidate of parsed.data.history) {
        const entry = entrySchema.safeParse(candidate);
        // One broken old slot must not invalidate the current clean result.
        if (entry.success && isValidEntry(entry.data) && !seen.has(entry.data.key)) { history.push(entry.data); seen.add(entry.data.key); }
      }
      return { record: { ...parsed.data, history } };
    } catch (error) {
      if (error instanceof SyntaxError) return { reason: 'cache-record-invalid' };
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'cache-record-missing' };
      throw error;
    }
  }
  async function entryBytes(directory: string, entry: Entry, primary: boolean): Promise<{ bytes?: Buffer; reason?: string }> {
    try {
      const path = join(directory, primary ? nativeCacheFiles[1] : historyFile(entry.key));
      // Bound a malicious/oversize file before allocating or hashing its bytes.
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error('Native cache must use regular files without links');
      if (info.size > BigInt(nativeCacheLimits.bytes)) return { reason: 'cache-output-too-large' };
      const bytes = await plainBytes(path);
      return byteDigest(bytes) === entry.outputSha256 ? { bytes } : { reason: 'cache-output-corrupt' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'cache-output-missing' }; throw error; }
  }
  const cache: NativeCache = {
    launch: { blender: { ...location, command }, env: environment, cwd, factoryStartup: true, pythonCachePrefix: join(stage, '.agent-meshes-python-imports') },
    read: async directory => {
      const prior = await previousRecord(directory);
      if (!prior.record) return { reason: prior.reason! };
      const record = prior.record;
      const entry = record.key === key ? record : record.history.find(item => item.key === key);
      if (!entry) return { reason: 'cache-key-changed', changedComponents: (Object.keys(components) as (keyof Components)[]).filter(name => components[name] !== record.components[name]) };
      const value = await entryBytes(directory, entry, entry === record);
      if (!value.bytes) return { reason: value.reason! };
      return { reason: 'matching-native-cache', value: { bytes: value.bytes, blender: entry.blender, meshes: entry.meshes, readAudit: entry.readAudit } };
    },
    write: async (stage, bytes, result) => {
      if (bytes.byteLength > nativeCacheLimits.bytes) return [];
      const entry: Entry = { key, components, outputSha256: byteDigest(bytes), blender: result.blender, meshes: result.meshes, readAudit: result.readAudit };
      const retained: Entry[] = [], files: string[] = [...nativeCacheFiles];
      let totalBytes = bytes.byteLength;
      const previous = (await previousRecord(output)).record;
      if (previous) {
        const { schema: _schema, history: _history, ...primary } = previous;
        for (const candidate of [primary, ...previous.history]) {
          if (candidate.key === key || retained.length >= nativeCacheLimits.entries - 1) continue;
          const cached = await entryBytes(output, candidate, candidate === primary);
          if (!cached.bytes || totalBytes + cached.bytes.length > nativeCacheLimits.bytes) continue;
          const name = historyFile(candidate.key);
          await writeFile(join(stage, name), cached.bytes, { flag: 'wx' });
          retained.push(candidate); files.push(name); totalBytes += cached.bytes.length;
        }
      }
      const record: Record = { schema: 'agent-meshes/native-blender-cache@3', ...entry, history: retained };
      // Exclusive creation in the private stage cannot follow a decorator's link
      // or overwrite a file it created. The output transaction publishes both.
      await writeFile(join(stage, nativeCacheFiles[1]), bytes, { flag: 'wx' });
      await writeFile(join(stage, nativeCacheFiles[0]), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      return files;
    },
    assertUnchanged: async () => {
      await validateRuntime(snapshots);
      const shared = await tree(helperRoot);
      if (shared.length !== helperFiles.length || shared.some((item, index) => item.path !== helperFiles[index].path || item.metadata !== helperFiles[index].metadata)) throw new Error('Shared Python runtime changed during build');
      await validateImplementation(implementation);
    },
  };
  return { cache, reason: 'no-matching-native-cache' };
}
