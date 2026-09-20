import { expect, it } from 'vitest';
import { AnimationMixer, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import type { Project } from '../src/core/types.ts';
import { buildScene } from '../src/render/scene.ts';

function animatedProject(): Project {
  let project = createProject('animated-arm');
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'shoulder' } });
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'elbow', parent: 'shoulder', position: [0, 1, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'arm', geometry: { type: 'box', size: [0.4, 2, 0.4] }, position: [0, 1, 0] } });
  project = applyOperation(project, { op: 'bind', name: 'arm', binding: { type: 'linear', bones: ['shoulder', 'elbow'], axis: 'y', range: [-0.5, 0.5] } });
  return { ...project, clips: [{ name: 'bend', duration: 1, tracks: [{ bone: 'elbow', property: 'rotation' as const, keys: [
    { time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }, { time: 1, value: [0, 0, 0, 1] },
  ] }] }] };
}

it('exports valid skinning and animation that deform vertices in an independent GLTFLoader', async () => {
  const project = animatedProject();
  project.bones[1].pose = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const original = structuredClone(project);
  const bytes = await exportGLB(project);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF');
  const report = await verifyGLB(bytes);
  expect(report.errors).toBe(0);
  expect(report.warnings).toBe(0);
  expect(report.ok).toBe(true);
  expect(project).toEqual(original);
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  expect(gltf.animations.map(clip => clip.name)).toEqual(['bend']);
  const mesh = gltf.scene.getObjectByName('arm') as SkinnedMesh;
  expect(mesh.isSkinnedMesh).toBe(true);
  const positions = mesh.geometry.getAttribute('position');
  const vertexIndex = Array.from({ length: positions.count }, (_, i) => i).find(i => positions.getY(i) > 0.9)!;
  const vertex = new Vector3().fromBufferAttribute(positions, vertexIndex);
  gltf.scene.updateMatrixWorld(true);
  expect(mesh.applyBoneTransform(vertexIndex, vertex.clone()).distanceTo(vertex)).toBeLessThan(1e-5);
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play(); mixer.setTime(0.5); gltf.scene.updateMatrixWorld(true);
  expect(gltf.scene.getObjectByName('elbow')!.quaternion.z).toBeCloseTo(Math.SQRT1_2);
  expect(mesh.applyBoneTransform(vertexIndex, vertex.clone()).distanceTo(vertex)).toBeGreaterThan(0.8);
});

it('preserves animated world vertices and static descendants under transformed parents without skin warnings', async () => {
  let project = animatedProject();
  project = applyOperation(project, { op: 'add', part: { name: 'assembly', geometry: { type: 'group' }, position: [2, 3, -1], rotation: [0, Math.sin(0.3), 0, Math.cos(0.3)], scale: [1.4, 0.8, 1.2] } });
  project = applyOperation(project, { op: 'update', name: 'arm', changes: { parent: 'assembly', rotation: [Math.sin(0.2), 0, 0, Math.cos(0.2)], scale: [0.9, 1.1, 1.3] } });
  project = applyOperation(project, { op: 'add', part: { name: 'badge', parent: 'arm', position: [0.2, 0.7, 0], rotation: [0, 0, Math.sin(0.4), Math.cos(0.4)] } });
  project.bones[0].position = [0.2, -0.1, 0.3];
  project.bones[0].rotation = [0, Math.sin(0.2), 0, Math.cos(0.2)];
  const original = structuredClone(project);
  const built = buildScene(project);
  try {
    const bytes = await exportGLB(project);
    const report = await verifyGLB(bytes);
    expect(report.errors).toBe(0); expect(report.warnings).toBe(0);
    const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
    const expected = built.root.getObjectByName('arm') as SkinnedMesh;
    const actual = loaded.scene.getObjectByName('arm') as SkinnedMesh;
    expect(actual.parent).toBe(loaded.scene);
    expect(actual.position.toArray()).toEqual([0, 0, 0]);
    expect(actual.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(actual.scale.toArray()).toEqual([1, 1, 1]);
    const expectedMixer = new AnimationMixer(built.root), actualMixer = new AnimationMixer(loaded.scene);
    expectedMixer.clipAction(built.clips[0]).play(); actualMixer.clipAction(loaded.animations[0]).play();
    for (const time of [0, 0.25, 0.5, 0.75]) {
      expectedMixer.setTime(time); actualMixer.setTime(time);
      built.root.updateMatrixWorld(true); loaded.scene.updateMatrixWorld(true);
      for (let index = 0; index < expected.geometry.getAttribute('position').count; index++) {
        const wanted = expected.applyBoneTransform(index, new Vector3().fromBufferAttribute(expected.geometry.getAttribute('position'), index)).applyMatrix4(expected.matrixWorld);
        const received = actual.applyBoneTransform(index, new Vector3().fromBufferAttribute(actual.geometry.getAttribute('position'), index)).applyMatrix4(actual.matrixWorld);
        expect(received.distanceTo(wanted)).toBeLessThan(2e-6);
      }
      const expectedBadge = built.root.getObjectByName('badge') as Mesh, actualBadge = loaded.scene.getObjectByName('badge') as Mesh;
      for (let index = 0; index < expectedBadge.geometry.getAttribute('position').count; index++) {
        const wanted = new Vector3().fromBufferAttribute(expectedBadge.geometry.getAttribute('position'), index).applyMatrix4(expectedBadge.matrixWorld);
        const received = new Vector3().fromBufferAttribute(actualBadge.geometry.getAttribute('position'), index).applyMatrix4(actualBadge.matrixWorld);
        expect(received.distanceTo(wanted)).toBeLessThan(2e-6);
      }
    }
    expect(project).toEqual(original);
  } finally { built.dispose(); }
});

it('carries part and shell metalness and roughness into the GLB as pbrMetallicRoughness factors', async () => {
  let project = createProject('koons');
  project = applyOperation(project, { op: 'add', part: { name: 'chrome', geometry: { type: 'sphere', size: [1, 1, 1] }, material: { metalness: 1, roughness: 0.1 } } });
  project = applyOperation(project, { op: 'add', part: { name: 'matte', position: [2, 0, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'a', position: [0, 3, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'b', position: [0.5, 3, 0] } });
  project = applyOperation(project, { op: 'shell.set', shell: { name: 'blob', parts: ['a', 'b'], blend: 0.3, resolution: 16, material: { metalness: 0.8, roughness: 0.2 } } });
  const bytes = await exportGLB(project);
  const report = await verifyGLB(bytes);
  expect(report.errors).toBe(0);
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  const finish = (name: string) => { const m = (gltf.scene.getObjectByName(name) as Mesh).material as MeshStandardMaterial; return { metalness: m.metalness, roughness: m.roughness }; };
  expect(finish('chrome')).toEqual({ metalness: 1, roughness: 0.1 });
  expect(finish('matte')).toEqual({ metalness: 0.08, roughness: 0.65 });
  expect(finish('blob')).toEqual({ metalness: 0.8, roughness: 0.2 });
});

it('supports simultaneous exports without FileReader races', async () => {
  const outputs = await Promise.all([exportGLB(animatedProject()), exportGLB(animatedProject())]);
  for (const output of outputs) expect((await verifyGLB(output)).ok).toBe(true);
});

it('reports malformed GLB instead of claiming verification passed', async () => {
  const report = await verifyGLB(new Uint8Array([1, 2, 3, 4]));
  expect(report.ok).toBe(false);
  expect(report.errors).toBeGreaterThan(0);
});
