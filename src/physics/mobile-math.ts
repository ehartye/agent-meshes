export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const multiply = (a: Vec3, scale: number): Vec3 => [a[0] * scale, a[1] * scale, a[2] * scale];
export const length = (a: Vec3): number => Math.hypot(...a);
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vector = (a: Vec3) => ({ x: a[0], y: a[1], z: a[2] });
export const tuple = (a: { x: number; y: number; z: number }): Vec3 => [a.x, a.y, a.z];
export const quaternion = (q: { x: number; y: number; z: number; w: number }): Quat => [q.x, q.y, q.z, q.w];

export function rotate(p: Vec3, q: Quat): Vec3 {
  const t: Vec3 = [2 * (q[1] * p[2] - q[2] * p[1]), 2 * (q[2] * p[0] - q[0] * p[2]), 2 * (q[0] * p[1] - q[1] * p[0])];
  return [p[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1], p[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2], p[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]];
}

/** Rotation from the capsule's local Y axis to a nonzero segment. */
export function wireRotation(delta: Vec3): { x: number; y: number; z: number; w: number } {
  const d = multiply(delta, 1 / length(delta));
  if (d[1] < -1 + 1e-12) return { x: 1, y: 0, z: 0, w: 0 };
  const q = [d[2], 0, -d[0], 1 + d[1]], magnitude = Math.hypot(...q);
  return { x: q[0] / magnitude, y: 0, z: q[2] / magnitude, w: q[3] / magnitude };
}

export function pathDistances(points: readonly Vec3[]): readonly number[] {
  const result = [0];
  for (let i = 1; i < points.length; i++) result.push(result[i - 1] + length(subtract(points[i], points[i - 1])));
  return result;
}

export function samplePath(points: readonly Vec3[], distances: readonly number[], u: number): Vec3 {
  const distance = u * distances[distances.length - 1];
  let i = 1;
  while (i < points.length - 1 && distance > distances[i]) i++;
  const fraction = (distance - distances[i - 1]) / (distances[i] - distances[i - 1]);
  return add(points[i - 1], multiply(subtract(points[i], points[i - 1]), fraction));
}

/** Detaches are performed by validation; this protects shared immutable snapshot geometry. */
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function finite(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be finite in ${min}..${max}`);
  return value;
}
