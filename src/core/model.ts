import { z } from 'zod';
import { Euler, Quaternion, Vector3 } from 'three';
import type { Project, Operation, PartInput, Part, Shell, Vec3, Quat } from './types.ts';
import { nameSchema, vec3Schema, quatSchema, boneSchema, bindingSchema, validateRig, applyRigOperation, boneRestWorld } from './rig.ts';
import { clipSchema, validateAnimation } from './animation.ts';
import { applyAssemblyCopy } from './assembly.ts';
import { applyPoseTarget } from './pose-target.ts';
import { ModelError } from '../errors.ts';
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
  /** lathe only: 'metres' makes profile points real [radius, height] in meters, height up from the part origin; size is then ignored. Default 'unit'. */
  profileUnits: z.enum(['unit', 'metres']).optional(),
  /** lathe only: profile point indices that are hard edges; normals are split there so a ledge shades crisply. */
  corners: z.array(z.number().int().min(0).max(63)).max(64).optional(),
  /** lathe only: [startDeg, endDeg] revolves just that sector (about +y, from +z toward +x) and caps its radial ends. */
  angleRange: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  /** lathe only: phase of the segment grid in degrees. Lathes and sectors with equal segments and startAngle share vertex angles. */
  startAngle: z.number().finite().optional(),
  /** prism only: 'metres' makes outline points real meters and extrudes from the part origin to size along the axis. Default 'unit'. */
  outlineUnits: z.enum(['unit', 'metres']).optional(),
  /** prism only: extrusion axis. 'z' (default) takes an XY outline; 'y' takes an XZ outline and extrudes upward. */
  axis: z.enum(['y', 'z']).optional(),
  /** prism only: chamfer width on both cap edges, in outline units; footprint and length are unchanged. */
  bevel: z.number().positive().finite().optional(),
}).strict();
const LIMIT = 1000;
const unitRangeHint = 'Unit profiles are size-normalised: radius 0..0.5, height -0.5..0.5, scaled by size. For real meters set profileUnits: "metres".';
/** Shape-specific rules kept out of the schema so contract schemas can still be made partial. */
export function validateGeometry(g: Part['geometry']): void {
  const only = (kind: string, fields: (keyof Part['geometry'])[]) => {
    for (const field of fields) if (g[field] !== undefined && g.type !== kind) throw new ModelError(`Only a ${kind} takes ${field}, not a ${g.type}`, { path: `geometry.${field}`, value: g[field], hint: `Remove ${field}, or change the geometry type to ${kind}.` });
  };
  only('lathe', ['profileUnits', 'corners', 'angleRange', 'startAngle']);
  only('prism', ['outlineUnits', 'axis', 'bevel']);
  if (g.type === 'lathe') {
    if (!g.profile) throw new ModelError('A lathe needs a profile', { path: 'geometry.profile', hint: 'Give [radius, height] points bottom to top; a zero-radius first or last point closes the cap.' });
    const metres = g.profileUnits === 'metres';
    g.profile.forEach(([r, y], i) => {
      const bad = metres ? r < 0 || r > LIMIT || Math.abs(y) > LIMIT : r < 0 || r > 0.5 || y < -0.5 || y > 0.5;
      if (bad) throw new ModelError(metres ? `Profile point ${i} [${r}, ${y}]: radius must be 0 to ${LIMIT} and height within +-${LIMIT} meters` : `Profile point ${i} [${r}, ${y}]: radius must be 0 to 0.5 and height -0.5 to 0.5 (unit profile)`,
        { path: `geometry.profile[${i}]`, value: [r, y], hint: metres ? 'Radius cannot be negative.' : unitRangeHint });
    });
    for (const index of g.corners ?? []) {
      if (index >= g.profile.length) throw new ModelError(`Corner index ${index} is outside the ${g.profile.length}-point profile`, { path: 'geometry.corners', value: index, hint: `corners lists zero-based profile point indices, 0 to ${g.profile.length - 1}.` });
    }
    if (g.corners && new Set(g.corners).size !== g.corners.length) throw new ModelError('corners lists a profile point twice', { path: 'geometry.corners', value: g.corners });
    if (g.angleRange) {
      const [a, b] = g.angleRange;
      if (!(b > a) || b - a > 360 || Math.abs(a) > 720 || Math.abs(b) > 720) throw new ModelError(`angleRange [${a}, ${b}] must have start < end, a span of at most 360 degrees, and angles within +-720`, { path: 'geometry.angleRange', value: g.angleRange, hint: 'Degrees about +y, measured from +z toward +x; [0, 45] is one eighth.' });
    }
  } else if (g.profile) throw new ModelError(`Only a lathe takes a profile, not a ${g.type}`, { path: 'geometry.profile', hint: 'Remove profile, or change the geometry type to lathe.' });
  if (g.type === 'prism') {
    if (!g.outline) throw new ModelError('A prism needs an outline', { path: 'geometry.outline', hint: 'Give at least 3 [x, y] points; with axis "y" they are [x, z] points.' });
    const metres = g.outlineUnits === 'metres';
    g.outline.forEach(([x, y], i) => {
      const bad = metres ? Math.abs(x) > LIMIT || Math.abs(y) > LIMIT : Math.abs(x) > 0.5 || Math.abs(y) > 0.5;
      if (bad) throw new ModelError(`Outline point ${i} [${x}, ${y}] is out of range: outline points must be within ${metres ? `+-${LIMIT}` : '-0.5 to 0.5'}`,
        { path: `geometry.outline[${i}]`, value: [x, y], hint: metres ? undefined : 'Outline coordinates are size-normalised -0.5..0.5 units (scaled by size) unless outlineUnits is "metres"; divide real-meter coordinates by size or set outlineUnits: "metres".' });
    });
    if (g.bevel !== undefined) {
      const axis = g.axis ?? 'z', length = g.outlineUnits === 'metres' ? g.size[axis === 'y' ? 1 : 2] : 1;
      if (g.bevel * 2 >= length) throw new ModelError(`bevel ${g.bevel} is too wide: twice the bevel must be less than the extrusion length ${length}`, { path: 'geometry.bevel', value: g.bevel, hint: 'The bevel is cut from both caps, in outline units; use a smaller value.' });
    }
  } else if (g.outline) throw new ModelError(`Only a prism takes an outline, not a ${g.type}`, { path: 'geometry.outline', hint: 'Remove outline, or change the geometry type to prism.' });
}
/**
 * Surface finish: metalness 0 is paint or plastic, 1 is bare metal; roughness 0 is a mirror, 1 is chalk. Absent means the scene's default finish.
 * Glass: opacity below 1 blends the surface over what is behind it (glTF alphaMode BLEND); transmission 0 to 1 is
 * physically transmitted light (KHR_materials_transmission) and ior the index of refraction (KHR_materials_ior, 1.5 is glass);
 * doubleSided draws both faces, so a hollow bubble shows its far wall. Omitted glass fields mean an opaque, one-sided surface.
 */
export const materialSchema = z.object({
  metalness: z.number().min(0).max(1).default(0), roughness: z.number().min(0).max(1).default(0.65),
  opacity: z.number().min(0).max(1).optional(), transmission: z.number().min(0).max(1).optional(),
  ior: z.number().min(1).max(2.333).optional(), doubleSided: z.boolean().optional(),
}).strict();
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** A painted pattern baked into vertex colors in world space. `size` is the dot spacing, stripe period or check size in meters. */
export const patternSchema = z.object({
  type: z.enum(['dots', 'stripes', 'checks']), color: colorSchema,
  size: z.number().positive().max(100),
  /** Stripes cross this axis; checks tile the two axes perpendicular to it. Default y. */
  axis: z.enum(['x', 'y', 'z']).optional(),
  /** World-space shift of the pattern, in meters. */
  offset: vec3Schema.optional(),
}).strict();
export const partSchema = z.object({
  name: nameSchema, geometry: geometrySchema, color: colorSchema,
  position: vec3Schema, rotation: quatSchema,
  scale: vec3Schema.refine(v => v.every(n => n > 0 && n <= 1000), 'Scale must be positive'),
  parent: nameSchema.nullable(),
  binding: bindingSchema.optional(),
  material: materialSchema.optional(),
  pattern: patternSchema.optional(),
}).strict();
/** `update` changes: any part field but the name; `pattern: null` removes a pattern. */
/** Euler angles in degrees, three.js 'XYZ' order (a world-axis rotation about z, then y, then x), as an easier alternative to `rotation`. */
export const rotationEulerSchema = vec3Schema;
/** Unit quaternion for Euler degrees [x, y, z]; positive angles turn counter-clockwise looking down the axis toward the origin. */
export function eulerToQuat(degrees: Vec3): Quat {
  const q = new Quaternion().setFromEuler(new Euler(...degrees.map(d => d * Math.PI / 180) as [number, number, number], 'XYZ'));
  return q.normalize().toArray() as Quat;
}
function bothRotations(where: string): never {
  throw new ModelError(`${where} gives both rotation and rotationEuler`, { path: 'rotation', hint: 'Give one: rotation is a unit quaternion [x,y,z,w]; rotationEuler is [x,y,z] degrees (three.js XYZ order).' });
}
export const partChangesSchema = partSchema.omit({ name: true }).partial().extend({ pattern: patternSchema.nullable().optional(), rotationEuler: rotationEulerSchema.optional() });
export const shellSchema = z.object({
  name: nameSchema, parts: z.array(nameSchema).min(1).max(200),
  /** Parts subtracted from the field (holes and hollows); never rendered on their own, never a member. */
  cut: z.array(nameSchema).max(200).optional(),
  /** Blend radius in meters: how far two members reach toward each other before they merge. */
  blend: z.number().positive().max(10),
  /** Width of the band over which member colors mix, in meters; 0 gives hard patches by ownership. Default blend / 2. Skin weights are unaffected. */
  colorBlend: z.number().min(0).max(10).optional(),
  /** Grid cells along the longest axis, 16 to 96. */
  resolution: z.number().int().min(16).max(96),
  material: materialSchema.optional(),
  pattern: patternSchema.optional(),
}).strict();
export const projectSchema = z.object({ version: z.literal(1), name: z.string().trim().min(1).max(100), parts: z.array(partSchema).max(2000), bones: z.array(boneSchema).max(256).default([]), clips: z.array(clipSchema).max(100).default([]), shells: z.array(shellSchema).max(50).default([]) }).strict();
const shapeOptionKeys = ['profileUnits', 'corners', 'angleRange', 'startAngle', 'outlineUnits', 'axis', 'bevel'] as const;
/** The shell's signed-distance fields model the default unit shapes only. */
function checkShellShape(shell: Shell, part: Part): void {
  const used = shapeOptionKeys.filter(key => part.geometry[key] !== undefined);
  if (used.length) throw new ModelError(`Shell ${shell.name} cannot include ${part.name}: shells support only default unit lathes and prisms, not ${used.join(', ')}`, { path: 'geometry', value: used, hint: `Keep ${part.name} as a separate part, or remove ${used.join(', ')} to use it in a shell.` });
}
function validateShells(project: Project): void {
  const partNames = new Set(project.parts.map(p => p.name)), boneNames = new Set(project.bones.map(b => b.name)), seen = new Set<string>();
  for (const shell of project.shells ?? []) {
    if (seen.has(shell.name)) throw new Error(`Duplicate shell name: ${shell.name}`);
    seen.add(shell.name);
    if (partNames.has(shell.name) || boneNames.has(shell.name)) throw new Error(`Shell, part and bone names must be distinct: ${shell.name}`);
    if (new Set(shell.parts).size !== shell.parts.length) throw new Error(`Shell ${shell.name} lists a part twice`);
    for (const name of shell.parts) {
      const part = project.parts.find(p => p.name === name);
      if (!part) throw new Error(`Unknown shell part: ${name}`);
      if (part.geometry.type === 'group') throw new Error(`Shell ${shell.name} cannot include group ${name}`);
      checkShellShape(shell, part);
      if (part.binding && part.binding.type !== 'rigid') throw new Error(`Shell ${shell.name} member ${name} must be rigid-bound or unbound`);
    }
    const bound = shell.parts.filter(name => project.parts.find(p => p.name === name)!.binding);
    if (bound.length && bound.length !== shell.parts.length) throw new Error(`Shell ${shell.name} mixes bound and unbound parts`);
    const cut = shell.cut ?? [];
    if (new Set(cut).size !== cut.length) throw new Error(`Shell ${shell.name} lists a cutter twice`);
    for (const name of cut) {
      const part = project.parts.find(p => p.name === name);
      if (!part) throw new Error(`Unknown shell cutter: ${name}`);
      if (shell.parts.includes(name)) throw new Error(`Shell ${shell.name}: ${name} cannot be both a member and a cutter`);
      if (part.geometry.type === 'group') throw new Error(`Shell ${shell.name} cannot cut with group ${name}`);
      checkShellShape(shell, part);
      if (part.binding && part.binding.type !== 'rigid') throw new Error(`Shell ${shell.name} cutter ${name} must be rigid-bound or unbound`);
    }
  }
}

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
  for (const part of project.parts) {
    try { validateGeometry(part.geometry); } catch (error) { throw error instanceof ModelError ? error.forPart(part.name) : error; }
  }
  checkHierarchy(project.parts, 'part');
  checkHierarchy(project.bones, 'bone');
  validateRig(project);
  validateAnimation(project);
  validateShells(project);
  return project;
}
export function createProject(name: string): Project { return validateProject({ version: 1, name, parts: [] }); }
function makePart(project: Project, input: PartInput): Part {
  const { anchor, rotationEuler, ...rest } = input;
  if (rotationEuler !== undefined) {
    if (rest.rotation !== undefined) bothRotations('Part');
    rest.rotation = eulerToQuat(rotationEulerSchema.parse(rotationEuler));
  }
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
      const { pattern, rotationEuler, ...changes } = partChangesSchema.parse(operation.changes);
      if (rotationEuler) {
        if (changes.rotation) bothRotations('Changes');
        changes.rotation = eulerToQuat(rotationEuler);
      }
      if (part.binding && changes.geometry) throw new Error('Unbind the part before changing its geometry');
      Object.assign(part, changes);
      if (pattern === null) delete part.pattern; else if (pattern) part.pattern = pattern;
      break;
    }
    case 'remove': {
      if (!next.parts.some(p => p.name === operation.name)) throw new Error(`Unknown part: ${operation.name}`);
      if (next.parts.some(p => p.parent === operation.name)) throw new Error('Remove or reparent child parts first');
      for (const shell of next.shells ?? []) if (shell.parts.includes(operation.name) || shell.cut?.includes(operation.name)) throw new Error(`Part ${operation.name} belongs to shell ${shell.name}; remove it from the shell first`);
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
    case 'shell.set': {
      const shell = shellSchema.parse(operation.shell);
      next.shells ??= [];
      const index = next.shells.findIndex(s => s.name === shell.name);
      if (index < 0) next.shells.push(shell); else next.shells[index] = shell;
      break;
    }
    case 'shell.remove':
      if (!(next.shells ?? []).some(s => s.name === operation.name)) throw new Error(`Unknown shell: ${operation.name}`);
      next.shells = (next.shells ?? []).filter(s => s.name !== operation.name); break;
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
