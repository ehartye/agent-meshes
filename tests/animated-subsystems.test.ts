import { describe, expect, it } from 'vitest';
import { AnimationMixer, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperations, capabilities, OperationPlanError, parseOperation, planOperations } from '../src/agent-contract.ts';
import { createProject, Editor, projectSchema } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Object3D } from 'three';
import type { Clip, Operation, Project, Quat, Track } from '../src/core/types.ts';

const TWO_PI = Math.PI * 2;
const wrap = (angle: number) => angle - TWO_PI * Math.round(angle / TWO_PI);
const track = (clip: Clip, bone: string, property: string): Track => clip.tracks.find(item => item.bone === bone && item.property === property)!;
const clipOf = (project: Project, name: string): Clip => project.clips.find(clip => clip.name === name)!;
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
/** Angle about +z of each key, unwrapped across keys the same way a reader of the file would. */
function unwrapZ(keys: Track['keys']): number[] {
  const angles: number[] = [];
  for (const key of keys) {
    const [, , z, w] = key.value as Quat;
    const raw = 2 * Math.atan2(z, w);
    angles.push(angles.length ? angles.at(-1)! + wrap(raw - angles.at(-1)!) : wrap(raw));
  }
  return angles;
}
/** Interpolate the unwrapped angle of a z rotation track linearly in time, which is what slerp about a fixed axis does. */
function angleAt(keys: Track['keys'], time: number): number {
  const angles = unwrapZ(keys);
  const next = keys.findIndex(key => key.time >= time);
  if (next <= 0) return angles[Math.max(next, 0)];
  const span = keys[next].time - keys[next - 1].time;
  return angles[next - 1] + (angles[next] - angles[next - 1]) * (time - keys[next - 1].time) / span;
}
const boxPart = (name: string, size: [number, number, number], position: [number, number, number], bone: string): Operation =>
  ({ op: 'add', part: { name, geometry: { type: 'box', size }, position, binding: { type: 'rigid', bone } } });

/** A little head with two eyelids and a jaw, then the controls that animate them: every operation, no keys written by hand. */
const characterRig: Operation[] = [
  { op: 'bone.add', bone: { name: 'root' } },
  { op: 'bone.add', bone: { name: 'head', parent: 'root', position: [0, 1.5, 0] } },
  { op: 'bone.add', bone: { name: 'lid_l', parent: 'head', position: [-0.12, 0.1, 0.28] } },
  { op: 'bone.add', bone: { name: 'lid_r', parent: 'head', position: [0.12, 0.1, 0.28] } },
  { op: 'bone.add', bone: { name: 'jaw', parent: 'head', position: [0, -0.15, 0.05] } },
  boxPart('torso', [0.5, 1, 0.3], [0, 0.9, 0], 'root'),
  boxPart('skull', [0.5, 0.4, 0.5], [0, 1.6, 0], 'head'),
  boxPart('lid_part_l', [0.14, 0.1, 0.03], [-0.12, 1.6, 0.3], 'lid_l'),
  boxPart('lid_part_r', [0.14, 0.1, 0.03], [0.12, 1.6, 0.3], 'lid_r'),
  boxPart('chin', [0.3, 0.08, 0.3], [0, 1.31, 0.2], 'jaw'),
];
const blinkOps: Operation[] = [
  { op: 'control.pulse', name: 'talk', bone: 'lid_l', property: 'scale', peak: [1, 0.05, 1], times: [1, 2.6], width: 0.2, duration: 4 },
  { op: 'control.pulse', name: 'talk', bone: 'lid_r', property: 'scale', peak: [1, 0.05, 1], times: [1, 2.6], width: 0.2 },
];
const jawOps: Operation[] = [{ op: 'control.pulse', name: 'talk', bone: 'jaw', property: 'position', peak: [0, -0.04, 0], times: [0.5, 1.8, 3.2], width: 0.4 }];
const nodOps: Operation[] = [{ op: 'control.hinge', name: 'talk', bone: 'head', axis: 'x', from: 0, to: 12, cycles: 2 }];

const gearTeeth: [number, number] = [20, 10];
/** A base with a wheel, a propeller and two meshing gears (20 and 10 teeth, so the small one turns twice per turn of the large one). */
const machineOps: Operation[] = [
  { op: 'bone.add', bone: { name: 'base' } },
  { op: 'bone.add', bone: { name: 'wheel', parent: 'base', position: [-1, 0.5, 0] } },
  { op: 'bone.add', bone: { name: 'prop', parent: 'base', position: [0, 1.2, 0.6] } },
  { op: 'bone.add', bone: { name: 'gear_a', parent: 'base', position: [0.6, 0.5, 0] } },
  { op: 'bone.add', bone: { name: 'gear_b', parent: 'base', position: [0.9, 0.5, 0] } },
  boxPart('frame', [2.4, 0.1, 0.3], [0, 0.2, 0], 'base'),
  boxPart('wheel_rim', [0.5, 0.5, 0.05], [-1, 0.5, 0], 'wheel'), boxPart('wheel_spoke', [0.7, 0.06, 0.08], [-1, 0.5, 0.05], 'wheel'),
  boxPart('blade_a', [0.5, 0.08, 0.02], [0.2, 1.2, 0.6], 'prop'), boxPart('blade_b', [0.5, 0.08, 0.02], [-0.2, 1.2, 0.6], 'prop'),
  boxPart('gear_a_disc', [0.4, 0.4, 0.05], [0.6, 0.5, 0], 'gear_a'), boxPart('gear_a_tooth', [0.1, 0.1, 0.07], [0.8, 0.5, 0], 'gear_a'),
  boxPart('gear_b_disc', [0.2, 0.2, 0.05], [0.9, 0.5, 0], 'gear_b'), boxPart('gear_b_tooth', [0.08, 0.08, 0.07], [0.9, 0.58, 0], 'gear_b'),
  { op: 'control.spin', name: 'run', bone: 'wheel', axis: 'z', turns: 3, duration: 3 },
  { op: 'control.spin', name: 'run', bone: 'prop', axis: 'z', turns: -6 },
  { op: 'control.spin', name: 'run', bone: 'gear_a', axis: 'z', turns: 3 },
  { op: 'control.couple', name: 'run', driver: 'gear_a', driven: 'gear_b', axis: 'z', teeth: gearTeeth, phase: 18 },
];
const build = (operations: Operation[], from = createProject('subsystems')) => applyOperations(from, operations);

/** Skinned vertices in world space of the named parts, with the clip played to `time`. */
function posedVertices(root: Object3D, names: string[]): Vector3[] {
  root.updateMatrixWorld(true);
  return names.flatMap(name => {
    const mesh = root.getObjectByName(name) as SkinnedMesh;
    const positions = mesh.geometry.getAttribute('position');
    return Array.from({ length: positions.count }, (_, index) => mesh.applyBoneTransform(index, new Vector3().fromBufferAttribute(positions, index)).applyMatrix4(mesh.matrixWorld));
  });
}
async function expectExportMatches(project: Project, clipName: string, parts: string[], times: number[], needs: 'scale' | 'quaternion') {
  const bytes = await exportGLB(project);
  const report = await verifyGLB(bytes);
  expect(report.errors).toBe(0);
  const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  const received = loaded.animations.find(clip => clip.name === clipName)!;
  expect(received.tracks.some(item => item.name.endsWith(`.${needs}`))).toBe(true);
  const built = buildScene(project);
  try {
    const wanted = new AnimationMixer(built.root), actual = new AnimationMixer(loaded.scene);
    wanted.clipAction(built.clips.find(clip => clip.name === clipName)!).play(); actual.clipAction(received).play();
    const rest = posedVertices(built.root, parts);
    let moved = 0;
    for (const time of times) {
      wanted.setTime(time); actual.setTime(time);
      const expected = posedVertices(built.root, parts), got = posedVertices(loaded.scene, parts);
      expect(got.length).toBe(expected.length);
      expected.forEach((vertex, index) => { expect(got[index].distanceTo(vertex)).toBeLessThan(5e-6); moved = Math.max(moved, vertex.distanceTo(rest[index])); });
    }
    return moved;
  } finally { built.dispose(); }
}

describe('control operations', () => {
  it('are published with schemas and valid examples', () => {
    const contract = capabilities();
    for (const op of ['control.hinge', 'control.spin', 'control.pulse', 'control.couple'] as const) {
      expect(contract.operations[op].description.length).toBeGreaterThan(80);
      expect(contract.operations[op].examples.length).toBeGreaterThan(0);
      for (const example of contract.operations[op].examples) expect(parseOperation(example)).toEqual(example);
    }
    expect(() => parseOperation({ op: 'control.spin', name: 'run', bone: 'wheel', axis: 'z', turns: 0 })).toThrow(/turn/);
    expect(() => parseOperation({ op: 'control.spin', name: 'run', bone: 'wheel', axis: 'z', turns: 1.5 })).toThrow();
    expect(() => parseOperation({ op: 'control.spin', name: 'run', bone: 'wheel', axis: [0, 0, 0], turns: 1 })).toThrow(/zero/);
    expect(() => parseOperation({ op: 'control.hinge', name: 'c', bone: 'b', axis: 'x', from: 10, to: 10 })).toThrow(/different/);
    expect(() => parseOperation({ op: 'control.couple', name: 'c', driver: 'a', driven: 'b', axis: 'z' })).toThrow(/ratio/);
    expect(() => parseOperation({ op: 'control.couple', name: 'c', driver: 'a', driven: 'b', axis: 'z', ratio: 2, teeth: [20, 10] })).toThrow(/ratio/);
  });

  it('bake a hinge between two angles that returns to its start, with a quarter turn at most between keys', () => {
    const project = build([...characterRig, { op: 'control.hinge', name: 'nod', bone: 'head', axis: 'x', from: -10, to: 30, cycles: 2, duration: 2 }]);
    const keys = track(clipOf(project, 'nod'), 'head', 'rotation').keys;
    expect(keys[0].time).toBe(0); expect(keys.at(-1)!.time).toBe(2);
    expect(keys[0].value).toEqual(keys.at(-1)!.value);
    const angles = keys.map(key => 2 * Math.atan2((key.value as Quat)[0], (key.value as Quat)[3]) * 180 / Math.PI);
    expect(Math.min(...angles)).toBeCloseTo(-10, 6); expect(Math.max(...angles)).toBeCloseTo(30, 6);
    expect(keys.filter((_, index) => Math.abs(angles[index] - 30) < 1e-6)).toHaveLength(2);
    // A ramp across two full revolutions adds keys until each step is a quarter turn or less, and the signs stay continuous.
    const ramp = build([{ op: 'bone.add', bone: { name: 'door' } }, { op: 'control.hinge', name: 'swing', bone: 'door', axis: [0, 1, 0], from: 0, to: 720, mode: 'ramp', keysPerCycle: 4, duration: 4 }]);
    const ramped = track(clipOf(ramp, 'swing'), 'door', 'rotation').keys;
    expect(ramped.length).toBeGreaterThanOrEqual(9);
    for (let index = 1; index < ramped.length; index++) expect(dot(ramped[index].value, ramped[index - 1].value)).toBeGreaterThan(Math.cos(Math.PI / 4) - 1e-9);
  });

  it('bake three continuous turns with no quaternion sign reversal and a monotonic unwrapped angle', () => {
    const project = build([{ op: 'bone.add', bone: { name: 'wheel' } }, { op: 'control.spin', name: 'spin', bone: 'wheel', axis: 'z', turns: 3, duration: 3, phase: 25 }]);
    const keys = track(clipOf(project, 'spin'), 'wheel', 'rotation').keys;
    expect(keys).toHaveLength(3 * 8 + 1);
    for (let index = 1; index < keys.length; index++) {
      // A shortest-path reversal shows as a negative dot product between neighbouring keys.
      expect(dot(keys[index].value, keys[index - 1].value)).toBeGreaterThan(0.9);
      expect(keys[index].time).toBeGreaterThan(keys[index - 1].time);
    }
    const angles = unwrapZ(keys);
    for (let index = 1; index < angles.length; index++) {
      expect(angles[index]).toBeGreaterThan(angles[index - 1]);
      expect(angles[index] - angles[index - 1]).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
    expect(angles.at(-1)! - angles[0]).toBeCloseTo(3 * TWO_PI, 9);
    expect(angles[0]).toBeCloseTo(25 * Math.PI / 180, 9);
    // Three turns end on the negated quaternion, which is the same orientation as the start.
    expect(Math.abs(dot(keys.at(-1)!.value, keys[0].value))).toBeCloseTo(1, 12);
    // A reverse spin runs the other way, one revolution per two seconds at any axis.
    const back = build([{ op: 'bone.add', bone: { name: 'fan' } }, { op: 'control.spin', name: 'spin', bone: 'fan', axis: 'z', turns: -2, duration: 4, keysPerTurn: 12 }]);
    const reverse = unwrapZ(track(clipOf(back, 'spin'), 'fan', 'rotation').keys);
    for (let index = 1; index < reverse.length; index++) expect(reverse[index]).toBeLessThan(reverse[index - 1]);
    expect(reverse.at(-1)! - reverse[0]).toBeCloseTo(-2 * TWO_PI, 9);
  });

  it('pulse a scale or a position and return to rest, within the clip and without overlapping', () => {
    const project = build([...characterRig, ...blinkOps, ...jawOps]);
    const lid = track(clipOf(project, 'talk'), 'lid_l', 'scale');
    expect(lid.keys[0]).toEqual({ time: 0, value: [1, 1, 1] });
    expect(lid.keys.at(-1)).toEqual({ time: 4, value: [1, 1, 1] });
    expect(Math.min(...lid.keys.map(key => key.value[1]))).toBeCloseTo(0.05, 12);
    expect(lid.keys.find(key => key.time === 1)!.value).toEqual([1, 0.05, 1]);
    expect(lid.keys.every(key => key.value[0] === 1 && key.value[2] === 1 && key.value[1] > 0)).toBe(true);
    const jaw = track(clipOf(project, 'talk'), 'jaw', 'position');
    expect(jaw.keys.find(key => key.time === 1.8)!.value).toEqual([0, -0.04, 0]);
    expect(jaw.keys.find(key => key.time === 0.3)!.value).toEqual([0, 0, 0]);
    const triangle = build([...characterRig, { op: 'control.pulse', name: 'talk', bone: 'jaw', property: 'position', peak: [0, -0.04, 0], times: [1], width: 0.5, shape: 'triangle', duration: 2 }]);
    const straight = track(clipOf(triangle, 'talk'), 'jaw', 'position').keys;
    expect(straight).toHaveLength(11);
    expect(straight[1].time).toBe(0.75); expect(straight[9].time).toBe(1.25);
    expect(straight.find(key => key.time === 0.875)!.value[1]).toBeCloseTo(-0.02, 12);
    for (const pulse of [
      { property: 'scale', peak: [1, 0, 1] }, { property: 'scale', peak: [1, -0.5, 1] },
    ]) expect(() => parseOperation({ op: 'control.pulse', name: 'talk', bone: 'lid_l', times: [1], width: 0.2, duration: 2, ...pulse })).toThrow(/positive/);
    const base = { op: 'control.pulse', name: 'talk', bone: 'lid_l', property: 'scale', peak: [1, 0.1, 1] };
    expect(() => build([...characterRig, { ...base, times: [0.05], width: 0.2, duration: 2 } as Operation])).toThrow(/does not fit/);
    expect(() => build([...characterRig, { ...base, times: [1, 1.1], width: 0.2, duration: 2 } as Operation])).toThrow(/overlaps/);
    expect(() => build([...characterRig, { ...base, times: [1.9], width: 0.4, duration: 2 } as Operation])).toThrow(/does not fit/);
  });

  it('name the operation index and clip when a control is wrong', () => {
    const project = build(characterRig);
    const failure = (operations: unknown[]) => { try { planOperations(project, operations); } catch (error) { return error as OperationPlanError; } throw new Error('Expected a failure'); };
    expect(failure([{ op: 'control.pulse', name: 'talk', bone: 'missing', property: 'scale', peak: [1, 0.1, 1], times: [1], width: 0.2, duration: 2 }])).toMatchObject({ operationIndex: 0, part: 'talk' });
    expect(failure([{ op: 'control.spin', name: 'new_clip', bone: 'head', axis: 'x', turns: 1 }]).message).toMatch(/give duration/);
    const second = failure([{ op: 'control.spin', name: 'spin', bone: 'head', axis: 'x', turns: 1, duration: 2 }, { op: 'control.spin', name: 'spin', bone: 'head', axis: 'x', turns: 1, duration: 3 }]);
    expect(second.operationIndex).toBe(1); expect(second.message).toMatch(/lasts 2 s/);
    expect(failure([{ op: 'control.couple', name: 'spin', driver: 'head', driven: 'jaw', axis: 'x', ratio: 2 }]).message).toMatch(/Unknown clip/);
  });
});

describe('a character with independent blink and jaw controls', () => {
  it('is built from operations, with each control owning only its bone', () => {
    const project = build([...characterRig, ...blinkOps, ...jawOps, ...nodOps]);
    const talk = clipOf(project, 'talk');
    expect(talk.tracks.map(item => `${item.bone}:${item.property}`).sort()).toEqual(['head:rotation', 'jaw:position', 'lid_l:scale', 'lid_r:scale']);
    // Independent: the blink and the jaw do not share a time, and neither track moves the other's bone.
    const lidTimes = new Set(track(talk, 'lid_l', 'scale').keys.filter(key => key.value[1] < 1).map(key => key.time));
    const jawTimes = track(talk, 'jaw', 'position').keys.filter(key => key.value[1] < 0).map(key => key.time);
    expect(jawTimes.some(time => lidTimes.has(time))).toBe(false);
    // Order does not matter and adding a control leaves the others deep-equal.
    const reordered = build([...characterRig, ...nodOps.map(op => ({ ...op, duration: 4 }) as Operation), ...jawOps.map(op => ({ ...op, duration: 4 }) as Operation), ...blinkOps.map(op => ({ ...op, duration: 4 }) as Operation)]);
    const sorted = (clip: Clip) => [...clip.tracks].sort((a, b) => `${a.bone}:${a.property}`.localeCompare(`${b.bone}:${b.property}`));
    expect(sorted(clipOf(reordered, 'talk'))).toEqual(sorted(talk));
  });

  it('keeps unrelated tracks and clips deep-equal when a control is added, replacing only its own track', () => {
    const base = build([
      ...characterRig,
      { op: 'clip.set', clip: { name: 'talk', duration: 4, tracks: [
        { bone: 'root', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [0, 0.05, 0] }, { time: 4, value: [0, 0, 0] }] },
        { bone: 'jaw', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 4, value: [0, 0, 0, 1] }] },
      ] } },
      { op: 'clip.create', name: 'idle', duration: 1, bones: ['root'] },
    ]);
    const before = structuredClone(base);
    const after = build([...blinkOps, ...jawOps, ...nodOps], base);
    expect(base).toEqual(before);
    const talk = clipOf(after, 'talk');
    for (const original of clipOf(before, 'talk').tracks) expect(track(talk, original.bone, original.property)).toEqual(original);
    expect(clipOf(after, 'idle')).toEqual(clipOf(before, 'idle'));
    expect(talk.tracks).toHaveLength(2 + 4);
    // Running a control again replaces its track instead of adding a second one.
    const again = build([{ op: 'control.pulse', name: 'talk', bone: 'jaw', property: 'position', peak: [0, -0.1, 0], times: [2], width: 0.5 }], after);
    expect(clipOf(again, 'talk').tracks).toHaveLength(talk.tracks.length);
    expect(track(clipOf(again, 'talk'), 'jaw', 'position').keys.find(key => key.time === 2)!.value).toEqual([0, -0.1, 0]);
    expect(track(clipOf(again, 'talk'), 'lid_l', 'scale')).toEqual(track(talk, 'lid_l', 'scale'));
  });

  it('survives save and reopen unchanged, and one undo removes a whole batch of controls', () => {
    const rigged = build(characterRig);
    const plan = planOperations(rigged, [...blinkOps, ...jawOps, ...nodOps]);
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(plan.project)));
    expect(reopened).toEqual(plan.project);
    expect(reopened.version).toBe(1);
    const editor = new Editor(rigged);
    editor.replace(plan.project);
    expect(editor.project.clips).toHaveLength(1);
    const restored = Editor.restore(JSON.parse(JSON.stringify(editor.snapshot())));
    expect(restored.project).toEqual(plan.project);
    expect(restored.undo()).toEqual(rigged);
  });

  it('exports a scale channel and plays the blink and jaw in a fresh GLB the same as in memory', async () => {
    const project = build([...characterRig, ...blinkOps, ...jawOps, ...nodOps]);
    const moved = await expectExportMatches(project, 'talk', ['lid_part_l', 'lid_part_r', 'chin', 'skull'], [0, 0.45, 0.5, 0.9, 1, 1.05, 1.8, 2.55, 2.6, 3.9, 4], 'scale');
    expect(moved).toBeGreaterThan(0.03);
    // The lid really is squashed at the middle of the blink, by the scale track alone.
    const built = buildScene(project);
    try {
      const mixer = new AnimationMixer(built.root); mixer.clipAction(built.clips[0]).play(); mixer.setTime(1);
      expect(built.bones.get('lid_l')!.scale.toArray()).toEqual([1, 0.05, 1].map(v => expect.closeTo(v, 6)));
      expect(built.bones.get('lid_l')!.position.toArray()).toEqual([-0.12, 0.1, 0.28].map(v => expect.closeTo(v, 6)));
    } finally { built.dispose(); }
  }, 30000);
});

describe('a mechanical model with a wheel, a propeller and meshing gears', () => {
  const machine = () => build(machineOps);
  it('is built from operations, with every track a standard rotation track and a looping pose', () => {
    const project = machine();
    const run = clipOf(project, 'run');
    expect(run.duration).toBe(3);
    expect(run.tracks.map(item => `${item.bone}:${item.property}`)).toEqual(['wheel:rotation', 'prop:rotation', 'gear_a:rotation', 'gear_b:rotation']);
    for (const item of run.tracks) {
      expect(item.keys[0].time).toBe(0); expect(item.keys.at(-1)!.time).toBe(3);
      // First and last pose match: the same orientation, whether the quaternion is the same or negated.
      expect(Math.abs(dot(item.keys.at(-1)!.value, item.keys[0].value))).toBeCloseTo(1, 12);
      for (let index = 1; index < item.keys.length; index++) expect(dot(item.keys[index].value, item.keys[index - 1].value)).toBeGreaterThan(0.7);
    }
    expect(unwrapZ(track(run, 'prop', 'rotation').keys).at(-1)).toBeCloseTo(-6 * TWO_PI, 9);
    expect(JSON.parse(JSON.stringify(project))).toEqual(project);
  });

  it('holds angle2 = -ratio * angle1 + phase to 1e-6 at every key and at sampled times', () => {
    const project = machine();
    const run = clipOf(project, 'run');
    const driver = track(run, 'gear_a', 'rotation').keys, driven = track(run, 'gear_b', 'rotation').keys;
    const ratio = gearTeeth[0] / gearTeeth[1], phase = 18 * Math.PI / 180;
    const drivenAngles = unwrapZ(driven);
    driven.forEach((key, index) => {
      const expected = -ratio * angleAt(driver, key.time) + phase;
      expect(Math.abs(drivenAngles[index] - expected)).toBeLessThan(1e-6);
    });
    for (let index = 1; index < drivenAngles.length; index++) expect(Math.abs(drivenAngles[index] - drivenAngles[index - 1])).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    // The same holds in the playing scene, between keys: bone angles read back from the mixer.
    const built = buildScene(project);
    try {
      const mixer = new AnimationMixer(built.root); mixer.clipAction(built.clips.find(clip => clip.name === 'run')!).play();
      for (const time of [0, 0.013, 0.2, 0.37, 0.5, 1.111, 1.5, 2.2, 2.77, 2.999, 3]) {
        mixer.setTime(time);
        const a = built.bones.get('gear_a')!.quaternion, b = built.bones.get('gear_b')!.quaternion;
        const angle1 = angleAt(driver, time);
        expect(Math.abs(wrap(2 * Math.atan2(a.z, a.w) - angle1))).toBeLessThan(1e-6);
        expect(Math.abs(wrap(2 * Math.atan2(b.z, b.w) - (-ratio * angle1 + phase)))).toBeLessThan(1e-6);
      }
    } finally { built.dispose(); }
  });

  it('couples a fractional ratio and an internal gear, and refuses a ratio whose loop would pop', () => {
    const rig: Operation[] = [
      { op: 'bone.add', bone: { name: 'a' } }, { op: 'bone.add', bone: { name: 'b' } }, { op: 'bone.add', bone: { name: 'ring' } },
      { op: 'control.spin', name: 'mesh', bone: 'a', axis: 'z', turns: 2, duration: 4 },
    ];
    const project = build([...rig,
      { op: 'control.couple', name: 'mesh', driver: 'a', driven: 'b', axis: 'z', teeth: [24, 16], phase: -30 },
      { op: 'control.couple', name: 'mesh', driver: 'a', driven: 'ring', axis: 'z', ratio: 0.5, mesh: 'internal' },
    ]);
    const mesh = clipOf(project, 'mesh'), driver = track(mesh, 'a', 'rotation').keys;
    const b = unwrapZ(track(mesh, 'b', 'rotation').keys), ring = unwrapZ(track(mesh, 'ring', 'rotation').keys);
    track(mesh, 'b', 'rotation').keys.forEach((key, index) => expect(Math.abs(b[index] - (-1.5 * angleAt(driver, key.time) - Math.PI / 6))).toBeLessThan(1e-6));
    track(mesh, 'ring', 'rotation').keys.forEach((key, index) => expect(Math.abs(ring[index] - 0.5 * angleAt(driver, key.time))).toBeLessThan(1e-6));
    expect(b.at(-1)! - b[0]).toBeCloseTo(-3 * TWO_PI, 9);
    // Two driver turns against 20:12 teeth leave the small gear 2/3 of a turn short of a whole number, so the loop would pop.
    const pop = [...rig, { op: 'control.couple', name: 'mesh', driver: 'a', driven: 'b', axis: 'z', teeth: [20, 12] } as Operation];
    expect(() => build(pop)).toThrow(/loop would pop/);
    expect(clipOf(build([...rig, { ...pop.at(-1)!, loop: false } as Operation]), 'mesh').tracks).toHaveLength(2);
    expect(() => build(pop.map(op => op.op === 'control.couple' ? { ...op, teeth: [20, 10] } as Operation : op))).not.toThrow();
  });

  it('couples only a driver that turns about the stated axis', () => {
    const rig: Operation[] = [{ op: 'bone.add', bone: { name: 'a' } }, { op: 'bone.add', bone: { name: 'b' } }, { op: 'control.spin', name: 'mesh', bone: 'a', axis: 'x', turns: 1, duration: 2 }];
    expect(() => build([...rig, { op: 'control.couple', name: 'mesh', driver: 'a', driven: 'b', axis: 'z', ratio: 1 }])).toThrow(/about the coupled axis only/);
    expect(() => build([...rig, { op: 'control.couple', name: 'mesh', driver: 'b', driven: 'a', axis: 'x', ratio: 1 }])).toThrow(/no rotation track for driver "b"/);
    const meshed = build([...rig, { op: 'control.couple', name: 'mesh', driver: 'a', driven: 'b', axis: 'x', drivenAxis: [0, 1, 0], ratio: 1 }]);
    const key = track(clipOf(meshed, 'mesh'), 'b', 'rotation').keys[2].value as Quat;
    expect(key[0]).toBeCloseTo(0, 12); expect(key[2]).toBeCloseTo(0, 12);
    expect(Math.abs(key[1])).toBeGreaterThan(0.1);
  });

  it('adds controls without changing a walk clip it shares a model with', () => {
    const walk: Clip = { name: 'run', duration: 3, tracks: [{ bone: 'base', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1.5, value: [0, 0.02, 0] }, { time: 3, value: [0, 0, 0] }] }] };
    const withWalk = build([{ op: 'bone.add', bone: { name: 'base' } }, { op: 'bone.add', bone: { name: 'wheel', parent: 'base' } }, { op: 'clip.set', clip: walk }]);
    const spun = build([{ op: 'control.spin', name: 'run', bone: 'wheel', axis: 'z', turns: 2 }], withWalk);
    expect(clipOf(spun, 'run').tracks[0]).toEqual(walk.tracks[0]);
    expect(clipOf(spun, 'run').tracks).toHaveLength(2);
  });

  it('exports and plays in a fresh GLB the same as in memory, for a rotating gear and a scaled part together', async () => {
    const scaled = build([
      ...machineOps,
      { op: 'control.pulse', name: 'run', bone: 'gear_b', property: 'scale', peak: [1.3, 1.3, 1], times: [0.75, 2.25], width: 0.5 },
    ]);
    const times = [0, 0.1, 0.375, 0.75, 1, 1.4, 2.25, 2.9, 3];
    const gears = ['gear_a_disc', 'gear_a_tooth', 'gear_b_disc', 'gear_b_tooth'];
    expect(await expectExportMatches(scaled, 'run', gears, times, 'quaternion')).toBeGreaterThan(0.1);
    expect(await expectExportMatches(scaled, 'run', ['gear_b_disc', 'gear_b_tooth'], [0.75, 2.25], 'scale')).toBeGreaterThan(0.03);
    expect(await expectExportMatches(scaled, 'run', ['wheel_spoke', 'wheel_rim', 'blade_a', 'blade_b', 'frame'], times, 'quaternion')).toBeGreaterThan(0.1);
    // Three turns in the exported file keep their signs continuous, so a viewer never sees a spin reverse.
    const loaded = await new GLTFLoader().parseAsync((await exportGLB(scaled)).slice().buffer as ArrayBuffer, '');
    for (const item of loaded.animations.find(clip => clip.name === 'run')!.tracks.filter(entry => entry.name.endsWith('.quaternion'))) {
      for (let index = 1; index < item.times.length; index++) {
        const key = (i: number) => [...item.values.slice(i * 4, i * 4 + 4)];
        expect(dot(key(index), key(index - 1))).toBeGreaterThan(0.7);
      }
    }
    // The in-memory scale really changes the geometry: the pulsed gear is wider mid-pulse than at rest.
    const built = buildScene(scaled);
    try {
      const mixer = new AnimationMixer(built.root); mixer.clipAction(built.clips.find(clip => clip.name === 'run')!).play();
      mixer.setTime(0.75);
      expect(built.bones.get('gear_b')!.scale.toArray()).toEqual([1.3, 1.3, 1].map(v => expect.closeTo(v, 6)));
      mixer.setTime(0);
      expect(built.bones.get('gear_b')!.scale.toArray()).toEqual([1, 1, 1]);
      expect(new Quaternion().copy(built.bones.get('gear_b')!.quaternion).angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 18 * Math.PI / 180))).toBeLessThan(1e-9);
    } finally { built.dispose(); }
  }, 60000);
});
