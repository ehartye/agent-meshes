/** @lane merge
 * @subject src/build-provenance.ts
 */
import { it as runTest, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureBuildInputs, captureBuildToolchain, checkToolchainPin } from '../src/build-provenance.ts';

const directories: string[] = [];
let failed = false;
const it = (name: string, run: () => Promise<void>) => runTest(name, async () => {
  try { await run(); } catch (error) { failed = true; throw error; }
});
afterEach(async () => {
  if (failed) {
    failed = false;
    console.error('Retained provenance fixtures:', directories.splice(0)); return;
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mesh-build-provenance-')); directories.push(root);
  const config = join(root, 'build.json'), output = join(root, 'generated');
  await writeFile(config, '{}'); await writeFile(join(root, 'entry.py'), 'import design\n');
  await writeFile(join(root, 'design.py'), 'WIDTH = 1\n');
  return { root, config, output };
}
async function runtimeFixture() {
  const { root } = await fixture();
  await mkdir(join(root, 'scripts', 'blender_lib', 'data'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent-meshes', version: '1.2.3' }));
  await writeFile(join(root, 'scripts', 'blender-author.py'), 'wrapper\n');
  await writeFile(join(root, 'scripts', 'blender_lib', 'helper.py'), 'helper\n');
  await writeFile(join(root, 'scripts', 'blender_lib', 'data', 'shape.bin'), new Uint8Array([0, 255, 13, 10]));
  return root;
}

it('captures entry and explicit imported/data bytes in deterministic relative-name order', async () => {
  const { root, config, output } = await fixture();
  await writeFile(join(root, 'shape.bin'), new Uint8Array([0, 255]));
  const inputs = [{ path: 'shape.bin' }, { path: 'design.py', sha256: sha256('WIDTH = 1\n') }];
  const first = await captureBuildInputs(config, 'entry.py', inputs, output);
  const second = await captureBuildInputs(config, 'entry.py', [...inputs].reverse(), output);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.files.map(file => file.path), ['design.py', 'entry.py', 'shape.bin']);
  assert.equal(first.files[2].sha256, sha256(new Uint8Array([0, 255])));
  await first.assertUnchanged();
});

it('rejects missing declared imports visibly before a build can publish', async () => {
  const { config, output } = await fixture();
  await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path: 'missing.py' }], output), /missing.*missing\.py/i);
});

it('rejects declared input pins changed since the reviewed declaration', async () => {
  const { config, output } = await fixture();
  await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path: 'design.py', sha256: '0'.repeat(64) }], output), /pin.*design\.py/i);
});

it('detects an imported input changed during the build', async () => {
  const { root, config, output } = await fixture();
  const snapshot = await captureBuildInputs(config, 'entry.py', [{ path: 'design.py' }], output);
  await writeFile(join(root, 'design.py'), 'WIDTH = 2\n');
  await assert.rejects(snapshot.assertUnchanged(), /changed.*design\.py/i);
});

it('detects an input edited and then restored by checking file metadata as well as hashes', async () => {
  const { root, config, output } = await fixture();
  const snapshot = await captureBuildInputs(config, 'entry.py', [{ path: 'design.py' }], output);
  await writeFile(join(root, 'design.py'), 'WIDTH = 99\n');
  await writeFile(join(root, 'design.py'), 'WIDTH = 1\n');
  await assert.rejects(snapshot.assertUnchanged(), /changed.*design\.py/i);
});

it('rejects wrong installed version, helpers and actual Blender pins', async () => {
  const snapshot = await captureBuildToolchain(await runtimeFixture());
  const actual = { ...snapshot.identity, blenderVersion: '5.0.1' };
  const good = { ...actual };
  checkToolchainPin(good, actual);
  for (const wrong of [{ ...good, agentMeshesVersion: '9.9.9' }, { ...good, helpersSha256: '0'.repeat(64) }, { ...good, blenderVersion: '4.0.0' }]) {
    assert.throws(() => checkToolchainPin(wrong, actual), /toolchain.*pin/i);
  }
});

it('also protects config and entry bytes, and catches declared inputs removed while running', async () => {
  for (const path of ['build.json', 'entry.py', 'design.py']) {
    const { root, config, output } = await fixture();
    const snapshot = await captureBuildInputs(config, 'entry.py', [{ path: 'design.py' }], output);
    if (path === 'design.py') await rm(join(root, path));
    else await writeFile(join(root, path), 'changed');
    await assert.rejects(snapshot.assertUnchanged(), /changed|missing/i);
  }
});

it('rejects output containing any config/entry/declared file and allows pinning the entry once', async () => {
  const { root, config } = await fixture();
  await mkdir(join(root, 'protected'));
  await writeFile(join(root, 'protected', 'data.bin'), 'keep');
  for (const output of [root, join(root, 'entry.py'), join(root, 'protected')]) {
    await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path: 'protected/data.bin' }], output), /contain/i);
  }
  const snapshot = await captureBuildInputs(config, 'entry.py', [{ path: 'entry.py', sha256: sha256('import design\n') }], join(root, 'generated'));
  assert.deepEqual(snapshot.files, [{ path: 'entry.py', sha256: sha256('import design\n') }]);
  assert.deepEqual(snapshot.pins, ['entry.py']);
});

it('requires explicit portable files without globs, aliases, duplicate declarations or directories', async () => {
  const { root, config, output } = await fixture();
  for (const path of ['../design.py', './design.py', 'design\\other.py', '*.py', 'data/**', '/design.py', 'C:design.py', 'design.py.', 'design.py ', 'data//design.py']) {
    await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path }], output), /unsafe/i);
  }
  await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path: 'design.py' }, { path: 'design.py' }], output), /duplicate/i);
  await mkdir(join(root, 'data'));
  await assert.rejects(captureBuildInputs(config, 'entry.py', [{ path: 'data' }], output), /regular file/i);
});

it('identifies wrapper, full helper tree and actual data bytes while ignoring Python bytecode', async () => {
  const root = await runtimeFixture();
  await mkdir(join(root, 'scripts', 'blender_lib', '__pycache__'));
  await writeFile(join(root, 'scripts', 'blender_lib', '__pycache__', 'helper.cpython-312.pyc'), 'first cache');
  await writeFile(join(root, 'scripts', 'blender_lib', 'other.pyc'), 'another cache');
  const captured = await captureBuildToolchain(root);
  assert.deepEqual(captured.files.map(file => file.path), [
    'scripts/blender-author.py', 'scripts/blender_lib/data/shape.bin', 'scripts/blender_lib/helper.py',
  ]);
  assert.equal(captured.files[1].sha256, sha256(new Uint8Array([0, 255, 13, 10])));
  assert.equal(captured.identity.helpersSha256, sha256(JSON.stringify(captured.files)));
  await writeFile(join(root, 'scripts', 'blender_lib', '__pycache__', 'helper.cpython-312.pyc'), 'changed cache');
  await captured.assertUnchanged();
  await writeFile(join(root, 'scripts', 'blender_lib', 'data', 'shape.bin'), new Uint8Array([0, 255, 10]));
  await assert.rejects(captured.assertUnchanged(), /toolchain changed/i);
  assert.notEqual((await captureBuildToolchain(root)).identity.helpersSha256, captured.identity.helpersSha256);
});

it('binds helper additions, removals, wrapper edits and installed package metadata', async () => {
  for (const mutate of [
    (root: string) => writeFile(join(root, 'scripts', 'blender_lib', 'extra.json'), '{}'),
    (root: string) => rm(join(root, 'scripts', 'blender_lib', 'data', 'shape.bin')),
    (root: string) => writeFile(join(root, 'scripts', 'blender-author.py'), 'changed wrapper'),
    (root: string) => writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent-meshes', version: '1.2.3', extra: true })),
  ]) {
    const root = await runtimeFixture(), captured = await captureBuildToolchain(root);
    await mutate(root);
    await assert.rejects(captured.assertUnchanged(), /toolchain changed/i);
  }
});

it('keeps tool identity portable across equivalent installations and refuses helper/output overlap', async () => {
  const firstRoot = await runtimeFixture(), secondRoot = await runtimeFixture();
  const first = await captureBuildToolchain(firstRoot), second = await captureBuildToolchain(secondRoot);
  assert.deepEqual(first.identity, second.identity);
  assert.deepEqual(first.files, second.files);
  assert.equal(first.identity.agentMeshesVersion, '1.2.3');
  assert.ok(!JSON.stringify(first.files).includes(firstRoot));
  await assert.rejects(captureBuildToolchain(firstRoot, join(firstRoot, 'scripts', 'blender_lib', 'generated')), /overlap/i);
});
