import { expect, it } from 'vitest';
import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { createPuppet } from '../src/render/puppet.ts';
import { previewGaze } from '../src/web/preview-gaze.ts';

function fixture() {
  const scene = new Group(), rig = new Group(); scene.add(rig);
  rig.userData.arkitFace = { contract: 'arkit-face/1', gaze: { yawMax: 25, pitchMax: 18 }, lidFollow: { up: .8, down: .35 } };
  const head = new Bone(); head.name = 'head'; rig.add(head);
  for (const side of ['L', 'R']) { const eye = new Bone(); eye.name = `eye_${side}`; eye.rotation.y = side === 'L' ? .5 : -.5; head.add(eye); }
  const geometry = new BoxGeometry();
  geometry.morphAttributes.position = ['eyeBlinkLeft', 'eyeWideLeft', 'eyeBlinkRight', 'eyeWideRight', 'jawOpen'].map(name => {
    const attr = new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3); attr.name = name; return attr;
  });
  const face = new Mesh(geometry, new MeshBasicMaterial()); face.name = 'face'; head.add(face);
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .4).toArray();
  const animations = [new AnimationClip('look', 1, [
    new QuaternionKeyframeTrack('head.quaternion', [0, 1], [0, 0, 0, 1, ...turn]),
    new NumberKeyframeTrack('face.morphTargetInfluences[0]', [0, 1], [0, 1]),
  ])];
  return { puppet: createPuppet({ scene, animations }), rig, animations };
}

function partialFixture() {
  const result = fixture();
  delete result.rig.userData.arkitFace;
  result.rig.userData.eyeGaze = { contract: 'eye-gaze/1', forward: '+Z', gaze: { yawMax: 14, pitchMax: 9 } };
  return result;
}

it('offers shared gaze on an explicitly declared partial sculpt without claiming the facial contract', () => {
  const { puppet, rig } = partialFixture();
  expect(rig.userData.arkitFace).toBeUndefined();
  const gaze = previewGaze(puppet); expect(gaze).not.toBeNull();
  expect(gaze!.limits).toEqual({ yaw: 14, pitch: 9 });
});

it('partial gaze offsets authored eye frames, preserving head motion, animated expressions and reset ownership', () => {
  const { puppet, animations } = partialFixture(), gaze = previewGaze(puppet);
  expect(gaze).not.toBeNull();
  puppet.play('look'); puppet.seek(.3); puppet.pause();
  const head = puppet.bone('head').quaternion.clone(), rest = puppet.bone('eye_L').quaternion.clone();
  const beforeTracks = animations.map(clip => clip.tracks.map(track => Array.from(track.values)));
  gaze!.set(14, 9); gaze!.update();
  const direction = new Vector3(0, 0, 1).applyQuaternion(rest.clone().invert().multiply(puppet.bone('eye_L').quaternion));
  expect(Math.atan2(direction.x, direction.z) * 180 / Math.PI).toBeCloseTo(14);
  expect(Math.asin(direction.y) * 180 / Math.PI).toBeCloseTo(9);
  expect(puppet.bone('head').quaternion.toArray()).toEqual(head.toArray());
  expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.3);
  expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(0); // No unrequested lid following on a partial sculpt.
  puppet.setMorph('face', 'jawOpen', .7); gaze!.reset();
  expect(puppet.bone('eye_L').quaternion.angleTo(rest)).toBeLessThan(1e-7);
  expect(puppet.getMorph('face', 'jawOpen')).toBe(.7);
  puppet.seek(.8); gaze!.update(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.8);
  expect(animations.map(clip => clip.tracks.map(track => Array.from(track.values)))).toEqual(beforeTracks);
});

it('refuses ambiguous declarations, unsupported eye frames and unsafe partial limits', () => {
  const { puppet, rig } = partialFixture(), declaration = rig.userData.eyeGaze;
  expect(previewGaze(puppet)).not.toBeNull();
  for (const forward of [undefined, '-Z', '+Y']) {
    declaration.forward = forward; expect(previewGaze(puppet)).toBeNull();
  }
  declaration.forward = '+Z';
  for (const value of [0, -1, 91, NaN, Infinity, true, '14', undefined]) {
    declaration.gaze.yawMax = value; expect(previewGaze(puppet)).toBeNull();
  }
  declaration.gaze.yawMax = 14;
  rig.userData.arkitFace = { contract: 'arkit-face/1', gaze: { yawMax: 25, pitchMax: 18 } };
  expect(previewGaze(puppet)).toBeNull(); delete rig.userData.arkitFace;
  const alien = new Group(); alien.userData.eyeGaze = declaration; puppet.root.add(alien);
  expect(previewGaze(puppet)).toBeNull(); puppet.root.remove(alien);
  rig.remove(puppet.bone('head')); puppet.root.add(puppet.bone('head'));
  expect(previewGaze(puppet)).toBeNull();
});

it('offers gaze only for one compatible face contract with two unambiguous eye bones', () => {
  const { puppet, rig } = fixture(); expect(previewGaze(puppet)?.limits).toEqual({ yaw: 25, pitch: 18 });
  rig.userData.arkitFace.gaze.yawMax = NaN; expect(previewGaze(puppet)).toBeNull();
  rig.userData.arkitFace.gaze.yawMax = 25;
  const duplicate = new Bone(); duplicate.name = 'eye_L'; puppet.root.add(duplicate); expect(previewGaze(puppet)).toBeNull();
  puppet.root.remove(duplicate); delete rig.userData.arkitFace; expect(previewGaze(puppet)).toBeNull();
});

it('offsets each authored eye frame, survives clip sampling and resets only gaze rotation', () => {
  const { puppet } = fixture(), gaze = previewGaze(puppet)!;
  puppet.setPose('head', { position: [0, .1, 0] }); puppet.setPose('eye_L', { scale: [1.1, 1, 1] });
  puppet.play('look'); puppet.seek(.5); puppet.pause();
  const rest = puppet.bone('eye_L').quaternion.clone(), head = puppet.bone('head').quaternion.clone();
  gaze.set(12, 8); puppet.sync();
  const local = new Vector3(0, 0, 1).applyQuaternion(rest.clone().invert().multiply(puppet.bone('eye_L').quaternion));
  expect(Math.atan2(local.x, local.z) * 180 / Math.PI).toBeCloseTo(12);
  expect(Math.asin(local.y) * 180 / Math.PI).toBeCloseTo(8);
  puppet.seek(.8); gaze.update(); expect(puppet.getPose('eye_L').rotation).not.toEqual([0, 0, 0]);
  gaze.reset(); puppet.seek(.5); puppet.sync();
  expect(puppet.bone('eye_L').quaternion.angleTo(rest)).toBeLessThan(1e-7);
  expect(puppet.bone('head').quaternion.angleTo(head)).toBeLessThan(1e-7);
  expect(puppet.getPose('head').position).toEqual([0, .1, 0]); expect(puppet.getPose('eye_L').scale).toEqual([1.1, 1, 1]);
});

it('composes lid follow with animated blink and explicit expressions, then restores their ownership', () => {
  const { puppet } = fixture(), gaze = previewGaze(puppet)!;
  puppet.play('look'); puppet.seek(.6); puppet.pause();
  gaze.set(0, -18); gaze.update(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.6);
  puppet.seek(.1); gaze.update(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.35);
  gaze.setMorph('eyeBlinkLeft', 1); gaze.setMorph('jawOpen', .7); gaze.set(0, 18); gaze.update();
  expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBe(1);
  expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(0); // A closed eye must stay closed when looking up.
  expect(puppet.getMorph('face', 'eyeWideRight')).toBeCloseTo(.8);
  gaze.reset(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBe(1); expect(puppet.getMorph('face', 'jawOpen')).toBe(.7);
  expect(puppet.getMorph('face', 'eyeWideRight')).toBe(0);
  puppet.seek(.9); gaze.update(); expect(puppet.getMorph('face', 'eyeBlinkRight')).toBe(0);
});

it('clamps gaze to contract limits and does not change playback or clip data', () => {
  const { puppet } = fixture(), gaze = previewGaze(puppet)!; puppet.play('look'); puppet.seek(.3);
  gaze.set(200, -200); expect(gaze.value).toEqual({ yaw: 25, pitch: -18 });
  expect(puppet.playing).toBe(true); expect(puppet.time).toBeCloseTo(.3);
  expect(() => gaze.set(NaN, 0)).toThrow(/finite/);
});

it('releases automatic lid overrides on reset so the next animated blink still plays', () => {
  const { puppet } = fixture(), gaze = previewGaze(puppet)!;
  puppet.play('look'); puppet.seek(.1); gaze.set(0, -18); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.35);
  gaze.reset(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.1);
  puppet.seek(.8); gaze.update(); expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.8);
});

it('preserves scripted morph setters and resetters while gaze is active', () => {
  const { puppet } = fixture(), gaze = previewGaze(puppet)!;
  puppet.play('look'); puppet.pause(); puppet.seek(.2); gaze.set(0, 18);
  puppet.setMorph('face', 'eyeBlinkLeft', 1); gaze.update();
  expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBe(1); expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(0);
  puppet.resetMorph('face', 'eyeBlinkLeft'); gaze.update();
  expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.2);
  expect(puppet.getMorph('face', 'eyeWideLeft')).toBeCloseTo(.64);
  gaze.setMorph('eyeBlinkLeft', .7); puppet.resetMorph('face'); gaze.update();
  expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBeCloseTo(.2);
  gaze.reset(); expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(0);
});

it('follows the face skin beside its rig, leaving unrelated morph owners unchanged', () => {
  const { puppet: original } = fixture(), scene = original.root, oldFace = original.object('face');
  oldFace.removeFromParent();
  const geometry = oldFace.geometry.clone(), count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 ? 0 : 1), 4));
  const face = new SkinnedMesh(geometry, oldFace.material); face.name = 'face'; scene.add(face);
  face.bind(new Skeleton(['head', 'eye_L', 'eye_R'].map(name => original.bone(name))));
  const unrelated = new Mesh(oldFace.geometry, oldFace.material); unrelated.name = 'unrelated'; scene.add(unrelated);
  const puppet = createPuppet({ scene, animations: [] }), gaze = previewGaze(puppet)!;
  gaze.set(0, 18); expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(.8);
  expect(puppet.getMorph('unrelated', 'eyeWideLeft')).toBe(0);
  gaze.dispose(); expect(puppet.getMorph('face', 'eyeWideLeft')).toBe(0);
});

it('rejects invalid derived weights and recovers when the layer is disposed', () => {
  const { puppet } = fixture();
  const invalidWeights: Record<string, number>[] = [{ jawOpen: NaN }, { unknown: 1 }];
  for (const weights of invalidWeights) {
    const layer = puppet.addMorphTransform('face', () => weights);
    expect(() => puppet.sync()).toThrow(/finite|Unknown derived morph/);
    layer.dispose(); expect(puppet.getMorph('face', 'jawOpen')).toBe(0);
  }
});
