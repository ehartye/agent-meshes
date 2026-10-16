import { it, expect } from 'vitest';
import { rigCatalog, verifyRigLibrary, rigDemo, packageRoot } from '../scripts/rig-library.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('discovers all nine real banks by body plan and role, reusing existing humans', async () => {
  const catalog = await rigCatalog();
  expect(catalog.libraries).toHaveLength(9);
  expect(new Set(catalog.libraries.map(item => item.id)).size).toBe(9);
  expect(catalog.libraries.filter(item => item.path.startsWith('../mannequins/'))).toHaveLength(2);
  expect(catalog.libraries.reduce((sum, item) => sum + item.clips.length, 0)).toBe(214);
  expect(catalog.libraries.find(item => item.id === 'spider')?.bodyPlan).toBe('many-legged');
});

it('checks actual source bytes, every catalog clip and all delivered GLBs', async () => {
  const result = await verifyRigLibrary();
  expect(result.sourceSnapshots).toBe(26);
  expect(result.libraries).toHaveLength(9);
  expect(result.errors).toBe(0);
}, 30000);

it('rejects an unusable demo selection before producing files', async () => {
  await expect(rigDemo(['spider'], 'unused.html')).rejects.toThrow('distinct');
  await expect(rigDemo(['spider', '../outside'], 'unused.html')).rejects.toThrow('Unknown');
  await expect(rigDemo(['human-base', 'fox'], join(packageRoot, 'scripts/rigging/toy-maker/unused.html')))
    .rejects.toThrow('bundled source');
  await expect(rigDemo(['human-base', 'fox'], 'source.py')).rejects.toThrow('.html');
});

it('preserves existing demo and comparison bytes before writing any output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'meshes-rig-collision-'));
  try {
    const html = join(folder, 'review.html');
    await writeFile(html, 'owner review');
    await expect(rigDemo(['human-base', 'fox'], html)).rejects.toThrow('exists');
    expect(await readFile(html, 'utf8')).toBe('owner review');
    const fresh = join(folder, 'fresh.html');
    await writeFile(fresh + '.comparison.json', 'owner comparison');
    await expect(rigDemo(['human-base', 'fox'], fresh)).rejects.toThrow('exists');
    expect(await readFile(fresh + '.comparison.json', 'utf8')).toBe('owner comparison');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
