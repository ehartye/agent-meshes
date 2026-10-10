import { Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { bindingBones, nameSchema, vec3Schema } from './rig.ts';
import type { BoneDef, Part, Project, Quat, Vec3 } from './types.ts';

export const assemblyCopySchema = z.object({
  op: z.literal('assembly.copy'), root: nameSchema, prefix: nameSchema,
  mirror: z.enum(['x', 'y', 'z']).optional(), offset: vec3Schema.optional(), clips: z.boolean().default(true),
}).strict();
export type AssemblyCopyOperation = z.input<typeof assemblyCopySchema>;

const identity = new Vector3(1, 1, 1);
function matrix(item: BoneDef | Part): Matrix4 {
  return new Matrix4().compose(new Vector3(...item.position), new Quaternion(...item.rotation), 'scale' in item ? new Vector3(...item.scale) : identity);
}
function worldMatrices(items: (BoneDef | Part)[]): Map<string, Matrix4> {
  const byName = new Map(items.map(item => [item.name, item])), result = new Map<string, Matrix4>();
  function world(name: string): Matrix4 {
    if (result.has(name)) return result.get(name)!;
    const item = byName.get(name)!;
    const value = item.parent ? world(item.parent).clone().multiply(matrix(item)) : matrix(item);
    result.set(name, value); return value;
  }
  for (const item of items) world(item.name);
  return result;
}
function setTransform(part: Part, value: Matrix4): void {
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  value.decompose(position, rotation, scale);
  const reconstructed = new Matrix4().compose(position, rotation, scale);
  if (scale.toArray().some(v => v <= 0) || value.elements.some((v, i) => Math.abs(v - reconstructed.elements[i]) > 1e-7 * Math.max(1, Math.abs(v)))) {
    throw new Error(`Cannot copy part ${part.name}: transform contains shear; retain its ancestor groups or remove nonuniform scaling`);
  }
  part.position = position.toArray() as Vec3; part.rotation = rotation.normalize().toArray() as Quat; part.scale = scale.toArray() as Vec3;
}

/** Copy a whole rigged assembly. Mirror/offset use the root bone parent's REST frame.
 * Mutates the caller's clone; applyOperation validates and commits it atomically.
 */
export function applyAssemblyCopy(project: Project, operation: unknown): void {
  const input = assemblyCopySchema.parse(operation);
  const root = project.bones.find(bone => bone.name === input.root);
  if (!root) throw new Error(`Unknown assembly root bone: ${input.root}`);
  const bones = new Set([root.name]);
  for (let changed = true; changed;) {
    changed = false;
    for (const bone of project.bones) if (bone.parent && bones.has(bone.parent) && !bones.has(bone.name)) { bones.add(bone.name); changed = true; }
  }
  const parts = new Set<string>(), visibleParts = new Set<string>();
  for (const part of project.parts) {
    if (!part.binding) continue;
    const references = bindingBones(part.binding);
    if (!references.some(name => bones.has(name))) continue;
    if (!references.every(name => bones.has(name))) throw new Error(`Cannot copy part ${part.name}: mixed influences inside and outside assembly ${root.name}; separate or rebind the part`);
    parts.add(part.name); visibleParts.add(part.name);
  }
  // Accessories travel with a selected mesh, while unrelated bound descendants stay put.
  for (let changed = true; changed;) {
    changed = false;
    for (const part of project.parts) if (!part.binding && part.parent && visibleParts.has(part.parent) && !visibleParts.has(part.name)) {
      visibleParts.add(part.name); parts.add(part.name); changed = true;
    }
  }
  const byName = new Map(project.parts.map(part => [part.name, part]));
  for (const name of [...parts]) {
    let parent = byName.get(name)!.parent;
    while (parent) {
      const ancestor = byName.get(parent)!;
      if (ancestor.binding && !bindingBones(ancestor.binding).every(name => bones.has(name))) throw new Error(`Cannot copy part ${ancestor.name}: bound ancestor is outside assembly ${root.name}; reparent the selected meshes first`);
      parts.add(parent); parent = ancestor.parent;
    }
  }
  const occupied = new Set([...project.parts, ...project.bones].map(item => item.name));
  for (const name of [...bones, ...parts]) {
    const target = nameSchema.parse(input.prefix + name);
    if (occupied.has(target)) throw new Error(`Assembly copy name collision: ${target}; choose another prefix`);
    occupied.add(target);
  }
  const axis = input.mirror ? { x: 0, y: 1, z: 2 }[input.mirror] : -1;
  const reflectVector = (value: Vec3): Vec3 => value.map((v, i) => i === axis ? -v : v) as Vec3;
  const reflectRotation = (value: Quat): Quat => value.map((v, i) => axis >= 0 && i < 3 && i !== axis ? -v : v) as Quat;
  const offset = input.offset ?? [0, 0, 0];
  const boneCopies = project.bones.filter(bone => bones.has(bone.name)).map(bone => {
    const copy = structuredClone(bone);
    copy.name = input.prefix + bone.name;
    copy.parent = bone.parent && bones.has(bone.parent) ? input.prefix + bone.parent : bone.parent;
    copy.position = reflectVector(bone.position);
    if (bone.name === root.name) copy.position = copy.position.map((v, i) => v + offset[i]) as Vec3;
    copy.rotation = reflectRotation(bone.rotation); copy.pose = reflectRotation(bone.pose);
    return copy;
  });
  const parentWorld = root.parent ? worldMatrices(project.bones).get(root.parent)! : new Matrix4();
  const reflection = new Vector3(1, 1, 1); if (input.mirror) reflection[input.mirror] = -1;
  const transform = parentWorld.clone().multiply(new Matrix4().makeTranslation(...offset)).multiply(new Matrix4().makeScale(...reflection.toArray())).multiply(parentWorld.clone().invert());
  const localReflection = axis >= 0 ? new Matrix4().makeScale(-1, 1, 1) : new Matrix4();
  const originalWorld = worldMatrices(project.parts), copiedWorld = new Map<string, Matrix4>();
  for (const name of parts) copiedWorld.set(name, transform.clone().multiply(originalWorld.get(name)!).multiply(localReflection));
  const partCopies = project.parts.filter(part => parts.has(part.name)).map(part => {
    const copy = structuredClone(part); copy.name = input.prefix + part.name;
    copy.parent = part.parent ? input.prefix + part.parent : null;
    const local = part.parent ? copiedWorld.get(part.parent)!.clone().invert().multiply(copiedWorld.get(part.name)!) : copiedWorld.get(part.name)!;
    setTransform(copy, local);
    if (!visibleParts.has(part.name)) { copy.geometry = { type: 'group', size: [1, 1, 1], segments: 3 }; delete copy.binding; }
    else {
      if (axis >= 0 && copy.geometry.type !== 'group') {
        if (copy.geometry.mirrorX) delete copy.geometry.mirrorX; else copy.geometry.mirrorX = true;
      }
      if (copy.binding) {
        if (copy.binding.type === 'rigid') copy.binding.bone = input.prefix + copy.binding.bone;
        else {
          copy.binding.bones = copy.binding.bones.map(name => input.prefix + name) as [string, string];
          if (axis >= 0 && copy.binding.type === 'linear' && copy.binding.axis === 'x') {
            copy.binding.bones.reverse(); copy.binding.range = [-copy.binding.range[1], -copy.binding.range[0]];
          }
        }
      }
    }
    return copy;
  });
  if (input.clips) for (const clip of project.clips) {
    const tracks = clip.tracks.filter(track => bones.has(track.bone)).map(track => ({
      ...structuredClone(track), bone: input.prefix + track.bone,
      keys: track.keys.map(key => ({ time: key.time, value: track.property === 'rotation' ? reflectRotation(key.value as Quat) : reflectVector(key.value as Vec3) })),
    }));
    clip.tracks.push(...tracks);
  }
  project.bones.push(...boneCopies); project.parts.push(...partCopies);
}
