import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../src/core/types.ts';
import { solveChain } from '../src/recipes/chain.ts';

const rest: Vec3[] = [[.23, .57, .3], [.34, .59, .31], [.43, .65, .34], [.85, .90, .5], [.94, .82, .55], [1.17, .34, .72], [1.21, .10, .82]];
const vector = (v: Vec3) => new Vector3().fromArray(v);

function verify(points: Vec3[], target: Vec3, preferred?: Vec3[]) {
  const solved = solveChain(points, target, preferred);
  expect(solved.positions).toHaveLength(points.length);
  expect(solved.rotations).toHaveLength(points.length - 1);
  expect(solved.positions[0]).toEqual(points[0]);
  const position = vector(points[0]);
  const rotation = new Quaternion();
  for (let i = 0; i < points.length - 1; i++) {
    const restVector = vector(points[i + 1]).sub(vector(points[i]));
    expect(vector(solved.positions[i + 1]).distanceTo(vector(solved.positions[i]))).toBeCloseTo(restVector.length(), 10);
    expect(Math.hypot(...solved.rotations[i])).toBeCloseTo(1, 12);
    rotation.multiply(new Quaternion().fromArray(solved.rotations[i]));
    position.add(restVector.applyQuaternion(rotation));
    expect(position.distanceTo(vector(solved.positions[i + 1]))).toBeLessThan(1e-7);
  }
  expect(position.distanceTo(vector(target))).toBeLessThan(1e-6);
  return solved;
}

describe('longer articulated chain solver', () => {
  it('reaches stance and lifted swing targets with fixed segments and reproducible local rotations', () => {
    for (const z of [-.15, 0, .15]) for (const y of [0, .12]) verify(rest, [1.21, .1 + y, .82 + z]);
    const posed = verify(rest, [1.21, .22, .97]);
    expect(new Quaternion().fromArray(posed.rotations[0]).angleTo(new Quaternion())).toBeGreaterThan(.001);
    expect(new Quaternion().fromArray(posed.rotations.at(-1)!).angleTo(new Quaternion())).toBeGreaterThan(.001);
    expect(posed.positions[3][1]).toBeGreaterThan(rest[0][1]);
  });
  it('is deterministic without mutating inputs and respects a supplied bend seed', () => {
    const before = structuredClone(rest);
    const target: Vec3 = [1.21, .22, .95];
    const preferred = rest.map(([x, y, z], i): Vec3 => [x, y + .05 * Math.sin(i), z + .03 * Math.sin(i)]);
    const seedBefore = structuredClone(preferred);
    const first = verify(rest, target, preferred);
    expect(solveChain(rest, target, preferred)).toEqual(first);
    expect(first.positions[2]).not.toEqual(solveChain(rest, target).positions[2]);
    expect(rest).toEqual(before); expect(preferred).toEqual(seedBefore);
  });
  it('moves continuously between nearby targets and mirrors the solved shape', () => {
    const target: Vec3 = [1.21, .19, .87];
    const base = verify(rest, target);
    const nearby = verify(rest, [target[0], target[1], target[2] + 1e-4]);
    for (let i = 0; i < rest.length; i++) expect(vector(nearby.positions[i]).distanceTo(vector(base.positions[i]))).toBeLessThan(.002);
    const mirror = ([x, y, z]: Vec3): Vec3 => [-x, y, z];
    const reflected = verify(rest.map(mirror), mirror(target));
    for (let i = 0; i < rest.length; i++) expect(vector(reflected.positions[i]).distanceTo(vector(mirror(base.positions[i])))).toBeLessThan(1e-8);
  });
  it('escapes a straight-line singular seed and supports full extension', () => {
    const straight: Vec3[] = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]];
    verify(straight, [0, 2, 0]);
    verify(straight, [0, 3, 0]);
    verify(straight, [0, 2.99, 0]);
    verify(straight, [0, 1.5, 0], straight.map((): Vec3 => [0, 0, 0]));
  });
  it('rejects malformed, zero-length, and geometrically unreachable requests', () => {
    expect(() => solveChain(rest.slice(0, 2), [0, 0, 0])).toThrow(/three|3/i);
    expect(() => solveChain(rest, [NaN, 0, 0])).toThrow(/finite/i);
    expect(() => solveChain(rest, [1, 1, 1], rest.slice(1))).toThrow(/count|length/i);
    expect(() => solveChain([[0, 0, 0], [0, 0, 0], [1, 0, 0]], [1, 0, 0])).toThrow(/length/i);
    expect(() => solveChain(rest, [100, 0, 0])).toThrow(/unreachable/i);
    expect(() => solveChain([[0, 0, 0], [0, 3, 0], [0, 4, 0]], [0, 1, 0])).toThrow(/unreachable/i);
  });
});
