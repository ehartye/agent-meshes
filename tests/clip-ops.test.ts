import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnimationMixer, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperations, OperationPlanError, parseOperation, planOperations } from '../src/agent-contract.ts';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Clip, Operation, Project } from '../src/core/types.ts';

const S = Math.SQRT1_2;
function fixture(): Project {
  let project = createProject('clip-ops');
  for (const operation of [
    { op: 'bone.add', bone: { name: 'root' } },
    { op: 'bone.add', bone: { name: 'arm', parent: 'root', position: [0, 1, 0] } },
    { op: 'bone.add', bone: { name: 'hand', parent: 'arm', position: [0, 1, 0] } },
    { op: 'add', part: { name: 'limb', geometry: { type: 'box', size: [0.4, 2, 0.4] }, position: [0, 1, 0] } },
    { op: 'bind', name: 'limb', binding: { type: 'linear', bones: ['root', 'arm'], axis: 'y', range: [-0.5, 0.5] } },
    { op: 'clip.set', clip: { name: 'walk', duration: 2, tracks: [
      { bone: 'root', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, 0, 0, 1] }] },
      { bone: 'arm', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, S, S] }, { time: 1.5, value: [0, 0, 0.5, Math.sqrt(0.75)] }, { time: 2, value: [0, 0, 0, 1] }] },
      { bone: 'arm', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [0, 0.1, 0] }] },
    ] } },
  ] as Operation[]) project = applyOperation(project, operation);
  return project;
}
const walk = (project: Project): Clip => project.clips.find(clip => clip.name === 'walk')!;
const track = (clip: Clip, bone: string, property: string) => clip.tracks.find(item => item.bone === bone && item.property === property)!;
const times = (clip: Clip, bone: string, property: string) => track(clip, bone, property).keys.map(key => key.time);
/** Every track of `after` except the listed bone:property pairs equals the one in `before`. */
function expectUnrelatedUntouched(before: Clip, after: Clip, changed: string[]) {
  for (const original of before.tracks) {
    if (changed.includes(`${original.bone}:${original.property}`)) continue;
    expect(track(after, original.bone, original.property)).toStrictEqual(original);
  }
}
function failure(project: Project, operations: unknown[]): OperationPlanError {
  try { planOperations(project, operations); } catch (error) { expect(error).toBeInstanceOf(OperationPlanError); return error as OperationPlanError; }
  throw new Error('Expected the plan to fail');
}

describe('clip create, clone, rename and retime', () => {
  it('creates a clip with a pose-holding rotation track per bone, or per listed bone', () => {
    let project = applyOperation(fixture(), { op: 'pose', name: 'arm', rotation: [0, 0, S, S] });
    const all = applyOperation(project, { op: 'clip.create', name: 'idle', duration: 3 });
    const idle = all.clips.find(clip => clip.name === 'idle')!;
    expect(idle.duration).toBe(3);
    expect(idle.tracks.map(item => `${item.bone}:${item.property}`)).toEqual(['root:rotation', 'arm:rotation', 'hand:rotation']);
    expect(track(idle, 'arm', 'rotation').keys).toEqual([{ time: 0, value: [0, 0, S, S] }, { time: 3, value: [0, 0, S, S] }]);
    project = applyOperation(project, { op: 'clip.create', name: 'arm_only', duration: 1, bones: ['arm'] });
    expect(project.clips.find(clip => clip.name === 'arm_only')!.tracks).toHaveLength(1);
    expect(walk(project)).toStrictEqual(walk(fixture()));
  });

  it('clones a clip with independent tracks', () => {
    const project = applyOperation(fixture(), { op: 'clip.clone', from: 'walk', name: 'walk2' });
    const copy = project.clips.find(clip => clip.name === 'walk2')!;
    expect(copy).toStrictEqual({ ...walk(project), name: 'walk2' });
    copy.tracks[0].keys[0].value = [1, 0, 0, 0];
    expect(track(walk(project), 'root', 'rotation').keys[0].value).toEqual([0, 0, 0, 1]);
  });

  it('renames a clip and keeps its tracks', () => {
    const before = fixture();
    const project = applyOperation(before, { op: 'clip.rename', name: 'walk', to: 'stroll' });
    expect(project.clips.map(clip => clip.name)).toEqual(['stroll']);
    expect(project.clips[0]).toStrictEqual({ ...walk(before), name: 'stroll' });
  });

  it('retimes by scaling every key time and the duration', () => {
    const before = fixture();
    const slower = applyOperation(before, { op: 'clip.retime', name: 'walk', duration: 4 }), clip = walk(slower);
    expect(clip.duration).toBe(4);
    expect(times(clip, 'arm', 'rotation')).toEqual([0, 2, 3, 4]);
    expect(times(clip, 'root', 'rotation')).toEqual([0, 4]);
    expect(track(clip, 'arm', 'rotation').keys.map(key => key.value)).toEqual(track(walk(before), 'arm', 'rotation').keys.map(key => key.value));
    const faster = walk(applyOperation(before, { op: 'clip.retime', name: 'walk', duration: 0.5 }));
    expect(faster.duration).toBe(0.5);
    expect(times(faster, 'arm', 'rotation')).toEqual([0, 0.25, 0.375, 0.5]);
    expect(times(faster, 'arm', 'position')).toEqual([0, 0.5]);
  });

  it('rejects name collisions, unknown clips and out-of-range durations with the operation index', () => {
    const project = fixture();
    const cases: [unknown[], RegExp][] = [
      [[{ op: 'clip.create', name: 'walk', duration: 1 }], /Clip name already in use: walk/],
      [[{ op: 'clip.clone', from: 'walk', name: 'walk' }], /Clip name already in use: walk/],
      [[{ op: 'clip.rename', name: 'walk', to: 'walk' }], /Clip name already in use: walk/],
      [[{ op: 'clip.clone', from: 'missing', name: 'copy' }], /Unknown clip: missing/],
      [[{ op: 'clip.retime', name: 'walk', duration: 0.01 }], /duration/],
      [[{ op: 'clip.retime', name: 'walk', duration: 121 }], /duration/],
      [[{ op: 'clip.create', name: 'idle', duration: 1, bones: ['ghost'] }], /Unknown animation bone: ghost/],
    ];
    for (const [operations, message] of cases) {
      const error = failure(project, [{ op: 'clip.clone', from: 'walk', name: 'ok_copy' }, ...operations]);
      expect(error.operationIndex).toBe(1);
      expect(error.message).toMatch(/^Operation 1: /);
      expect(error.message).toMatch(message);
    }
    const named = failure(project, [{ op: 'clip.rename', name: 'walk', to: 'walk' }]);
    expect(named).toMatchObject({ operationIndex: 0, op: 'clip.rename', part: 'walk' });
    const collision = applyOperations(project, [{ op: 'clip.clone', from: 'walk', name: 'a' }]);
    expect(() => applyOperations(collision, [{ op: 'clip.rename', name: 'a', to: 'walk' }])).toThrow(/Operation 0.*already in use/);
  });
});

describe('per-key set, remove and record', () => {
  it('inserts a key in order and replaces one at an existing time, leaving unrelated tracks deep-equal', () => {
    const before = fixture();
    let project = applyOperation(before, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 0.5, value: [0, 0, 0.2, Math.sqrt(1 - 0.04)] });
    expect(times(walk(project), 'arm', 'rotation')).toEqual([0, 0.5, 1, 1.5, 2]);
    expectUnrelatedUntouched(walk(before), walk(project), ['arm:rotation']);
    project = applyOperation(project, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 1, value: [0, 0, 0, 1] });
    expect(track(walk(project), 'arm', 'rotation').keys).toHaveLength(5);
    expect(track(walk(project), 'arm', 'rotation').keys[2]).toEqual({ time: 1, value: [0, 0, 0, 1] });
    expect(times(walk(project), 'arm', 'rotation')).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(walk(project).duration).toBe(2);
  });

  it('sets a key on the endpoints, snapping a time within 1e-7 of the duration and creating a missing track', () => {
    const before = fixture();
    let project = applyOperation(before, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 2 + 1e-7, value: [0, 0, 0.5, Math.sqrt(0.75)] });
    expect(times(walk(project), 'arm', 'rotation')).toEqual([0, 1, 1.5, 2]);
    expect(track(walk(project), 'arm', 'rotation').keys[3].value).toEqual([0, 0, 0.5, Math.sqrt(0.75)]);
    expect(track(walk(project), 'arm', 'rotation').keys[0].value).toEqual([0, 0, 0, 1]);
    project = applyOperation(project, { op: 'clip.key.set', name: 'walk', bone: 'hand', property: 'position', time: 1, value: [0, 0.1, 0] });
    expect(track(walk(project), 'hand', 'position').keys).toEqual([{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0.1, 0] }, { time: 2, value: [0, 0, 0] }]);
    expectUnrelatedUntouched(walk(before), walk(project), ['arm:rotation', 'hand:position']);
  });

  it('copies an endpoint key to the other end under the loop policy only', () => {
    const base = fixture(), value = [0, 0, 0.2, Math.sqrt(1 - 0.04)];
    const free = applyOperation(base, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 0, value: value as never });
    expect(track(walk(free), 'arm', 'rotation').keys.at(-1)!.value).toEqual([0, 0, 0, 1]);
    const loop = applyOperation(base, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 0, value: value as never, endpoints: 'loop' });
    expect(track(walk(loop), 'arm', 'rotation').keys.at(-1)!.value).toEqual(value);
    const atEnd = applyOperation(base, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 2, value: value as never, endpoints: 'loop' });
    expect(track(walk(atEnd), 'arm', 'rotation').keys[0].value).toEqual(value);
    const middle = applyOperation(base, { op: 'clip.key.set', name: 'walk', bone: 'arm', property: 'rotation', time: 1, value: value as never, endpoints: 'loop' });
    expect(track(walk(middle), 'arm', 'rotation').keys[0].value).toEqual([0, 0, 0, 1]);
  });

  it('normalizes rotation values on key.set and key.record, and rejects a zero quaternion or wrong length', () => {
    const set = applyOperation(fixture(), { op: 'clip.key.set', name: 'walk', bone: 'root', property: 'rotation', time: 1, value: [0, 0, 3, 4] });
    const [x, y, z, w] = track(walk(set), 'root', 'rotation').keys[1].value as number[];
    expect([x, y, z, w]).toEqual([0, 0, 0.6, 0.8]);
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
    const recorded = applyOperation(fixture(), { op: 'clip.key.record', name: 'walk', time: 1, poses: [{ bone: 'root', rotation: [2, 0, 0, 0] }] });
    expect(track(walk(recorded), 'root', 'rotation').keys[1].value).toEqual([1, 0, 0, 0]);
    expect(() => parseOperation({ op: 'clip.key.set', name: 'walk', bone: 'root', property: 'rotation', time: 1, value: [0, 0, 0, 0] })).toThrow(/zero quaternion|Invalid/i);
    const wrongLength = failure(fixture(), [{ op: 'clip.key.set', name: 'walk', bone: 'root', property: 'rotation', time: 1, value: [0, 1, 0] }]);
    expect(wrongLength).toMatchObject({ operationIndex: 0, field: 'value' });
    expect(failure(fixture(), [{ op: 'clip.key.set', name: 'walk', bone: 'root', property: 'position', time: 1, value: [0, 0, 0, 1] }]).operationIndex).toBe(0);
  });

  it('removes an interior key and leaves every other track deep-equal', () => {
    const before = fixture();
    const project = applyOperation(before, { op: 'clip.key.remove', name: 'walk', bone: 'arm', property: 'rotation', time: 1.5 });
    expect(times(walk(project), 'arm', 'rotation')).toEqual([0, 1, 2]);
    expectUnrelatedUntouched(walk(before), walk(project), ['arm:rotation']);
  });

  it('refuses to remove an endpoint, to leave fewer than 2 keys or to remove a key that is not there', () => {
    const base = fixture(), first = { op: 'clip.key.set', name: 'walk', bone: 'root', property: 'rotation', time: 1, value: [0, 0, 0, 1] };
    const remove = (bone: string, property: string, time: number) => ({ op: 'clip.key.remove', name: 'walk', bone, property, time });
    expect(failure(base, [first, remove('arm', 'rotation', 0)])).toMatchObject({ operationIndex: 1, message: expect.stringMatching(/start endpoint of arm:rotation/) });
    expect(failure(base, [first, remove('arm', 'rotation', 2)]).message).toMatch(/end endpoint of arm:rotation/);
    expect(failure(base, [first, remove('arm', 'position', 1)]).message).toMatch(/has no key at time 1/);
    expect(failure(base, [first, remove('arm', 'position', 0)])).toMatchObject({ operationIndex: 1, message: expect.stringMatching(/fewer than 2 keys/) });
    expect(failure(base, [first, remove('hand', 'rotation', 1)]).message).toMatch(/no hand:rotation track/);
    const afterRemoval = applyOperation(applyOperation(base, first as Operation), remove('root', 'rotation', 1) as Operation);
    expect(walk(afterRemoval)).toStrictEqual(walk(base));
  });

  it('rejects an out-of-bounds time and a bad endpoint policy with the operation index', () => {
    const base = fixture(), pad = { op: 'clip.key.set', name: 'walk', bone: 'root', property: 'rotation', time: 1, value: [0, 0, 0, 1] };
    const late = failure(base, [pad, { ...pad, time: 2.5 }]);
    expect(late).toMatchObject({ operationIndex: 1, op: 'clip.key.set', part: 'walk' });
    expect(late.message).toMatch(/^Operation 1: clip\.key\.set "walk": Key time 2\.5 is outside clip "walk" \(0 to 2\)/);
    expect(failure(base, [pad, { op: 'clip.key.remove', name: 'walk', bone: 'root', property: 'rotation', time: 9 }]).message).toMatch(/Operation 1: .*outside clip/);
    expect(failure(base, [pad, { op: 'clip.key.record', name: 'walk', time: 9 }]).message).toMatch(/Operation 1: .*outside clip/);
    expect(failure(base, [pad, { ...pad, time: -1 }]).operationIndex).toBe(1);
    const policy = failure(base, [pad, { ...pad, endpoints: 'wrap' }]);
    expect(policy).toMatchObject({ operationIndex: 1, field: 'endpoints' });
    expect(failure(base, [pad, { op: 'clip.key.record', name: 'walk', time: 1, endpoints: 'wrap' }]).operationIndex).toBe(1);
    expect(failure(base, [pad, { ...pad, bone: 'ghost' }]).message).toMatch(/Operation 1: .*Unknown animation bone: ghost/);
  });

  it('records stored pose rotations of the selected bones, creating tracks and leaving other tracks deep-equal', () => {
    let project = applyOperation(fixture(), { op: 'pose', name: 'hand', rotation: [S, 0, 0, S] });
    const before = walk(project);
    project = applyOperation(project, { op: 'clip.key.record', name: 'walk', time: 0.75, bones: ['hand'] });
    const clip = walk(project);
    expect(track(clip, 'hand', 'rotation').keys).toEqual([{ time: 0, value: [0, 0, 0, 1] }, { time: 0.75, value: [S, 0, 0, S] }, { time: 2, value: [0, 0, 0, 1] }]);
    expect(clip.tracks).toHaveLength(before.tracks.length + 1);
    expectUnrelatedUntouched(before, clip, ['hand:rotation']);
    const everyBone = walk(applyOperation(project, { op: 'clip.key.record', name: 'walk', time: 0.75 }));
    for (const bone of ['root', 'arm', 'hand']) expect(times(everyBone, bone, 'rotation')).toContain(0.75);
    expect(times(everyBone, 'arm', 'position')).toEqual([0, 2]);
  });

  it('records explicit rotation and position poses, with the loop policy mirroring the endpoint', () => {
    const before = fixture();
    const project = applyOperation(before, { op: 'clip.key.record', name: 'walk', time: 0, endpoints: 'loop', poses: [{ bone: 'arm', rotation: [0, 0, 3, 4], position: [0, 0.2, 0] }] });
    const clip = walk(project);
    expect(track(clip, 'arm', 'rotation').keys.map(key => key.value)).toEqual([[0, 0, 0.6, 0.8], [0, 0, S, S], [0, 0, 0.5, Math.sqrt(0.75)], [0, 0, 0.6, 0.8]]);
    expect(track(clip, 'arm', 'position').keys.map(key => key.value)).toEqual([[0, 0.2, 0], [0, 0.2, 0]]);
    expectUnrelatedUntouched(walk(before), clip, ['arm:rotation', 'arm:position']);
    expect(failure(before, [{ op: 'clip.key.record', name: 'walk', time: 1, poses: [{ bone: 'arm', position: [0, 0, 0] }, { bone: 'arm', rotation: [0, 0, 0, 1] }] }]).message).toMatch(/Duplicate pose for bone: arm/);
    expect(failure(before, [{ op: 'clip.key.record', name: 'walk', time: 1, bones: ['ghost'] }]).message).toMatch(/Unknown animation bone: ghost/);
    expect(failure(before, [{ op: 'clip.key.record', name: 'walk', time: 1, poses: [{ bone: 'arm' }] }]).operationIndex).toBe(0);
  });
});

describe('batches', () => {
  const directories: string[] = [];
  const run = promisify(execFile);
  const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 15000, windowsHide: true });
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

  it('applies a mixed clip batch offline and fails the whole batch at the offending index', () => {
    const base = fixture();
    const batch = [
      { op: 'clip.clone', from: 'walk', name: 'run' },
      { op: 'clip.retime', name: 'run', duration: 1 },
      { op: 'clip.key.set', name: 'run', bone: 'arm', property: 'rotation', time: 0.25, value: [0, 0, 0.1, Math.sqrt(0.99)] },
      { op: 'clip.rename', name: 'run', to: 'sprint' },
    ];
    const { project } = planOperations(base, batch);
    expect(applyOperations(base, batch)).toStrictEqual(project);
    expect(project.clips.map(clip => clip.name)).toEqual(['walk', 'sprint']);
    expect(times(project.clips[1], 'arm', 'rotation')).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(() => applyOperations(base, [...batch, { op: 'clip.rename', name: 'sprint', to: 'walk' }])).toThrow(/Operation 4: clip\.rename "sprint": Clip name already in use: walk/);
    expect(walk(base).duration).toBe(2);
  });

  it('commits a batch as one undo step and a dry run reports clip changes without mutating', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-clip-ops-')); directories.push(directory);
    const invoke = async (...args: string[]) => JSON.parse((await cli('--workspace', directory, ...args)).stdout);
    await invoke('new', 'Clip batch');
    const setup = join(directory, 'setup.json'), edit = join(directory, 'edit.json');
    await writeFile(setup, JSON.stringify([
      { op: 'bone.add', bone: { name: 'root' } },
      { op: 'bone.add', bone: { name: 'arm', parent: 'root', position: [0, 1, 0] } },
      { op: 'clip.create', name: 'walk', duration: 2 },
    ]));
    await invoke('batch', setup);
    const prior = await invoke('state');
    await writeFile(edit, JSON.stringify([
      { op: 'clip.clone', from: 'walk', name: 'run' },
      { op: 'clip.retime', name: 'run', duration: 1 },
      { op: 'clip.key.set', name: 'run', bone: 'arm', property: 'rotation', time: 0.5, value: [0, 0, 3, 4] },
      { op: 'clip.key.record', name: 'walk', time: 1, poses: [{ bone: 'root', position: [0, 0.1, 0] }] },
      { op: 'clip.rename', name: 'run', to: 'sprint' },
    ]));
    const dry = await invoke('batch', edit, '--dry-run');
    expect(dry).toMatchObject({ ok: true, revision: prior.revision, changes: { clips: { added: ['sprint'], removed: [], updated: ['walk'] } } });
    expect(await invoke('state')).toEqual(prior);
    const applied = await invoke('batch', edit);
    expect(applied.project.clips.map((clip: Clip) => clip.name)).toEqual(['walk', 'sprint']);
    expect(applied.undo).toBe(prior.undo + 1);
    const undone = await invoke('undo');
    expect(undone.project).toEqual(prior.project);
    expect(undone.undo).toBe(prior.undo);
    const failing = join(directory, 'failing.json');
    await writeFile(failing, JSON.stringify([{ op: 'clip.clone', from: 'walk', name: 'copy' }, { op: 'clip.key.set', name: 'copy', bone: 'root', property: 'rotation', time: 99, value: [0, 0, 0, 1] }]));
    await expect(cli('--workspace', directory, 'batch', failing)).rejects.toMatchObject({ stderr: expect.stringContaining('"operationIndex":1') });
    expect((await invoke('state')).project).toEqual(prior.project);
  }, 60000);
});

describe('export', () => {
  it('plays an edited clip in an exported GLB the same as the authored project', async () => {
    let project = fixture();
    project = applyOperations(project, [
      { op: 'clip.clone', from: 'walk', name: 'stomp' },
      { op: 'clip.retime', name: 'stomp', duration: 1 },
      { op: 'clip.key.set', name: 'stomp', bone: 'arm', property: 'rotation', time: 0.25, value: [0, 0, 1, 1] },
      { op: 'clip.key.record', name: 'stomp', time: 0.5, poses: [{ bone: 'arm', rotation: [0, 0, 0, 2] }, { bone: 'root', position: [0, 0.05, 0] }] },
      { op: 'clip.key.remove', name: 'stomp', bone: 'arm', property: 'rotation', time: 0.75 },
      { op: 'clip.rename', name: 'stomp', to: 'stomp_final' },
    ]);
    const bytes = await exportGLB(project);
    const report = await verifyGLB(bytes);
    expect(report.errors).toBe(0);
    const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
    expect(loaded.animations.map(clip => clip.name).sort()).toEqual(['stomp_final', 'walk']);
    const built = buildScene(project);
    try {
      const expected = built.root.getObjectByName('limb') as SkinnedMesh, actual = loaded.scene.getObjectByName('limb') as SkinnedMesh;
      const wanted = new AnimationMixer(built.root), received = new AnimationMixer(loaded.scene);
      wanted.clipAction(built.clips.find(clip => clip.name === 'stomp_final')!).play();
      received.clipAction(loaded.animations.find(clip => clip.name === 'stomp_final')!).play();
      const count = expected.geometry.getAttribute('position').count;
      let moved = 0;
      for (const at of [0, 0.125, 0.25, 0.5, 0.8, 1]) {
        wanted.setTime(at); received.setTime(at);
        built.root.updateMatrixWorld(true); loaded.scene.updateMatrixWorld(true);
        for (let index = 0; index < count; index++) {
          const a = expected.applyBoneTransform(index, new Vector3().fromBufferAttribute(expected.geometry.getAttribute('position'), index)).applyMatrix4(expected.matrixWorld);
          const b = actual.applyBoneTransform(index, new Vector3().fromBufferAttribute(actual.geometry.getAttribute('position'), index)).applyMatrix4(actual.matrixWorld);
          expect(b.distanceTo(a)).toBeLessThan(2e-6);
          moved = Math.max(moved, a.distanceTo(new Vector3().fromBufferAttribute(expected.geometry.getAttribute('position'), index)));
        }
      }
      expect(moved).toBeGreaterThan(0.05);
    } finally { built.dispose(); }
  }, 30000);
});
