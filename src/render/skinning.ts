import { Bone, Skeleton, SkinnedMesh, Uint16BufferAttribute, Float32BufferAttribute, Quaternion } from 'three';
import type { BufferGeometry, Group } from 'three';
import type { Binding, Project } from '../core/types.ts';
import { validateWeightCount } from '../core/rig.ts';

export function createSkeleton(project: Project, root: Group) {
  const bones = new Map<string, Bone>();
  for (const def of project.bones ?? []) {
    const bone = new Bone(); bone.name = def.name;
    bone.position.fromArray(def.position); bone.quaternion.fromArray(def.rotation);
    bones.set(def.name, bone);
  }
  for (const def of project.bones ?? []) (def.parent ? bones.get(def.parent)! : root).add(bones.get(def.name)!);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton([...bones.values()]);
  return { bones, skeleton };
}
export function applySkin(geometry: BufferGeometry, binding: Binding, boneNames: string[]) {
  const positions = geometry.getAttribute('position');
  const indices: number[] = [], weights: number[] = [];
  if (binding.type === 'weights') validateWeightCount(binding, positions.count);
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let names: string[], values: number[];
    if (binding.type === 'rigid') { names = [binding.bone]; values = [1]; }
    else if (binding.type === 'linear') {
      const coordinate = binding.axis === 'x' ? positions.getX(vertex) : binding.axis === 'y' ? positions.getY(vertex) : positions.getZ(vertex);
      const fraction = Math.max(0, Math.min(1, (coordinate - binding.range[0]) / (binding.range[1] - binding.range[0])));
      names = binding.bones; values = [1 - fraction, fraction];
    } else { names = binding.bones; values = binding.weights[vertex]; }
    for (let influence = 0; influence < 4; influence++) {
      const boneIndex = influence < names.length ? boneNames.indexOf(names[influence]) : 0;
      if (boneIndex < 0) throw new Error(`Unknown skin bone: ${names[influence]}`);
      indices.push(boneIndex); weights.push(values[influence] ?? 0);
    }
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
}
export function applyPose(project: Project, root: Group, bones: Map<string, Bone>, skeleton: Skeleton) {
  for (const def of project.bones ?? []) bones.get(def.name)!.quaternion.fromArray(def.rotation).multiply(new Quaternion().fromArray(def.pose));
  root.updateMatrixWorld(true); skeleton.update();
  root.traverse(object => { if (object instanceof SkinnedMesh) { object.computeBoundingBox(); object.computeBoundingSphere(); } });
}
