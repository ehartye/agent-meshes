import { describe, expect, it } from 'vitest';
import { createBeltDrive } from '../src/mechanisms/belt-drive.ts';

const base = { driver: { center: [0, 0] as [number, number], radius: .18 }, driven: { center: [1.2, 0] as [number, number], radius: .36 } };
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('ideal planar belt drive', () => {
  it('ties angular speed and belt travel to the actual pitch radii', () => {
    for (const crossed of [false, true]) {
      const drive = createBeltDrive({ ...base, crossed });
      expect(drive.ratio).toBe(crossed ? -.5 : .5);
      const result = drive.sample(12 * Math.PI);
      expect(result.drivenAngle).toBeCloseTo((crossed ? -6 : 6) * Math.PI, 12);
      expect(result.beltTravel).toBeCloseTo(-.18 * 12 * Math.PI, 12);
      expect(drive.sample(-.7).drivenAngle).toBeCloseTo(-.7 * drive.ratio, 12);
      const angle = .4, delta = 1e-5, a = drive.point(drive.sample(angle).beltTravel), b = drive.point(drive.sample(angle + delta).beltTravel);
      expect(distance(a.point, b.point) / delta).toBeCloseTo(.18, 6);
    }
  });

  it('computes tangent contacts on both radii and perpendicular to both connecting spans', () => {
    for (const crossed of [false, true]) for (const radii of [[.18, .36], [.4, .1], [.2, .2]]) {
      const spec = { driver: { center: [-.3, .7] as [number, number], radius: radii[0] }, driven: { center: [1, -.1] as [number, number], radius: radii[1] }, crossed };
      const belt = createBeltDrive(spec);
      for (const index of [0, 2]) {
        const span = belt.segments[index]; if (span.kind !== 'line') throw Error('Expected straight span');
        const ends = index === 0 ? [spec.driver, spec.driven] : [spec.driven, spec.driver];
        for (const [i, p] of [span.start, span.end].entries()) {
          expect(distance(p, ends[i].center)).toBeCloseTo(ends[i].radius, 12);
          const dot = (p[0] - ends[i].center[0]) * (span.end[0] - span.start[0]) + (p[1] - ends[i].center[1]) * (span.end[1] - span.start[1]);
          expect(Math.abs(dot)).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('closes a smooth directed path with unit tangents and no jumps at span boundaries', () => {
    for (const crossed of [false, true]) {
      const belt = createBeltDrive({ ...base, crossed }); let at = 0;
      for (const segment of belt.segments) {
        const a = belt.point(at - 1e-7), b = belt.point(at + 1e-7);
        expect(distance(a.point, b.point)).toBeCloseTo(2e-7, 11);
        expect(distance(a.tangent, b.tangent)).toBeLessThan(2e-6);
        at += segment.length;
      }
      expect(at).toBeCloseTo(belt.length, 12);
      expect(distance(belt.point(0).point, belt.point(belt.length).point)).toBeLessThan(1e-12);
      expect(distance(belt.point(-.1).point, belt.point(belt.length - .1).point)).toBeLessThan(1e-12);
      for (let i = 0; i < 150; i++) expect(Math.hypot(...belt.point(i * belt.length / 150).tangent)).toBeCloseTo(1, 12);
    }
  });

  it('agrees with equal-radius open and crossed length formulas', () => {
    const radius = .2, separation = 1.2;
    const spec = { driver: { center: [0, 0] as [number, number], radius }, driven: { center: [separation, 0] as [number, number], radius } };
    expect(createBeltDrive(spec).length).toBeCloseTo(2 * separation + 2 * Math.PI * radius, 12);
    const alpha = Math.acos(2 * radius / separation);
    expect(createBeltDrive({ ...spec, crossed: true }).length).toBeCloseTo(2 * Math.sqrt(separation ** 2 - 4 * radius ** 2) + 4 * radius * (Math.PI - alpha), 12);
  });

  it('is equivariant under rotation, translation and reasonable unit scaling', () => {
    const original = createBeltDrive(base), angle = 1.37, c = Math.cos(angle), s = Math.sin(angle);
    for (const scale of [1e-4, 1, 1000]) {
      const move = (p: readonly number[]) => [scale * (c * p[0] - s * p[1] + 3), scale * (s * p[0] + c * p[1] - 2)] as [number, number];
      const belt = createBeltDrive({ driver: { center: move(base.driver.center), radius: base.driver.radius * scale }, driven: { center: move(base.driven.center), radius: base.driven.radius * scale } });
      expect(belt.ratio).toBe(original.ratio);
      for (let i = 0; i < 30; i++) expect(distance(belt.point(i * original.length / 30 * scale).point, move(original.point(i * original.length / 30).point))).toBeLessThan(scale * 1e-11);
    }
  });

  it('copies configuration and exposes only frozen data', () => {
    const spec = structuredClone(base), belt = createBeltDrive(spec), expected = belt.point(.3);
    spec.driver.center[0] = 300; spec.driven.radius = 100;
    expect(belt.point(.3)).toEqual(expected);
    for (const value of [belt, belt.segments, ...belt.segments, belt.driver.center, expected, expected.point, expected.tangent, belt.sample(1)]) expect(Object.isFrozen(value)).toBe(true);
  });

  it('rejects invalid, overlapping, sparse and unresolvable geometry at creation', () => {
    const bad = [null, {}, { ...base, crossed: 1 }, { ...base, driver: { center: new Array(2), radius: .2 } }, { ...base, driver: { center: [0, NaN], radius: .2 } }, { ...base, driver: { center: [0, 0], radius: 0 } }, { ...base, driven: { center: [.54, 0], radius: .36 } }, { ...base, driven: { center: [.5, 0], radius: .36 } }, { driver: { center: [1e6, 0], radius: 1e-6 }, driven: { center: [1e6 - 1, 0], radius: .2 } }];
    for (const spec of bad) expect(() => createBeltDrive(spec as typeof base)).toThrow();
    const belt = createBeltDrive(base);
    for (const value of [NaN, Infinity, -Infinity, 1e20]) { expect(() => belt.sample(value)).toThrow(); expect(() => belt.point(value)).toThrow(); }
    expect(belt.sample(1).drivenAngle).toBe(.5);
  });
});
