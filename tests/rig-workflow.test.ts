import { expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createProject, Editor } from '../src/core/model.ts';
import { capabilities, planOperations } from '../src/agent-contract.ts';
import { buildScene } from '../src/render/scene.ts';

it('discovers, composes, targets and undoes a complete mirrored limb in one batch', () => {
  const operations = [
    { op: 'bone.add', bone: { name: 'hip', position: [0.5, 1.5, 0] } },
    { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -0.6, 0.15] } },
    { op: 'bone.add', bone: { name: 'foot', parent: 'knee', position: [0, -0.6, -0.15] } },
    { op: 'add', part: { name: 'limbShell', position: [0.5, 1.2, 0.075], geometry: { type: 'capsule', size: [0.1, 0.6, 0.1] }, binding: { type: 'linear', bones: ['hip', 'knee'], axis: 'y', range: [-0.3, 0.3] } } },
    { op: 'assembly.copy', root: 'hip', prefix: 'right_', mirror: 'x' },
    { op: 'pose.target', chain: ['hip', 'knee', 'foot'], target: [0.6, 0.4, 0.2], pole: [0.5, 1, 1] },
  ];
  const base = createProject('Agent assembly'), planned = planOperations(base, operations);
  expect(capabilities().operations['assembly.copy']).toBeDefined();
  expect(capabilities().operations['pose.target']).toBeDefined();
  expect(planned.project.bones).toHaveLength(6); expect(planned.project.parts).toHaveLength(2);
  expect(planned.report.changes.bones.added).toContain('right_foot');
  const built = buildScene(planned.project);
  try { expect(built.bones.get('foot')!.getWorldPosition(new Vector3()).distanceTo(new Vector3(0.6, 0.4, 0.2))).toBeLessThan(1e-7); }
  finally { built.dispose(); }
  const editor = new Editor(base); editor.replace(planned.project);
  expect(editor.undo()).toEqual(base); expect(editor.redo()).toEqual(planned.project);
  expect(() => planOperations(planned.project, [{ op: 'assembly.copy', root: 'hip', prefix: 'right_' }])).toThrow(/collision|duplicate|already/i);
});
