import { it, expect } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import { createProject, applyOperation, validateProject } from '../src/core/model.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Clip } from '../src/core/types.ts';
const swing: Clip = { name: 'swing', duration: 2, tracks: [{ bone: 'joint', property: 'rotation', keys: [
  { time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }, { time: 2, value: [0, 0, 0, 1] },
] }] };
it('plays a named clip on the actual bone and returns to its loop start', () => {
  let p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'clip.set', clip: swing });
  const built = buildScene(p), mixer = new AnimationMixer(built.root);
  mixer.clipAction(built.clips[0]).play(); mixer.setTime(1);
  expect(built.bones.get('joint')!.quaternion.z).toBeCloseTo(Math.SQRT1_2);
  mixer.setTime(2); expect(built.bones.get('joint')!.quaternion.z).toBeCloseTo(0);
  expect(validateProject(JSON.parse(JSON.stringify(p))).clips).toEqual(p.clips);
  built.dispose();
});
it('treats position keys as offsets from the bone rest position', () => {
  let p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint', position: [0, 2, 0] } });
  p = applyOperation(p, { op: 'clip.set', clip: { name: 'bob', duration: 2, tracks: [{ bone: 'joint', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0.2, 0] }, { time: 2, value: [0, 0, 0] }] }] } });
  const built = buildScene(p), mixer = new AnimationMixer(built.root); mixer.clipAction(built.clips[0]).play(); mixer.setTime(1);
  expect(built.bones.get('joint')!.position.distanceTo(new Vector3(0, 2.2, 0))).toBeLessThan(1e-6);
  built.dispose();
});
it('rejects malformed clips and protects referenced bones', () => {
  let p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint' } });
  for (const clip of [ { ...swing, duration: 0 }, { ...swing, tracks: [{ ...swing.tracks[0], bone: 'missing' }] }, { ...swing, tracks: [swing.tracks[0], swing.tracks[0]] }, { ...swing, tracks: [{ ...swing.tracks[0], keys: [{ time: 1, value: [0, 0, 0, 1] }, { time: 0, value: [0, 0, 0, 1] }] }] } ]) {
    expect(() => applyOperation(p, { op: 'clip.set', clip: clip as Clip })).toThrow();
  }
  p = applyOperation(p, { op: 'clip.set', clip: swing });
  expect(() => applyOperation(p, { op: 'bone.remove', name: 'joint' })).toThrow(/clip|animation|bone/i);
  p = applyOperation(p, { op: 'clip.remove', name: 'swing' });
  expect(applyOperation(p, { op: 'bone.remove', name: 'joint' }).bones).toHaveLength(0);
});
