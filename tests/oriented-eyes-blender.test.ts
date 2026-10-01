import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';
import { Vector3, type Mesh, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createPuppet } from '../src/render/puppet.ts';

const maybe = findBlender() ? it : it.skip;
maybe('build_eye aligns its eyeball and skin targets with a side-set hole', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-oriented-eyes-'));
  try {
    const result = await authorGLB(resolve('tests/blender_oriented_eye_fixture.py'), join(directory, 'model.glb'));
    expect(result.meshes).toBe(2);
    const bytes = await readFile(join(directory, 'model.glb'));
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const puppet = createPuppet(gltf);
    const bone = puppet.bone('eye_L');
    const center = bone.getWorldPosition(new Vector3());
    const optical = () => {
      puppet.sync();
      let pupil: SkinnedMesh | undefined;
      puppet.root.traverse(object => {
        const mesh = object as Mesh;
        if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === 'eye_pupil') pupil = mesh as SkinnedMesh;
      });
      expect(pupil).toBeDefined();
      const mesh = pupil!;
      const indices = new Set(Array.from(mesh.geometry.index!.array));
      const average = new Vector3();
      for (const i of indices) average.add(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
      return average.divideScalar(indices.size).sub(center).normalize();
    };
    const forward = new Vector3(.5, 0, Math.sqrt(.75));
    expect(optical().distanceTo(forward)).toBeLessThan(1e-5);
    expect(new Vector3(0, 0, 1).transformDirection(bone.matrixWorld).distanceTo(forward)).toBeLessThan(1e-6);
    const desired = new Vector3(.3, .25, .9).normalize();
    puppet.aimBone('eye_L', center.clone().add(desired).toArray(), { maxYaw: 60, maxPitch: 60 });
    expect(optical().distanceTo(desired)).toBeLessThan(1e-5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 600000);
