import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOperation, createProject } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';

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
