import { readAccessor, readGLB, triangles, type GLTFDocument, type GLTFMesh } from './gltf-read.ts';

export interface GeometryBudgetOptions { target: 'uefn'; renderVertexBudget?: number }
export interface MeshGeometryCounts {
  mesh: number; name: string; instances: number;
  /** Authoring topology cannot be recovered from exported GLB vertex records. */
  sourceVertices: null;
  /** Exact distinct referenced XYZ positions, without normals/UVs; not an authoring vertex count. */
  positionVertices: number | null;
  /** Referenced exported vertex records per material primitive, including normal/UV splits. */
  renderVertices: number | null;
  triangles: number | null;
}
export interface GeometryBudgetWarning {
  code: 'RENDER_VERTEX_BUDGET_EXCEEDED' | 'GEOMETRY_COUNT_UNKNOWN';
  mesh: number; message: string;
}
export interface GeometryBudgetReport {
  target: 'uefn'; renderVertexBudget: number; nativeVerified: false;
  meshes: MeshGeometryCounts[];
  totals: { sourceVertices: null; positionVertices: number | null; renderVertices: number | null; triangles: number | null };
  warnings: GeometryBudgetWarning[];
}

function meshCounts(doc: GLTFDocument, mesh: GLTFMesh): Pick<MeshGeometryCounts, 'positionVertices' | 'renderVertices' | 'triangles'> {
  const distinctPositions = new Set<string>();
  let renderVertices = 0, triangleCount = 0;
  for (const primitive of mesh.primitives) {
    if (![4, 5, 6].includes(primitive.mode ?? 4)) continue;
    if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed geometry needs decoding');
    const positions = readAccessor(doc, primitive.attributes.POSITION);
    if (positions.size !== 3) throw new Error('POSITION must contain XYZ rows');
    const order = triangles(doc, primitive, positions.count);
    const used = new Set(order);
    for (const index of used) {
      if (index >= positions.count) throw new Error('Triangle index is outside the POSITION accessor');
      const xyz = Array.from(positions.data.subarray(index * 3, index * 3 + 3));
      if (xyz.some(value => !Number.isFinite(value))) throw new Error('POSITION contains non-finite data');
      distinctPositions.add(xyz.join(','));
    }
    // A shared POSITION accessor can contain every material section. Only the
    // records this primitive indexes count, not the full accessor once per section.
    renderVertices += used.size;
    triangleCount += order.length / 3;
  }
  return { positionVertices: distinctPositions.size, renderVertices, triangles: triangleCount };
}

/**
 * Optional exported-geometry preflight, independent of structural GLB validity.
 * Counts each mesh asset once; nodes sharing it are instances, not larger assets.
 * The default is a workflow warning budget, not a universal UEFN validation limit.
 * Native import can weld, split or recompute attributes: inspect actual native LODs.
 */
export function auditGeometryBudget(bytes: Uint8Array, options: GeometryBudgetOptions): GeometryBudgetReport {
  if (options.target !== 'uefn') throw new Error('Geometry target must be uefn');
  const budget = options.renderVertexBudget ?? 30000;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Render vertex budget must be a positive safe integer');
  const doc = readGLB(bytes);
  const warnings: GeometryBudgetWarning[] = [];
  const meshes = (doc.json.meshes ?? []).map((mesh, index): MeshGeometryCounts => {
    const name = mesh.name ?? `mesh ${index}`;
    let counts: Pick<MeshGeometryCounts, 'positionVertices' | 'renderVertices' | 'triangles'>;
    try {
      if (doc.json.extensionsRequired?.includes('EXT_meshopt_compression')) throw new Error('Meshopt-compressed geometry needs decoding');
      counts = meshCounts(doc, mesh);
    } catch (error) {
      counts = { positionVertices: null, renderVertices: null, triangles: null };
      warnings.push({ code: 'GEOMETRY_COUNT_UNKNOWN', mesh: index, message: `${name}: ${String(error)}; cannot assess the vertex budget` });
    }
    if (counts.renderVertices !== null && counts.renderVertices > budget) {
      warnings.push({ code: 'RENDER_VERTEX_BUDGET_EXCEEDED', mesh: index,
        message: `${name}: ${counts.renderVertices} exported render vertices exceed the ${budget} UEFN warning budget; inspect native LODs and simplify or add LODs` });
    }
    return { mesh: index, name, instances: (doc.json.nodes ?? []).filter(node => node.mesh === index).length,
      sourceVertices: null, ...counts };
  });
  const total = (key: 'positionVertices' | 'renderVertices' | 'triangles') => meshes.reduce<number | null>(
    (sum, mesh) => sum === null || mesh[key] === null ? null : sum + mesh[key], 0);
  return { target: options.target, renderVertexBudget: budget, nativeVerified: false, meshes,
    totals: { sourceVertices: null, positionVertices: total('positionVertices'), renderVertices: total('renderVertices'), triangles: total('triangles') }, warnings };
}
