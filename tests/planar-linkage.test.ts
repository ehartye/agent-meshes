import { describe, expect, it } from 'vitest';
import { createPlanarLinkage } from '../src/mechanisms/planar-linkage.ts';
import { solveJansenLeg } from '../src/recipes/strandbeest.ts';

const simple = () => ({ fixed: { O: [0, 0], P: [2, 0] }, crank: { name: 'C', center: 'O', radius: 1 }, joints: [{ name: 'J', a: 'P', b: 'C', ra: 2, rb: 2, branch: 1 }] });
const jansen = () => ({ fixed: { O: [0, 0], P: [-38, -7.8] }, crank: { name: 'C', center: 'O', radius: 15 }, joints: [
  { name: 'A', a: 'P', b: 'C', ra: 41.5, rb: 50, branch: 1 },
  { name: 'B', a: 'P', b: 'C', ra: 39.3, rb: 61.9, branch: -1 },
  { name: 'D', a: 'P', b: 'A', ra: 40.1, rb: 55.8, branch: 1 },
  { name: 'E', a: 'D', b: 'B', ra: 39.4, rb: 36.7, branch: -1 },
  { name: 'F', a: 'B', b: 'E', ra: 49, rb: 65.7, branch: 1 },
] });
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('analytic planar linkage', () => {
  it('intersects on an oriented side, detaches inputs and deeply freezes independent samples', () => {
    const input = simple(), linkage = createPlanarLinkage(input), first = linkage.sample(0);
    expect(first.points.C).toEqual([1, 0]); expect(first.points.J[1]).toBeLessThan(0);
    expect(distance(first.points.J, first.points.P)).toBeCloseTo(2, 12);
    expect(distance(first.points.J, first.points.C)).toBeCloseTo(2, 12);
    expect(first.minimumBranchGap).toBeCloseTo(Math.sqrt(15), 12);
    input.fixed.O[0] = 99; input.joints[0].ra = 99;
    expect(linkage.sample(0)).toEqual(first);
    for (const value of [linkage, first, first.points, ...Object.values(first.points)]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (first.points.J as unknown as number[])[0] = 99; }).toThrow();
    const other = linkage.sample(1); expect(other.points.J).not.toBe(first.points.J);
    expect(linkage.sample(0)).toEqual(first);
    const opposite = simple(); opposite.joints[0].branch = -1;
    expect(createPlanarLinkage(opposite).sample(0).points.J[1]).toBe(-first.points.J[1]);
  });

  it('rejects malformed, oversized and unordered graphs before sampling', () => {
    const cases: unknown[] = [null, [], {}, { ...simple(), fixed: {} }, { ...simple(), joints: null }, { ...simple(), joints: Array(1) }];
    for (const mutate of [
      (s: ReturnType<typeof simple>) => { s.fixed.O[0] = NaN; },
      s => { s.fixed.O = [0]; }, s => { s.fixed.P[0] = 1e7; },
      s => { s.crank.radius = 0; }, s => { s.crank.radius = Infinity; }, s => { s.crank.radius = 1e-12; },
      s => { s.crank.center = 'missing'; }, s => { s.crank.name = 'O'; },
      s => { s.joints[0].name = 'C'; }, s => { s.joints[0].branch = 0; },
      s => { s.joints[0].a = 'J'; }, s => { s.joints[0].a = 'missing'; },
      s => { s.joints[0].b = 'P'; }, s => { s.joints[0].ra = -1; },
      s => { s.joints[0].rb = 1e7; }, s => { s.joints = Array(65).fill(s.joints[0]); },
    ] as ((s: ReturnType<typeof simple>) => void)[]) { const s = simple(); mutate(s); cases.push(s); }
    cases.push({ ...simple(), fixed: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['P' + i, [0, 0]])) });
    for (const input of cases) expect(() => createPlanarLinkage(input)).toThrow();
  });

  it('rejects unreachable circles, tangencies and coincident centers without retaining a failed sample', () => {
    const input = simple(); input.joints[0].ra = input.joints[0].rb = 1;
    const driver = createPlanarLinkage(input), good = driver.sample(0);
    expect(() => driver.sample(Math.PI)).toThrow(/close/);
    expect(driver.sample(0)).toEqual(good);
    for (const [point, radii] of [[[3, 0], [1, 1]], [[2, 0], [2, 1]], [[1, 0], [1, 1]]] as const) {
      const spec = simple(); spec.fixed.P = [...point]; [spec.joints[0].ra, spec.joints[0].rb] = radii;
      expect(() => createPlanarLinkage(spec).sample(0)).toThrow(/singular|coincident/i);
    }
    for (const phase of [NaN, Infinity, -Infinity, 1e10]) expect(() => driver.sample(phase)).toThrow(/angle/);
  });

  it('keeps branch meaning under rotation and permits a mirrored mechanism by reversing branch signs', () => {
    const original = simple(), driver = createPlanarLinkage(original), rotation = Math.PI - 1e-9;
    const rotate = (p: readonly number[]) => [p[0] * Math.cos(rotation) - p[1] * Math.sin(rotation), p[0] * Math.sin(rotation) + p[1] * Math.cos(rotation)];
    const rotated = simple(), mirrored = simple();
    for (const [name, p] of Object.entries(original.fixed)) {
      rotated.fixed[name as 'O' | 'P'] = rotate(p);
      mirrored.fixed[name as 'O' | 'P'] = [p[0], -p[1]];
    }
    mirrored.joints[0].branch = -1;
    const rotatedDriver = createPlanarLinkage(rotated), mirroredDriver = createPlanarLinkage(mirrored);
    for (const angle of [0, .3, 2, 5, -1]) {
      const points = driver.sample(angle).points, r = rotatedDriver.sample(angle + rotation).points, m = mirroredDriver.sample(-angle).points;
      for (const [name, p] of Object.entries(points)) {
        expect(distance(r[name], rotate(p))).toBeLessThan(1e-13);
        expect(distance(m[name], [p[0], -p[1]])).toBeLessThan(1e-13);
      }
    }
  });

  it('bounds output coordinates and keeps object-prototype names as ordinary point data', () => {
    const driver = createPlanarLinkage({ fixed: { constructor: [0, 0] }, crank: { name: 'toString', center: 'constructor', radius: 1 }, joints: [] });
    const points = driver.sample(0).points;
    expect(Object.getPrototypeOf(points)).toBeNull(); expect(points.toString).toEqual([1, 0]);
    expect(() => createPlanarLinkage({ fixed: { ['__proto__']: [0, 0] }, crank: { name: 'C', center: '__proto__', radius: 1 }, joints: [] })).toThrow();
    const large = createPlanarLinkage({ fixed: { O: [1e6, 0] }, crank: { name: 'C', center: 'O', radius: 1 }, joints: [] });
    expect(() => large.sample(0)).toThrow(/C X/);
  });

  it('supports a crank alone and rejects output that loses radius precision at a distant origin', () => {
    const driver = createPlanarLinkage({ fixed: { O: [0, 0] }, crank: { name: 'C', center: 'O', radius: 1 }, joints: [] });
    expect(driver.sample(0).minimumBranchGap).toBeNull();
    expect(driver.sample(Math.PI / 2).points.C[1]).toBe(1);
    const far = createPlanarLinkage({ fixed: { O: [999999, 999999] }, crank: { name: 'C', center: 'O', radius: 1e-6 }, joints: [] });
    expect(() => far.sample(.73)).toThrow(/precision/);
  });

  it('retains corrected Jansen closure and assembly at small and large scales, independent of call order', () => {
    for (const scale of [1e-6, 1, 1e3]) {
      const spec = jansen(), offset = [13 * scale, -7 * scale];
      for (const p of Object.values(spec.fixed)) { p[0] = p[0] * scale + offset[0]; p[1] = p[1] * scale + offset[1]; }
      spec.crank.radius *= scale; for (const j of spec.joints) { j.ra *= scale; j.rb *= scale; }
      const driver = createPlanarLinkage(spec);
      const saved = driver.sample(.37); let previous = driver.sample(0);
      for (let i = 0; i <= 720; i++) {
        const angle = i / 720 * Math.PI * 2, current = driver.sample(angle), reference = solveJansenLeg(angle);
        expect(current.minimumBranchGap! / scale).toBeGreaterThan(24);
        for (const [name, p] of Object.entries(current.points)) {
          const normalized = [(p[0] - offset[0]) / scale, (p[1] - offset[1]) / scale];
          expect(distance(normalized, reference[name as keyof typeof reference])).toBeLessThan(1e-10);
          expect(distance(p, previous.points[name]) / scale).toBeLessThan(.5);
        }
        previous = current;
      }
      driver.sample(-4); driver.sample(3); expect(driver.sample(.37)).toEqual(saved);
      const first = driver.sample(0), last = driver.sample(Math.PI * 2);
      for (const name of Object.keys(first.points)) expect(distance(first.points[name], last.points[name]) / scale).toBeLessThan(1e-10);
    }
  });
});

