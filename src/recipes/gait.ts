import type { Quat, Vec3 } from '../core/types.ts';
import { Quaternion, Vector3 } from 'three';

/** +Z is forward. One cycle contains grounded stance followed by lifted recovery. */
export function footPath(cycle: number, stride: number, lift: number, stance = 0.6): Vec3 {
  if (![cycle, stride, lift, stance].every(Number.isFinite)) throw new Error('Foot cycle inputs must be finite');
  if (stride < 0 || lift < 0) throw new Error('Stride and lift must be nonnegative');
  if (stance <= 0 || stance >= 1) throw new Error('Stance fraction must be between zero and one');
  const phase = cycle - Math.floor(cycle);
  if (phase <= stance) return [0, 0, stride * (0.5 - phase / stance)];
  const u = (phase - stance) / (1 - stance);
  const smooth = u * u * (3 - 2 * u);
  // Hermite endpoint tangents preserve stance speed through lift-off and landing.
  const tangent = -stride * (1 - stance) / stance;
  const z = -stride / 2 + stride * smooth + tangent * u * (2 * u * u - 3 * u + 1);
  return [0, lift * Math.sin(Math.PI * u) ** 2, z];
}

/** All positions share root-local space; pole is a direction, and rest rotations are identity. */
export function solveLeg(hip: Vec3, knee: Vec3, foot: Vec3, target: Vec3, pole: Vec3): { upper: Quat; lower: Quat; ankle: Quat } {
  if (![hip, knee, foot, target, pole].every(v => v.length === 3 && v.every(Number.isFinite))) {
    throw new Error('Leg positions and pole must contain three finite coordinates');
  }
  const origin = new Vector3().fromArray(hip);
  const upperRest = new Vector3().fromArray(knee).sub(origin);
  const lowerRest = new Vector3().fromArray(foot).sub(new Vector3().fromArray(knee));
  const upperLength = upperRest.length();
  const lowerLength = lowerRest.length();
  if (upperLength < 1e-8 || lowerLength < 1e-8) throw new Error('Leg segment lengths must be positive');
  const direction = new Vector3().fromArray(target).sub(origin);
  const distance = direction.length();
  const min = Math.abs(upperLength - lowerLength), max = upperLength + lowerLength;
  const tolerance = 1e-8 * Math.max(1, max);
  if (distance < min - tolerance || distance > max + tolerance) {
    throw new Error(`Unreachable leg target: distance ${distance}, reachable range ${min} to ${max}`);
  }
  if (distance < 1e-10) throw new Error('Leg target coincides with hip; bend direction is indeterminate');
  direction.divideScalar(distance);
  const reachableDistance = Math.max(min, Math.min(max, distance));
  const along = (upperLength ** 2 - lowerLength ** 2 + reachableDistance ** 2) / (2 * reachableDistance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const bend = new Vector3().fromArray(pole).normalize();
  bend.addScaledVector(direction, -bend.dot(direction));
  // A parallel pole has no bend plane: prefer the rest bend, then a stable Cartesian axis.
  if (bend.lengthSq() < 1e-12) {
    bend.copy(upperRest).normalize();
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  if (bend.lengthSq() < 1e-12) {
    const axis = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
    const index = axis.indexOf(Math.min(...axis));
    bend.set(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  bend.normalize();
  const upperVector = direction.clone().multiplyScalar(along).addScaledVector(bend, height);
  const lowerVector = direction.clone().multiplyScalar(reachableDistance).sub(upperVector);
  const upper = new Quaternion().setFromUnitVectors(upperRest.normalize(), upperVector.normalize()).normalize();
  const lower = new Quaternion().setFromUnitVectors(lowerRest.normalize(), lowerVector.applyQuaternion(upper.clone().invert()).normalize()).normalize();
  const ankle = upper.clone().multiply(lower).invert().normalize();
  return { upper: upper.toArray() as Quat, lower: lower.toArray() as Quat, ankle: ankle.toArray() as Quat };
}
