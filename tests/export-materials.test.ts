import { expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Project } from '../src/core/types.ts';

function pieces(): Project {
  let project = createProject('piece');
  const white = { name: 'PieceWhite', metalness: 0, roughness: 0.5 };
  project = applyOperation(project, { op: 'add', part: { name: 'base', geometry: { type: 'cylinder', size: [1, 0.2, 1] }, color: '#f0e8d8', material: white } });
  project = applyOperation(project, { op: 'add', part: { name: 'stem', geometry: { type: 'cylinder', size: [0.4, 1, 0.4] }, color: '#f0e8d8', material: white, position: [0, 0.6, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'head', geometry: { type: 'sphere', size: [0.6, 0.6, 0.6] }, color: '#f0e8d8', material: white, position: [0, 1.3, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'gem', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, color: '#cc2222', material: { name: 'Gem', metalness: 0.2, roughness: 0.2 }, position: [0, 1.7, 0] } });
  return project;
}

it('writes material names and shares one glTF material between identical parts', async () => {
  const bytes = await exportGLB(pieces());
  const { json } = readGLB(bytes);
  expect(json.materials!.map(m => m.name).sort()).toEqual(['Gem', 'PieceWhite']);
  const used = new Set(json.meshes!.flatMap(mesh => mesh.primitives.map(p => p.material)));
  expect(used.size).toBe(2);
  expect((await verifyGLB(bytes)).ok).toBe(true);
});

it('shares identical unnamed materials but never merges different colours or finishes', async () => {
  let project = createProject('plain');
  project = applyOperation(project, { op: 'add', part: { name: 'a', color: '#ff0000' } });
  project = applyOperation(project, { op: 'add', part: { name: 'b', color: '#ff0000' } });
  project = applyOperation(project, { op: 'add', part: { name: 'c', color: '#00ff00' } });
  project = applyOperation(project, { op: 'add', part: { name: 'd', color: '#ff0000', material: { roughness: 0.1 } } });
  const { json } = readGLB(await exportGLB(project));
  expect(json.materials).toHaveLength(3);
  expect(json.materials!.every(m => !m.name)).toBe(true);
});

it('keeps part names as nodes after dedup', async () => {
  const { json } = readGLB(await exportGLB(pieces()));
  expect(json.nodes!.map(n => n.name)).toEqual(expect.arrayContaining(['base', 'stem', 'head', 'gem']));
});

it('rejects an empty material name', () => {
  expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', material: { name: '' } } })).toThrow();
});
