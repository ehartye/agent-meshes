// KNOWN RED, declared as an expected failure: the stylized character's face contract reports 7 failures, down from 29.
// What remains: the lids pass through each other from three quarters of a blink on (lid-penetration, one per eye:
// the hm08 lids overlap when closed and roll at one distance from the eye), the upper teeth's edge shows through the
// resting lips' crack (exposed-teeth), and the pocket's wall crosses the lip at full mouthFunnel
// (mouth-skin-intersection, 4). Each repair changes how the face looks and waits on the owner's choice.
// The strict assertion lives in its own `it.fails` test below, so the suite is green while the defects stand and
// turns red the day the contract passes, which is the signal to make it a plain test. The failures are ratcheted per
// contract check in the build test: a count may fall, never rise, and no other check may fail.
// Owner: the face programme (wiki item stylized-character-face-contract).
// Expiry: 2026-12-31. Fix it or re-justify it by then; do not loosen the assertion.
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { authorGLB } from '../src/author.ts';
import { blender, blenderGate, blenderIt } from './helpers/blender.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { contractExpectations } from '../src/arkit-face.ts';
import { unrealAvailable, verifyUnreal } from '../src/unreal.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Real Blender only: CI skips this, like the refine stage. Run it locally with Blender installed.
const maybe = blenderIt;

maybe('a coarse mouth slit reaches both authored corners without splitting them or folding under jaw motion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-mouth-corners-')); directories.push(directory);
  const result = await authorGLB(resolve('tests/blender_mouth_corner_fixture.py'), join(directory, 'model.glb'));
  expect(result.meshes).toBe(1);
}, 600000);


maybe('a face on a body skeleton (head under spine, add_eye_bones) builds and passes arkit-face/1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-body-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'test_body_face', blender: { script: resolve('tests/fixtures/face-rig/test_body_face.py') }, output: 'generated' }));
  const built = await buildAsset(config);
  const bytes = await readFile(join(built.output, 'model.glb'));
  const report = await verifyFaceContract(bytes);
  expect(report.failures).toEqual([]);
  expect(report.checks.find(c => c.id === 'skeleton')!.message).toMatch(/body skeleton \(head under spine\)/);
  const { json } = readGLB(bytes);
  const parent = (name: string) => json.nodes!.find(n => n.children?.some(c => json.nodes![c].name === name))?.name;
  expect([parent('eye_L'), parent('eye_R'), parent('head')]).toEqual(['head', 'head', 'spine']);
  expect(json.nodes!.find(n => n.name === 'eye_L')!.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
  // The chin is the face's, not the torso's below it.
  expect(report.measurements.chinDropRatio).toBeGreaterThanOrEqual(0.1);
}, 600000);

// The known-red failures by contract check. The inversion, attached-parts, head-binding and mouth-parts failures and
// 16 of the 20 mouth crossings that stood beside them are repaired and may not come back.
const KNOWN_RED_CHARACTER_FAILURES: Record<string, number> = { 'lid-penetration': 2, 'exposed-teeth': 1, 'mouth-skin-intersection': 4 };
let characterFaceFailures: string[] | undefined;

maybe('a stylized character with face=arkit walks and jogs with a living face on its head bone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-character-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'test_character_face', blender: { script: resolve('tests/fixtures/face-rig/test_character_face.py') }, output: 'generated' }));
  const built = await buildAsset(config);
  const bytes = await readFile(join(built.output, 'model.glb'));
  const report = await verifyFaceContract(bytes);
  characterFaceFailures = report.failures;
  // Ratchet for the known-red contract (see the header): no check may fail that did not, and none may fail more often.
  const failing: Record<string, number> = {};
  for (const check of report.checks) if (check.problems.length) failing[check.id] = check.problems.length;
  for (const [id, count] of Object.entries(failing)) expect(count, `contract check ${id}`).toBeLessThanOrEqual(KNOWN_RED_CHARACTER_FAILURES[id] ?? 0);
  expect(report.checks.find(c => c.id === 'skeleton')!.message).toMatch(/head under rig-neck/);
  const { json } = readGLB(bytes);
  const parent = (name: string) => json.nodes!.find(n => n.children?.some(c => json.nodes![c].name === name))?.name;
  expect([parent('eye_L'), parent('eye_R'), parent('head')]).toEqual(['head', 'head', 'rig-neck']);
  // The walk and jog clips still turn the head (the face rides it); they hold the eye bones at rest, so gaze is free.
  type Clip = { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { output: number }[] };
  const animations = (json as { animations?: Clip[] }).animations ?? [];
  expect(animations.map(a => a.name).sort()).toEqual(['jog', 'walk']);
  const doc = readGLB(bytes);
  const head = json.nodes!.findIndex(n => n.name === 'head'), eyes = ['eye_L', 'eye_R'].map(n => json.nodes!.findIndex(x => x.name === n));
  for (const clip of animations) {
    expect(clip.channels.some(c => c.target.node === head)).toBe(true);
    for (const channel of clip.channels.filter(c => eyes.includes(c.target.node!) && c.target.path === 'rotation')) {
      const values = readAccessor(doc, clip.samplers[channel.sampler].output).data;
      for (let i = 0; i < values.length; i += 4) expect(Math.abs(values[i + 3])).toBeCloseTo(1, 5);
    }
  }
  // One morph mesh, the face, bound to the one body skin.
  expect(json.meshes!.filter(m => Array.isArray(m.extras?.targetNames)).map(m => m.name)).toEqual(['face']);
  expect(json.skins).toHaveLength(1);
}, 900000);

// The strict contract, known red (see the header). It reads the report of the build test above, which fails on its
// own if the build breaks, so this expected failure can only mean "the contract still reports failures".
(blender ? it.fails : it.skip)('known red until 2026-12-31: the stylized character with face=arkit passes arkit-face/1 with no failure', () => {
  expect(characterFaceFailures, 'the build test above must have produced a report').toBeDefined();
  expect(characterFaceFailures).toEqual([]);
});

maybe('the face-rig wrappers validate, join and export inside real Blender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-wrappers-')); directories.push(directory);
  const result = await authorGLB(resolve('tests/blender_face_fixture.py'), join(directory, 'model.glb'));
  const bytes = await readFile(result.output);
  const report = await verifyFaceContract(bytes);
  const passed = new Set(report.checks.filter(c => c.ok).map(c => c.id));
  for (const id of ['validator', 'skeleton', 'skinning', 'eyes', 'morph-names', 'rest-weights', 'morph-motion', 'inversion', 'lid-clearance', 'eye-oblique', 'materials', 'extras', 'exposed-teeth', 'puppet-jaw', 'mouth-skin-intersection']) expect(passed, id).toContain(id);
  // Its lower-tooth quad sits inside the head, so it never pierces the chin skin as the jaw swings (it once hung 6 mm
  // outside the skin and the check reported it from jawOpen = .25).
  expect(report.measurements.mouthCrossings).toMatchObject({ examples: [], capped: false });
  // The wrapper fixture has lower teeth only, so the teeth check names the missing upper row; its eyes sit behind an
  // uncut skin, so no lid edge shows to follow the gaze. Its lids are build_eye's default shells (no eye_hole): two
  // rotating shells that pass through each other when blink, squint and wide add up, which lid-penetration names for
  // both eyes, shell against shell. eye_hole's continuous lids are nested to pass it (tests/fixtures/face-rig).
  const shellsCross = (side: 'L' | 'R') => expect.stringMatching(new RegExp(`^lid-penetration: eye_${side}: in \\d+ of 33 blink, squint and wide poses .*face\\[lid\\] triangle \\d+ passes through face\\[lid\\] triangle \\d+`));
  expect(report.failures).toEqual([
    'lid-follow: eye_L: no eyeball shows down the middle of the eye at rest, so lid follow cannot be seen',
    'lid-follow: eye_R: no eyeball shows down the middle of the eye at rest, so lid follow cannot be seen',
    shellsCross('L'),
    shellsCross('R'),
    'teeth: no upper teeth found: name the mesh or material with "teeth" and "upper" (for example teeth_upper)',
    'upper-lip: skipped because no upper teeth mark the gum line',
    'mouth-open: skipped because the upper or lower teeth were not found',
  ]);
}, 600000);

// Blender and Unreal both: export_glb stores morphs sparse (prune_glb_morphs), and Unreal must import every vertex.
const both = blenderGate(unrealAvailable() && !process.env.AGENT_MESHES_SKIP_UNREAL);
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
