import { expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Operation } from '../src/core/types.ts';

const kit = (operations: Operation[]) => operations.reduce(applyOperation, createProject('hull-dart'));
const parts: Operation[] = [
  { op: 'add', part: { name: 'body', geometry: { type: 'box', size: [1, 1, 2] } } },
  { op: 'add', part: { name: 'socket_engine', geometry: { type: 'group' }, position: [0, 0, -1] } },
  { op: 'add', part: { name: 'fin', geometry: { type: 'prism', size: [0.1, 0.5, 0.6], outline: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] }, position: [0, 0.6, 0] } },
];
/** Each mesh node's name next to the name of the glTF mesh it draws. */
const pairs = (bytes: Uint8Array) => { const { json } = readGLB(bytes); return json.nodes!.filter(n => n.mesh !== undefined).map(n => [n.name, json.meshes![n.mesh!].name]); };

it('names every glTF mesh after its part, under one wrapper root named after the project', async () => {
  const bytes = await exportGLB(kit(parts));
  expect(pairs(bytes)).toEqual([['body', 'body'], ['fin', 'fin']]);
  const { json } = readGLB(bytes);
  const scene = json.scenes![json.scene ?? 0];
  expect(scene.nodes).toHaveLength(1);
  const root = json.nodes![scene.nodes![0]];
  expect(root.name).toBe('hull-dart');
  expect(root.children!.map(i => json.nodes![i].name)).toEqual(['body', 'socket_engine', 'fin']);
  expect(json.nodes!.find(n => n.name === 'socket_engine')!.mesh).toBeUndefined();
  expect((await verifyGLB(bytes)).ok).toBe(true);
});

it('names skinned parts, shells and a merged mesh too', async () => {
  const rigged = kit([...parts, { op: 'bone.add', bone: { name: 'root' } }, { op: 'bind', name: 'fin', binding: { type: 'rigid', bone: 'root' } }]);
  expect(pairs(await exportGLB(rigged))).toEqual(expect.arrayContaining([['fin', 'fin'], ['body', 'body']]));
  const shelled = kit([...parts, { op: 'shell.set', shell: { name: 'hull', parts: ['body', 'fin'], blend: 0.05, resolution: 16 } }]);
  expect(pairs(await exportGLB(shelled))).toEqual([['hull', 'hull']]);
  expect(pairs(await exportGLB(kit(parts), { merge: 'byMaterial' }))).toEqual([['hull-dart', 'hull-dart']]);
});
