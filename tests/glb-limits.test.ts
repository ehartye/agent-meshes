import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';
import { checkLimits, measureBounds } from '../src/glb-limits.ts';
import type { Project } from '../src/core/types.ts';

const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), 'mesh-limits-')); directories.push(directory); return directory; };
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 20000, windowsHide: true });
const half = Math.SQRT1_2;

/** A 1 m tall column standing on y=0, plus a bar lying across it: a part rotated 90 degrees about z, exported as a matrix node. */
function column(lift = 0.5): Project {
  let project = createProject('column');
  project = applyOperation(project, { op: 'add', part: { name: 'shaft', geometry: { type: 'cylinder', size: [0.4, 1, 0.4] }, position: [0, lift, 0], color: '#cccccc' } });
  project = applyOperation(project, { op: 'add', part: { name: 'bar', geometry: { type: 'box', size: [0.2, 0.2, 0.2] }, position: [0, lift, 0], rotation: [0, 0, half, half], scale: [1, 1, 1], color: '#cc0000' } });
  return project;
}

it('measures world-space bounds with node matrices applied, for a rotated part', async () => {
  let project = createProject('bar');
  // 1 x 0.2 x 0.2 box rotated 90 degrees about z stands 1 m tall: accessor min/max would say 0.2 tall.
  project = applyOperation(project, { op: 'add', part: { name: 'bar', geometry: { type: 'box', size: [1, 0.2, 0.2] }, position: [0, 0.5, 0], rotation: [0, 0, half, half] } });
  const bounds = measureBounds(await exportGLB(project));
  expect(bounds.size[1]).toBeCloseTo(1, 4);
  expect(bounds.size[0]).toBeCloseTo(0.2, 4);
  expect(bounds.yMin).toBeCloseTo(0, 4);
  expect(bounds.baseCenter[0]).toBeCloseTo(0, 4);
  expect(bounds.baseCenter[2]).toBeCloseTo(0, 4);
});

it('reports triangle, material and pivot violations with the measured values', async () => {
  const bytes = await exportGLB(column());
  const ok = checkLimits(bytes, { maxTriangles: 100000, maxMaterials: 2, expectPivot: 'bottom-center', expectHeight: 1 });
  expect(ok.ok).toBe(true);
  expect(ok.materials).toBe(2);
  expect(ok.checks.map(c => c.name)).toEqual(['maxTriangles', 'maxMaterials', 'expectPivot', 'expectHeight']);
  const bad = checkLimits(bytes, { maxTriangles: 10, maxMaterials: 1, expectPivot: 'center', expectHeight: 2, tolerance: 0.001 });
  expect(bad.ok).toBe(false);
  expect(bad.checks.filter(c => !c.ok).map(c => c.name)).toEqual(['maxTriangles', 'maxMaterials', 'expectPivot', 'expectHeight']);
  expect(bad.failures[0]).toMatch(/triangles/);
});

it('accepts a centred pivot and honours the tolerance', async () => {
  const centred = await exportGLB(column(0));
  expect(checkLimits(centred, { expectPivot: 'center' }).ok).toBe(true);
  expect(checkLimits(await exportGLB(column(0.5)), { expectPivot: 'bottom-center', tolerance: 0.6 }).ok).toBe(true);
  expect(checkLimits(await exportGLB(column(0.52)), { expectPivot: 'bottom-center', tolerance: 0.001 }).ok).toBe(false);
});

it('verify prints JSON limits and exits non-zero on a violation unless --warn-only', async () => {
  const file = join(await temp(), 'column.glb'); await writeFile(file, await exportGLB(column()));
  const pass = await cli('verify', file, '--max-triangles', '100000', '--expect-pivot', 'bottom-center', '--expect-height', '1');
  expect(JSON.parse(pass.stdout)).toMatchObject({ ok: true, limits: { ok: true, bounds: { yMin: expect.any(Number) } } });
  await expect(cli('verify', file, '--max-materials', '1')).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"limits"'), stderr: expect.stringContaining('materials') });
  const warned = await cli('verify', file, '--max-materials', '1', '--warn-only');
  expect(JSON.parse(warned.stdout).limits).toMatchObject({ ok: false, warnOnly: true });
}, 60000);

it('rejects a bad pivot name or limit before reading the file', async () => {
  await expect(cli('verify', 'missing.glb', '--expect-pivot', 'top')).rejects.toMatchObject({ stderr: expect.stringContaining('--expect-pivot') });
  await expect(cli('verify', 'missing.glb', '--max-triangles', '0')).rejects.toMatchObject({ stderr: expect.stringContaining('--max-triangles') });
}, 60000);

it('applies a build.json verify section to the final GLB, writes it to verification.json and fails the build on violation', async () => {
  const directory = await temp();
  await writeFile(join(directory, 'source.json'), JSON.stringify(column()));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', verify: { maxTriangles: 100000, maxMaterials: 2, expectPivot: 'bottom-center', expectHeight: 1 } }));
  const { output } = await buildAsset(config);
  const report = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(report.limits.ok).toBe(true);
  expect(report.limits.bounds.size[1]).toBeCloseTo(1, 4);
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', verify: { maxMaterials: 1 } }));
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'VERIFY_LIMITS_FAILED', message: expect.stringContaining('materials') });
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', verify: { maxMaterials: 1, warnOnly: true } }));
  const warned = JSON.parse(await readFile(join((await buildAsset(config)).output, 'verification.json'), 'utf8'));
  expect(warned.limits).toMatchObject({ ok: false, warnOnly: true });
}, 30000);
