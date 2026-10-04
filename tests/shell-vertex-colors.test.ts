import { expect, it } from 'vitest';
import { Color } from 'three';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Project } from '../src/core/types.ts';

function shelled(shell: Record<string, unknown> = {}, colors: [string, string] = ['#f0e8d8', '#f0e8d8']): Project {
  let project = createProject('shelled');
  project = applyOperation(project, { op: 'add', part: { name: 'a', geometry: { type: 'sphere', size: [0.4, 0.4, 0.4] }, color: colors[0], position: [0, 0.2, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'b', geometry: { type: 'sphere', size: [0.3, 0.3, 0.3] }, color: colors[1], position: [0, 0.5, 0] } });
  return applyOperation(project, { op: 'shell.set', shell: { name: 'body', parts: ['a', 'b'], blend: 0.1, resolution: 24, ...shell } });
}
const attributes = async (project: Project) => {
  const { json } = readGLB(await exportGLB(project));
  const mesh = json.meshes![json.nodes!.find(n => n.name === 'body')!.mesh!];
  return { json, primitive: mesh.primitives[0], mesh };
};

it('bakes member colour and occlusion into vertex colours by default, as before', async () => {
  const { primitive } = await attributes(shelled());
  expect(Object.keys(primitive.attributes)).toContain('COLOR_0');
});

it('vertexColors false leaves COLOR_0 and the baked base out and puts the member colour on the material', async () => {
  const project = shelled({ vertexColors: false, material: { name: 'PieceWhite', metalness: 0, roughness: 0.5 } });
  const { json, primitive } = await attributes(project);
  expect(Object.keys(primitive.attributes).filter(name => name.includes('COLOR'))).toEqual([]);
  const material = json.materials![primitive.material!];
  expect(material.name).toBe('PieceWhite');
  const expected = new Color('#f0e8d8').toArray();
  material.pbrMetallicRoughness!.baseColorFactor!.slice(0, 3).forEach((value, i) => expect(value).toBeCloseTo(expected[i], 4));
  expect((await verifyGLB(await exportGLB(project))).ok).toBe(true);
});

it('shares the exported material between such a shell and a lathe part of the same colour and finish', async () => {
  let project = shelled({ vertexColors: false, material: { metalness: 0, roughness: 0.5 } });
  project = applyOperation(project, { op: 'add', part: { name: 'foot', geometry: { type: 'cylinder', size: [1, 0.1, 1] }, color: '#f0e8d8', material: { metalness: 0, roughness: 0.5 } } });
  const { json } = readGLB(await exportGLB(project));
  expect(json.materials).toHaveLength(1);
});

it('refuses vertexColors false when members differ in colour or a pattern needs vertex colours', () => {
  expect(() => shelled({ vertexColors: false }, ['#f0e8d8', '#202020'])).toThrow(/vertexColors/);
  expect(() => shelled({ vertexColors: false, pattern: { type: 'dots', color: '#ffffff', size: 0.1 } })).toThrow(/vertexColors/);
});
