/** @lane merge
 * @subject .github/scripts/release-candidate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordCandidate, verifyCandidate, verifyTag, findCandidate } from '../.github/scripts/release-candidate.mjs';

const expected = { repository: 'ehartye/agent-meshes', tree: 'a'.repeat(40), version: '0.19.0' };
const run = { id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', path: '.github/workflows/check.yml', head_repository: { full_name: expected.repository }, html_url: 'https://github.com/ehartye/agent-meshes/actions/runs/123' };
const receipt = { schema: 'agent-meshes/release-candidate@1', ...expected, commit: 'b'.repeat(40), runId: 123, runAttempt: 1, scope: 'full' };

test('tag must match the package version exactly', () => {
  assert.doesNotThrow(() => verifyTag('v0.19.0', '0.19.0'));
  assert.throws(() => verifyTag('v0.18.0', '0.19.0'), /version/);
  assert.throws(() => verifyTag('release', '0.19.0'), /version/);
});

test('matching tree survives a squash commit while changed contents are refused', () => {
  assert.doesNotThrow(() => verifyCandidate(receipt, expected, run));
  assert.throws(() => verifyCandidate(receipt, { ...expected, tree: 'c'.repeat(40) }, run), /tree/);
});

test('receipt cannot substitute another version, repository, attempt or partial scope', () => {
  for (const patch of [{ version: '0.18.0' }, { repository: 'other/repo' }, { runAttempt: 2 }, { runId: 999 }, { scope: 'documentation' }, { schema: 'other' }]) {
    assert.throws(() => verifyCandidate({ ...receipt, ...patch }, expected, run), undefined, JSON.stringify(patch));
  }
});

test('failed, unfinished, forked or unrelated workflows cannot authorize publication', () => {
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_repository: { full_name: 'fork/agent-meshes' } }, { path: '.github/workflows/unrelated.yml' }]) {
    assert.throws(() => verifyCandidate(receipt, expected, { ...run, ...patch }), undefined, JSON.stringify(patch));
  }
});

test('artifact lookup requires live evidence from a successful full Check run', () => {
  const artifact = { name: `validated-tree-${expected.tree}`, expired: false, workflow_run: { id: 123 } };
  const api = path => path.includes('/artifacts?') ? { artifacts: [artifact] } : run;
  assert.equal(findCandidate(expected, { api, download: () => receipt }).runId, 123);
  assert.throws(() => findCandidate(expected, { api: () => ({ artifacts: [{ ...artifact, expired: true }] }), download: () => receipt }), /full Check/);
  assert.throws(() => findCandidate(expected, { api: path => path.includes('/artifacts?') ? { artifacts: [artifact] } : { ...run, conclusion: 'failure' }, download: () => receipt }), /full Check/);
  assert.throws(() => findCandidate(expected, { api, download: () => ({ ...receipt, tree: 'd'.repeat(40) }) }), /full Check/);
});

test('record uses the checked Git tree and refuses partial scope or a dirty tracked file', t => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-release-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.invalid');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-meshes', version: '0.19.0' }));
  git('add', '.'); git('commit', '-qm', 'candidate');
  const env = { GITHUB_REPOSITORY: expected.repository, GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', CI_JAVASCRIPT: 'true', CI_PYTHON: 'true' };
  const recorded = recordCandidate(root, env);
  assert.equal(recorded.tree, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(recorded.version, '0.19.0');
  assert.equal(recorded.scope, 'full');
  assert.throws(() => recordCandidate(root, { ...env, CI_PYTHON: 'false' }), /full/);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-meshes', version: '0.20.0' }));
  assert.throws(() => recordCandidate(root, env), /dirty/);
});
