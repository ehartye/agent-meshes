import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from '../core/types.ts';
import { footPath } from './gait.ts';

export const spiderGait = { stride: 0.25, lift: 0.075, stance: 0.70, duration: 1.6 } as const;

export function spiderStep(phase: number, side: number, index: number) {
  // Adjacent legs alternate, with a small rear-to-front wave within each group.
  const cycle = phase + (index + (side < 0 ? 0 : 1)) % 2 * 0.5 + index * 0.035;
  return footPath(cycle, spiderGait.stride, spiderGait.lift, spiderGait.stance);
}

/** Fixed local hinge axes; hip yaw, femur elevation and knee flex solve the foot target.
 * Smaller joints follow recovery instead of independently chasing the endpoint.
 * These bounds are for this stylized rest shape, not measured species joint limits.
 */
export function solveSpiderPose(rest: Vec3[], target: Vec3, recovery: number): Quat[] {
  if (rest.length !== 8 || ![...rest, target].every(p => p.length === 3 && p.every(Number.isFinite)) || !Number.isFinite(recovery) || recovery < 0 || recovery > 1) {
    throw new Error('Spider pose needs eight finite rest points, a finite target, and recovery in [0, 1]');
  }
  const points = rest.map(p => new Vector3(...p)), end = new Vector3(...target);
  const offsets = points.slice(1).map((p, i) => p.clone().sub(points[i]));
  const radial = points[7].clone().sub(points[0]).setY(0).normalize();
  const hinge = radial.clone().cross(new Vector3(0, 1, 0)).normalize();
  const axes = [new Vector3(0, 1, 0), ...Array.from({ length: 6 }, () => hinge.clone())];
  const angles = [0, -0.035 * recovery, 0, 0, 0.018 * recovery, 0.20 * recovery, -0.10 * recovery];
  const drivers = [0, 2, 3], limits = [0.6, 0.7, 0.8];

  function forward() {
    const position = points[0].clone(), parent = new Quaternion();
    const origins: Vector3[] = [], worldAxes: Vector3[] = [], rotations: Quat[] = [];
    for (let i = 0; i < 7; i++) {
      origins.push(position.clone()); worldAxes.push(axes[i].clone().applyQuaternion(parent));
      const rotation = new Quaternion().setFromAxisAngle(axes[i], angles[i]);
      rotations.push(rotation.toArray() as Quat); parent.multiply(rotation);
      position.add(offsets[i].clone().applyQuaternion(parent));
    }
    return { position, origins, worldAxes, rotations };
  }

  // Three bounded degrees of freedom avoid the redundant chain's arbitrary bend choices.
  for (let iteration = 0; iteration < 32; iteration++) {
    const pose = forward(), error = end.clone().sub(pose.position);
    if (error.length() < 1e-9) return pose.rotations;
    const columns = drivers.map(i => pose.worldAxes[i].clone().cross(pose.position.clone().sub(pose.origins[i])));
    const [a, b, c] = columns, bc = b.clone().cross(c), determinant = a.dot(bc);
    if (Math.abs(determinant) < 1e-10) break;
    const step = [error.dot(bc), a.dot(error.clone().cross(c)), a.dot(b.clone().cross(error))].map(v => v / determinant);
    const scale = Math.min(1, 0.2 / Math.max(...step.map(Math.abs)));
    drivers.forEach((joint, i) => { angles[joint] = Math.max(-limits[i], Math.min(limits[i], angles[joint] + step[i] * scale)); });
  }
  throw new Error(`Spider target is outside the constrained pose range (${forward().position.distanceTo(end)} m error)`);
}
