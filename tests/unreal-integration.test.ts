import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractExpectations } from '../src/arkit-face.ts';
import { findUnreal, unrealAvailable, verifyUnreal } from '../src/unreal.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

// Real UnrealEditor-Cmd runs. Skipped where Unreal is absent (CI) or AGENT_MESHES_SKIP_UNREAL is set.
const runs = unrealAvailable() && !process.env.AGENT_MESHES_SKIP_UNREAL;
const maybe = runs ? it : it.skip;
// The heads below were recorded on UE 5.7.3. UE 5.8 imports an unskinned mesh in a skinned file as a StaticMesh, where 5.7 dropped it
// or merged it into the SkeletalMesh, so those tests are skipped on 5.8 and 5.8-specific tests pin what 5.8.2 does instead.
const engineVersion = runs ? findUnreal()?.version ?? '' : '';
const [engineMajor = 0, engineMinor = 0] = engineVersion.split('.').map(Number);
const onUE58 = engineMajor > 5 || (engineMajor === 5 && engineMinor >= 8);
const recordedOn57 = (title: string, reason: string, run: () => Promise<void>, timeout: number) => {
  if (runs && onUE58) console.info(`skipped on UE ${engineVersion}: "${title}": ${reason}`);
  return (runs && !onUE58 ? it : it.skip)(runs && onUE58 ? `${title} [skipped on UE ${engineVersion}: ${reason}]` : title, run, timeout);
};
const onlyOn58 = runs && onUE58 ? it : it.skip;
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const fixture = async (name: string, options?: Parameters<typeof arkitFaceFixtureGLB>[0]) => {
  const dir = await mkdtemp(join(tmpdir(), 'verify unreal ')); dirs.push(dir); // a space in the path on purpose
  const file = join(dir, name); await writeFile(file, arkitFaceFixtureGLB(options)); return file;
};
const contract = { ...contractExpectations('arkit-face/1'), requireSkeletalMesh: true, singleSkeletalMesh: true, contract: 'arkit-face/1', quiet: true };
// Blender heads from the face-rig acceptance bar's P9a evidence (round 2: good, head mesh left out of the skin, no skin at all).
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

// Round-3 heads from the face-rig acceptance bar's P9a evidence: eyeballs left out of the skin (derived, and built in Blender
// through `agent-meshes build` with the eyeballs not passed to bind_skin), eye bones not under head, two skins.
recordedOn57('fails, naming the unbound eyeball nodes, when Interchange silently drops eyeballs left out of the skin',
  'UE 5.8 imports eyeballs left out of the skin as StaticMeshes instead of dropping them (see the 5.8 test below)', async () => {
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

// Recorded on UE 5.8.2: the heads whose eyeball nodes have no skin. The SkeletalMesh holds only the head (1152 vertices); each eyeball is
// a StaticMesh of 1100 of its 1104 vertices, so no vertex is missing beyond the tolerance, and the contract still fails because a
// StaticMesh does not follow the eye bones.
onlyOn58('fails, naming the unbound eyeball nodes, when UE 5.8 imports them as separate StaticMeshes', async () => {
  for (const file of ['C-static-eyes.glb', 'bl3-staticeyes.glb', 'C2-static-eyes-parented-to-eye-bones.glb']) {
    const report = await verifyUnreal(head(file), contract);
    expect(report.summary).toMatchObject({ skeletalMeshes: 1, skeletons: 1, staticMeshes: 2 });
    expect(report.skeletalMeshes.map(m => m.vertices[0])).toEqual([1152]);
    expect(report.staticMeshes.map(m => m.path.split('/').pop()).sort()).toEqual(['Eyeball_L', 'Eyeball_R']);
    expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 3352, missing: 8, tolerance: 34, droppedByInterchange: [] });
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^the mesh nodes "Eyeball_L" \(1104 vertices\), "Eyeball_R" \(1104 vertices\) are not bound to the skin .* so Unreal imported them as separate StaticMeshes \("Eyeball_L", "Eyeball_R"\) and not as part of the SkeletalMesh\. A StaticMesh does not follow the rig's bones\./);
    expect(report.failures[0]).toMatch(/Fix: bind them to skin 0 "HeadRig"/);
    expect(report.failures[0]).toMatch(/weight each eyeball 100% to its eye bone/);
    // Under a joint (C2) the SkeletalMesh gets bones named after the eyeballs but no geometry for them.
    expect(/Parenting a node under a joint does not bind it: "Eyeball_L", "Eyeball_R" are under "eye_L", "eye_R", and Interchange gave the SkeletalMesh bones named "Eyeball_L", "Eyeball_R"/.test(report.failures[0])).toBe(file.startsWith('C2'));
  }
}, 40 * 60000);

maybe('passes a fresh Blender-built head, with every vertex imported', async () => {
  const report = await verifyUnreal(head('bl3-good.glb'), contract);
  expect(report.failures).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 3360, missing: 0 });
  expect(report.skeletalMeshes[0].boneParents).toMatchObject({ head: null, eye_L: 'head', eye_R: 'head' });
}, 40 * 60000);

recordedOn57('passes eyeballs parented to the eye bones, with every vertex imported',
  'UE 5.8 gives the SkeletalMesh bones for such eyeballs but keeps their geometry only in StaticMeshes (see the 5.8 test above)', async () => {
  const report = await verifyUnreal(head('C2-static-eyes-parented-to-eye-bones.glb'), contract);
  expect(report.failures).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.geometry).toMatchObject({ glbVertices: 3360, unrealVertices: 3360, missing: 0 });
  expect(report.skeletalMeshes[0].boneParents).toMatchObject({ head: null, eye_L: 'head', eye_R: 'head' });
}, 40 * 60000);

// Recorded on UE 5.8.2: its DefaultGLTFAssetsPipeline stores CombineSkeletalMeshesBehavior DoNotCombine, which imports each skinned
// mesh node as its own SkeletalMesh (the head and both eyeballs of bl-good.glb), so the verifier sets BySkeleton on its scratch copy.
onlyOn58('imports the Blender head as one SkeletalMesh because the verifier combines skeletal meshes by skeleton', async () => {
  const report = await verifyUnreal(head('bl-good.glb'), contract);
  expect(report.skeletalMeshGrouping).toEqual({ engineDefault: 'DO_NOT_COMBINE', applied: 'BY_SKELETON' });
  expect(report.failures).toEqual([]);
  expect(report.summary).toMatchObject({ skeletalMeshes: 1, skeletons: 1, staticMeshes: 0 });
  expect(report.skeletalMeshes[0].vertices).toEqual([3360]);
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
