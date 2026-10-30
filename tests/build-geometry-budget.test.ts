import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOperation, createProject } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';
import { wagClip, wagProject } from './helpers/clip-glb.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('writes opt-in UEFN warnings about the exported geometry without failing a valid build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-budget-build-')); directories.push(directory);
  const project = applyOperation(createProject('asset'), { op: 'add', part: { name: 'body' } });
  await writeFile(join(directory, 'source.json'), JSON.stringify(project));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', target: 'uefn', renderVertexBudget: 1 }));
  const { output } = await buildAsset(config);
  const report = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(report.ok).toBe(true);
  expect(report.geometryBudget.target).toBe('uefn');
  expect(report.geometryBudget.meshes[0].renderVertices).toBeGreaterThan(report.geometryBudget.meshes[0].positionVertices);
  expect(report.geometryBudget.warnings[0].code).toBe('RENDER_VERTEX_BUDGET_EXCEEDED');
});

it('rejects a warning budget without an explicit target before opening source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-budget-build-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'missing.json', output: 'generated', renderVertexBudget: 30000 }));
  await expect(buildAsset(config)).rejects.toThrow('renderVertexBudget requires an explicit target');
});

it('applies maxClips, maxTracks and maxKeys from the build.json verify section and names the offender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-budget-build-')); directories.push(directory);
  await writeFile(join(directory, 'source.json'), JSON.stringify(wagProject([wagClip('idle', { tailOnly: true }), wagClip('walk'), wagClip('run')])));
  const config = join(directory, 'build.json');
  const configure = (verify: object) => writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', verify }));
  await configure({ maxClips: 3, maxTracks: 2, maxKeys: 21 });
  const report = JSON.parse(await readFile(join((await buildAsset(config)).output, 'verification.json'), 'utf8'));
  expect(report.limits).toMatchObject({ ok: true, clips: [{ name: 'idle' }, { name: 'walk' }, { name: 'run' }] });
  await configure({ maxClips: 2 });
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'VERIFY_LIMITS_FAILED', message: expect.stringContaining('3 animation clips exceed the budget of 2 (idle, walk, run)') });
  await configure({ maxTracks: 1 });
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'VERIFY_LIMITS_FAILED', message: expect.stringContaining('clip "walk" has 2 tracks; the budget is 1 per clip') });
  await configure({ maxKeys: 10 });
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'VERIFY_LIMITS_FAILED', message: expect.stringContaining('clip "run" track root.translation has 21 keys; the budget is 10 per track') });
  await configure({ maxClips: 0 });
  await expect(buildAsset(config)).rejects.toThrow();
}, 30000);
