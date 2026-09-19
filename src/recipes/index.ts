import { Quaternion, Vector3 } from 'three';
import { validateProject } from '../core/model.ts';
import type { Project, Vec3, Quat, GeometryKind, Track } from '../core/types.ts';
import { footPath, solveLeg } from './gait.ts';
import { createSpiderLeg } from './spider-leg.ts';
import { spiderGait } from './spider-motion.ts';
import { createQuadruped } from './quadruped.ts';

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
interface Leg { name: string; hip: Vec3; knee: Vec3; foot: Vec3; pole: Vec3; phase: number; stride: number; lift: number; stance: number }

/** Recipes produce ordinary editable projects; the runtime has no creature-specific rig rules. */
export interface CreatureOptions {
  /** Clips for equine or vulpine: any of walk, trot, gallop. Default walk and trot. */ gaits?: readonly string[];
  /** Equine or vulpine only: blend every part into one smooth skin with lathe hooves. */ shell?: boolean;
}
export function createCreature(kind: CreatureKind | 'quadruped', options: CreatureOptions = {}): Project {
  if (kind === 'quadruped') kind = 'vulpine';
  if (!creatureKinds.includes(kind)) throw new Error(`Unknown creature recipe: ${kind}`);
  const info = creatureInfo[kind];
  if (kind === 'equine' || kind === 'vulpine') return createQuadruped(kind, info.name, options.gaits, { shell: options.shell });
  if (options.gaits || options.shell) throw new Error(`Gaits and shells are only configurable for equine and vulpine, not ${kind}`);
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
  const clipTracks: Track[] = [{ bone: 'root', property: 'position', keys: [] }];
  for (const leg of legs) for (const joint of ['hip', 'knee', 'ankle']) clipTracks.push({ bone: `${leg.name}_${joint}`, property: 'rotation', keys: [] });
  for (const leg of spiderLegs) for (const bone of leg.names) clipTracks.push({ bone, property: 'rotation', keys: [] });
  for (const { bone } of tracks) clipTracks.push({ bone, property: 'rotation', keys: [] });
  for (let frame = 0; frame <= samples; frame++) {
    const phase = frame === samples ? 0 : frame / samples, time = frame / samples * duration;
    let index = 0;
    clipTracks[index++].keys.push({ time, value: [0, bob(phase), 0] });
    for (const leg of legs) {
      const offset = footPath(phase + leg.phase, leg.stride, leg.lift, leg.stance);
      const target: Vec3 = [leg.foot[0] + offset[0], leg.foot[1] + offset[1] - bob(phase), leg.foot[2] + offset[2]];
      const pose = solveLeg(leg.hip, leg.knee, leg.foot, target, leg.pole);
      for (const value of [pose.upper, pose.lower, pose.ankle]) clipTracks[index++].keys.push({ time, value });
    }
    for (const leg of spiderLegs) for (const value of leg.sample(phase, bob(phase))) clipTracks[index++].keys.push({ time, value });
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
  project.clips.push({ name: info.gait, duration, tracks: clipTracks });
  // Canonical JSON also turns signed zero from quaternion math into ordinary zero.
  return validateProject(JSON.parse(JSON.stringify(project)));
}
