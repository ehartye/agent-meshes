import { Quaternion, Vector3 } from 'three';
import type { GeometryKind, Project, Quat, Vec3 } from '../core/types.ts';

const identity: Quat = [0, 0, 0, 1];
const rotation = (axis: Vec3, angle: number) => new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), angle).toArray() as Quat;

/** Body geometry shares the same root-space landmarks as the quadruped limb rig. */
export function addQuadrupedBody(project: Project, species: 'equine' | 'vulpine'): void {
  function bone(name: string, position: Vec3) {
    project.bones.push({ name, parent: 'root', position, rotation: [...identity], pose: [...identity] });
  }
  function part(name: string, shape: GeometryKind, size: Vec3, position: Vec3, color: string, joint = 'root', orient: Quat = identity) {
    project.parts.push({ name, geometry: { type: shape, size, segments: 10 }, position, rotation: [...orient], scale: [1, 1, 1], color, parent: null, binding: { type: 'rigid', bone: joint } });
  }
  function segment(name: string, from: Vec3, to: Vec3, width: number, color: string, joint: string, depth = width) {
    const direction = new Vector3(...to).sub(new Vector3(...from));
    const center = new Vector3(...from).add(new Vector3(...to)).multiplyScalar(0.5).toArray() as Vec3;
    part(name, 'capsule', [width, direction.length(), depth], center, color, joint, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()).toArray() as Quat);
  }
  if (species === 'vulpine') {
    const rust = '#c76f43', dark = '#463c40', cream = '#f1d6aa', gold = '#e5a45b';
    part('body', 'sphere', [0.83, 0.66, 1.38], [0, 1.04, -0.13], rust);
    part('chest_fur', 'sphere', [0.67, 0.76, 0.63], [0, 1.04, 0.40], cream);
    part('back_mantle', 'sphere', [0.69, 0.29, 1.15], [0, 1.27, -0.17], gold);
    bone('head', [0, 1.29, 0.58]);
    part('neck_ruff', 'sphere', [0.59, 0.56, 0.58], [0, 1.27, 0.61], rust, 'head');
    part('head_shape', 'sphere', [0.68, 0.56, 0.70], [0, 1.55, 0.86], rust, 'head');
    part('muzzle', 'sphere', [0.43, 0.30, 0.49], [0, 1.43, 1.15], cream, 'head');
    part('nose', 'sphere', [0.18, 0.14, 0.14], [0, 1.48, 1.40], dark, 'head');
    for (const side of [-1, 1]) {
      const s = side < 0 ? 'L' : 'R';
      part(`ear_${s}`, 'cone', [0.30, 0.57, 0.28], [side * 0.24, 1.94, 0.76], dark, 'head', rotation([0, 0, 1], -side * 0.18));
      part(`ear_inner_${s}`, 'cone', [0.16, 0.36, 0.06], [side * 0.25, 1.94, 0.895], gold, 'head', rotation([0, 0, 1], -side * 0.18));
      part(`cheek_${s}`, 'sphere', [0.29, 0.26, 0.37], [side * 0.26, 1.39, 0.91], cream, 'head');
      part(`eye_${s}`, 'sphere', [0.10, 0.12, 0.055], [side * 0.22, 1.63, 1.126], dark, 'head');
      part(`eye_glint_${s}`, 'sphere', [0.027, 0.03, 0.025], [side * 0.208, 1.653, 1.155], cream, 'head');
    }
    bone('tail', [0, 1.1, -0.69]);
    segment('tail_base', [0, 1.1, -0.69], [0, 1.40, -1.29], 0.35, rust, 'tail');
    segment('tail_plume', [0, 1.36, -1.15], [0, 1.62, -1.65], 0.44, rust, 'tail');
    segment('tail_tip', [0, 1.57, -1.52], [0, 1.76, -1.91], 0.3, cream, 'tail');
    return;
  }

  const chestnut = '#a56743', warm = '#c68c58', dark = '#3d3030', cream = '#ead9b2';
  part('body', 'sphere', [0.82, 0.85, 1.72], [0, 1.55, -0.10], chestnut);
  part('chest', 'sphere', [0.73, 0.86, 0.64], [0, 1.53, 0.55], chestnut);
  part('haunches', 'sphere', [0.87, 0.80, 0.70], [0, 1.58, -0.68], chestnut);
  part('back_highlight', 'sphere', [0.65, 0.20, 1.32], [0, 1.92, -0.15], warm);
  // The neck belongs to the trunk; a nod pivots the skull at the poll, not the shoulder.
  segment('neck_base', [0, 1.55, 0.52], [0, 2.20, 0.93], 0.58, chestnut, 'root', 0.68);
  segment('neck_crest', [0, 1.88, 0.64], [0, 2.39, 0.99], 0.35, warm, 'root', 0.44);
  segment('mane', [0, 1.89, 0.36], [0, 2.45, 0.86], 0.13, dark, 'root', 0.27);
  bone('head', [0, 2.34, 1.01]);
  part('head_shape', 'sphere', [0.38, 0.48, 0.43], [0, 2.36, 1.11], chestnut, 'head');
  segment('long_face', [0, 2.35, 1.18], [0, 2.00, 1.51], 0.33, chestnut, 'head', 0.37);
  part('muzzle', 'sphere', [0.39, 0.28, 0.35], [0, 1.99, 1.52], dark, 'head');
  part('nose', 'sphere', [0.25, 0.18, 0.075], [0, 2.03, 1.675], dark, 'head');
  segment('blaze', [0, 2.44, 1.25], [0, 2.12, 1.52], 0.085, cream, 'head', 0.025);
  part('forelock', 'cone', [0.21, 0.33, 0.20], [0, 2.48, 1.17], dark, 'head', rotation([1, 0, 0], Math.PI));
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'L' : 'R';
    part(`ear_${s}`, 'cone', [0.15, 0.39, 0.17], [side * 0.15, 2.65, 0.99], chestnut, 'head', rotation([0, 0, 1], -side * 0.15));
    part(`ear_inner_${s}`, 'cone', [0.08, 0.25, 0.035], [side * 0.15, 2.65, 1.075], cream, 'head', rotation([0, 0, 1], -side * 0.15));
    part(`eye_${s}`, 'sphere', [0.047, 0.09, 0.11], [side * 0.187, 2.39, 1.22], dark, 'head');
    part(`eye_glint_${s}`, 'sphere', [0.016, 0.024, 0.025], [side * 0.210, 2.415, 1.245], cream, 'head');
    part(`nostril_${s}`, 'sphere', [0.025, 0.077, 0.10], [side * 0.186, 2.04, 1.58], '#221f24', 'head');
  }
  bone('tail', [0, 1.78, -0.98]);
  segment('tail_base', [0, 1.78, -0.98], [0, 1.46, -1.17], 0.17, chestnut, 'tail');
  segment('tail_hair', [0, 1.48, -1.15], [0, 0.79, -1.30], 0.24, dark, 'tail', 0.29);
  segment('tail_tip', [0, 0.86, -1.28], [0, 0.42, -1.33], 0.17, dark, 'tail', 0.22);
}
