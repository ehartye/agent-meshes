import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * A small, dependency-free reader for self-contained GLB files: JSON, binary chunk,
 * accessors (strided, normalized and sparse) and node world matrices. It exists so
 * verifiers can inspect morph targets and skins exactly as stored, without a renderer.
 */
export interface GLTFJson {
  scene?: number; scenes?: { nodes?: number[]; extras?: unknown }[];
  nodes?: GLTFNode[]; meshes?: GLTFMesh[]; skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  materials?: GLTFMaterial[]; accessors?: GLTFAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}
export interface GLTFMaterial {
  name?: string; alphaMode?: string; alphaCutoff?: number; doubleSided?: boolean;
  pbrMetallicRoughness?: { baseColorFactor?: number[] } & Record<string, unknown>; extensions?: Record<string, unknown>;
}
export interface GLTFNode { name?: string; children?: number[]; mesh?: number; skin?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; weights?: number[]; extras?: unknown }
export interface GLTFPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: Record<string, number>[] }
export interface GLTFMesh { name?: string; primitives: GLTFPrimitive[]; weights?: number[]; extras?: { targetNames?: unknown } & Record<string, unknown> }
interface GLTFAccessor {
  bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string;
  sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } };
}

export interface GLTFDocument { json: GLTFJson; bin?: Uint8Array }
export interface AccessorData { data: Float64Array; size: number; count: number }

const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function readGLB(bytes: Uint8Array): GLTFDocument {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Not a glTF 2.0 GLB file');
  let offset = 12, json: GLTFJson | undefined, bin: Uint8Array | undefined;
  const end = Math.min(view.getUint32(8, true), bytes.byteLength);
  while (offset + 8 <= end) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GLTFJson;
    else if (type === 0x004e4942 && !bin) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function read(doc: GLTFDocument, viewIndex: number, byteOffset: number, componentType: number, normalized: boolean, size: number, count: number, out: Float64Array): void {
  const bufferView = doc.json.bufferViews?.[viewIndex];
  if (!bufferView) throw new Error(`Missing bufferView ${viewIndex}`);
  if (bufferView.buffer !== 0 || !doc.bin || doc.json.buffers?.[0]?.uri !== undefined) throw new Error('Only self-contained GLB buffers are supported');
  const component = BYTES[componentType];
  if (!component) throw new Error(`Unsupported component type ${componentType}`);
  const stride = bufferView.byteStride ?? component * size;
  const data = new DataView(doc.bin.buffer, doc.bin.byteOffset + (bufferView.byteOffset ?? 0), bufferView.byteLength);
  for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) {
    const at = byteOffset + i * stride + k * component;
    let value: number;
    switch (componentType) {
      case 5120: value = data.getInt8(at); if (normalized) value = Math.max(value / 127, -1); break;
      case 5121: value = data.getUint8(at); if (normalized) value /= 255; break;
      case 5122: value = data.getInt16(at, true); if (normalized) value = Math.max(value / 32767, -1); break;
      case 5123: value = data.getUint16(at, true); if (normalized) value /= 65535; break;
      case 5125: value = data.getUint32(at, true); break;
      default: value = data.getFloat32(at, true);
    }
    out[i * size + k] = value;
  }
}

export function readAccessor(doc: GLTFDocument, index: number): AccessorData {
  const accessor = doc.json.accessors?.[index];
  if (!accessor) throw new Error(`Missing accessor ${index}`);
  const size = SIZES[accessor.type];
  if (!size) throw new Error(`Unsupported accessor type ${accessor.type}`);
  const data = new Float64Array(accessor.count * size);
  if (accessor.bufferView !== undefined) read(doc, accessor.bufferView, accessor.byteOffset ?? 0, accessor.componentType, accessor.normalized ?? false, size, accessor.count, data);
  if (accessor.sparse) {
    const { count, indices, values } = accessor.sparse;
    const where = new Float64Array(count), replacement = new Float64Array(count * size);
    read(doc, indices.bufferView, indices.byteOffset ?? 0, indices.componentType, false, 1, count, where);
    read(doc, values.bufferView, values.byteOffset ?? 0, accessor.componentType, accessor.normalized ?? false, size, count, replacement);
    for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) data[where[i] * size + k] = replacement[i * size + k];
  }
  return { data, size, count: accessor.count };
}

export function localMatrix(node: GLTFNode): Matrix4 {
  if (node.matrix) return new Matrix4().fromArray(node.matrix);
  const t = node.translation ?? [0, 0, 0], r = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
  return new Matrix4().compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]), new Vector3(s[0], s[1], s[2]));
}

/** World matrices and parents for every node reachable from the default scene (or every scene). */
export function sceneGraph(json: GLTFJson): { world: Map<number, Matrix4>; parent: Map<number, number>; roots: number[] } {
  const nodes = json.nodes ?? [], world = new Map<number, Matrix4>(), parent = new Map<number, number>();
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? [];
  const visit = (index: number, parentWorld: Matrix4) => {
    if (world.has(index)) return;
    const matrix = parentWorld.clone().multiply(localMatrix(nodes[index] ?? {}));
    world.set(index, matrix);
    for (const child of nodes[index]?.children ?? []) { parent.set(child, index); visit(child, matrix); }
  };
  for (const root of roots) visit(root, new Matrix4());
  return { world, parent, roots };
}

/** Triangle vertex indices for TRIANGLES, TRIANGLE_STRIP and TRIANGLE_FAN primitives; other modes have none. */
export function triangles(doc: GLTFDocument, primitive: GLTFPrimitive, vertexCount: number): Uint32Array {
  const order = primitive.indices === undefined ? Array.from({ length: vertexCount }, (_, i) => i) : Array.from(readAccessor(doc, primitive.indices).data);
  const mode = primitive.mode ?? 4, result: number[] = [];
  if (mode === 4) for (let i = 0; i + 2 < order.length; i += 3) result.push(order[i], order[i + 1], order[i + 2]);
  else if (mode === 5) for (let i = 0; i + 2 < order.length; i++) result.push(...(i % 2 ? [order[i + 1], order[i], order[i + 2]] : [order[i], order[i + 1], order[i + 2]]));
  else if (mode === 6) for (let i = 1; i + 1 < order.length; i++) result.push(order[0], order[i], order[i + 1]);
  return Uint32Array.from(result);
}
