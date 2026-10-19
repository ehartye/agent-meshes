// Conservative area routing: this is not a complete per-test dependency graph.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  throw new Error('Usage: node scripts/ci-plan.mjs plan|gate');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
