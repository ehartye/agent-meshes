import { expect, it } from 'vitest';
import { Bone } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';

it('exports a rig with several root bones as a valid GLB with one common skeleton root', async () => {
  // A chair whose every rod has its own root bone: legal in the project, but glTF needs one common skeleton root.
  let p = createProject('chair');
  for (const [name, x] of [['a', -1], ['b', 0], ['c', 1]] as const) {
    p = applyOperation(p, { op: 'bone.add', bone: { name, position: [x, 1, 0] } });
    p = applyOperation(p, { op: 'add', part: { name: `rod_${name}`, position: [x, 1, 0], geometry: { type: 'box', size: [0.1, 1, 0.1] }, binding: { type: 'rigid', bone: name } } });
  }
  const bytes = await exportGLB(p);
  const report = await verifyGLB(bytes);
  expect(report.errors).toBe(0);
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
  const bones: Bone[] = []; gltf.scene.traverse(o => { if (o instanceof Bone) bones.push(o); });
  // The original bones keep their names and world positions; any added root sits at the origin.
  for (const [name, x] of [['a', -1], ['b', 0], ['c', 1]] as const) {
    const bone = bones.find(b => b.name === name)!;
    expect(bone.getWorldPosition(bone.position.clone()).toArray().map(v => +v.toFixed(6) + 0)).toEqual([x, 1, 0]);
  }
  const roots = bones.filter(b => !(b.parent instanceof Bone));
  expect(roots).toHaveLength(1);
  expect(['a', 'b', 'c']).not.toContain(roots[0].name);
});

it('does not add a root when the rig already has one', async () => {
  let p = createProject('one');
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'root', position: [0, 0, 0] } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'child', parent: 'root', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'x', position: [0, 1, 0], binding: { type: 'rigid', bone: 'child' } } });
  const gltf = await new GLTFLoader().parseAsync((await exportGLB(p)).slice().buffer, '');
  const bones: string[] = []; gltf.scene.traverse(o => { if (o instanceof Bone) bones.push(o.name); });
  expect(bones.sort()).toEqual(['child', 'root']);
});
