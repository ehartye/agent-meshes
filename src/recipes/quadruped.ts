import { Quaternion, Vector3 } from 'three';
import type { Project, Vec3, Quat, Track } from '../core/types.ts';
import { validateProject } from '../core/model.ts';
import { footPath, solveLeg } from './gait.ts';
import { addQuadrupedBody } from './quadruped-body.ts';

type Species = 'equine' | 'vulpine';
const identity: Quat = [0, 0, 0, 1];
const v = (p: Vec3) => new Vector3(...p);
const tuple = (p: Vector3) => p.toArray() as Vec3;
const hinge = (angle: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle);

/** Touchdown phase of each foot within one cycle (LF/RF fore, LH/RH hind). */
export interface Footfall { LF: number; RF: number; LH: number; RH: number }
export interface GaitSettings {
  duration: number; stride: number; lift: number; stance: number;
  /** Trunk rise amplitude, cycles of rise per stride, and where in the stride the rise peaks. */
  bob: number; bobs: number; bobShift: number;
  /** Fraction of the swing spent lifting and again lowering the foot; between, it holds tucked at `lift`. Omitted: a sine arc. */
  gather?: number;
  /** How far a tucked fore hoof swings back and a hind hoof forward (meters), scaled by the same profile as the lift. */
  tuck?: [fore: number, hind: number];
  /** Carpus (or wrist) and hock recovery fold at full lift, radians about +X; positive folds a fore cannon back. */
  fold?: [fore: number, hind: number];
  /** Trunk pitch nose-down at the top of the leap (radians); level whenever a foot is on the ground. */
  pitch?: number;
  footfall: Footfall;
}
// Walk: lateral sequence LH, LF, RH, RF. Trot: diagonal pairs. Gallop: transverse, right lead,
// hind legs strike first, no foot is down for more than 30% of the stride, at most three are down
// together, and the last 30% is a gathered suspension with every leg folded under the trunk.
const walkOrder: Footfall = { LH: 0, LF: 0.25, RH: 0.5, RF: 0.75 };
const trotOrder: Footfall = { LF: 0, RH: 0, RF: 0.5, LH: 0.5 };
const gallopOrder: Footfall = { LH: 0, RH: 0.12, LF: 0.28, RF: 0.40 };
const recoveryFold: [number, number] = [0.48, -0.20];
const smoothstep = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
/** In-place cycles: forward travel speed is stride / (stance * duration). */
export const quadrupedGaits: Record<Species, Record<string, GaitSettings>> = {
  equine: {
    walk: { duration: 1.6, stride: 0.42, lift: 0.10, stance: 0.72, bob: 0.008, bobs: 2, bobShift: 0, footfall: walkOrder },
    trot: { duration: 1.0, stride: 0.60, lift: 0.15, stance: 0.56, bob: 0.018, bobs: 2, bobShift: 0, footfall: trotOrder },
    // Muybridge's gathered suspension: hooves 0.4 m up, fore hooves swung back under the chest, hind hooves forward
    // under the belly, carpus and hock folded past 70 degrees, and the trunk dipping six degrees at the top of the leap.
    gallop: { duration: 0.7, stride: 0.60, lift: 0.46, stance: 0.30, bob: 0.02, bobs: 1, bobShift: 0.35, gather: 0.25, tuck: [0.25, 0.20], fold: [1.0, -0.7], pitch: 0.105, footfall: gallopOrder },
  },
  vulpine: {
    walk: { duration: 1.2, stride: 0.30, lift: 0.08, stance: 0.72, bob: 0.005, bobs: 2, bobShift: 0, footfall: walkOrder },
    trot: { duration: 0.8, stride: 0.42, lift: 0.12, stance: 0.56, bob: 0.009, bobs: 2, bobShift: 0, footfall: trotOrder },
    gallop: { duration: 0.55, stride: 0.44, lift: 0.32, stance: 0.30, bob: 0.03, bobs: 1, bobShift: 0.35, gather: 0.25, tuck: [0.18, 0.14], fold: [1.5, -0.7], pitch: 0.105, footfall: gallopOrder },
  },
};
export const defaultQuadrupedGaits = ['walk', 'trot'] as const;

export interface QuadrupedOptions { /** Blend every part into one smooth skin with lathe hooves instead of box feet. */ shell?: boolean }
export function createQuadruped(species: Species, name: string, gaits: readonly string[] = defaultQuadrupedGaits, options: QuadrupedOptions = {}): Project {
  for (const gait of gaits) if (!Object.hasOwn(quadrupedGaits[species], gait)) throw new Error(`Unknown ${species} gait: ${gait}`);
  const horse = species === 'equine';
  const project: Project = { version: 1, name, parts: [], bones: [{ name: 'root', parent: null, position: [0, 0, 0], rotation: [...identity], pose: [...identity] }], clips: [] };
  addQuadrupedBody(project, species);
  const legs: { names: string[]; points: Vec3[]; front: boolean; left: boolean }[] = [];
  for (const side of [-1, 1]) for (const front of [true, false]) {
    const prefix = `leg_${side < 0 ? 'L' : 'R'}_${front ? 'front' : 'rear'}`;
    const x = side * (front ? (horse ? 0.26 : 0.28) : 0.30);
    const points: Vec3[] = horse
      ? front ? [[x, 1.43, 0.62], [x, 1.08, 0.42], [x, 0.60, 0.65], [x, 0.20, 0.65], [x, 0.085, 0.71]]
        : [[x, 1.48, -0.69], [x, 1.06, -0.43], [x, 0.62, -0.80], [x, 0.20, -0.72], [x, 0.085, -0.64]]
      : front ? [[x, 1.00, 0.45], [x, 0.65, 0.30], [x, 0.22, 0.50], [x, 0.085, 0.54]]
        : [[x, 1.04, -0.52], [x, 0.70, -0.31], [x, 0.31, -0.61], [x, 0.085, -0.55]];
    const joints = front ? ['shoulder', 'elbow', horse ? 'carpus' : 'wrist'] : ['hip', 'stifle', 'hock'];
    if (horse) joints.push('fetlock');
    joints.push(horse ? 'hoof' : 'paw');
    const names = joints.map(joint => `${prefix}_${joint}`);
    legs.push({ names, points, front, left: side < 0 });
    points.forEach((point, index) => {
      project.bones.push({ name: names[index], parent: index ? names[index - 1] : 'root', position: index ? tuple(v(point).sub(v(points[index - 1]))) : point, rotation: [...identity], pose: [...identity] });
      const width = index === 0 ? (horse ? 0.25 : 0.20) : index === 1 ? (horse ? 0.16 : 0.12) : 0.09;
      const color = index < 2 ? (horse ? '#aa7149' : '#c76f43') : '#463c40';
      if (index < points.length - 1) {
        const end = points[index + 1], direction = v(end).sub(v(point)), length = direction.length();
        project.parts.push({ name: `${prefix}_${['upper', 'shin', 'cannon', 'pastern'][index]}`, geometry: { type: 'capsule', size: [width, length, width], segments: 10 }, position: tuple(v(point).add(v(end)).multiplyScalar(0.5)), rotation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()).toArray() as Quat, scale: [1, 1, 1], color, parent: null, binding: index === 0 && !options.shell ? { type: 'linear', bones: [names[0], names[1]], axis: 'y', range: [length * 0.1, length * 0.48] } : { type: 'rigid', bone: names[index] } });
        project.parts.push({ name: `${names[index]}_cover`, geometry: { type: 'sphere', size: [width, width, width], segments: 10 }, position: point, rotation: [...identity], scale: [1, 1, 1], color, parent: null, binding: { type: 'rigid', bone: names[index] } });
      } else {
        const hoof = horse && options.shell;
        project.parts.push({ name: `${prefix}_foot`, geometry: hoof ? { type: 'lathe', size: [0.19, 0.15, 0.21], segments: 16, profile: [[0.42, -0.5], [0.5, -0.1], [0.44, 0.3], [0.28, 0.5]] } : { type: horse ? 'box' : 'sphere', size: horse ? [0.17, 0.17, 0.23] : [0.18, 0.17, 0.26], segments: 10 }, position: [point[0], hoof ? 0.075 : point[1], point[2] + 0.025], rotation: [...identity], scale: [1, 1, 1], color: '#463c40', parent: null, binding: { type: 'rigid', bone: names[index] } });
      }
    });
  }

  if (options.shell) {
    // The flat highlight stripe would ride on the barrel as a lighter patch with an occlusion rim; the skin is one colour there.
    project.parts = project.parts.filter(part => part.name !== 'back_highlight');
    // Eyes and nostrils stay crisp on top of the skin; everything else blends into one body.
    const skin = project.parts.filter(part => !/eye|glint|nostril/.test(part.name)).map(part => part.name);
    project.shells = [{ name: 'skin', parts: skin, blend: horse ? 0.06 : 0.05, resolution: 72 }];
  }
  // The trunk pitches about the midpoint of shoulders and hips, not the ground origin, so the body does not lurch.
  const pivot = v(legs[0].points[0]).add(v(legs[1].points[0])).multiplyScalar(0.5).setX(0);
  for (const gait of gaits) {
    const settings = quadrupedGaits[species][gait];
    const tracks: Track[] = [{ bone: 'root', property: 'position', keys: [] }, ...(settings.pitch ? [{ bone: 'root', property: 'rotation' as const, keys: [] }] : []), ...legs.flatMap(leg => leg.names.map(bone => ({ bone, property: 'rotation' as const, keys: [] }))), { bone: 'head', property: 'rotation', keys: [] }, { bone: 'tail', property: 'rotation', keys: [] }];
    // The flight window: after the last foot leaves until the first foot lands again.
    const flightStart = Math.max(...Object.values(settings.footfall)) + settings.stance, flightEnd = Math.min(...Object.values(settings.footfall)) + 1;
    const frames = Math.ceil(settings.duration * 120);
    for (let frame = 0; frame <= frames; frame++) {
      const phase = frame === frames ? 0 : frame / frames, time = frame / frames * settings.duration;
      // Low trunk rise (twice per cycle for walk and trot, once for gallop); IK compensates so stance feet do not bob.
      const bob = settings.bob * (1 - Math.cos(2 * Math.PI * (settings.bobs * phase - settings.bobShift)));
      let track = 0;
      if (settings.pitch) {
        const flight = phase < flightStart || phase > flightEnd ? 0 : Math.sin(Math.PI * (phase - flightStart) / (flightEnd - flightStart)) ** 2;
        const pitch = hinge(settings.pitch * flight);
        tracks[track++].keys.push({ time, value: tuple(pivot.clone().sub(pivot.clone().applyQuaternion(pitch)).add(new Vector3(0, bob, 0))) });
        tracks[track++].keys.push({ time, value: pitch.toArray() as Quat });
      } else tracks[track++].keys.push({ time, value: [0, bob, 0] });
      for (const leg of legs) {
        const { points, front, left } = leg;
        // A foot's cycle starts at its touchdown, so its offset is the complement of its footfall phase.
        const touchdown = settings.footfall[`${left ? 'L' : 'R'}${front ? 'F' : 'H'}` as keyof Footfall];
        const cycle = (phase + 1 - touchdown) % 1;
        const path = footPath(cycle, settings.stride, settings.lift, settings.stance);
        const u = cycle <= settings.stance ? 0 : (cycle - settings.stance) / (1 - settings.stance);
        // Sine arc for walk and trot; a gathering gait snaps the foot up after lift-off and holds it tucked until just before landing.
        const swing = u === 0 ? 0 : settings.gather ? smoothstep(Math.min(u, 1 - u) / settings.gather) : Math.sin(Math.PI * u) ** 2;
        if (settings.gather) path[1] = settings.lift * swing;
        // Tucked hooves swing back under the chest and forward under the belly while they are held up.
        if (settings.tuck) path[2] += swing * (front ? -settings.tuck[0] : settings.tuck[1]);
        // Carpus/hock recovery folds are coupled to foot lift, not free oscillators.
        const distal = hinge(swing * (settings.fold ?? recoveryFold)[front ? 0 : 1]);
        const pastern = distal.clone().multiply(hinge(horse ? -0.12 * swing : 0));
        const foot = points.at(-1)!;
        const target = v(foot).add(v(path)); target.y -= bob;
        const lowerOffset = v(points[3]).sub(v(points[2])).applyQuaternion(distal);
        if (horse) lowerOffset.add(v(points[4]).sub(v(points[3])).applyQuaternion(pastern));
        const middleTarget = target.clone().sub(lowerOffset);
        const solved = solveLeg(points[0], points[1], points[2], tuple(middleTarget), [0, 0, front ? -1 : 1]);
        const parent = new Quaternion().fromArray(solved.upper).multiply(new Quaternion().fromArray(solved.lower));
        const values: Quat[] = [solved.upper, solved.lower, parent.invert().multiply(distal).toArray() as Quat];
        if (horse) values.push(distal.clone().invert().multiply(pastern).toArray() as Quat);
        values.push((horse ? pastern : distal).clone().invert().toArray() as Quat);
        for (const value of values) tracks[track++].keys.push({ time, value });
      }
      tracks[track++].keys.push({ time, value: hinge((gait === 'walk' ? 0.022 : gait === 'gallop' ? 0.05 : 0.007) * Math.sin(2 * Math.PI * (settings.bobs * phase - settings.bobShift))).toArray() as Quat });
      tracks[track].keys.push({ time, value: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (horse ? 0.035 : 0.07) * Math.sin(2 * Math.PI * phase)).toArray() as Quat });
    }
    project.clips.push({ name: gait, duration: settings.duration, tracks });
  }
  return validateProject(JSON.parse(JSON.stringify(project)));
}
