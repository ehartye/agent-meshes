import { z } from 'zod';
import { nameSchema, vec3Schema } from './rig.ts';
import type { Clip, Project, Quat, Track, Vec3 } from './types.ts';

/** Targeted clip authoring: create, clone, rename and retime clips, and set, remove or record single keys without resending the clip. */
const duration = z.number().finite().min(0.05).max(120);
const time = z.number().finite().nonnegative();
const property = z.enum(['rotation', 'position']);
/** Any non-zero quaternion; key operations store it normalized. */
const looseQuat = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(q => Math.hypot(...q) > 1e-6, 'Rotation must not be the zero quaternion');
/** 'free' writes only the key given; 'loop' also copies a key written at time 0 or at the duration to the other end for a seamless loop. */
const endpoints = z.enum(['free', 'loop']).optional();

export const clipCreateSchema = z.object({ op: z.literal('clip.create'), name: nameSchema, duration, bones: z.array(nameSchema).min(1).max(256).optional() }).strict();
export const clipCloneSchema = z.object({ op: z.literal('clip.clone'), from: nameSchema, name: nameSchema }).strict();
export const clipRenameSchema = z.object({ op: z.literal('clip.rename'), name: nameSchema, to: nameSchema }).strict();
export const clipRetimeSchema = z.object({ op: z.literal('clip.retime'), name: nameSchema, duration }).strict();
export const clipKeySetSchema = z.object({
  op: z.literal('clip.key.set'), name: nameSchema, bone: nameSchema, property, time,
  value: z.union([looseQuat, vec3Schema]), endpoints,
}).strict().superRefine((operation, context) => {
  const length = operation.property === 'rotation' ? 4 : 3;
  if (operation.value.length !== length) context.addIssue({ code: 'custom', path: ['value'], message: operation.property === 'rotation' ? 'A rotation key needs a quaternion [x, y, z, w]' : 'A position key needs an offset [x, y, z]' });
});
export const clipKeyRemoveSchema = z.object({ op: z.literal('clip.key.remove'), name: nameSchema, bone: nameSchema, property, time }).strict();
const poseSchema = z.object({ bone: nameSchema, rotation: looseQuat.optional(), position: vec3Schema.optional() }).strict()
  .refine(pose => pose.rotation !== undefined || pose.position !== undefined, 'A pose needs a rotation, a position or both');
export const clipKeyRecordSchema = z.object({
  op: z.literal('clip.key.record'), name: nameSchema, time,
  bones: z.array(nameSchema).min(1).max(256).optional(), poses: z.array(poseSchema).min(1).max(256).optional(), endpoints,
}).strict();
export const clipOperationSchemas = {
  'clip.create': clipCreateSchema, 'clip.clone': clipCloneSchema, 'clip.rename': clipRenameSchema, 'clip.retime': clipRetimeSchema,
  'clip.key.set': clipKeySetSchema, 'clip.key.remove': clipKeyRemoveSchema, 'clip.key.record': clipKeyRecordSchema,
};
export type ClipOperation = z.infer<typeof clipCreateSchema> | z.infer<typeof clipCloneSchema> | z.infer<typeof clipRenameSchema> | z.infer<typeof clipRetimeSchema>
  | z.infer<typeof clipKeySetSchema> | z.infer<typeof clipKeyRemoveSchema> | z.infer<typeof clipKeyRecordSchema>;

const EPSILON = 1e-6;
function findClip(project: Project, name: string): Clip {
  const clip = project.clips.find(item => item.name === name);
  if (!clip) throw new Error(`Unknown clip: ${name}`);
  return clip;
}
function requireBone(project: Project, name: string) {
  const bone = project.bones.find(item => item.name === name);
  if (!bone) throw new Error(`Unknown animation bone: ${name}`);
  return bone;
}
function requireFreeName(project: Project, name: string): void {
  if (project.clips.some(clip => clip.name === name)) throw new Error(`Clip name already in use: ${name}`);
}
/** Check a key time is inside the clip and snap the two endpoints exactly. */
function keyTime(clip: Clip, value: number): number {
  if (value > clip.duration + EPSILON) throw new Error(`Key time ${value} is outside clip "${clip.name}" (0 to ${clip.duration})`);
  return value <= EPSILON ? 0 : Math.abs(value - clip.duration) <= EPSILON ? clip.duration : value;
}
/** Unit length, leaving a quaternion that is already unit to within rounding exactly as given. */
const normalized = (q: readonly number[]): Quat => { const length = Math.hypot(...q); return (Math.abs(length - 1) < 1e-12 ? [...q] : q.map(v => v / length)) as Quat; };
const neutral = (name: 'rotation' | 'position'): Quat | Vec3 => name === 'rotation' ? [0, 0, 0, 1] : [0, 0, 0];
const trackOf = (clip: Clip, bone: string, name: string) => clip.tracks.find(track => track.bone === bone && track.property === name);

/** Insert a key keeping times strictly increasing, or replace the one already at that time. */
function putKey(track: Track, at: number, value: Quat | Vec3): void {
  const copy = [...value] as Quat | Vec3;
  const existing = track.keys.findIndex(key => Math.abs(key.time - at) <= EPSILON);
  if (existing >= 0) { track.keys[existing] = { time: track.keys[existing].time, value: copy }; return; }
  const after = track.keys.findIndex(key => key.time > at);
  track.keys.splice(after < 0 ? track.keys.length : after, 0, { time: at, value: copy });
}
function writeKey(project: Project, clip: Clip, bone: string, name: 'rotation' | 'position', at: number, value: Quat | Vec3, policy: 'free' | 'loop'): void {
  requireBone(project, bone);
  let track = trackOf(clip, bone, name);
  if (!track) {
    track = { bone, property: name, keys: [{ time: 0, value: [...neutral(name)] as Quat | Vec3 }, { time: clip.duration, value: [...neutral(name)] as Quat | Vec3 }] };
    clip.tracks.push(track);
  }
  putKey(track, at, value);
  if (policy === 'loop' && (at === 0 || at === clip.duration)) putKey(track, at === 0 ? clip.duration : 0, value);
}

function create(project: Project, operation: z.infer<typeof clipCreateSchema>): void {
  requireFreeName(project, operation.name);
  const names = operation.bones ?? project.bones.map(bone => bone.name);
  if (!names.length) throw new Error('Add a bone before creating a clip');
  if (new Set(names).size !== names.length) throw new Error('Clip bones must be distinct');
  const tracks: Track[] = names.map(name => {
    const pose = requireBone(project, name).pose;
    return { bone: name, property: 'rotation', keys: [{ time: 0, value: [...pose] as Quat }, { time: operation.duration, value: [...pose] as Quat }] };
  });
  project.clips.push({ name: operation.name, duration: operation.duration, tracks });
}
function clone(project: Project, operation: z.infer<typeof clipCloneSchema>): void {
  const source = findClip(project, operation.from);
  requireFreeName(project, operation.name);
  project.clips.push({ ...structuredClone(source), name: operation.name });
}
function rename(project: Project, operation: z.infer<typeof clipRenameSchema>): void {
  const clip = findClip(project, operation.name);
  requireFreeName(project, operation.to);
  clip.name = operation.to;
}
function retime(project: Project, operation: z.infer<typeof clipRetimeSchema>): void {
  const clip = findClip(project, operation.name);
  const factor = operation.duration / clip.duration;
  for (const track of clip.tracks) {
    track.keys.forEach((key, index) => { key.time = index === 0 ? 0 : index === track.keys.length - 1 ? operation.duration : Math.round(key.time * factor * 1e9) / 1e9; });
  }
  clip.duration = operation.duration;
}
function setKey(project: Project, operation: z.infer<typeof clipKeySetSchema>): void {
  const clip = findClip(project, operation.name);
  const value = operation.property === 'rotation' ? normalized(operation.value) : operation.value;
  writeKey(project, clip, operation.bone, operation.property, keyTime(clip, operation.time), value, operation.endpoints ?? 'free');
}
function removeKey(project: Project, operation: z.infer<typeof clipKeyRemoveSchema>): void {
  const clip = findClip(project, operation.name);
  const id = `${operation.bone}:${operation.property}`;
  const track = trackOf(clip, operation.bone, operation.property);
  if (!track) throw new Error(`Clip "${clip.name}" has no ${id} track`);
  const at = keyTime(clip, operation.time);
  const index = track.keys.findIndex(key => Math.abs(key.time - at) <= EPSILON);
  if (index < 0) throw new Error(`Track ${id} has no key at time ${operation.time}`);
  if (track.keys.length <= 2) throw new Error(`Removing the key at ${operation.time} would leave ${id} with fewer than 2 keys; use clip.set to drop the track`);
  if (index === 0 || index === track.keys.length - 1) throw new Error(`The key at ${operation.time} is the ${index === 0 ? 'start' : 'end'} endpoint of ${id}; tracks must span 0 to ${clip.duration}, so replace it with clip.key.set instead`);
  track.keys.splice(index, 1);
}
function recordKeys(project: Project, operation: z.infer<typeof clipKeyRecordSchema>): void {
  const clip = findClip(project, operation.name);
  const at = keyTime(clip, operation.time);
  const targets = new Map<string, { rotation?: readonly number[]; position?: Vec3 }>();
  const selected = operation.bones ?? (operation.poses ? [] : project.bones.map(bone => bone.name));
  if (new Set(selected).size !== selected.length) throw new Error('Recorded bones must be distinct');
  for (const name of selected) targets.set(name, { rotation: requireBone(project, name).pose });
  const given = new Set<string>();
  for (const pose of operation.poses ?? []) {
    requireBone(project, pose.bone);
    if (given.has(pose.bone)) throw new Error(`Duplicate pose for bone: ${pose.bone}`);
    given.add(pose.bone);
    const target = targets.get(pose.bone) ?? {};
    if (pose.rotation) target.rotation = pose.rotation;
    if (pose.position) target.position = pose.position;
    targets.set(pose.bone, target);
  }
  if (!targets.size) throw new Error('Add a bone before recording a pose');
  for (const [bone, pose] of targets) {
    if (pose.rotation) writeKey(project, clip, bone, 'rotation', at, normalized(pose.rotation), operation.endpoints ?? 'free');
    if (pose.position) writeKey(project, clip, bone, 'position', at, pose.position, operation.endpoints ?? 'free');
  }
}

/** Mutates the caller's clone; applyOperation validates the whole project afterwards, so a failed operation changes nothing. */
export function applyClipOperation(project: Project, operation: ClipOperation): void {
  switch (operation.op) {
    case 'clip.create': return create(project, clipCreateSchema.parse(operation));
    case 'clip.clone': return clone(project, clipCloneSchema.parse(operation));
    case 'clip.rename': return rename(project, clipRenameSchema.parse(operation));
    case 'clip.retime': return retime(project, clipRetimeSchema.parse(operation));
    case 'clip.key.set': return setKey(project, clipKeySetSchema.parse(operation));
    case 'clip.key.remove': return removeKey(project, clipKeyRemoveSchema.parse(operation));
    case 'clip.key.record': return recordKeys(project, clipKeyRecordSchema.parse(operation));
  }
}
