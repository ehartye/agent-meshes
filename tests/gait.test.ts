import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../src/core/types.ts';
import { footPath, solveLeg } from '../src/recipes/gait.ts';

describe('procedural foot cycle', () => {
  it('plants the foot during stance, then lifts and returns it during swing', () => {
    expect(footPath(0, 1, 0.3)).toEqual([0, 0, 0.5]);
    expect(footPath(0.3, 1, 0.3)).toEqual([0, 0, 0]);
    expect(footPath(0.6, 1, 0.3)).toEqual([0, 0, -0.5]);
    expect(footPath(0.8, 1, 0.3)[1]).toBeCloseTo(0.3, 10);
    expect(footPath(0.8, 1, 0.3)[2]).toBeCloseTo(0, 10);
    for (let i = 0; i < 60; i++) expect(footPath(i / 100, 1, 0.3)[1]).toBe(0);
    for (let i = 61; i < 100; i++) expect(footPath(i / 100, 1, 0.3)[1]).toBeGreaterThan(0);
  });
  it('wraps positive and negative cycles with continuous contact velocities', () => {
    for (const t of [0, 0.1, 0.6, 0.8, 0.99]) {
      const reference = footPath(t, 0.8, 0.2);
      for (const offset of [-3, -1, 1, 4]) footPath(t + offset, 0.8, 0.2).forEach((n, i) => expect(n).toBeCloseTo(reference[i], 12));
    }
    expect(footPath(-1, 1, 0.3)).toEqual(footPath(0, 1, 0.3));
    const epsilon = 1e-6;
    for (const contact of [0, 0.6]) {
      const before = footPath(contact - epsilon, 1, 0.3);
      const at = footPath(contact, 1, 0.3);
      const after = footPath(contact + epsilon, 1, 0.3);
      for (let i = 0; i < 3; i++) expect((at[i] - before[i]) / epsilon).toBeCloseTo((after[i] - at[i]) / epsilon, 3);
    }
    expect(footPath(0.4, 1, 0.2, 0.8)).toEqual([0, 0, 0]);
  });
  it('rejects nonfinite inputs and invalid cycle parameters', () => {
    for (const args of [[NaN, 1, 1, 0.6], [0, -1, 1, 0.6], [0, 1, -1, 0.6], [0, 1, 1, 0], [0, 1, 1, 1], [0, Infinity, 1, 0.6]]) {
      expect(() => footPath(...args as [number, number, number, number])).toThrow(/finite|nonnegative|stance/i);
    }
  });
});

describe('two-link leg inverse kinematics', () => {
  const hip: Vec3 = [0.6, 1.5, 0.1];
  const knee: Vec3 = [0.9, 0.9, 0.4];
  const foot: Vec3 = [1, 0.2, 0];
  function verify(target: Vec3, pole: Vec3) {
    const pose = solveLeg(hip, knee, foot, target, pole);
    const upper = new Quaternion().fromArray(pose.upper);
    const total = upper.clone().multiply(new Quaternion().fromArray(pose.lower));
    const actual = new Vector3().fromArray(hip)
      .add(new Vector3().fromArray(knee).sub(new Vector3().fromArray(hip)).applyQuaternion(upper))
      .add(new Vector3().fromArray(foot).sub(new Vector3().fromArray(knee)).applyQuaternion(total));
    expect(actual.distanceTo(new Vector3().fromArray(target))).toBeLessThan(1e-8);
    expect(total.multiply(new Quaternion().fromArray(pose.ankle)).angleTo(new Quaternion())).toBeLessThan(1e-7);
    for (const q of Object.values(pose)) expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    return pose;
  }
  it('reaches a complete foot cycle despite compensated root bob and levels the ankle', () => {
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      const offset = footPath(t, 0.4, 0.2);
      verify([foot[0], foot[1] + offset[1] - 0.04 * Math.cos(t * Math.PI * 2), foot[2] + offset[2]], [1, 0, 0.6]);
    }
    expect(hip).toEqual([0.6, 1.5, 0.1]);
    expect(knee).toEqual([0.9, 0.9, 0.4]);
    expect(foot).toEqual([1, 0.2, 0]);
  });
  it('uses a bend direction independent of the world origin and handles singular poles', () => {
    const target: Vec3 = [1.05, 0.25, 0.1];
    const direction = new Vector3().fromArray(target).sub(new Vector3().fromArray(hip));
    verify(target, direction.toArray() as Vec3);
    verify(target, direction.clone().add(new Vector3(1e-12, 0, 0)).toArray() as Vec3);
    verify(target, [0, 0, 0]);
    const first = verify(target, [1, 0, 0.6]);
    const translate = (v: Vec3): Vec3 => [v[0] + 4, v[1] - 3, v[2] + 7];
    const moved = solveLeg(translate(hip), translate(knee), translate(foot), translate(target), [1, 0, 0.6]);
    for (const key of ['upper', 'lower', 'ankle'] as const) first[key].forEach((n, i) => expect(moved[key][i]).toBeCloseTo(n, 12));
  });
  it('rejects unreachable or degenerate legs with actionable errors', () => {
    expect(() => solveLeg(hip, knee, foot, [1, 10, 0], [1, 0, 0])).toThrow(/unreachable/i);
    expect(() => solveLeg([0, 0, 0], [0, 2, 0], [0, 3, 0], [0, 0.5, 0], [1, 0, 0])).toThrow(/unreachable/i);
    expect(() => solveLeg(hip, hip, foot, foot, [1, 0, 0])).toThrow(/length/i);
    expect(() => solveLeg(hip, knee, foot, [NaN, 0, 0], [1, 0, 0])).toThrow(/finite/i);
  });
});
