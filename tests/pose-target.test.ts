import { expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { createProject, applyOperation, validateProject } from '../src/core/model.ts';
import { applyPoseTarget } from '../src/core/pose-target.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Quat } from '../src/core/types.ts';

function fixture() {
  let p = createProject('Target fixture');
  const q = (axis: Vector3, angle: number) => new Quaternion().setFromAxisAngle(axis, angle).toArray() as Quat;
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'parent', position: [2, 1, -1], rotation: q(new Vector3(0, 1, 0), 0.4), pose: q(new Vector3(0, 0, 1), 0.25) } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'upper', parent: 'parent', position: [0.5, 1, 0], rotation: q(new Vector3(1, 0, 0), 0.3) } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'middle', parent: 'upper', position: [0, -1, 0], rotation: q(new Vector3(0, 1, 0), 0.2) } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'end', parent: 'middle', position: [0, -0.9, 0.2], pose: q(new Vector3(0, 0, 1), 0.1) } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'unrelated', position: [-2, 0, 0] } });
  return p;
}

it('poses a two-link chain to a world target under rotated/posed ancestors while preserving end orientation', () => {
  const p = fixture(), before = structuredClone(p), original = buildScene(p);
  const start = original.bones.get('upper')!.getWorldPosition(new Vector3());
  const orientation = original.bones.get('end')!.getWorldQuaternion(new Quaternion());
  const target = start.clone().add(new Vector3(0.4, -1.4, 0.3));
  applyPoseTarget(p, { op: 'pose.target', chain: ['upper', 'middle', 'end'], target: target.toArray(), pole: start.clone().add(new Vector3(0, 0, 2)).toArray() });
  const posed = buildScene(validateProject(p));
  try {
    expect(posed.bones.get('end')!.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(1e-7);
    expect(posed.bones.get('end')!.getWorldQuaternion(new Quaternion()).angleTo(orientation)).toBeLessThan(1e-7);
    expect(p.bones.find(b => b.name === 'parent')).toEqual(before.bones.find(b => b.name === 'parent'));
    expect(p.bones.find(b => b.name === 'unrelated')).toEqual(before.bones.find(b => b.name === 'unrelated'));
    expect(p.clips).toEqual(before.clips);
    for (const b of p.bones) expect(b.position).toEqual(before.bones.find(old => old.name === b.name)!.position);
  } finally { original.dispose(); posed.dispose(); }
});

it('rejects unreachable, degenerate and noncontiguous targets without partial pose mutation', () => {
  const p = fixture(), before = structuredClone(p);
  expect(() => applyPoseTarget(p, { op: 'pose.target', chain: ['upper', 'middle', 'end'], target: [100, 100, 100], pole: [0, 0, 0] })).toThrow(/unreachable/i);
  expect(p).toEqual(before);
  expect(() => applyPoseTarget(p, { op: 'pose.target', chain: ['parent', 'middle', 'end'], target: [0, 0, 0], pole: [1, 0, 0] })).toThrow(/direct|chain/i);
  const built = buildScene(p), start = built.bones.get('upper')!.getWorldPosition(new Vector3()); built.dispose();
  expect(() => applyPoseTarget(p, { op: 'pose.target', chain: ['upper', 'middle', 'end'], target: start.clone().add(new Vector3(0, -1, 0)).toArray(), pole: start.clone().add(new Vector3(0, -2, 0)).toArray() })).toThrow(/pole/i);
  expect(p).toEqual(before);
});

it('uses the pole to choose opposite bend sides without changing segment lengths', () => {
  const original = fixture(), built = buildScene(original), start = built.bones.get('upper')!.getWorldPosition(new Vector3()); built.dispose();
  const knees = [];
  for (const sign of [-1, 1]) {
    const p = structuredClone(original);
    applyPoseTarget(p, { op: 'pose.target', chain: ['upper', 'middle', 'end'], target: start.clone().add(new Vector3(0, -1.5, 0)).toArray(), pole: start.clone().add(new Vector3(0, 0, sign)).toArray() });
    const scene = buildScene(p);
    try {
      const knee = scene.bones.get('middle')!.getWorldPosition(new Vector3()); knees.push(knee);
      expect(knee.distanceTo(start)).toBeCloseTo(1, 7);
      expect(knee.z * sign - start.z * sign).toBeGreaterThan(0.3);
    } finally { scene.dispose(); }
  }
  expect(knees[0].distanceTo(knees[1])).toBeGreaterThan(0.6);
});
