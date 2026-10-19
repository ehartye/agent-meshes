/** @lane merge
 * @subject src/build-config.ts
 */
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBuildConfig } from '../src/build-config.ts';

const roots: string[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-build-config-'))); roots.push(root);
  const put = async (path: string, value: unknown) => {
    const file = join(root, path); await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); return file;
  };
  return { root, put };
}

it('preserves a standalone JSON object and its exact raw-byte identity', async () => {
  const { put } = await fixture();
  const raw = '{ "version": 1, "blender": {"script":"cube.py"}, "output":"generated", "opaque": [null, 2] }\r\n';
  const file = await put('build.json', raw);
  const loaded = await loadBuildConfig(file);
  expect(loaded.value).toEqual(JSON.parse(raw));
  expect(loaded.sources).toEqual([{ path: 'build.json', sha256: sha(raw) }]);
  expect(loaded.leafSha256).toBe(sha(raw));
  await loaded.assertUnchanged();
});

it('merges nested defaults while resolving each extends relative to its declaring file', async () => {
  const { put } = await fixture();
  const base = await put('defaults/base.json', { version: 1, blender: { toolchain: { agentMeshesVersion: '0.23.0', helpersSha256: 'a'.repeat(64) }, readAudit: 'warn' }, verify: { maxTriangles: 100, pivot: 'bottom' } });
  const middle = await put('defaults/props.json', { extends: 'base.json', blender: { readAudit: 'strict' }, verify: { maxTriangles: 50 } });
  const leaf = await put('assets/barrel/build.json', { extends: '../../defaults/props.json', blender: { script: 'barrel.py' }, output: 'generated' });
  const loaded = await loadBuildConfig(leaf);
  expect(loaded.value).toEqual({ version: 1, blender: { toolchain: { agentMeshesVersion: '0.23.0', helpersSha256: 'a'.repeat(64) }, readAudit: 'strict', script: 'barrel.py' }, verify: { maxTriangles: 50, pivot: 'bottom' }, output: 'generated' });
  expect(loaded.sources).toEqual(await Promise.all([[leaf, 'build.json'], [middle, '../../defaults/props.json'], [base, '../../defaults/base.json']].map(async ([file, path]) => ({ path, sha256: sha(await readFile(file)) }))));
  expect(loaded.leafSha256).toBe(sha(await readFile(leaf)));
  await loaded.assertUnchanged();
});

it('replaces arrays and scalars without rebasing inherited asset path fields', async () => {
  const { put } = await fixture();
  await put('defaults.json', { blender: { script: 'source.py', inputs: [{ path: 'old.py' }] }, output: 'generated', verify: { maxTriangles: 100 }, name: 'base' });
  const leaf = await put('assets/build.json', { extends: '../defaults.json', blender: { inputs: [{ dir: 'lib' }] }, verify: null, name: 'leaf' });
  const loaded = await loadBuildConfig(leaf);
  expect(loaded.value).toEqual({ blender: { script: 'source.py', inputs: [{ dir: 'lib' }] }, output: 'generated', verify: null, name: 'leaf' });
});

it('rejects missing parents, non-object configs and invalid extends declarations', async () => {
  const { put } = await fixture();
  const missing = await put('build.json', { extends: 'missing.json' });
  await expect(loadBuildConfig(missing)).rejects.toThrow(/missing|unreadable|ENOENT/i);
  for (const value of [null, [], 1, '"text"']) {
    const file = await put('bad.json', typeof value === 'string' ? value : JSON.stringify(value));
    await expect(loadBuildConfig(file)).rejects.toThrow(/object/i);
  }
  for (const value of [null, [], 1, {}, '', '  ']) {
    const file = await put('bad.json', { extends: value });
    await expect(loadBuildConfig(file)).rejects.toThrow(/extends/i);
  }
});

it('rejects canonical cycles and bounds the chain to sixteen configs', async () => {
  const { root, put } = await fixture();
  const a = await put('a.json', { extends: 'b.json' }); await put('b.json', { extends: './a.json' });
  await expect(loadBuildConfig(a)).rejects.toThrow(/cycle/i);
  if (process.platform === 'win32') {
    const caseAlias = await put('Case.json', { extends: 'CASE.JSON' });
    await expect(loadBuildConfig(caseAlias)).rejects.toThrow(/cycle/i);
  }
  for (let i = 0; i < 16; i++) await put(`${i}.json`, i === 15 ? {} : { extends: `${i + 1}.json` });
  expect((await loadBuildConfig(join(root, '0.json'))).sources).toHaveLength(16);
  await put('15.json', { extends: '16.json' }); await put('16.json', {});
  await expect(loadBuildConfig(join(root, '0.json'))).rejects.toThrow(/16|depth|limit/i);
});

it('rejects base edits and follows the captured chain rather than an edited extends', async () => {
  const { put } = await fixture();
  const base = await put('base.json', { name: 'before' });
  const leaf = await put('build.json', { extends: 'base.json' });
  const loaded = await loadBuildConfig(leaf);
  await put('base.json', { name: 'after!' });
  await expect(loaded.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
  const next = await loadBuildConfig(leaf);
  await put('other.json', { name: 'different' }); await put('build.json', { extends: 'other.json' });
  await expect(next.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
  expect(await readFile(base, 'utf8')).toContain('after!');
});

it('rejects deleted and byte-identical replaced inherited configs', async () => {
  const { put, root } = await fixture();
  const base = await put('base.json', { name: 'same' }); const leaf = await put('build.json', { extends: 'base.json' });
  const loaded = await loadBuildConfig(leaf);
  await rename(base, join(root, 'previous.json')); await put('base.json', { name: 'same' });
  await expect(loaded.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
  const deleted = await loadBuildConfig(leaf); await unlink(base);
  await expect(deleted.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
});

it('permits initial canonical aliases but rejects a directory-link retarget', async () => {
  const { put, root } = await fixture();
  await put('one/base.json', { name: 'same' }); await put('two/base.json', { name: 'same' });
  const alias = join(root, 'shared'); await symlink(join(root, 'one'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const leaf = await put('build.json', { extends: 'shared/base.json' });
  const loaded = await loadBuildConfig(leaf); await loaded.assertUnchanged();
  await expect(loaded.assertPlainSources()).rejects.toThrow(/link|alias/i);
  expect(loaded.sources.map(source => source.path)).toEqual(['build.json', 'one/base.json']);
  await unlink(alias); await symlink(join(root, 'two'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(loaded.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
});

it('preserves legacy hard-linked config loading while rejecting later file mutation', async () => {
  const { put, root } = await fixture();
  const original = await put('original.json', { version: 1, output: 'generated' }); const alias = join(root, 'build.json');
  await link(original, alias);
  const loaded = await loadBuildConfig(alias); await loaded.assertUnchanged();
  expect(loaded.sources[0].path).toBe('build.json');
  await writeFile(original, '{"version":1,"output":"different"}');
  await expect(loaded.assertUnchanged()).rejects.toThrow(/config.*changed|changed.*config/i);
});

it('rejects dangerous property names recursively without changing prototypes', async () => {
  const { put } = await fixture();
  for (const raw of ['{"__proto__":{"polluted":true}}', '{"blender":{"constructor":{}}}', '{"inputs":[{"prototype":{}}]}']) {
    const file = await put('bad.json', raw);
    await expect(loadBuildConfig(file)).rejects.toThrow(/unsafe|dangerous|property/i);
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
