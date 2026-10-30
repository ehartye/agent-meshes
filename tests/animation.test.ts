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
it('plays a key written by clip.key.set and a pose recorded by clip.key.record on the actual bone', () => {
  let p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'clip.create', name: 'nod', duration: 2 });
  p = applyOperation(p, { op: 'clip.key.set', name: 'nod', bone: 'joint', property: 'rotation', time: 1, value: [0, 0, 1, 1] });
  p = applyOperation(p, { op: 'clip.key.record', name: 'nod', time: 1.5, poses: [{ bone: 'joint', position: [0, 0.2, 0] }] });
  const built = buildScene(p), mixer = new AnimationMixer(built.root);
  mixer.clipAction(built.clips[0]).play(); mixer.setTime(1);
  expect(built.bones.get('joint')!.quaternion.z).toBeCloseTo(Math.SQRT1_2);
  mixer.setTime(1.5);
  expect(built.bones.get('joint')!.position.distanceTo(new Vector3(0, 1.2, 0))).toBeLessThan(1e-6);
  expect(validateProject(JSON.parse(JSON.stringify(p))).clips).toEqual(p.clips);
  built.dispose();
});
it('accepts positive scale tracks and rejects zero, negative or malformed scale values', () => {
  const p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint' } });
  const scaleClip = (value: number[]): Clip => ({ name: 'squash', duration: 1, tracks: [{ bone: 'joint', property: 'scale', keys: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: value as [number, number, number] }] }] });
  const accepted = applyOperation(p, { op: 'clip.set', clip: scaleClip([1, 0.05, 2.5]) });
  expect(accepted.clips[0].tracks[0].keys[1].value).toEqual([1, 0.05, 2.5]);
  expect(accepted.version).toBe(1);
  expect(validateProject(JSON.parse(JSON.stringify(accepted))).clips).toEqual(accepted.clips);
  for (const bad of [[1, 0, 1], [-1, 1, 1], [1, 1, -0.001], [0, 0, 0], [1, 1], [1, 1, 1, 1], [1, Number.NaN, 1]]) {
    expect(() => applyOperation(p, { op: 'clip.set', clip: scaleClip(bad) }), JSON.stringify(bad)).toThrow();
  }
  expect(() => applyOperation(p, { op: 'clip.set', clip: scaleClip([1, 0, 1]) })).toThrow(/Scale must be positive.*rest scale is \[1, 1, 1\]/);
  // One track per bone and property: a scale track sits beside a rotation and a position track on the same bone.
  const both = { ...scaleClip([2, 2, 2]), tracks: [...scaleClip([2, 2, 2]).tracks, { bone: 'joint', property: 'position' as const, keys: [{ time: 0, value: [0, 0, 0] as [number, number, number] }, { time: 1, value: [0, 1, 0] as [number, number, number] }] }] };
  expect(applyOperation(p, { op: 'clip.set', clip: both }).clips[0].tracks).toHaveLength(2);
  expect(() => applyOperation(p, { op: 'clip.set', clip: { ...both, tracks: [both.tracks[0], both.tracks[0]] } })).toThrow(/Duplicate track/);
});
it('plays a scale track as the absolute scale of the bone, leaving its position and rotation alone', () => {
  let p = applyOperation(createProject('animated'), { op: 'bone.add', bone: { name: 'joint', position: [0, 2, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } });
  p = applyOperation(p, { op: 'clip.set', clip: { name: 'pump', duration: 2, tracks: [{ bone: 'joint', property: 'scale', keys: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: [2, 0.5, 1] }, { time: 2, value: [1, 1, 1] }] }] } });
  const built = buildScene(p);
  try {
    expect(built.clips[0].tracks.map(track => track.name.replace(/^[^.]+\./, ''))).toEqual(['scale']);
    const mixer = new AnimationMixer(built.root); mixer.clipAction(built.clips[0]).play();
    const bone = built.bones.get('joint')!;
    expect(bone.scale.toArray()).toEqual([1, 1, 1]);
    mixer.setTime(1);
    expect(bone.scale.toArray()).toEqual([2, 0.5, 1]);
    expect(bone.position.toArray()).toEqual([0, 2, 0]);
    expect(bone.quaternion.z).toBeCloseTo(Math.SQRT1_2);
    mixer.setTime(0.5);
    expect(bone.scale.toArray()).toEqual([1.5, 0.75, 1]);
  } finally { built.dispose(); }
});
