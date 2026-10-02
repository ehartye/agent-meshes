/** Two triangles with a UV seam: four positions, six exported render records. */
export function budgetFixture(options: { primitives?: number[][]; mode?: number; unused?: boolean; instances?: number; compression?: 'draco' | 'meshopt' } = {}): Uint8Array {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  if (options.unused) positions.push(9, 9, 9);
  const chunks: Uint8Array[] = [];
  const bufferViews: object[] = [], accessors: object[] = [];
  let offset = 0;
  const add = (data: Uint8Array, type: string, componentType: number, count: number, bounds?: object) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    chunks.push(data); offset += data.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count, type, ...bounds });
    return accessors.length - 1;
  };
  const position = add(new Uint8Array(new Float32Array(positions).buffer), 'VEC3', 5126, positions.length / 3,
    { min: [0, 0, 0], max: options.unused ? [9, 9, 9] : [1, 1, 0] });
  const normals = Array.from({ length: positions.length / 3 }, () => [0, 0, 1]).flat();
  const normal = add(new Uint8Array(new Float32Array(normals).buffer), 'VEC3', 5126, normals.length / 3);
  const uvs = [0, 0, 1, 0, 1, 1, 0.5, 0, 0.5, 1, 0, 1];
  if (options.unused) uvs.push(0, 0);
  const uv = add(new Uint8Array(new Float32Array(uvs).buffer), 'VEC2', 5126, uvs.length / 2);
  const primitives = (options.primitives ?? [[0, 1, 2, 3, 4, 5]]).map(indices => ({
    attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, mode: options.mode ?? 4,
    indices: add(new Uint8Array(new Uint32Array(indices).buffer), 'SCALAR', 5125, indices.length),
    ...(options.compression === 'draco' ? { extensions: { KHR_draco_mesh_compression: {} } } : {}),
  }));
  const nodes = Array.from({ length: options.instances ?? 1 }, (_, i) => ({ mesh: 0, name: `instance-${i}` }));
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    ...(options.compression === 'meshopt' ? { extensionsRequired: ['EXT_meshopt_compression'] } : {}),
    nodes, meshes: [{ name: 'seamed', primitives }], accessors, bufferViews, buffers: [{ byteLength: offset }] };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = (jsonBytes.length + 3) & ~3;
  const bytes = new Uint8Array(20 + padded + 8 + offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + padded); bytes.set(jsonBytes, 20);
  view.setUint32(20 + padded, offset, true); view.setUint32(24 + padded, 0x004e4942, true);
  let at = 28 + padded;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}
