import { Color, Group, Mesh, SkinnedMesh, MeshStandardMaterial } from 'three';
import type { Object3D } from 'three';
import type { Material, Project } from '../core/types.ts';
import { createSkeleton, applySkin, applyPose } from './skinning.ts';
import { geometryFor as partGeometry } from '../geometry.ts';
import { createClips } from './animation.ts';
import { buildShellGeometry } from './shell.ts';
import { bakePattern, uniformBase } from './pattern.ts';
/** The finish every part and shell had before materials were authorable, so older models render unchanged. */
const defaultFinish: Material = { metalness: 0.08, roughness: 0.65 };
export function buildScene(project: Project) {
  const root = new Group(); root.name = project.name;
  const { bones, skeleton } = createSkeleton(project, root);
  const objects = new Map<string, Object3D>();
  const shells = project.shells ?? [];
  const shelled = new Set(shells.flatMap(shell => [...shell.parts, ...(shell.cut ?? [])]));
  for (const part of project.parts) {
    // Shell members stay in the hierarchy as empty groups so children and transforms still resolve.
    const geometry = part.geometry.type === 'group' || shelled.has(part.name) ? null : partGeometry(part);
    if (geometry && part.binding) applySkin(geometry, part.binding, [...bones.keys()]);
    // A patterned part carries its color in the vertices, like a shell; the base color_1 attribute lets the viewer re-bake.
    if (geometry && part.pattern) geometry.setAttribute('color_1', uniformBase(geometry.getAttribute('position').count, new Color(part.color)));
    // Use the same geometry normals glTF exports, so curved surfaces preview faithfully.
    const material = geometry ? new MeshStandardMaterial({ color: part.pattern ? '#ffffff' : part.color, vertexColors: !!part.pattern, ...(part.material ?? defaultFinish) }) : null;
    const object = !geometry ? new Group() : part.binding ? new SkinnedMesh(geometry, material!) : new Mesh(geometry, material!);
    object.name = part.name;
    object.position.fromArray(part.position); object.quaternion.fromArray(part.rotation); object.scale.fromArray(part.scale);
    object.castShadow = true; object.receiveShadow = true;
    object.userData.part = part.name; if (part.pattern) object.userData.pattern = structuredClone(part.pattern);
    objects.set(part.name, object);
  }
  for (const part of project.parts) (part.parent ? objects.get(part.parent)! : root).add(objects.get(part.name)!);
  root.updateMatrixWorld(true);
  for (const part of project.parts) if (part.pattern && objects.get(part.name) instanceof Mesh) { const mesh = objects.get(part.name) as Mesh; bakePattern(mesh.geometry, part.pattern, mesh.matrixWorld); }
  for (const object of objects.values()) if (object instanceof SkinnedMesh) object.bind(skeleton, object.matrixWorld);
  for (const shell of shells) {
    const built = buildShellGeometry(project, shell, [...bones.keys()]);
    const material = new MeshStandardMaterial({ color: '#ffffff', vertexColors: true, ...(shell.material ?? defaultFinish) });
    const object = built.geometry.getAttribute('skinIndex') ? new SkinnedMesh(built.geometry, material) : new Mesh(built.geometry, material);
    object.name = shell.name; object.castShadow = true; object.receiveShadow = true; object.userData.shell = shell.name;
    if (shell.pattern) object.userData.pattern = structuredClone(shell.pattern);
    root.add(object); root.updateMatrixWorld(true);
    if (object instanceof SkinnedMesh) object.bind(skeleton, object.matrixWorld);
    objects.set(shell.name, object);
  }
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
