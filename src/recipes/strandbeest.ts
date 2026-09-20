import { Quaternion, Vector3 } from 'three';
import { validateProject } from '../core/model.ts';
import type { Project, Quat, Track, Vec3 } from '../core/types.ts';

/**
 * Theo Jansen's leg linkage, with the rod lengths he published (his "holy numbers"), and a
 * Strandbeest-style walker built from mirrored leg pairs on one crankshaft. Every crank position
 * carries four legs: left and right, and on each side a front-facing leg and its back-facing
 * mirror driven by the same crank pin, so the feet straddle the axle and the body stands over them.
 * The linkage is planar: one crank turn drives eleven rods so the foot traces a flat-bottomed
 * loop. Points follow the usual diagram: O is the crank axle, P the fixed pivot to its left,
 * C the crank pin; A and B hang from C and P; D closes the upper triangle P A D; E is the knee
 * between D and B; F is the foot closing the lower triangle B E F.
 */
export const JANSEN = { a: 38, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7, h: 65.7, i: 49, j: 50, k: 61.9, l: 7.8, m: 15 } as const;

export type P2 = [number, number];
export interface JansenLeg { O: P2; P: P2; C: P2; A: P2; B: P2; D: P2; E: P2; F: P2 }

/** The two intersections of circles (c1, r1) and (c2, r2); `pick` chooses one. */
function meet(c1: P2, r1: number, c2: P2, r2: number, pick: (p: P2, q: P2) => P2): P2 {
  const dx = c2[0] - c1[0], dy = c2[1] - c1[1], d = Math.hypot(dx, dy);
  if (d > r1 + r2 || d < Math.abs(r1 - r2) || d === 0) throw new Error(`Linkage cannot close: circles ${r1} and ${r2} at distance ${d.toFixed(3)}`);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + a * dx / d, my = c1[1] + a * dy / d;
  return pick([mx + h * dy / d, my - h * dx / d], [mx - h * dy / d, my + h * dx / d]);
}
const lower = (p: P2, q: P2): P2 => (p[1] < q[1] ? p : q);
const leftmost = (p: P2, q: P2): P2 => (p[0] < q[0] ? p : q);

/** Solve one leg for a crank angle, in Jansen's units, x forward and y up, crank axle at the origin. */
export function solveJansenLeg(theta: number): JansenLeg {
  const { a, b, c, d, e, f, g, h, i, j, k, l, m } = JANSEN;
  const O: P2 = [0, 0], P: P2 = [-a, -l];
  const C: P2 = [m * Math.cos(theta), m * Math.sin(theta)];
  // Branches chosen so the foot path is the classic one: flat along the bottom, below and
  // behind the axle, continuous through the whole turn.
  const A = meet(P, b, C, j, lower);
  const B = meet(P, c, C, k, lower);
  const D = meet(P, d, A, e, leftmost);
  const E = meet(D, f, B, g, lower);
  const F = meet(B, h, E, i, lower);
  return { O, P, C, A, B, D, E, F };
}

/** The rods as pairs of joint names, keyed by Jansen's letters (the frame a and l are static). */
const RODS: Record<string, [keyof JansenLeg, keyof JansenLeg]> = { m: ['O', 'C'], j: ['C', 'A'], k: ['C', 'B'], b: ['P', 'A'], c: ['P', 'B'], d: ['P', 'D'], e: ['A', 'D'], f: ['D', 'E'], g: ['B', 'E'], h: ['B', 'F'], i: ['E', 'F'] };

export interface StrandbeestOptions {
  /** Crank positions along the shaft; each carries four legs (L and R, front- and back-facing). Default 3. */
  pairs?: number; scale?: number; name?: string; duration?: number;
  /** Distance between leg pairs along the crankshaft, in meters. Default 0.42. */
  spacing?: number;
  /** One clip per entry: the crank offset of each pair as a fraction of a turn. Default one clip, `walk`, with the cranks spread evenly. */
  patterns?: Record<string, number[]>;
}

/** A walker of Jansen legs along one crankshaft, four to a crank position, cranks offset evenly around the turn. */
export function createStrandbeest(options: StrandbeestOptions = {}): Project {
  const pairs = options.pairs ?? 3, scale = options.scale ?? 0.012, duration = options.duration ?? 2.4, name = options.name ?? 'Strandbeest';
  // Four legs of twelve bones per crank position, plus the root, must fit the project's 256-bone limit.
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5) throw new Error(`Strandbeest takes at most 5 crank positions (four legs each), received ${pairs}`);
  const tube = '#e6c84a', dark = '#3b3a30', frameColor = '#cfae37';
  // 60 samples per turn; with segments-5 rods, three crank positions (twelve legs) export well under 2.6 MB.
  const frames = 60;
  // Ground level: the lowest the foot ever goes, so feet touch y = 0 at the bottom of the stance.
  let lowest = Infinity;
  for (let k = 0; k < frames; k++) lowest = Math.min(lowest, solveJansenLeg(2 * Math.PI * k / frames).F[1]);
  const axleHeight = -lowest * scale;
  const project: Project = { version: 1, name, parts: [], bones: [{ name: 'root', parent: null, position: [0, axleHeight, 0], rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1] }], clips: [], shells: [] };
  const spacing = options.spacing ?? 0.42, inner = 0.32;
  const sideX = (side: number, pair: number) => side * (inner + pair * spacing);
  // Leg-space (x forward, y up) to root-local space (z forward, y up) at a given side offset. A back-facing
  // leg (facing -1) is the linkage mirrored through the vertical plane of the crankshaft, so its foot path
  // lies ahead of the axle where the front-facing leg's lies behind it.
  const world = (p: P2, x: number, facing: number): Vec3 => [x, p[1] * scale, facing * p[0] * scale];
  // The same crank pin seen from the mirrored leg: (m cos t, m sin t) reflected in x is the angle pi - t.
  const crank = (theta: number, facing: number) => (facing < 0 ? Math.PI - theta : theta);
  const rodQuaternion = (from: Vec3, to: Vec3): Quat => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize()).toArray() as Quat;

  const patterns = options.patterns ?? { walk: Array.from({ length: pairs }, (_, pair) => pair / pairs) };
  for (const [clipName, offsets] of Object.entries(patterns)) if (offsets.length !== pairs) throw new Error(`Expected ${pairs} crank offsets for ${clipName}, received ${offsets.length}`);
  const legs: { prefix: string; x: number; facing: number; pair: number }[] = [];
  for (let pair = 0; pair < pairs; pair++) for (const side of [-1, 1]) for (const facing of [1, -1]) {
    const prefix = `leg_${side < 0 ? 'L' : 'R'}_${pair + 1}${facing > 0 ? 'f' : 'b'}`, x = sideX(side, pair), phase = 2 * Math.PI * pair / pairs;
    // Rest pose spreads the cranks evenly whatever the patterns, so every clip starts from the same rig.
    legs.push({ prefix, x, facing, pair });
    const rest = solveJansenLeg(crank(phase, facing));
    for (const [rod, [from, to]] of Object.entries(RODS)) {
      const start = world(rest[from], x, facing), end = world(rest[to], x, facing);
      project.bones.push({ name: `${prefix}_${rod}`, parent: 'root', position: start, rotation: rodQuaternion(start, end), pose: [0, 0, 0, 1] });
      const length = JANSEN[rod as keyof typeof JANSEN] * scale;
      project.parts.push({ name: `${prefix}_${rod}_rod`, geometry: { type: 'capsule', size: [rod === 'm' ? 0.05 : 0.035, length, rod === 'm' ? 0.05 : 0.035], segments: 5 }, color: rod === 'm' ? dark : tube, position: [0, length / 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: `${prefix}_${rod}` } });
    }
    project.bones.push({ name: `${prefix}_foot`, parent: 'root', position: world(rest.F, x, facing), rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1] });
    const fw = world(rest.F, x, facing);
    project.parts.push({ name: `${prefix}_foot_pad`, geometry: { type: 'sphere', size: [0.09, 0.06, 0.12], segments: 8 }, color: dark, position: [fw[0], fw[1] + axleHeight, fw[2]], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: `${prefix}_foot` } });
    // The fixed frame of this leg: axle to pivot, rigid with the body.
    const o = world(rest.O, x, facing), p = world(rest.P, x, facing), frameLength = Math.hypot(JANSEN.a, JANSEN.l) * scale;
    project.parts.push({ name: `${prefix}_frame`, geometry: { type: 'capsule', size: [0.04, frameLength, 0.04], segments: 7 }, color: frameColor, position: [(o[0] + p[0]) / 2, (o[1] + p[1]) / 2 + axleHeight, (o[2] + p[2]) / 2], rotation: rodQuaternion(o, p), scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: 'root' } });
  }
  // Body: the crankshaft across the pairs and a backbone tube above it.
  const span = 2 * (inner + (pairs - 1) * spacing) + 0.3;
  project.parts.push({ name: 'crankshaft', geometry: { type: 'cylinder', size: [0.06, span, 0.06], segments: 12 }, color: dark, position: [0, axleHeight, 0], rotation: [0, 0, 0.7071068, 0.7071068], scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: 'root' } });
  project.parts.push({ name: 'backbone', geometry: { type: 'cylinder', size: [0.05, span, 0.05], segments: 12 }, color: frameColor, position: [0, axleHeight + 0.32, -0.12], rotation: [0, 0, 0.7071068, 0.7071068], scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: 'root' } });
  project.parts.push({ name: 'spine', geometry: { type: 'capsule', size: [0.05, 0.4, 0.05], segments: 10 }, color: frameColor, position: [0, axleHeight + 0.16, -0.06], rotation: [0.1837, 0, 0, 0.983], scale: [1, 1, 1], parent: null, binding: { type: 'rigid', bone: 'root' } });

  // Convert absolute joint positions and rod directions into offsets from each bone's rest.
  // Anchor parts to their bones so the capsule sits along the rod: position is bone-local at rest.
  for (const part of project.parts) if (part.name.endsWith('_rod')) {
    const bone = project.bones.find(b => b.name === part.name.slice(0, -4))!;
    const local = new Vector3(...part.position).applyQuaternion(new Quaternion(...bone.rotation));
    part.position = [bone.position[0] + local.x, bone.position[1] + local.y + axleHeight, bone.position[2] + local.z];
    part.rotation = [...bone.rotation] as Quat;
  }
  const restOf = new Map(project.bones.map(b => [b.name, b]));
  for (const [clipName, offsets] of Object.entries(patterns)) {
    const tracks: Track[] = [{ bone: 'root', property: 'position', keys: [] }];
    for (const leg of legs) {
      for (const rod of Object.keys(RODS)) tracks.push({ bone: `${leg.prefix}_${rod}`, property: 'position', keys: [] }, { bone: `${leg.prefix}_${rod}`, property: 'rotation', keys: [] });
      tracks.push({ bone: `${leg.prefix}_foot`, property: 'position', keys: [] });
    }
    for (let k = 0; k <= frames; k++) {
      const t = k === frames ? 0 : k / frames, time = k / frames * duration;
      tracks[0].keys.push({ time, value: [0, 0.01 * (1 - Math.cos(2 * Math.PI * pairs * t)), 0] });
      let index = 1;
      for (const leg of legs) {
        const solved = solveJansenLeg(crank(2 * Math.PI * (offsets[leg.pair] + t), leg.facing));
        for (const [rod, [from, to]] of Object.entries(RODS)) {
          const bone = restOf.get(`${leg.prefix}_${rod}`)!;
          const start = world(solved[from], leg.x, leg.facing), end = world(solved[to], leg.x, leg.facing);
          const absolute = new Quaternion(...rodQuaternion(start, end));
          const offset = new Quaternion(...bone.rotation).invert().multiply(absolute).normalize();
          tracks[index++].keys.push({ time, value: [start[0] - bone.position[0], start[1] - bone.position[1], start[2] - bone.position[2]] });
          tracks[index++].keys.push({ time, value: offset.toArray() as Quat });
        }
        const foot = restOf.get(`${leg.prefix}_foot`)!, f = world(solved.F, leg.x, leg.facing);
        tracks[index++].keys.push({ time, value: [f[0] - foot.position[0], f[1] - foot.position[1], f[2] - foot.position[2]] });
      }
    }
    for (const track of tracks) if (track.property === 'rotation') {
      for (let i = 1; i < track.keys.length; i++) {
        const previous = track.keys[i - 1].value, current = track.keys[i].value;
        if (current.reduce((sum, n, j) => sum + n * previous[j], 0) < 0) track.keys[i].value = current.map(n => -n) as Quat;
      }
    }
    for (const track of tracks) track.keys[track.keys.length - 1].value = [...track.keys[0].value] as Vec3 | Quat;
    project.clips.push({ name: clipName, duration, tracks });
  }
  return validateProject(JSON.parse(JSON.stringify(project)));
}
