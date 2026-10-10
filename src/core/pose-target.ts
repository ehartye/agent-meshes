import { z } from 'zod';
import { Quaternion, Vector3 } from 'three';
import { nameSchema, vec3Schema } from './rig.ts';
import type { Project, Quat } from './types.ts';

export const poseTargetSchema = z.object({
  op: z.literal('pose.target'), chain: z.tuple([nameSchema, nameSchema, nameSchema]),
  target: vec3Schema, pole: vec3Schema, preserveEndOrientation: z.boolean().optional(),
}).strict();
export type PoseTargetOperation = z.infer<typeof poseTargetSchema>;

/** Static two-link IK; target and pole are points in project world coordinates. */
export function applyPoseTarget(project: Project, input: PoseTargetOperation): void {
  const operation = poseTargetSchema.parse(input);
  const [upperName, middleName, endName] = operation.chain;
  if (new Set(operation.chain).size !== 3) throw new Error('Target chain needs three distinct bones');
  const defs = new Map(project.bones.map(b => [b.name, b]));
  const chain = operation.chain.map(name => { const bone = defs.get(name); if (!bone) throw new Error(`Unknown target-chain bone: ${name}`); return bone; });
  const [upper, middle, end] = chain;
  if (middle.parent !== upperName || end.parent !== middleName) throw new Error('Target chain must contain direct parent-child bones in order');
  const world = new Map<string, { position: Vector3; rotation: Quaternion }>();
  function transform(name: string): { position: Vector3; rotation: Quaternion } {
    const cached = world.get(name); if (cached) return cached;
    const bone = defs.get(name)!;
    const parent = bone.parent ? transform(bone.parent) : { position: new Vector3(), rotation: new Quaternion() };
    const result = {
      position: new Vector3(...bone.position).applyQuaternion(parent.rotation).add(parent.position),
      rotation: parent.rotation.clone().multiply(new Quaternion(...bone.rotation)).multiply(new Quaternion(...bone.pose)).normalize(),
    };
    world.set(name, result); return result;
  }
  const a = transform(upperName), b = transform(middleName), c = transform(endName);
  const upperVector = b.position.clone().sub(a.position), lowerVector = c.position.clone().sub(b.position);
  const l1 = upperVector.length(), l2 = lowerVector.length();
  if (Math.min(l1, l2) < 1e-8) throw new Error('Target chain contains a zero-length segment');
  const target = new Vector3(...operation.target), direction = target.clone().sub(a.position), distance = direction.length();
  if (distance < 1e-8) throw new Error('Target coincides with the chain root; bend direction is undefined');
  if (distance > l1 + l2 + 1e-8 || distance < Math.abs(l1 - l2) - 1e-8) throw new Error(`Unreachable target for ${upperName}: distance ${distance}, reach ${Math.abs(l1 - l2)} to ${l1 + l2}`);
  direction.divideScalar(distance);
  const bend = new Vector3(...operation.pole).sub(a.position);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-12) throw new Error('Pole must lie away from the root-target line');
  bend.normalize();
  const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const knee = a.position.clone().addScaledVector(direction, along).addScaledVector(bend, height);
  const upperDelta = new Quaternion().setFromUnitVectors(upperVector.clone().normalize(), knee.clone().sub(a.position).normalize());
  const upperWorld = upperDelta.clone().multiply(a.rotation).normalize();
  const middleDelta = new Quaternion().setFromUnitVectors(lowerVector.clone().applyQuaternion(upperDelta).normalize(), target.clone().sub(knee).normalize());
  const middleWorld = middleDelta.multiply(upperDelta).multiply(b.rotation).normalize();
  const parentWorld = upper.parent ? transform(upper.parent).rotation : new Quaternion();
  const pose = (rest: Quat, parent: Quaternion, desired: Quaternion) => new Quaternion(...rest).invert().multiply(parent.clone().invert()).multiply(desired).normalize().toArray() as Quat;
  const upperPose = pose(upper.rotation, parentWorld, upperWorld);
  const middlePose = pose(middle.rotation, upperWorld, middleWorld);
  const endPose = operation.preserveEndOrientation === false ? end.pose : pose(end.rotation, middleWorld, c.rotation);
  // Check FK before touching the caller's data so direct use is transactional too.
  const solvedKnee = new Vector3(...middle.position).applyQuaternion(upperWorld).add(a.position);
  const solvedEnd = new Vector3(...end.position).applyQuaternion(middleWorld).add(solvedKnee);
  if (solvedEnd.distanceTo(target) > 1e-6 * Math.max(1, l1 + l2)) throw new Error(`Target solution for ${upperName} failed its endpoint check`);
  upper.pose = upperPose; middle.pose = middlePose; end.pose = [...endPose];
}
