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
import { validateProject } from '../src/core/model.ts';
import { planOperations } from '../src/agent-contract.ts';
import { createCreature, type GaitParams } from '../src/recipes/index.ts';
import { quadrupedGaits } from '../src/recipes/quadruped.ts';
import { createRecipe, recipeIntent } from '../src/recipes/regenerate.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Operation, Project } from '../src/core/types.ts';

// Risks: a cycle time that is silently ignored or applied to the wrong body plan (wrong tuning), a leak into the shared gait tables
// (a tuned call changing later default recipes), a stored setting that a later load rejects (a corrupt project), and a refusal that builds anyway.
const clip = (project: Project, name: string) => project.clips.find(c => c.name === name)!;
const within = (actual: number, expected: number, tolerance: number) => expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

/** Backward speed of the front-left foot over its planted samples: the slope of z against time where the joint is within 0.5 mm of the lowest height (240 samples over the clip). */
function plantedSpeed(project: Project, gait: string, species: 'equine' | 'vulpine') {
  const built = buildScene(project);
  try {
    const action = built.clips.find(c => c.name === gait)!, mixer = new AnimationMixer(built.root);
    mixer.clipAction(action).play();
    const joint = built.bones.get(`leg_L_front_${species === 'equine' ? 'hoof' : 'paw'}`)!;
    const samples = Array.from({ length: 240 }, (_, i) => {
      const time = i / 240 * action.duration; mixer.setTime(time); built.root.updateMatrixWorld(true);
      const p = joint.getWorldPosition(new Vector3()); return { time, y: p.y, z: p.z };
    });
    const floor = Math.min(...samples.map(s => s.y)), planted = samples.filter(s => s.y <= floor + 0.0005);
    const meanT = planted.reduce((sum, s) => sum + s.time, 0) / planted.length, meanZ = planted.reduce((sum, s) => sum + s.z, 0) / planted.length;
    const slope = planted.reduce((sum, s) => sum + (s.time - meanT) * (s.z - meanZ), 0) / planted.reduce((sum, s) => sum + (s.time - meanT) ** 2, 0);
    return -slope;
  } finally { built.dispose(); }
}

it('duration sets the clip length and its key count, and the planted foot slows to match (Decision 2)', () => {
  const walk = quadrupedGaits.equine.walk;
  const base = createCreature('equine', { gaits: ['walk'] }), slow = createCreature('equine', { gaits: ['walk'], gaitParams: { walk: { duration: 2 } } });
  expect(clip(slow, 'walk').duration).toBe(2);
  expect(clip(slow, 'walk').tracks[0].keys).toHaveLength(Math.ceil(2 * 120) + 1);
  // The exported keys carry it: travel speed is stride / (stance * duration), so the planted foot moves slower by the ratio of the cycle times.
  const baseSpeed = plantedSpeed(base, 'walk', 'equine'), slowSpeed = plantedSpeed(slow, 'walk', 'equine');
  within(baseSpeed / (walk.stride / (walk.stance * walk.duration)), 1, 0.05);
  within(slowSpeed / (walk.stride / (walk.stance * 2)), 1, 0.05);
  const trot = createCreature('vulpine', { gaits: ['trot'], gaitParams: { trot: { duration: 1.0 } } });
  expect(clip(trot, 'trot').duration).toBe(1);
  expect(clip(trot, 'trot').tracks[0].keys).toHaveLength(Math.ceil(1.0 * 120) + 1);
});

it('the table value, an empty entry and an empty object leave every quadruped recipe byte-identical (Decision 8)', () => {
  for (const species of ['equine', 'vulpine'] as const) {
    const gaits = ['walk', 'trot', 'gallop'], expected = JSON.stringify(createCreature(species, { gaits }));
    const table: GaitParams = Object.fromEntries(gaits.map(g => [g, { duration: quadrupedGaits[species][g].duration }]));
    expect(JSON.stringify(createCreature(species, { gaits, gaitParams: table }))).toBe(expected);
    expect(JSON.stringify(createCreature(species, { gaits, gaitParams: { walk: {} } }))).toBe(expected);
    expect(JSON.stringify(createCreature(species, { gaits, gaitParams: {} }))).toBe(expected);
    // Negative control: the comparison can fail.
    expect(JSON.stringify(createCreature(species, { gaits, gaitParams: { walk: { duration: table.walk.duration! + 0.001 } } }))).not.toBe(expected);
  }
});

it('a tuned duration never changes the shared tables or the next default recipe (Decision 7)', () => {
  const before = JSON.stringify(createCreature('equine', { gaits: ['walk', 'trot', 'gallop'] })), tables = structuredClone(quadrupedGaits);
  expect(JSON.stringify(createCreature('equine', { gaits: ['walk', 'trot', 'gallop'], gaitParams: { walk: { duration: 3 }, gallop: { duration: 1 } } }))).not.toBe(before);
  expect(quadrupedGaits).toEqual(tables);
  expect(JSON.stringify(createCreature('equine', { gaits: ['walk', 'trot', 'gallop'] }))).toBe(before);
});

it('refuses a duration outside 0.3 to 4, a non-number, or an unknown gait, and accepts both bounds (Decision 2)', () => {
  const build = (gaitParams: unknown, gaits = ['walk']) => () => createCreature('equine', { gaits, gaitParams: gaitParams as GaitParams });
  expect(build({ walk: { duration: 0.29 } })).toThrow(/gait-params walk\.duration.*0\.3 to 4.*0\.29/);
  expect(build({ walk: { duration: 4.01 } })).toThrow(/gait-params walk\.duration.*0\.3 to 4.*4\.01/);
  expect(build({ walk: { duration: '2' } })).toThrow(/gait-params walk\.duration.*finite number/);
  expect(build({ run: { duration: 2 } })).toThrow(/run.*\(walk\)/);
  expect(clip(build({ walk: { duration: 0.3 } })(), 'walk').duration).toBe(0.3);
  expect(clip(build({ walk: { duration: 4 } })(), 'walk').duration).toBe(4);
});

it('the biped refuses duration with a pointer to --speed, in the library and in clip.regenerate (Decision 3)', () => {
  const message = 'gait-params walk.duration is not accepted for the biped; set the pace with --speed';
  expect(() => createCreature('biped', { gaitParams: { walk: { duration: 1.2 } } })).toThrow(message);
  expect(() => createCreature('biped', { gaitParams: { walk: { duration: '1.2' as never } } })).toThrow(message);
  expect(() => createCreature('biped', { gaitParams: { walk: { cadence: 1 } as never } })).toThrow(/stride, lift, stance, bob$/);
  const biped = createRecipe('biped');
  expect(() => planOperations(biped, [{ op: 'clip.regenerate', name: 'walk', params: { duration: 1.2 } } as Operation])).toThrow(message);
  // The pace is still set by --speed.
  expect(clip(createCreature('biped', { speed: 0.7 }), 'walk').duration).toBeCloseTo(0.52 / (0.62 * 0.7), 6);
});

it('stores the duration, keeps version 1, bounds it in the schema, and regenerates only the named clip (Decision 9, criterion 4)', () => {
  const gaits = ['walk', 'trot'], project = createRecipe('equine', { gaits, gaitParams: { walk: { duration: 2 } } });
  expect(project.version).toBe(1);
  expect(project.recipe).toEqual({ kind: 'equine', options: { gaits, gaitParams: { walk: { duration: 2 } } } });
  expect(recipeIntent('equine', { gaits, gaitParams: { walk: { duration: 1.6 } } }).options.gaitParams).toEqual({ walk: { duration: 1.6 } });
  const stored = (duration: number) => ({ ...project, recipe: { kind: 'equine', options: { gaitParams: { walk: { duration } } } } });
  expect(() => validateProject(stored(2))).not.toThrow();
  for (const duration of [0.29, 4.01]) expect(() => validateProject(stored(duration))).toThrow();
  expect(() => validateProject({ ...project, recipe: { kind: 'equine', options: { gaitParams: { walk: { cadence: 1 } } } } })).toThrow();
  const result = planOperations(project, [{ op: 'clip.regenerate', name: 'walk', params: { duration: 1.2 } } as Operation]).project;
  expect(clip(result, 'walk')).toEqual(clip(createCreature('equine', { gaits, gaitParams: { walk: { duration: 1.2 } } }), 'walk'));
  expect(clip(result, 'walk').duration).toBe(1.2);
  expect(clip(result, 'trot')).toEqual(clip(project, 'trot'));
  expect(result.recipe!.options.gaitParams).toEqual({ walk: { duration: 1.2 } });
});

// The CLI path: the same flags a user types.
const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('the CLI builds a tuned equine, refuses the biped duration and leaves the workspace untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-gait-duration-')); directories.push(directory);
  const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), '--workspace', directory, ...args], { timeout: 30000, windowsHide: true });
  const invoke = async (...args: string[]) => JSON.parse((await cli(...args)).stdout);
  await invoke('recipe', 'equine', '--gait-params', '{"walk":{"duration":2}}');
  const state = await invoke('state');
  expect(state.project.version).toBe(1);
  expect(state.project.recipe.options.gaitParams).toEqual({ walk: { duration: 2 } });
  expect(clip(state.project, 'walk').duration).toBe(2);
  expect((await invoke('inspect')).recipe).toEqual({ kind: 'equine' });
  const refused = async (...args: string[]) => {
    try { await cli('recipe', ...args); } catch (error) { expect(error).toMatchObject({ code: 1 }); return JSON.parse((error as { stderr: string }).stderr).error as { code: string; message: string }; }
    throw new Error('Expected CLI failure');
  };
  const before = JSON.stringify(await invoke('state'));
  const biped = await refused('biped', '--gait-params', '{"walk":{"duration":1.2}}');
  expect(biped).toMatchObject({ code: 'AUTHORING_ERROR', message: expect.stringContaining('gait-params walk.duration is not accepted for the biped; set the pace with --speed') });
  expect((await refused('equine', '--gait-params', '{"walk":{"duration":0.29}}')).message).toMatch(/gait-params walk\.duration.*0\.3 to 4/);
  expect(JSON.stringify(await invoke('state'))).toBe(before);
}, 60000);
