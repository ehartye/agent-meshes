import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { readGLB } from '../src/gltf-read.ts';
import { ARKIT_FACE_REQUIRED_MORPHS } from '../src/arkit-face.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Real Blender only: CI skips this, like the refine stage. Run it locally with Blender installed.
const maybe = findBlender() ? it : it.skip;

for (const fixture of ['test_head', 'test_robot', 'test_frog']) maybe(`the helper-authored ${fixture} builds through agent-meshes build and passes arkit-face/1`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-rig-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: fixture, blender: { script: resolve(`tests/fixtures/face-rig/${fixture}.py`) }, output: 'generated' }));
  const built = await buildAsset(config);
  const bytes = await readFile(join(built.output, 'model.glb'));
  const report = await verifyFaceContract(bytes);
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.measurements.eyes.L!.minLidClearance).toBeGreaterThanOrEqual(0.0005);
  expect(report.measurements.teeth.upperMove).toBe(0);
  // E3: the chin (the face's lowest point) drops by at least 10% of the face height; the upper lip stays.
  expect(report.measurements.chinDropRatio).toBeGreaterThanOrEqual(0.1);
  expect(report.measurements.upperLipMove).toBeLessThanOrEqual(0.0005);
  expect(report.measurements.mouthOpen!.hits.every(hit => /teeth|tongue|cavity/.test(hit))).toBe(true);
  // Oblique views (front, 3/4, above and below) never find the socket or the inside of the head, in any lid or
  // emotion state; lid follow moves the upper lid's edge visibly both ways (E2).
  for (const side of ['L', 'R'] as const) {
    expect(report.measurements.eyes[side]!.oblique).toMatchObject({ views: 15, leaks: 0 });
    expect(report.measurements.eyes[side]!.lidFollow!.up).toBeGreaterThanOrEqual(0.0015);
    expect(report.measurements.eyes[side]!.lidFollow!.down).toBeGreaterThanOrEqual(0.0015);
  }
  // Every file stays within E8's 3 MB, the eye holes' extra skin included.
  expect(bytes.length).toBeLessThan(3_000_000);

  const { json } = readGLB(bytes);
  const root = json.nodes![json.scenes![0].nodes![0]];
  expect(json.scenes![0].nodes).toHaveLength(1);
  expect((root.extras as { arkitFace: { contract: string; morphs: string[] } }).arkitFace).toMatchObject({ contract: 'arkit-face/1' });
  // Every morph-bearing part is one glTF mesh (Unreal keeps names only then); eyeballs stay separate.
  const morphMeshes = json.meshes!.filter(m => Array.isArray(m.extras?.targetNames));
  expect(morphMeshes.map(m => m.name)).toEqual(['face']);
  expect(morphMeshes[0].primitives.length).toBeGreaterThan(4);
  expect(ARKIT_FACE_REQUIRED_MORPHS.every(name => (morphMeshes[0].extras!.targetNames as string[]).includes(name))).toBe(true);
  for (const bone of ['head', 'eye_L', 'eye_R']) expect(json.nodes!.find(n => n.name === bone)?.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
  expect(json.nodes!.find(n => n.name === 'eye_L')!.translation![0]).toBeGreaterThan(0);
}, 600000);

maybe('the face-rig wrappers validate, join and export inside real Blender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-wrappers-')); directories.push(directory);
  const result = await authorGLB(resolve('tests/blender_face_fixture.py'), join(directory, 'model.glb'));
  const bytes = await readFile(result.output);
  const report = await verifyFaceContract(bytes);
  const passed = new Set(report.checks.filter(c => c.ok).map(c => c.id));
  for (const id of ['validator', 'skeleton', 'skinning', 'eyes', 'morph-names', 'rest-weights', 'morph-motion', 'inversion', 'lid-clearance', 'eye-oblique', 'materials', 'extras', 'exposed-teeth', 'puppet-jaw']) expect(passed, id).toContain(id);
  // The wrapper fixture has lower teeth only, so the teeth check names the missing upper row; its eyes sit behind an
  // uncut skin, so no lid edge shows to follow the gaze.
  expect(report.failures).toEqual([
    'lid-follow: eye_L: no eyeball shows down the middle of the eye at rest, so lid follow cannot be seen',
    'lid-follow: eye_R: no eyeball shows down the middle of the eye at rest, so lid follow cannot be seen',
    'teeth: no upper teeth found: name the mesh or material with "teeth" and "upper" (for example teeth_upper)',
    'upper-lip: skipped because no upper teeth mark the gum line',
    'mouth-open: skipped because the upper or lower teeth were not found',
  ]);
}, 600000);
