/**
 * Morph target name audit over a GLB's (or .gltf's) JSON, with no engine needed.
 *
 * glTF keeps morph names per mesh in `mesh.extras.targetNames` (the three.js and Blender
 * convention, read by three.js's GLTFLoader and by Unreal). UE 5.7's glTF parser
 * (Engine/Plugins/Interchange/Runtime/Source/Parsers/GLTFCore/Private/GLTF/GLTFAsset.cpp,
 * about lines 322-374) throws those names away in these cases and substitutes
 * `<file>_mesh_<m>_<i>_MorphTarget`:
 * - a name repeats across two glTF meshes: every name in the whole file is discarded;
 * - a name repeats within one mesh, or its `targetNames` count differs from its targets:
 *   that mesh's names are discarded.
 * Primitives of one mesh must also carry the same number of targets. The Interchange
 * pipeline option `bMergeMorphTargetsWithSameName` does not prevent any of this.
 *
 * Used by `verify-unreal` as a pre-flight, and exported for reuse by other verifiers.
 */

export interface GltfMesh { name?: string; extras?: { targetNames?: unknown }; primitives?: { targets?: unknown[] }[] }
export interface GltfJson { meshes?: GltfMesh[]; [key: string]: unknown }

export interface MeshMorphNames { mesh: number; name?: string; targetNames: string[] | null; primitiveTargetCounts: number[] }
export type MorphNameIssueCode =
  | 'MORPH_NAME_SHARED_ACROSS_MESHES' | 'MORPH_NAME_DUPLICATE_IN_MESH' | 'MORPH_NAMES_COUNT_MISMATCH'
  | 'MORPH_TARGET_COUNT_VARIES' | 'MORPH_NAMES_MISSING';
export interface MorphNameIssue { code: MorphNameIssueCode; message: string; meshes: number[]; names?: string[] }
/** Per-mesh morph names, every distinct name in file order, and every layout Unreal rejects. */
export interface MorphNameAudit { meshes: MeshMorphNames[]; names: string[]; issues: MorphNameIssue[] }

/** The names UE's glTF parser generates (`<mesh UniqueId>_<index>_MorphTarget`, UniqueId `<file>_mesh_<m>`). */
export const UE_FALLBACK_MORPH_NAME = /_mesh_\d+_\d+_MorphTarget$/;

/** The one-line fix, shared by every message that recommends it. */
export const SHARED_MORPH_FIX = 'put the parts that share morphs into one glTF mesh as separate primitives (one per material; in Blender, join them into one object)';

const unreadable = (why: string) => Object.assign(new Error(`not a readable GLB or glTF file (${why})`), { code: 'GLTF_UNREADABLE' });

/** Parse the JSON of a GLB (binary) or a .gltf (JSON text). Throws `GLTF_UNREADABLE` otherwise. */
export function readGltfJson(bytes: Uint8Array): GltfJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (bytes.byteLength < 20) throw unreadable('truncated GLB header');
    const length = view.getUint32(12, true), type = view.getUint32(16, true);
    if (type !== 0x4e4f534a) throw unreadable('first GLB chunk is not JSON');
    if (20 + length > bytes.byteLength) throw unreadable('truncated GLB JSON chunk');
    text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  } else {
    text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    if (!/^\s*\{/.test(text)) throw unreadable('bad magic: neither GLB nor JSON');
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) { throw unreadable(`invalid JSON: ${(error as Error).message}`); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw unreadable('JSON is not a glTF object');
  return json as GltfJson;
}

const label = (m: MeshMorphNames) => `mesh ${m.mesh}${m.name ? ` "${m.name}"` : ''}`;

/** Audit morph names in parsed glTF JSON. Meshes without targets are listed but never flagged. */
export function morphNameAudit(json: GltfJson): MorphNameAudit {
  const meshes: MeshMorphNames[] = (json.meshes ?? []).map((mesh, index) => {
    const raw = mesh.extras?.targetNames;
    return {
      mesh: index, ...(mesh.name ? { name: mesh.name } : {}),
      targetNames: Array.isArray(raw) ? raw.map(String) : null,
      primitiveTargetCounts: (mesh.primitives ?? []).map(p => Array.isArray(p.targets) ? p.targets.length : 0),
    };
  });
  const issues: MorphNameIssue[] = [];
  const owners = new Map<string, number[]>();
  for (const m of meshes) {
    const targets = Math.max(0, ...m.primitiveTargetCounts);
    if (!targets && !m.targetNames?.length) continue;
    const names = m.targetNames ?? [];
    for (const name of new Set(names)) owners.set(name, [...(owners.get(name) ?? []), m.mesh]);
    const dups = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dups.length) issues.push({ code: 'MORPH_NAME_DUPLICATE_IN_MESH', meshes: [m.mesh], names: dups,
      message: `${label(m)} lists morph target name(s) ${dups.map(n => `"${n}"`).join(', ')} more than once in extras.targetNames; UE's glTF parser (GLTFAsset.cpp) then discards all of this mesh's names and renames them <file>_mesh_${m.mesh}_<i>_MorphTarget. Give every target in a mesh a unique name.` });
    if (new Set(m.primitiveTargetCounts).size > 1) issues.push({ code: 'MORPH_TARGET_COUNT_VARIES', meshes: [m.mesh],
      message: `${label(m)} has primitives with different numbers of morph targets (${m.primitiveTargetCounts.join(', ')}); glTF and UE require every primitive of a mesh to carry the same targets in the same order (use zero deltas where a primitive does not move).` });
    if (!m.targetNames) issues.push({ code: 'MORPH_NAMES_MISSING', meshes: [m.mesh],
      message: `${label(m)} has ${targets} morph target(s) but no extras.targetNames, so every engine invents names for them (UE: <file>_mesh_${m.mesh}_<i>_MorphTarget). Export with target names.` });
    else if (names.length !== targets) issues.push({ code: 'MORPH_NAMES_COUNT_MISMATCH', meshes: [m.mesh],
      message: `${label(m)} names ${names.length} morph target(s) in extras.targetNames but has ${targets}; UE's glTF parser (GLTFAsset.cpp) then discards this mesh's names and renames them <file>_mesh_${m.mesh}_<i>_MorphTarget.` });
  }
  const shared = [...owners].filter(([, list]) => list.length > 1);
  if (shared.length) {
    const byIndex = new Map(meshes.map(m => [m.mesh, m]));
    const where = shared.map(([name, list]) => `"${name}" (${list.map(i => label(byIndex.get(i)!)).join(', ')})`).join(', ');
    issues.unshift({
      code: 'MORPH_NAME_SHARED_ACROSS_MESHES', names: shared.map(([name]) => name), meshes: [...new Set(shared.flatMap(([, list]) => list))].sort((a, b) => a - b),
      message: `morph target name(s) on more than one glTF mesh: ${where}. UE's glTF parser (Interchange GLTFCore GLTFAsset.cpp) discards every morph target name in the file when any name repeats across meshes, and renames them all <file>_mesh_<m>_<i>_MorphTarget; the Interchange option bMergeMorphTargetsWithSameName does not prevent it. Fix: ${SHARED_MORPH_FIX}.`,
    });
  }
  return { meshes, names: [...owners.keys()], issues };
}

/** Read a GLB or .gltf and audit its morph names. Throws `GLTF_UNREADABLE` for anything else. */
export const auditMorphNames = (bytes: Uint8Array): MorphNameAudit => morphNameAudit(readGltfJson(bytes));
