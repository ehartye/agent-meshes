import { DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import type { Material as ThreeMaterial, Object3D } from 'three';
import { Mesh } from 'three';
import type { Material } from '../core/types.ts';

/** Whether an authored finish is glass: see-through by opacity (alphaMode BLEND) or by transmission. */
export function isGlassFinish(finish: Material | undefined): boolean {
  return !!finish && ((finish.opacity ?? 1) < 1 || (finish.transmission ?? 0) > 0);
}

/**
 * A three.js material for an authored finish. Transmission or ior need MeshPhysicalMaterial; opacity below 1 is
 * transparent without depth writes (what three's GLTFLoader makes of alphaMode BLEND), so surfaces behind it still draw.
 */
export function finishMaterial(color: string, vertexColors: boolean, finish: Material): MeshStandardMaterial {
  const { opacity = 1, transmission, ior, doubleSided, metalness, roughness } = finish;
  const base = { color, vertexColors, metalness, roughness, ...(doubleSided ? { side: DoubleSide } : {}) };
  const material = transmission !== undefined || ior !== undefined
    ? new MeshPhysicalMaterial({ ...base, transmission: transmission ?? 0, ior: ior ?? 1.5 })
    : new MeshStandardMaterial(base);
  if (opacity < 1) { material.transparent = true; material.opacity = opacity; material.depthWrite = false; }
  return material;
}

/** Whether a rendered (for example GLTFLoader-made) material is glass: blended below full opacity, or transmissive. */
export function isGlassMaterial(material: ThreeMaterial): boolean {
  return (material.transparent && material.opacity < 1) || ((material as MeshPhysicalMaterial).transmission ?? 0) > 0;
}

/** Whether any material slot of this object is glass. */
export function isGlassObject(object: Object3D): boolean {
  if (!(object instanceof Mesh)) return false;
  return (Array.isArray(object.material) ? object.material : [object.material]).some(isGlassMaterial);
}

/**
 * Ready loaded glass for display: it receives shadows but casts none (a solid shadow over the face behind a visor
 * would hide it), and is tagged `userData.glass`. Call after any traversal that turns shadows on. Returns the glass names.
 */
export function prepareGlass(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse(object => {
    if (!isGlassObject(object)) return;
    object.castShadow = false; object.userData.glass = true; names.push(object.name);
  });
  return names;
}
