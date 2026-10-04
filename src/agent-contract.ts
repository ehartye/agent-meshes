import { z } from 'zod';
import { applyOperation, createProject, partChangesSchema, partSchema, projectSchema, rotationEulerSchema, validateProject } from './core/model.ts';
import { bindingBones, bindingSchema, boneSchema, nameSchema, quatSchema } from './core/rig.ts';
import { clipSchema } from './core/animation.ts';
import { shellSchema } from './core/model.ts';
import { assemblyCopySchema } from './core/assembly.ts';
import { poseTargetSchema } from './core/pose-target.ts';
import { ModelError } from './errors.ts';
import type { BoneDef, Clip, GeometryKind, Operation, Part, Project } from './core/types.ts';

const partInputSchema = partSchema.omit({ geometry: true }).partial().required({ name: true }).extend({ anchor: nameSchema.optional(), rotationEuler: rotationEulerSchema.optional() })
  .extend({ geometry: partSchema.shape.geometry.partial().required({ type: true }).optional() });
const named = { name: nameSchema };

/** Shape contracts reuse model schemas; state-dependent checks still run in applyOperation. */
export const operationSchemas = {
  'assembly.copy': assemblyCopySchema,
  'pose.target': poseTargetSchema,
  add: z.object({ op: z.literal('add'), part: partInputSchema }).strict(),
  update: z.object({ op: z.literal('update'), ...named, changes: partChangesSchema }).strict(),
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
    { op: 'add', part: { name: 'visor', geometry: { type: 'sphere', size: [0.5, 0.5, 0.5] }, color: '#e8f6ff', material: { metalness: 0, roughness: 0.05, opacity: 0.18, ior: 1.5, doubleSided: true } } },
  ],
  update: [{ op: 'update', name: 'body', changes: { color: '#64b9c4' } }, { op: 'update', name: 'body', changes: { material: { metalness: 1, roughness: 0.1 } } }, { op: 'update', name: 'body', changes: { pattern: { type: 'dots', color: '#ffffff', size: 0.12 } } }, { op: 'update', name: 'body', changes: { pattern: null } }],
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
    { op: 'shell.set', shell: { name: 'skin', parts: ['body', 'head'], blend: 0.12, colorBlend: 0, resolution: 48 } },
    { op: 'shell.set', shell: { name: 'steel', parts: ['body', 'head'], blend: 0.12, resolution: 48, material: { metalness: 1, roughness: 0.1 } } },
    { op: 'shell.set', shell: { name: 'skin', parts: ['body', 'head'], blend: 0.12, resolution: 48, pattern: { type: 'stripes', color: '#ffffff', size: 0.2, axis: 'y' } } },
  ],
  'shell.remove': [{ op: 'shell.remove', name: 'skin' }],
};
const descriptions: Record<Operation['op'], string> = {
  add: 'Create a named primitive or group; omitted fields use the published defaults. A lathe needs a unit profile and a prism a unit outline. An anchor bone makes position and rotation relative to that bone\'s rest frame. An optional material sets the finish: metalness 0 to 1 (paint to bare metal) and roughness 0 to 1 (mirror to chalk); metalness 1 with roughness 0.1 is polished chrome. Glass adds opacity (0 to 1; below 1 blends over what is behind, exported as glTF alphaMode BLEND), transmission (0 to 1, KHR_materials_transmission), ior (1 to 2.333, KHR_materials_ior; 1.5 is glass) and doubleSided; a clear visor is opacity about 0.2, roughness 0.05, doubleSided. Glass casts no shadow and has no outline hull. An optional material name (for example PieceWhite) is written as the glTF material name; parts with the same name, colour and finish share one exported material, and identical unnamed materials are shared too. An optional pattern (dots, stripes or checks of a color at a size in meters; stripes and checks take an axis, default y, and an optional world offset) is painted over the part color in world space and baked into vertex colors.',
  update: 'Update a part. Unbind before changing geometry; update does not rename. A material change replaces the whole finish (metalness, roughness and any glass fields: opacity, transmission, ior, doubleSided), with omitted fields at their defaults. Set pattern to null to remove a painted pattern.',
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
  'shell.set': 'Create or replace a smooth shell that blends the listed parts into one surface and replaces them when rendered or exported. Members must all be rigid-bound or all unbound; colors and bone weights come from the members that own each point. Optional colorBlend (meters, min 0) is the width of the band where member colors mix: default half of blend, 0 gives hard-edged patches by ownership; bone weights are unaffected. Optional cut lists parts subtracted from the surface (holes and hollows) with the same blend; cutters are hidden like members, contribute no color or weight, and cannot also be members. An optional material (metalness, roughness, 0 to 1, plus the glass fields opacity, transmission, ior and doubleSided) sets the finish of the whole shell. An optional pattern (dots, stripes or checks) is painted over the blended colors in world space, before ambient occlusion. By default the shell bakes member colors and ambient occlusion into vertex colors (COLOR_0, COLOR_1) that multiply the material color, so it looks darker or tinted next to a plain part of the same color; vertexColors false exports none, takes the single member color from the material like a plain part, and requires all members to share one color and no pattern.',
  'shell.remove': 'Remove a shell; its member parts render individually again.',
  'assembly.copy': 'Copy a bone subtree with its bound parts and clip tracks under a prefix, optionally mirrored and offset in the root parent frame.',
  'pose.target': 'Pose a three-bone parent-child chain with two-link IK so the end bone reaches a world-space target, bending toward the pole.',
};

/** File references resolve from the package running this CLI/server, including managed installs. */
export function techniqueGuidance() {
  return {
    baseUrl: new URL('../', import.meta.url).href,
    references: [{
      topic: 'character-construction',
      path: 'scripts/blender_lib/references/character-construction.md',
      useWhen: 'Before constructing or repairing a skinned character, clothing, hair or facial attachments',
    }],
  };
}

interface GeometryGuide { description: string; conventions: string[]; examples: Operation[] }
const roundSegments = 'segments is the facet count around the circumference, 3 to 64; a larger count is rounder and costs more triangles.';
const unitBox = 'size is the bounding box in meters and the shape is centred on the part origin.';
/** Per-geometry contracts: what `capabilities lathe` prints. Conventions here were previously found only by experiment. */
const geometryGuides: Record<GeometryKind, GeometryGuide> = {
  box: { description: 'A cuboid of size [x, y, z] meters.', conventions: [unitBox, 'segments is ignored by a box (it always has 6 flat faces); omit it.'], examples: [{ op: 'add', part: { name: 'slab', geometry: { type: 'box', size: [1, 0.2, 0.5] } } }] },
  sphere: { description: 'An ellipsoid with diameters size [x, y, z].', conventions: [unitBox, roundSegments], examples: [{ op: 'add', part: { name: 'ball', geometry: { type: 'sphere', size: [0.4, 0.4, 0.4], segments: 24 } } }] },
  cylinder: { description: 'A cylinder along y; diameter from size[0] and size[2], height size[1].', conventions: [unitBox, roundSegments], examples: [{ op: 'add', part: { name: 'drum', geometry: { type: 'cylinder', size: [0.5, 0.3, 0.5], segments: 32 } } }] },
  cone: { description: 'A cone along y with its point up.', conventions: [unitBox, roundSegments], examples: [{ op: 'add', part: { name: 'spire', geometry: { type: 'cone', size: [0.3, 0.8, 0.3] } } }] },
  capsule: { description: 'A capsule along y: a cylinder with hemispherical ends.', conventions: [unitBox, roundSegments], examples: [{ op: 'add', part: { name: 'limb', geometry: { type: 'capsule', size: [0.12, 0.5, 0.12] } } }] },
  group: { description: 'An empty transform node; parts name it as their parent to move together.', conventions: ['A group has no mesh, cannot be bound to bones or put in a shell.'], examples: [{ op: 'add', part: { name: 'rig_root', geometry: { type: 'group' } } }] },
  lathe: {
    description: 'Revolves a [radius, height] profile around y: turned pieces, vases, chess pieces, towers, bowls.',
    conventions: [
      'Unit profile (default, profileUnits "unit"): radius 0 to 0.5 and height -0.5 to 0.5. The world radius is r * size[0] (not size[0] / 2), the height is h * size[1]; the shape is centred on the part origin, so the bottom is at y = -size[1] / 2.',
      'Metre profile (profileUnits "metres"): points are real [radius, height] in meters, height measured upward from the part origin (a profile starting at height 0 puts the bottom at y = 0). size is ignored; scale the part with `scale` if needed.',
      'Order points bottom to top with the outside facing away from the axis. A first or last point with radius 0 closes the cap on the axis. Profiles take 3 to 64 points.',
      'Normals are smooth across every profile joint. corners lists zero-based profile indices that are hard edges: normals split there (a ledge, collar or step shades crisply) and only the duplicated vertices are added, no extra triangles.',
      'angleRange [startDeg, endDeg] revolves one sector (angles about +y, measured from +z toward +x; [0, 45] is an eighth). The profile is closed with a wall back to its first point and both radial ends are capped, so a profile with an inner radius gives an annular sector. Spans of 360 or more are a full lathe.',
      'segments counts steps around the full circle. A sector uses the grid angles startAngle + k * 360 / segments inside its range plus its two exact ends, so a sector and a full lathe with the same segments and startAngle share vertex angles and sit flush when the range ends are on the grid (use a segment count divisible by the sector fraction).',
      'Shell members and cutters must be default unit lathes: profileUnits, corners, angleRange and startAngle are rejected there.',
    ],
    examples: [
      { op: 'add', part: { name: 'pawn', geometry: { type: 'lathe', size: [0.3, 0.6, 0.3], segments: 32, profile: [[0, -0.5], [0.5, -0.5], [0.5, -0.4], [0.2, 0], [0.3, 0.3], [0, 0.5]] } } },
      { op: 'add', part: { name: 'plinth', geometry: { type: 'lathe', segments: 48, profileUnits: 'metres', corners: [2, 3], profile: [[0, 0], [0.4, 0], [0.4, 0.1], [0.2, 0.1], [0.2, 0.5], [0, 0.5]] } } },
      { op: 'add', part: { name: 'merlon', geometry: { type: 'lathe', segments: 48, profileUnits: 'metres', angleRange: [45, 90], corners: [1, 2], profile: [[0.3, 0.5], [0.4, 0.5], [0.4, 0.7], [0.3, 0.7]] } } },
    ],
  },
  prism: {
    description: 'Extrudes a flat [x, y] outline into a solid: cut-outs, silhouettes, horizontal plates and sectors.',
    conventions: [
      'Unit outline (default, outlineUnits "unit"): points within -0.5 to 0.5, scaled by size. With axis "z" (default) they are [x, y] points extruded along z from -size[2] / 2 to size[2] / 2.',
      'axis "y": the outline is [x, z] points in the horizontal plane, extruded along y (height size[1], centred in unit mode).',
      'Metre outline (outlineUnits "metres"): points are real meters and size is not applied to them. The extrusion runs from the part origin to size along the axis (size[1] for axis "y", size[2] for axis "z"), so a horizontal plate with axis "y" sits on y = 0.',
      'bevel chamfers both cap edges by that width (outline units: meters with outlineUnits "metres", otherwise the unit outline fraction); the footprint and the overall length do not change, and twice the bevel must be less than the length.',
      'Outline points are in order around the polygon (either winding); 3 to 64 points. Faces are flat shaded.',
    ],
    examples: [
      { op: 'add', part: { name: 'star', geometry: { type: 'prism', size: [1, 1, 0.05], outline: [[0, 0.5], [0.5, 0.1], [0.3, -0.5], [-0.3, -0.5], [-0.5, 0.1]] } } },
      { op: 'add', part: { name: 'plate', geometry: { type: 'prism', axis: 'y', outlineUnits: 'metres', size: [1, 0.05, 1], bevel: 0.005, outline: [[0, 0], [2, 0], [2, 1], [0, 1]] } } },
    ],
  },
};
const geometryKinds = Object.keys(geometryGuides) as GeometryKind[];

/** One operation's or one geometry's contract, small enough to read whole. Names match case-insensitively. */
export function capabilitiesFor(name: string) {
  const key = name.trim().toLowerCase();
  const base = { version: 1, service: 'agent-meshes', protocolVersion: '0.1.0', coordinates };
  const op = (Object.keys(operationSchemas) as Operation['op'][]).find(candidate => candidate.toLowerCase() === key);
  if (op) return { ...base, filter: { name: op, kind: 'operation' as const }, operation: { name: op, description: descriptions[op], schema: z.toJSONSchema(operationSchemas[op]), examples: structuredClone(examples[op]) } };
  const geometry = geometryKinds.find(candidate => candidate === key);
  if (geometry) {
    const { size, segments } = defaultPart().geometry;
    return { ...base, filter: { name: geometry, kind: 'geometry' as const }, geometry: { name: geometry, ...geometryGuides[geometry], defaults: { size, segments }, schema: z.toJSONSchema(partSchema.shape.geometry), usedBy: ['add', 'update'] } };
  }
  throw Object.assign(new Error(`Unknown capability "${name}". Operations: ${Object.keys(operationSchemas).join(', ')}. Geometries: ${geometryKinds.join(', ')}.`), { code: 'UNKNOWN_CAPABILITY' });
}

const coordinates = { units: 'meters', up: '+Y', quaternion: '[x,y,z,w]', rotationEuler: '[x,y,z] degrees, three.js XYZ order, accepted on add and update as an alternative to quaternion rotation', animationTransforms: 'Offsets from bone rest transforms' };
// Defaults come from the same constructor path used by authoring, not a second list.
const defaultPart = () => applyOperation(createProject('defaults'), { op: 'add', part: { name: 'example' } }).parts[0];
export function capabilities() { return full(); }
function full() {
  // Defaults come from the same constructor path used by authoring, not a second list.
  const part = applyOperation(createProject('defaults'), { op: 'add', part: { name: 'example' } }).parts[0];
  const bone = applyOperation(createProject('defaults'), { op: 'bone.add', bone: { name: 'example' } }).bones[0];
  const { name: _partName, ...partDefaults } = part;
  const { name: _boneName, ...boneDefaults } = bone;
  return {
    version: 1,
    service: 'agent-meshes',
    protocolVersion: '0.1.0',
    guidance: techniqueGuidance(),
    coordinates,
    defaults: { part: partDefaults, bone: boneDefaults },
    constraints: [
      'JSON Schemas describe field shapes and numeric limits. Runtime refinements and project relationships must also pass planOperations or normal authoring validation.',
      'Quaternions must be unit length within 0.001. Influence names must be distinct, linear ranges ascending, and explicit weight rows normalized within 0.000001 with one row per generated vertex.',
      'Part and bone names are globally distinct; each hierarchy must be acyclic with existing parents. Binding bones and animation bones must exist.',
      'Each clip name and each bone/property track pair must be unique. Key times strictly increase from zero through the clip duration.',
      'Examples are individual operation shapes, not a sequential batch; named targets must exist where required.',
      'Planning validates every intermediate state exactly as applying operations does. Failures report zero-based operationIndex; no source project is changed.',
    ],
    usage: 'Print one operation or geometry only with "capabilities <name>", for example "capabilities lathe" or "capabilities shell.set".',
    geometries: Object.fromEntries(geometryKinds.map(kind => [kind, structuredClone(geometryGuides[kind])])),
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

const SHOWN_ISSUES = 3;
/** Field-path prefix of the payload an operation's schema error is relative to, so apply-phase paths read like the JSON the agent wrote. */
const payloadPrefix: Partial<Record<string, string[]>> = { add: ['part'], update: ['changes'], 'shell.set': ['shell'], 'clip.set': ['clip'], 'bone.add': ['bone'], 'bone.update': ['changes'] };
const pathText = (path: readonly PropertyKey[]) => path.reduce<string>((text, key) => typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key), '');
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) { if (value === null || typeof value !== 'object') return undefined; value = (value as Record<PropertyKey, unknown>)[key]; }
  return value;
}
const shown = (value: unknown) => { const text = JSON.stringify(value); return text === undefined ? undefined : text.length > 60 ? `${text.slice(0, 57)}...` : text; };

/** One-line advice for the most common validation mistakes; undefined when the message already says enough. */
function hintFor(issue: z.core.$ZodIssue, field: string, operation: unknown): string | undefined {
  if (issue.code === 'unrecognized_keys') return `Check field names against "capabilities ${(operation as { op?: string } | undefined)?.op ?? '<op>'}".`;
  if (/geometry\.segments$/.test(field)) {
    const type = (operation as { part?: { geometry?: { type?: string } } } | undefined)?.part?.geometry?.type;
    return type === 'box'
      ? 'A box ignores segments (it always has 6 flat faces); omit it. For round shapes segments is the number of facets around the circumference, 3 to 64.'
      : 'segments is the number of facets around the circumference of a sphere, cylinder, cone, capsule or lathe, 3 to 64 (a box ignores it).';
  }
  if (/geometry\.size/.test(field)) return 'size is [x, y, z] in meters, each above 0 and at most 1000.';
  if (/(^|\.)rotation$/.test(field)) return 'rotation is a unit quaternion [x, y, z, w]; use rotationEuler: [x, y, z] degrees to avoid writing one.';
  if (/(^|\.)color$/.test(field)) return 'color is "#rrggbb".';
  if (field === 'op') return 'Run "capabilities" for the list of operations.';
  return undefined;
}

export class OperationPlanError extends Error {
  readonly operationIndex: number;
  readonly issues?: z.ZodError['issues'];
  readonly op?: string;
  readonly part?: string;
  readonly field?: string;
  readonly value?: unknown;
  readonly hint?: string;
  /** Only set when a caller needs a specific error code instead of OPERATION_FAILED. */
  readonly code?: string;
  /**
   * `phase` says where the cause was raised: 'parse' (schema validation of the operation, so paths already start at the
   * operation) or 'apply' (validation inside applyOperation, so paths start inside the payload).
   */
  constructor(operationIndex: number, cause: unknown, operation?: unknown, options: { phase?: 'parse' | 'apply'; code?: string } = {}) {
    const record = operation && typeof operation === 'object' ? operation as Record<string, unknown> : {};
    const op = typeof record.op === 'string' ? record.op : undefined;
    const payload = (record.part ?? record.shell ?? record.bone ?? record.clip) as { name?: unknown } | undefined;
    let part = typeof record.name === 'string' ? record.name : typeof payload?.name === 'string' ? payload.name : undefined;
    const prefix = (options.phase === 'apply' && op ? payloadPrefix[op] : undefined) ?? [];
    let field: string | undefined, value: unknown, hint: string | undefined, detail: string;
    if (cause instanceof z.ZodError) {
      const parts = cause.issues.slice(0, SHOWN_ISSUES).map(issue => {
        const path = [...prefix, ...issue.path, ...(issue.code === 'unrecognized_keys' ? issue.keys.slice(0, 1) : [])];
        const full = pathText(path), found = valueAt(operation, path);
        field ??= full; if (value === undefined) value = found;
        hint ??= hintFor(issue, full, operation);
        return `${full || 'operation'}${found !== undefined ? ` = ${shown(found)}` : ''}: ${issue.message}`;
      });
      const extra = cause.issues.length - parts.length;
      detail = `${parts.join('; ')}${extra > 0 ? ` (and ${extra} more)` : ''}`;
    } else if (cause instanceof ModelError) {
      part ??= cause.part;
      field = cause.path ? pathText([...prefix, ...cause.path.split('.')]) : undefined; value = cause.value; hint = cause.hint;
      detail = `${field ? `${field}${cause.value !== undefined ? ` = ${shown(cause.value)}` : ''}: ` : ''}${cause.summary}`;
    } else detail = cause instanceof Error ? cause.message : String(cause);
    super(`Operation ${operationIndex}: ${op ? `${op} ` : ''}${part ? `"${part}": ` : op ? ': ' : ''}${detail}${hint ? `${/[.!?]$/.test(detail) ? "" : "."} Hint: ${hint}` : ''}`.replace(': : ', ': '), { cause });
    this.name = 'OperationPlanError';
    this.operationIndex = operationIndex;
    this.op = op; this.part = part; this.field = field; this.value = value; this.hint = hint;
    if (options.code) this.code = options.code;
    if (cause instanceof z.ZodError) this.issues = cause.issues;
  }
}

/**
 * Apply operations in order, naming the failing zero-based index, operation, part, field and value. Unlike
 * planOperations this does not pre-parse each operation against its strict contract schema, so builds keep accepting
 * what they always accepted; error codes stay VALIDATION_ERROR (schema) and AUTHORING_ERROR (everything else).
 */
export function applyOperations(project: Project, operations: readonly unknown[]): Project {
  let current = project;
  operations.forEach((operation, index) => {
    try { current = applyOperation(current, operation as Operation); }
    catch (cause) { throw new OperationPlanError(index, cause, operation, { phase: 'apply', code: cause instanceof z.ZodError ? 'VALIDATION_ERROR' : 'AUTHORING_ERROR' }); }
  });
  return current;
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
    let parsed: Operation;
    try { parsed = parseOperation(operations[index]); } catch (cause) { throw new OperationPlanError(index, cause, operations[index], { phase: 'parse' }); }
    try { project = applyOperation(project, parsed); } catch (cause) { throw new OperationPlanError(index, cause, operations[index], { phase: 'apply' }); }
  }
  return { project, report: { ok: true as const, operations: operations.length, changes: {
    parts: changes(original.parts, project.parts), bones: changes(original.bones, project.bones), clips: changes(original.clips, project.clips),
  } } };
}
