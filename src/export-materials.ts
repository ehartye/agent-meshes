import { Mesh } from 'three';
import type { Material, MeshPhysicalMaterial, MeshStandardMaterial, Object3D } from 'three';

/**
 * A key that is equal exactly when two authored materials would export as the same glTF material:
 * name, base colour, vertex-colour use, finish and the glass fields.
 */
export function materialKey(material: Material): string {
  const m = material as MeshStandardMaterial & Partial<MeshPhysicalMaterial>;
  return JSON.stringify([m.type, m.name, m.color?.getHexString(), m.vertexColors, m.metalness, m.roughness, m.transparent, m.opacity, m.transmission ?? 0, m.ior ?? 1.5, m.side, m.alphaTest]);
}

/**
 * Point every mesh at one shared material per distinct key, so ten parts with the same colour and finish export
 * one glTF material instead of ten. Returns the materials that became unused, for the caller to dispose.
 */
export function shareIdenticalMaterials(root: Object3D): Material[] {
  const canonical = new Map<string, Material>(), replaced = new Set<Material>();
  root.traverse(object => {
    if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
    const key = materialKey(object.material), first = canonical.get(key);
    if (!first) canonical.set(key, object.material);
    else if (first !== object.material) { replaced.add(object.material); object.material = first; }
  });
  return [...replaced];
}
