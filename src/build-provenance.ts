import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DeclaredFileInput { path: string; sha256?: string }
export interface DeclaredTreeInput { dir: string; include?: string[]; exclude?: string[]; maxFiles?: number; sha256?: string }
export type DeclaredBuildInput = DeclaredFileInput | DeclaredTreeInput;
export interface BuildToolchainLock { agentMeshesVersion: string; helpersSha256: string; blenderVersion?: string }
export interface FileIdentity { path: string; sha256: string }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const portable = (path: string) => path.split(sep).join('/');
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const metadata = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(':');
const inside = (directory: string, path: string) => {
  const rel = relative(directory, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const publicIdentity = ({ path, sha256 }: FileIdentity): FileIdentity => ({ path, sha256 });
interface Snapshot extends FileIdentity { absolute: string; metadata: string; allowHardlinks: boolean }

/** Strict, portable *file* names only. Entry scripts retain their legacy relative/absolute syntax. */
function checkDeclaredPath(path: string): void {
  if (!path || isAbsolute(path) || /[\\:*?\[\]{}\x00-\x1f]/.test(path) || path.split('/').some(piece => !piece || piece === '.' || piece === '..' || /[. ]$/.test(piece))) {
    throw new Error(`Unsafe declared build input path (use an explicit relative file): ${path}`);
  }
}

/** Reject links in every path component, including directory junctions and hard-linked files. */
async function plainPath(absolute: string): Promise<BigIntStats> {
  let stat: BigIntStats;
  try { stat = await lstat(absolute, { bigint: true }); }
  catch (error) { throw new Error(`Missing or unreadable build input: ${absolute}`, { cause: error }); }
  if (stat.isSymbolicLink()) throw new Error(`Link in build input: ${absolute}`);
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Link or non-directory in build input path: ${parent}`);
    if (dirname(parent) === parent) break;
  }
  // Detect platform aliases (for example Windows short names) as well as links.
  if (pathKey(await realpath(absolute)) !== pathKey(absolute)) throw new Error(`Alias in build input path: ${absolute}`);
  return stat;
}

async function snapshotFile(absolute: string, path: string, allowHardlinks = false): Promise<Snapshot> {
  const before = await plainPath(absolute);
  if (!before.isFile()) throw new Error(`Build input must be a regular file: ${path}`);
  if (!allowHardlinks && before.nlink !== 1n) throw new Error(`Hard link in build input: ${path}`);
  const bytes = await readFile(absolute);
  const after = await plainPath(absolute);
  if (metadata(before) !== metadata(after)) throw new Error(`Build input changed while reading: ${path}`);
  return { path, absolute, sha256: hash(bytes), metadata: metadata(after), allowHardlinks };
}

function protectOutput(output: string, source: string): void {
  if (inside(output, source)) throw new Error(`Build output cannot contain its config or input source: ${source}`);
}

function treePatterns(patterns: string[] | undefined, fallback: string[], name: string): string[] {
  const values = patterns ?? fallback;
  if (!Array.isArray(values) || (name === 'include' && values.length === 0) || values.length > 100) throw new Error(`Invalid input tree ${name} patterns`);
  for (const pattern of values) {
    if (typeof pattern !== 'string' || !pattern || isAbsolute(pattern) || /[\\:\[\]{}!()\x00-\x1f]/.test(pattern)
      || pattern.split('/').some(piece => !piece || piece === '.' || piece === '..' || (piece.includes('**') && piece !== '**'))) throw new Error(`Unsafe input tree ${name} pattern: ${pattern}`);
  }
  return [...new Set(values)].sort();
}

/** Match portable glob paths; membership is captured again before publication. */
async function expandInputTree(base: string, declaration: DeclaredTreeInput, output: string) {
  checkDeclaredPath(declaration.dir);
  // An omitted include watches every regular file, including dotfiles. Explicit
  // patterns use Node's documented glob semantics (dot paths need dot patterns).
  const include = declaration.include === undefined ? null : treePatterns(declaration.include, [], 'include');
  const exclude = treePatterns(declaration.exclude, [], 'exclude');
  const maxFiles = declaration.maxFiles ?? 10000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000) throw new Error('Input tree maxFiles limit must be between 1 and 10000');
  const root = resolve(base, declaration.dir);
  if (inside(root, output) || inside(output, root)) throw new Error('Build output cannot overlap a declared input tree');
  if (!(await plainPath(root)).isDirectory()) throw new Error(`Input tree must be a directory: ${declaration.dir}`);
  const paths: string[] = [];
  let visited = 0;
  async function visit(directory: string): Promise<void> {
    const before = await plainPath(directory);
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++visited > 50000) throw new Error('Input tree traversal exceeds the 50000-entry budget');
      if (child.isSymbolicLink()) throw new Error(`Link in declared input tree: ${child.name}`);
      if (child.name === '__pycache__' || /\.py[co]$/i.test(child.name)) continue;
      const absolute = join(directory, child.name);
      if (child.isDirectory()) await visit(absolute);
      else if (child.isFile()) {
        const path = portable(relative(root, absolute));
        if ((include === null || include.some(pattern => posix.matchesGlob(path, pattern))) && !exclude.some(pattern => posix.matchesGlob(path, pattern))) {
          const name = portable(relative(base, absolute));
          checkDeclaredPath(name);
          paths.push(name);
          if (paths.length > maxFiles) throw new Error(`Input tree file limit exceeded: ${declaration.dir} (maximum ${maxFiles})`);
        }
      } else throw new Error(`Non-file in declared input tree: ${child.name}`);
    }
    if (metadata(before) !== metadata(await plainPath(directory))) throw new Error(`Input tree changed while listing: ${declaration.dir}`);
  }
  await visit(root);
  return { dir: declaration.dir, include, exclude, maxFiles, paths: paths.sort() };
}
async function assertSnapshots(snapshots: Snapshot[]): Promise<void> {
  for (const expected of snapshots) {
    try {
      const actual = await snapshotFile(expected.absolute, expected.path, expected.allowHardlinks);
      if (actual.sha256 !== expected.sha256 || actual.metadata !== expected.metadata) throw new Error('bytes or file identity differ');
    } catch (error) { throw new Error(`Build input changed or missing during build: ${expected.path}`, { cause: error }); }
  }
}

/** Entry + explicitly declared inputs only: this does not discover Python imports or dependency closure. */
export async function captureBuildInputs(configFile: string, script: string, declared: DeclaredBuildInput[], output: string) {
  const base = dirname(resolve(configFile));
  // buildAsset supplies canonical legacy config/entry paths. Their historical
  // hard-link support remains; newly declared inputs use strict file identity.
  const config = await snapshotFile(resolve(configFile), portable(relative(base, configFile)), true);
  const entry = resolve(base, script);
  const declarations = new Map<string, DeclaredFileInput>();
  const expandedTrees: { declaration: DeclaredTreeInput; expanded: Awaited<ReturnType<typeof expandInputTree>> }[] = [];
  function addDeclaration(file: DeclaredFileInput): void {
    checkDeclaredPath(file.path);
    const key = pathKey(resolve(base, file.path));
    if (declarations.has(key)) throw new Error(`Duplicate declared build input: ${file.path}`);
    if (file.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`Invalid SHA-256 pin for build input: ${file.path}`);
    declarations.set(key, file);
  }
  for (const declaration of declared) {
    if ('dir' in declaration) {
      if (declaration.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(declaration.sha256)) throw new Error(`Invalid input tree SHA-256 pin: ${declaration.dir}`);
      const expanded = await expandInputTree(base, declaration, output);
      if (expandedTrees.some(tree => pathKey(resolve(base, tree.declaration.dir)) === pathKey(resolve(base, declaration.dir)))) throw new Error(`Duplicate declared input tree: ${declaration.dir}`);
      expandedTrees.push({ declaration, expanded });
      for (const path of expanded.paths) addDeclaration({ path });
    } else addDeclaration(declaration);
  }
  const paths = new Map([[pathKey(entry), entry]]);
  for (const file of declarations.values()) {
    const absolute = resolve(base, file.path);
    if (!paths.has(pathKey(absolute))) paths.set(pathKey(absolute), absolute);
  }
  const snapshots: Snapshot[] = [];
  for (const absolute of paths.values()) {
    const declaration = declarations.get(pathKey(absolute));
    const snapshot = await snapshotFile(absolute, portable(relative(base, absolute)), declaration === undefined);
    if (declaration?.sha256 !== undefined && declaration.sha256 !== snapshot.sha256) throw new Error(`SHA-256 pin mismatch for build input: ${snapshot.path}`);
    snapshots.push(snapshot);
  }
  snapshots.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const byPath = new Map(snapshots.map(file => [pathKey(file.absolute), file]));
  const trees = expandedTrees.map(({ declaration, expanded }) => {
    const records = expanded.paths.map(path => publicIdentity(byPath.get(pathKey(resolve(base, path)))!));
    const sha256 = hash(Buffer.from(JSON.stringify(records)));
    if (declaration.sha256 !== undefined && declaration.sha256 !== sha256) throw new Error(`Input tree SHA-256 pin mismatch: ${declaration.dir}`);
    return { ...expanded, sha256 };
  });
  for (const file of [config, ...snapshots]) protectOutput(output, file.absolute);
  return {
    files: snapshots.map(publicIdentity), config: publicIdentity(config),
    trees, treePins: expandedTrees.filter(tree => tree.declaration.sha256 !== undefined).map(tree => tree.declaration.dir),
    entry: publicIdentity(snapshots.find(file => pathKey(file.absolute) === pathKey(entry))!),
    pins: snapshots.filter(file => declarations.get(pathKey(file.absolute))?.sha256 !== undefined).map(file => file.path),
    assertUnchanged: async () => {
      for (const { declaration, expanded } of expandedTrees) {
        const current = await expandInputTree(base, declaration, output);
        if (JSON.stringify(current) !== JSON.stringify(expanded)) throw new Error(`Input tree changed during build: ${declaration.dir}`);
      }
      await assertSnapshots([config, ...snapshots]);
    },
  };
}

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
async function toolchainSnapshot(root: string) {
  root = resolve(root);
  const pkg = await snapshotFile(join(root, 'package.json'), 'package.json');
  const installed = JSON.parse(await readFile(pkg.absolute, 'utf8')) as { name?: unknown; version?: unknown };
  if (installed.name !== 'agent-meshes' || typeof installed.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(installed.version)) throw new Error('Invalid installed agent-meshes package/version');
  const paths = ['scripts/blender-author.py'];
  async function visit(name: string): Promise<void> {
    const stat = await plainPath(join(root, name));
    if (!stat.isDirectory()) throw new Error(`Helper tree must be a directory: ${name}`);
    for (const child of (await readdir(join(root, name), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = `${name}/${child.name}`;
      if (child.isSymbolicLink()) throw new Error(`Link in build helper tree: ${path}`);
      if (child.name === '__pycache__' || child.name.endsWith('.pyc')) continue;
      if (child.isDirectory()) await visit(path);
      else if (child.isFile()) paths.push(path);
      else throw new Error(`Non-file in build helper tree: ${path}`);
    }
  }
  await visit('scripts/blender_lib');
  const snapshots = await Promise.all(paths.sort().map(path => snapshotFile(join(root, path), path)));
  const files = snapshots.map(publicIdentity);
  // v1 helpersSha256 = SHA-256(UTF-8 JSON of sorted [{path, sha256}]).
  // Each inner digest hashes raw bytes, including data. No CRLF normalization or cache paths.
  const identity = { agentMeshesVersion: installed.version, helpersSha256: hash(Buffer.from(JSON.stringify(files))) };
  await assertSnapshots([pkg]);
  return { identity, files, snapshots: [pkg, ...snapshots] };
}

/** The managed-runtime identity includes bytecode and normalizes text. This narrower identity is byte-exact. */
export async function captureBuildToolchain(root = runtimeRoot, output?: string) {
  const captured = await toolchainSnapshot(root);
  if (output) {
    for (const file of captured.snapshots) protectOutput(output, file.absolute);
    if (inside(join(resolve(root), 'scripts', 'blender_lib'), output)) throw new Error('Build output cannot overlap the installed helper tree');
  }
  return {
    identity: captured.identity, files: captured.files,
    assertUnchanged: async () => {
      try {
        const actual = await toolchainSnapshot(root);
        if (JSON.stringify(actual.identity) !== JSON.stringify(captured.identity) || actual.snapshots.length !== captured.snapshots.length || actual.snapshots.some((file, index) => file.path !== captured.snapshots[index].path || file.sha256 !== captured.snapshots[index].sha256 || file.metadata !== captured.snapshots[index].metadata)) {
          throw new Error('helper files or installed package changed');
        }
      } catch (error) { throw new Error('Build toolchain changed or missing during build', { cause: error }); }
    },
  };
}

/** Blender's identity comes from the actual author completion report, never its executable path. */
export function checkToolchainPin(pin: BuildToolchainLock | undefined, actual: { agentMeshesVersion: string; helpersSha256: string; blenderVersion?: string }): void {
  if (!pin) return;
  for (const key of ['agentMeshesVersion', 'helpersSha256', 'blenderVersion'] as const) {
    if (pin[key] !== undefined && pin[key] !== actual[key]) throw new Error(`Build toolchain pin mismatch for ${key}: expected ${pin[key]}, got ${actual[key] ?? '(not reported)'}`);
  }
}
