import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LID_CONTRACT_MAX_POSES, LID_CROSSING_POSES, LID_FOLLOW_DEFAULT, lidContractPoses, lidGridPoses, eyePenetration, poseLabel, type LidPose, type LidSurface } from '../src/face-lids.ts';

const RADIUS = 0.012, CENTER: [number, number, number] = [0, 0, 0], FOLLOW = { down: 0.35, up: 0.8 };
type P = [number, number, number];
const pose = (blink: number, squint = 0, wide = 0): LidPose => ({ blink, squint, wide });

/** A triangle soup as a lid surface: positions and corner indices, with each morph given as absolute target positions. */
function surface(label: string, points: P[], triangles: number[], targets: Partial<Record<'blink' | 'squint' | 'wide', P[]>> = {}, extra: Partial<LidSurface> = {}): LidSurface {
  const flat = (list: P[]) => Float64Array.from(list.flat());
  const deltas = Object.fromEntries(Object.entries(targets).map(([name, moved]) => [name, flat(moved!.map((p, i) => [p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]] as P))]));
  return { label, rest: flat(points), triangles: Uint32Array.from(triangles), ...deltas, ...extra };
}
const shift = (points: P[], d: P): P[] => points.map(p => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
/** Raise points by up to `rise`, by 0 at the plate's left edge (x = -10 mm) and all of it at the right (x = +10 mm): a tilted swing, so the plates cross along a line. */
const tilt = (points: P[], rise: number): P[] => points.map(p => [p[0], p[1], p[2] + rise * (p[0] + 0.01) / 0.02]);
/** A horizontal square of side 2 * half at height z, as two triangles. */
const plate = (z: number, half = 0.01, at: [number, number] = [0, 0]): { points: P[]; triangles: number[] } => ({
  points: [[at[0] - half, at[1] - half, z], [at[0] + half, at[1] - half, z], [at[0] + half, at[1] + half, z], [at[0] - half, at[1] + half, z]], triangles: [0, 1, 2, 0, 2, 3],
});

describe('lid-penetration poses', () => {
  it('poses every weight of blink, squint and wide and the lid-follow unions: 324 poses besides rest', () => {
    const poses = lidGridPoses(FOLLOW);
    expect(poses).toHaveLength(324);
    expect(poses.some(p => !p.blink && !p.squint && !p.wide)).toBe(false);
    const labels = poses.map(p => poseLabel(p, 'Left'));
    expect(new Set(labels).size).toBe(324);
    expect(lidGridPoses(FOLLOW)).toEqual(poses);
    // eyeLookDown = 1 adds blink `down` (soft-unioned), eyeLookUp = 1 adds wide `up`.
    expect(poses).toContainEqual(pose(0.8375));
    expect(poses).toContainEqual(pose(1, 0, 0.8));
    expect(poses).toContainEqual(pose(0.35, 1, 0.5));
    expect(lidGridPoses({ down: 0, up: 0 })).toHaveLength(124);
  });

  it('keeps the contract poses to 40 per eye: the 12 coverage states, the 20 named crossing poses and lid follow', () => {
    expect(LID_CROSSING_POSES).toHaveLength(20);
    const coverage = [pose(0.25), pose(0.25, 1), pose(0.5), pose(0.5, 1), pose(0.75), pose(0.75, 1), pose(0, 1), pose(0, 0, 1), pose(1), pose(1, 1), pose(1, 0, 1), pose(1, 1, 1)];
    const poses = lidContractPoses(FOLLOW, coverage);
    expect(poses.length).toBeLessThanOrEqual(LID_CONTRACT_MAX_POSES);
    expect(LID_CONTRACT_MAX_POSES).toBe(40);
    expect(poses.length).toBeGreaterThan(30);
    for (const c of coverage) expect(poses).toContainEqual(c);
    for (const [blink, squint, wide] of LID_CROSSING_POSES) expect(poses).toContainEqual(pose(blink, squint, wide));
    expect(poses).toContainEqual(pose(0.35));
    expect(poses).toContainEqual(pose(0, 0, 0.8));
    expect(new Set(poses.map(p => poseLabel(p, 'Right'))).size).toBe(poses.length);
    expect(lidContractPoses(FOLLOW, coverage)).toEqual(poses);
    expect(LID_FOLLOW_DEFAULT).toEqual({ down: 0.35, up: 0.8 });
  });

  it('labels a pose by its morphs', () => {
    expect(poseLabel(pose(1, 0.5, 0), 'Left')).toBe('eyeBlinkLeft=1 + eyeSquintLeft=0.5');
    expect(poseLabel(pose(0, 0, 0.8375), 'Right')).toBe('eyeWideRight=0.8375');
    expect(poseLabel(pose(0), 'Left')).toBe('rest');
  });
});

// Both passes (see 'the default pass and the exhaustive pass' below) keep every rule of the check: the exemptions, the limits, the names.
describe.each([['default', false], ['exhaustive', true]])('eyePenetration (%s pass)', (_name, exhaustive) => {
  const upper = plate(0.005), lower = plate(-0.005);
  const judge = (surfaces: LidSurface[], poses: LidPose[], options = {}) => eyePenetration(surfaces, CENTER, RADIUS, FOLLOW, 'Left', { poses, exhaustive, ...options });

  it('counts the poses in which a moving triangle passes through another one, and names the pair', () => {
    // The lower plate rises by up to 16 mm at blink 1, more toward its right edge: it passes through the upper plate (10 mm above
    // it) from a blink of 0.625 on.
    const result = judge([
      surface('upper', upper.points, upper.triangles),
      surface('lower', lower.points, lower.triangles, { blink: tilt(lower.points, 0.016) }),
    ], [pose(0.25), pose(0.5), pose(0.75), pose(1)]);
    expect(result).toMatchObject({ poses: 4, crossingPoses: 2, triangles: 4, moving: 2, restPairs: 0 });
    expect(result.crossing.map(c => c.pose)).toEqual(['eyeBlinkLeft=0.75', 'eyeBlinkLeft=1']);
    expect(result.worstCrossing!.pairs).toBeGreaterThan(0);
    const example = result.worstCrossing!.examples[0];
    expect([example.part, example.other].sort()).toEqual(['lower', 'upper']);
    expect(result.worstCrossing!.heights[0]).toBeLessThanOrEqual(result.worstCrossing!.heights[1]);
  });

  it('adds morphs: blink and squint each carry the plate part of the way, together they pass through', () => {
    const result = judge([
      surface('upper', upper.points, upper.triangles),
      surface('lower', lower.points, lower.triangles, { blink: tilt(lower.points, 0.006), squint: tilt(lower.points, 0.006) }),
    ], [pose(1), pose(0, 1), pose(1, 1), pose(0.5, 0.5)]);
    expect(result.crossingPoses).toBe(1);
    expect(result.worstCrossing!.pose).toBe('eyeBlinkLeft=1 + eyeSquintLeft=1');
  });

  it('judges nothing that does not move with the eye, and nothing far from it', () => {
    const still = judge([surface('upper', upper.points, upper.triangles), surface('lower', shift(upper.points, [0, 0, -0.01]), upper.triangles)], [pose(1)]);
    expect(still).toMatchObject({ moving: 0, crossingPoses: 0 });
    // Triangles more than three eyeball radii from the center are not judged.
    const far = judge([
      surface('upper', shift(upper.points, [0.1, 0, 0]), upper.triangles),
      surface('lower', shift(lower.points, [0.1, 0, 0]), lower.triangles, { blink: tilt(shift(lower.points, [0.1, 0, 0]), 0.016) }),
    ], [pose(1)]);
    expect(far).toMatchObject({ triangles: 0, crossingPoses: 0 });
  });

  it('leaves out the triangles marked as attached parts', () => {
    const result = judge([
      surface('upper', upper.points, upper.triangles),
      surface('lower', lower.points, lower.triangles, { blink: tilt(lower.points, 0.016) }, { skip: Uint8Array.from([1, 1]) }),
    ], [pose(1)]);
    expect(result).toMatchObject({ triangles: 2, moving: 0, crossingPoses: 0 });
  });

  it('does not call two triangles that share a welded corner a crossing (the canthus where the lids meet)', () => {
    // Both lids' triangles meet at the corner point (a vertex in each surface at the same rest position); the lower one
    // swings up through the upper one's plane about it. Pivoting about a shared corner is how two lids close.
    const corner: P = [0, 0, 0];
    const fixed: P[] = [corner, [0.02, 0, 0], [0, 0.02, 0]];
    const swing: P[] = [corner, [0.012, 0.002, -0.003], [0.002, 0.012, -0.003]];
    const swung: P[] = [corner, [0.012, 0.002, -0.003], [0.002, 0.012, 0.003]];
    const welded = judge([surface('upper', fixed, [0, 1, 2]), surface('lower', swing, [0, 1, 2], { blink: swung })], [pose(0.75), pose(1)]);
    expect(welded.crossingPoses).toBe(0);
    // The same triangles with the corners 0.5 mm apart (no longer one welded point) do cross.
    const apart: P[] = [[-0.0005, -0.0005, 0], ...swing.slice(1)];
    const apartSwung: P[] = [[-0.0005, -0.0005, 0], ...swung.slice(1)];
    const loose = judge([surface('upper', fixed, [0, 1, 2]), surface('lower', apart, [0, 1, 2], { blink: apartSwung })], [pose(0.75), pose(1)]);
    expect(loose.crossingPoses).toBe(2);
  });

  it('does not judge a blade that slides through a well it already passes through at rest (a robot lens)', () => {
    // A well wall in the plane y = 0 (two triangles split along the diagonal) and a narrow blade across it. The blade
    // stands through the wall at rest and slides down 30 mm: half way it crosses the wall's other triangle, which is a
    // new pair of triangles but the same two pieces.
    const wall: P[] = [[-0.02, 0, -0.02], [0.02, 0, -0.02], [0.02, 0, 0.02], [-0.02, 0, 0.02]];
    const bladeAt = (y0: number, y1: number): P[] => [[-0.002, y0, 0.015], [0.002, y0, 0.015], [0.002, y1, 0.015], [-0.002, y1, 0.015]];
    const rest = bladeAt(-0.008, 0.008);
    const well = surface('well', wall, [0, 1, 2, 0, 2, 3]);
    const slid = judge([well, surface('blade', rest, [0, 1, 2, 0, 2, 3], { blink: shift(rest, [0, 0, -0.03]) })], [pose(0.25), pose(0.5), pose(0.75), pose(1)]);
    expect(slid.restPairs).toBeGreaterThan(0);
    expect(slid.restPieces).toBe(1);
    expect(slid.crossingPoses).toBe(0);
    // A blade that starts clear of the wall and slides through it is a crossing.
    const clear = bladeAt(0.012, 0.028);
    const through = judge([well, surface('blade', clear, [0, 1, 2, 0, 2, 3], { blink: shift(clear, [0, -0.03, 0]) })], [pose(0.25), pose(0.5), pose(0.75)]);
    expect(through.restPairs).toBe(0);
    expect(through.restPieces).toBe(0);
    expect(through.crossingPoses).toBe(2);
  });

  it('reports bounded examples however many triangles cross', () => {
    const fine = (z: number) => {
      const points: P[] = [], triangles: number[] = [], n = 12;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) points.push([-0.01 + 0.02 * i / n, -0.01 + 0.02 * j / n, z]);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = i * (n + 1) + j; triangles.push(a, a + n + 1, a + n + 2, a, a + n + 2, a + 1); }
      return { points, triangles };
    };
    const a = fine(0.005), b = fine(-0.005);
    const result = judge([surface('upper', a.points, a.triangles), surface('lower', b.points, b.triangles, { blink: tilt(b.points, 0.016) })], [pose(1)], { pairLimit: 12 });
    expect(result.crossingPoses).toBe(1);
    expect(result.worstCrossing!.pairs).toBeGreaterThan(0);
    expect(result.worstCrossing!.pairs).toBeLessThanOrEqual(12);
    expect(result.worstCrossing!.examples.length).toBeLessThanOrEqual(4);
  });

  it('judges the whole 324-pose grid in grid mode', () => {
    const result = eyePenetration([
      surface('upper', upper.points, upper.triangles),
      surface('lower', lower.points, lower.triangles, { blink: tilt(lower.points, 0.016) }),
    ], CENTER, RADIUS, FOLLOW, 'Left', { grid: true, exhaustive });
    expect(result.mode).toBe('grid');
    expect(result.poses).toBe(324);
    // The plates cross from a blink of 0.625 on: more than a quarter and fewer than all of the poses.
    expect(result.crossingPoses).toBeGreaterThan(100);
    expect(result.crossingPoses).toBeLessThan(324);
  });
});

describe('real lantern lids', () => {
  // The lids of a lantern head (big round eyes on a plain ellipsoid, 48 degrees wide, squint share .35), built by eye_hole in
  // pure Python and trimmed to the eye: before the lids were nested by construction, and after. tests/fixtures/lantern-lids/make.py
  // regenerates them.
  const lantern = (name: string): { surface: LidSurface; center: [number, number, number]; radius: number } => {
    const data = JSON.parse(readFileSync(new URL(`./fixtures/lantern-lids/${name}.json`, import.meta.url), 'utf8'));
    const rest = Float64Array.from(data.vertices.flat() as number[]);
    const deltas = { blink: new Float64Array(rest.length), squint: new Float64Array(rest.length), wide: new Float64Array(rest.length) };
    for (const [v, ...d] of data.moving as number[][]) { deltas.blink.set(d.slice(0, 3), v * 3); deltas.squint.set(d.slice(3, 6), v * 3); deltas.wide.set(d.slice(6, 9), v * 3); }
    return { surface: { label: 'lantern', rest, triangles: Uint32Array.from((data.triangles as number[][]).flat()), ...deltas }, center: data.center, radius: data.radius };
  };

  it('finds the lids passing through each other before the fix, in many contract poses and the lone blink', () => {
    const { surface, center, radius } = lantern('before-fix');
    const result = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage: [pose(0.25), pose(0.5), pose(1)] });
    expect(result.moving).toBeGreaterThan(500);
    expect(result.restPairs).toBe(0);
    expect(result.crossingPoses).toBeGreaterThanOrEqual(12);
    expect(result.crossing.map(c => c.pose)).toContain('eyeBlinkLeft=0.75');
    expect(result.worstCrossing!.pairs).toBeGreaterThan(10);
  }, 60_000);

  it('finds no pose in which the nested lids pass through each other: the contract poses, then the whole grid', () => {
    const { surface, center, radius } = lantern('after-fix');
    const contract = eyePenetration([surface], center, radius, FOLLOW, 'Left');
    expect(contract.poses).toBeGreaterThanOrEqual(28);
    expect(contract).toMatchObject({ crossingPoses: 0, worstCrossing: null, restPairs: 0 });
    const grid = eyePenetration([surface], center, radius, FOLLOW, 'Left', { grid: true });
    expect(grid).toMatchObject({ mode: 'grid', poses: 324, crossingPoses: 0 });
  }, 120_000);

  // The verifier judges two eyes of every head it is given, 33 poses each, so the cost of one pose is the cost of the check. Each
  // pose used to build a bounding-volume tree of every triangle near the eye (and the objects under it) before it found the few
  // pairs whose boxes touch, which made lid-penetration add 37 to 88 percent to the whole verifier. The default pass now meets
  // the pairs by their swept boxes first and hands the crossing test only the triangles that can meet. `exhaustive` runs the
  // crossing test on every triangle of every pose, as the check first did (without the box that culled the skin to the moving
  // triangles, which would have changed the edge ownership with the pass): it is the reference the default pass must agree with.
  describe('the default pass and the exhaustive pass', () => {
    // No pair limit that cuts a pose short: the pairs found, their order and the heights are then one set, whichever way they are met.
    const UNCUT = 1_000_000;
    const scaled = (s: LidSurface, by: { blink?: number; squint?: number; wide?: number }): LidSurface => ({
      ...s, blink: s.blink!.map(v => v * (by.blink ?? 1)), squint: s.squint!.map(v => v * (by.squint ?? 1)), wide: s.wide!.map(v => v * (by.wide ?? 1)),
    });

    it('find the same crossings in the same poses: lids that pass through each other', () => {
      const { surface, center, radius } = lantern('before-fix');
      const coverage = [pose(0.25), pose(0.5), pose(1)];
      const fast = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage, pairLimit: UNCUT });
      const slow = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage, pairLimit: UNCUT, exhaustive: true });
      expect(fast.crossingPoses).toBeGreaterThanOrEqual(12);
      expect(fast).toEqual(slow);
    }, 120_000);

    it('find the same crossings in the same poses: nested lids pushed past each other by a stronger squint, a stronger blink, a stronger wide', () => {
      const { surface, center, radius } = lantern('after-fix');
      const poses = [pose(0.5, 0.75), pose(1, 1), pose(1, 0, 1), pose(0.25, 0.5, 0.5), pose(0, 1, 1), pose(0.8375)];
      for (const by of [{ squint: 1.6 }, { blink: 1.4 }, { wide: 2 }, { blink: 1.2, squint: 1.2, wide: 1.2 }]) {
        const pushed = scaled(surface, by);
        const fast = eyePenetration([pushed], center, radius, FOLLOW, 'Left', { poses, pairLimit: UNCUT });
        const slow = eyePenetration([pushed], center, radius, FOLLOW, 'Left', { poses, pairLimit: UNCUT, exhaustive: true });
        expect(fast).toEqual(slow);
      }
    }, 120_000);

    it('find the same, none, in the nested lids over the contract poses', () => {
      const { surface, center, radius } = lantern('after-fix');
      const fast = eyePenetration([surface], center, radius, FOLLOW, 'Left');
      const slow = eyePenetration([surface], center, radius, FOLLOW, 'Left', { exhaustive: true });
      expect(fast).toMatchObject({ mode: 'contract', crossingPoses: 0 });
      expect(fast).toEqual(slow);
    }, 120_000);

    it('agree on how many poses cross and how many pairs the worst has, when the limit does cut a pose short', () => {
      const { surface, center, radius } = lantern('before-fix');
      const coverage = [pose(0.25), pose(0.5), pose(1)];
      const fast = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage });
      const slow = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage, exhaustive: true });
      expect(fast.crossingPoses).toBe(slow.crossingPoses);
      expect(fast.crossing).toEqual(slow.crossing);
      expect(fast.worstCrossing!.pairs).toBe(slow.worstCrossing!.pairs);
      expect(fast.worstCrossing!.pose).toBe(slow.worstCrossing!.pose);
    }, 120_000);

    it('are one pass when too many pairs could meet: the default pass falls back to crossing every triangle', () => {
      const { surface, center, radius } = lantern('before-fix');
      const coverage = [pose(0.5), pose(1)];
      const slow = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage, pairLimit: UNCUT, exhaustive: true });
      const fallback = eyePenetration([surface], center, radius, FOLLOW, 'Left', { coverage, pairLimit: UNCUT, maxCandidates: 10 });
      expect(slow.crossingPoses).toBeGreaterThan(0);
      expect(fallback).toEqual(slow);
    }, 120_000);

    it('differ in cost: the default pass judges the contract poses of a lid and the skin round it at least 4 times faster than the exhaustive pass', () => {
      const { surface, center, radius } = lantern('after-fix');
      // A sheet of skin beside the lid, 3,200 triangles that move a little with each morph and never meet the lid or each other
      // (a flat sheet at that: many of its pairs lie in one plane): the lid with the skin round it is what a head gives the check.
      const side = 40, points: number[] = [], blink: number[] = [], squint: number[] = [], wide: number[] = [], triangles: number[] = [];
      for (let i = 0; i <= side; i++) for (let j = 0; j <= side; j++) {
        points.push(center[0] + (i / side * 2 - 1) * 1.6 * radius, center[1] + 2.2 * radius, center[2] + (j / side * 2 - 1) * 1.6 * radius);
        blink.push(0, 0.0004 * Math.sin(3 * i / side), 0); squint.push(0, 0.0006 * j / side, 0.0002); wide.push(0.0002, 0, 0.0003 * i / side);
      }
      for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) { const a = i * (side + 1) + j; triangles.push(a, a + side + 1, a + side + 2, a, a + side + 2, a + 1); }
      const skin: LidSurface = { label: 'skin', rest: Float64Array.from(points), triangles: Uint32Array.from(triangles), blink: Float64Array.from(blink), squint: Float64Array.from(squint), wide: Float64Array.from(wide) };
      const time = (exhaustive: boolean) => {
        const start = performance.now();
        const result = eyePenetration([surface, skin], center, radius, FOLLOW, 'Left', { exhaustive });
        expect(result).toMatchObject({ crossingPoses: 0, restPairs: 0 });
        expect(result.triangles).toBeGreaterThan(5000);
        return performance.now() - start;
      };
      time(false); // warm both paths up before timing
      time(true);
      // The faster of three runs of each, alternating: the ratio holds when the machine is busy, which the seconds do not. About
      // 6 times when measured (the lid alone, whose every triangle can meet another, about 4).
      const fast: number[] = [], slow: number[] = [];
      for (let run = 0; run < 3; run++) { fast.push(time(false)); slow.push(time(true)); }
      expect(Math.min(...slow) / Math.min(...fast)).toBeGreaterThanOrEqual(4);
    }, 120_000);
  });
});

describe('the default pass and the exhaustive pass on random triangle soups', () => {
  // Lattice meshes: every coordinate and every delta is a multiple of 1/1024 m, and the weights are 0, 1/2 and 1, so all sums are
  // exact. Lots of vertices coincide in a pose without being welded at rest (the lids of a closed eye), triangles lie in one
  // plane, an edge lies in another triangle's plane, and morphs carry triangles through each other: the cases in which the
  // edge ownership of `surfaceCrossings` decides, and in which a pass that hands it too few triangles would differ.
  const UNIT = 1 / 1024;
  const generator = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const POSES: LidPose[] = [pose(1), pose(0, 1), pose(0, 0, 1), pose(0.5), pose(1, 1), pose(1, 0.5, 0.5), pose(0.5, 1, 1), pose(1, 1, 1)];

  function soup(random: () => number, lattice: number): LidSurface[] {
    const integer = (n: number) => Math.floor(random() * n);
    return [0, 1].map(piece => {
      const count = 8 + integer(8), points: P[] = [], deltas = { blink: [] as P[], squint: [] as P[], wide: [] as P[] };
      for (let v = 0; v < count; v++) {
        points.push([integer(lattice) * UNIT, integer(lattice) * UNIT, integer(lattice) * UNIT]);
        for (const name of ['blink', 'squint', 'wide'] as const) deltas[name].push(random() < 0.5 ? [0, 0, 0] : [(integer(5) - 2) * UNIT, (integer(5) - 2) * UNIT, (integer(5) - 2) * UNIT]);
      }
      const triangles: number[] = [];
      for (let t = 0; t < 14 + integer(10); t++) { const a = integer(count), b = integer(count), c = integer(count); if (a !== b && b !== c && a !== c) triangles.push(a, b, c); }
      const moved = (name: 'blink' | 'squint' | 'wide'): P[] => points.map((p, i) => [p[0] + deltas[name][i][0], p[1] + deltas[name][i][1], p[2] + deltas[name][i][2]]);
      return surface(`piece${piece}`, points, triangles, { blink: moved('blink'), squint: moved('squint'), wide: moved('wide') });
    });
  }
  /** The two passes' reports on one soup, as text; the soup crosses in a pose when `crossing`, already crosses at rest when `rest`. */
  function both(seed: number, lattice: number) {
    const surfaces = soup(generator(seed), lattice);
    const options = { poses: POSES, pairLimit: 1_000_000 };
    const fast = eyePenetration(surfaces, CENTER, 0.05, FOLLOW, 'Left', options);
    const slow = eyePenetration(surfaces, CENTER, 0.05, FOLLOW, 'Left', { ...options, exhaustive: true });
    return { same: JSON.stringify(fast) === JSON.stringify(slow), crossing: fast.crossingPoses > 0, rest: fast.restPairs > 0, fast: fast.crossing, slow: slow.crossing };
  }

  it('find the same crossings in the soups that once differed', () => {
    // Seeds 1041 to 1782 were found by searching 20,000 soups: an early default pass missed a crossing that rests on the edge
    // ownership of triangles it had not handed to the crossing test, because their corners coincide in the pose only (not welded
    // at rest). Seed 225 is one that differs when the pass does not read the triangles across an edge that lies in a plane.
    for (const [seed, lattice] of [[1041, 5], [2146, 5], [3359, 5], [3490, 5], [1782, 4], [225, 5]]) {
      const result = both(seed, lattice);
      expect({ seed, same: result.same }).toEqual({ seed, same: true });
    }
  });

  it('find the same crossings, in the same poses, in 1,500 random soups (and most of them cross)', () => {
    let crossing = 0, rest = 0;
    const different: number[] = [];
    for (let seed = 1; seed <= 1500; seed++) {
      const result = both(seed, 3 + (seed % 4));
      if (!result.same) different.push(seed);
      if (result.crossing) crossing++;
      if (result.rest) rest++;
    }
    expect(different).toEqual([]);
    // The soups exercise the check: many cross in a pose, many already cross at rest.
    expect(crossing).toBeGreaterThan(500);
    expect(rest).toBeGreaterThan(500);
  }, 120_000);
});
