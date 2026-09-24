import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractExpectations } from '../src/arkit-face.ts';
import { unrealAvailable, verifyUnreal } from '../src/unreal.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

// Real UnrealEditor-Cmd runs. Skipped where Unreal is absent (CI) or AGENT_MESHES_SKIP_UNREAL is set.
const maybe = unrealAvailable() && !process.env.AGENT_MESHES_SKIP_UNREAL ? it : it.skip;
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const fixture = async (name: string, options?: Parameters<typeof arkitFaceFixtureGLB>[0]) => {
  const dir = await mkdtemp(join(tmpdir(), 'verify unreal ')); dirs.push(dir); // a space in the path on purpose
  const file = join(dir, name); await writeFile(file, arkitFaceFixtureGLB(options)); return file;
};
const contract = { ...contractExpectations('arkit-face/1'), requireSkeletalMesh: true, contract: 'arkit-face/1', quiet: true };

maybe('imports an arkit-face GLB through Interchange with every morph and bone verbatim', async () => {
  const report = await verifyUnreal(await fixture('face fixture.glb'), contract);
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.summary.skeletalMeshes).toBe(1);
  expect(report.summary.skeletons).toBe(1);
  expect(report.morphTargets).toEqual(expect.arrayContaining(contract.morphs));
  expect(report.bones).toEqual(expect.arrayContaining(['head', 'eye_L', 'eye_R']));
  expect(report.skeletalMeshes[0].vertices[0]).toBeGreaterThan(0);
  expect(report.log.importErrors).toEqual([]);
  expect(report.log.interchangeCompleted).toBe(true);
}, 40 * 60000);

maybe('fails, listing what Unreal is missing, when the GLB breaks the contract', async () => {
  const morphs = contract.morphs.filter(n => n !== 'jawOpen');
  const report = await verifyUnreal(await fixture('broken.glb', { morphs, bones: ['head', 'eye_L'] }), contract);
  expect(report.ok).toBe(false);
  expect(report.failures).toEqual(['missing morph target "jawOpen"', 'missing bone "eye_R"']);
}, 40 * 60000);
