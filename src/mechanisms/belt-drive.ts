/** Coordinates in one plane; the renderer chooses how to place that plane in 3D. */
export type BeltPoint = readonly [number, number];
export interface BeltPulley { readonly center: BeltPoint; readonly radius: number }
export interface BeltDriveSpec { readonly driver: BeltPulley; readonly driven: BeltPulley; readonly crossed?: boolean }
export type BeltSegment = Readonly<{ kind: 'line'; start: BeltPoint; end: BeltPoint; length: number }> |
  Readonly<{ kind: 'arc'; center: BeltPoint; radius: number; startAngle: number; sweep: number; length: number }>;
export interface BeltDrive {
  readonly driver: BeltPulley;
  readonly driven: BeltPulley;
  readonly crossed: boolean;
  /** Driven angular displacement / driver displacement; negative for a crossed belt. */
  readonly ratio: number;
  readonly length: number;
  /** Closed directed path: first span, driven arc, return span, driver arc. */
  readonly segments: readonly BeltSegment[];
  sample(driverAngle: number): Readonly<{ driverAngle: number; drivenAngle: number; beltTravel: number }>;
  /** Signed distance along the directed path, wrapped to its length, plus a unit tangent. */
  point(distance: number): Readonly<{ point: BeltPoint; tangent: BeltPoint }>;
}

const TAU = Math.PI * 2, MAX_COMPONENT = 1e6, MAX_ANGLE = 1e9, MAX_TRAVEL = 1e12;
const pair = (x: number, y: number): BeltPoint => Object.freeze([x, y] as [number, number]);
function pulley(value: BeltPulley, label: string): BeltPulley {
  if (!value || !Array.isArray(value.center) || value.center.length !== 2 ||
    ![0, 1].every(i => Number.isFinite(value.center[i]) && Math.abs(value.center[i]) <= MAX_COMPONENT)) {
    throw new Error(`${label} center needs two finite coordinates in ±1e6`);
  }
  if (!Number.isFinite(value.radius) || value.radius < 1e-6 || value.radius > MAX_COMPONENT) throw new Error(`${label} pitch radius must be within 1e-6..1e6`);
  return Object.freeze({ center: pair(value.center[0], value.center[1]), radius: value.radius });
}
function bounded(value: number, bound: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > bound) throw new Error(`${label} must be finite and within ±${bound}`);
}

/**
 * Two disjoint circular pitch pulleys connected by an ideal taut, zero-thickness belt.
 * No slip, friction, elasticity, tension, inertia or contact forces are simulated. Changing
 * radii requires a new model/belt length; there is no implicit tensioner. Angles are radians,
 * positive counterclockwise in the supplied plane. Sampling is stateless and reversible.
 */
export function createBeltDrive(spec: BeltDriveSpec): BeltDrive {
  if (!spec || typeof spec !== 'object') throw new Error('Belt drive needs a specification');
  const driver = pulley(spec.driver, 'Driver'), driven = pulley(spec.driven, 'Driven');
  if (spec.crossed !== undefined && typeof spec.crossed !== 'boolean') throw new Error('Crossed must be boolean');
  const crossed = spec.crossed ?? false, sign = crossed ? -1 : 1;
  const dx = driven.center[0] - driver.center[0], dy = driven.center[1] - driver.center[1], separation = Math.hypot(dx, dy);
  const scale = Math.max(...driver.center.map(Math.abs), ...driven.center.map(Math.abs), separation, driver.radius, driven.radius);
  const uncertainty = 64 * Number.EPSILON * scale;
  if (separation - driver.radius - driven.radius <= uncertainty) throw new Error('Pulley pitch circles must be disjoint with a resolvable gap');
  if (uncertainty / Math.min(driver.radius, driven.radius) > 1e-7) throw new Error('Coordinates cannot preserve the required radius precision');
  const ratio = sign * driver.radius / driven.radius, ux = dx / separation, uy = dy / separation;
  const cosine = (driver.radius - sign * driven.radius) / separation;
  const sine = Math.sqrt((1 - cosine) * (1 + cosine)), alpha = Math.acos(cosine), direction = Math.atan2(dy, dx);
  const normal = (side: number): BeltPoint => pair(ux * cosine - uy * side * sine, uy * cosine + ux * side * sine);
  const contact = (wheel: BeltPulley, n: BeltPoint, side: number): BeltPoint => pair(wheel.center[0] + side * wheel.radius * n[0], wheel.center[1] + side * wheel.radius * n[1]);
  const plus = normal(1), minus = normal(-1), aPlus = contact(driver, plus, 1), aMinus = contact(driver, minus, 1), bPlus = contact(driven, plus, sign), bMinus = contact(driven, minus, sign);
  const line = (start: BeltPoint, end: BeltPoint): BeltSegment => Object.freeze({ kind: 'line', start, end, length: Math.hypot(end[0] - start[0], end[1] - start[1]) });
  const arc = (wheel: BeltPulley, startAngle: number, sweep: number): BeltSegment => Object.freeze({ kind: 'arc', center: wheel.center, radius: wheel.radius, startAngle, sweep, length: Math.abs(sweep) * wheel.radius });
  const segments = Object.freeze([
    line(aPlus, bPlus), arc(driven, direction + alpha + (crossed ? Math.PI : 0), crossed ? TAU - 2 * alpha : -2 * alpha),
    line(bMinus, aMinus), arc(driver, direction - alpha, 2 * alpha - TAU),
  ]);
  const length = segments.reduce((sum, segment) => sum + segment.length, 0);
  return Object.freeze({
    driver, driven, crossed, ratio, length, segments,
    sample(driverAngle: number) {
      bounded(driverAngle, MAX_ANGLE, 'Driver angle');
      const drivenAngle = driverAngle * ratio, beltTravel = -driverAngle * driver.radius;
      bounded(drivenAngle, MAX_ANGLE, 'Driven angle'); bounded(beltTravel, MAX_TRAVEL, 'Belt travel');
      return Object.freeze({ driverAngle, drivenAngle, beltTravel });
    },
    point(distance: number) {
      bounded(distance, MAX_TRAVEL, 'Belt distance');
      // Reject distances whose floating-point spacing can no longer resolve the belt.
      if (Math.abs(distance) * Number.EPSILON / length > 1e-8) throw new Error('Belt distance cannot preserve phase precision');
      let at = ((distance % length) + length) % length;
      for (const [i, segment] of segments.entries()) {
        if (at > segment.length && i < segments.length - 1) { at -= segment.length; continue; }
        const t = Math.max(0, Math.min(1, at / segment.length));
        if (segment.kind === 'line') {
          const x = segment.end[0] - segment.start[0], y = segment.end[1] - segment.start[1];
          return Object.freeze({ point: pair(segment.start[0] + t * x, segment.start[1] + t * y), tangent: pair(x / segment.length, y / segment.length) });
        }
        const angle = segment.startAngle + t * segment.sweep, c = Math.cos(angle), s = Math.sin(angle), turn = Math.sign(segment.sweep);
        return Object.freeze({ point: pair(segment.center[0] + segment.radius * c, segment.center[1] + segment.radius * s), tangent: pair(-turn * s, turn * c) });
      }
      throw new Error('Unreachable belt segment');
    },
  });
}
