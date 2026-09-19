import { it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
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
