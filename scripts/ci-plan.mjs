// Conservative area routing: this is not a complete per-test dependency graph.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readTestingPhase(root = process.cwd()) {
  // Deliberately require one plain top-level enum, rather than guessing at YAML.
  // The risk-map validator checks the complete document separately.
  const text = readFileSync(join(root, '.testing/risk.yml'), 'utf8').replace(/^\uFEFF/, '');
  const fields = text.match(/^(?:phase|"phase"|'phase') *:[^\r\n]*$/gm) ?? [];
  const match = fields.length === 1 && /^phase: *(dev|test|production) *(?:#.*)?$/.exec(fields[0]);
  if (!match) throw new Error('Risk-map phase must be one plain top-level dev, test or production value');
  return match[1];
}

export function planChanges(paths, { full = false, phase = 'production' } = {}) {
  if (!['dev', 'test', 'production'].includes(phase)) throw new Error('Invalid testing phase');
  const all = { javascript: true, python: true, geometrySweeps: true, recipeExamples: true };
  if (full) return all;
  if (phase === 'dev') return { javascript: false, python: false, geometrySweeps: false, recipeExamples: false };
  if (!Array.isArray(paths)) return all;
  let javascript = false, python = false, recipeExamples = false;
  for (const file of paths) {
    if (typeof file !== 'string' || file.includes('..') || file.includes('\\')) return all;
    if (/^(README\.md|AGENTS\.md|CLAUDE\.md|LICENSE|\.github\/README\.md)$/.test(file)
      || /^skills\/.*\.md$/.test(file)
      || /^docs\/.*\.(md|json|txt|png|jpg|jpeg|svg|webp|gif|pdf)$/.test(file)) continue;
    if (/^src\/.*\.(ts|css|html)$/.test(file) || /^tests\/.*\.test\.ts$/.test(file)) {
      javascript = true;
      continue;
    }
    // Changing selection/fixture policy itself must prove the complete replacement.
    if (['tests/geometry_test_scope.py', 'tests/geometry_scope.py'].includes(file)) return all;
    if (/^(recipes\/.*|scripts\/blender_lib\/.*|tests\/[^/]+)\.py$/.test(file)) {
      javascript = true; python = true;
      if (file.startsWith('recipes/') || /^tests\/(stylized_.*|face_recipe_parity)\.py$/.test(file)) recipeExamples = true;
      continue;
    }
    // Dependencies, version, fixtures, CI and unknown inputs still require every sweep.
    return all;
  }
  return { javascript, python, geometrySweeps: false, recipeExamples };
}

// A change to a key helper must also run the tests that guard it, even if a text search would miss them.
export const PYTHON_TEST_MAP = {
  'scripts/blender_lib/agent_meshes_digitigrade_gait.py': ['tests/digitigrade_gait.py', 'tests/digitigrade_body_timing.py'],
};

// The workflow stays the one list of Python scripts: read the python and examples jobs instead of copying them.
export function workflowPythonScripts(root = REPO_ROOT) {
  const text = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('\n  python:\n');
  const examples = text.indexOf('\n  examples:\n');
  const end = text.indexOf('\n  required:\n');
  if (start < 0 || examples < start || end < examples) throw new Error('check.yml has no python, examples and required jobs in that order');
  const scripts = block => [...new Set([...block.matchAll(/^\s+run: python (?:-B )?(tests\/\S+\.py)\s*$/gm)].map(match => match[1]))];
  return { python: scripts(text.slice(start, examples)), examples: scripts(text.slice(examples, end)) };
}

// Tests that read a changed helper module, directly or through another helper module that reads it.
function testsReadingHelpers(changed, tests, root) {
  const libDir = join(root, 'scripts/blender_lib');
  const library = existsSync(libDir) ? readdirSync(libDir).filter(name => name.endsWith('.py')).map(name => name.slice(0, -3)) : [];
  const read = file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return ''; } };
  const libText = Object.fromEntries(library.map(name => [name, read(`scripts/blender_lib/${name}.py`)]));
  const reads = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  const affected = new Set(changed);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of library) {
      if (!affected.has(name) && [...affected].some(other => reads(libText[name], other))) { affected.add(name); grew = true; }
    }
  }
  return tests.filter(file => { const text = read(file); return [...affected].some(name => reads(text, name)); });
}

export function affectedPythonTests(paths, { root = REPO_ROOT } = {}) {
  const { python } = workflowPythonScripts(root);
  const chosen = new Set();
  const helpers = [];
  for (const file of paths) {
    if (PYTHON_TEST_MAP[file]) PYTHON_TEST_MAP[file].forEach(test => chosen.add(test));
    const helper = /^scripts\/blender_lib\/([^/]+)\.py$/.exec(file);
    if (helper) { helpers.push({ name: helper[1], mapped: Boolean(PYTHON_TEST_MAP[file]) }); continue; }
    if (python.includes(file)) { chosen.add(file); continue; }
    // A recipe, an unlisted test helper or anything else Python: no safe narrowing, so run the whole job.
    if (/\.py$/.test(file)) return python;
  }
  if (helpers.length) {
    const found = testsReadingHelpers(helpers.map(helper => helper.name), python, root);
    // A helper that nothing reads and no map names is not trusted to be unused.
    if (!found.length && !helpers.every(helper => helper.mapped)) return python;
    found.forEach(test => chosen.add(test));
  }
  return python.filter(test => chosen.has(test));
}

const SKILLS_ONLY = /^skills\/[^/]+\/(SKILL\.md|references\/.*\.md)$/;
export const SKILL_TESTS = ['tests/build-output-guidance.test.ts', 'tests/mesh-tool-selection-skill.test.ts'];
export const DONE_MARKER = 'LOCAL-GATE-DONE';

// What to run locally for a diff. Independent of the dev phase: the dev phase silences the PR observer's runtime
// jobs, which is why the whole gate falls on this local run. A version file, CI file or unknown input selects the
// full plan (planChanges already treats them that way).
export function localGate(paths, { root = REPO_ROOT, pathsFile = '<paths-file>' } = {}) {
  const docs = [
    { command: 'python tests/ci_docs.py' },
    { command: `python scripts/check_docs.py --paths-file "${pathsFile}"` },
  ];
  if (!paths.length) return { lane: 'none', plan: planChanges([], { phase: 'test' }), commands: [], testLane: 'merge' };
  const plan = planChanges(paths, { phase: 'test' });
  if (paths.every(file => SKILLS_ONLY.test(file))) {
    return { lane: 'skills-only', plan, testLane: 'merge', commands: [{ command: 'npm run typecheck' }, ...docs, { command: `npx vitest run ${SKILL_TESTS.join(' ')}` }] };
  }
  const full = plan.javascript && plan.python && plan.geometrySweeps && plan.recipeExamples;
  const lane = full ? 'full' : plan.javascript || plan.python ? 'affected' : 'docs-only';
  const commands = [...docs];
  if (plan.javascript) {
    const mjs = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
    commands.push({ command: 'npm run typecheck' }, { command: 'npm run build' }, { command: `node --test ${mjs.join(' ')}` },
      { command: 'npm test -- --maxWorkers=2 --exclude tests/capture-views.test.ts' }, { command: 'npm test -- tests/capture-views.test.ts --maxWorkers=1' });
  }
  if (plan.python) {
    const scripts = full ? workflowPythonScripts(root).python : affectedPythonTests(paths, { root });
    for (const script of scripts) commands.push({ command: `python ${script}` });
  }
  if (plan.recipeExamples) for (const script of workflowPythonScripts(root).examples) commands.push({ command: `python ${script}` });
  return { lane, plan, commands, testLane: plan.geometrySweeps ? 'full' : 'merge' };
}

export function localPaths(base, root = REPO_ROOT) {
  if (typeof base !== 'string' || !base || base.startsWith('-') || !/^[\w./~^@{}-]+$/.test(base)) throw new Error('local-gate needs --base <commit-ish>');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  // Committed since the base, uncommitted tracked edits, and new untracked files.
  return [...new Set([
    ...git(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`, '--']),
    ...git(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ])].sort();
}

export function localGateMain(args, root = REPO_ROOT, log = console.log) {
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
  const paths = localPaths(base, root);
  const directory = mkdtempSync(join(tmpdir(), 'meshes-local-gate-'));
  const pathsFile = join(directory, 'changed-paths.json');
  writeFileSync(pathsFile, JSON.stringify(paths) + '\n');
  const gate = localGate(paths, { root, pathsFile });
  log(`local-gate: base=${base}; ${paths.length} changed paths; lane=${gate.lane}; AGENT_MESHES_TEST_LANE=${gate.testLane}`);
  gate.commands.forEach((entry, index) => log(`${index + 1}. ${entry.command}`));
  if (!gate.commands.length) log('Nothing to run: no changed paths.');
  const run = args.includes('--run');
  let failed = null;
  if (run) {
    for (const entry of gate.commands) {
      log(`> ${entry.command}`);
      const result = spawnSync(entry.command, { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, AGENT_MESHES_TEST_LANE: gate.testLane } });
      if (result.status !== 0) { failed = entry.command; break; }
    }
  }
  // One line a monitor can wait for, printed last in every outcome.
  log(`${DONE_MARKER} lane=${gate.lane} status=${run ? (failed ? 'fail' : 'pass') : 'planned'} commands=${gate.commands.length}${failed ? ` failed=${JSON.stringify(failed)}` : ''}`);
  return failed ? 1 : 0;
}

export function gateFailures(plan, results) {
  if (typeof plan.javascript !== 'boolean' || typeof plan.python !== 'boolean' || typeof plan.geometrySweeps !== 'boolean' || typeof plan.recipeExamples !== 'boolean' || (plan.recipeExamples && !plan.python) || (plan.geometrySweeps && (!plan.python || !plan.recipeExamples))) return ['invalid plan'];
  const expected = { quick: 'success', node: plan.javascript ? 'success' : 'skipped', browser: plan.javascript ? 'success' : 'skipped', python: plan.python ? 'success' : 'skipped', examples: plan.recipeExamples ? 'success' : 'skipped' };
  return Object.entries(expected).filter(([job, result]) => results[job] !== result).map(([job, result]) => `${job}: expected ${result}, got ${results[job] ?? 'missing'}`);
}

export function pullRequestPaths(event, root = process.cwd()) {
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (![base, head].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) throw new Error('PR base/head SHA missing or invalid');
  // Full checkout history avoids API path-list limits. --no-renames retains both
  // sides of a source-to-documentation rename; NUL delimiters preserve filenames.
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function main() {
  const mode = process.argv[2];
  if (mode === 'plan') {
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const isPr = process.env.GITHUB_EVENT_NAME === 'pull_request';
    const phase = readTestingPhase();
    let paths = null;
    if (isPr) {
      try { paths = pullRequestPaths(event); }
      catch (error) { console.warn(`Change scope unavailable; using ${phase} phase policy: ${error.message}`); }
    }
    const full = !isPr || event.pull_request?.labels?.some(label => label.name === 'ci:full');
    const plan = planChanges(paths, { full, phase });
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'meshes-ci-'));
    const pathsFile = join(directory, 'changed-paths.json');
    writeFileSync(pathsFile, JSON.stringify(paths ?? []) + '\n');
    const output = `phase=${phase}\njavascript=${plan.javascript}\npython=${plan.python}\ngeometry_sweeps=${plan.geometrySweeps}\nrecipe_examples=${plan.recipeExamples}\npaths_file=${pathsFile}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    const summary = `CI plan: phase=${phase}; ${paths === null ? 'no PR diff' : `${paths.length} changed paths`}; JavaScript/browser=${plan.javascript}; Python=${plan.python}; geometry sweeps=${plan.geometrySweeps}; recipe examples=${plan.recipeExamples}.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary.trim());
    return;
  }
  if (mode === 'gate') {
    const boolean = name => {
      const value = process.env[name];
      if (!['true', 'false'].includes(value)) throw new Error(`Missing or invalid ${name}`);
      return value === 'true';
    };
    const failures = gateFailures({ javascript: boolean('CI_JAVASCRIPT'), python: boolean('CI_PYTHON'), geometrySweeps: boolean('CI_GEOMETRY_SWEEPS'), recipeExamples: boolean('CI_RECIPE_EXAMPLES') }, {
      quick: process.env.CI_QUICK_RESULT, node: process.env.CI_NODE_RESULT,
      python: process.env.CI_PYTHON_RESULT, browser: process.env.CI_BROWSER_RESULT,
      examples: process.env.CI_EXAMPLES_RESULT,
    });
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('Every selected suite passed; only explicitly unselected suites were skipped.');
    return;
  }
  if (mode === 'local-gate') {
    process.exitCode = localGateMain(process.argv.slice(3), process.cwd());
    return;
  }
  throw new Error('Usage: node scripts/ci-plan.mjs plan|gate|local-gate --base <commit-ish> [--run]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
