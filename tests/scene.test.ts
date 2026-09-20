import { it, expect } from 'vitest';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { createProject, applyOperation } from '../src/core/model.ts';
import { buildScene } from '../src/render/scene.ts';
it('renders named mesh geometry at the intended dimensions and local hierarchy', () => {
  let p = applyOperation(createProject('model'), { op: 'add', part: { name: 'body', geometry: { type: 'group' }, position: [0, 3, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'head', parent: 'body', geometry: { type: 'box', size: [2, 1, 3] }, position: [0, 1, 0] } });
  const { root } = buildScene(p);
  root.updateMatrixWorld(true);
  const head = root.getObjectByName('head')!;
  expect(head.parent?.name).toBe('body');
  expect(head.getWorldPosition(new Vector3()).toArray()).toEqual([0, 4, 0]);
  expect(new Box3().setFromObject(head).getSize(new Vector3()).toArray()).toEqual([2, 1, 3]);
});
it('applies a part or shell material finish and keeps the default finish for parts without one', () => {
  let p = applyOperation(createProject('koons'), { op: 'add', part: { name: 'chrome', material: { metalness: 1, roughness: 0.1 } } });
  p = applyOperation(p, { op: 'add', part: { name: 'matte', position: [2, 0, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'a', position: [0, 3, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'b', position: [0.5, 3, 0] } });
  p = applyOperation(p, { op: 'shell.set', shell: { name: 'blob', parts: ['a', 'b'], blend: 0.3, resolution: 16, material: { metalness: 0.8, roughness: 0.2 } } });
  const { root, dispose } = buildScene(p);
  try {
    const finish = (name: string) => { const m = (root.getObjectByName(name) as Mesh).material as MeshStandardMaterial; return { metalness: m.metalness, roughness: m.roughness }; };
    expect(finish('chrome')).toEqual({ metalness: 1, roughness: 0.1 });
    expect(finish('matte')).toEqual({ metalness: 0.08, roughness: 0.65 });
    expect(finish('blob')).toEqual({ metalness: 0.8, roughness: 0.2 });
  } finally { dispose(); }
});
