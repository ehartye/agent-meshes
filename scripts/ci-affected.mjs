// Which vitest files can a diff affect? A static reach graph, conservative by construction:
// every answer is either a list of test files that can reach a changed file, or null, meaning "run them all".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(ts|mts|mjs|js)$/;
const GRAPH_ROOTS = ['src', 'scripts', 'tests', 'recipes'];
const SKIP_DIRECTORIES = new Set(['node_modules', '__pycache__', 'reference-assets']);
// The workbench is reached through its build output, and the viewer scripts through a bundle made at run time
// (bundleWeb in src/preview-html.ts), not through an import.
const WORKBENCH_INPUTS = /^(src\/web\/|index\.html$|vite\.config\.ts$)/;
const WORKBENCH_MARK = /dist-web|\bbundleWeb\b/;
// Blender runs these out of process; a test reaches them through any module that names a Blender script.
const BLENDER_PYTHON = /^(scripts\/[^/]+\.py|scripts\/blender_lib\/.*|recipes\/.*\.py)$/;
const BLENDER_MARK = /scripts\/(blender[-_][\w-]+\.py|blender_lib)/;
// The four files a release bumps. The caller passes them only when nothing but their version strings changed.
// A version string reaches a test that names a version file, or that names a module which does, directly: those are
// the tests that assert a version. Deeper reach (every build stamps the version) proves nothing more about a bump.
export const VERSION_FILES = ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const VERSION_MARK = /package\.json|plugin\.json|marketplace\.json/;

/** Prose and retained evidence: no runtime reads it; the content tests below are what does. */
export const isDocumentation = file => /^(README\.md|AGENTS\.md|CLAUDE\.md|LICENSE|\.github\/README\.md)$/.test(file)
  || /^skills\/.*\.md$/.test(file)
  || /^docs\/.*\.(md|json|txt|png|jpg|jpeg|svg|webp|gif|pdf)$/.test(file);
/** Tests that read the tree as content. They run for every diff. */
export const CONTENT_TESTS = ['tests/build-output-guidance.test.ts', 'tests/mesh-tool-selection-skill.test.ts', 'tests/plugin-content-hygiene.test.ts'];

function walk(root, directory, out) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) walk(root, path, out); }
    else if (CODE.test(entry.name)) out.push(path);
  }
  return out;
}

function resolveImport(root, from, specifier) {
  // A bundler query (`./worker.ts?worker&inline`) is not part of the path.
  const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, '')));
  if (base.startsWith('..')) return null;
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'),
    `${base}/index.ts`, `${base}/index.mjs`, `${base}/index.js`];
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile()) return candidate;
  }
  return null;
}

/**
 * The files and directories one module names: relative imports, and repository paths written as string literals.
 * `unresolved` collects the modules holding a relative import that matches no file: the caller cannot follow those.
 */
function references(root, file, text, unresolved) {
  const found = new Set();
  const add = path => { if (path && existsSync(join(root, path))) found.add(path); };
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolveImport(root, file, match[1]);
    if (target) found.add(target); else unresolved.add(file);
  }
  // resolve('scripts/agent-meshes.mjs'), new URL('../scripts/blender-author.py', import.meta.url), 'tests/fixtures/x.json'
  for (const match of text.matchAll(/['"`]((?:\.\.?\/)*(?:src|scripts|tests|recipes|skills|docs)\/[\w./-]*)['"`]/g)) {
    add(match[1].replace(/^(\.\.?\/)+/, '').replace(/\/$/, ''));
  }
  // A template such as `tests/fixtures/face-rig/${fixture}.py` names its directory.
  for (const match of text.matchAll(/`((?:src|scripts|tests|recipes)\/[\w./-]*)\/[\w.-]*\$\{/g)) add(match[1]);
  return found;
}

/**
 * Test files a diff can affect, or null when the diff or the tree holds anything this graph cannot follow.
 * A test is selected when it changed, when it can reach a changed file through imports or literal repository paths,
 * or when it reaches no source at all. The content tests, which read the whole tree, always run.
 * A source that a browser bundle contains selects every test that can reach a bundle; documentation selects the
 * tests that name it; a version file selects the tests that assert a version.
 */
export function affectedVitestTests(paths, { root = REPO_ROOT } = {}) {
  const files = GRAPH_ROOTS.flatMap(directory => existsSync(join(root, directory)) ? walk(root, directory, []) : []);
  const text = new Map(files.map(file => [file, readFileSync(join(root, file), 'utf8')]));
  const unresolved = new Set();
  const edges = new Map(files.map(file => [file, references(root, file, text.get(file), unresolved)]));
  // Everything reachable from `start`. Naming a directory reaches the modules inside it.
  const closure = start => {
    const seen = new Set(start);
    for (const queue = [...start]; queue.length;) {
      const current = queue.pop();
      const next = edges.has(current) ? edges.get(current) : files.filter(file => file.startsWith(`${current}/`));
      for (const file of next) if (!seen.has(file)) { seen.add(file); queue.push(file); }
    }
    return seen;
  };
  const tests = files.filter(file => /^tests\/[^/]+\.test\.ts$/.test(file)).sort();
  const reach = new Map(tests.map(test => [test, closure([test])]));
  // The sources vite bundles for the browser: the workbench and the viewer scripts start from src/web.
  const bundled = closure(files.filter(file => file.startsWith('src/web/')));
  // An import the graph cannot resolve hides whatever lies behind it: a bundle that holds one is unknown, and a test
  // that can reach one always runs.
  const blind = file => unresolved.has(file);
  if ([...bundled].some(blind)) return null;
  const reaches = (test, predicate) => [...reach.get(test)].some(predicate);
  const marked = (test, mark) => reaches(test, file => mark.test(text.get(file) ?? ''));
  const covers = path => file => path === file || path.startsWith(`${file}/`);
  const names = path => file => (text.get(file) ?? '').includes(path);
  const chosen = new Set(tests.filter(test => CONTENT_TESTS.includes(test) || reaches(test, blind) || !reaches(test, file => file !== test && /^(src|scripts)\//.test(file))));
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('..') || path.includes('\\')) return null;
    // Prose is read only by tests that name it (the README thresholds, a skill folder); nothing else can break.
    if (isDocumentation(path)) { tests.filter(test => reaches(test, covers(path)) || reaches(test, names(path))).forEach(test => chosen.add(test)); continue; }
    let hits;
    if (VERSION_FILES.includes(path)) hits = tests.filter(test => [test, ...edges.get(test)].some(file => VERSION_MARK.test(text.get(file) ?? '')));
    // A deleted or renamed file is no longer in the graph, so nothing can be said about who used it.
    else if (!existsSync(join(root, path))) return null;
    else if (WORKBENCH_INPUTS.test(path) || bundled.has(path)) hits = tests.filter(test => marked(test, WORKBENCH_MARK) || reaches(test, covers(path)));
    else if (BLENDER_PYTHON.test(path)) hits = tests.filter(test => marked(test, BLENDER_MARK) || reaches(test, covers(path)));
    else if (/^(src|scripts|tests|recipes)\//.test(path)) hits = tests.filter(test => reaches(test, covers(path)));
    else return null;
    // A file nothing reaches is not trusted to be unused.
    if (!hits.length) return null;
    hits.forEach(test => chosen.add(test));
  }
  return tests.filter(test => chosen.has(test));
}
