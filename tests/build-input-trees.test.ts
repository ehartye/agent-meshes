/** @lane merge
 * @subject src/build-provenance.ts
 */
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureBuildInputs } from '../src/build-provenance.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-input-tree-'))); roots.push(root);
  await mkdir(join(root, 'lib', 'nested'), { recursive: true });
  await mkdir(join(root, 'lib', '__pycache__'));
  const files = { 'build.json': '{}', 'entry.py': '# entry\n', 'lib/a.py': 'A=1\n', 'lib/nested/b.py': 'B=2\n', 'lib/data.json': '{"scale":1}', 'lib/skip.py': '# excluded', 'lib/__pycache__/a.pyc': 'cache', 'lib/stale.pyc': 'cache' };
  await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(root, path), text)));
  const capture = (declared: Parameters<typeof captureBuildInputs>[2], output = join(root, 'generated')) => captureBuildInputs(join(root, 'build.json'), join(root, 'entry.py'), declared, output);
  return { root, capture };
}

it('expands sorted matching raw-byte inputs and records a reproducible tree pin', async () => {
  const { root, capture } = await fixture();
  const declaration = { dir: 'lib', include: ['**/*.py', '**/*.json'], exclude: ['skip.py'] };
  const result = await capture([declaration]);
  expect(result.files.map(file => file.path)).toEqual(['entry.py', 'lib/a.py', 'lib/data.json', 'lib/nested/b.py']);
  const records = await Promise.all(['lib/a.py', 'lib/data.json', 'lib/nested/b.py'].map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })));
  const expected = sha(JSON.stringify(records));
  expect(result.trees).toEqual([{ ...declaration, include: ['**/*.json', '**/*.py'], maxFiles: 10000, sha256: expected, paths: records.map(file => file.path) }]);
  expect((await capture([{ ...declaration, sha256: expected }])).treePins).toEqual(['lib']);
  await expect(capture([{ ...declaration, sha256: '0'.repeat(64) }])).rejects.toThrow(/tree.*pin/i);
  await result.assertUnchanged();
});

it('pins Unicode names in ECMAScript UTF-16 code-unit order rather than code-point or locale order', async () => {
  const { root, capture } = await fixture();
  await mkdir(join(root, 'unicode'));
  const names = ['unicode/\u{10000}.py', 'unicode/\uE000.py'];
  for (const path of names) await writeFile(join(root, path), '# same bytes\n');
  const result = await capture([{ dir: 'unicode' }]);
  const records = names.map(path => ({ path, sha256: sha('# same bytes\n') }));
  expect(result.trees[0].paths).toEqual(names);
  expect(result.trees[0].sha256).toBe(sha(JSON.stringify(records)));
});

it('detects selected additions, deletions and edits while excluding bytecode and ignored data', async () => {
  const { root, capture } = await fixture();
  const inputs = [{ dir: 'lib', include: ['**/*.py'], exclude: ['skip.py'] }];
  const original = await capture(inputs);
  await writeFile(join(root, 'lib', 'data.json'), 'ignored data');
  await writeFile(join(root, 'lib', '__pycache__', 'new.pyc'), 'ignored bytecode');
  await original.assertUnchanged();
  await writeFile(join(root, 'lib', 'new.py'), '# new');
  await expect(original.assertUnchanged()).rejects.toThrow(/tree.*changed/i);
  const added = await capture(inputs);
  expect(added.trees[0].sha256).not.toBe(original.trees[0].sha256);
  await rm(join(root, 'lib', 'new.py'));
  await expect(added.assertUnchanged()).rejects.toThrow(/changed|missing/i);
  const edited = await capture(inputs);
  await writeFile(join(root, 'lib', 'a.py'), 'A=2\n');
  await expect(edited.assertUnchanged()).rejects.toThrow(/changed/i);
  expect((await capture(inputs)).trees[0].sha256).not.toBe(original.trees[0].sha256);
});

it('retains empty declared trees so their first matching file invalidates the snapshot', async () => {
  const { root, capture } = await fixture();
  await mkdir(join(root, 'empty'));
  const result = await capture([{ dir: 'empty', include: ['**/*.py'] }]);
  expect(result.trees[0].paths).toEqual([]);
  await writeFile(join(root, 'empty', 'first.py'), '# first');
  await expect(result.assertUnchanged()).rejects.toThrow(/tree.*changed/i);
});

it('rejects transient additions removed before publication', async () => {
  const { root, capture } = await fixture();
  const captured = await capture([{ dir: 'lib' }]);
  await writeFile(join(root, 'lib', 'temporary.py'), '# observed during generation');
  await rm(join(root, 'lib', 'temporary.py'));
  await expect(captured.assertUnchanged()).rejects.toThrow(/tree.*changed/i);
});

it('omitted includes cover dotfiles while explicit patterns retain documented glob semantics', async () => {
  const { root, capture } = await fixture();
  await writeFile(join(root, 'lib', '.parameters.json'), '{"hidden":true}');
  const all = await capture([{ dir: 'lib' }]);
  expect(all.trees[0].include).toBeNull();
  expect(all.files.map(file => file.path)).toContain('lib/.parameters.json');
  expect(all.files.map(file => file.path)).not.toContain('lib/stale.pyc');
  const matched = await capture([{ dir: 'lib', include: ['**/*.json', '**/.*.json'] }]);
  expect(matched.trees[0].paths).toEqual(['lib/.parameters.json', 'lib/data.json']);
});

it('rejects unsafe or ambiguous declarations, invalid patterns, overlap and bounded expansion overflow', async () => {
  const { root, capture } = await fixture();
  for (const declaration of [
    { dir: '../escape' }, { dir: '.' }, { dir: 'lib', include: ['../*.py'] },
    { dir: 'lib', include: ['/absolute.py'] }, { dir: 'lib', include: ['**/*.py'], maxFiles: 1 },
    { dir: 'lib', include: ['!a.py'] }, { dir: 'lib', include: [] },
  ]) await expect(capture([declaration])).rejects.toThrow(/path|pattern|limit|maximum|budget|include/i);
  await expect(capture([{ dir: 'lib' }], join(root, 'lib', 'generated'))).rejects.toThrow(/overlap/i);
  await expect(capture([{ dir: 'lib' }, { path: 'lib/a.py' }])).rejects.toThrow(/duplicate/i);
  await expect(capture([{ dir: 'lib' }, { dir: 'lib/nested' }])).rejects.toThrow(/duplicate/i);
  await link(join(root, 'lib', 'a.py'), join(root, 'linked.py'));
  await expect(capture([{ dir: 'lib' }])).rejects.toThrow(/link/i);
});

it('rejects linked directories even when their files would be excluded', async () => {
  const { root, capture } = await fixture();
  await mkdir(join(root, 'donor'));
  await symlink(join(root, 'donor'), join(root, 'lib', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(capture([{ dir: 'lib', include: ['**/*.py'] }])).rejects.toThrow(/link/i);
});
