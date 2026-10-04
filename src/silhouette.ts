import { readGLB } from './gltf-read.ts';
import { forEachWorldTriangle, type Point } from './glb-geometry.ts';

export type Axis = 'x' | 'y' | 'z';
export interface SilhouetteOptions {
  axis?: Axis; bins?: number;
  /** The two coordinates the axis passes through, in the order of the remaining axes (x,z for y; y,z for x; x,y for z). Default 0,0. */
  center?: [number, number];
}
export interface SilhouetteBin { from: number; to: number; /** Largest distance from the axis of any surface in the bin; null when the bin holds no surface. */ radius: number | null }
export interface Silhouette { axis: Axis; center: [number, number]; min: number; max: number; bins: SilhouetteBin[] }

const index = { x: 0, y: 1, z: 2 } as const;

/**
 * Radius against height of the exported geometry, with node matrices applied: for each bin along `axis`, the
 * largest distance from the axis of any triangle surface in that slab. Triangles are clipped to the slab, so a
 * long wall that spans several bins is measured in each, not only at its vertices.
 */
export function silhouette(bytes: Uint8Array, options: SilhouetteOptions = {}): Silhouette {
  const axis = options.axis ?? 'y', count = options.bins ?? 100, center = options.center ?? [0, 0];
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw Object.assign(new Error('bins must be an integer from 1 to 100000'), { code: 'CLI_ARGUMENT_ERROR' });
  const h = index[axis], [u, v] = [0, 1, 2].filter(i => i !== h);
  const triangles: Point[][] = [];
  let min = Infinity, max = -Infinity;
  forEachWorldTriangle(readGLB(bytes), (...corners) => {
    triangles.push(corners);
    for (const p of corners) { if (!Number.isFinite(p[h]) || !Number.isFinite(p[u]) || !Number.isFinite(p[v])) throw new Error('POSITION contains non-finite data'); min = Math.min(min, p[h]); max = Math.max(max, p[h]); }
  });
  if (!triangles.length) throw Object.assign(new Error('GLB has no drawn triangles to measure'), { code: 'NO_GEOMETRY' });
  const step = (max - min) / count || 1;
  const radii = new Array<number | null>(count).fill(null);
  const radius = (p: Point) => Math.hypot(p[u] - center[0], p[v] - center[1]);
  const clip = (polygon: Point[], keep: (p: Point) => boolean, at: number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], ka = keep(a), kb = keep(b);
      if (ka) out.push(a);
      if (ka !== kb) { const t = (at - a[h]) / (b[h] - a[h]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    return out;
  };
  for (const triangle of triangles) {
    const low = Math.min(...triangle.map(p => p[h])), high = Math.max(...triangle.map(p => p[h]));
    const first = Math.max(0, Math.min(count - 1, Math.floor((low - min) / step - 1e-9))), last = Math.max(0, Math.min(count - 1, Math.floor((high - min) / step + 1e-9)));
    for (let bin = first; bin <= last; bin++) {
      const from = min + bin * step, to = bin === count - 1 ? max : min + (bin + 1) * step;
      let polygon = clip(triangle, p => p[h] >= from - 1e-12, from);
      if (polygon.length) polygon = clip(polygon, p => p[h] <= to + 1e-12, to);
      for (const p of polygon) { const r = radius(p); if (radii[bin] === null || r > radii[bin]!) radii[bin] = r; }
    }
  }
  return { axis, center: [center[0], center[1]], min, max, bins: radii.map((r, i) => ({ from: min + i * step, to: i === count - 1 ? max : min + (i + 1) * step, radius: r })) };
}

export interface LintOptions {
  /** Height zones [y0, y1] where a narrowing followed by a widening is intended (a collar, a bead, a cove). */
  allow?: [number, number][];
  /** Smallest radius change in metres that counts as a real rise or fall, so facet noise is ignored. Default 0.001. */
  tolerance?: number;
}
export interface NotchFinding {
  /** Height of the narrowest point. */
  y: number; radius: number;
  /** The wider radius below and above the narrowing, and where each is. */
  before: { y: number; radius: number }; after: { y: number; radius: number };
  /** How far the profile narrows: the smaller neighbour radius minus the radius at the notch. */
  depth: number; message: string;
}

/**
 * Finds every local minimum of radius that has a larger radius before and after it along the axis, the classic
 * notch in a turned profile. Radius changes smaller than `tolerance` are ignored; zones in `allow` are skipped.
 */
export function lintSilhouette(profile: Silhouette, options: LintOptions = {}): NotchFinding[] {
  const tolerance = options.tolerance ?? 0.001;
  const samples = profile.bins.filter(bin => bin.radius !== null).map(bin => ({ y: (bin.from + bin.to) / 2, r: bin.radius! }));
  if (!samples.length) return [];
  type Extreme = { kind: 'min' | 'max'; y: number; r: number };
  const extremes: Extreme[] = [];
  let direction = 0, hi = samples[0], lo = samples[0];
  for (const sample of samples) {
    if (direction >= 0 && sample.r > hi.r) hi = sample;
    if (direction <= 0 && sample.r < lo.r) lo = sample;
    if (direction === 0) {
      if (sample.r - lo.r > tolerance) { extremes.push({ kind: 'min', y: lo.y, r: lo.r }); direction = 1; hi = sample; }
      else if (hi.r - sample.r > tolerance) { extremes.push({ kind: 'max', y: hi.y, r: hi.r }); direction = -1; lo = sample; }
    } else if (direction > 0 && hi.r - sample.r > tolerance) { extremes.push({ kind: 'max', y: hi.y, r: hi.r }); direction = -1; lo = sample; }
    else if (direction < 0 && sample.r - lo.r > tolerance) { extremes.push({ kind: 'min', y: lo.y, r: lo.r }); direction = 1; hi = sample; }
  }
  if (direction > 0) extremes.push({ kind: 'max', y: hi.y, r: hi.r }); else if (direction < 0) extremes.push({ kind: 'min', y: lo.y, r: lo.r });
  const findings: NotchFinding[] = [];
  const allowed = (y: number) => (options.allow ?? []).some(([a, b]) => y >= Math.min(a, b) && y <= Math.max(a, b));
  const m = (n: number) => Number(n.toFixed(4));
  for (let k = 1; k < extremes.length - 1; k++) {
    const notch = extremes[k], before = extremes[k - 1], after = extremes[k + 1];
    if (notch.kind !== 'min' || before.kind !== 'max' || after.kind !== 'max' || allowed(notch.y)) continue;
    const depth = Math.min(before.r, after.r) - notch.r;
    findings.push({ y: notch.y, radius: notch.r, before: { y: before.y, radius: before.r }, after: { y: after.y, radius: after.r }, depth,
      message: `notch at ${profile.axis}=${m(notch.y)}: radius narrows from ${m(before.r)} (at ${m(before.y)}) to ${m(notch.r)}, then widens to ${m(after.r)} (at ${m(after.y)}); depth ${m(depth)}` });
  }
  return findings;
}
