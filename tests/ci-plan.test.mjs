/** @lane merge
 * @subject scripts/ci-plan.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planChanges, gateFailures, pullRequestPaths } from '../scripts/ci-plan.mjs';

test('documentation-only changes avoid every expensive suite, including deleted docs', () => {
  assert.deepEqual(planChanges(['README.md', 'skills/mesh-build/SKILL.md', 'docs/validation/check.json']), { javascript: false, python: false });
});

test('TypeScript changes retain both JavaScript platforms without unrelated Python work', () => {
  assert.deepEqual(planChanges(['src/core/model.ts', 'tests/model.test.ts', 'docs/guide.md']), { javascript: true, python: false });
});

test('Python, shared inputs, policy and unknown paths conservatively run the full suite', () => {
  for (const file of ['recipes/stylized_character.py', 'scripts/blender_lib/agent_meshes_face.py', 'tests/stylized_costume.py', 'tests/fixtures/head.glb', 'package-lock.json', '.github/workflows/check.yml', 'scripts/ci-plan.mjs', 'new-owner/data.bin', 'scripts/blender_lib/README.md']) {
    assert.deepEqual(planChanges([file]), { javascript: true, python: true }, file);
  }
});

test('force-full and missing change information never reduce coverage', () => {
  assert.deepEqual(planChanges(['README.md'], { full: true }), { javascript: true, python: true });
  assert.deepEqual(planChanges(null), { javascript: true, python: true });
});

test('renaming a source into documentation still selects full coverage when both paths are supplied', () => {
  assert.deepEqual(planChanges(['scripts/blender-author.py', 'docs/old-generator.md']), { javascript: true, python: true });
});

test('gate accepts only successful selected jobs and explicitly unselected skips', () => {
  assert.deepEqual(gateFailures({ javascript: false, python: false }, { quick: 'success', node: 'skipped', python: 'skipped', browser: 'skipped' }), []);
  assert.deepEqual(gateFailures({ javascript: true, python: false }, { quick: 'success', node: 'success', python: 'skipped', browser: 'success' }), []);
  for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
    assert.ok(gateFailures({ javascript: true, python: true }, { quick: 'success', node: result, python: 'success', browser: 'success' }).length, String(result));
  }
  assert.ok(gateFailures({ javascript: false, python: false }, { quick: 'failure', node: 'skipped', python: 'skipped', browser: 'skipped' }).length);
  assert.ok(gateFailures({ javascript: false, python: false }, { quick: 'success', node: 'failure', python: 'skipped', browser: 'skipped' }).length);
});

test('real Git diff includes deleted inputs and both sides of a rename with spaces', t => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-ci-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'CI routing test');
  git('config', 'user.email', 'ci-test@example.invalid');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'generator.py'), 'original input\n');
  git('add', '.');
  git('commit', '-qm', 'input');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(root, 'docs'));
  git('mv', 'scripts/generator.py', 'docs/old generator.md');
  git('commit', '-qam', 'move input');
  const paths = pullRequestPaths({ pull_request: { base: { sha: base }, head: { sha: git('rev-parse', 'HEAD') } } }, root);
  assert.deepEqual(paths.sort(), ['docs/old generator.md', 'scripts/generator.py']);
  assert.deepEqual(planChanges(paths), { javascript: true, python: true });
  assert.throws(() => pullRequestPaths({ pull_request: { base: { sha: '--help' } } }, root), /SHA/);
});

test('gate CLI fails closed for absent planning output and failed selected jobs', () => {
  const env = { ...process.env, CI_JAVASCRIPT: 'true', CI_PYTHON: 'false', CI_QUICK_RESULT: 'success', CI_NODE_RESULT: 'success', CI_BROWSER_RESULT: 'success', CI_PYTHON_RESULT: 'skipped' };
  const run = overrides => spawnSync(process.execPath, [resolve('scripts/ci-plan.mjs'), 'gate'], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  assert.equal(run({ CI_NODE_RESULT: 'failure' }).status, 1);
  assert.equal(run({ CI_JAVASCRIPT: '' }).status, 1);
});
