import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { createPuppet } from '../src/render/puppet.ts';

function project() {
  let p = createProject('puppet');
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'hip', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -0.5, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'thigh', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.75, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'hip' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'shin', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.25, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'knee' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'hat', geometry: { type: 'sphere', size: [0.3, 0.3, 0.3] }, position: [0, 1.5, 0], color: '#cc3333', material: { metalness: 1, roughness: 0.1 } } });
  p = applyOperation(p, { op: 'clip.set', clip: { name: 'kick', duration: 1, tracks: [{ bone: 'knee', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0.7071068, 0, 0, 0.7071068] }, { time: 1, value: [0, 0, 0, 1] }] }] } });
  return p;
}
async function load() {
  const bytes = await exportGLB(project());
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
  return createPuppet(gltf);
}
const tip = (puppet: Awaited<ReturnType<typeof load>>) => puppet.bone('knee').localToWorld(new Vector3(0, -0.5, 0));

describe('puppet', () => {
  it('lists bones, visible parts and clips by name', async () => {
    const puppet = await load();
    expect(puppet.bones).toEqual(['hip', 'knee']);
    expect([...puppet.parts].sort()).toEqual(['hat', 'shin', 'thigh']);
    expect(puppet.clips).toEqual(['kick']);
    expect(puppet.duration).toBe(1);
  });

  it('poses a bone in degrees and reports the pose back', async () => {
    const puppet = await load();
    expect(tip(puppet).toArray().map(v => +v.toFixed(3))).toEqual([0, 0, 0]);
    puppet.setPose('knee', { rotation: [90, 0, 0] });
    const posed = tip(puppet);
    expect(Math.abs(posed.z)).toBeCloseTo(0.5, 3);
    expect(posed.y).toBeCloseTo(0.5, 3);
    expect(puppet.getPose('knee').rotation.map(Math.round)).toEqual([90, 0, 0]);
    puppet.setPose('hip', { position: [0.25, 0, 0] });
    expect(puppet.bone('hip').getWorldPosition(new Vector3()).x).toBeCloseTo(0.25, 6);
    puppet.resetPose();
    expect(tip(puppet).toArray().map(v => +v.toFixed(3))).toEqual([0, 0, 0]);
    expect(puppet.getPose('hip')).toEqual({ rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] });
  });

  it('scales a bone and everything it carries, and reports the scale back', async () => {
    const puppet = await load();
    puppet.setPose('knee', { scale: [1, 2, 1] });
    expect(tip(puppet).y).toBeCloseTo(-0.5, 3);
    expect(puppet.getPose('knee').scale).toEqual([1, 2, 1]);
    puppet.setPose('hip', { scale: [1, 1.5, 1] });
    // Child bone positions scale with the parent: the knee sits 0.75 below the hip, then its own doubled shin.
    expect(puppet.bone('knee').getWorldPosition(new Vector3()).y).toBeCloseTo(0.25, 3);
    expect(tip(puppet).y).toBeCloseTo(0.25 - 1.5, 3);
    puppet.resetPose('hip');
    expect(puppet.getPose('hip').scale).toEqual([1, 1, 1]);
    expect(puppet.bone('knee').getWorldPosition(new Vector3()).y).toBeCloseTo(0.5, 3);
    puppet.resetPose();
    expect(tip(puppet).y).toBeCloseTo(0, 3);
  });

  it('keeps a pose offset composed on top of clip playback', async () => {
    const puppet = await load();
    puppet.play('kick'); puppet.seek(0.5);
    const animatedOnly = puppet.bone('knee').quaternion.clone();
    puppet.setPose('knee', { rotation: [0, 0, 45] });
    const both = puppet.bone('knee').quaternion.clone();
    expect(both.angleTo(animatedOnly)).toBeCloseTo(Math.PI / 4, 3);
    puppet.seek(0);
    const restPlusOffset = puppet.bone('knee').quaternion.clone();
    expect(restPlusOffset.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 4, 3);
    puppet.resetPose();
    expect(puppet.bone('knee').quaternion.angleTo(new Quaternion())).toBeCloseTo(0, 6);
  });

  it('advances time only while playing and wraps at the clip end', async () => {
    const puppet = await load();
    expect(puppet.playing).toBe(false);
    puppet.play();
    expect(puppet.clip).toBe('kick');
    puppet.update(0.25); expect(puppet.time).toBeCloseTo(0.25, 6);
    puppet.pause(); puppet.update(0.25); expect(puppet.time).toBeCloseTo(0.25, 6);
    puppet.play(); puppet.update(0.9); expect(puppet.time).toBeCloseTo(0.15, 6);
    puppet.speed = 2; puppet.update(0.1); expect(puppet.time).toBeCloseTo(0.35, 6);
  });

  it('recolors one part without touching parts that shared its material', async () => {
    const puppet = await load();
    expect(puppet.getColor('thigh')).toBe('#3366cc');
    puppet.setColor('thigh', '#ffffff');
    expect(puppet.getColor('thigh')).toBe('#ffffff');
    expect(puppet.getColor('shin')).toBe('#3366cc');
    puppet.setVisible('hat', false);
    expect(puppet.object('hat').visible).toBe(false);
  });

  it('reads the exported finish and switches one part between matte and mirror without touching its neighbours', async () => {
    const puppet = await load();
    expect(puppet.getMaterial('hat')).toEqual({ metalness: 1, roughness: 0.1 });
    expect(puppet.getMaterial('thigh')).toEqual({ metalness: 0.08, roughness: 0.65 });
    puppet.setMaterial('thigh', { metalness: 1, roughness: 0.1 });
    expect(puppet.getMaterial('thigh')).toEqual({ metalness: 1, roughness: 0.1 });
    expect(puppet.getMaterial('shin')).toEqual({ metalness: 0.08, roughness: 0.65 });
    puppet.setMaterial('thigh', { roughness: 0.9 });
    expect(puppet.getMaterial('thigh')).toEqual({ metalness: 1, roughness: 0.9 });
    expect(() => puppet.setMaterial('thigh', { metalness: 2 })).toThrow(/0 to 1/);
    expect(() => puppet.getMaterial('wing')).toThrow(/Unknown part: wing/);
  });

  it('reports bounds from the posed skin, not the bind pose', async () => {
    const puppet = await load();
    const rest = puppet.bounds();
    expect(rest.min.y).toBeCloseTo(0, 2);
    puppet.setPose('knee', { scale: [1, 2, 1] });
    expect(puppet.bounds().min.y).toBeCloseTo(-0.5, 2);
    puppet.setPose('hip', { position: [0, 0, 1] });
    expect(puppet.bounds().max.z).toBeGreaterThan(1.05);
    puppet.resetPose();
    expect(puppet.bounds().min.y).toBeCloseTo(rest.min.y, 3);
  });

  it('rejects unknown names', async () => {
    const puppet = await load();
    expect(() => puppet.setPose('tail', { rotation: [1, 0, 0] })).toThrow(/Unknown bone: tail/);
    expect(() => puppet.setColor('wing', '#000000')).toThrow(/Unknown part: wing/);
    expect(() => puppet.play('dance')).toThrow(/Unknown clip: dance/);
  });
});
