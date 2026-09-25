import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { ARKIT_FACE_REQUIRED_MORPHS, contractExpectations } from '../src/arkit-face.ts';
import { unrealAvailable, verifyUnreal } from '../src/unreal.ts';

const directories: string[] = [];
// Each fixture's mouth line (glTF y) and half width.
const MOUTHS: Record<string, [number, number]> = { test_head: [0.075, 0.022], test_robot: [NaN, 0], test_frog: [0.088, 0.055], test_kid: [0.088, 0.021] };

/**
 * The steepest turn of the skin's shading normals (degrees per mm between vertices under 3 mm apart) in a band 15 mm
 * either side of the mouth line, across the cheeks beyond the lips: one continuous skin turns about 0.7 degree per mm
 * on these heads, while a sliver row cut beside a vertex a hair off the line turns 13-27.
 */
function mouthBandTurn(bytes: Uint8Array, mouthY: number, halfWidth: number): number {
  const doc = readGLB(bytes);
  const face = doc.json.meshes!.find(m => m.name === 'face')!;
  let worst = 0;
  for (const primitive of face.primitives) {
    if (!/skin/.test(doc.json.materials![primitive.material!].name ?? '')) continue;
    const P = readAccessor(doc, primitive.attributes.POSITION).data, N = readAccessor(doc, primitive.attributes.NORMAL).data;
    const band: number[] = [];
    for (let i = 0; i < P.length / 3; i++) if (P[i * 3 + 2] > 0.03 && Math.abs(P[i * 3 + 1] - mouthY) < 0.015 && Math.abs(P[i * 3]) > 1.5 * halfWidth) band.push(i);
    for (const i of band) for (const j of band) {
      const d = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
      if (d > 0.003 || d < 1e-6) continue;
      const cos = N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2];
      worst = Math.max(worst, Math.acos(Math.min(1, cos)) * 180 / Math.PI / (d * 1000));
    }
  }
  return worst;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Real Blender only: CI skips this, like the refine stage. Run it locally with Blender installed.
const maybe = findBlender() ? it : it.skip;

for (const fixture of ['test_head', 'test_robot', 'test_frog', 'test_kid']) maybe(`the helper-authored ${fixture} builds through agent-meshes build and passes arkit-face/1`, async () => {
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
  if (fixture === 'test_kid') {
    // Skin brows lie on the skin in every pose; the fused nose's wings lift visibly with noseSneer.
    const brows = report.measurements.attached.filter(part => /browDown/.test(part.part));
    expect(brows).toHaveLength(2);
    for (const brow of brows) expect(brow.gap).toBeLessThanOrEqual(0.0005);
    expect(report.measurements.morphMotion.noseSneerLeft).toBeGreaterThanOrEqual(0.002);
    // Skin paint survives join_face_parts and exports as COLOR_0 on the skin, which multiplies the base color.
    const doc = readGLB(bytes), face = doc.json.meshes!.find(m => m.name === 'face')!;
    const skin = face.primitives.find(p => doc.json.materials![p.material!].name === 'skin')!;
    expect(skin.attributes.COLOR_0).toBeDefined();
    const tint = readAccessor(doc, skin.attributes.COLOR_0);
    let darkest = 1;
    for (let i = 0; i < tint.count; i++) darkest = Math.min(darkest, tint.data[i * tint.size + 1]);
    expect(darkest).toBeLessThan(0.8);
  }
  // The skin shades as one surface across the mouth line: no sliver row beside the slit (a seam across the face).
  const [mouthY, halfWidth] = MOUTHS[fixture];
  if (Number.isFinite(mouthY)) expect(mouthBandTurn(bytes, mouthY, halfWidth)).toBeLessThan(5);
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

// Blender and Unreal both: export_glb stores morphs sparse (prune_glb_morphs), and Unreal must import every vertex.
const both = findBlender() && unrealAvailable() && !process.env.AGENT_MESHES_SKIP_UNREAL ? it : it.skip;
both('a helper-authored head with pruned, sparse morphs and skin paint imports into Unreal intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-unreal-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'test_kid', blender: { script: resolve('tests/fixtures/face-rig/test_kid.py') }, output: 'generated' }));
  const built = await buildAsset(config);
  const report = await verifyUnreal(join(built.output, 'model.glb'), { ...contractExpectations('arkit-face/1'), requireSkeletalMesh: true, singleSkeletalMesh: true, contract: 'arkit-face/1', quiet: true });
  expect(report.failures).toEqual([]);
  expect(report.geometry?.missing).toBeLessThanOrEqual(report.geometry!.tolerance);
  // The skin paint arrives as vertex colors, and Interchange's glTF material (M_Default, whose MF_BaseColor reads the
  // vertex color) multiplies the skin's base color by them.
  expect(report.skeletalMeshes[0].hasVertexColors).toBe(true);
  expect(report.skeletalMeshes[0].materials!.find(m => m?.name === 'skin')?.base).toBe('/InterchangeAssets/gltf/M_Default');
}, 40 * 60000);

maybe('a shutter eye in a well much wider than its lens keeps its housing out of oblique views', async () => {
  // Round 5: a housing cup 1.02 lens radii wide inside a 1.9-radius tube showed its outside past its rim at 35 degrees.
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-well-')); directories.push(directory);
  const source = await readFile(resolve('tests/fixtures/face-rig/test_robot.py'), 'utf8');
  const wide = source.replace('hole_radius=.018, aperture=.021', 'hole_radius=.03, aperture=.021');
  expect(wide).not.toBe(source);
  await writeFile(join(directory, 'robot_well.py'), wide);
  await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, name: 'robot_well', blender: { script: 'robot_well.py' }, output: 'generated' }));
  const built = await buildAsset(join(directory, 'build.json'));
  const report = await verifyFaceContract(await readFile(join(built.output, 'model.glb')));
  expect(report.failures).toEqual([]);
  for (const side of ['L', 'R'] as const) expect(report.measurements.eyes[side]!.oblique).toMatchObject({ leaks: 0 });
}, 600000);
