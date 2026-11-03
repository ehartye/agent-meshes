/** @lane merge
 * @subject src/recipes/index.ts
 */
import { afterEach, expect, it } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planOperations } from '../src/agent-contract.ts';
import { createCreature, type GaitParams } from '../src/recipes/index.ts';
import { quadrupedGaits } from '../src/recipes/quadruped.ts';
import { createRecipe, recipeIntent } from '../src/recipes/regenerate.ts';
import { createSpiderLeg } from '../src/recipes/spider-leg.ts';
import { spiderGait, spiderStep } from '../src/recipes/spider-motion.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Operation, Project } from '../src/core/types.ts';

// Risks: a setting that is silently ignored on the insectoid or arachnid (wrong tuning), a tuned call that leaks into the module constants
// (the next default recipe changes), an unreachable value that builds anyway or throws without the setting named, a stored recipe that
// regenerates the wrong clip names, and a default recipe that is no longer the one 0.41.0 produced.
const clip = (project: Project, name: string) => project.clips.find(c => c.name === name)!;
const build = (kind: 'insectoid' | 'arachnid', gaitParams: unknown, extra: object = {}) => createCreature(kind, { gaitParams: gaitParams as GaitParams, ...extra });
const regenerate = (project: Project, name: string, params?: object) => planOperations(project, [{ op: 'clip.regenerate', name, ...(params ? { params } : {}) } as Operation]).project;
const insectTable = { stride: 0.30, lift: 0.12, stance: 0.62, bob: 0.01, duration: 1.4 }, spiderTable = { stride: 0.25, lift: 0.075, stance: 0.70, bob: 0.003, duration: 1.6 };

/** Backward speed of one foot joint over its planted samples: the slope of z against time (unwrapped across the loop point) where the joint is within 0.5 mm of its lowest height (240 samples over the clip). */
function plantedSpeed(project: Project, clipName: string, bone: string) {
  const built = buildScene(project);
  try {
    const action = built.clips.find(c => c.name === clipName)!, mixer = new AnimationMixer(built.root);
    mixer.clipAction(action).play();
    const joint = built.bones.get(bone)!;
    const raw = Array.from({ length: 240 }, (_, i) => {
      const time = i / 240 * action.duration; mixer.setTime(time); built.root.updateMatrixWorld(true);
      const p = joint.getWorldPosition(new Vector3()); return { time, y: p.y, z: p.z };
    });
    // Start the walk at the top of the swing so the stance, which may straddle the loop point, is one unbroken stretch of time.
    const top = raw.findIndex(s => s.y === Math.max(...raw.map(r => r.y)));
    const samples = [...raw.slice(top), ...raw.slice(0, top).map(s => ({ ...s, time: s.time + action.duration }))];
    const floor = Math.min(...samples.map(s => s.y)), planted = samples.filter(s => s.y <= floor + 0.0005);
    const meanT = planted.reduce((sum, s) => sum + s.time, 0) / planted.length, meanZ = planted.reduce((sum, s) => sum + s.z, 0) / planted.length;
    return -planted.reduce((sum, s) => sum + (s.time - meanT) * (s.z - meanZ), 0) / planted.reduce((sum, s) => sum + (s.time - meanT) ** 2, 0);
  } finally { built.dispose(); }
}

it('the planted foot moves at stride / (stance * duration) of the stored settings, on both body plans (Decisions 2 and 4)', () => {
  const near = (actual: number, expected: number) => expect(Math.abs(actual / expected - 1)).toBeLessThan(0.05);
  near(plantedSpeed(createCreature('insectoid'), 'tripod', 'leg_L_1_ankle'), 0.30 / (0.62 * 1.4));
  near(plantedSpeed(build('insectoid', { tripod: { stride: 0.5 } }), 'tripod', 'leg_L_1_ankle'), 0.5 / (0.62 * 1.4));
  const slow = build('insectoid', { tripod: { duration: 2.5 } });
  expect(clip(slow, 'tripod').duration).toBe(2.5);
  expect(clip(slow, 'tripod').tracks[0].keys).toHaveLength(Math.ceil(2.5 * 60) + 1);
  near(plantedSpeed(slow, 'tripod', 'leg_L_1_ankle'), 0.30 / (0.62 * 2.5));
  near(plantedSpeed(createCreature('arachnid'), 'scuttle', 'leg_L_1_tip'), 0.25 / (0.70 * 1.6));
  near(plantedSpeed(build('arachnid', { scuttle: { stride: 0.3 } }), 'scuttle', 'leg_L_1_tip'), 0.3 / (0.70 * 1.6));
  // Stance is not ignored: the planted foot speed follows stride / (stance * duration) for another stance, and the default stance is unchanged above.
  near(plantedSpeed(build('insectoid', { tripod: { stance: 0.5 } }), 'tripod', 'leg_L_1_ankle'), 0.30 / (0.5 * 1.4));
  near(plantedSpeed(build('insectoid', { tripod: { stance: 0.8 } }), 'tripod', 'leg_L_1_ankle'), 0.30 / (0.8 * 1.4));
  near(plantedSpeed(build('arachnid', { scuttle: { stance: 0.5 } }), 'scuttle', 'leg_L_1_tip'), 0.25 / (0.5 * 1.6));
  near(plantedSpeed(build('arachnid', { scuttle: { stance: 0.85 } }), 'scuttle', 'leg_L_1_tip'), 0.25 / (0.85 * 1.6));
  const spider = build('arachnid', { scuttle: { duration: 2 } });
  expect(clip(spider, 'scuttle').duration).toBe(2);
  expect(clip(spider, 'scuttle').tracks[0].keys).toHaveLength(Math.ceil(2 * 60) + 1);
  // Lift and bob reach the keys too: the trunk rises by twice the bob.
  const peak = (project: Project, name: string) => Math.max(...clip(project, name).tracks[0].keys.map(k => k.value[1]));
  expect(peak(build('insectoid', { tripod: { bob: 0.03 } }), 'tripod')).toBeCloseTo(0.06, 6);
  expect(peak(build('arachnid', { scuttle: { bob: 0.02 } }), 'scuttle')).toBeCloseTo(0.04, 6);
});

it('a custom --leg-phases clip name keys the entry, and the entry names a clip that exists (Decision 4)', () => {
  const legPhases = { ripple: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], tripod: [0, 0.5, 0, 0.5, 0, 0.5] };
  const project = build('insectoid', { ripple: { stride: 0.45, duration: 2 } }, { legPhases });
  expect(clip(project, 'ripple').duration).toBe(2);
  expect(clip(project, 'tripod')).toEqual(clip(createCreature('insectoid', { legPhases }), 'tripod'));
  expect(() => build('insectoid', { together: { stride: 0.4 } }, { legPhases })).toThrow(/names the clip together.*\(ripple, tripod\)/);
  expect(() => build('insectoid', { walk: { stride: 0.4 } })).toThrow(/names the clip walk.*\(tripod\)/);
  expect(() => build('arachnid', { tripod: { stride: 0.4 } })).toThrow(/names the clip tripod.*\(scuttle\)/);
  expect(() => createCreature('arachnid', { legPhases })).toThrow(/Leg phases are only configurable for insectoid/);
});

it('the reach ceilings of Decision 6 build and the next 0.01 step is refused with the setting named', () => {
  const ceilings: [kind: 'insectoid' | 'arachnid', clipName: string, setting: string, works: number][] = [
    ['insectoid', 'tripod', 'stride', 0.79], ['insectoid', 'tripod', 'lift', 1.59], ['insectoid', 'tripod', 'bob', 0.22],
    ['arachnid', 'scuttle', 'stride', 0.37], ['arachnid', 'scuttle', 'lift', 1.83], ['arachnid', 'scuttle', 'bob', 0.05],
  ];
  for (const [kind, clipName, setting, works] of ceilings) {
    expect(() => build(kind, { [clipName]: { [setting]: works } }), `${kind} ${setting} ${works}`).not.toThrow();
    const failing = Math.round((works + 0.01) * 100) / 100;
    expect(() => build(kind, { [clipName]: { [setting]: failing } }), `${kind} ${setting} ${failing}`).toThrow(new RegExp(`Cannot build the ${kind} ${clipName} clip with gait-params ${clipName}\\.${setting}=${failing}: (Unreachable leg target|Spider)`));
  }
  // The label is the real kind, never the biped's.
  expect(() => build('insectoid', { tripod: { stride: 0.8 } })).toThrow(/Cannot build the insectoid tripod clip/);
  expect(() => build('insectoid', { tripod: { stride: 0.8 } })).not.toThrow(/biped/i);
});

it('refuses an unknown setting, a bad value or the strandbeest before anything is built (Decisions 2, 4 and 11)', () => {
  for (const kind of ['insectoid', 'arachnid'] as const) {
    const name = kind === 'insectoid' ? 'tripod' : 'scuttle';
    expect(() => build(kind, { [name]: { cadence: 1 } })).toThrow(new RegExp(`gait-params ${name}\\.cadence.*stride, lift, stance, bob, duration`));
    expect(() => build(kind, { [name]: { stride: -1 } })).toThrow(new RegExp(`gait-params ${name}\\.stride`));
    expect(() => build(kind, { [name]: { stance: 1 } })).toThrow(new RegExp(`gait-params ${name}\\.stance`));
    expect(() => build(kind, { [name]: { bob: 'high' } })).toThrow(new RegExp(`gait-params ${name}\\.bob`));
    for (const duration of [0.29, 4.01]) expect(() => build(kind, { [name]: { duration } })).toThrow(new RegExp(`gait-params ${name}\\.duration.*0\\.3 to 4`));
    expect(() => build(kind, { [name]: 3 })).toThrow(new RegExp(`gait-params ${name} `));
    expect(clip(build(kind, { [name]: { duration: 4 } }), name).duration).toBe(4);
  }
  expect(() => createCreature('strandbeest', { gaitParams: { walk: { stride: 0.4 } } })).toThrow('Gait parameters (--gait-params) are only configurable for biped, equine, vulpine, insectoid and arachnid, not strandbeest');
  // A stance below 0.5 is accepted (Decision 5); only the three-feet-down property of the tripod is gone.
  expect(() => build('insectoid', { tripod: { stance: 0.4 } })).not.toThrow();
});

it('the table value, an empty entry and an empty object leave both recipes byte-identical (Decision 8)', () => {
  for (const [kind, name, table] of [['insectoid', 'tripod', insectTable], ['arachnid', 'scuttle', spiderTable]] as const) {
    const expected = JSON.stringify(createCreature(kind));
    expect(JSON.stringify(build(kind, { [name]: table }))).toBe(expected);
    expect(JSON.stringify(build(kind, { [name]: {} }))).toBe(expected);
    expect(JSON.stringify(build(kind, {}))).toBe(expected);
    // Negative control: the comparison can fail.
    expect(JSON.stringify(build(kind, { [name]: { stride: table.stride + 0.001 } }))).not.toBe(expected);
  }
});

it('a tuned call never changes the module constants or the next default recipe (Decision 7)', () => {
  const defaults = ['insectoid', 'arachnid', 'equine', 'vulpine'].map(kind => JSON.stringify(createCreature(kind as 'equine'))), tables = structuredClone(quadrupedGaits), spider = structuredClone(spiderGait);
  build('arachnid', { scuttle: { stride: 0.3, lift: 0.1, stance: 0.6, bob: 0.01, duration: 2 } });
  build('insectoid', { tripod: { stride: 0.5, lift: 0.2, stance: 0.55, bob: 0.02, duration: 2 } });
  createCreature('equine', { gaitParams: { walk: { stride: 0.5, duration: 2 } } });
  expect(spiderGait).toEqual(spider);
  expect(quadrupedGaits).toEqual(tables);
  expect(['insectoid', 'arachnid', 'equine', 'vulpine'].map(kind => JSON.stringify(createCreature(kind as 'equine')))).toEqual(defaults);
});

it('the pinned arachnid signatures keep their meaning with the optional tuning left out (Decision 7)', () => {
  expect(spiderStep(0.3, -1, 2)).toEqual(spiderStep(0.3, -1, 2, spiderGait));
  const leg = createSpiderLeg(-1, 2);
  expect(leg.sample(0.3, 0.003)).toEqual(leg.sample(0.3, 0.003, spiderGait));
  expect(spiderStep(0.3, -1, 2, { stride: 0.3, lift: spiderGait.lift, stance: spiderGait.stance })).not.toEqual(spiderStep(0.3, -1, 2));
});

it('stores the settings under the clip name and the default gaits follow the kind (Decision 12)', () => {
  expect(recipeIntent('insectoid', { gaitParams: { tripod: { stride: 0.5 } } }).options.gaitParams).toEqual({ tripod: { stride: 0.5 } });
  expect(recipeIntent('arachnid', { gaitParams: { scuttle: { duration: 2 } } }).options.gaitParams).toEqual({ scuttle: { duration: 2 } });
  const legPhases = { ripple: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], tripod: [0, 0.5, 0, 0.5, 0, 0.5] };
  expect(recipeIntent('insectoid', { legPhases, gaitParams: { ripple: { stride: 0.4 } } }).options.gaitParams).toEqual({ ripple: { stride: 0.4 } });
  expect(() => recipeIntent('insectoid', { gaitParams: { walk: { stride: 0.4 } } })).toThrow(/names the clip walk.*\(tripod\)/);
});

it('clip.regenerate rebuilds tripod and scuttle with and without params, merging per setting and touching only that clip (criterion 9)', () => {
  for (const [kind, name] of [['insectoid', 'tripod'], ['arachnid', 'scuttle']] as const) {
    const project = createRecipe(kind);
    expect(clip(regenerate(project, name), name)).toEqual(clip(project, name));
    const first = regenerate(project, name, { stride: 0.35 });
    expect(clip(first, name)).toEqual(clip(createCreature(kind, { gaitParams: { [name]: { stride: 0.35 } } }), name));
    expect(first.recipe!.options.gaitParams).toEqual({ [name]: { stride: 0.35 } });
    const second = regenerate(first, name, { duration: 2 });
    expect(second.recipe!.options.gaitParams).toEqual({ [name]: { stride: 0.35, duration: 2 } });
    expect(clip(second, name)).toEqual(clip(createCreature(kind, { gaitParams: { [name]: { stride: 0.35, duration: 2 } } }), name));
    expect({ ...second, clips: [], recipe: undefined }).toEqual({ ...project, clips: [], recipe: undefined });
    // A hand-edited clip is restored from the stored settings, not from the table.
    const hand = planOperations(first, [{ op: 'clip.key.set', name, bone: 'root', property: 'position', time: 0.1, value: [0, 0.2, 0] } as Operation]).project;
    expect(clip(regenerate(hand, name), name)).toEqual(clip(first, name));
    // An unreachable value changes nothing and names the setting.
    const before = structuredClone(project);
    expect(() => regenerate(project, name, { stride: 2 })).toThrow(new RegExp(`gait-params ${name}\\.stride=2`));
    expect(project).toEqual(before);
  }
});

it('regenerates the custom clip names of a stored --leg-phases, keeps hand edits elsewhere and still raises RECIPE_STALE (criterion 9)', () => {
  const legPhases = { ripple: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], tripod: [0, 0.5, 0, 0.5, 0, 0.5] };
  const project = createRecipe('insectoid', { legPhases });
  const edited = planOperations(project, [{ op: 'update', name: 'abdomen', changes: { color: '#112233' } } as Operation, { op: 'clip.key.set', name: 'tripod', bone: 'root', property: 'position', time: 0.1, value: [0, 0.2, 0] } as Operation]).project;
  const result = regenerate(edited, 'ripple', { stride: 0.45 });
  expect(clip(result, 'ripple')).toEqual(clip(createCreature('insectoid', { legPhases, gaitParams: { ripple: { stride: 0.45 } } }), 'ripple'));
  expect(clip(result, 'tripod')).toEqual(clip(edited, 'tripod'));
  expect(result.parts.find(part => part.name === 'abdomen')!.color).toBe('#112233');
  expect(result.clips.map(c => c.name)).toEqual(['ripple', 'tripod']);
  expect(() => regenerate(project, 'tripod', { stride: 0.45 })).not.toThrow();
  expect(() => regenerate(project, 'walk')).toThrow(/ripple, tripod/);
  for (const [kind, name] of [['insectoid', 'tripod'], ['arachnid', 'scuttle']] as const) {
    const stale = planOperations(createRecipe(kind), [{ op: 'remove', name: 'thorax' } as Operation]).project;
    for (const params of [undefined, { stride: 0.3 }]) {
      let code: unknown;
      try { regenerate(stale, name, params); } catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe('RECIPE_STALE');
    }
  }
});

// The CLI path: the flags a user types, and a second process for the regenerate.
const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('the CLI builds a tuned insectoid and arachnid, refuses an unreachable stride, and a later process regenerates (criteria 6 to 9)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-gait-insect-')); directories.push(directory);
  const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), '--workspace', directory, ...args], { timeout: 30000, windowsHide: true });
  const invoke = async (...args: string[]) => JSON.parse((await cli(...args)).stdout);
  const refused = async (...args: string[]) => {
    try { await cli(...args); } catch (error) { expect(error).toMatchObject({ code: 1 }); return JSON.parse((error as { stderr: string }).stderr).error as { code: string; message: string }; }
    throw new Error('Expected CLI failure');
  };
  await invoke('recipe', 'insectoid', '--gait-params', '{"tripod":{"stride":0.5}}');
  let state = await invoke('state');
  expect(state.project.recipe).toEqual({ kind: 'insectoid', options: { gaitParams: { tripod: { stride: 0.5 } } } });
  expect((await invoke('inspect')).recipe).toEqual({ kind: 'insectoid' });
  const before = JSON.stringify(state);
  expect(await refused('recipe', 'insectoid', '--gait-params', '{"tripod":{"stride":0.8}}')).toMatchObject({ code: 'AUTHORING_ERROR', message: expect.stringContaining('gait-params tripod.stride=0.8') });
  expect((await refused('recipe', 'arachnid', '--gait-params', '{"scuttle":{"stride":0.38}}')).message).toContain('gait-params scuttle.stride=0.38');
  expect((await refused('recipe', 'arachnid', '--gait-params', '{"scuttle":{}}', '--leg-phases', '{"x":[0,0,0,0,0,0]}')).message).toMatch(/Leg phases/);
  expect((await refused('recipe', 'strandbeest', '--gait-params', '{"walk":{}}')).message).toContain('insectoid and arachnid');
  expect(JSON.stringify(await invoke('state'))).toBe(before);
  await invoke('recipe', 'arachnid', '--gait-params', '{"scuttle":{"stride":0.3}}');
  await invoke('op', '{"op":"clip.regenerate","name":"scuttle","params":{"duration":2}}');
  state = await invoke('state');
  expect(state.project.recipe.options.gaitParams).toEqual({ scuttle: { stride: 0.3, duration: 2 } });
  expect(clip(state.project, 'scuttle').duration).toBe(2);
}, 90000);
