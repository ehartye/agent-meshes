import { Quaternion, Vector3 } from 'three';
import type { Project, Quat } from '../core/types.ts';

/** Preserve the horse's material boundaries when the flesh is meshed as a smooth shell. */
export function refineEquineSkin(project: Project): void {
  const part = (name: string) => project.parts.find(p => p.name === name)!;
  // A narrower crest leaves a readable throat and jaw instead of a swollen neck/chest union.
  part('body').geometry.size = [0.76, 0.78, 1.78];
  part('chest').geometry.size = [0.64, 0.78, 0.64];
  part('haunches').geometry.size = [0.79, 0.77, 0.74];
  part('neck_base').geometry.size[0] = 0.44;
  part('neck_base').geometry.size[2] = 0.54;
  part('neck_crest').geometry.size[0] = 0.29;
  part('neck_crest').geometry.size[2] = 0.34;
  part('neck_crest').color = part('body').color;
  part('mane').geometry.size[0] = 0.09;
  part('mane').geometry.size[2] = 0.14;
  part('mane').position[2] += 0.04;
  // One tapered lock replaces the two blunt capsules. Local +Y points toward the dock.
  const tail = part('tail_hair');
  tail.geometry = { type: 'lathe', size: [0.22, 0.98, 0.18], segments: 20,
    profile: [[0, -0.5], [0.12, -0.46], [0.33, -0.28], [0.50, 0.08], [0.40, 0.4], [0.28, 0.5]] };
  tail.position = [0, 1.00, -1.24];
  tail.rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0.98, 0.15).normalize()).toArray() as Quat;
  project.parts = project.parts.filter(p => p.name !== 'tail_tip' && p.name !== 'forelock');
  for (const side of ['L', 'R']) {
    const ear = part(`ear_${side}`), inner = part(`ear_inner_${side}`);
    ear.geometry = { type: 'lathe', size: [0.15, 0.31, 0.10], segments: 16,
      profile: [[0, -0.5], [0.40, -0.35], [0.50, 0], [0.28, 0.35], [0, 0.5]] };
    ear.position[1] -= 0.03;
    inner.geometry = { ...ear.geometry, size: [0.07, 0.22, 0.025] };
    inner.position[1] = ear.position[1]; inner.position[2] = ear.position[2] + 0.05;
  }
  for (const hoof of project.parts.filter(p => p.name.endsWith('_foot'))) {
    hoof.geometry.profile = [[0, -0.5], [0.50, -0.5], [0.50, -0.15], [0.40, 0.4], [0.28, 0.5], [0, 0.5]];
  }
}
