import { z } from 'zod';
import { nameSchema, vec3Schema } from './rig.ts';
import { scaleSchema } from './animation.ts';
import type { Clip, Keyframe, Project, Quat, Track, Vec3 } from './types.ts';

/**
 * Declarative motion controls: each operation states what moves (a hinge between two angles, a number of turns, a pulse, a
 * gear ratio) and bakes it into ordinary rotation, position or scale tracks of a named clip. No quaternion is written by hand,
 * and the baked keys are dense enough that interpolation never takes a shortest-path reversal: consecutive rotation keys are
 * never more than a quarter turn apart and their quaternion signs are continuous. A control replaces only the track(s) of the
 * bone and property it drives; every other track of the clip is left exactly as it was.
 */
const duration = z.number().finite().min(0.05).max(120);
const degrees = z.number().finite().min(-100000).max(100000);
/** An axis in the bone's own rest frame: x, y or z, or any non-zero vector (normalized when baked). */
const axisSchema = z.union([z.enum(['x', 'y', 'z']), vec3Schema.refine(axis => Math.hypot(...axis) > 1e-6, 'Axis must not be the zero vector')]);

export const controlHingeSchema = z.object({
  op: z.literal('control.hinge'), name: nameSchema, bone: nameSchema, axis: axisSchema, from: degrees, to: degrees,
  mode: z.enum(['swing', 'ramp']).optional(), cycles: z.number().int().min(1).max(1000).optional(),
  keysPerCycle: z.number().int().min(4).max(1000).optional(), duration: duration.optional(),
}).strict().refine(operation => operation.from !== operation.to, { message: 'A hinge needs two different angles', path: ['to'] });
export const controlSpinSchema = z.object({
  op: z.literal('control.spin'), name: nameSchema, bone: nameSchema, axis: axisSchema,
  turns: z.number().int().min(-1000).max(1000).refine(turns => turns !== 0, 'A spin needs at least one turn (negative reverses the direction)'),
  phase: degrees.optional(), keysPerTurn: z.number().int().min(4).max(360).optional(), duration: duration.optional(),
}).strict();
export const controlPulseSchema = z.object({
  op: z.literal('control.pulse'), name: nameSchema, bone: nameSchema, property: z.enum(['scale', 'position']),
  peak: vec3Schema, times: z.array(z.number().finite().nonnegative()).min(1).max(500), width: z.number().finite().positive().max(120),
  shape: z.enum(['smooth', 'triangle']).optional(), duration: duration.optional(),
}).strict().superRefine((operation, context) => {
  if (operation.property === 'scale') for (const issue of scaleSchema.safeParse(operation.peak).error?.issues ?? []) context.addIssue({ code: 'custom', path: ['peak'], message: issue.message });
});
const toothCount = z.number().int().min(3).max(10000);
export const controlCoupleSchema = z.object({
  op: z.literal('control.couple'), name: nameSchema, driver: nameSchema, driven: nameSchema, axis: axisSchema, drivenAxis: axisSchema.optional(),
  ratio: z.number().finite().positive().max(1000).optional(), teeth: z.tuple([toothCount, toothCount]).optional(),
  mesh: z.enum(['external', 'internal']).optional(), phase: degrees.optional(), loop: z.boolean().optional(),
}).strict().superRefine((operation, context) => {
  if ((operation.ratio === undefined) === (operation.teeth === undefined)) context.addIssue({ code: 'custom', path: ['ratio'], message: 'Give exactly one of ratio and teeth ([driver teeth, driven teeth])' });
  if (operation.driver === operation.driven) context.addIssue({ code: 'custom', path: ['driven'], message: 'The driver and the driven bone must differ' });
});
export const controlOperationSchemas = {
  'control.hinge': controlHingeSchema, 'control.spin': controlSpinSchema, 'control.pulse': controlPulseSchema, 'control.couple': controlCoupleSchema,
};
export type ControlOperation = z.infer<typeof controlHingeSchema> | z.infer<typeof controlSpinSchema> | z.infer<typeof controlPulseSchema> | z.infer<typeof controlCoupleSchema>;

const TWO_PI = Math.PI * 2;
const QUARTER_TURN = Math.PI / 2;
const MAX_KEYS = 10000;
const TIME_EPSILON = 1e-9;
const radians = (value: number) => value * Math.PI / 180;
const roundTime = (value: number) => Math.round(value * 1e9) / 1e9;

function unitAxis(axis: z.infer<typeof axisSchema>): Vec3 {
  const raw: Vec3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : axis === 'z' ? [0, 0, 1] : axis;
  const length = Math.hypot(...raw);
  return raw.map(v => v / length) as Vec3;
}
/** The rotation of `angle` radians about a unit axis. Continuous in the angle, so turns beyond one revolution flip no sign. */
function aroundAxis(axis: Vec3, angle: number): Quat {
  const sine = Math.sin(angle / 2);
  // + 0 turns a negative zero into 0 so a saved and reopened project compares equal.
  return [axis[0] * sine + 0, axis[1] * sine + 0, axis[2] * sine + 0, Math.cos(angle / 2)];
}
function requireBone(project: Project, name: string): void {
  if (!project.bones.some(bone => bone.name === name)) throw new Error(`Unknown animation bone: ${name}`);
}
/** The named clip, created with `length` seconds when absent. A clip that exists keeps its duration. */
function clipFor(project: Project, name: string, length: number | undefined): Clip {
  const existing = project.clips.find(clip => clip.name === name);
  if (existing) {
    if (length !== undefined && Math.abs(length - existing.duration) > TIME_EPSILON) throw new Error(`Clip "${name}" lasts ${existing.duration} s; omit duration or use clip.retime to change it`);
    return existing;
  }
  if (length === undefined) throw new Error(`Unknown clip: ${name}; give duration to create it`);
  const clip: Clip = { name, duration: length, tracks: [] };
  project.clips.push(clip);
  return clip;
}
/** Replace the bone/property track in place, or append it; nothing else in the clip changes. */
function putTrack(clip: Clip, bone: string, property: Track['property'], keys: Keyframe[]): void {
  if (keys.length < 2) throw new Error(`Control for ${bone}:${property} baked fewer than 2 keys`);
  if (keys.length > MAX_KEYS) throw new Error(`Control for ${bone}:${property} would need ${keys.length} keys (limit ${MAX_KEYS}); lower the cycles, turns or keys per turn`);
  const track: Track = { bone, property, keys };
  const index = clip.tracks.findIndex(item => item.bone === bone && item.property === property);
  if (index >= 0) clip.tracks[index] = track; else clip.tracks.push(track);
}

/** Largest step between consecutive angles. */
const largestStep = (angles: readonly number[]) => angles.reduce((most, angle, index) => index ? Math.max(most, Math.abs(angle - angles[index - 1])) : most, 0);
/**
 * Sample an angle curve at equal times, starting from `count` intervals and doubling until no two keys are more than a quarter turn apart.
 * `angleAt` takes a fraction of the clip, 0 through 1.
 */
function sampleAngles(angleAt: (fraction: number) => number, count: number): { fractions: number[]; angles: number[] } {
  for (let intervals = count; intervals <= MAX_KEYS; intervals *= 2) {
    const fractions = Array.from({ length: intervals + 1 }, (_, index) => index / intervals);
    const angles = fractions.map(angleAt);
    if (largestStep(angles) <= QUARTER_TURN + 1e-9) return { fractions, angles };
  }
  throw new Error(`The motion needs more than ${MAX_KEYS} keys to stay under a quarter turn per key; lower the angle range, cycles or turns`);
}
function rotationKeys(length: number, axis: Vec3, fractions: readonly number[], angles: readonly number[]): Keyframe[] {
  return fractions.map((fraction, index) => ({ time: index === fractions.length - 1 ? length : roundTime(length * fraction), value: aroundAxis(axis, angles[index]) }));
}

function hinge(project: Project, operation: z.infer<typeof controlHingeSchema>): void {
  requireBone(project, operation.bone);
  const clip = clipFor(project, operation.name, operation.duration);
  const axis = unitAxis(operation.axis), from = radians(operation.from), to = radians(operation.to);
  const cycles = operation.cycles ?? 1, ramp = operation.mode === 'ramp';
  if (ramp && operation.cycles !== undefined) throw new Error('A ramp is one pass from one angle to the other; use mode "swing" for cycles');
  const perCycle = operation.keysPerCycle ?? 24;
  const { fractions, angles } = sampleAngles(fraction => ramp ? from + (to - from) * fraction : from + (to - from) * (1 - Math.cos(TWO_PI * cycles * fraction)) / 2, ramp ? perCycle : perCycle * cycles);
  if (!ramp) angles[angles.length - 1] = from;
  const keys = rotationKeys(clip.duration, axis, fractions, angles);
  if (!ramp) keys[keys.length - 1].value = [...keys[0].value] as Quat;
  putTrack(clip, operation.bone, 'rotation', keys);
}

function spin(project: Project, operation: z.infer<typeof controlSpinSchema>): void {
  requireBone(project, operation.bone);
  const clip = clipFor(project, operation.name, operation.duration);
  const axis = unitAxis(operation.axis), phase = radians(operation.phase ?? 0), turns = operation.turns;
  const count = (operation.keysPerTurn ?? 8) * Math.abs(turns);
  const fractions = Array.from({ length: count + 1 }, (_, index) => index / count);
  const keys = rotationKeys(clip.duration, axis, fractions, fractions.map(fraction => phase + TWO_PI * turns * fraction));
  // After a whole number of turns the pose is the start again; an odd count is the same orientation as the negated quaternion, which keeps the signs continuous.
  keys[keys.length - 1].value = keys[0].value.map(v => (Math.abs(turns) % 2 ? -v : v) + 0) as Quat;
  putTrack(clip, operation.bone, 'rotation', keys);
}

/** Smooth pulses ease with half a cosine over four steps per side; triangles are straight lines. */
const PULSE_STEPS = 4;
function pulse(project: Project, operation: z.infer<typeof controlPulseSchema>): void {
  requireBone(project, operation.bone);
  const clip = clipFor(project, operation.name, operation.duration);
  const rest: Vec3 = operation.property === 'scale' ? [1, 1, 1] : [0, 0, 0];
  const half = operation.width / 2, smooth = (operation.shape ?? 'smooth') === 'smooth';
  const at = (weight: number): Vec3 => rest.map((base, index) => weight === 1 ? operation.peak[index] : base + weight * (operation.peak[index] - base)) as Vec3;
  const keys: Keyframe[] = [];
  const push = (time: number, value: Vec3) => {
    const snapped = time <= TIME_EPSILON ? 0 : Math.abs(time - clip.duration) <= TIME_EPSILON ? clip.duration : roundTime(time);
    const last = keys.at(-1);
    if (last && snapped - last.time <= TIME_EPSILON) { if (snapped < last.time) throw new Error('Pulses must not overlap'); return; }
    keys.push({ time: snapped, value });
  };
  let previousEnd = 0;
  const centers = [...operation.times];
  centers.forEach((center, index) => {
    if (index && center <= centers[index - 1]) throw new Error('Pulse times must strictly increase');
    if (center - half < -TIME_EPSILON || center + half > clip.duration + TIME_EPSILON) throw new Error(`The pulse at ${center} s (width ${operation.width} s) does not fit inside clip "${clip.name}" (0 to ${clip.duration} s)`);
    if (center - half < previousEnd - TIME_EPSILON) throw new Error(`The pulse at ${center} s overlaps the previous one; widen the spacing or narrow the width`);
    if (index === 0 && center - half > TIME_EPSILON) push(0, [...rest]);
    for (let step = 0; step <= PULSE_STEPS * 2; step++) {
      const side = step <= PULSE_STEPS ? step / PULSE_STEPS : (PULSE_STEPS * 2 - step) / PULSE_STEPS;
      push(center - half + operation.width * step / (PULSE_STEPS * 2), at(smooth ? (1 - Math.cos(Math.PI * side)) / 2 : side));
    }
    previousEnd = center + half;
  });
  if (keys.at(-1)!.time < clip.duration) push(clip.duration, [...rest]);
  putTrack(clip, operation.bone, operation.property, keys);
}

/** The angle about `axis` of each key of a rotation track, unwrapped so the sequence is continuous from a start in (-pi, pi]. */
function unwrappedAngles(track: Track, axis: Vec3, label: string): number[] {
  const angles: number[] = [];
  for (const key of track.keys) {
    const [x, y, z, w] = key.value as Quat;
    const length = Math.hypot(x, y, z, w);
    const along = (x * axis[0] + y * axis[1] + z * axis[2]) / length;
    const off = Math.hypot(x / length - along * axis[0], y / length - along * axis[1], z / length - along * axis[2]);
    if (off > 1e-6) throw new Error(`${label} must rotate about the coupled axis only; the key at ${key.time} s also turns about another axis`);
    const raw = 2 * Math.atan2(along, w / length);
    if (!angles.length) { angles.push(raw - TWO_PI * Math.round(raw / TWO_PI)); continue; }
    const delta = raw - angles.at(-1)!;
    const step = delta - TWO_PI * Math.round(delta / TWO_PI);
    if (Math.abs(step) > QUARTER_TURN + 1e-6) throw new Error(`${label} turns more than a quarter turn between keys near ${key.time} s, so its direction is ambiguous; bake it with control.spin or control.hinge`);
    angles.push(angles.at(-1)! + step);
  }
  return angles;
}

function couple(project: Project, operation: z.infer<typeof controlCoupleSchema>): void {
  requireBone(project, operation.driver); requireBone(project, operation.driven);
  const clip = clipFor(project, operation.name, undefined);
  const source = clip.tracks.find(track => track.bone === operation.driver && track.property === 'rotation');
  if (!source) throw new Error(`Clip "${clip.name}" has no rotation track for driver "${operation.driver}"; bake it first with control.spin or control.hinge`);
  const ratio = operation.ratio ?? operation.teeth![0] / operation.teeth![1];
  const sign = (operation.mesh ?? 'external') === 'external' ? -1 : 1, phase = radians(operation.phase ?? 0);
  const driverAngles = unwrappedAngles(source, unitAxis(operation.axis), `Driver "${operation.driver}"`);
  const times: number[] = [], angles: number[] = [];
  source.keys.forEach((key, index) => {
    const here = sign * ratio * driverAngles[index] + phase;
    if (index) {
      const earlier = angles.at(-1)!, start = source.keys[index - 1].time, steps = Math.max(1, Math.ceil(Math.abs(here - earlier) / QUARTER_TURN - 1e-9));
      for (let step = 1; step < steps; step++) { times.push(roundTime(start + (key.time - start) * step / steps)); angles.push(earlier + (here - earlier) * step / steps); }
    }
    times.push(key.time); angles.push(here);
  });
  const travel = (angles.at(-1)! - angles[0]) / TWO_PI;
  if ((operation.loop ?? true) && Math.abs(travel - Math.round(travel)) > 1e-6) {
    throw new Error(`Driven bone "${operation.driven}" ends ${+(travel - Math.floor(travel)).toFixed(4)} of a turn past where it starts, so the loop would pop; choose a driver turn count that makes ratio times turns whole, or set loop to false`);
  }
  const axis = unitAxis(operation.drivenAxis ?? operation.axis);
  const keys: Keyframe[] = times.map((time, index) => ({ time, value: aroundAxis(axis, angles[index]) }));
  putTrack(clip, operation.driven, 'rotation', keys);
}

/** Mutates the caller's clone; applyOperation validates the whole project afterwards, so a failed control changes nothing. */
export function applyControlOperation(project: Project, operation: ControlOperation): void {
  switch (operation.op) {
    case 'control.hinge': return hinge(project, controlHingeSchema.parse(operation));
    case 'control.spin': return spin(project, controlSpinSchema.parse(operation));
    case 'control.pulse': return pulse(project, controlPulseSchema.parse(operation));
    case 'control.couple': return couple(project, controlCoupleSchema.parse(operation));
  }
}
