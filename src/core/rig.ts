import { z } from 'zod';
import type { Binding, BoneDef, Project, Quat, RigOperation } from './types.ts';
import { geometryFor } from '../geometry.ts';

export const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/, 'Use a letter followed by letters, digits, dots, underscores or hyphens');
export const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const quatSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(q => Math.abs(Math.hypot(...q) - 1) < 0.001, 'Rotation must be a unit quaternion');
export const boneSchema = z.object({
  name: nameSchema, parent: nameSchema.nullable(), position: vec3Schema, rotation: quatSchema, pose: quatSchema,
}).strict();
const axisSchema = z.enum(['x', 'y', 'z']);
export const bindingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rigid'), bone: nameSchema }).strict(),
  z.object({
    type: z.literal('linear'), bones: z.tuple([nameSchema, nameSchema]).refine(b => b[0] !== b[1], 'Influence bones must be distinct'),
    axis: axisSchema,
    range: z.tuple([z.number().finite(), z.number().finite()]).refine(r => r[0] < r[1], 'Range must be ascending'),
  }).strict(),
  z.object({
    type: z.literal('weights'), bones: z.array(nameSchema).min(1).max(4).refine(b => new Set(b).size === b.length, 'Influence bones must be distinct'),
    weights: z.array(z.array(z.number().finite().nonnegative()).min(1).max(4)).min(1),
  }).strict().refine(b => b.weights.every(row => row.length === b.bones.length && Math.abs(row.reduce((a, n) => a + n, 0) - 1) < 0.000001), 'Each vertex needs one normalized weight per influence bone'),
]);

export function bindingBones(binding: Binding): string[] {
  return binding.type === 'rigid' ? [binding.bone] : binding.bones;
}

/** Geometry creators call this once their actual vertex count is known. */
export function validateWeightCount(binding: Binding, vertexCount: number): void {
  if (binding.type === 'weights' && binding.weights.length !== vertexCount) {
    throw new Error(`Expected ${vertexCount} vertex weight rows, received ${binding.weights.length}`);
  }
}

export function validateRig(project: Project): void {
  const boneNames = new Set(project.bones.map(bone => bone.name));
  for (const part of project.parts) {
    if (boneNames.has(part.name)) throw new Error(`Part and bone names must be distinct: ${part.name}`);
    if (!part.binding) continue;
    if (part.geometry.type === 'group') throw new Error('Groups cannot have a bone binding');
    for (const name of bindingBones(part.binding)) {
      if (!boneNames.has(name)) throw new Error(`Unknown binding bone: ${name}`);
    }
    if (part.binding.type === 'weights') {
      const geometry = geometryFor(part);
      try { validateWeightCount(part.binding, geometry.getAttribute('position').count); }
      finally { geometry.dispose(); }
    }
  }
}

function findBone(project: Project, name: string): BoneDef {
  const bone = project.bones.find(b => b.name === name);
  if (!bone) throw new Error(`Unknown bone: ${name}`);
  return bone;
}

function subtree(project: Project, name: string): Set<string> {
  const names = new Set([name]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const bone of project.bones) {
      if (bone.parent && names.has(bone.parent) && !names.has(bone.name)) {
        names.add(bone.name); expanded = true;
      }
    }
  }
  return names;
}

function requireUnbound(project: Project, names: Set<string>): void {
  if (project.parts.some(part => part.binding && bindingBones(part.binding).some(name => names.has(name)))) {
    throw new Error('Unbind affected parts before editing the rest rig');
  }
}

/** Mutates only the caller's cloned project; model validation commits the operation atomically. */
export function applyRigOperation(project: Project, operation: RigOperation): void {
  switch (operation.op) {
    case 'bone.add':
      project.bones.push(boneSchema.parse({ parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1], ...operation.bone }));
      break;
    case 'bone.update': {
      const bone = findBone(project, operation.name);
      const changes = boneSchema.omit({ name: true, pose: true }).partial().parse(operation.changes);
      requireUnbound(project, subtree(project, bone.name));
      Object.assign(bone, changes);
      break;
    }
    case 'bone.remove':
      findBone(project, operation.name);
      if (project.bones.some(bone => bone.parent === operation.name)) throw new Error('Remove or reparent child bones first');
      requireUnbound(project, new Set([operation.name]));
      project.bones = project.bones.filter(bone => bone.name !== operation.name);
      break;
    case 'bone.mirror': {
      findBone(project, operation.name);
      const axis = axisSchema.parse(operation.axis);
      const index = { x: 0, y: 1, z: 2 }[axis];
      const names = subtree(project, operation.name);
      const reflectRotation = (q: Quat): Quat => q.map((n, i) => i < 3 && i !== index ? -n : n) as Quat;
      const copies = project.bones.filter(bone => names.has(bone.name)).map(bone => {
        const copy = structuredClone(bone);
        copy.name = nameSchema.parse(operation.prefix + bone.name);
        copy.parent = bone.parent && names.has(bone.parent) ? operation.prefix + bone.parent : bone.parent;
        copy.position[index] *= -1;
        copy.rotation = reflectRotation(bone.rotation);
        copy.pose = reflectRotation(bone.pose);
        return copy;
      });
      project.bones.push(...copies);
      break;
    }
    case 'pose': findBone(project, operation.name).pose = quatSchema.parse(operation.rotation); break;
    case 'pose.reset': for (const bone of project.bones) bone.pose = [0, 0, 0, 1]; break;
    case 'bind':
    case 'unbind': {
      const part = project.parts.find(p => p.name === operation.name);
      if (!part) throw new Error(`Unknown part: ${operation.name}`);
      if (operation.op === 'bind') part.binding = bindingSchema.parse(operation.binding);
      else delete part.binding;
      break;
    }
  }
}
