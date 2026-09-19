import { BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import type { Part, Project } from '../core/types.ts';

export function partGeometry(part: Part): BufferGeometry {
  const { type, size: [x, y, z], segments } = part.geometry;
  let geometry: BufferGeometry;
  switch (type) {
    case 'sphere': geometry = new SphereGeometry(0.5, segments, Math.max(4, Math.floor(segments / 2))); break;
    case 'cylinder': geometry = new CylinderGeometry(0.5, 0.5, 1, segments, 8); break;
    case 'cone': geometry = new ConeGeometry(0.5, 1, segments, 8); break;
    case 'capsule': geometry = new CapsuleGeometry(0.25, 0.5, 4, segments); geometry.scale(2, 1, 2); break;
    default: geometry = new BoxGeometry(1, 1, 1, 1, 8, 1);
  }
  geometry.scale(x, y, z);
  return geometry;
}
export function buildScene(project: Project) {
  const root = new Group(); root.name = project.name;
  const objects = new Map<string, Object3D>();
  for (const part of project.parts) {
    const object = part.geometry.type === 'group' ? new Group() : new Mesh(partGeometry(part), new MeshStandardMaterial({ color: part.color, roughness: 0.65, metalness: 0.08, flatShading: true }));
    object.name = part.name;
    object.position.fromArray(part.position); object.quaternion.fromArray(part.rotation); object.scale.fromArray(part.scale);
    object.castShadow = true; object.receiveShadow = true;
    object.userData.part = part.name;
    objects.set(part.name, object);
  }
  for (const part of project.parts) (part.parent ? objects.get(part.parent)! : root).add(objects.get(part.name)!);
  root.updateMatrixWorld(true);
  return { root, objects, dispose: () => disposeScene(root) };
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
