import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, applyOperation } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-build-test-')); directories.push(directory);
  const project = applyOperation(createProject('asset'), { op: 'add', part: { name: 'body' } });
  await writeFile(join(directory, 'source.json'), JSON.stringify(project));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated' }));
  return { directory, config, project, output: join(directory, 'generated') };
}

it('builds owned validated assets from an isolated project and rebuilds them', async () => {
  const { config, output, project } = await fixture();
  const result = await buildAsset(config);
  expect(result.output).toBe(output);
  expect(result.files).toEqual(expect.arrayContaining(['project.mesh.json', 'model.glb', 'verification.json']));
  expect(JSON.parse(await readFile(join(output, 'project.mesh.json'), 'utf8'))).toEqual(project);
  expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
  const marker = JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8'));
  expect(marker.config).toBe('../build.json');
  expect(marker.files).toEqual(result.files);
  await buildAsset(config);
});

it('builds operations into a fresh project on each run', async () => {
  const { directory, config, output } = await fixture();
  await writeFile(join(directory, 'ops.json'), JSON.stringify([{ op: 'add', part: { name: 'body' } }]));
  await writeFile(config, JSON.stringify({ version: 1, name: 'recipe', operations: 'ops.json', output: 'generated' }));
  await buildAsset(config); await buildAsset(config);
  expect(JSON.parse(await readFile(join(output, 'project.mesh.json'), 'utf8')).parts).toHaveLength(1);
});

it('preserves the last good output when rendering fails and cleans staging files', async () => {
  const { directory, config, output } = await fixture();
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'preview.png'), 'partial'); throw new Error('render failed');
  } })).rejects.toThrow('render failed');
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['build.json', 'source.json', 'generated']));
  expect((await readdir(directory)).filter(name => name.includes('.stage-') || name.includes('.lock'))).toEqual([]);
});

it('refuses unowned directories and unexpected files in owned directories', async () => {
  const { config, output } = await fixture();
  await mkdir(output); await writeFile(join(output, 'personal.txt'), 'keep me');
  await expect(buildAsset(config)).rejects.toThrow(/owned|ownership/i);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('keep me');
  await rm(output, { recursive: true }); await buildAsset(config);
  await writeFile(join(output, 'personal.txt'), 'still keep me');
  await expect(buildAsset(config)).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('still keep me');
});

it('includes rendering artifacts only after the complete build succeeds', async () => {
  const { config, output } = await fixture();
  const result = await buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'preview.png'), 'rendered'); return ['preview.png'];
  } });
  expect(result.files).toContain('preview.png');
  expect(await readFile(join(output, 'preview.png'), 'utf8')).toBe('rendered');
});

it('prevents two builds from owning the same output concurrently', async () => {
  const { config } = await fixture();
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const first = buildAsset(config, { decorate: async () => { entered(); await gate; return []; } });
  await started;
  try { await expect(buildAsset(config)).rejects.toThrow(/locked|progress/i); }
  finally { resume(); await first; }
});

it('keeps ownership portable when a whole asset workspace moves', async () => {
  const { directory, config } = await fixture(); await buildAsset(config);
  const moved = `${directory}-moved`; directories.push(moved);
  await rename(directory, moved);
  await expect(buildAsset(join(moved, 'build.json'))).resolves.toMatchObject({ output: join(moved, 'generated') });
});

it('rejects source files under the output and ambiguous input configs', async () => {
  const { directory, config } = await fixture();
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: '.' }));
  await expect(buildAsset(config)).rejects.toThrow(/inside|contain/i);
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', operations: 'source.json', output: 'generated' }));
  await expect(buildAsset(config)).rejects.toThrow(/one|input|unrecognized/i);
});

it('refuses symlink outputs and symlinks added inside owned output', async () => {
  const { directory, config, output } = await fixture();
  const outside = join(directory, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'personal.txt'), 'keep');
  await symlink(outside, output, 'junction');
  await expect(buildAsset(config)).rejects.toThrow(/symlink/i);
  await rm(output); await buildAsset(config);
  await symlink(outside, join(output, 'foreign'), 'junction');
  await expect(buildAsset(config)).rejects.toThrow(/symlink/i);
  expect(await readFile(join(outside, 'personal.txt'), 'utf8')).toBe('keep');
});

it('resolves parent directory aliases so builds share ownership and locking', async () => {
  const { directory, config } = await fixture();
  const actualParent = join(directory, 'actual'); await mkdir(actualParent);
  await symlink(actualParent, join(directory, 'alias'), 'junction');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'alias/generated' }));
  const result = await buildAsset(config);
  expect(result.output).toBe(join(actualParent, 'generated'));
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'actual/generated' }));
  await expect(buildAsset(config)).resolves.toEqual(result);
});

it('preserves new unowned files created in the old output during rendering', async () => {
  const { config, output } = await fixture(); await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async () => {
    await writeFile(join(output, 'personal.txt'), 'new file'); return [];
  } })).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('new file');
});

it('rejects invalid artifact paths and unlisted decoration output before replacing an asset', async () => {
  const { config, output } = await fixture(); await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async () => ['../outside.txt'] })).rejects.toThrow(/unsafe/i);
  await expect(buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'unlisted.txt'), 'unexpected'); return [];
  } })).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
});
