import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const contract = { ...contractExpectations('arkit-face/1'), requireSkeletalMesh: true, singleSkeletalMesh: true, contract: 'arkit-face/1', quiet: true };
// Blender heads from the talking-heads bar's P9a round-2 evidence: good, head mesh left out of the skin, no skin at all.
const head = (name: string) => fileURLToPath(new URL(`./fixtures/heads/${name}`, import.meta.url));

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
  expect(report.failures).toEqual(['missing morph target "jawOpen" (the GLB has no morph target with this name)', 'missing bone "eye_R" (the GLB has no skin joint with this name)']);
}, 40 * 60000);

maybe('keeps every name verbatim for face and teeth as two primitives of one glTF mesh (the portable layout)', async () => {
  const report = await verifyUnreal(await fixture('multi primitive head.glb', { layout: 'primitives' }), contract);
  expect(report.failures).toEqual([]);
  expect(report.preflight.morphNames?.issues).toEqual([]);
  expect(report.morphTargets).toEqual(expect.arrayContaining(contract.morphs));
  expect(report.morphTargets.some(n => /_MorphTarget$/.test(n))).toBe(false);
  expect(report.skeletalMeshes[0].materialSlots).toBe(2);
  expect(report.log.importWarnings.filter(w => /Duplicate morph target/.test(w))).toEqual([]);
}, 40 * 60000);

maybe('gives one clear failure, not a missing line per morph, when a morph name repeats across glTF meshes', async () => {
  const report = await verifyUnreal(await fixture('good head copy.glb', { layout: 'meshes' }), contract);
  expect(report.ok).toBe(false);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]).toMatch(/^Unreal renamed every morph target to <file>_mesh_<m>_<i>_MorphTarget \(for example "good_head_copy_mesh_0_0_MorphTarget"\)/);
  expect(report.failures[0]).toContain('"jawOpen" (mesh 0 "Face", mesh 1 "Teeth")');
  expect(report.failures[0]).toMatch(/one glTF mesh as separate primitives/);
  // Imported from a sanitized copy, so Interchange does not rename the names a second time.
  expect(report.log.importWarnings.filter(w => /Duplicate morph target/.test(w))).toEqual([]);
}, 40 * 60000);

maybe('reports only the import failure for a file Unreal cannot read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify unreal ')); dirs.push(dir);
  const file = join(dir, 'corrupt.glb'); await writeFile(file, 'this is not a GLB at all');
  const report = await verifyUnreal(file, contract);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]).toMatch(/^Unreal imported nothing/);
  expect(report.preflight.error).toMatch(/not a readable GLB/);
}, 40 * 60000);

maybe('passes the Blender head whose face, teeth, tongue and eyeballs share one skin', async () => {
  const report = await verifyUnreal(head('bl-good.glb'), contract);
  expect(report.failures).toEqual([]);
  expect(report.summary).toMatchObject({ skeletalMeshes: 1, skeletons: 1 });
}, 40 * 60000);

maybe('fails when the morph-bearing mesh is left out of the skin, so Unreal splits morphs and bones across two SkeletalMeshes', async () => {
  const report = await verifyUnreal(head('partialskin.glb'), contract);
  expect(report.summary).toMatchObject({ skeletalMeshes: 2, skeletons: 2 });
  expect(report.ok).toBe(false);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]).toMatch(/^no single SkeletalMesh carries the arkit-face\/1 contract: SkeletalMesh "Head_[0-9a-f]+" has 21 of the 21 morph targets, but its skeleton has only the bone "Head_[0-9a-f]+", while "head", "eye_L", "eye_R" are on SkeletalMesh "Eyeball_L"/);
  expect(report.failures[0]).toContain('Cause: the morph-bearing glTF mesh "Head" (node "Head") is not skinned');
}, 40 * 60000);

maybe('blames the missing skin, not bone spelling, for a head with no skin at all', async () => {
  const report = await verifyUnreal(head('bl-noskin.glb'), contract);
  expect(report.ok).toBe(false);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]).toMatch(/^missing bones "head", "eye_L", "eye_R": SkeletalMesh "Head" has only the bone "Head", which Interchange made up from the mesh node\. Cause: the GLB has no skin/);
  expect(report.failures[0]).not.toMatch(/names must survive verbatim/);
}, 40 * 60000);
