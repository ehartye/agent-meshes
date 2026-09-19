import { Quaternion, Vector3 } from 'three';
import type { BoneDef, Part, Quat, Vec3 } from '../core/types.ts';
import { solveSpiderPose, spiderContact, spiderStep, spiderTarget } from './spider-motion.ts';

export const spiderSegments = ['coxa', 'trochanter', 'femur', 'patella', 'tibia', 'metatarsus', 'tarsus'] as const;
const vector = (p: Vec3) => new Vector3(...p);
const tuple = (v: Vector3) => v.toArray() as Vec3;
const identity: Quat = [0, 0, 0, 1];

/** Seven rigid exoskeleton sections, plus an unmeshed tip for contact inspection. */
export function createSpiderLeg(side: number, index: number) {
  const prefix = `leg_${side < 0 ? 'L' : 'R'}_${index + 1}`;
  const spread = 0.62 - index * 0.44, z = 0.42 - index * 0.2;
  const fan = Math.sin(index / 3 * Math.PI) * 0.18;
  const rest: Vec3[] = [
    [side * 0.23, 0.57, z],
    [side * 0.34, 0.59, z + spread * 0.07],
    [side * 0.43, 0.66, z + spread * 0.14],
    [side * (0.84 + fan), 0.92, z + spread * 0.43],
    [side * (0.95 + fan), 0.82, z + spread * 0.50],
    [side * (1.10 + fan * 0.7), 0.37, z + spread * 0.75],
    [side * (1.19 + fan * 0.7), 0.115, z + spread * 0.91],
    [side * (1.29 + fan * 0.7), 0.033, z + spread],
  ];
  const widths = [0.115, 0.105, 0.11, 0.12, 0.077, 0.05, 0.034];
  const colors = ['#70658d', '#9180a7', '#827299', '#b3a0c5', '#70658d', '#4d4a6a', '#34364f'];
  const names = spiderSegments.map(segment => `${prefix}_${segment}`);
  const bones: BoneDef[] = [...names, `${prefix}_tip`].map((name, i) => ({
    name, parent: i === 0 ? 'root' : names[i - 1], position: i === 0 ? rest[0] : tuple(vector(rest[i]).sub(vector(rest[i - 1]))), rotation: [...identity], pose: [...identity],
  }));
  const parts: Part[] = [];
  for (let i = 0; i < names.length; i++) {
    const from = vector(rest[i]), to = vector(rest[i + 1]), direction = to.clone().sub(from);
    const binding = { type: 'rigid' as const, bone: names[i] };
    parts.push({ name: `${names[i]}_shell`, geometry: { type: 'capsule', size: [widths[i], direction.length(), widths[i]], segments: 8 }, position: tuple(from.clone().add(to).multiplyScalar(0.5)), rotation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()).toArray() as Quat, scale: [1, 1, 1], parent: null, color: colors[i], binding });
    const width = widths[i] * 1.12;
    parts.push({ name: `${names[i]}_joint`, geometry: { type: 'sphere', size: [width, width, width], segments: 8 }, position: rest[i], rotation: [...identity], scale: [1, 1, 1], parent: null, color: i === 3 ? '#d6bd83' : colors[i], binding });
  }
  parts.push({ name: `${prefix}_contact`, geometry: { type: 'sphere', size: [0.051, 0.062, 0.063], segments: 8 }, position: rest[7], rotation: [...identity], scale: [1, 1, 1], parent: null, color: '#34364f', binding: { type: 'rigid', bone: `${prefix}_tip` } });

  const contact = spiderContact(rest[0], rest[7]);
  function sample(phase: number, bob: number): Quat[] {
    const offset = spiderStep(phase, side, index);
    return solveSpiderPose(rest, spiderTarget(rest[0], contact, offset, bob));
  }
  return { bones, parts, names, contact, sample };
}
