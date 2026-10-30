/** @lane merge
 * @subject scripts/ci-plan.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planChanges, gateFailures, pullRequestPaths, readTestingPhase, localGate, localGateMain, workflowPythonScripts, DONE_MARKER } from '../scripts/ci-plan.mjs';

test('dev PRs use only quick checks even for versions, policy or unknown inputs', () => {
  const quick = { javascript: false, python: false, geometrySweeps: false, recipeExamples: false };
  for (const paths of [null, ['package.json'], ['.testing/risk.yml'], ['new/data.bin'], ['scripts/blender_lib/agent_meshes_face.py']]) {
    assert.deepEqual(planChanges(paths, { phase: 'dev' }), quick);
    assert.deepEqual(planChanges(paths, { phase: 'dev', full: true }), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  }
  assert.throws(() => planChanges([], { phase: 'typo' }), /phase/);
  assert.deepEqual(planChanges(['package.json'], { phase: 'test' }), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
});

test('planner reads the checked risk map and retains explicit full dev runs', t => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-dev-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.testing'));
  const policy = join(root, '.testing/risk.yml');
  const output = join(root, 'outputs');
  const script = resolve('scripts/ci-plan.mjs');
  assert.throws(() => readTestingPhase(root));
  for (const body of ['consumers: []\n', 'phase: typo\n', 'phase: dev\nphase: production\n', 'phase: dev\nphase : production\n', 'phase: dev\n"phase": production\n']) {
    writeFileSync(policy, body);
    assert.throws(() => readTestingPhase(root), /phase/);
  }
  writeFileSync(policy, 'phase: dev # sole owner\n');
  assert.equal(readTestingPhase(root), 'dev');
  const run = event => spawnSync(process.execPath, [script, 'plan'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: '', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
  });
  assert.equal(run('pull_request').status, 0);
  assert.match(readFileSync(output, 'utf8'), /phase=dev\njavascript=false\npython=false/);
  writeFileSync(output, '');
  assert.equal(run('schedule').status, 0);
  assert.match(readFileSync(output, 'utf8'), /geometry_sweeps=true\nrecipe_examples=true/);
  writeFileSync(policy, 'phase: typo\n');
  assert.equal(run('pull_request').status, 1);
});

test('documentation-only changes avoid every expensive suite, including deleted docs', () => {
  assert.deepEqual(planChanges(['README.md', 'skills/mesh-build/SKILL.md', 'docs/validation/check.json']), { javascript: false, python: false, geometrySweeps: false, recipeExamples: false });
});

test('TypeScript changes retain both JavaScript platforms without unrelated Python work', () => {
  assert.deepEqual(planChanges(['src/core/model.ts', 'tests/model.test.ts', 'docs/guide.md']), { javascript: true, python: false, geometrySweeps: false, recipeExamples: false });
});

test('Python, shared inputs, policy and unknown paths conservatively run the full suite', () => {
  for (const file of ['tests/fixtures/head.glb', 'package-lock.json', '.github/workflows/check.yml', 'scripts/ci-plan.mjs', 'new-owner/data.bin', 'scripts/blender_lib/README.md']) {
    assert.deepEqual(planChanges([file]), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true }, file);
  }
});

test('force-full and missing change information never reduce coverage', () => {
  assert.deepEqual(planChanges(['README.md'], { full: true }), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  assert.deepEqual(planChanges(null), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
});

test('renaming a source into documentation still selects full coverage when both paths are supplied', () => {
  assert.deepEqual(planChanges(['scripts/blender-author.py', 'docs/old-generator.md']), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
});

test('gate accepts only successful selected jobs and explicitly unselected skips', () => {
  assert.deepEqual(gateFailures({ javascript: false, python: false, geometrySweeps: false, recipeExamples: false }, { quick: 'success', node: 'skipped', python: 'skipped', browser: 'skipped', examples: 'skipped' }), []);
  assert.deepEqual(gateFailures({ javascript: true, python: false, geometrySweeps: false, recipeExamples: false }, { quick: 'success', node: 'success', python: 'skipped', browser: 'success', examples: 'skipped' }), []);
  for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
    assert.ok(gateFailures({ javascript: true, python: true, geometrySweeps: true, recipeExamples: true }, { quick: 'success', node: result, python: 'success', browser: 'success', examples: 'success' }).length, String(result));
  }
  assert.ok(gateFailures({ javascript: false, python: false, geometrySweeps: false, recipeExamples: false }, { quick: 'failure', node: 'skipped', python: 'skipped', browser: 'skipped', examples: 'skipped' }).length);
  assert.ok(gateFailures({ javascript: false, python: false, geometrySweeps: false, recipeExamples: false }, { quick: 'success', node: 'failure', python: 'skipped', browser: 'skipped', examples: 'skipped' }).length);
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
  assert.deepEqual(planChanges(paths), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  assert.throws(() => pullRequestPaths({ pull_request: { base: { sha: '--help' } } }, root), /SHA/);
});

test('gate CLI fails closed for absent planning output and failed selected jobs', () => {
  const env = { ...process.env, CI_JAVASCRIPT: 'true', CI_PYTHON: 'false', CI_GEOMETRY_SWEEPS: 'false', CI_QUICK_RESULT: 'success', CI_NODE_RESULT: 'success', CI_BROWSER_RESULT: 'success', CI_PYTHON_RESULT: 'skipped', CI_RECIPE_EXAMPLES: 'false', CI_EXAMPLES_RESULT: 'skipped' };
  const run = overrides => spawnSync(process.execPath, [resolve('scripts/ci-plan.mjs'), 'gate'], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  assert.equal(run({ CI_NODE_RESULT: 'failure' }).status, 1);
  assert.equal(run({ CI_JAVASCRIPT: '' }).status, 1);
  assert.equal(run({ CI_GEOMETRY_SWEEPS: '' }).status, 1);
  assert.equal(run({ CI_RECIPE_EXAMPLES: '' }).status, 1);
  assert.equal(run({ CI_EXAMPLES_RESULT: 'failure' }).status, 1);
});

test('ordinary Python edits keep merge checks while full sweeps require a full input or explicit run', () => {
  for (const file of ['recipes/stylized_character.py', 'scripts/blender_lib/agent_meshes_face.py', 'tests/stylized_costume.py']) {
    assert.deepEqual(planChanges([file]), { javascript: true, python: true, geometrySweeps: false, recipeExamples: file.startsWith('recipes/') || file.startsWith('tests/stylized_') });
    assert.deepEqual(planChanges([file], { full: true }), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
    assert.deepEqual(planChanges([file, 'package.json']), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  }
  assert.deepEqual(planChanges(['tests/geometry-sweeps.json']), { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  assert.ok(gateFailures({ javascript: true, python: true }, {}).includes('invalid plan'));
});


test('shared helper contracts gate merges independently of recipe examples', () => {
  assert.deepEqual(planChanges(['scripts/blender_lib/agent_meshes_face_geometry.py']), { javascript: true, python: true, geometrySweeps: false, recipeExamples: false });
  for (const file of ['recipes/stylized_character.py', 'recipes/stylized_face.py', 'tests/stylized_face.py', 'tests/face_recipe_parity.py']) {
    assert.equal(planChanges([file]).recipeExamples, true, file);
  }
  const plan = { javascript: true, python: true, geometrySweeps: false, recipeExamples: true };
  assert.deepEqual(gateFailures(plan, { quick: 'success', node: 'success', python: 'success', browser: 'success', examples: 'success' }), []);
  for (const examples of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.ok(gateFailures(plan, { quick: 'success', node: 'success', python: 'success', browser: 'success', examples }).length, String(examples));
  }
  assert.ok(gateFailures({ ...plan, recipeExamples: false, geometrySweeps: true }, {}).includes('invalid plan'));
});

test('local-gate for a skills-only diff selects the skills lane, even in the dev phase', () => {
  const gate = localGate(['skills/mesh-build/SKILL.md', 'skills/mesh-build/references/native-build-identity.md']);
  assert.equal(gate.lane, 'skills-only');
  const commands = gate.commands.map(entry => entry.command);
  assert.deepEqual(commands.filter(command => !command.includes('check_docs')), [
    'npm run typecheck', 'python tests/ci_docs.py',
    'npx vitest run tests/build-output-guidance.test.ts tests/mesh-tool-selection-skill.test.ts',
  ]);
  assert.ok(!commands.some(command => /face-rig|npm test|build$/.test(command)));
  // Dev still silences the PR observer; the local gate does not read the phase.
  assert.deepEqual(planChanges(['skills/mesh-build/SKILL.md'], { phase: 'dev' }), { javascript: false, python: false, geometrySweeps: false, recipeExamples: false });
  // A skill file outside SKILL.md and references/ is not trusted to be skills-only.
  assert.notEqual(localGate(['skills/mesh-build/scripts/helper.py']).lane, 'skills-only');
});

test('local-gate maps a digitigrade gait change to its body-timing test and runs merge-lane Python', () => {
  const gate = localGate(['scripts/blender_lib/agent_meshes_digitigrade_gait.py']);
  const commands = gate.commands.map(entry => entry.command);
  assert.equal(gate.lane, 'affected');
  assert.equal(gate.testLane, 'merge');
  assert.ok(commands.includes('python tests/digitigrade_gait.py'));
  assert.ok(commands.includes('python tests/digitigrade_body_timing.py'));
  assert.ok(commands.includes('npm run typecheck'));
  assert.ok(!commands.includes('python tests/face_components.py'), 'an unrelated face script is not selected');
  assert.ok(commands.length < workflowPythonScripts().python.length, 'narrower than the whole python job');
  // The workflow itself runs the body-timing file, so CI and the local plan agree.
  assert.ok(workflowPythonScripts().python.includes('tests/digitigrade_body_timing.py'));
  assert.ok(workflowPythonScripts().python.includes('tests/digitigrade_gait.py'));
});

test('local-gate for a version bump runs the full plan with every script', () => {
  const gate = localGate(['package.json', 'skills/mesh-build/SKILL.md']);
  const commands = gate.commands.map(entry => entry.command);
  const { python, examples } = workflowPythonScripts();
  assert.equal(gate.lane, 'full');
  assert.equal(gate.testLane, 'full');
  assert.deepEqual(gate.plan, { javascript: true, python: true, geometrySweeps: true, recipeExamples: true });
  for (const script of [...python, ...examples]) assert.ok(commands.includes(`python ${script}`), script);
  assert.ok(commands.some(command => command.startsWith('node --test ') && command.includes('tests/ci-plan.test.mjs')));
  assert.ok(commands.includes('npm run build'));
});


test('local-gate reads committed, edited and untracked paths from Git and ends with the done marker', t => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-local-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'CI routing test');
  git('config', 'user.email', 'ci-test@example.invalid');
  mkdirSync(join(root, 'skills/x/references'), { recursive: true });
  writeFileSync(join(root, 'skills/x/SKILL.md'), 'start\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'skills/x/SKILL.md'), 'committed edit\n');
  git('commit', '-qam', 'edit skill');
  writeFileSync(join(root, 'skills/x/references/note.md'), 'untracked reference\n');
  const lines = [];
  assert.equal(localGateMain(['--base', base], root, line => lines.push(line)), 0);
  assert.match(lines[0], /^local-gate: base=[0-9a-f]{40}; 2 changed paths; lane=skills-only; AGENT_MESHES_TEST_LANE=merge$/);
  assert.match(lines.at(-1), new RegExp(`^${DONE_MARKER} lane=skills-only status=planned commands=4$`));
  const cli = args => spawnSync(process.execPath, [resolve('scripts/ci-plan.mjs'), 'local-gate', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(cli([]).status, 1);
  assert.equal(cli(['--base', '--run']).status, 1);
  assert.equal(cli(['--base', base]).status, 0);
});
