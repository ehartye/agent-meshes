import { z } from 'zod';
import { readGLB, sceneGraph, type GLTFDocument } from './gltf-read.ts';
import { forEachWorldTriangle } from './glb-geometry.ts';
import { checkDetached, type DetachedReport } from './verify-detached.ts';

export type Vec3 = [number, number, number];
export interface GLBBounds {
  min: Vec3; max: Vec3; size: Vec3; center: Vec3;
  /** Lowest world y. */
  yMin: number;
  /** Middle of the footprint at the lowest y: [centre x, yMin, centre z]. A "bottom-center" pivot puts this at the origin. */
  baseCenter: Vec3;
}

/**
 * Pivot conventions an exported model can be held to. Both spellings of centre are accepted on input
 * and normalised to the American one.
 */
export const pivotNames = ['bottom-center', 'center'] as const;
export type Pivot = typeof pivotNames[number];
export const pivotSchema = z.enum(['bottom-center', 'bottom-centre', 'center', 'centre']).transform((name): Pivot => name.replace('centre', 'center') as Pivot);

/** Limits and expectations checked against the final GLB; every field is optional. */
export const limitsSchema = z.object({
  maxTriangles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxMaterials: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  expectPivot: pivotSchema.optional(),
  expectHeight: z.number().positive().finite().optional(),
  /** Metres allowed on the pivot and height checks (default 0.001). */
  tolerance: z.number().min(0).finite().optional(),
  /** Report violations as warnings in the output instead of failing. */
  warnOnly: z.boolean().optional(),
  /** Fail when a mesh part (or a group of touching parts) of a static model is farther than this many metres from the rest. */
  maxGap: z.number().min(0).finite().optional(),
  /** Part names allowed to float (a halo, a hovering orb); never reported by the detached-part lint. */
  allowDetached: z.array(z.string().min(1)).optional(),
}).strict();
export type LimitOptions = z.input<typeof limitsSchema>;

export interface LimitCheck { name: 'maxTriangles' | 'maxMaterials' | 'expectPivot' | 'expectHeight' | 'maxGap'; ok: boolean; expected: number | string; actual: number | Vec3; message: string }
export interface LimitsReport {
  ok: boolean; warnOnly: boolean;
  /** Triangles drawn by the default scene, counting every node instance. */
  triangles: number;
  /** Distinct materials the drawn meshes reference. */
  materials: number;
  bounds: GLBBounds;
  checks: LimitCheck[];
  failures: string[];
  /** The detached-part lint, present when maxGap is set. */
  detached?: DetachedReport;
}

const m = (value: number) => Number(value.toFixed(5));
const vec = (v: Vec3) => `[${v.map(m).join(', ')}]`;

/** World-space bounds of the drawn geometry from the final vertices, with node matrices applied. */
export function boundsOf(doc: GLTFDocument): GLBBounds & { triangles: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  forEachWorldTriangle(doc, (...corners) => {
    count++;
    for (const p of corners) for (let i = 0; i < 3; i++) { if (!Number.isFinite(p[i])) throw new Error('POSITION contains non-finite data'); min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  });
  if (!count) throw Object.assign(new Error('GLB has no drawn triangles to measure'), { code: 'NO_GEOMETRY' });
  const size = max.map((v, i) => v - min[i]) as Vec3, center = max.map((v, i) => (v + min[i]) / 2) as Vec3;
  return { min, max, size, center, yMin: min[1], baseCenter: [center[0], min[1], center[2]], triangles: count };
}
export function measureBounds(bytes: Uint8Array): GLBBounds { const { triangles: _unused, ...bounds } = boundsOf(readGLB(bytes)); return bounds; }

function drawnMaterials(doc: GLTFDocument): number {
  const used = new Set<number | string>(), meshes = new Set<number>();
  const { world } = sceneGraph(doc.json);
  for (const index of world.keys()) { const mesh = doc.json.nodes![index].mesh; if (mesh !== undefined) meshes.add(mesh); }
  for (const mesh of meshes) for (const primitive of doc.json.meshes![mesh].primitives) used.add(primitive.material ?? 'default');
  return used.size;
}

export function checkLimits(bytes: Uint8Array, options: LimitOptions): LimitsReport {
  const limits = limitsSchema.parse(options), doc = readGLB(bytes);
  const { triangles, ...bounds } = boundsOf(doc), materials = drawnMaterials(doc), tolerance = limits.tolerance ?? 0.001;
  const checks: LimitCheck[] = [];
  if (limits.maxTriangles !== undefined) checks.push({ name: 'maxTriangles', ok: triangles <= limits.maxTriangles, expected: limits.maxTriangles, actual: triangles,
    message: `${triangles} triangles ${triangles <= limits.maxTriangles ? 'within' : 'exceed'} the budget of ${limits.maxTriangles}` });
  if (limits.maxMaterials !== undefined) checks.push({ name: 'maxMaterials', ok: materials <= limits.maxMaterials, expected: limits.maxMaterials, actual: materials,
    message: `${materials} materials ${materials <= limits.maxMaterials ? 'within' : 'exceed'} the budget of ${limits.maxMaterials}` });
  if (limits.expectPivot !== undefined) {
    const at: Vec3 = limits.expectPivot === 'center' ? bounds.center : bounds.baseCenter;
    const off = Math.max(...at.map(Math.abs)), ok = off <= tolerance;
    checks.push({ name: 'expectPivot', ok, expected: limits.expectPivot, actual: at,
      message: `${limits.expectPivot === 'center' ? 'bounds centre' : 'base centre'} is at ${vec(at)}; the origin is expected within ${tolerance} m${ok ? '' : ` (off by ${m(off)} m)`}` });
  }
  if (limits.expectHeight !== undefined) {
    const height = bounds.size[1], ok = Math.abs(height - limits.expectHeight) <= tolerance;
    checks.push({ name: 'expectHeight', ok, expected: limits.expectHeight, actual: height,
      message: `height is ${m(height)} m; ${limits.expectHeight} m is expected within ${tolerance} m` });
  }
  let detached: DetachedReport | undefined;
  if (limits.maxGap !== undefined) {
    detached = checkDetached(doc, { tolerance: limits.maxGap, allow: limits.allowDetached });
    const worst = Math.max(0, ...detached.findings.map(finding => finding.gap));
    checks.push({ name: 'maxGap', ok: detached.ok, expected: limits.maxGap, actual: worst,
      message: detached.ok ? `every mesh part is within ${limits.maxGap} m of another${detached.skipped ? ` (skipped: ${detached.skipped})` : ''}` : detached.findings.map(finding => finding.message).join('\n') });
  }
  // One failure line per floating group, so each prints as its own FAIL line.
  const failures = checks.filter(check => !check.ok).flatMap(check => check.name === 'maxGap' ? check.message.split('\n') : [check.message]);
  return { ok: failures.length === 0, warnOnly: limits.warnOnly ?? false, triangles, materials, bounds, checks, failures, ...(detached ? { detached } : {}) };
}
