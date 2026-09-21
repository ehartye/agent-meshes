export type PlanarPoint = readonly [number, number];
export interface PlanarCrank { readonly name: string; readonly center: string; readonly radius: number }
export interface PlanarIntersection {
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly ra: number;
  readonly rb: number;
  /** Sign of cross(b − a, joint − a), independent of previous samples. */
  readonly branch: -1 | 1;
}
export interface PlanarLinkageSpec {
  readonly fixed: Readonly<Record<string, PlanarPoint>>;
  readonly crank: PlanarCrank;
  /** Each intersection can only reference already defined points. */
  readonly joints: readonly PlanarIntersection[];
}
export interface PlanarLinkageSample {
  readonly points: Readonly<Record<string, PlanarPoint>>;
  /** Smallest distance between alternate intersections; null with no joints. */
  readonly minimumBranchGap: number | null;
}
export interface PlanarLinkage {
  sample(angleRadians: number): PlanarLinkageSample;
}

const MAX_COORDINATE = 1e6, MIN_RADIUS = 1e-6, MAX_ANGLE = 1e9;
const SINGULAR_TOLERANCE = 128 * Number.EPSILON;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be finite in ${min}..${max}`);
  return value;
}
function point(x: unknown, y: unknown, label: string): PlanarPoint {
  return Object.freeze([
    bounded(x, -MAX_COORDINATE, MAX_COORDINATE, `${label} X`),
    bounded(y, -MAX_COORDINATE, MAX_COORDINATE, `${label} Y`),
  ] as const);
}
function radiusMatches(p: PlanarPoint, center: PlanarPoint, radius: number, label: string): void {
  const actual = Math.hypot(p[0] - center[0], p[1] - center[1]);
  if (Math.abs(actual - radius) > radius * 1e-8) throw new Error(`Insufficient coordinate precision at ${label}`);
}

/**
 * Validate and detach an ordered, single-crank 2D mechanism. No renderer or time
 * state is retained. A valid graph may still be unreachable or singular at a
 * requested angle; sampling then throws without affecting any other sample.
 */
export function createPlanarLinkage(input: unknown): PlanarLinkage {
  const source = record(input, 'Planar linkage'), rawFixed = record(source.fixed, 'Fixed points');
  const known = new Set<string>(), fixed: [string, PlanarPoint][] = [];
  function name(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) || known.has(value)) throw new Error('Point names must be unique identifiers of at most 64 characters');
    known.add(value); return value;
  }
  function reference(value: unknown): string {
    if (typeof value !== 'string' || !known.has(value)) throw new Error(`Unknown or forward point reference: ${String(value)}`);
    return value;
  }
  for (const key in rawFixed) {
    if (!Object.hasOwn(rawFixed, key)) continue;
    if (fixed.length === 32) throw new Error('At most 32 fixed points are supported');
    const value = rawFixed[key];
    if (!Array.isArray(value) || value.length !== 2) throw new Error('Fixed points need two coordinates');
    fixed.push([name(key), point(value[0], value[1], key)]);
  }
  if (!fixed.length) throw new Error('At least one fixed point is required');
  const rawCrank = record(source.crank, 'Crank');
  const center = reference(rawCrank.center), crankRadius = bounded(rawCrank.radius, MIN_RADIUS, MAX_COORDINATE, 'Crank radius'), crankName = name(rawCrank.name);
  if (!Array.isArray(source.joints) || source.joints.length > 64) throw new Error('Joints must be an array of at most 64 intersections');
  const joints: PlanarIntersection[] = Array.from(source.joints, value => {
    const raw = record(value, 'Intersection'), a = reference(raw.a), b = reference(raw.b);
    if (a === b) throw new Error('Circle centers must reference different points');
    const ra = bounded(raw.ra, MIN_RADIUS, MAX_COORDINATE, 'Circle radius'), rb = bounded(raw.rb, MIN_RADIUS, MAX_COORDINATE, 'Circle radius');
    if (raw.branch !== -1 && raw.branch !== 1) throw new Error('Intersection branch must be -1 or +1');
    return { name: name(raw.name), a, b, ra, rb, branch: raw.branch };
  });

  return Object.freeze({
    sample(angleRadians: number): PlanarLinkageSample {
      const angle = bounded(angleRadians, -MAX_ANGLE, MAX_ANGLE, 'Crank angle') % (2 * Math.PI);
      // Null prototype permits ordinary names such as "constructor" safely.
      const points: Record<string, PlanarPoint> = Object.create(null);
      for (const [key, value] of fixed) points[key] = point(value[0], value[1], key);
      const origin = points[center];
      points[crankName] = point(origin[0] + crankRadius * Math.cos(angle), origin[1] + crankRadius * Math.sin(angle), crankName);
      radiusMatches(points[crankName], origin, crankRadius, crankName);
      let minimumBranchGap: number | null = null;
      for (const joint of joints) {
        const a = points[joint.a], b = points[joint.b], dx = b[0] - a[0], dy = b[1] - a[1], distance = Math.hypot(dx, dy);
        const scale = Math.max(distance, joint.ra, joint.rb);
        const d = distance / scale, ra = joint.ra / scale, rb = joint.rb / scale;
        if (d <= SINGULAR_TOLERANCE) throw new Error(`Coincident or singular circle centers at ${joint.name}`);
        if (d > ra + rb || d < Math.abs(ra - rb)) throw new Error(`Linkage cannot close at ${joint.name}`);
        // Normalize before squaring, and factor the difference of squared radii.
        const along = .5 * (d + (ra - rb) * (ra + rb) / d);
        const heightSquared = (ra - along) * (ra + along);
        if (heightSquared <= SINGULAR_TOLERANCE) throw new Error(`Singular or near-tangent intersection at ${joint.name}`);
        const height = Math.sqrt(heightSquared), ux = dx / distance, uy = dy / distance;
        const solved = point(a[0] + scale * (along * ux - joint.branch * height * uy), a[1] + scale * (along * uy + joint.branch * height * ux), joint.name);
        radiusMatches(solved, a, joint.ra, joint.name); radiusMatches(solved, b, joint.rb, joint.name);
        const signedHeight = ux * (solved[1] - a[1]) - uy * (solved[0] - a[0]);
        if (signedHeight * joint.branch <= 0) throw new Error(`Insufficient branch precision at ${joint.name}`);
        points[joint.name] = solved;
        const gap = 2 * height * scale;
        minimumBranchGap = minimumBranchGap === null ? gap : Math.min(minimumBranchGap, gap);
      }
      return Object.freeze({ points: Object.freeze(points), minimumBranchGap });
    },
  });
}
