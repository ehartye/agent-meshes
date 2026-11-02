/** @lane merge
 * @subject src/recipes/index.ts
 */
import { describe, expect, it } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import { analyzeGait, loadGait } from '../src/gait-analysis.ts';
import { exportGLB } from '../src/export.ts';
import { createCreature, validateGaitOverride, type GaitParams } from '../src/recipes/index.ts';
import { quadrupedGaits } from '../src/recipes/quadruped.ts';
import { buildScene } from '../src/render/scene.ts';

type Project = ReturnType<typeof createCreature>;
const clip = (project: Project, name: string) => project.clips.find(c => c.name === name)!;
const within = (actual: number, expected: number, tolerance: number) => expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
const rootRise = (project: Project, name: string) => Math.max(...clip(project, name).tracks.find(t => t.bone === 'root' && t.property === 'position')!.keys.map(k => k.value[1]));

// The biped table is private to the recipe, so the values are repeated here to prove the override path is the only difference.
const bipedTable: GaitParams = { walk: { stride: 0.52, lift: 0.14, stance: 0.62, bob: 0.024 }, run: { stride: 0.8, lift: 0.3, stance: 0.4, bob: 0.04 } };
const quadrupedTable = (species: 'equine' | 'vulpine'): GaitParams => Object.fromEntries(Object.entries(quadrupedGaits[species]).map(([gait, g]) => [gait, { stride: g.stride, lift: g.lift, stance: g.stance, bob: g.bob }]));

describe('defaults are unchanged (a regression in every recipe)', () => {
  const cases = [
    ['biped', { gaits: ['walk', 'run'] }, bipedTable],
    ['equine', { gaits: ['walk', 'trot', 'gallop'] }, quadrupedTable('equine')],
    ['vulpine', { gaits: ['walk', 'trot', 'gallop'] }, quadrupedTable('vulpine')],
  ] as const;
  for (const [kind, base, table] of cases) it(`${kind}: no option, {} and the table values give the same project`, () => {
    const expected = JSON.stringify(createCreature(kind, base));
    expect(JSON.stringify(createCreature(kind, { ...base, gaitParams: {} }))).toBe(expected);
    expect(JSON.stringify(createCreature(kind, { ...base, gaitParams: table }))).toBe(expected);
    // Negative control: the comparison can fail.
    const nudged = { ...table, walk: { ...table.walk, stride: table.walk.stride! + 0.001 } };
    expect(JSON.stringify(createCreature(kind, { ...base, gaitParams: nudged }))).not.toBe(expected);
  });
});

describe('tuning leaves the shared gait tables alone (a tuned call must not change later default recipes)', () => {
  // Every setting at a non-default value, for every gait of each body plan.
  const tuning = { stride: 0.3, lift: 0.1, stance: 0.55, bob: 0.015 };
  const cases = [
    ['biped', ['walk', 'run']],
    ['equine', ['walk', 'trot', 'gallop']],
    ['vulpine', ['walk', 'trot', 'gallop']],
  ] as const;
  for (const [kind, gaits] of cases) it(`${kind}: a tuned call changes neither the tables nor the next default recipe`, () => {
    const options = { gaits: [...gaits] };
    const before = JSON.stringify(createCreature(kind, options));
    const tables = structuredClone(quadrupedGaits);
    const gaitParams = Object.fromEntries(gaits.map(gait => [gait, { ...tuning, ...(gait === 'run' ? { stride: 0.6 } : {}), ...(gait === 'gallop' ? { stride: 0.4, lift: 0.3, stance: 0.25, bob: 0.006 } : {}) }]));
    // Negative control: the tuning really changes the recipe, so a leak would be visible in the comparison below.
    expect(JSON.stringify(createCreature(kind, { ...options, gaitParams }))).not.toBe(before);
    expect(quadrupedGaits).toEqual(tables);
    expect(JSON.stringify(createCreature(kind, options))).toBe(before);
  });
});

describe('biped settings', () => {
  it('bob is the amplitude: the trunk rises by twice the bob', () => {
    expect(rootRise(createCreature('biped', { gaitParams: { walk: { bob: 0.04 } } }), 'walk')).toBeCloseTo(0.08, 6);
  });
  // Measured as the gait command does, on the exported clip: the foot joint's height curve and the stride over stance.
  const walkReport = async (gaitParams?: GaitParams) => analyzeGait(await loadGait(await exportGLB(createCreature('biped', { gaitParams }))), { clip: 'walk' });
  it('lift raises the foot: the foot joint peak rises from 0.0904 to 0.1266', async () => {
    const peak = async (gaitParams?: GaitParams) => Math.max(...(await walkReport(gaitParams)).curves.footHeightLeft);
    within(await peak(), 0.0904, 0.002);
    within(await peak({ walk: { lift: 0.2 } }), 0.1266, 0.002);
  });
  it('stance sets the stride over stance and the travel speed', async () => {
    const { metrics } = await walkReport({ walk: { stance: 0.5 } });
    within(metrics.stride.meters, 0.52 / 0.5, 0.02);
    within(metrics.stride.travelSpeed, 0.52 / (0.5 * 1.2), 0.02);
  });
  it('--speed uses the effective stride and stance for the cycle length', () => {
    const project = createCreature('biped', { speed: 0.7, gaitParams: { walk: { stride: 0.4, stance: 0.5 } } });
    expect(clip(project, 'walk').duration).toBeCloseTo(0.4 / (0.5 * 0.7), 6);
  });
  it('a setting for one clip leaves the other clip as it was', () => {
    const base = createCreature('biped', { gaits: ['walk', 'run'] });
    const tuned = createCreature('biped', { gaits: ['walk', 'run'], gaitParams: { run: { stride: 0.7 } } });
    expect(clip(tuned, 'walk')).toEqual(clip(base, 'walk'));
    expect(clip(tuned, 'run')).not.toEqual(clip(base, 'run'));
  });
});

/** Sample the front-left foot joint through the scene graph: 240 even samples over the clip; planted means within 0.5 mm of the lowest height seen. */
function foot(kind: 'equine' | 'vulpine', gait: string, gaitParams?: GaitParams) {
  const project = createCreature(kind, { gaits: [gait], gaitParams });
  const built = buildScene(project);
  try {
    const action = built.clips.find(c => c.name === gait)!, mixer = new AnimationMixer(built.root);
    mixer.clipAction(action).play();
    const joint = built.bones.get(`leg_L_front_${kind === 'equine' ? 'hoof' : 'paw'}`)!;
    const samples = Array.from({ length: 240 }, (_, i) => {
      mixer.setTime(i / 240 * action.duration); built.root.updateMatrixWorld(true);
      return joint.getWorldPosition(new Vector3());
    });
    const floor = Math.min(...samples.map(p => p.y));
    const planted = samples.filter(p => p.y <= floor + 0.0005);
    const z = planted.map(p => p.z);
    return { project, range: Math.max(...z) - Math.min(...z), peak: Math.max(...samples.map(p => p.y)) - floor, fraction: planted.length / samples.length };
  } finally { built.dispose(); }
}

describe('quadruped settings take effect where the table says (wrong tuning)', () => {
  const table = quadrupedGaits.equine.walk;
  const base = foot('equine', 'walk');
  it('stride sets how far a planted hoof travels', () => {
    const wider = foot('equine', 'walk', { walk: { stride: 0.5 } });
    expect(base.range / table.stride).toBeCloseTo(1, 1);
    expect(wider.range / base.range).toBeCloseTo(0.5 / table.stride, 2);
  });
  it('lift sets the hoof clearance', () => {
    within(base.peak, table.lift, 0.002);
    within(foot('equine', 'walk', { walk: { lift: 0.15 } }).peak, 0.15, 0.002);
  });
  it('stance sets the planted fraction of the cycle', () => {
    const shorter = foot('equine', 'walk', { walk: { stance: 0.6 } });
    within(shorter.fraction, 0.621, 0.01);
    expect(shorter.fraction).toBeLessThan(base.fraction);
  });
  it('bob is the amplitude: the trunk rises by twice the bob', () => {
    expect(rootRise(foot('equine', 'walk', { walk: { bob: 0.02 } }).project, 'walk')).toBeCloseTo(0.04, 6);
  });
  it('a vulpine paw follows its own table', () => {
    const own = quadrupedGaits.vulpine.walk, tuned = foot('vulpine', 'walk', { walk: { stride: 0.4, lift: 0.12 } });
    expect(foot('vulpine', 'walk').range / own.stride).toBeCloseTo(1, 1);
    expect(tuned.range / 0.4).toBeCloseTo(1, 1);
    within(tuned.peak, 0.12, 0.003);
  });
  it('a high gallop lift still validates and loops', () => {
    const gallop = clip(createCreature('equine', { gaits: ['gallop'], gaitParams: { gallop: { lift: 0.4 } } }), 'gallop');
    for (const track of gallop.tracks) expect(track.keys.at(-1)!.value).toEqual(track.keys[0].value);
  });
});

describe('refusals name the setting (silent bad output)', () => {
  const refused: [string, () => unknown, RegExp][] = [
    ['negative stride', () => createCreature('biped', { gaitParams: { walk: { stride: -0.1 } } }), /gait-params walk\.stride.*-0\.1/],
    ['non-finite lift', () => createCreature('equine', { gaitParams: { walk: { lift: Infinity } } }), /gait-params walk\.lift/],
    ['text bob', () => createCreature('biped', { gaitParams: { walk: { bob: 'high' as unknown as number } } }), /gait-params walk\.bob.*high/],
    ['stance of one', () => createCreature('biped', { gaitParams: { walk: { stance: 1 } } }), /gait-params walk\.stance/],
    ['gallop stance closing the flight window', () => createCreature('equine', { gaits: ['gallop'], gaitParams: { gallop: { stance: 0.6 } } }), /gait-params gallop\.stance/],
    ['unknown setting', () => createCreature('biped', { gaitParams: { walk: { cadence: 1 } as never } }), /gait-params walk\.cadence.*stride, lift, stance, bob/],
    ['entry that is not an object', () => createCreature('biped', { gaitParams: { walk: 3 as never } }), /gait-params walk /],
    ['gait that is not generated', () => createCreature('biped', { gaitParams: { run: { stride: 0.5 } } }), /run.*\(walk\)/],
    ['default quadruped gaits exclude the gallop', () => createCreature('equine', { gaitParams: { gallop: { lift: 0.4 } } }), /gallop.*\(walk, trot\)/],
    ['reach exceeded on the run', () => createCreature('biped', { gaits: ['run'], gaitParams: { run: { stride: 0.9 } } }), /gait-params run\.stride=0\.9.*Unreachable leg target/],
    ['reach exceeded on the equine walk', () => createCreature('equine', { gaitParams: { walk: { stride: 5 } } }), /equine walk.*gait-params walk\.stride=5.*Unreachable leg target/],
    ['speed outside the cycle limit keeps its message', () => createCreature('biped', { speed: 40, gaitParams: { walk: { stride: 0.4 } } }), /speed of 40.*cycle/],
    ...(['insectoid', 'arachnid', 'strandbeest'] as const).map(kind => [`${kind} refuses the option`, () => createCreature(kind, { gaitParams: { walk: { stride: 0.4 } } }), new RegExp(`--gait-params.*not ${kind}`)] as [string, () => unknown, RegExp]),
  ];
  for (const [label, build, message] of refused) it(label, () => expect(build).toThrow(message));

  it('exports the single-entry check', () => {
    expect(validateGaitOverride('walk', { stride: 0.4 })).toEqual({ stride: 0.4 });
    expect(() => validateGaitOverride('gallop', { stance: 0.7 })).toThrow(/gait-params gallop\.stance/);
  });
});
