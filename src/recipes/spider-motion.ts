import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from '../core/types.ts';
import { footPath } from './gait.ts';

export const spiderGait = { stride: 0.25, lift: 0.075, stance: 0.70, duration: 1.6 } as const;

export function spiderStep(phase: number, side: number, index: number) {
  // Adjacent legs alternate, with a small rear-to-front wave within each group.
  const cycle = phase + (index + (side < 0 ? 0 : 1)) % 2 * 0.5 + index * 0.035;
  return footPath(cycle, spiderGait.stride, spiderGait.lift, spiderGait.stance);
}

/** A wider, less fore/aft-splayed stance lets the hip sweep without changing reach much. */
export function spiderContact(hip: Vec3, foot: Vec3): Vec3 {
  const x = foot[0] - hip[0], z = foot[2] - hip[2], spread = z * 0.45;
  return [hip[0] + Math.sign(x) * Math.sqrt(x * x + z * z - spread * spread), foot[1], hip[2] + spread];
}

/** Recovery follows a hip-centred arc; planted feet retain a straight, no-slip path. */
export function spiderTarget(hip: Vec3, contact: Vec3, offset: Vec3, bob: number): Vec3 {
  const x = contact[0] - hip[0], depth = hip[1] - contact[1], lift = offset[1];
  const reach = Math.sqrt(x * x + lift * (2 * depth - lift));
  return [hip[0] + Math.sign(x) * reach, contact[1] + lift - bob, contact[2] + offset[2]];
}

/** Sweep and lift the whole leg at the thorax. One small patella hinge correction
 * changes reach just enough to plant the foot; no joint has an independent wiggle.
 * The limits describe this authored pose, not measured species joint limits.
 */
export function solveSpiderPose(rest: Vec3[], target: Vec3): Quat[] {
  if (rest.length !== 8 || ![...rest, target].every(p => p.length === 3 && p.every(Number.isFinite))) {
    throw new Error('Spider pose needs eight finite rest points and a finite target');
  }
  const points = rest.map(p => new Vector3(...p)), destination = new Vector3(...target).sub(points[0]);
  const offsets = points.slice(1).map((p, i) => p.clone().sub(points[i]));
  const radial = points[7].clone().sub(points[0]).setY(0).normalize();
  const hinge = radial.clone().cross(new Vector3(0, 1, 0)).normalize();
  if (destination.length() < 1e-8 || hinge.lengthSq() < 0.5 || offsets.some(v => v.length() < 1e-8)) {
    throw new Error('Spider pose has a degenerate leg or target');
  }
  // All other joints stay at their rest angles; each side of the patella is rigid.
  const upper = points[3].clone().sub(points[0]), lower = points[7].clone().sub(points[3]);
  let flex = 0;

  function forward() {
    const segment = lower.clone().applyAxisAngle(hinge, flex);
    return { tip: upper.clone().add(segment), derivative: hinge.clone().cross(segment) };
  }

  for (let iteration = 0; iteration < 16; iteration++) {
    const { tip, derivative } = forward(), error = tip.length() - destination.length();
    if (Math.abs(error) < 1e-9) {
      const hip = new Quaternion().setFromUnitVectors(tip.normalize(), destination.clone().normalize());
      const rotations: Quat[] = Array.from({ length: 7 }, () => [0, 0, 0, 1]);
      rotations[0] = hip.toArray() as Quat;
      rotations[3] = new Quaternion().setFromAxisAngle(hinge, flex).toArray() as Quat;
      return rotations;
    }
    const slope = tip.dot(derivative) / tip.length();
    if (Math.abs(slope) < 1e-8) break;
    flex = Math.max(-0.1, Math.min(0.1, flex - error / slope));
  }
  throw new Error(`Spider target is outside the constrained pose range (${Math.abs(forward().tip.length() - destination.length())} m reach error)`);
}
