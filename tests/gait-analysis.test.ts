import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alignCurves, analyzeGait, evaluateGait, kneeInterior, loadGait, pearson, resolveGaitBones, symmetrizeCurves } from '../src/gait-analysis.ts';
import { walkerGLB } from './helpers/gait-glb.ts';

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
  });
});

describe('analyzeGait on a synthetic walker', () => {
  it('recovers the analytic gait: bob, lean, spine flex, counter-rotation, pelvis drop, contacts and arms', async () => {
    const report = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const m = report.metrics;
    expect(report.forward.map(v => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0, 1]);
    expect(report.height).toBe(1.75);
    expect(report.travelSpeed).toBeCloseTo(0.6 / (0.6 * 1.2), 6);
    expect(report.contactSource).toBe('declared');
    expect(m.seam).toBeLessThan(1e-5);
    expect(m.groundError).toBeLessThan(1e-4);
    expect(m.skate).toBeLessThan(0.01);
    expect(m.stanceSpeedRatio.min).toBeGreaterThan(0.99);
    expect(m.stanceSpeedRatio.max).toBeLessThan(1.01);
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
    expect(report.travelSpeed).toBeCloseTo(0.6 / (0.6 * 1.2), 1);
  }, 30000);

  it('finds each foot from the vertices skinned to it, whatever the meshes are called', async () => {
    const named = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const anonymous = analyzeGait(await loadGait(await walkerGLB({ footMeshes: ['shoe-a', 'shoe-b'] })), { clip: 'walk' });
    expect(anonymous.feet).toEqual({ left: expect.any(Number), right: expect.any(Number) });
    expect(anonymous.feet!.left).toBeGreaterThan(0);
    expect(anonymous.metrics).toEqual(named.metrics);
    expect(anonymous.curves.footHeightLeft).toEqual(named.curves.footHeightLeft);
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
    expect(walk.checks.map(c => c.id)).toEqual(['groundError', 'stanceSpeed', 'skate', 'seam', 'contactPop', 'kneeHyperextension', 'kneePop', 'flight',
      'armCounterswing', 'headBob', 'headBobCount', 'headPitchRatio', 'torsoLean', 'spineFlex', 'counterRotation', 'pelvisDrop', 'curveCorrelation']);
    expect(walk.checks.filter(c => !c.pass)).toEqual([]);
    expect(walk.ok).toBe(true);
    const jog = evaluateGait(report, 'jog');
    expect(jog.ok).toBe(false);
    expect(jog.checks.filter(c => !c.pass).map(c => c.id)).toEqual(expect.arrayContaining(['flight', 'headBob', 'torsoLean']));
  }, 30000);

  it('fails arms that swing with the legs, a hiked pelvis and a curve that does not match its reference', async () => {
    const reference = analyzeGait(await loadGait(await walkerGLB()), { clip: 'walk' });
    const report = analyzeGait(await loadGait(await walkerGLB({ arm: -20, roll: -5 })), { clip: 'walk', references: [reference] });
    const failed = evaluateGait(report, 'walk').checks.filter(c => !c.pass).map(c => c.id);
    expect(failed).toEqual(expect.arrayContaining(['armCounterswing', 'pelvisDrop', 'curveCorrelation']));
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
    const checked = await cli('gait', glb, '--clip', 'walk', '--reference', curves, '--gait', 'walk');
    expect(JSON.parse(checked.stdout)).toMatchObject({ evaluation: { gait: 'walk', ok: true } });
    await expect(cli('gait', glb, '--clip', 'walk', '--gait', 'jog')).rejects.toMatchObject({ code: 1 });
    await expect(cli('gait', glb, '--clip', 'nope')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No clip named nope') });
  }, 90000);
});
