import { z } from 'zod';
import type { Project, Operation, PartInput, Part } from './types.ts';

export const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/, 'Use a letter followed by letters, digits, dots, underscores or hyphens');
export const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const quatSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(q => Math.abs(Math.hypot(...q) - 1) < 0.001, 'Rotation must be a unit quaternion');
const geometrySchema = z.object({
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'group']),
  size: vec3Schema.refine(v => v.every(n => n > 0 && n <= 1000), 'Size must be positive and at most 1000'),
  segments: z.number().int().min(3).max(64),
}).strict();
export const partSchema = z.object({
  name: nameSchema, geometry: geometrySchema, color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  position: vec3Schema, rotation: quatSchema,
  scale: vec3Schema.refine(v => v.every(n => n > 0 && n <= 1000), 'Scale must be positive'),
  parent: nameSchema.nullable(),
}).strict();
export const projectSchema = z.object({ version: z.literal(1), name: z.string().trim().min(1).max(100), parts: z.array(partSchema).max(2000) }).strict();

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
  checkHierarchy(project.parts, 'part');
  return project;
}
export function createProject(name: string): Project { return validateProject({ version: 1, name, parts: [] }); }
function makePart(input: PartInput): Part {
  return partSchema.parse({
    color: '#64b9c4', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null,
    ...input, geometry: { type: 'box', size: [1, 1, 1], segments: 12, ...input.geometry },
  });
}
export function applyOperation(project: Project, operation: Operation): Project {
  const next = structuredClone(project);
  if (!operation || typeof operation !== 'object') throw new Error('Expected an operation object');
  switch (operation.op) {
    case 'add': next.parts.push(makePart(operation.part)); break;
    case 'update': {
      const part = next.parts.find(p => p.name === operation.name);
      if (!part) throw new Error(`Unknown part: ${operation.name}`);
      const changes = partSchema.omit({ name: true }).partial().parse(operation.changes);
      Object.assign(part, changes);
      break;
    }
    case 'remove': {
      if (!next.parts.some(p => p.name === operation.name)) throw new Error(`Unknown part: ${operation.name}`);
      if (next.parts.some(p => p.parent === operation.name)) throw new Error('Remove or reparent child parts first');
      next.parts = next.parts.filter(p => p.name !== operation.name);
      break;
    }
    default: throw new Error(`Unknown operation: ${(operation as { op: string }).op}`);
  }
  return validateProject(next);
}
export class Editor {
  private current: Project;
  private past: Project[] = [];
  private future: Project[] = [];
  constructor(project: Project) { this.current = validateProject(project); }
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
