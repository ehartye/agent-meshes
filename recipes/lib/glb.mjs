// Dependency-free GLB reader shared by the set recipes (set-stats.mjs, set-sheet.mjs).
// It answers the questions accessor min/max cannot: a part exported as a `matrix` node, or rotated, has accessor bounds
// in its own space, so world bounds, pivots and silhouettes must apply every node transform to every vertex.
import { readFileSync } from 'node:fs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 product a*b (glTF order). */
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** A node's local matrix: its `matrix`, or translation * rotation(quaternion) * scale. */
export function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0], [x, y, z, w] = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** Split a GLB into `{ json, bin }`. Throws on anything that is not a single-BIN GLB 2.0 with plain float positions. */
export function parseGLB(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  let offset = 12, json = null, bin = Buffer.alloc(0);
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942 && bin.length === 0) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  const compressed = (json.extensionsUsed || []).filter(name => /draco|meshopt|quantization/i.test(name));
  if (compressed.length) throw new Error(`compressed or quantized geometry is not supported by this reader: ${compressed.join(', ')}`);
  return { json, bin };
}

function readVec3(json, bin, accessorIndex) {
  const a = json.accessors[accessorIndex];
  if (a.componentType !== 5126 || a.type !== 'VEC3') throw new Error('POSITION must be float VEC3');
  if (a.bufferView === undefined) return new Float32Array(a.count * 3);
  const view = json.bufferViews[a.bufferView], base = (view.byteOffset || 0) + (a.byteOffset || 0), stride = view.byteStride || 12;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = bin.readFloatLE(base + i * stride + k * 4);
  return out;
}

/**
 * Walk the default scene and call `visit({ node, mesh, primitive, matrix, positions })` for every mesh primitive.
 * `positions` are in the primitive's own space; `matrix` is its node-to-world transform.
 */
export function walkPrimitives(glb, visit) {
  const { json, bin } = glb;
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const go = (index, parent) => {
    const node = json.nodes[index], matrix = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) visit({ node, mesh: json.meshes[node.mesh], primitive, matrix, positions: readVec3(json, bin, primitive.attributes.POSITION) });
    }
    (node.children || []).forEach(child => go(child, matrix));
  };
  roots.forEach(root => go(root, IDENTITY));
}

export function toWorld(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Real triangles of a primitive, by draw mode. Points and lines draw none. */
export function primitiveTriangles(json, primitive) {
  const count = primitive.indices !== undefined ? json.accessors[primitive.indices].count : json.accessors[primitive.attributes.POSITION].count;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

/**
 * Everything a set check needs from one GLB, with node matrices applied to every vertex.
 * `base.centre` is the [x, z] centre of the vertices within `baseBand` (1 mm) of the lowest point: the pivot test for a
 * piece that must stand on y = 0 with its origin under the middle of its base.
 */
export function inspectGLB(file, { baseBand = 0.001 } = {}) {
  const glb = parseGLB(readFileSync(file)), { json } = glb;
  let triangles = 0, vertices = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const world = [], attributes = new Set();
  walkPrimitives(glb, ({ primitive, matrix, positions }) => {
    triangles += primitiveTriangles(json, primitive);
    vertices += positions.length / 3;
    Object.keys(primitive.attributes).forEach(name => attributes.add(name));
    for (let i = 0; i < positions.length; i += 3) {
      const p = toWorld(matrix, positions[i], positions[i + 1], positions[i + 2]);
      for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
      world.push(p);
    }
  });
  if (!world.length) throw new Error(`${file}: no mesh geometry in the default scene`);
  const low = world.filter(p => p[1] <= min[1] + baseBand);
  const range = k => low.reduce((r, p) => [Math.min(r[0], p[k]), Math.max(r[1], p[k])], [Infinity, -Infinity]), rx = range(0), rz = range(2);
  const used = new Set();
  for (const mesh of json.meshes || []) for (const p of mesh.primitives) if (p.material !== undefined) used.add(p.material);
  const nodes = json.nodes || [];
  return {
    file, triangles, vertices, min, max, size: max.map((v, k) => v - min[k]),
    base: { centre: [(rx[0] + rx[1]) / 2, (rz[0] + rz[1]) / 2], vertices: low.length },
    materials: (json.materials || []).map((m, index) => ({ index, name: m.name ?? null, used: used.has(index) })),
    nodes: { total: nodes.length, matrix: nodes.filter(n => n.matrix).length, meshes: nodes.filter(n => n.mesh !== undefined).length },
    attributes: [...attributes].sort(),
  };
}
