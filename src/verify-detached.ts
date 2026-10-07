import { Vector3 } from 'three';
import { readAccessor, readGLB, sceneGraph, triangles, type GLTFDocument } from './gltf-read.ts';

/**
 * Detached-part lint for static models. Every drawn mesh node of the exported GLB is one part, measured with its
 * real world-space triangles (node matrices, parenting and rotation applied), not its bounds. Two parts are joined when
 * their surfaces come within the tolerance of each other or one sits wholly inside the other; the largest group of
 * joined parts (by surface area) is the body, and every other group is reported with its measured gap.
 *
 * Skinned or animated files are skipped: their parts move, so a rest-pose gap is often intended (a joint gap between
 * two leg segments) and a touching rest pose proves nothing about the clips. Empty nodes (sockets, `group` parts) have
 * no surface and are not parts here; their transforms still place their children.
 */

/**
 * Default join distance, in metres. Round parts are faceted: a part placed against the ideal surface of a 0.5 m radius
 * sphere or cylinder at 16 segments can sit up to 0.5 * (1 - cos 11.25 deg) = 9.6 mm off the facets. One centimetre
 * absorbs that sag and float noise while the gaps seen in practice (0.1 m and up) are reported.
 */
export const DEFAULT_DETACHED_TOLERANCE = 0.01;

export interface DetachedOptions {
  /** Metres within which two surfaces count as touching (default 0.01). */
  tolerance?: number;
  /** Part (node) names that may float on purpose; they are never reported but still join their neighbours. */
  allow?: readonly string[];
}
export interface DetachedFinding {
  code: 'DETACHED_PART';
  /** Mesh parts that touch each other but nothing in the body. */
  parts: string[];
  /** The closest part outside the group. */
  nearest: string;
  /** Shortest surface-to-surface distance from the group to any other part, in metres. */
  gap: number;
  message: string;
}
export interface DetachedReport {
  ok: boolean;
  tolerance: number;
  /** Mesh parts measured. */
  parts: number;
  /** Groups of touching parts; 1 means everything is connected. */
  groups: number;
  /** Why the check did not run, when it did not. */
  skipped?: string;
  findings: DetachedFinding[];
}

type V = [number, number, number];
interface Piece { name: string; tris: V[][]; min: V; max: V; triMin: V[]; triMax: V[]; area: number }

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist2 = (a: V, b: V) => { const d = sub(a, b); return dot(d, d); };
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;

/** Squared gap between two axis-aligned boxes (0 when they overlap). */
function boxGap2(amin: V, amax: V, bmin: V, bmax: V): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(0, bmin[i] - amax[i], amin[i] - bmax[i]); sum += d * d; }
  return sum;
}

/** Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle2(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist2(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist2(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist2(p, lerp(a, b, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist2(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist2(p, lerp(a, c, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist2(p, lerp(b, c, (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return dist2(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Squared distance between segments p1q1 and p2q2 (Ericson 5.1.9). */
function segmentSegment2(p1: V, q1: V, p2: V, q2: V): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), EPS = 1e-18;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) return dot(r, r);
  if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return dist2(lerp(p1, q1, s), lerp(p2, q2, t));
}

/** Does segment pq cross triangle abc (Moller-Trumbore with t in [0, 1])? Coplanar contact is left to the distance tests. */
function segmentHitsTriangle(p: V, q: V, a: V, b: V, c: V): boolean {
  const dir = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(dir, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-15) return false;
  const inv = 1 / det, s = sub(p, a), u = inv * dot(s, h);
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1), v = inv * dot(dir, qv);
  if (v < 0 || u + v > 1) return false;
  const t = inv * dot(e2, qv);
  return t >= 0 && t <= 1;
}

/** Squared distance between two triangles: zero when they cross, otherwise the closest vertex-face or edge-edge pair. */
function triangleTriangle2(t: V[], u: V[]): number {
  for (let i = 0; i < 3; i++) {
    if (segmentHitsTriangle(t[i], t[(i + 1) % 3], u[0], u[1], u[2])) return 0;
    if (segmentHitsTriangle(u[i], u[(i + 1) % 3], t[0], t[1], t[2])) return 0;
  }
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    best = Math.min(best, pointTriangle2(t[i], u[0], u[1], u[2]), pointTriangle2(u[i], t[0], t[1], t[2]));
    for (let j = 0; j < 3; j++) best = Math.min(best, segmentSegment2(t[i], t[(i + 1) % 3], u[j], u[(j + 1) % 3]));
  }
  return best;
}

/**
 * Smallest squared surface distance between two parts, searching only below `bound2` (squared). Returns early with a
 * value at or below `stop2` once one is found, which is all the connectivity pass needs.
 */
function pieceGap2(a: Piece, b: Piece, bound2: number, stop2 = -1): number {
  if (boxGap2(a.min, a.max, b.min, b.max) >= bound2) return bound2;
  const reach = Math.sqrt(bound2);
  const near = (p: Piece, other: Piece) => {
    const lo: V = [other.min[0] - reach, other.min[1] - reach, other.min[2] - reach], hi: V = [other.max[0] + reach, other.max[1] + reach, other.max[2] + reach];
    const out: number[] = [];
    for (let i = 0; i < p.tris.length; i++) if (boxGap2(p.triMin[i], p.triMax[i], lo, hi) === 0) out.push(i);
    return out;
  };
  const ia = near(a, b), ib = near(b, a);
  let best = bound2;
  for (const i of ia) for (const j of ib) {
    if (boxGap2(a.triMin[i], a.triMax[i], b.triMin[j], b.triMax[j]) >= best) continue;
    const d = triangleTriangle2(a.tris[i], b.tris[j]);
    if (d < best) { best = d; if (best <= stop2) return best; }
  }
  return best;
}

/** Generalized winding number of a point with respect to a part's triangles: about 1 inside a closed surface, 0 outside. */
function winding(p: V, piece: Piece): number {
  let total = 0;
  for (const [a0, b0, c0] of piece.tris) {
    const a = sub(a0, p), b = sub(b0, p), c = sub(c0, p);
    const la = Math.hypot(...a), lb = Math.hypot(...b), lc = Math.hypot(...c);
    total += 2 * Math.atan2(dot(a, cross(b, c)), la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la);
  }
  return total / (4 * Math.PI);
}
const within = (inner: Piece, outer: Piece, slack: number) => inner.min.every((v, i) => v >= outer.min[i] - slack && inner.max[i] <= outer.max[i] + slack);

function piecesOf(doc: GLTFDocument): Piece[] {
  const { world } = sceneGraph(doc.json);
  const pieces: Piece[] = [], v = new Vector3();
  for (const [index, matrix] of world) {
    const node = doc.json.nodes![index];
    if (node.mesh === undefined) continue;
    const tris: V[][] = [];
    for (const primitive of doc.json.meshes![node.mesh].primitives) {
      if (![4, 5, 6].includes(primitive.mode ?? 4)) continue;
      if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed geometry needs decoding');
      const positions = readAccessor(doc, primitive.attributes.POSITION), order = triangles(doc, primitive, positions.count);
      const corner = (i: number): V => { v.set(positions.data[i * 3], positions.data[i * 3 + 1], positions.data[i * 3 + 2]).applyMatrix4(matrix); return [v.x, v.y, v.z]; };
      for (let i = 0; i + 2 < order.length; i += 3) tris.push([corner(order[i]), corner(order[i + 1]), corner(order[i + 2])]);
    }
    if (!tris.length) continue;
    const min: V = [Infinity, Infinity, Infinity], max: V = [-Infinity, -Infinity, -Infinity], triMin: V[] = [], triMax: V[] = [];
    let area = 0;
    for (const t of tris) {
      const lo: V = [Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]), Math.min(t[0][2], t[1][2], t[2][2])];
      const hi: V = [Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1]), Math.max(t[0][2], t[1][2], t[2][2])];
      triMin.push(lo); triMax.push(hi);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], lo[k]); max[k] = Math.max(max[k], hi[k]); }
      area += Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2;
    }
    pieces.push({ name: node.name || `node ${index}`, tris, min, max, triMin, triMax, area });
  }
  return pieces;
}

const metres = (value: number) => Number(value.toFixed(3));

/** Report every mesh part, or group of touching parts, that touches nothing in the body of a static model. */
export function checkDetached(input: Uint8Array | GLTFDocument, options: DetachedOptions = {}): DetachedReport {
  const tolerance = options.tolerance ?? DEFAULT_DETACHED_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw Object.assign(new Error('Detached-part tolerance must be a non-negative number of metres'), { code: 'CLI_ARGUMENT_ERROR' });
  const doc = input instanceof Uint8Array ? readGLB(input) : input;
  const json = doc.json as GLTFDocument['json'] & { animations?: unknown[] };
  const base = { tolerance, findings: [] as DetachedFinding[] };
  if (json.skins?.length || json.animations?.length) {
    return { ...base, ok: true, parts: 0, groups: 0, skipped: 'skinned or animated model: parts move with bones or clips, so rest-pose gaps are not judged; check contact on the clip contact sheets' };
  }
  let pieces: Piece[];
  try { pieces = piecesOf(doc); } catch (error) {
    return { ...base, ok: true, parts: 0, groups: 0, skipped: `geometry could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const n = pieces.length;
  const root = pieces.map((_, i) => i);
  const find = (i: number): number => root[i] === i ? i : (root[i] = find(root[i]));
  const tol2 = tolerance * tolerance, probe = Math.max(tol2 * 1.0001, 1e-12);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (find(i) === find(j)) continue;
    const a = pieces[i], b = pieces[j];
    if (boxGap2(a.min, a.max, b.min, b.max) > tol2) continue;
    const touching = pieceGap2(a, b, probe, tol2) <= tol2
      // Nested: one part wholly inside a closed other part with no surface contact is still held by it.
      || (within(a, b, tolerance) && Math.abs(winding(a.tris[0][0], b)) >= 0.5)
      || (within(b, a, tolerance) && Math.abs(winding(b.tris[0][0], a)) >= 0.5);
    if (touching) root[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  pieces.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const list = [...groups.values()];
  const areaOf = (group: number[]) => group.reduce((sum, i) => sum + pieces[i].area, 0);
  const body = list.reduce((best, group) => areaOf(group) > areaOf(best) ? group : best, list[0] ?? []);
  const allowed = new Set(options.allow ?? []);
  const findings: DetachedFinding[] = [];
  for (const group of list) {
    if (group === body) continue;
    const names = group.map(i => pieces[i].name).filter(name => !allowed.has(name));
    if (!names.length) continue;
    const inside = new Set(group);
    const pairs: [number, number, number][] = [];
    for (const i of group) for (let j = 0; j < n; j++) if (!inside.has(j)) pairs.push([i, j, boxGap2(pieces[i].min, pieces[i].max, pieces[j].min, pieces[j].max)]);
    pairs.sort((x, y) => x[2] - y[2]);
    let best = Infinity, nearest = '';
    for (const [i, j, box] of pairs) {
      if (box >= best) break;
      const d = pieceGap2(pieces[i], pieces[j], best);
      if (d < best) { best = d; nearest = pieces[j].name; }
    }
    const gap = metres(Math.sqrt(best));
    const who = names.length === 1 ? `${names[0]} touches` : `${names.join(', ')} touch each other but`;
    findings.push({ code: 'DETACHED_PART', parts: names, nearest, gap,
      message: `DETACHED_PART: ${who} nothing else: ${gap} m from the nearest part (${nearest}), more than the ${tolerance} m tolerance. Move it onto its neighbour or overlap them.` });
  }
  return { ...base, ok: findings.length === 0, parts: n, groups: list.length, findings };
}
