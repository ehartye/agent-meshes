// Conservative area routing: this is not a complete per-test dependency graph.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function planChanges(paths, { full = false } = {}) {
  if (full || !Array.isArray(paths)) return { javascript: true, python: true };
  let javascript = false;
  for (const file of paths) {
    if (typeof file !== 'string' || file.includes('..') || file.includes('\\')) return { javascript: true, python: true };
    if (/^(README\.md|AGENTS\.md|CLAUDE\.md|LICENSE|\.github\/README\.md)$/.test(file)
      || /^skills\/.*\.md$/.test(file)
      || /^docs\/.*\.(md|json|txt|png|jpg|jpeg|svg|webp|gif|pdf)$/.test(file)) continue;
    if (/^src\/.*\.(ts|css|html)$/.test(file) || /^tests\/.*\.test\.ts$/.test(file)) {
      javascript = true;
      continue;
    }
    // Python, fixtures, toolchain/release/CI policy and new owners default to full.
    return { javascript: true, python: true };
  }
  return { javascript, python: false };
}

export function gateFailures(plan, results) {
  if (typeof plan.javascript !== 'boolean' || typeof plan.python !== 'boolean') return ['invalid plan'];
  const expected = { quick: 'success', node: plan.javascript ? 'success' : 'skipped', browser: plan.javascript ? 'success' : 'skipped', python: plan.python ? 'success' : 'skipped' };
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
    let paths = null;
    if (isPr) {
      try { paths = pullRequestPaths(event); }
      catch (error) { console.warn(`Change scope unavailable; selecting all suites: ${error.message}`); }
    }
    const full = !isPr || event.pull_request?.labels?.some(label => label.name === 'ci:full');
    const plan = planChanges(paths, { full });
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'meshes-ci-'));
    const pathsFile = join(directory, 'changed-paths.json');
    writeFileSync(pathsFile, JSON.stringify(paths ?? []) + '\n');
    const output = `javascript=${plan.javascript}\npython=${plan.python}\npaths_file=${pathsFile}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    const summary = `CI plan: ${paths === null ? 'full (no PR diff)' : `${paths.length} changed paths`}; JavaScript/browser=${plan.javascript}; Python=${plan.python}.\n`;
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
    const failures = gateFailures({ javascript: boolean('CI_JAVASCRIPT'), python: boolean('CI_PYTHON') }, {
      quick: process.env.CI_QUICK_RESULT, node: process.env.CI_NODE_RESULT,
      python: process.env.CI_PYTHON_RESULT, browser: process.env.CI_BROWSER_RESULT,
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
