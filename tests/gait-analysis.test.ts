import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alignCurves, analyzeGait, evaluateGait, kneeInterior, loadGait, pearson, resolveGaitBones, symmetrizeCurves } from '../src/gait-analysis.ts';
import { twistHands, walkerGLB } from './helpers/gait-glb.ts';

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('curve helpers', () => {
  it('correlates shapes, not scale, and aligns a circular phase shift', () => {
    const n = 64, wave = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * i / n) + 0.3 * Math.cos(4 * Math.PI * i / n));
    expect(pearson(wave, wave.map(v => 3 * v + 2))).toBeCloseTo(1, 10);
    expect(pearson(wave, wave.map(v => -v))).toBeCloseTo(-1, 10);
    expect(pearson(wave, wave.map(() => 1))).toBe(0);
    const shifted = wave.map((_, i) => wave[(i + 10) % n]);
    const aligned = alignCurves({ a: shifted, b: shifted.map(v => v * v) }, { a: wave, b: wave.map(v => v * v) });
    expect(aligned.shift).toBe(10);
    expect(aligned.r.a).toBeCloseTo(1, 10);
    expect(aligned.r.b).toBeCloseTo(1, 10);
  });

  it('symmetrizes curves into their mirrored-gait parts: even for the body, odd for lateral, paired for legs', () => {
    const n = 8, i = [...Array(n).keys()], wave = (h: number, p = 0) => i.map(k => Math.cos(2 * Math.PI * h * (k / n - p)));
    const sym = symmetrizeCurves({ pelvisHeight: wave(1).map((v, k) => v + wave(2)[k]), pelvisRoll: wave(1).map((v, k) => v + wave(2)[k]),
      kneeLeft: wave(1), kneeRight: wave(1, 0.25) });
    sym.pelvisHeight.forEach((v, k) => expect(v).toBeCloseTo(wave(2)[k], 10));
    sym.pelvisRoll.forEach((v, k) => expect(v).toBeCloseTo(wave(1)[k], 10));
    // Right shifted by a half cycle joins left: (cos(x) + cos(x + pi/2 + pi)) / 2, and right is left a half cycle on.
    sym.kneeLeft.forEach((v, k) => expect(v).toBeCloseTo((wave(1)[k] + wave(1, 0.25)[(k + n / 2) % n]) / 2, 10));
    sym.kneeRight.forEach((v, k) => expect(v).toBeCloseTo(sym.kneeLeft[(k + n / 2) % n], 10));
  });

  it('measures knee interior angles, above 180 degrees only when the knee bends backward', () => {
    const forward: [number, number, number] = [0, 0, 1];
    expect(kneeInterior([0, 1, 0], [0, 0.5, 0], [0, 0, 0], forward)).toBeCloseTo(180, 6);
    expect(kneeInterior([0, 1, 0], [0, 0.5, 0.1], [0, 0, 0], forward)).toBeLessThan(180);
    expect(kneeInterior([0, 1, 0], [0, 0.5, -0.1], [0, 0, 0], forward)).toBeGreaterThan(180);
  });

  it('resolves raised-hock metatarsals as the ankle chain, retaining grounded toes', () => {
    const names = ['pelvis', 'spine_low', 'spine_high', 'neck_lower', 'neck_middle', 'neck_upper', 'head',
      ...['l', 'r'].flatMap(s => ['thigh', 'shin', 'metatarsal', 'toes', 'upperarm', 'forearm', 'hand'].map(n => `${n}_${s}`))];
    const parent = {head:'neck_upper', neck_upper:'neck_middle', neck_middle:'neck_lower', neck_lower:'spine_high', spine_high:'spine_low', spine_low:'pelvis'};
    const rig = resolveGaitBones(names, n => parent[n as keyof typeof parent] ?? null);
    expect(rig.legs.a).toEqual({thigh:'thigh_l', calf:'shin_l', foot:'metatarsal_l', toe:'toes_l'});
    expect(rig.spine).toEqual(['spine_low', 'spine_high']);
  });

  it('resolves stylized and UE-mannequin bone names, choosing left and right by geometry', () => {
    const stylized = resolveGaitBones(['rig-root', 'rig-pelvis', 'rig-spine', 'rig-chest', 'rig-neck', 'rig-head', 'rig-left-thigh', 'rig-left-shin', 'rig-left-foot', 'rig-right-thigh', 'rig-right-shin', 'rig-right-foot', 'rig-left-upper-arm', 'rig-left-forearm', 'rig-right-upper-arm', 'rig-right-forearm'],
      name => ({ 'rig-head': 'rig-neck', 'rig-neck': 'rig-chest', 'rig-chest': 'rig-spine', 'rig-spine': 'rig-pelvis' } as Record<string, string>)[name] ?? null);
    expect(stylized).toMatchObject({ pelvis: 'rig-pelvis', spine: ['rig-spine', 'rig-chest'], neck: 'rig-neck', head: 'rig-head' });
    expect(stylized.legs.a).toMatchObject({ thigh: 'rig-left-thigh', calf: 'rig-left-shin', foot: 'rig-left-foot' });
    expect(stylized.arms.b).toMatchObject({ upper: 'rig-right-upper-arm', lower: 'rig-right-forearm' });
    const ue = resolveGaitBones(['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r'],
      name => ({ head: 'neck_01', neck_01: 'spine_03', spine_03: 'spine_02', spine_02: 'spine_01', spine_01: 'pelvis' } as Record<string, string>)[name] ?? null);
    expect(ue).toMatchObject({ pelvis: 'pelvis', spine: ['spine_01', 'spine_02', 'spine_03'], neck: 'neck_01', head: 'head' });
    expect(ue.legs.a).toMatchObject({ thigh: 'thigh_l', calf: 'calf_l', foot: 'foot_l', toe: 'ball_l' });
    const m = (n: string) => `mixamorig:${n}`;
    const mixamo = resolveGaitBones(['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'RightShoulder', 'RightArm', 'RightForeArm'].map(m),
      name => ({ [m('Head')]: m('Neck'), [m('Neck')]: m('Spine2'), [m('Spine2')]: m('Spine1'), [m('Spine1')]: m('Spine'), [m('Spine')]: m('Hips') } as Record<string, string>)[name] ?? null);
    expect(mixamo).toMatchObject({ pelvis: m('Hips'), spine: [m('Spine'), m('Spine1'), m('Spine2')], neck: m('Neck'), head: m('Head') });
    expect(mixamo.legs.b).toMatchObject({ thigh: m('RightUpLeg'), calf: m('RightLeg'), foot: m('RightFoot'), toe: m('RightToeBase') });
    expect(mixamo.arms.a).toMatchObject({ upper: m('LeftArm'), lower: m('LeftForeArm') });
  });
});

describe('analyzeGait on a synthetic walker', () => {
  it('recovers the analytic gait: bob, lean, spine flex, counter-rotation, pelvis drop, contacts and arms', async () => {
    const report = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const m = report.metrics;
    expect(report.forward.map(v => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0, 1]);
    expect(report.height).toBe(1.75);
    expect(report.travelSpeed).toBeCloseTo(0.6 / (0.55 * 1.2), 6);
    expect(report.contactSource).toBe('declared');
    expect(m.seam).toBeLessThan(1e-5);
    expect(m.groundError).toBeLessThan(1e-4);
    expect(m.skate).toBeLessThan(0.05);
    expect(m.stanceSpeedRatio.min).toBeGreaterThan(0.97);
    expect(m.stanceSpeedRatio.max).toBeLessThan(1.03);
    expect(m.flightFraction).toBe(0);
    expect(m.headBob).toBeCloseTo(0.04, 2);
    expect(m.headBobPeaks).toBe(2);
    expect(m.headPitchRatio).toBeCloseTo(0.5, 1);
    const trunk = Math.atan2(0.5 * Math.sin(6 * Math.PI / 180), 0.1 + 0.5 * Math.cos(6 * Math.PI / 180)) * 180 / Math.PI;
    expect(m.torsoLeanDeg).toBeCloseTo(trunk, 0);
    expect(m.spineJointRangeDeg.spine_01).toBeCloseTo(8, 1);
    expect(m.spineJointRangeDeg.spine_02).toBeGreaterThan(8);
    expect(m.counterRotationDeg).toBeGreaterThan(15.5);
    expect(m.counterRotationDeg).toBeLessThan(16.5);
    expect(m.counterRotationCorrelation).toBeLessThan(-0.9);
    expect(m.pelvisDropDeg).toBeGreaterThan(4.5);
    expect(m.pelvisDropDeg).toBeLessThanOrEqual(5.01);
    expect(m.kneeMaxInteriorDeg).toBeLessThanOrEqual(180);
    expect(m.kneePopDeg).toBeLessThan(25);
    expect(m.armCounterswing).toBeLessThan(-0.7);
    expect(m.contactVelocityJumpRatio).toBeLessThan(0.35);
    expect(Object.keys(report.curves)).toEqual(expect.arrayContaining(['pelvisHeight', 'pelvisRoll', 'chestPitch', 'headPitch', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight', 'footHeightLeft', 'footHeightRight']));
    for (const curve of Object.values(report.curves)) expect(curve).toHaveLength(64);
    // Phase zero is the anatomical-left touchdown: the left foot is at its lowest and about to plant.
    expect(report.curves.footHeightLeft[0]).toBeCloseTo(0, 3);
  }, 30000);

  it('flags an open loop seam, a liftoff velocity pop, arms that swings with the legs, and auto-detects contacts without extras', async () => {
    const report = analyzeGait(await loadGait(await walkerGLB({ seamError: 0.01, arm: -20, declare: false })), { clip: 'walk' });
    expect(report.metrics.seam).toBeGreaterThan(0.009);
    expect(report.metrics.armCounterswing).toBeGreaterThan(0.7);
    const popping = analyzeGait(await loadGait(await walkerGLB({ smoothLiftoff: false })), { clip: 'walk' });
    expect(popping.metrics.contactVelocityJumpRatio).toBeGreaterThan(0.5);
    expect(report.contactSource).toBe('auto');
    expect(report.travelSpeed).toBeCloseTo(0.6 / (0.55 * 1.2), 1);
  }, 30000);

  it('finds each foot from the vertices skinned to it, whatever the meshes are called', async () => {
    const named = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const anonymous = analyzeGait(await loadGait(await walkerGLB({ footMeshes: ['shoe-a', 'shoe-b'] })), { clip: 'walk' });
    expect(anonymous.feet).toEqual({ left: expect.any(Number), right: expect.any(Number) });
    expect(anonymous.feet!.left).toBeGreaterThan(0);
    expect(anonymous.metrics).toEqual(named.metrics);
    expect(anonymous.curves.footHeightLeft).toEqual(named.curves.footHeightLeft);
  }, 30000);

  it('measures palms, thumbs and finger curl from the skinned hand geometry, at rest and through the clip', async () => {
    const natural = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' }).metrics.hands!;
    // Palms face the thighs and thumbs point forward; the arm swing leaves the hand's twist alone.
    expect(Math.abs(natural.rest.palmDeg.left)).toBeLessThan(3);
    expect(Math.abs(natural.rest.palmDeg.right)).toBeLessThan(3);
    expect(natural.rest.thumbForward).toBeGreaterThan(0.99);
    expect(Math.abs(natural.palmDeg.min)).toBeLessThan(3);
    expect(Math.abs(natural.palmDeg.max)).toBeLessThan(3);
    expect(natural.thumbForward).toBeGreaterThan(0.99);
    expect(natural.curl).toBeGreaterThan(0.05);
    // A forearm that turns the palm forward (toward palm up) by 70 degrees mid-clip shows as a negative palm angle.
    const twisted = analyzeGait(await loadGait(await walkerGLB({ handTwist: 70 })), { clip: 'walk' }).metrics.hands!;
    expect(Math.abs(twisted.rest.palmDeg.left)).toBeLessThan(3);
    expect(twisted.palmDeg.min).toBeGreaterThan(-73);
    expect(twisted.palmDeg.min).toBeLessThan(-67);
    // Backward hands: palms forward, thumbs toward the body.
    const backward = analyzeGait(await loadGait(await walkerGLB({ palms: 'backward' })), { clip: 'walk' }).metrics.hands!;
    expect(backward.rest.palmDeg.left).toBeCloseTo(-90, 0);
    expect(Math.abs(backward.rest.thumbForward)).toBeLessThan(0.05);
    // What the rig declares does not matter; the skinned hands do.
    const declared = analyzeGait(await loadGait(await walkerGLB({ declaredPalms: 'backward' })), { clip: 'walk' }).metrics.hands!;
    expect(declared.rest.palmDeg).toEqual(natural.rest.palmDeg);
    // Hand bones turned 180 degrees about their axis at rest and in every key: the bones move as before relative
    // to their rest, but the skinned hands face out with the thumbs back.
    const flipped = analyzeGait(await loadGait(twistHands(await walkerGLB(), 180)), { clip: 'walk' }).metrics.hands!;
    expect(Math.abs(flipped.rest.palmDeg.left)).toBeGreaterThan(170);
    expect(flipped.rest.thumbForward).toBeLessThan(-0.95);
    expect(flipped.thumbForward).toBeLessThan(-0.95);
    // Flat fingers have no curl.
    expect(analyzeGait(await loadGait(await walkerGLB({ curl: 0 })), { clip: 'walk' }).metrics.hands!.curl).toBeLessThan(0.04);
    expect(analyzeGait(await loadGait(await walkerGLB({ palms: 'none' })), { clip: 'walk' }).metrics.hands).toBeNull();
  }, 30000);

  it('measures stride from the soles and skating from every sole vertex on the floor', async () => {
    const report = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    // Stance carries the sole 0.6 m back in 0.55 x 1.2 s: 0.909 m/s, 1.09 m per cycle. The rest leg is 0.34 + 0.42 m.
    const stride = 0.6 / 0.55;
    expect(report.metrics.stride.meters).toBeCloseTo(stride, 3);
    expect(report.metrics.stride.perHeight).toBeCloseTo(stride / 1.75, 3);
    expect(report.metrics.stride.perLeg).toBeCloseTo(stride / 0.76, 2);
    expect(report.metrics.skate).toBeLessThan(0.05);
    const short = analyzeGait(await loadGait(await walkerGLB({ stride: 0.3 })), { clip: 'walk' });
    expect(short.metrics.stride.meters).toBeCloseTo(0.3 / 0.55, 3);
    // The declared stance says nothing about a sole skimming the floor at speed just before touchdown.
    const grazing = analyzeGait(await loadGait(await walkerGLB({ swing: 'graze' })), { clip: 'walk' });
    expect(grazing.metrics.skate).toBeGreaterThan(0.1);
  }, 30000);

  it('compares curves against a reference after phase alignment', async () => {
    const reference = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const other = analyzeGait(await loadGait(await walkerGLB({ bob: 0.03, roll: 4 })), { clip: 'walk', references: [reference] });
    expect(other.comparisons).toHaveLength(1);
    expect(other.comparisons![0].shift).toBe(0);
    expect(other.comparisons![0].r.pelvisHeight).toBeGreaterThan(0.99);
    expect(other.comparisons![0].minR).toBeGreaterThan(0.95);
    expect(other.comparisons![0].symmetric.minR).toBeGreaterThan(0.95);
  }, 30000);
});

describe('evaluateGait', () => {
  it('checks every natural-gait threshold, per gait', async () => {
    const reference = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const report = analyzeGait(await loadGait(await walkerGLB({ bob: 0.022 })), { clip: 'walk', references: [reference] });
    const walk = evaluateGait(report, 'walk');
    expect(walk.checks.map(c => c.id)).toEqual(['groundError', 'stanceSpeed', 'skate', 'seam', 'contactPop', 'kneeHyperextension', 'kneePop', 'flight', 'stride',
      'armCounterswing', 'handOrientation', 'headBob', 'headBobCount', 'headPitchRatio', 'torsoLean', 'spineFlex', 'counterRotation', 'pelvisDrop', 'curveCorrelation']);
    expect(walk.checks.filter(c => !c.pass)).toEqual([]);
    expect(walk.ok).toBe(true);
    const jog = evaluateGait(report, 'jog');
    expect(jog.ok).toBe(false);
    expect(jog.checks.filter(c => !c.pass).map(c => c.id)).toEqual(expect.arrayContaining(['flight', 'stride', 'headBob', 'torsoLean']));
  }, 30000);

  it('fails arms that swing with the legs, a hiked pelvis and a curve that does not match its reference', async () => {
    const reference = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const report = analyzeGait(await loadGait(await walkerGLB({ arm: -20, roll: -5 })), { clip: 'walk', references: [reference] });
    const failed = evaluateGait(report, 'walk').checks.filter(c => !c.pass).map(c => c.id);
    expect(failed).toEqual(expect.arrayContaining(['armCounterswing', 'pelvisDrop', 'curveCorrelation']));
    // Palms turned forward mid-clip, backward hands, flat fingers and missing hands all fail the hand check.
    for (const options of [{ handTwist: 70 }, { palms: 'backward' as const }, { curl: 0 }, { palms: 'none' as const }]) {
      const hands = evaluateGait(analyzeGait(await loadGait(await walkerGLB(options)), { clip: 'walk' }), 'walk').checks.find(c => c.id === 'handOrientation')!;
      expect(hands.pass).toBe(false);
    }
    // So do hands twisted 180 degrees on their bones, however the rig declares them.
    const flipped = evaluateGait(analyzeGait(await loadGait(twistHands(await walkerGLB(), 180)), { clip: 'walk' }), 'walk');
    expect(flipped.checks.find(c => c.id === 'handOrientation')!.pass).toBe(false);
    // A shuffle fails the stride check, and a sole that grazes the floor at speed fails the skate check.
    expect(evaluateGait(analyzeGait(await loadGait(await walkerGLB({ stride: 0.3 })), { clip: 'walk' }), 'walk').checks.find(c => c.id === 'stride')!.pass).toBe(false);
    expect(evaluateGait(analyzeGait(await loadGait(await walkerGLB({ swing: 'graze' })), { clip: 'walk' }), 'walk').checks.find(c => c.id === 'skate')!.pass).toBe(false);
    // A palm turned slightly back still hangs naturally.
    const back = evaluateGait(analyzeGait(await loadGait(await walkerGLB({ handTwist: -30 })), { clip: 'walk' }), 'walk');
    expect(back.checks.find(c => c.id === 'handOrientation')!.pass).toBe(true);
    // A reference compared for information is scored but does not fail the check.
    const hiked = analyzeGait(await loadGait(await walkerGLB({ roll: -5 })), { clip: 'walk' });
    const informed = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk', references: [reference, hiked], referenceRequired: [true, false] });
    expect(informed.comparisons!.map(c => c.required)).toEqual([true, false]);
    expect(informed.comparisons![1].minR).toBeLessThan(0.8);
    expect(evaluateGait(informed, 'walk').checks.find(c => c.id === 'curveCorrelation')!.pass).toBe(true);
    // Without references the correlation check is absent, not passed.
    const bare = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    expect(evaluateGait(bare, 'walk').checks.map(c => c.id)).not.toContain('curveCorrelation');
  }, 30000);
});

describe('gait CLI', () => {
  it('samples a clip to curves JSON with source provenance and scores it against references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-gait-cli-')); directories.push(directory);
    const glb = join(directory, 'walker.glb'), curves = join(directory, 'walker-curves.json');
    await writeFile(glb, await walkerGLB());
    const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 60000, windowsHide: true });
    await cli('gait', glb, '--clip', 'walk', '--out', curves, '--commit', 'abc123', '--license', 'CC0-1.0', '--source-url', 'https://example.test/walker.glb');
    const saved = JSON.parse(await readFile(curves, 'utf8'));
    expect(saved).toMatchObject({ format: 'agent-meshes/gait-curves/1', clip: 'walk', samples: 64, source: { file: 'walker.glb', commit: 'abc123', license: 'CC0-1.0', url: 'https://example.test/walker.glb' } });
    expect(saved.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    const scored = JSON.parse((await cli('gait', glb, '--clip', 'walk', '--reference', curves)).stdout);
    expect(scored.comparisons[0]).toMatchObject({ reference: 'walker-curves.json', clip: 'walk', shift: 0 });
    expect(scored.comparisons[0].minR).toBeGreaterThan(0.999);
    const checked = await cli('gait', glb, '--clip', 'walk', '--reference', curves, '--compare', curves, '--gait', 'walk');
    expect(JSON.parse(checked.stdout)).toMatchObject({ evaluation: { gait: 'walk', ok: true }, comparisons: [{ required: true }, { required: false }] });
    await expect(cli('gait', glb, '--clip', 'walk', '--gait', 'jog')).rejects.toMatchObject({ code: 1 });
    await expect(cli('gait', glb, '--clip', 'nope')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No clip named nope') });
  }, 90000);
});
