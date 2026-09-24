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
// Blender heads from the talking-heads bar's P9a evidence (round 2: good, head mesh left out of the skin, no skin at all).
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
  expect(report.geometry?.missing).toBeLessThanOrEqual(report.geometry!.tolerance);
  expect(report.skeletalMeshes[0].boneParents).toEqual({ head: null, eye_L: 'head', eye_R: 'head' });
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
  expect(report.geometry).toEqual({ glbVertices: 3360, unrealVertices: 3360, missing: 0, tolerance: 34, droppedByInterchange: [] });
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
  // Without a skin the eyeballs become StaticMeshes; welding costs 4 of each eyeball's 1104 vertices, inside the tolerance.
  expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 3352, missing: 8, tolerance: 34 });
}, 40 * 60000);

// Round-3 heads from the talking-heads bar's P9a evidence: eyeballs left out of the skin (derived, and built in Blender
// through `agent-meshes build` with the eyeballs not passed to bind_skin), eye bones not under head, two skins.
maybe('fails, naming the unbound eyeball nodes, when Interchange silently drops eyeballs left out of the skin', async () => {
  for (const file of ['C-static-eyes.glb', 'bl3-staticeyes.glb']) {
    const report = await verifyUnreal(head(file), contract);
    expect(report.summary.staticMeshes).toBe(0);
    expect(report.skeletalMeshes.map(m => m.vertices[0])).toEqual([1152]);
    expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 1152, missing: 2208, droppedByInterchange: ['Eyeball_L', 'Eyeball_R'] });
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^Unreal imported 1152 of the GLB's 3360 vertices; 2208 are missing \(Unreal: SkeletalMesh "\w+" 1152, no StaticMesh\)\. Cause: the mesh nodes "Eyeball_L" \(1104 vertices\), "Eyeball_R" \(1104 vertices\) are not bound to the skin/);
    expect(report.failures[0]).toMatch(/Fix: bind them to skin 0 "HeadRig"/);
  }
}, 40 * 60000);

maybe('passes a fresh Blender-built head and eyeballs parented to the eye bones, with every vertex imported', async () => {
  for (const file of ['bl3-good.glb', 'C2-static-eyes-parented-to-eye-bones.glb']) {
    const report = await verifyUnreal(head(file), contract);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 3360, missing: 0 });
    expect(report.skeletalMeshes[0].boneParents).toMatchObject({ head: null, eye_L: 'head', eye_R: 'head' });
  }
}, 40 * 60000);

maybe('fails eye bones that are not children of head, read from Unreal\'s reference skeleton', async () => {
  const flat = await verifyUnreal(head('bl3-flat.glb'), contract);
  expect(flat.skeletalMeshes[0].boneParents).toEqual({ HeadRig_ProxyTrueRootJoint: null, eye_L: 'HeadRig_ProxyTrueRootJoint', eye_R: 'HeadRig_ProxyTrueRootJoint', head: 'HeadRig_ProxyTrueRootJoint' });
  expect(flat.failures).toEqual([expect.stringMatching(/^wrong bone hierarchy for the arkit-face\/1 contract: in SkeletalMesh "bl3_flat", "eye_L" is a child of "HeadRig_ProxyTrueRootJoint", not of "head"; "eye_R" is a child of "HeadRig_ProxyTrueRootJoint", not of "head"\. In the GLB, skin 0 "HeadRig" parents "eye_L" to "HeadRig" and "eye_R" to "HeadRig"/)]);
  const derived = await verifyUnreal(head('E-eyes-not-under-head.glb'), contract);
  expect(derived.failures).toEqual([expect.stringMatching(/^wrong bone hierarchy .*"HeadRig_ProxyTrueRootJoint" is the root Interchange adds/)]);
  const chained = await verifyUnreal(head('E2-eye_L-under-eye_R.glb'), contract);
  expect(chained.failures).toEqual([expect.stringMatching(/^wrong bone hierarchy for the arkit-face\/1 contract: in SkeletalMesh "E2_eye_L_under_eye_R", "eye_L" is a child of "eye_R", not of "head"\./)]);
}, 40 * 60000);

maybe('warns, without failing, when Unreal merged two skins into one correct SkeletalMesh', async () => {
  const report = await verifyUnreal(head('A-two-skins.glb'), contract);
  expect(report.failures).toEqual([]);
  expect(report.summary).toMatchObject({ skeletalMeshes: 1, skeletons: 1 });
  expect(report.warnings).toEqual([expect.stringMatching(/^pre-flight: the GLB binds its meshes to 2 skins .*the arkit-face\/1 contract asks for a single skin/)]);
}, 40 * 60000);
