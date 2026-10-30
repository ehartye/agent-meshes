import { afterEach, expect, it } from 'vitest';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { renderBuiltAsset } from '../src/preview.ts';
import { blenderIt } from './helpers/blender.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const png = async (path: string) => {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

blenderIt('a Blender-authored build renders owned views and one contact sheet per clip, and a second build reuses the cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-build-render-')); directories.push(directory);
  await copyFile(resolve('tests/fixtures/build_render_asset.py'), join(directory, 'asset.py'));
  const config = join(directory, 'build.json'), output = join(directory, 'generated');
  await writeFile(config, JSON.stringify({ version: 1, name: 'Column', blender: { script: 'asset.py' }, output: 'generated' }));
  const options = { ifChanged: true, renderAsset: (_asset: { name: string }, stage: string) => renderBuiltAsset(stage) };

  const first = await buildAsset(config, options);
  expect(first.incremental?.blender).toBe('built');
  for (const file of ['front.png', 'side.png', 'perspective.png', 'Sway-contact.png', 'Turn-contact.png']) expect(first.files).toContain(file);
  expect(first.files.filter(file => file.endsWith('.png'))).toHaveLength(5);
  expect(first.warnings ?? []).toEqual([]);
  expect(await png(join(output, 'front.png'))).toEqual({ width: 512, height: 512 });
  expect(await png(join(output, 'Sway-contact.png'))).toEqual({ width: 1280, height: 640 });
  const marker = JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8'));
  expect(marker.files).toEqual(expect.arrayContaining(first.files));
  expect((await readdir(output)).sort()).toEqual([...marker.files, '.agent-meshes-build.json'].sort());

  const second = await buildAsset(config, options);
  expect(second.incremental).toMatchObject({ blender: 'reused', reason: 'matching-native-cache' });
  expect(second.files.sort()).toEqual(first.files.sort());
  await png(join(output, 'perspective.png'));

  // Without the render callback (the library default and --no-preview) the build owns no PNGs.
  const plain = await buildAsset(config, { force: true });
  expect(plain.files.some(file => file.endsWith('.png'))).toBe(false);
  expect((await readdir(output)).some(file => file.endsWith('.png'))).toBe(false);
}, 300000);
