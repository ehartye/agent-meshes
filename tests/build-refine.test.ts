import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAsset } from '../src/build.ts';
import { findBlender } from '../src/refine.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const operations = [
  { op: 'add', part: { name: 'body', geometry: { type: 'sphere', size: [0.4, 0.3, 0.6] }, position: [0, 0.5, 0], color: '#8a6f4e' } },
  { op: 'add', part: { name: 'head', geometry: { type: 'sphere', size: [0.22, 0.22, 0.24] }, position: [0, 0.78, 0.3], color: '#6b5238' } },
  { op: 'shell.set', shell: { name: 'bird', parts: ['body', 'head'], blend: 0.08, resolution: 32 } },
];

const maybe = findBlender() ? it : it.skip;

maybe('build runs the Blender refine stage when the config asks for it, and verifies the result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-build-refine-')); directories.push(directory);
  await writeFile(join(directory, 'ops.json'), JSON.stringify(operations));
  await writeFile(join(directory, 'plain.json'), JSON.stringify({ version: 1, name: 'plain', operations: 'ops.json', output: 'plain' }));
  await writeFile(join(directory, 'refined.json'), JSON.stringify({ version: 1, name: 'refined', operations: 'ops.json', output: 'refined', refine: { subdivide: 1, noise: 0.005, noiseScale: 0.05, only: ['bird'] } }));
  const plain = await buildAsset(join(directory, 'plain.json'));
  const refined = await buildAsset(join(directory, 'refined.json'));
  expect(refined.files).toContain('model.glb');
  const vertices = async (output: string) => { const gltf = await new GLTFLoader().parseAsync(new Uint8Array(await readFile(join(output, 'model.glb'))).slice().buffer, ''); let n = 0; gltf.scene.traverse(o => { if (o instanceof Mesh) n += o.geometry.getAttribute('position').count; }); return n; };
  expect(await vertices(refined.output)).toBeGreaterThan(await vertices(plain.output) * 2);
  const report = JSON.parse(await readFile(join(refined.output, 'verification.json'), 'utf8'));
  expect(report.errors).toBe(0);
}, 300000);

it('rejects a refine config when Blender is absent instead of building silently without it', async () => {
  if (findBlender()) return;
  const directory = await mkdtemp(join(tmpdir(), 'mesh-build-refine-')); directories.push(directory);
  await writeFile(join(directory, 'ops.json'), JSON.stringify(operations));
  await writeFile(join(directory, 'refined.json'), JSON.stringify({ version: 1, name: 'refined', operations: 'ops.json', output: 'refined', refine: { subdivide: 1 } }));
  await expect(buildAsset(join(directory, 'refined.json'))).rejects.toThrow(/Blender/);
});
