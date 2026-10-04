import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';
import { auditGeometryBudget } from '../src/geometry-budget.ts';
import { measureBounds } from '../src/glb-limits.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Project } from '../src/core/types.ts';

const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), 'mesh-merge-')); directories.push(directory); return directory; };
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 20000, windowsHide: true });
const half = Math.SQRT1_2;

function chessPiece(): Project {
  let project = createProject('piece');
  const white = { name: 'PieceWhite', metalness: 0, roughness: 0.5 };
  project = applyOperation(project, { op: 'add', part: { name: 'group', geometry: { type: 'group' } } });
  project = applyOperation(project, { op: 'add', part: { name: 'base', parent: 'group', geometry: { type: 'cylinder', size: [1, 0.2, 1] }, position: [0, 0.1, 0], color: '#f0e8d8', material: white } });
  project = applyOperation(project, { op: 'add', part: { name: 'arm', parent: 'group', geometry: { type: 'box', size: [0.2, 0.2, 0.6] }, position: [0.2, 0.6, 0], rotation: [0, half, 0, half], color: '#f0e8d8', material: white } });
  project = applyOperation(project, { op: 'add', part: { name: 'gem', parent: 'group', geometry: { type: 'sphere', size: [0.2, 0.2, 0.2] }, position: [0, 0.9, 0], color: '#cc2222', material: { name: 'Gem', metalness: 0.2, roughness: 0.2 } } });
  return project;
}

it('fuses static parts into one mesh with one primitive per material, keeping geometry and bounds', async () => {
  const project = chessPiece();
  const separate = await exportGLB(project), merged = await exportGLB(project, { merge: 'byMaterial' });
  const { json } = readGLB(merged);
  expect(json.meshes).toHaveLength(1);
  expect(json.meshes![0].primitives).toHaveLength(2);
  expect(json.nodes!.filter(node => node.mesh !== undefined)).toHaveLength(1);
  expect(json.materials!.map(m => m.name).sort()).toEqual(['Gem', 'PieceWhite']);
  expect((await verifyGLB(merged)).ok).toBe(true);
  const a = measureBounds(separate), b = measureBounds(merged);
  for (let i = 0; i < 3; i++) { expect(b.min[i]).toBeCloseTo(a.min[i], 4); expect(b.max[i]).toBeCloseTo(a.max[i], 4); }
  expect(auditGeometryBudget(merged, { target: 'uefn' }).totals.triangles).toBe(auditGeometryBudget(separate, { target: 'uefn' }).totals.triangles);
});

it('refuses a model with skins, animation or morph-bearing bindings with MERGE_NOT_STATIC', async () => {
  let rigged = applyOperation(createProject('rigged'), { op: 'bone.add', bone: { name: 'spine' } });
  rigged = applyOperation(rigged, { op: 'add', part: { name: 'body' } });
  rigged = applyOperation(rigged, { op: 'bind', name: 'body', binding: { type: 'rigid', bone: 'spine' } });
  await expect(exportGLB(rigged, { merge: 'byMaterial' })).rejects.toMatchObject({ code: 'MERGE_NOT_STATIC', message: expect.stringContaining('body') });
  const animated: Project = { ...chessPiece(), bones: [{ name: 'root', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1] }],
    clips: [{ name: 'spin', duration: 1, tracks: [{ bone: 'root', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0, 1] }] }] }] };
  await expect(exportGLB(animated, { merge: 'byMaterial' })).rejects.toMatchObject({ code: 'MERGE_NOT_STATIC', message: expect.stringContaining('clip') });
});

it('leaves the default export unchanged: one node per named part', async () => {
  const { json } = readGLB(await exportGLB(chessPiece()));
  expect(json.nodes!.map(n => n.name)).toEqual(expect.arrayContaining(['base', 'arm', 'gem']));
});

it('merges through build.json and rejects an unknown mode or Blender input', async () => {
  const directory = await temp();
  await writeFile(join(directory, 'source.json'), JSON.stringify(chessPiece()));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', merge: 'byMaterial' }));
  const { output } = await buildAsset(config);
  expect(readGLB(new Uint8Array(await readFile(join(output, 'model.glb')))).json.meshes).toHaveLength(1);
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated', merge: 'everything' }));
  await expect(buildAsset(config)).rejects.toThrow();
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'x.py' }, output: 'generated', merge: 'byMaterial' }));
  await expect(buildAsset(config)).rejects.toThrow(/merge/);
}, 30000);

it('export --merge byMaterial writes the merged GLB from a workspace', async () => {
  const directory = await temp(), file = join(directory, 'ops.json'), out = join(directory, 'merged.glb');
  await writeFile(file, JSON.stringify([{ op: 'add', part: { name: 'a', color: '#ff0000' } }, { op: 'add', part: { name: 'b', color: '#ff0000', position: [2, 0, 0] } }]));
  await cli('--workspace', join(directory, 'ws'), 'new', 'two');
  await cli('--workspace', join(directory, 'ws'), 'batch', file);
  await cli('--workspace', join(directory, 'ws'), 'export', out, '--merge', 'byMaterial');
  const { json } = readGLB(new Uint8Array(await readFile(out)));
  expect(json.meshes).toHaveLength(1);
  await expect(cli('--workspace', join(directory, 'ws'), 'export', out, '--merge', 'nope')).rejects.toMatchObject({ stderr: expect.stringContaining('--merge') });
}, 60000);
