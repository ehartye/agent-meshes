import { z } from 'zod';
import { applyOperation, createProject, partSchema, projectSchema, validateProject } from './core/model.ts';
import { bindingBones, bindingSchema, boneSchema, nameSchema, quatSchema } from './core/rig.ts';
import { clipSchema } from './core/animation.ts';
import { shellSchema } from './core/model.ts';
import { assemblyCopySchema } from './core/assembly.ts';
import { poseTargetSchema } from './core/pose-target.ts';
import type { BoneDef, Clip, Operation, Part, Project } from './core/types.ts';

const partInputSchema = partSchema.omit({ geometry: true }).partial().required({ name: true }).extend({ anchor: nameSchema.optional() })
  .extend({ geometry: partSchema.shape.geometry.partial().required({ type: true }).optional() });
const named = { name: nameSchema };

/** Shape contracts reuse model schemas; state-dependent checks still run in applyOperation. */
export const operationSchemas = {
  'assembly.copy': assemblyCopySchema,
  'pose.target': poseTargetSchema,
  add: z.object({ op: z.literal('add'), part: partInputSchema }).strict(),
  update: z.object({ op: z.literal('update'), ...named, changes: partSchema.omit({ name: true }).partial() }).strict(),
  remove: z.object({ op: z.literal('remove'), ...named }).strict(),
  'bone.add': z.object({ op: z.literal('bone.add'), bone: boneSchema.partial().required({ name: true }) }).strict(),
  'bone.update': z.object({ op: z.literal('bone.update'), ...named, changes: boneSchema.omit({ name: true, pose: true }).partial() }).strict(),
  'bone.remove': z.object({ op: z.literal('bone.remove'), ...named }).strict(),
  'bone.mirror': z.object({ op: z.literal('bone.mirror'), ...named, prefix: nameSchema, axis: z.enum(['x', 'y', 'z']) }).strict(),
  pose: z.object({ op: z.literal('pose'), ...named, rotation: quatSchema }).strict(),
  'pose.reset': z.object({ op: z.literal('pose.reset') }).strict(),
  bind: z.object({ op: z.literal('bind'), ...named, binding: bindingSchema }).strict(),
  unbind: z.object({ op: z.literal('unbind'), ...named }).strict(),
  'clip.set': z.object({ op: z.literal('clip.set'), clip: clipSchema }).strict(),
  'clip.remove': z.object({ op: z.literal('clip.remove'), ...named }).strict(),
  'shell.set': z.object({ op: z.literal('shell.set'), shell: shellSchema }).strict(),
  'shell.remove': z.object({ op: z.literal('shell.remove'), ...named }).strict(),
} satisfies Record<Operation['op'], z.ZodType>;

export function parseOperation(value: unknown): Operation {
  const header = z.object({ op: z.enum(Object.keys(operationSchemas) as [Operation['op'], ...Operation['op'][]]) }).parse(value);
  return operationSchemas[header.op].parse(value) as Operation;
}

const examples: Record<Operation['op'], Operation[]> = {
  'assembly.copy': [{ op: 'assembly.copy', root: 'upper', prefix: 'right_', mirror: 'x', offset: [0, 0, 0], clips: true }],
  'pose.target': [{ op: 'pose.target', chain: ['upper', 'middle', 'end'], target: [0.5, 0.2, 0], pole: [0.5, 1, 1], preserveEndOrientation: true }],
  add: [
    { op: 'add', part: { name: 'body', geometry: { type: 'box', size: [1, 2, 1] }, position: [0, 1, 0] } },
    { op: 'add', part: { name: 'balloon', geometry: { type: 'sphere', size: [1, 1, 1] }, color: '#e0563a', material: { metalness: 1, roughness: 0.1 } } },
  ],
  update: [{ op: 'update', name: 'body', changes: { color: '#64b9c4' } }, { op: 'update', name: 'body', changes: { material: { metalness: 1, roughness: 0.1 } } }],
  remove: [{ op: 'remove', name: 'body' }],
  'bone.add': [{ op: 'bone.add', bone: { name: 'root' } }],
  'bone.update': [{ op: 'bone.update', name: 'root', changes: { position: [0, 1, 0] } }],
  'bone.remove': [{ op: 'bone.remove', name: 'root' }],
  'bone.mirror': [{ op: 'bone.mirror', name: 'root', prefix: 'copy_', axis: 'x' }],
  pose: [{ op: 'pose', name: 'root', rotation: [0, 0, 0, 1] }],
  'pose.reset': [{ op: 'pose.reset' }],
  bind: [{ op: 'bind', name: 'body', binding: { type: 'rigid', bone: 'root' } }],
  unbind: [{ op: 'unbind', name: 'body' }],
  'clip.set': [{ op: 'clip.set', clip: { name: 'idle', duration: 1, tracks: [{ bone: 'root', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0, 1] }] }] } }],
  'clip.remove': [{ op: 'clip.remove', name: 'idle' }],
  'shell.set': [
    { op: 'shell.set', shell: { name: 'skin', parts: ['body', 'head'], blend: 0.12, resolution: 48 } },
    { op: 'shell.set', shell: { name: 'skin', parts: ['body', 'head'], cut: ['hole'], blend: 0.12, resolution: 48 } },
    { op: 'shell.set', shell: { name: 'steel', parts: ['body', 'head'], blend: 0.12, resolution: 48, material: { metalness: 1, roughness: 0.1 } } },
  ],
  'shell.remove': [{ op: 'shell.remove', name: 'skin' }],
};
const descriptions: Record<Operation['op'], string> = {
  add: 'Create a named primitive or group; omitted fields use the published defaults. A lathe needs a unit profile and a prism a unit outline. An anchor bone makes position and rotation relative to that bone\'s rest frame. An optional material sets the finish: metalness 0 to 1 (paint to bare metal) and roughness 0 to 1 (mirror to chalk); metalness 1 with roughness 0.1 is polished chrome.',
  update: 'Update a part. Unbind before changing geometry; update does not rename. A material change replaces the whole finish (metalness, roughness), with omitted fields at their defaults.',
  remove: 'Remove an existing part after removing or reparenting its children.',
  'bone.add': 'Create a named bone with optional parent and rest transforms.',
  'bone.update': 'Update rest transforms or parent. Unbind parts affected by the bone subtree first.',
  'bone.remove': 'Remove a bone after removing or reparenting children and removing binding and animation references.',
  'bone.mirror': 'Copy a bone subtree reflected in its parent coordinates. Prefix every copied name; does not copy parts or clips.',
  pose: 'Set a bone quaternion offset from its rest rotation, preserving bindings.',
  'pose.reset': 'Reset all bone pose offsets to identity.',
  bind: 'Bind a mesh part to existing bones. Groups cannot be bound.',
  unbind: 'Remove an existing part binding.',
  'clip.set': 'Create or replace an entire named clip. Every track must span zero through duration with strictly increasing key times.',
  'clip.remove': 'Remove an existing named clip.',
  'shell.set': 'Create or replace a smooth shell that blends the listed parts into one surface and replaces them when rendered or exported. Members must all be rigid-bound or all unbound; colors and bone weights come from the members that own each point. Optional cut lists parts subtracted from the surface (holes and hollows) with the same blend; cutters are hidden like members, contribute no color or weight, and cannot also be members. An optional material (metalness, roughness, 0 to 1) sets the finish of the whole shell.',
  'shell.remove': 'Remove a shell; its member parts render individually again.',
  'assembly.copy': 'Copy a bone subtree with its bound parts and clip tracks under a prefix, optionally mirrored and offset in the root parent frame.',
  'pose.target': 'Pose a three-bone parent-child chain with two-link IK so the end bone reaches a world-space target, bending toward the pole.',
};

export function capabilities() {
  // Defaults come from the same constructor path used by authoring, not a second list.
  const part = applyOperation(createProject('defaults'), { op: 'add', part: { name: 'example' } }).parts[0];
  const bone = applyOperation(createProject('defaults'), { op: 'bone.add', bone: { name: 'example' } }).bones[0];
  const { name: _partName, ...partDefaults } = part;
  const { name: _boneName, ...boneDefaults } = bone;
  return {
    version: 1,
    service: 'agent-meshes',
    protocolVersion: '0.1.0',
    coordinates: { units: 'meters', up: '+Y', quaternion: '[x,y,z,w]', animationTransforms: 'Offsets from bone rest transforms' },
    defaults: { part: partDefaults, bone: boneDefaults },
    constraints: [
      'JSON Schemas describe field shapes and numeric limits. Runtime refinements and project relationships must also pass planOperations or normal authoring validation.',
      'Quaternions must be unit length within 0.001. Influence names must be distinct, linear ranges ascending, and explicit weight rows normalized within 0.000001 with one row per generated vertex.',
      'Part and bone names are globally distinct; each hierarchy must be acyclic with existing parents. Binding bones and animation bones must exist.',
      'Each clip name and each bone/property track pair must be unique. Key times strictly increase from zero through the clip duration.',
      'Examples are individual operation shapes, not a sequential batch; named targets must exist where required.',
      'Planning validates every intermediate state exactly as applying operations does. Failures report zero-based operationIndex; no source project is changed.',
    ],
    projectSchema: z.toJSONSchema(projectSchema),
    operations: Object.fromEntries(Object.entries(operationSchemas).map(([name, schema]) => [name, {
      description: descriptions[name as Operation['op']],
      schema: z.toJSONSchema(schema),
      examples: structuredClone(examples[name as Operation['op']]),
    }])),
  };
}

type Selection = { kind: 'part'; entity: Part } | { kind: 'bone'; entity: BoneDef } | { kind: 'clip'; entity: Clip };

export function inspectProject(input: Project, selection?: string) {
  const project = validateProject(structuredClone(input));
  let selected: Selection | undefined;
  if (selection !== undefined) {
    const separator = selection.indexOf(':');
    const kind = separator < 0 ? undefined : selection.slice(0, separator);
    const name = separator < 0 ? selection : selection.slice(separator + 1);
    const matches: Selection[] = [];
    const part = project.parts.find(item => item.name === name);
    const bone = project.bones.find(item => item.name === name);
    const clip = project.clips.find(item => item.name === name);
    if (part && (!kind || kind === 'part')) matches.push({ kind: 'part', entity: part });
    if (bone && (!kind || kind === 'bone')) matches.push({ kind: 'bone', entity: bone });
    if (clip && (!kind || kind === 'clip')) matches.push({ kind: 'clip', entity: clip });
    if (!matches.length) throw new Error(`Unknown selection: ${selection}`);
    if (matches.length > 1) throw new Error(`Ambiguous selection: ${selection}; use part:, bone: or clip: prefix`);
    selected = matches[0];
  }
  return {
    version: project.version,
    name: project.name,
    counts: {
      parts: project.parts.length, bones: project.bones.length, clips: project.clips.length,
      boundParts: project.parts.filter(part => part.binding).length,
      tracks: project.clips.reduce((sum, clip) => sum + clip.tracks.length, 0),
      keys: project.clips.reduce((sum, clip) => sum + clip.tracks.reduce((count, track) => count + track.keys.length, 0), 0),
    },
    parts: project.parts.map(part => ({ name: part.name, type: part.geometry.type, parent: part.parent,
      ...(part.binding ? { binding: { type: part.binding.type, bones: bindingBones(part.binding), ...(part.binding.type === 'weights' ? { vertices: part.binding.weights.length } : {}) } } : {}),
    })),
    bones: project.bones.map(bone => ({ name: bone.name, parent: bone.parent })),
    clips: project.clips.map(clip => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length, keys: clip.tracks.reduce((sum, track) => sum + track.keys.length, 0) })),
    ...(selected ? { selection: selected } : {}),
  };
}

export class OperationPlanError extends Error {
  readonly operationIndex: number;
  readonly issues?: z.ZodError['issues'];
  constructor(operationIndex: number, cause: unknown) {
    super(`Operation ${operationIndex}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'OperationPlanError';
    this.operationIndex = operationIndex;
    if (cause instanceof z.ZodError) this.issues = cause.issues;
  }
}

function changes(before: { name: string }[], after: { name: string }[]) {
  const previous = new Map(before.map(entity => [entity.name, entity]));
  const next = new Map(after.map(entity => [entity.name, entity]));
  return {
    added: after.filter(entity => !previous.has(entity.name)).map(entity => entity.name),
    removed: before.filter(entity => !next.has(entity.name)).map(entity => entity.name),
    updated: after.filter(entity => previous.has(entity.name) && JSON.stringify(previous.get(entity.name)) !== JSON.stringify(entity)).map(entity => entity.name),
  };
}

export function planOperations(input: Project, operations: unknown[]) {
  if (!Array.isArray(operations)) throw new Error('operations must be an array');
  const original = validateProject(structuredClone(input));
  let project = original;
  for (let index = 0; index < operations.length; index++) {
    try { project = applyOperation(project, parseOperation(operations[index])); }
    catch (cause) { throw new OperationPlanError(index, cause); }
  }
  return { project, report: { ok: true as const, operations: operations.length, changes: {
    parts: changes(original.parts, project.parts), bones: changes(original.bones, project.bones), clips: changes(original.clips, project.clips),
  } } };
}
