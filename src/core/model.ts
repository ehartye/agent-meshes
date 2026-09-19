import { z } from 'zod';
import { Quaternion, Vector3 } from 'three';
import type { Project, Operation, PartInput, Part, Vec3, Quat } from './types.ts';
import { nameSchema, vec3Schema, quatSchema, boneSchema, bindingSchema, validateRig, applyRigOperation, boneRestWorld } from './rig.ts';
import { clipSchema, validateAnimation } from './animation.ts';
import { applyAssemblyCopy } from './assembly.ts';
import { applyPoseTarget } from './pose-target.ts';
export { nameSchema, vec3Schema, quatSchema } from './rig.ts';

const vec2Schema = z.tuple([z.number().finite(), z.number().finite()]);
const geometrySchema = z.object({
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'lathe', 'prism', 'group']),
  size: vec3Schema.refine(v => v.every(n => n > 0 && n <= 1000), 'Size must be positive and at most 1000'),
  segments: z.number().int().min(3).max(64),
  mirrorX: z.boolean().optional(),
  /** lathe only: [radius, height] points of a unit profile, radius 0 to 0.5 and height -0.5 to 0.5, revolved around y. */
  profile: z.array(vec2Schema).min(3, 'A lathe profile needs at least 3 points').max(64).optional(),
  /** prism only: [x, y] points of a unit outline within -0.5 to 0.5, extruded along z from -0.5 to 0.5. */
  outline: z.array(vec2Schema).min(3, 'A prism outline needs at least 3 points').max(64).optional(),
}).strict();
/** Shape-specific rules kept out of the schema so contract schemas can still be made partial. */
export function validateGeometry(g: Part['geometry']): void {
  if (g.type === 'lathe') {
    if (!g.profile) throw new Error('A lathe needs a profile');
    if (g.profile.some(([r, y]) => r < 0 || r > 0.5 || y < -0.5 || y > 0.5)) throw new Error('Profile radius must be 0 to 0.5 and height -0.5 to 0.5');
  } else if (g.profile) throw new Error(`Only a lathe takes a profile, not a ${g.type}`);
  if (g.type === 'prism') {
    if (!g.outline) throw new Error('A prism needs an outline');
    if (g.outline.some(([x, y]) => Math.abs(x) > 0.5 || Math.abs(y) > 0.5)) throw new Error('Outline points must be within -0.5 to 0.5');
  } else if (g.outline) throw new Error(`Only a prism takes an outline, not a ${g.type}`);
}
export const partSchema = z.object({
  name: nameSchema, geometry: geometrySchema, color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  position: vec3Schema, rotation: quatSchema,
  scale: vec3Schema.refine(v => v.every(n => n > 0 && n <= 1000), 'Scale must be positive'),
  parent: nameSchema.nullable(),
  binding: bindingSchema.optional(),
}).strict();
export const projectSchema = z.object({ version: z.literal(1), name: z.string().trim().min(1).max(100), parts: z.array(partSchema).max(2000), bones: z.array(boneSchema).max(256).default([]), clips: z.array(clipSchema).max(100).default([]) }).strict();

export function checkHierarchy(items: { name: string; parent: string | null }[], label: string): void {
  const byName = new Map(items.map(item => [item.name, item]));
  if (byName.size !== items.length) throw new Error(`Duplicate ${label} name`);
  for (const item of items) {
    const seen = new Set([item.name]);
    let parent = item.parent;
    while (parent) {
      if (seen.has(parent)) throw new Error(`${label} hierarchy cycle at ${item.name}`);
      seen.add(parent);
      const next = byName.get(parent);
      if (!next) throw new Error(`Unknown ${label} parent: ${parent}`);
      parent = next.parent;
    }
  }
}
export function validateProject(value: unknown): Project {
  const project = projectSchema.parse(value);
  for (const part of project.parts) validateGeometry(part.geometry);
  checkHierarchy(project.parts, 'part');
  checkHierarchy(project.bones, 'bone');
  validateRig(project);
  validateAnimation(project);
  return project;
}
export function createProject(name: string): Project { return validateProject({ version: 1, name, parts: [] }); }
function makePart(project: Project, input: PartInput): Part {
  const { anchor, ...rest } = input;
  const part = partSchema.parse({
    color: '#64b9c4', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null,
    ...rest, geometry: { type: 'box', size: [1, 1, 1], segments: 12, ...input.geometry },
  });
  if (anchor !== undefined) {
    if (part.parent) throw new Error('An anchored part cannot also have a parent part');
    const frame = boneRestWorld(project, nameSchema.parse(anchor));
    const placed = frame.position.clone().add(new Vector3(...part.position).applyQuaternion(frame.rotation));
    part.position = placed.toArray() as Vec3;
    part.rotation = frame.rotation.clone().multiply(new Quaternion(...part.rotation)).normalize().toArray() as Quat;
  }
  return part;
}
export function applyOperation(project: Project, operation: Operation): Project {
  const next = structuredClone(project);
  if (!operation || typeof operation !== 'object') throw new Error('Expected an operation object');
  switch (operation.op) {
    case 'add': next.parts.push(makePart(next, operation.part)); break;
    case 'update': {
      const part = next.parts.find(p => p.name === operation.name);
      if (!part) throw new Error(`Unknown part: ${operation.name}`);
      const changes = partSchema.omit({ name: true }).partial().parse(operation.changes);
      if (part.binding && changes.geometry) throw new Error('Unbind the part before changing its geometry');
      Object.assign(part, changes);
      break;
    }
    case 'remove': {
      if (!next.parts.some(p => p.name === operation.name)) throw new Error(`Unknown part: ${operation.name}`);
      if (next.parts.some(p => p.parent === operation.name)) throw new Error('Remove or reparent child parts first');
      next.parts = next.parts.filter(p => p.name !== operation.name);
      break;
    }
    case 'bone.add': case 'bone.update': case 'bone.remove': case 'bone.mirror':
    case 'pose': case 'pose.reset': case 'bind': case 'unbind':
      applyRigOperation(next, operation); break;
    case 'assembly.copy': applyAssemblyCopy(next, operation); break;
    case 'pose.target': applyPoseTarget(next, operation); break;
    case 'clip.set': {
      const clip = clipSchema.parse(operation.clip);
      const index = next.clips.findIndex(c => c.name === clip.name);
      if (index < 0) next.clips.push(clip); else next.clips[index] = clip;
      break;
    }
    case 'clip.remove':
      if (!next.clips.some(c => c.name === operation.name)) throw new Error(`Unknown clip: ${operation.name}`);
      next.clips = next.clips.filter(c => c.name !== operation.name); break;
    default: throw new Error(`Unknown operation: ${(operation as { op: string }).op}`);
  }
  return validateProject(next);
}
export class Editor {
  private current: Project;
  private past: Project[] = [];
  private future: Project[] = [];
  constructor(project: Project) { this.current = validateProject(project); }
  static restore(value: unknown): Editor {
    const state = z.object({ project: projectSchema, past: z.array(projectSchema).max(100), future: z.array(projectSchema).max(100) }).strict().parse(value);
    const editor = new Editor(state.project);
    editor.past = state.past.map(validateProject); editor.future = state.future.map(validateProject);
    return editor;
  }
  snapshot() { return structuredClone({ project: this.current, past: this.past, future: this.future }); }
  get project(): Project { return structuredClone(this.current); }
  apply(operation: Operation): Project { return this.replace(applyOperation(this.current, operation)); }
  replace(project: Project): Project {
    const next = validateProject(project);
    this.past.push(this.current);
    if (this.past.length > 100) this.past.shift();
    this.current = next; this.future = [];
    return this.project;
  }
  undo(): Project {
    const previous = this.past.pop();
    if (!previous) throw new Error('Nothing to undo');
    this.future.push(this.current); this.current = previous;
    return this.project;
  }
  redo(): Project {
    const next = this.future.pop();
    if (!next) throw new Error('Nothing to redo');
    this.past.push(this.current); this.current = next;
    return this.project;
  }
}
