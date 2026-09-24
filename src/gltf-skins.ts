import { readGltfJson, type GltfJson } from './gltf-morphs.ts';

/**
 * Skin audit over a GLB's (or .gltf's) JSON, with no engine needed: which skins exist,
 * which joints they name and how those joints are parented, which mesh nodes are bound to
 * them, and how many vertices each mesh node renders once welded.
 *
 * Unreal's Interchange builds one SkeletalMesh and one Skeleton per glTF skin. A mesh node
 * with morph targets but no `skin` still becomes a SkeletalMesh (morphs need one), on a
 * made-up one-bone skeleton named after the node; an unskinned mesh without morphs becomes
 * a StaticMesh, unless the file also has a skinned mesh, in which case the default pipeline
 * drops it (see `interchangeDroppedMeshNodes` in unreal.ts). `verify-unreal` uses this audit
 * to explain why no SkeletalMesh carries both the morphs and the bones a contract needs, why
 * geometry went missing, and where a contract's bone hierarchy went wrong.
 */

export interface GltfSkinFacts {
  skin: number; name?: string; joints: string[]; usedBy: string[];
  /** Each joint's parent node name (a joint or not), or null at the scene root. */
  jointParents: Record<string, string | null>;
  /** Joints whose parent is not a joint of this skin, in joint order. A well-formed rig has one. */
  roots: string[];
}
export interface GltfMeshNode {
  node: number; name?: string; mesh: number; meshName?: string; skin: number | null; morphTargets: number;
  /**
   * Vertices the node's triangle primitives use, welded as Unreal's mesh build welds them:
   * the geometry an importer should keep. Null when the vertex data could not be read.
   */
  vertices: number | null;
  /** The nearest ancestor node that is a joint of any skin, or null. */
  jointAncestor: string | null;
}
export interface SkinAudit {
  skins: GltfSkinFacts[]; meshNodes: GltfMeshNode[];
  /** Sum of `vertices` over every mesh node, or null when any node's data could not be read. */
  vertices: number | null;
}

interface Node { name?: string; mesh?: number; skin?: number; children?: number[] }
interface Skin { name?: string; joints?: number[] }
interface Accessor { bufferView?: number; byteOffset?: number; componentType?: number; count?: number; type?: string; normalized?: boolean; sparse?: unknown }
interface BufferView { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }
interface Primitive { attributes?: Record<string, number>; indices?: number; mode?: number; extensions?: Record<string, unknown> }

const nodeLabel = (nodes: Node[], index: number) => nodes[index]?.name ?? `node ${index}`;
/** glTF primitive modes 4, 5 and 6 are triangles; points and lines render no surface. */
const TRIANGLE_MODES = new Set([4, 5, 6]);
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/**
 * Welding quanta: Unreal's mesh build merges vertices whose position, normal and UV agree
 * within small thresholds. Measured on UE 5.7.3: a sphere whose pole and seam vertices
 * repeat (185 used) imported as 146 vertices, exactly the count of distinct
 * (position to 0.1 mm, normal to 0.01, UV to 1/1024) keys; Blender heads, which never repeat
 * a vertex, imported every one. Coarse quanta only lower the expected count, so a
 * welding-heavy mesh never fails for vertices Unreal legitimately merged.
 */
const WELD = { position: 1e-4, normal: 1e-2, uv: 1 / 1024 };

/** Read an accessor's rows as numbers (normalized integers scaled to 0..1 or -1..1), or null when the data is not in `bin`. */
function readAccessor(json: GltfJson, index: number | undefined, bin: Uint8Array | null): number[][] | null {
  const accessor = ((json.accessors ?? []) as Accessor[])[index ?? -1];
  if (!accessor || !bin || accessor.sparse || typeof accessor.bufferView !== 'number') return null;
  const view = ((json.bufferViews ?? []) as BufferView[])[accessor.bufferView];
  const n = COMPONENTS[accessor.type ?? ''], size = BYTES[accessor.componentType ?? 0], count = accessor.count ?? 0;
  if (!view || (view.buffer ?? 0) !== 0 || !n || !size) return null;
  const stride = view.byteStride ?? n * size, start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (count && start + (count - 1) * stride + n * size > bin.byteLength) return null;
  const data = new DataView(bin.buffer, bin.byteOffset + start);
  const type = accessor.componentType!;
  const scale = !accessor.normalized ? 1 : ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[type] ?? 1;
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) {
      const at = i * stride + c * size;
      const v = type === 5126 ? data.getFloat32(at, true) : type === 5125 ? data.getUint32(at, true) : type === 5123 ? data.getUint16(at, true)
        : type === 5122 ? data.getInt16(at, true) : type === 5121 ? data.getUint8(at) : data.getInt8(at);
      row.push(scale === 1 ? v : Math.max(v / scale, -1));
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The vertices a primitive's triangles use, welded the way Unreal's mesh build welds them
 * (see WELD). 0 for points and lines; null when the vertex data cannot be read (a .gltf with
 * external buffers, sparse or Draco-compressed accessors).
 */
function primitiveVertices(json: GltfJson, primitive: Primitive, bin: Uint8Array | null): number | null {
  if (!TRIANGLE_MODES.has(primitive.mode ?? 4)) return 0;
  if (primitive.extensions?.KHR_draco_mesh_compression) return null;
  const attributes = primitive.attributes ?? {};
  const positions = readAccessor(json, attributes.POSITION, bin);
  if (!positions) return null;
  const normals = attributes.NORMAL === undefined ? null : readAccessor(json, attributes.NORMAL, bin);
  const uvs = attributes.TEXCOORD_0 === undefined ? null : readAccessor(json, attributes.TEXCOORD_0, bin);
  if ((attributes.NORMAL !== undefined && !normals) || (attributes.TEXCOORD_0 !== undefined && !uvs)) return null;
  let used: Iterable<number>;
  if (typeof primitive.indices === 'number') {
    const indices = readAccessor(json, primitive.indices, bin);
    if (!indices) return null;
    used = new Set(indices.map(row => row[0]).filter(i => i < positions.length));
  } else used = positions.keys();
  const key = (row: number[] | undefined, quantum: number) => (row ?? []).map(v => Math.round(v / quantum)).join(',');
  const welded = new Set<string>();
  for (const i of used) welded.add(`${key(positions[i], WELD.position)}|${key(normals?.[i], WELD.normal)}|${key(uvs?.[i], WELD.uv)}`);
  return welded.size;
}

/** Audit skins and mesh nodes in parsed glTF JSON; `bin` is the GLB's binary chunk, when there is one. */
export function skinAudit(json: GltfJson, bin: Uint8Array | null = null): SkinAudit {
  const nodes = (Array.isArray(json.nodes) ? json.nodes : []) as Node[];
  const skins = (Array.isArray(json.skins) ? json.skins : []) as Skin[];
  const parent = new Map<number, number>();
  nodes.forEach((node, index) => { for (const child of node?.children ?? []) if (!parent.has(child)) parent.set(child, index); });
  const jointNodes = new Set(skins.flatMap(skin => skin?.joints ?? []));
  const jointAbove = (index: number) => {
    const seen = new Set<number>();
    for (let at = parent.get(index); at !== undefined && !seen.has(at); at = parent.get(at)) { seen.add(at); if (jointNodes.has(at)) return nodeLabel(nodes, at); }
    return null;
  };
  const meshNodes: GltfMeshNode[] = [];
  nodes.forEach((node, index) => {
    if (typeof node?.mesh !== 'number') return;
    const mesh = json.meshes?.[node.mesh];
    const primitives = (mesh?.primitives ?? []) as Primitive[];
    meshNodes.push({
      node: index, ...(node.name ? { name: node.name } : {}), mesh: node.mesh, ...(mesh?.name ? { meshName: mesh.name } : {}),
      skin: typeof node.skin === 'number' ? node.skin : null,
      morphTargets: Math.max(0, ...(mesh?.primitives ?? []).map(p => Array.isArray(p.targets) ? p.targets.length : 0)),
      vertices: primitives.reduce<number | null>((sum, p) => { const v = primitiveVertices(json, p, bin); return sum === null || v === null ? null : sum + v; }, 0),
      jointAncestor: jointAbove(index),
    });
  });
  return {
    skins: skins.map((skin, index) => {
      const joints = skin?.joints ?? [];
      const jointParents: Record<string, string | null> = {};
      for (const j of joints) { const p = parent.get(j); jointParents[nodeLabel(nodes, j)] = p === undefined ? null : nodeLabel(nodes, p); }
      return {
        skin: index, ...(skin?.name ? { name: skin.name } : {}),
        joints: joints.map(j => nodeLabel(nodes, j)),
        usedBy: meshNodes.filter(n => n.skin === index).map(n => nodeLabel(nodes, n.node)),
        jointParents,
        roots: joints.filter(j => { const p = parent.get(j); return p === undefined || !joints.includes(p); }).map(j => nodeLabel(nodes, j)),
      };
    }),
    meshNodes,
    vertices: meshNodes.reduce<number | null>((sum, n) => sum === null || n.vertices === null ? null : sum + n.vertices, 0),
  };
}

/** The binary chunk of a GLB, or null for a .gltf or a GLB without one. */
function glbBinary(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return null;
  const at = 20 + view.getUint32(12, true);
  if (at + 8 > bytes.byteLength || view.getUint32(at + 4, true) !== 0x004e4942) return null;
  return bytes.subarray(at + 8, Math.min(bytes.byteLength, at + 8 + view.getUint32(at, true)));
}

/** Read a GLB or .gltf and audit its skins. Throws `GLTF_UNREADABLE` for anything else. */
export const auditSkins = (bytes: Uint8Array): SkinAudit => skinAudit(readGltfJson(bytes), glbBinary(bytes));
