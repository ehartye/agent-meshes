import { describe, it, expect } from 'vitest';
import { Editor, createProject, applyOperation, validateProject } from '../src/core/model.ts';
import { geometryFor } from '../src/geometry.ts';

function rig() {
  let p = applyOperation(createProject('rig'), { op: 'bone.add', bone: { name: 'hip' } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -1, 0] } });
  return applyOperation(p, { op: 'add', part: { name: 'leg' } });
}

describe('rig authoring', () => {
  it('upgrades legacy projects and persists named bones with defaults', () => {
    expect(validateProject({ version: 1, name: 'legacy', parts: [] }).bones).toEqual([]);
    const p = rig();
    expect(p.bones[0]).toEqual({ name: 'hip', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1] });
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('rejects cycles, dangling parents, duplicate names and part name collisions', () => {
    const p = rig();
    expect(() => applyOperation(p, { op: 'bone.update', name: 'hip', changes: { parent: 'knee' } })).toThrow(/cycle/i);
    expect(() => applyOperation(p, { op: 'bone.add', bone: { name: 'other', parent: 'missing' } })).toThrow(/parent/i);
    expect(() => applyOperation(p, { op: 'bone.add', bone: { name: 'hip' } })).toThrow(/duplicate/i);
    expect(() => applyOperation(p, { op: 'bone.add', bone: { name: 'leg' } })).toThrow(/name/i);
    expect(() => applyOperation(p, { op: 'add', part: { name: 'hip' } })).toThrow(/name/i);
    expect(() => applyOperation(p, { op: 'bone.remove', name: 'hip' })).toThrow(/child/i);
    expect(() => applyOperation(p, { op: 'bone.update', name: 'knee', changes: { rotation: [0, 0, 0, 0] } })).toThrow(/quaternion/i);
  });
  it('poses and resets bones while keeping undo atomic', () => {
    const editor = new Editor(rig());
    const rotation: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    editor.apply({ op: 'pose', name: 'knee', rotation });
    expect(editor.project.bones[1].pose).toEqual(rotation);
    expect(() => editor.apply({ op: 'pose', name: 'absent', rotation })).toThrow(/unknown/i);
    editor.apply({ op: 'pose.reset' });
    expect(editor.project.bones[1].pose).toEqual([0, 0, 0, 1]);
    editor.undo(); expect(editor.project.bones[1].pose).toEqual(rotation);
    editor.undo(); expect(editor.project.bones[1].pose).toEqual([0, 0, 0, 1]);
  });
  it('binds and unbinds parts and guards changes to their rest rig or geometry', () => {
    const initial = rig();
    const p = applyOperation(initial, { op: 'bind', name: 'leg', binding: { type: 'rigid', bone: 'knee' } });
    expect(initial.parts[0].binding).toBeUndefined();
    expect(p.parts[0].binding).toEqual({ type: 'rigid', bone: 'knee' });
    expect(() => applyOperation(p, { op: 'bone.remove', name: 'knee' })).toThrow(/unbind/i);
    expect(() => applyOperation(p, { op: 'bone.update', name: 'hip', changes: { position: [1, 0, 0] } })).toThrow(/unbind/i);
    expect(() => applyOperation(p, { op: 'update', name: 'leg', changes: { geometry: { type: 'sphere', size: [1, 1, 1], segments: 12 } } })).toThrow(/unbind/i);
    const free = applyOperation(p, { op: 'unbind', name: 'leg' });
    expect(free.parts[0].binding).toBeUndefined();
    expect(applyOperation(free, { op: 'bone.remove', name: 'knee' }).bones).toHaveLength(1);
    expect(() => applyOperation(initial, { op: 'bind', name: 'leg', binding: { type: 'rigid', bone: 'absent' } })).toThrow(/bone/i);
    const grouped = applyOperation(initial, { op: 'add', part: { name: 'assembly', geometry: { type: 'group' } } });
    expect(() => applyOperation(grouped, { op: 'bind', name: 'assembly', binding: { type: 'rigid', bone: 'hip' } })).toThrow(/group/i);
  });
  it('validates linear and explicit vertex influences', () => {
    const p = rig();
    const linear = { type: 'linear' as const, bones: ['hip', 'knee'] as [string, string], axis: 'y' as const, range: [-1, 0] as [number, number] };
    expect(applyOperation(p, { op: 'bind', name: 'leg', binding: linear }).parts[0].binding).toEqual(linear);
    expect(() => applyOperation(p, { op: 'bind', name: 'leg', binding: { ...linear, range: [1, 0] } })).toThrow();
    expect(() => applyOperation(p, { op: 'bind', name: 'leg', binding: { ...linear, bones: ['hip', 'hip'] } })).toThrow();
    const geometry = geometryFor(p.parts[0]);
    const weighted = { type: 'weights' as const, bones: ['hip', 'knee'], weights: Array.from({ length: geometry.getAttribute('position').count }, () => [0.2, 0.8]) };
    geometry.dispose();
    expect(applyOperation(p, { op: 'bind', name: 'leg', binding: weighted }).parts[0].binding).toEqual(weighted);
    for (const weights of [[[0, 0]], [[-1, 2]], [[0.5]], [[0.2, 0.2]], [[NaN, 1]]]) {
      expect(() => applyOperation(p, { op: 'bind', name: 'leg', binding: { ...weighted, weights } })).toThrow();
    }
  });
  it('rejects vertex weight counts that cannot render before changing editor state', () => {
    const editor = new Editor(rig());
    expect(() => editor.apply({ op: 'bind', name: 'leg', binding: { type: 'weights', bones: ['hip'], weights: [[1]] } })).toThrow(/vertex weight rows/i);
    expect(editor.project.parts[0].binding).toBeUndefined();
    expect(() => validateProject({ ...rig(), parts: [{ ...rig().parts[0], binding: { type: 'weights', bones: ['hip'], weights: [[1]] } }] })).toThrow(/weight/i);
  });
  it('caps skeletons at 256 bones', () => {
    const p = rig();
    const maxed = validateProject({ ...p, bones: Array.from({ length: 256 }, (_, i) => ({ ...p.bones[0], name: `bone${i}` })) });
    expect(() => applyOperation(maxed, { op: 'bone.add', bone: { name: 'overflow' } })).toThrow();
  });
  it('mirrors a subtree with reflected joint rotations and poses, preserving its external parent', () => {
    let p = rig();
    const q: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
    p = applyOperation(p, { op: 'bone.update', name: 'knee', changes: { position: [1, -1, 0], rotation: q } });
    p = applyOperation(p, { op: 'pose', name: 'knee', rotation: q });
    p = applyOperation(p, { op: 'bone.add', bone: { name: 'ankle', parent: 'knee', position: [0, -1, 0] } });
    const mirrored = applyOperation(p, { op: 'bone.mirror', name: 'knee', prefix: 'right.', axis: 'x' });
    expect(mirrored.bones.find(b => b.name === 'right.knee')).toEqual({ name: 'right.knee', parent: 'hip', position: [-1, -1, 0], rotation: [0.5, -0.5, -0.5, 0.5], pose: [0.5, -0.5, -0.5, 0.5] });
    expect(mirrored.bones.find(b => b.name === 'right.ankle')?.parent).toBe('right.knee');
    expect(p.bones).toHaveLength(3);
    expect(() => applyOperation(mirrored, { op: 'bone.mirror', name: 'knee', prefix: 'right.', axis: 'x' })).toThrow(/duplicate/i);
  });
});
