import { Quaternion, Vector3 } from 'three';
import { validateProject } from '../core/model.ts';
import type { Project, Vec3, Quat, GeometryKind, Track } from '../core/types.ts';
import { footPath, solveLeg } from './gait.ts';
import { createSpiderLeg } from './spider-leg.ts';
import { spiderGait } from './spider-motion.ts';
import { createQuadruped, defaultQuadrupedGaits, gaitSettings, withGaitContext, type GaitOverride } from './quadruped.ts';
import { createStrandbeest } from './strandbeest.ts';

export const creatureKinds = ['biped', 'equine', 'vulpine', 'insectoid', 'arachnid'] as const;
export type CreatureKind = typeof creatureKinds[number];
export const creatureInfo = {
  biped: { name: 'Copper courier', label: 'Biped', legs: 2, gait: 'walk', description: 'A small explorer with a big stride.', color: '#c88b3f' },
  equine: { name: 'Amber horse', label: 'Equine', legs: 4, gait: 'walk', description: 'A measured walk and a balanced diagonal trot.', color: '#aa7149' },
  vulpine: { name: 'Ember fox', label: 'Vulpine', legs: 4, gait: 'walk', description: 'A light walk and quick trot on articulated paws.', color: '#c16440' },
  insectoid: { name: 'Jade scarab', label: 'Insectoid', legs: 6, gait: 'tripod', description: 'Six legs move in two supporting tripods.', color: '#328f7d' },
  arachnid: { name: 'Indigo weaver', label: 'Arachnid', legs: 8, gait: 'scuttle', description: 'Eight legs, seven articulated segments each.', color: '#686391' },
} as const;
const identity: Quat = [0, 0, 0, 1];
const V = (p: Vec3) => new Vector3(...p);
const xyz = (v: Vector3) => v.toArray() as Vec3;
const rotation = (axis: Vec3, angle: number) => new Quaternion().setFromAxisAngle(V(axis).normalize(), angle).toArray() as Quat;
/** The biped's clips. A foot is planted for `stance` of the cycle and moves `stride` metres in that time, so the character travels at stride / (stance * duration). */
const bipedGaits = {
  walk: { stride: 0.52, lift: 0.14, stance: 0.62, duration: 1.2, bob: 0.024 },
  run: { stride: 0.8, lift: 0.3, stance: 0.4, duration: 0.6, bob: 0.04 },
} as const;
type BipedGait = { name: string; stride: number; lift: number; stance: number; duration: number; bob: number; given?: GaitOverride };

export type { GaitOverride, GaitSetting } from './quadruped.ts';
export type GaitParams = Record<string, GaitOverride>;
const describe = (value: unknown) => typeof value === 'object' ? JSON.stringify(value) : typeof value === 'string' ? JSON.stringify(value) : String(value);
/** The cycle time bounds in seconds, shared with the biped's --speed guard. */
const cycleBounds = [0.3, 4] as const;
/** Validate one gait's replacement settings. Every message names the setting as `gait-params <gait>.<setting>`; the limits are the ones footPath enforces plus the gallop flight window (stance below 0.6) and a cycle time of 0.3 to 4 s. `kind` is optional: with the biped, `duration` is refused and left out of the setting list. Returns only the settings that were given. */
export function validateGaitOverride(gait: string, entry: unknown, kind?: string): GaitOverride {
  const settings = kind === 'biped' ? gaitSettings.filter(setting => setting !== 'duration') : gaitSettings;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`gait-params ${gait} must be an object with any of ${settings.join(', ')}, received ${describe(entry)}`);
  const result: GaitOverride = {};
  for (const [setting, value] of Object.entries(entry)) {
    const name = `gait-params ${gait}.${setting}`;
    if (!(gaitSettings as readonly string[]).includes(setting)) throw new Error(`${name} is not a gait setting; the settings are ${settings.join(', ')}`);
    if (setting === 'duration' && kind === 'biped') throw new Error(`${name} is not accepted for the biped; set the pace with --speed`);
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number, received ${describe(value)}`);
    if (setting === 'duration') {
      if (value < cycleBounds[0] || value > cycleBounds[1]) throw new Error(`${name} must be from ${cycleBounds[0]} to ${cycleBounds[1]} (seconds per cycle), received ${value}`);
    } else if (setting === 'stance') {
      if (value <= 0 || value >= 1) throw new Error(`${name} must be greater than 0 and less than 1 (a fraction of the cycle), received ${value}`);
      if (gait === 'gallop' && value >= 0.6) throw new Error(`${name} must be below 0.6 on a gallop, or the flight phase closes, received ${value}`);
    } else if (value < 0) throw new Error(`${name} must be zero or more (metres), received ${value}`);
    result[setting as keyof GaitOverride] = value;
  }
  return result;
}
/** Validate the whole `gaitParams` option against the gaits being generated; entries with no settings are dropped. `kind` is optional and is passed to validateGaitOverride. */
export function validateGaitParams(params: unknown, gaits: readonly string[], kind?: string): GaitParams {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error(`gait-params must be a JSON object keyed by gait name, received ${describe(params)}`);
  const result: GaitParams = {};
  for (const [gait, entry] of Object.entries(params)) {
    if (!gaits.includes(gait)) throw new Error(`gait-params names the clip ${gait}, which is not among the gaits being generated (${gaits.join(', ')})`);
    const override = validateGaitOverride(gait, entry, kind);
    if (Object.keys(override).length) result[gait] = override;
  }
  return result;
}
function bipedGaitPlan(gaits: readonly string[] = ['walk'], speed?: number | Record<string, number>, gaitParams?: unknown): BipedGait[] {
  const known = Object.keys(bipedGaits);
  const overrides = gaitParams === undefined ? {} : validateGaitParams(gaitParams, gaits, 'biped');
  if (speed !== undefined && typeof speed === 'object') for (const name of Object.keys(speed)) if (!gaits.includes(name)) throw new Error(`Speed names the clip ${name}, which is not among the requested gaits (${gaits.join(', ')})`);
  return gaits.map(name => {
    if (!known.includes(name)) throw new Error(`Unknown biped gait ${name}; the gaits are ${known.join(', ')}`);
    const given = (overrides as GaitParams)[name];
    const base = { ...bipedGaits[name as keyof typeof bipedGaits], ...given };
    const wanted = typeof speed === 'object' ? speed[name] : speed;
    if (wanted === undefined) return { name, ...base, ...(given ? { given } : {}) };
    if (!Number.isFinite(wanted) || wanted <= 0) throw new Error(`Speed for ${name} must be a positive number of metres per second, received ${wanted}`);
    const duration = base.stride / (base.stance * wanted);
    if (duration < cycleBounds[0] || duration > cycleBounds[1]) throw new Error(`A speed of ${wanted} m/s gives a ${name} cycle of ${duration.toFixed(2)} s; the cycle must be between 0.3 and 4 s, so choose a speed between ${(base.stride / (base.stance * cycleBounds[1])).toFixed(2)} and ${(base.stride / (base.stance * cycleBounds[0])).toFixed(2)} m/s`);
    return { name, ...base, duration, ...(given ? { given } : {}) };
  });
}
interface Leg { name: string; hip: Vec3; knee: Vec3; foot: Vec3; pole: Vec3; phase: number; stride: number; lift: number; stance: number }

/** Recipes produce ordinary editable projects; the runtime has no creature-specific rig rules. */
export interface CreatureOptions {
  /** Clips for equine or vulpine: any of walk, trot, gallop (default walk and trot); for biped: any of walk, run (default walk). */ gaits?: readonly string[];
  /** Biped only: the travel speed in metres per second the stance foot is planted at, for every clip (a number) or per clip (a record). Sets the cycle length to stride / (stance * speed). Default: the clip's own design speed. */ speed?: number | Record<string, number>;
  /** Biped, equine or vulpine: per-gait replacements of the table's `stride`, `lift` and `bob` (metres), `stance` (fraction of the cycle) and, for equine and vulpine only, `duration` (seconds per cycle, 0.3 to 4; the biped sets its pace with `speed`), as `{ walk: { stride: 0.4, lift: 0.2 } }`; a setting not given keeps its table value. Out-of-range values are refused naming `gait-params <gait>.<setting>`. */ gaitParams?: GaitParams;
  /** Equine or vulpine only: smooth skin, retaining distinct equine hair, ears and hard hooves. */ shell?: boolean;
  /** Insectoid only: one clip per entry, each a touchdown phase (0 to 1) per leg in order L1 L2 L3 R1 R2 R3. */ legPhases?: Record<string, number[]>;
  /** Strandbeest only: crank positions along the crankshaft, four legs each. Default 3, at most 5. */ pairs?: number;
  /** Strandbeest only: distance between pairs in meters, and one clip per named crank-offset pattern. */ spacing?: number; patterns?: Record<string, number[]>;
}
export function createCreature(kind: CreatureKind | 'quadruped' | 'strandbeest', options: CreatureOptions = {}): Project {
  if (options.gaitParams !== undefined && (kind === 'strandbeest' || (creatureKinds.includes(kind as CreatureKind) && kind !== 'biped' && kind !== 'equine' && kind !== 'vulpine'))) throw new Error(`Gait parameters (--gait-params) are only configurable for biped, equine and vulpine, not ${kind}`);
  // Jansen's walking machine is a linkage, not a limb rig, so it has its own recipe and is not one of the gallery creatures.
  if (kind === 'strandbeest') return createStrandbeest({ pairs: options.pairs, spacing: options.spacing, patterns: options.patterns });
  if (kind === 'quadruped') kind = 'vulpine';
  if (!creatureKinds.includes(kind)) throw new Error(`Unknown creature recipe: ${kind}`);
  const info = creatureInfo[kind];
  if (kind === 'equine' || kind === 'vulpine') return createQuadruped(kind, info.name, options.gaits, { shell: options.shell, ...(options.gaitParams === undefined ? {} : { gaitParams: validateGaitParams(options.gaitParams, options.gaits ?? defaultQuadrupedGaits, kind) }) });
  if (options.shell) throw new Error(`Shells are only configurable for equine and vulpine, not ${kind}`);
  if (options.gaits && kind !== 'biped') throw new Error(`Gaits are only configurable for equine, vulpine or biped, not ${kind}`);
  if (options.speed !== undefined && kind !== 'biped') throw new Error(`Speed is only configurable for biped, not ${kind}`);
  const bipedClips = kind === 'biped' ? bipedGaitPlan(options.gaits, options.speed, options.gaitParams) : [];
  if (options.legPhases && kind !== 'insectoid') throw new Error(`Leg phases are only configurable for insectoid, not ${kind}`);
  const project: Project = { version: 1, name: info.name, parts: [], bones: [], clips: [] };
  const legs: Leg[] = [];
  const spiderLegs: ReturnType<typeof createSpiderLeg>[] = [];
  const tracks: { bone: string; sample: (phase: number) => Quat }[] = [];
  function bone(name: string, position: Vec3, parent = 'root') {
    project.bones.push({ name, parent: name === 'root' ? null : parent, position, rotation: [...identity], pose: [...identity] });
  }
  function part(name: string, shape: GeometryKind, size: Vec3, position: Vec3, color: string, joint = 'root', orient: Quat = identity) {
    project.parts.push({ name, geometry: { type: shape, size, segments: 10 }, position, rotation: [...orient], scale: [1, 1, 1], color, parent: null, binding: { type: 'rigid', bone: joint } });
  }
  function segment(name: string, from: Vec3, to: Vec3, width: number, color: string, joint: string, shape: GeometryKind = 'capsule', depth = width) {
    const direction = V(to).sub(V(from));
    part(name, shape, [width, direction.length(), depth], xyz(V(from).add(V(to)).multiplyScalar(0.5)), color, joint, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()).toArray() as Quat);
  }
  function leg(spec: Leg, width: number, color: string, accent: string, weighted = false) {
    legs.push(spec); const { name, hip, knee, foot } = spec;
    bone(`${name}_hip`, hip); bone(`${name}_knee`, xyz(V(knee).sub(V(hip))), `${name}_hip`); bone(`${name}_ankle`, xyz(V(foot).sub(V(knee))), `${name}_knee`);
    segment(`${name}_upper`, hip, knee, width, color, `${name}_hip`);
    if (weighted) {
      const length = V(hip).distanceTo(V(knee));
      project.parts.at(-1)!.binding = { type: 'linear', bones: [`${name}_hip`, `${name}_knee`], axis: 'y', range: [length * 0.1, length * 0.48] };
    }
    segment(`${name}_shin`, knee, foot, width * 0.73, accent, `${name}_knee`);
    part(`${name}_joint`, 'sphere', [width * 1.12, width * 1.12, width * 1.12], knee, color, `${name}_knee`);
    const footSize: Vec3 = kind === 'biped' ? [0.26, 0.18, 0.4] : [width * 1.1, foot[1] * 2, width * 1.8];
    part(`${name}_foot`, 'sphere', footSize, [foot[0], foot[1], foot[2] + (kind === 'biped' ? 0.08 : 0.025)], accent, `${name}_ankle`);
  }
  function motion(joint: string, axis: Vec3, amplitude: number, offset = 0, frequency = 1, phase = 0) {
    tracks.push({ bone: joint, sample: t => rotation(axis, offset + amplitude * Math.sin(2 * Math.PI * (t * frequency + phase))) });
  }
  bone('root', [0, 0, 0]);
  if (kind === 'biped') {
    const gold = '#d09a4c', dark = '#294958', teal = '#438c92', cream = '#f5ddb0';
    part('pelvis', 'sphere', [0.65, 0.33, 0.4], [0, 1.08, 0], dark);
    part('waist_bellows', 'cylinder', [0.42, 0.24, 0.37], [0, 1.3, 0], dark);
    bone('chest', [0, 1.4, 0]);
    part('jacket', 'box', [0.72, 0.57, 0.43], [0, 1.62, 0], teal, 'chest');
    part('chest_plate', 'box', [0.45, 0.35, 0.065], [0, 1.66, 0.25], gold, 'chest');
    part('chest_inset', 'box', [0.2, 0.10, 0.025], [0, 1.7, 0.29], dark, 'chest');
    part('chest_light', 'sphere', [0.045, 0.045, 0.025], [0.15, 1.6, 0.292], cream, 'chest');
    part('backpack', 'box', [0.52, 0.57, 0.28], [0, 1.62, -0.33], dark, 'chest');
    for (const side of [-1, 1]) part(`pack_strap_${side < 0 ? 'L' : 'R'}`, 'box', [0.075, 0.59, 0.045], [side * 0.27, 1.62, 0.24], cream, 'chest');
    bone('head', [0, 1.98, 0]);
    part('neck', 'cylinder', [0.21, 0.2, 0.21], [0, 1.98, 0], dark, 'head');
    part('helmet', 'sphere', [0.85, 0.72, 0.64], [0, 2.29, 0], gold, 'head');
    part('face_visor', 'sphere', [0.64, 0.34, 0.17], [0, 2.3, 0.29], dark, 'head');
    for (const side of [-1, 1]) {
      const s = side < 0 ? 'L' : 'R';
      part(`eye_${s}`, 'sphere', [0.12, 0.14, 0.055], [side * 0.16, 2.31, 0.375], cream, 'head');
      part(`ear_${s}`, 'sphere', [0.15, 0.30, 0.30], [side * 0.43, 2.27, 0], teal, 'head');
      const hip: Vec3 = [side * 0.23, 1.08, 0], knee: Vec3 = [side * 0.23, 0.59, 0.25], foot: Vec3 = [side * 0.23, 0.10, 0];
      leg({ name: `leg_${s}`, hip, knee, foot, pole: [0, 0, 1], phase: side < 0 ? 0 : 0.5, stride: 0.52, lift: 0.14, stance: 0.62 }, 0.22, gold, dark, true);
      const shoulder: Vec3 = [side * 0.49, 1.83, 0], elbow: Vec3 = [side * 0.61, 1.46, 0], hand: Vec3 = [side * 0.62, 1.16, 0.09];
      bone(`arm_${s}`, shoulder); bone(`elbow_${s}`, xyz(V(elbow).sub(V(shoulder))), `arm_${s}`);
      part(`shoulder_${s}`, 'sphere', [0.29, 0.3, 0.31], shoulder, gold, `arm_${s}`);
      segment(`sleeve_${s}`, shoulder, elbow, 0.2, teal, `arm_${s}`);
      part(`elbow_joint_${s}`, 'sphere', [0.17, 0.17, 0.17], elbow, dark, `elbow_${s}`);
      segment(`forearm_${s}`, elbow, hand, 0.17, gold, `elbow_${s}`);
      part(`hand_${s}`, 'sphere', [0.21, 0.25, 0.21], hand, dark, `elbow_${s}`);
      motion(`arm_${s}`, [1, 0, 0], -side * 0.4, 0, 1, 0.25); motion(`elbow_${s}`, [1, 0, 0], 0.10, -0.16, 1, side < 0 ? 0 : 0.5);
    }
    segment('antenna_stalk', [0.24, 2.58, -0.04], [0.35, 2.84, -0.04], 0.035, dark, 'head');
    part('antenna_light', 'sphere', [0.095, 0.095, 0.095], [0.35, 2.84, -0.04], teal, 'head');
    motion('chest', [0, 1, 0], 0.045); motion('head', [0, 1, 0], 0.07, 0, 1, 0.5);
  } else {
    const insect = kind === 'insectoid';
    const shell = insect ? '#308778' : '#70658d', highlight = insect ? '#75b6a0' : '#a08db5', dark = insect ? '#294c49' : '#34364f', gold = '#ddb768';
    const height = insect ? 0.65 : 0.60;
    const abdomenZ = insect ? -0.39 : -0.80;
    part('abdomen', 'sphere', insect ? [0.85, 0.55, 1.10] : [0.99, 0.72, 1.02], [0, height + 0.05, abdomenZ], shell);
    part('thorax', 'sphere', insect ? [0.59, 0.42, 0.59] : [0.62, 0.45, 0.89], [0, height, insect ? 0.30 : 0.19], dark);
    bone('head', [0, height, 0.51]);
    part('head_shape', 'sphere', [0.56, 0.4, 0.43], [0, height + 0.04, 0.64], shell, 'head');
    if (insect) {
      for (const side of [-1, 1]) {
        const s = side < 0 ? 'L' : 'R';
        part(`wing_case_${s}`, 'sphere', [0.43, 0.24, 0.98], [side * 0.21, 0.9, -0.37], highlight);
        part(`wing_stripe_${s}`, 'capsule', [0.035, 0.71, 0.025], [side * 0.22, 1.015, -0.38], gold, 'root', rotation([1, 0, 0], Math.PI / 2));
        part(`eye_${s}`, 'sphere', [0.18, 0.19, 0.14], [side * 0.225, 0.74, 0.78], dark, 'head');
        part(`eye_glint_${s}`, 'sphere', [0.055, 0.055, 0.025], [side * 0.23, 0.78, 0.847], gold, 'head');
        bone(`antenna_${s}`, [side * 0.16, 0.82, 0.72], 'head');
        // Head bones have a translated origin; antenna local positions are relative to it.
        project.bones.at(-1)!.position = [side * 0.16, 0.82 - height, 0.72 - 0.51];
        segment(`antenna_stem_${s}`, [side * 0.16, 0.82, 0.72], [side * 0.33, 1.13, 1.02], 0.032, dark, `antenna_${s}`);
        segment(`antenna_tip_${s}`, [side * 0.33, 1.13, 1.02], [side * 0.4, 1.13, 1.21], 0.047, gold, `antenna_${s}`);
        motion(`antenna_${s}`, [0, 0, 1], side * 0.08);
      }
    } else {
      segment('pedicel', [0, height - 0.01, -0.16], [0, height - 0.01, abdomenZ + 0.44], 0.14, dark, 'root');
      for (let i = 0; i < 3; i++) part(`abdomen_spot_${i}`, 'sphere', [0.2 - i * 0.03, 0.055, 0.19], [0, 1.01 - Math.abs(i - 1) * 0.055, abdomenZ - 0.21 + i * 0.22], gold);
      for (const side of [-1, 1]) {
        const s = side < 0 ? 'L' : 'R';
        for (let i = 0; i < 2; i++) {
          part(`eye_${s}_${i}`, 'sphere', [i ? 0.09 : 0.15, i ? 0.09 : 0.16, 0.09], [side * (i ? 0.21 : 0.088), height + (i ? 0.16 : 0.07), 0.829 - i * 0.045], gold, 'head');
          part(`pupil_${s}_${i}`, 'sphere', [i ? 0.036 : 0.067, i ? 0.05 : 0.10, 0.025], [side * (i ? 0.21 : 0.088), height + (i ? 0.16 : 0.07), 0.873 - i * 0.045], dark, 'head');
        }
        segment(`palp_${s}`, [side * 0.18, height - 0.09, 0.72], [side * 0.26, height - 0.16, 0.95], 0.09, highlight, 'head');
      }
    }
    const count = insect ? 3 : 4;
    for (const side of [-1, 1]) for (let i = 0; i < count; i++) {
      if (!insect) {
        const leg = createSpiderLeg(side, i); spiderLegs.push(leg); project.bones.push(...leg.bones); project.parts.push(...leg.parts);
        continue;
      }
      const s = side < 0 ? 'L' : 'R', t = i / (count - 1), z = 0.40 - t * 0.89, spread = 0.62 - t * 1.30;
      const hip: Vec3 = [side * 0.24, height - 0.05, z];
      const knee: Vec3 = [side * (0.76 + Math.sin(t * Math.PI) * 0.15), height + 0.10, z + spread * 0.50];
      const foot: Vec3 = [side * (1.05 + Math.sin(t * Math.PI) * 0.17), 0.045, z + spread];
      leg({ name: `leg_${s}_${i + 1}`, hip, knee, foot, pole: [side, 0.7, 0], phase: (i + (side < 0 ? 0 : 1)) % 2 * 0.5, stride: 0.30, lift: 0.12, stance: 0.62 }, 0.09, shell, dark);
      part(`hip_cover_${s}_${i + 1}`, 'sphere', [0.18, 0.16, 0.2], hip, highlight);
    }
    motion('head', [0, 1, 0], 0.035);
  }
  const duration = kind === 'biped' ? 1.2 : kind === 'insectoid' ? 1.4 : spiderGait.duration;
  const samples = Math.ceil(duration * 60);
  const bob = (t: number) => (kind === 'biped' ? 0.024 : kind === 'arachnid' ? 0.003 : 0.01) * (1 - Math.cos(4 * Math.PI * t));
  /** Sample one looping clip; phaseOf overrides each leg's touchdown phase in leg order. A biped gait replaces the stride, lift, stance, cycle length and bob. */
  function sampleClip(name: string, phaseOf: (legIndex: number) => number, gait?: BipedGait): void {
    const clipDuration = gait?.duration ?? duration, clipSamples = Math.ceil(clipDuration * 60);
    const clipBob = gait ? (t: number) => gait.bob * (1 - Math.cos(4 * Math.PI * t)) : bob;
    const clipTracks: Track[] = [{ bone: 'root', property: 'position', keys: [] }];
    for (const leg of legs) for (const joint of ['hip', 'knee', 'ankle']) clipTracks.push({ bone: `${leg.name}_${joint}`, property: 'rotation', keys: [] });
    for (const leg of spiderLegs) for (const bone of leg.names) clipTracks.push({ bone, property: 'rotation', keys: [] });
    for (const { bone } of tracks) clipTracks.push({ bone, property: 'rotation', keys: [] });
    for (let frame = 0; frame <= clipSamples; frame++) {
      const phase = frame === clipSamples ? 0 : frame / clipSamples, time = frame / clipSamples * clipDuration;
      let index = 0;
      clipTracks[index++].keys.push({ time, value: [0, clipBob(phase), 0] });
      legs.forEach((leg, legIndex) => {
        const offset = footPath(phase + phaseOf(legIndex), gait?.stride ?? leg.stride, gait?.lift ?? leg.lift, gait?.stance ?? leg.stance);
        const target: Vec3 = [leg.foot[0] + offset[0], leg.foot[1] + offset[1] - clipBob(phase), leg.foot[2] + offset[2]];
        const pose = withGaitContext('biped', name, gait?.given, () => solveLeg(leg.hip, leg.knee, leg.foot, target, leg.pole));
        for (const value of [pose.upper, pose.lower, pose.ankle]) clipTracks[index++].keys.push({ time, value });
      });
      for (const leg of spiderLegs) for (const value of leg.sample(phase, clipBob(phase))) clipTracks[index++].keys.push({ time, value });
      for (const { sample } of tracks) clipTracks[index++].keys.push({ time, value: sample(phase) });
    }
    // Avoid quaternion sign flips between adjacent samples without changing orientation.
    for (const track of clipTracks) if (track.property === 'rotation') {
      for (let i = 1; i < track.keys.length; i++) {
        const previous = track.keys[i - 1].value, current = track.keys[i].value;
        if (current.reduce((sum, n, j) => sum + n * previous[j], 0) < 0) track.keys[i].value = current.map(n => -n) as Quat;
      }
      track.keys.at(-1)!.value = [...track.keys[0].value];
    }
    project.clips.push({ name, duration: clipDuration, tracks: clipTracks });
  }
  if (options.legPhases) {
    if (kind !== 'insectoid') throw new Error(`Leg phases are only configurable for insectoid, not ${kind}`);
    for (const [name, phases] of Object.entries(options.legPhases)) {
      if (phases.length !== legs.length) throw new Error(`Expected ${legs.length} phases for ${name}, received ${phases.length}`);
      sampleClip(name, legIndex => phases[legIndex]);
    }
  } else if (kind === 'biped') for (const gait of bipedClips) sampleClip(gait.name, legIndex => legs[legIndex].phase, gait);
  else sampleClip(info.gait, legIndex => legs[legIndex].phase);
  // Canonical JSON also turns signed zero from quaternion math into ordinary zero.
  return validateProject(JSON.parse(JSON.stringify(project)));
}
