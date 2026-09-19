import type { Quat, Vec3 } from '../core/types.ts';
import { Quaternion, Vector3 } from 'three';

/** Deterministic FABRIK with a fixed root, fixed lengths, and identity rest joint rotations. */
export function solveChain(rest: Vec3[], target: Vec3, preferred?: Vec3[]): { positions: Vec3[]; rotations: Quat[] } {
  if (rest.length < 3) throw new Error('A chain needs at least three joints');
  if (preferred && preferred.length !== rest.length) throw new Error('Preferred joint count must match the rest chain');
  if (![...rest, target, ...(preferred ?? [])].every(v => v.length === 3 && v.every(Number.isFinite))) {
    throw new Error('Chain coordinates must contain three finite numbers');
  }
  const original = rest.map(v => new Vector3().fromArray(v));
  const root = original[0];
  const end = new Vector3().fromArray(target);
  const vectors = original.slice(1).map((v, i) => v.clone().sub(original[i]));
  const lengths = vectors.map(v => v.length());
  if (lengths.some(length => !Number.isFinite(length) || length < 1e-8)) throw new Error('Chain segment lengths must be finite and positive');
  const total = lengths.reduce((a, b) => a + b, 0);
  const minimum = Math.max(0, 2 * Math.max(...lengths) - total);
  const distance = root.distanceTo(end);
  const tolerance = 1e-9;
  if (!Number.isFinite(distance) || distance > total + tolerance || distance < minimum - tolerance) {
    throw new Error(`Unreachable chain target: distance ${distance}, reachable range ${minimum} to ${total}`);
  }
  const positions = (preferred ?? rest).map(v => new Vector3().fromArray(v));
  const translation = root.clone().sub(positions[0]);
  positions.forEach(p => p.add(translation));
  const direction = end.clone().sub(root);
  if (direction.lengthSq() < 1e-20) direction.copy(vectors[0]);
  direction.normalize();
  if (Math.abs(distance - total) <= tolerance) {
    positions[0].copy(root);
    for (let i = 1; i < positions.length; i++) positions[i].copy(positions[i - 1]).addScaledVector(direction, lengths[i - 1]);
  } else {
    // A perfectly collinear seed cannot choose a bend plane. Seed a small reproducible arch.
    const collinear = positions.every(p => {
      const relative = p.clone().sub(root);
      return relative.addScaledVector(direction, -relative.dot(direction)).lengthSq() < 1e-16;
    });
    if (collinear) {
      const components = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
      const axis = components.indexOf(Math.min(...components));
      const bend = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
      bend.addScaledVector(direction, -bend.dot(direction)).normalize();
      for (let i = 1; i < positions.length - 1; i++) positions[i].addScaledVector(bend, total * .05 * Math.sin(Math.PI * i / (positions.length - 1)));
    }
    const delta = new Vector3();
    let error = Infinity;
    for (let iteration = 0; iteration < 1024; iteration++) {
      positions.at(-1)!.copy(end);
      for (let i = positions.length - 2; i >= 0; i--) {
        delta.copy(positions[i]).sub(positions[i + 1]);
        if (delta.lengthSq() < 1e-20) delta.copy(vectors[i]).negate();
        positions[i].copy(positions[i + 1]).addScaledVector(delta.normalize(), lengths[i]);
      }
      positions[0].copy(root);
      for (let i = 1; i < positions.length; i++) {
        delta.copy(positions[i]).sub(positions[i - 1]);
        if (delta.lengthSq() < 1e-20) delta.copy(vectors[i - 1]);
        positions[i].copy(positions[i - 1]).addScaledVector(delta.normalize(), lengths[i - 1]);
      }
      error = positions.at(-1)!.distanceTo(end);
      if (error <= tolerance) break;
    }
    if (error > 1e-7) throw new Error(`Chain solver did not converge for the supplied bend seed (endpoint error ${error})`);
  }
  const rotations: Quat[] = [];
  const parent = new Quaternion();
  for (let i = 0; i < vectors.length; i++) {
    const localDirection = positions[i + 1].clone().sub(positions[i]).applyQuaternion(parent.clone().invert()).normalize();
    const rotation = new Quaternion().setFromUnitVectors(vectors[i].clone().normalize(), localDirection).normalize();
    rotations.push(rotation.toArray() as Quat);
    parent.multiply(rotation).normalize();
  }
  return { positions: positions.map(p => p.toArray() as Vec3), rotations };
}
