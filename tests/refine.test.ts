import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mesh, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { findBlender, refineGLB } from '../src/refine.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function project() {
  let p = createProject('refine');
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'hip', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -0.5, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'thigh', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.75, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'hip' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'shin', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.25, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'knee' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'hat', geometry: { type: 'sphere', size: [0.3, 0.3, 0.3] }, position: [0, 1.5, 0], color: '#cc3333' } });
  return applyOperation(p, { op: 'clip.set', clip: { name: 'kick', duration: 1, tracks: [{ bone: 'knee', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0.7071068, 0, 0, 0.7071068] }, { time: 1, value: [0, 0, 0, 1] }] }] } });
}

const blender = findBlender();
const maybe = blender ? it : it.skip;

it('reports whether Blender is available without throwing', () => {
  expect(blender === null || typeof blender.command === 'string').toBe(true);
});

maybe('subdivides a GLB in Blender while keeping bones, skins, clips and validity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-refine-')); directories.push(directory);
  const input = join(directory, 'in.glb'), output = join(directory, 'out.glb');
  await writeFile(input, await exportGLB(project()));
  const before = await new GLTFLoader().parseAsync((await exportGLB(project())).slice().buffer, '');
  const result = await refineGLB(input, output, { subdivide: 1 });
  expect(result.meshes).toBeGreaterThanOrEqual(3);
  expect(result.bytes).toBeGreaterThan(0);
  const bytes = new Uint8Array(await (await import('node:fs/promises')).readFile(output));
  expect((await verifyGLB(bytes)).errors).toBe(0);
  const after = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
  const count = (scene: typeof after.scene) => { let vertices = 0, skinned = 0; scene.traverse(o => { if (o instanceof Mesh) vertices += o.geometry.getAttribute('position').count; if (o instanceof SkinnedMesh) skinned++; }); return { vertices, skinned }; };
  expect(count(after.scene).vertices).toBeGreaterThan(count(before.scene).vertices * 2);
  expect(count(after.scene).skinned).toBe(2);
  expect(after.animations.map(a => a.name)).toEqual(['kick']);
  const bones: string[] = []; after.scene.traverse(o => { if ((o as { isBone?: boolean }).isBone) bones.push(o.name); });
  expect(bones.sort()).toEqual(['hip', 'knee']);
}, 240000);
