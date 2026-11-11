/**
 * The helper-authored face fixtures, each built through `agent-meshes build` in a real Blender and held to arkit-face/1.
 * One build takes minutes, so the fixtures are spread over several test files that vitest runs side by side
 * (tests/face-rig-*-blender.test.ts); each file names the fixtures it owns.
 */
import { afterEach, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../../src/build.ts';
import { blenderIt } from './blender.ts';
import { verifyFaceContract } from '../../src/face-contract.ts';
import { readAccessor, readGLB } from '../../src/gltf-read.ts';
import { ARKIT_FACE_REQUIRED_MORPHS } from '../../src/arkit-face.ts';
import { lipCreaseStreak } from './lip-streak.ts';

export const FACE_RIG_FIXTURES = ['test_head', 'test_robot', 'test_frog', 'test_kid', 'test_lips_kid', 'test_lips_frog'] as const;
export type FaceRigFixture = typeof FACE_RIG_FIXTURES[number];

// Each fixture's mouth line (glTF y) and half width.
const MOUTHS: Record<string, [number, number]> = { test_head: [0.075, 0.022], test_robot: [NaN, 0], test_frog: [0.088, 0.055], test_kid: [0.088, 0.021], test_lips_kid: [0.088, 0.021], test_lips_frog: [0.083, 0.068] };
// Fixtures with soft lips (sculpt_lips): their crease must shade smoothly (round 6: a comb of streaks, 11-17 degrees).
const LIPS = new Set(['test_kid', 'test_lips_kid', 'test_lips_frog']);

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

/** Register the build-and-contract test of each named fixture in the calling test file. */
export function faceRigFixtureTests(fixtures: readonly FaceRigFixture[]): void {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
  for (const fixture of fixtures) blenderIt(`the helper-authored ${fixture} builds through agent-meshes build and passes arkit-face/1`, async () => {
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
    // One soft crease above each lid eye and at most the lid meeting the cheek below: no terraced socket (P1a round 8).
    // Plain faces (the kid, the frog's domes) do not fold below at all. Shutter eyes are not judged.
    for (const side of ['L', 'R'] as const) {
      const crease = report.measurements.eyes[side]!.crease!;
      if (fixture === 'test_robot') { expect(crease.skipped).toMatch(/shutter/); continue; }
      expect(crease.above).toBeLessThanOrEqual(1);
      expect(crease.below).toBeLessThanOrEqual(1);
      if (fixture === 'test_kid' || fixture === 'test_frog') expect(crease.below).toBe(0);
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
      // The lids are the skin (eye_hole's continuous default): no separate lid mesh parts; the lash line and the lining
      // inside the lids are paint on it (their own materials in the one face mesh).
      const materials = face.primitives.map(p => doc.json.materials![p.material!].name);
      expect(materials).toEqual(expect.arrayContaining(['skin', 'lash', 'eye_lining']));
      expect(materials).not.toContain('lid');
    }
    // The skin shades as one surface across the mouth line: no sliver row beside the slit (a seam across the face).
    const [mouthY, halfWidth] = MOUTHS[fixture];
    if (Number.isFinite(mouthY)) expect(mouthBandTurn(bytes, mouthY, halfWidth)).toBeLessThan(5);
    if (LIPS.has(fixture)) {
      const streak = lipCreaseStreak(bytes, mouthY, halfWidth);
      expect(streak.max).toBeLessThan(1.5);
      expect(streak.reversals).toBeLessThan(3);
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
}
