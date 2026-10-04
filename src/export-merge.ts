import { BufferAttribute, BufferGeometry, Mesh, SkinnedMesh } from 'three';
import type { Material, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Project } from './core/types.ts';
import { materialKey } from './export-materials.ts';

export type MergeMode = 'byMaterial';
export const mergeModes: readonly MergeMode[] = ['byMaterial'];

/** A merge keeps no bones, skins or clips, so it only applies to a model that has none of them in use. */
export function assertMergeable(project: Project): void {
  const problems: string[] = [];
  const bound = project.parts.filter(part => part.binding).map(part => part.name);
  if (bound.length) problems.push(`skinned parts (${bound.slice(0, 5).join(', ')}${bound.length > 5 ? ', ...' : ''})`);
  if (project.clips.length) problems.push(`${project.clips.length} animation clip${project.clips.length === 1 ? '' : 's'} (${project.clips.map(c => c.name).join(', ')})`);
  if (problems.length) throw Object.assign(new Error(`merge byMaterial needs a static model, but this one has ${problems.join(' and ')}. Remove the merge option or export the rigged model unmerged.`), { code: 'MERGE_NOT_STATIC' });
}

/**
 * Fuse every mesh under `root` into one mesh with one primitive per distinct material, in world space.
 * Part names are lost (one node), geometry, normals, UVs and vertex colours are kept. A material that
 * relies on vertex colours makes plain parts carry a white COLOR_0, which multiplies to no change.
 */
export function mergeByMaterial(root: Object3D, name: string): Mesh {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: Material; geometries: BufferGeometry[] }>();
  root.traverse(object => {
    if (!(object instanceof Mesh) || object instanceof SkinnedMesh || Array.isArray(object.material)) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    const key = materialKey(object.material), group = groups.get(key);
    if (group) group.geometries.push(geometry); else groups.set(key, { material: object.material, geometries: [geometry] });
  });
  if (!groups.size) throw Object.assign(new Error('merge byMaterial found no geometry to merge'), { code: 'MERGE_EMPTY' });
  const all = [...groups.values()].flatMap(group => group.geometries);
  const keep = ['position', 'normal', 'uv', 'color'].filter(attribute => all.some(g => g.getAttribute(attribute)));
  const complete = keep.filter(attribute => attribute === 'color' || all.every(g => g.getAttribute(attribute)));
  for (const geometry of all) {
    for (const attribute of Object.keys(geometry.attributes)) if (!complete.includes(attribute)) geometry.deleteAttribute(attribute);
    if (complete.includes('color') && !geometry.getAttribute('color')) {
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    }
  }
  const asIndexed = (geometry: BufferGeometry) => geometry.index ? geometry : geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i));
  const perMaterial = [...groups.values()].map(group => mergeGeometries(group.geometries.map(asIndexed))!);
  const merged = mergeGeometries(perMaterial, true);
  if (!merged) throw Object.assign(new Error('merge byMaterial could not combine the geometry'), { code: 'MERGE_FAILED' });
  for (const geometry of [...all, ...perMaterial]) geometry.dispose();
  const mesh = new Mesh(merged, [...groups.values()].map(group => group.material));
  mesh.name = name;
  return mesh;
}
