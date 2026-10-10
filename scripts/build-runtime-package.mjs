#!/usr/bin/env node
// Generate the slim `agent-meshes-runtime` package: the files `src/runtime.ts` reaches, a two-dependency
// package.json, the licence and a short README. Nothing is copied by hand and nothing is edited; every file is
// byte-identical to its source, so the package can never drift in behaviour, only lag in time.
//
// Why this exists: npm installs a git dependency's whole `dependencies` list, and npm cannot install a
// subdirectory of a git repository. A game that imports `agent-meshes/src/runtime.ts` would therefore install
// express, playwright, vite, rapier and the rest (about 97 lock entries) to use 18 files that need only `three`
// and `zod`. A game depends on the generated package instead; see docs/runtime-package.md.
//
// Usage:
//   node scripts/build-runtime-package.mjs --out <dir>        write the package into <dir> (created, must be empty or absent)
//   node scripts/build-runtime-package.mjs --check <dir>      exit 1 unless <dir> already equals what would be generated
//   node scripts/build-runtime-package.mjs --publish          commit the package onto the local `runtime` branch (never pushes)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'src/runtime.ts';
export const PACKAGE_NAME = 'agent-meshes-runtime';
export const BRANCH = 'runtime';
/** The three.js window this runtime is tested against: the repository pins 0.186, the first game consumer runs 0.185. */
export const THREE_RANGE = '>=0.185.0 <0.187.0';
const RUNTIME_DEPENDENCIES = new Set(['three', 'zod']);

const posix = path => path.split(sep).join('/');
const SPECIFIERS = [
  /^\s*(?:import|export)\s+[^;]*?from\s+['"]([^'"]+)['"]/gm,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The package name a bare specifier belongs to: `three/examples/x.js` is `three`, `@a/b/c` is `@a/b`. */
export const packageOf = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/**
 * Every file reachable from the entry through relative import/export statements (type-only ones too, so a
 * consumer's typechecker finds every declaration), and the bare specifiers they name, split into those the
 * emitted JavaScript needs at run time and those only the type checker reads.
 */
export function runtimeClosure(entry = ENTRY, base = root) {
  const files = new Set();
  const runtime = new Set();
  const typeOnly = new Set();
  const visit = file => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(join(base, file), 'utf8');
    for (const pattern of SPECIFIERS) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        const isType = /^\s*(?:import|export)\s+type\b/.test(match[0]);
        if (spec.startsWith('.')) visit(posix(relative(base, resolve(base, dirname(file), spec))));
        else (isType ? typeOnly : runtime).add(spec);
      }
    }
  };
  visit(entry);
  return { files: [...files].sort(), runtime: [...runtime].sort(), typeOnly: [...typeOnly].sort() };
}

/** Throws unless the closure needs nothing beyond `three` and `zod` (plus Node built-ins are refused: this runs in a browser). */
export function assertSlim(closure) {
  const stray = [...closure.runtime, ...closure.typeOnly].filter(spec => !RUNTIME_DEPENDENCIES.has(packageOf(spec)));
  if (stray.length) throw new Error(`runtime closure reaches beyond three and zod: ${stray.join(', ')}`);
}

export function packageJson(rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))) {
  return {
    name: PACKAGE_NAME,
    version: rootPackage.version,
    description: 'Browser-safe runtime of agent-meshes: model data in, three.js scene graph out. Generated; do not edit.',
    license: 'MIT',
    type: 'module',
    sideEffects: false,
    repository: { type: 'git', url: 'git+https://github.com/ehartye/agent-meshes.git' },
    // three is a peer so the host's copy is the only copy: scenes cross the boundary as Object3D instances.
    peerDependencies: { three: THREE_RANGE },
    dependencies: { zod: `^${rootPackage.dependencies.zod}` },
    engines: { node: '>=24' },
  };
}

const README = `# agent-meshes-runtime

Generated from [agent-meshes](https://github.com/ehartye/agent-meshes) by \`scripts/build-runtime-package.mjs\`. Do not edit.

The browser-safe entry \`src/runtime.ts\` and the files it reaches, byte-identical to their sources. It needs only
\`three\` (peer) and \`zod\`. TypeScript source is shipped as is; import it with a bundler or runner that accepts
\`.ts\` specifiers:

\`\`\`ts
import { buildScene, instantiate, seedParams, checkSockets } from 'agent-meshes-runtime/src/runtime.ts';
\`\`\`
`;

/** The package as a map of relative path to file contents. */
export function generate(base = root) {
  const closure = runtimeClosure(ENTRY, base);
  assertSlim(closure);
  const out = new Map();
  for (const file of closure.files) out.set(file, readFileSync(join(base, file)));
  out.set('package.json', `${JSON.stringify(packageJson(JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))), null, 2)}\n`);
  out.set('LICENSE', readFileSync(join(base, 'LICENSE')));
  out.set('README.md', README);
  return out;
}

function listFiles(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

const text = value => (typeof value === 'string' ? value : value.toString('utf8')).replaceAll('\r\n', '\n');

/** Differences between a directory and the generated package; empty means equal. Line endings are compared as LF. */
export function diff(dir, generated = generate()) {
  const problems = [];
  const present = new Set(existsSync(dir) ? listFiles(dir) : []);
  for (const [path, content] of generated) {
    if (!present.has(path)) problems.push(`missing ${path}`);
    else if (text(readFileSync(join(dir, path))) !== text(content)) problems.push(`differs ${path}`);
  }
  for (const path of present) if (!generated.has(path)) problems.push(`extra ${path}`);
  return problems;
}

function write(dir, generated) {
  for (const [path, content] of generated) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Commit the package onto the local `runtime` branch (append-only, so every pinned commit stays reachable). Returns the commit or null if unchanged. */
function publish() {
  const generated = generate();
  const source = git(root, 'rev-parse', '--short', 'HEAD');
  const scratch = mkdtempSync(join(tmpdir(), 'am-runtime-'));
  const tree = join(scratch, 'tree');
  try {
    const exists = (() => { try { git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`); return true; } catch { return false; } })();
    if (exists) git(root, 'worktree', 'add', '-q', tree, BRANCH);
    else git(root, 'worktree', 'add', '-q', '--detach', tree);
    if (!exists) { git(tree, 'checkout', '-q', '--orphan', BRANCH); try { git(tree, 'rm', '-rfq', '.'); } catch { /* an orphan checkout can start empty */ } }
    for (const path of listFiles(tree)) rmSync(join(tree, path), { force: true });
    write(tree, generated);
    git(tree, 'add', '-A');
    if (!git(tree, 'status', '--porcelain')) return null;
    git(tree, 'commit', '-q', '-m', `runtime ${packageJson().version} from agent-meshes ${source}`);
    return git(tree, 'rev-parse', 'HEAD');
  } finally {
    try { git(root, 'worktree', 'remove', '--force', tree); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, target] = process.argv.slice(2);
  try {
    if (mode === '--out' && target) {
      const dir = resolve(target);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
      const generated = generate();
      write(dir, generated);
      console.log(`wrote ${generated.size} files to ${dir}`);
    } else if (mode === '--check' && target) {
      const problems = diff(resolve(target));
      if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; } else console.log('runtime package is current');
    } else if (mode === '--publish') {
      const commit = publish();
      console.log(commit ? `committed ${commit} on ${BRANCH}; push with: git push origin ${BRANCH}` : `${BRANCH} is already current`);
    } else throw new Error('Usage: node scripts/build-runtime-package.mjs --out <dir> | --check <dir> | --publish');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
