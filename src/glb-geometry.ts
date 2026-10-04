import { Matrix4, Vector3 } from 'three';
import { readAccessor, sceneGraph, triangles, type GLTFDocument } from './gltf-read.ts';

export type Point = [number, number, number];

/**
 * Calls `visit` with the three world-space corners of every triangle that the default scene draws, once per
 * node instance. Node matrices (exported parts are `matrix` nodes) are applied; a skinned node's own
 * transform is ignored, as glTF specifies. Rest pose only: morph targets and animation are not applied.
 */
export function forEachWorldTriangle(doc: GLTFDocument, visit: (a: Point, b: Point, c: Point) => void): void {
  const { world } = sceneGraph(doc.json);
  const identity = new Matrix4(), v = new Vector3();
  const cache = new Map<number, { positions: Float64Array; order: Uint32Array }[]>();
  for (const [index, matrix] of world) {
    const node = doc.json.nodes![index];
    if (node.mesh === undefined) continue;
    let prepared = cache.get(node.mesh);
    if (!prepared) {
      prepared = [];
      for (const primitive of doc.json.meshes![node.mesh].primitives) {
        if (![4, 5, 6].includes(primitive.mode ?? 4)) continue;
        if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed geometry needs decoding');
        const positions = readAccessor(doc, primitive.attributes.POSITION);
        prepared.push({ positions: positions.data, order: triangles(doc, primitive, positions.count) });
      }
      cache.set(node.mesh, prepared);
    }
    const m = node.skin !== undefined ? identity : matrix;
    for (const { positions, order } of prepared) {
      const corner = (i: number): Point => { v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(m); return [v.x, v.y, v.z]; };
      for (let i = 0; i + 2 < order.length; i += 3) visit(corner(order[i]), corner(order[i + 1]), corner(order[i + 2]));
    }
  }
}
