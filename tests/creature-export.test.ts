import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimationMixer, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createCreature, creatureKinds } from '../src/recipes/index.ts';
import { validateProject } from '../src/core/model.ts';
import { loadProject, saveProject } from '../src/storage.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildScene, disposeScene } from '../src/render/scene.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function worldVertex(mesh: SkinnedMesh, index: number): Vector3 {
  return mesh.applyBoneTransform(index, new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), index)).applyMatrix4(mesh.matrixWorld);
}

for (const kind of creatureKinds) it(`${kind} survives save/reopen and exports the same animated world geometry`, async () => {
  const source = createCreature(kind);
  const directory = await mkdtemp(join(tmpdir(), `agent-meshes-${kind}-`)); directories.push(directory);
  const path = join(directory, 'creature.mesh.json');
  await saveProject(path, source);
  const reopened = await loadProject(path);
  expect(reopened).toEqual(source);
  expect(validateProject(JSON.parse(JSON.stringify(reopened)))).toEqual(source);
  const bytes = await exportGLB(reopened), report = await verifyGLB(bytes);
  expect(report.errors).toBe(0); expect(report.warnings).toBe(0);
  const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  const built = buildScene(reopened);
  try {
    expect(loaded.animations.map(clip => clip.name)).toEqual(source.clips.map(clip => clip.name));
    const names = source.parts.filter(part => part.binding && (/_upper$|_shin$|_foot$/.test(part.name) || part.binding.type === 'linear')).map(part => part.name);
    const selected = [...new Set([source.parts[0].name, ...names.slice(0, 10)])];
    const originalMixer = new AnimationMixer(built.root), exportedMixer = new AnimationMixer(loaded.scene);
    originalMixer.clipAction(built.clips[0]).play(); exportedMixer.clipAction(loaded.animations[0]).play();
    const duration = source.clips[0].duration;
    let maxMotion = 0;
    const initial = new Map<string, Vector3[]>();
    for (const phase of [0, 0.17, 0.35, 0.58, 0.81, 1 - 1e-7]) {
      originalMixer.setTime(duration * phase); exportedMixer.setTime(duration * phase);
      built.root.updateMatrixWorld(true); loaded.scene.updateMatrixWorld(true);
      for (const name of selected) {
        const expected = built.root.getObjectByName(name) as SkinnedMesh;
        const actual = loaded.scene.getObjectByName(name) as SkinnedMesh;
        expect(actual.isSkinnedMesh).toBe(true);
        const count = expected.geometry.getAttribute('position').count;
        if (phase === 0) initial.set(name, Array.from({ length: count }, (_, index) => worldVertex(actual, index)));
        for (let index = 0; index < count; index++) {
          const wanted = worldVertex(expected, index), received = worldVertex(actual, index);
          expect(received.distanceTo(wanted)).toBeLessThan(1e-5);
          maxMotion = Math.max(maxMotion, received.distanceTo(initial.get(name)![index]));
          if (phase > 0.99) expect(received.distanceTo(initial.get(name)![index])).toBeLessThan(1e-5);
        }
      }
    }
    expect(maxMotion).toBeGreaterThan(0.05);
    expect(reopened).toEqual(source);
  } finally { built.dispose(); disposeScene(loaded.scene); }
});
