import { createHash } from 'node:crypto';
import { boundsOf, type Vec3 } from './glb-limits.ts';
import { readGLB, sceneGraph } from './gltf-read.ts';
import { silhouette } from './silhouette.ts';

export interface GLBStats {
  sha256: string; triangles: number; materials: number; meshes: number;
  bounds: { min: Vec3; max: Vec3; size: Vec3 }; baseCenter: Vec3;
  /** Hash of the y silhouette (64 bins, rounded to 0.5 mm): equal profiles hash equal, any visible change to the turned outline changes it. */
  profileHash: string;
}
export interface StatsDifference { field: string; a: unknown; b: unknown }

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const roundVec = (v: Vec3): Vec3 => v.map(round) as Vec3;

/** Mechanical fingerprint of an exported GLB, for proving that a revert or refactor left the geometry unchanged. */
export function glbStats(bytes: Uint8Array): GLBStats {
  const doc = readGLB(bytes), bounds = boundsOf(doc);
  const drawn = new Set<number>(), materials = new Set<number | string>();
  for (const index of sceneGraph(doc.json).world.keys()) { const mesh = doc.json.nodes![index].mesh; if (mesh !== undefined) drawn.add(mesh); }
  for (const mesh of drawn) for (const primitive of doc.json.meshes![mesh].primitives) materials.add(primitive.material ?? 'default');
  const profile = silhouette(bytes, { axis: 'y', bins: 64 }).bins.map(bin => bin.radius === null ? null : Math.round(bin.radius * 2000));
  return { sha256: createHash('sha256').update(bytes).digest('hex'), triangles: bounds.triangles, materials: materials.size, meshes: drawn.size,
    bounds: { min: roundVec(bounds.min), max: roundVec(bounds.max), size: roundVec(bounds.size) }, baseCenter: roundVec(bounds.baseCenter),
    profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 16) };
}

/** Fields that differ between two fingerprints. The byte hash is compared only on request: equal geometry can serialise differently. */
export function diffStats(a: GLBStats, b: GLBStats, options: { bytes?: boolean } = {}): StatsDifference[] {
  const fields: [string, unknown, unknown][] = [['triangles', a.triangles, b.triangles], ['materials', a.materials, b.materials], ['meshes', a.meshes, b.meshes],
    ['bounds', a.bounds, b.bounds], ['baseCenter', a.baseCenter, b.baseCenter], ['profileHash', a.profileHash, b.profileHash],
    ...(options.bytes ? [['sha256', a.sha256, b.sha256] as [string, unknown, unknown]] : [])];
  return fields.filter(([, x, y]) => JSON.stringify(x) !== JSON.stringify(y)).map(([field, x, y]) => ({ field, a: x, b: y }));
}
