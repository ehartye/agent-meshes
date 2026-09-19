import { Group, Mesh, SkinnedMesh, MeshStandardMaterial } from 'three';
import type { Object3D } from 'three';
import type { Project } from '../core/types.ts';
import { createSkeleton, applySkin, applyPose } from './skinning.ts';
import { geometryFor as partGeometry } from '../geometry.ts';
import { createClips } from './animation.ts';
export function buildScene(project: Project) {
  const root = new Group(); root.name = project.name;
  const { bones, skeleton } = createSkeleton(project, root);
  const objects = new Map<string, Object3D>();
  for (const part of project.parts) {
    const geometry = part.geometry.type === 'group' ? null : partGeometry(part);
    if (geometry && part.binding) applySkin(geometry, part.binding, [...bones.keys()]);
    const material = geometry ? new MeshStandardMaterial({ color: part.color, roughness: 0.65, metalness: 0.08, flatShading: true }) : null;
    const object = !geometry ? new Group() : part.binding ? new SkinnedMesh(geometry, material!) : new Mesh(geometry, material!);
    object.name = part.name;
    object.position.fromArray(part.position); object.quaternion.fromArray(part.rotation); object.scale.fromArray(part.scale);
    object.castShadow = true; object.receiveShadow = true;
    object.userData.part = part.name;
    objects.set(part.name, object);
  }
  for (const part of project.parts) (part.parent ? objects.get(part.parent)! : root).add(objects.get(part.name)!);
  root.updateMatrixWorld(true);
  for (const object of objects.values()) if (object instanceof SkinnedMesh) object.bind(skeleton, object.matrixWorld);
  applyPose(project, root, bones, skeleton);
  return { root, objects, bones, skeleton, clips: createClips(project, bones), dispose: () => { skeleton.dispose(); disposeScene(root); } };
}
export function disposeScene(root: Object3D): void {
  root.traverse(object => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material.dispose());
    }
  });
  root.removeFromParent();
}
