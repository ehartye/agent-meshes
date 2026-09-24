import { readGltfJson, type GltfJson } from './gltf-morphs.ts';

/**
 * Skin audit over a GLB's (or .gltf's) JSON, with no engine needed: which skins exist,
 * which joints they name, and which mesh nodes are bound to them.
 *
 * Unreal's Interchange builds one SkeletalMesh and one Skeleton per glTF skin. A mesh node
 * with morph targets but no `skin` still becomes a SkeletalMesh (morphs need one), on a
 * made-up one-bone skeleton named after the node; an unskinned mesh without morphs becomes
 * a StaticMesh. `verify-unreal` uses this audit to explain why no SkeletalMesh carries
 * both the morphs and the bones a contract needs.
 */

export interface GltfSkinFacts { skin: number; name?: string; joints: string[]; usedBy: string[] }
export interface GltfMeshNode { node: number; name?: string; mesh: number; meshName?: string; skin: number | null; morphTargets: number }
export interface SkinAudit { skins: GltfSkinFacts[]; meshNodes: GltfMeshNode[] }

interface Node { name?: string; mesh?: number; skin?: number }
interface Skin { name?: string; joints?: number[] }

const nodeLabel = (nodes: Node[], index: number) => nodes[index]?.name ?? `node ${index}`;

/** Audit skins and mesh nodes in parsed glTF JSON. */
export function skinAudit(json: GltfJson): SkinAudit {
  const nodes = (Array.isArray(json.nodes) ? json.nodes : []) as Node[];
  const skins = (Array.isArray(json.skins) ? json.skins : []) as Skin[];
  const meshNodes: GltfMeshNode[] = [];
  nodes.forEach((node, index) => {
    if (typeof node?.mesh !== 'number') return;
    const mesh = json.meshes?.[node.mesh];
    meshNodes.push({
      node: index, ...(node.name ? { name: node.name } : {}), mesh: node.mesh, ...(mesh?.name ? { meshName: mesh.name } : {}),
      skin: typeof node.skin === 'number' ? node.skin : null,
      morphTargets: Math.max(0, ...(mesh?.primitives ?? []).map(p => Array.isArray(p.targets) ? p.targets.length : 0)),
    });
  });
  return {
    skins: skins.map((skin, index) => ({
      skin: index, ...(skin?.name ? { name: skin.name } : {}),
      joints: (skin?.joints ?? []).map(j => nodeLabel(nodes, j)),
      usedBy: meshNodes.filter(n => n.skin === index).map(n => nodeLabel(nodes, n.node)),
    })),
    meshNodes,
  };
}

/** Read a GLB or .gltf and audit its skins. Throws `GLTF_UNREADABLE` for anything else. */
export const auditSkins = (bytes: Uint8Array): SkinAudit => skinAudit(readGltfJson(bytes));
