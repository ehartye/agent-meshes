import { AnimationMixer, Mesh, SkinnedMesh, Vector3 } from 'three';
import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readGLB } from './gltf-read.ts';

/**
 * Garment penetration check for a skinned, animated GLB, with no renderer. Every clip is sampled
 * at evenly spaced phases and each mesh is posed as three.js skins it. A vertex of one part that
 * was outside another closed part at rest, and is inside it by more than the tolerance at a
 * sampled phase, is an intrusion: a leg punching through a belt, a hand sinking into a hip, a
 * pouch shearing into a jacket hem. Overlaps that exist at rest (a garment's inner face embedded
 * in the body it is seated on) are the baseline for the clips. The rest pose itself fails when two
 * parts cross, each hiding surface of the other that faced outward (a trouser leg wider than the
 * boot shaft round it shows through the shaft in jagged patches): see `restCrossings`.
 *
 * Parts are garments (named by `garments`, default `layer-*`, gloves, boots and outsoles) or body.
 * Garment-vs-garment, garment-vs-body and garment self-folds (a surface folding through its own
 * volume, such as a hip crease under linear-blend skinning) are checked; body-vs-body is not. Only
 * closed (watertight once welded) parts can contain anything; open parts are listed and skipped.
 */

export type Vec3 = [number, number, number];
export const GARMENT_CHECK_FORMAT = 'agent-meshes/garment-check/1';
export const DEFAULT_GARMENTS = /^layer-|glove|boot|outsole/;
export type IntrusionKind = 'garment-garment' | 'garment-body' | 'self' | 'rest-crossing';

export interface GarmentCheckOptions {
  /** Clips to sample (default: every clip in the file). */
  clips?: string[];
  /** Phases per clip, evenly spaced from 0 (default 16). */
  samples?: number;
  /** Depth past which an intrusion counts, meters (default 0.002). */
  tolerance?: number;
  garments?: RegExp;
  /** Parts left out of the check entirely. */
  ignore?: RegExp;
  /** Self-folds ignore surface within this distance of the vertex along the rest surface, meters (default 0.03). */
  selfRadius?: number;
  /**
   * Two garments cross at rest when each buries at least this many of the other's outward-facing
   * vertices deeper than `crossingDepth` (defaults 8 and 0.004 m): a patch, not a seam or a trim.
   */
  crossingVertices?: number;
  crossingDepth?: number;
  /** List every offending vertex (rest and posed position, depth) on each intrusion. */
  points?: boolean;
}
export interface Intrusion {
  clip: string; phase: number; kind: IntrusionKind;
  /** The part whose vertices entered `into`. */
  part: string; into: string;
  vertices: number;
  /** Deepest vertex's distance inside `into`, meters (capped at 5 cm). */
  depth: number;
  /** Posed world position of the deepest vertex, and where that vertex sits at rest. */
  at: Vec3; from: Vec3;
  /** Every offending vertex, with `points: true`. */
  points?: { from: Vec3; at: Vec3; depth: number }[];
}
export interface PairSummary { part: string; into: string; kind: IntrusionKind; depth: number; vertices: number; clips: string[]; phases: number[] }
export interface GarmentReport {
  format: string; ok: boolean; tolerance: number; samples: number; clips: string[];
  parts: { garments: string[]; bodies: string[]; open: string[] };
  intrusions: Intrusion[];
  /** Worst intrusion per part pair across every sample, deepest first. */
  pairs: PairSummary[];
}

const DEPTH_CAP = 0.05;
/** Offsets the parity ray origin off exact edges and vertices. */
const JITTER: [number, number] = [1.3e-7, 2.9e-7];

/** GLTFLoader cannot decode images in Node; the check needs no materials, so drop them first. */
function geometryOnly(bytes: Uint8Array): ArrayBuffer {
  const { json, bin } = readGLB(bytes) as { json: Record<string, unknown> & { materials?: { name?: string }[] }; bin?: Uint8Array };
  delete json.images; delete json.textures; delete json.samplers;
  if (json.materials) json.materials = json.materials.map(material => ({ ...(material.name ? { name: material.name } : {}) }));
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key] as string[] | undefined;
    if (list) json[key] = list.filter(name => !/^KHR_(materials|texture)_/.test(name));
  }
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonLength = text.length + pad(text.length), binLength = bin ? bin.length + pad(bin.length) : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true); view.setUint32(at + 4, 0x004e4942, true); out.set(bin, at + 8);
  }
  return out.buffer;
}

/** One named part: its meshes' vertices welded by position, so seams split for normals or UVs close up. */
interface Part {
  name: string; garment: boolean; closed: boolean;
  /** For each welded vertex, a (mesh, vertex index) it can be posed from. */
  sources: { mesh: Mesh; index: number }[];
  triangles: Uint32Array;
  /** Connected component of each welded vertex and each triangle: merged pieces (laces, eyelets) overlap one another. */
  vertexComponent: Uint32Array; triangleComponent: Uint32Array;
  rest: Float64Array;
}

function collectParts(scene: Object3D, garments: RegExp, ignore: RegExp | undefined): Part[] {
  const byName = new Map<string, Mesh[]>();
  scene.traverse(object => {
    if (!(object as Mesh).isMesh) return;
    // Multi-primitive glTF meshes load as a named group of unnamed-primitive children.
    const name = object.name && !/_\d+$/.test(object.name) ? object.name : object.parent?.name || object.name;
    if (!name || ignore?.test(name)) return;
    byName.set(name, [...(byName.get(name) ?? []), object as Mesh]);
  });
  const parts: Part[] = [];
  const point = new Vector3();
  for (const [name, meshes] of byName) {
    const keys = new Map<string, number>(), sources: Part['sources'] = [], triangles: number[] = [], rest: number[] = [];
    for (const mesh of meshes) {
      const position = mesh.geometry.getAttribute('position'), local: number[] = [];
      mesh.updateWorldMatrix(true, false);
      for (let i = 0; i < position.count; i++) {
        pose(mesh, i, point);
        const key = `${Math.round(point.x * 1e5)},${Math.round(point.y * 1e5)},${Math.round(point.z * 1e5)}`;
        let id = keys.get(key);
        if (id === undefined) { id = sources.length; keys.set(key, id); sources.push({ mesh, index: i }); rest.push(point.x, point.y, point.z); }
        local.push(id);
      }
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let k = 0; k + 2 < count; k += 3) {
        const a = local[index ? index.getX(k) : k], b = local[index ? index.getX(k + 1) : k + 1], c = local[index ? index.getX(k + 2) : k + 2];
        if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
      }
    }
    const edges = new Map<string, number[]>();
    for (let k = 0; k < triangles.length; k += 3) for (let e = 0; e < 3; e++) {
      const a = triangles[k + e], b = triangles[k + (e + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key); if (list) list.push(k / 3); else edges.set(key, [k / 3]);
    }
    const closed = triangles.length > 0 && [...edges.values()].every(list => list.length % 2 === 0);
    // Pieces are joined across manifold edges only: merged tubes that merely touch at a weld stay apart.
    const root = Array.from({ length: triangles.length / 3 }, (_, i) => i);
    const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
    for (const list of edges.values()) if (list.length === 2) root[find(list[1])] = find(list[0]);
    const triangleComponent = Uint32Array.from(root.map((_, t) => find(t)));
    const vertexComponent = new Uint32Array(sources.length);
    for (let k = 0; k < triangles.length; k++) vertexComponent[triangles[k]] = triangleComponent[Math.floor(k / 3)];
    parts.push({ name, garment: garments.test(name), closed, sources, triangles: Uint32Array.from(triangles), vertexComponent, triangleComponent, rest: Float64Array.from(rest) });
  }
  return parts.sort((a, b) => a.name.localeCompare(b.name));
}

/** Vertices within `radius` of vertex `v` along the part's rest surface (edge-path Dijkstra), cached per part. */
const neighbourhoods = new WeakMap<Part, { edges: [number, number][][]; balls: Map<number, Set<number>> }>();
function nearby(part: Part, v: number, radius: number): Set<number> {
  let cache = neighbourhoods.get(part);
  if (!cache) {
    const edges: [number, number][][] = part.sources.map(() => []), r = part.rest;
    const link = (a: number, b: number) => {
      const length = Math.hypot(r[a * 3] - r[b * 3], r[a * 3 + 1] - r[b * 3 + 1], r[a * 3 + 2] - r[b * 3 + 2]);
      edges[a].push([b, length]); edges[b].push([a, length]);
    };
    for (let k = 0; k < part.triangles.length; k += 3) for (let e = 0; e < 3; e++) link(part.triangles[k + e], part.triangles[k + (e + 1) % 3]);
    cache = { edges, balls: new Map() }; neighbourhoods.set(part, cache);
  }
  let ball = cache.balls.get(v);
  if (ball) return ball;
  const best = new Map<number, number>([[v, 0]]), open = [v]; ball = new Set();
  while (open.length) {
    // Balls hold tens of vertices: a linear scan for the nearest open vertex is cheap enough.
    let at = 0; for (let k = 1; k < open.length; k++) if (best.get(open[k])! < best.get(open[at])!) at = k;
    const u = open.splice(at, 1)[0]; if (ball.has(u)) continue; ball.add(u);
    for (const [w, length] of cache.edges[u]) {
      const d = best.get(u)! + length;
      if (d <= radius && d < (best.get(w) ?? Infinity)) { best.set(w, d); open.push(w); }
    }
  }
  cache.balls.set(v, ball);
  return ball;
}

function pose(mesh: Mesh, index: number, target: Vector3): Vector3 {
  if ((mesh as SkinnedMesh).isSkinnedMesh) (mesh as SkinnedMesh).getVertexPosition(index, target);
  else target.fromBufferAttribute(mesh.geometry.getAttribute('position'), index);
  return target.applyMatrix4(mesh.matrixWorld);
}

function posed(part: Part): Float64Array {
  const out = new Float64Array(part.sources.length * 3), point = new Vector3();
  part.sources.forEach(({ mesh, index }, i) => { pose(mesh, index, point); out[i * 3] = point.x; out[i * 3 + 1] = point.y; out[i * 3 + 2] = point.z; });
  return out;
}

/**
 * Point containment and surface distance for one posed closed part. Containment is ray parity
 * along +X through a (y, z) bin grid; distance searches a 3D bin grid in growing shells.
 */
class Volume {
  readonly min: Vec3 = [Infinity, Infinity, Infinity]; readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];
  private readonly cell: number; private readonly bins = new Map<number, number[]>(); private readonly cells = new Map<string, number[]>();
  private readonly points: Float64Array; private readonly triangles: Uint32Array; private readonly component: Uint32Array;
  constructor(points: Float64Array, triangles: Uint32Array, component: Uint32Array) {
    this.points = points; this.triangles = triangles; this.component = component;
    for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
      this.min[k] = Math.min(this.min[k], points[i + k]); this.max[k] = Math.max(this.max[k], points[i + k]);
    }
    const extent = Math.max(this.max[1] - this.min[1], this.max[2] - this.min[2], 1e-6);
    this.cell = Math.max(extent / 48, 0.004);
    for (let t = 0; t < triangles.length; t += 3) {
      const [y0, y1] = this.span(t, 1), [z0, z1] = this.span(t, 2);
      for (let y = this.bin(y0, 1); y <= this.bin(y1, 1); y++) for (let z = this.bin(z0, 2); z <= this.bin(z1, 2); z++) {
        const key = y * 100003 + z; const list = this.bins.get(key); if (list) list.push(t); else this.bins.set(key, [t]);
      }
      const lo = [0, 1, 2].map(k => Math.floor(this.span(t, k)[0] / this.cell)), hi = [0, 1, 2].map(k => Math.floor(this.span(t, k)[1] / this.cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = `${x},${y},${z}`; const list = this.cells.get(key); if (list) list.push(t); else this.cells.set(key, [t]);
      }
    }
  }
  private span(t: number, k: number): [number, number] {
    const p = this.points, a = p[this.triangles[t] * 3 + k], b = p[this.triangles[t + 1] * 3 + k], c = p[this.triangles[t + 2] * 3 + k];
    return [Math.min(a, b, c), Math.max(a, b, c)];
  }
  private bin(value: number, k: number) { return Math.floor((value - this.min[k]) / this.cell); }
  near(x: number, y: number, z: number, margin = 0) {
    return x >= this.min[0] - margin && x <= this.max[0] + margin && y >= this.min[1] - margin && y <= this.max[1] + margin && z >= this.min[2] - margin && z <= this.max[2] + margin;
  }
  /**
   * The connected components (optionally only `only`) whose parity puts the point inside; empty
   * when it is outside. Per-component parity keeps overlapping merged pieces from cancelling.
   */
  contains(x: number, y: number, z: number, only?: number): number[] {
    if (!this.near(x, y, z)) return [];
    y += JITTER[0]; z += JITTER[1];
    const list = this.bins.get(this.bin(y, 1) * 100003 + this.bin(z, 2));
    if (!list) return [];
    const p = this.points, crossings = new Map<number, number>();
    let first = -1, count = 0, mixed = false;
    for (const t of list) {
      const component = this.component[t / 3];
      if (only !== undefined && component !== only) continue;
      const a = this.triangles[t] * 3, b = this.triangles[t + 1] * 3, c = this.triangles[t + 2] * 3;
      // Barycentric coordinates of (y, z) in the triangle's projection onto the YZ plane.
      const d = (p[b + 1] - p[a + 1]) * (p[c + 2] - p[a + 2]) - (p[c + 1] - p[a + 1]) * (p[b + 2] - p[a + 2]);
      if (d === 0) continue;
      const u = ((y - p[a + 1]) * (p[c + 2] - p[a + 2]) - (p[c + 1] - p[a + 1]) * (z - p[a + 2])) / d;
      const v = ((p[b + 1] - p[a + 1]) * (z - p[a + 2]) - (y - p[a + 1]) * (p[b + 2] - p[a + 2])) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      if (p[a] + u * (p[b] - p[a]) + v * (p[c] - p[a]) <= x) continue;
      // Most parts are one piece: count plainly until a second piece turns up.
      if (first < 0) first = component;
      if (component === first && !mixed) { count++; continue; }
      if (!mixed) { mixed = true; crossings.set(first, count); }
      crossings.set(component, (crossings.get(component) ?? 0) + 1);
    }
    if (!mixed) return count % 2 === 1 ? [first] : [];
    return [...crossings].filter(([, n]) => n % 2 === 1).map(([component]) => component);
  }
  /**
   * Distance along a unit direction to the first triangle that `keep` accepts, out to `cap`;
   * Infinity when the ray meets none. Cells are gathered along the ray, then each triangle is hit
   * tested (Moller-Trumbore).
   */
  ray(x: number, y: number, z: number, dx: number, dy: number, dz: number, cap: number, keep?: (t: number) => boolean): number {
    const seen = new Set<number>(), p = this.points; let best = Infinity;
    for (let s = 0; s <= cap + this.cell && s <= best; s += this.cell * 0.5) {
      const cx = Math.floor((x + dx * s) / this.cell), cy = Math.floor((y + dy * s) / this.cell), cz = Math.floor((z + dz * s) / this.cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        for (const t of this.cells.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
          if (seen.has(t)) continue; seen.add(t);
          if (keep && !keep(t)) continue;
          const a = this.triangles[t] * 3, b = this.triangles[t + 1] * 3, c = this.triangles[t + 2] * 3;
          const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
          const h = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
          const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
          if (Math.abs(det) < 1e-12) continue;
          const f = 1 / det, o = [x - p[a], y - p[a + 1], z - p[a + 2]];
          const u = f * (o[0] * h[0] + o[1] * h[1] + o[2] * h[2]);
          if (u < 0 || u > 1) continue;
          const q = [o[1] * e1[2] - o[2] * e1[1], o[2] * e1[0] - o[0] * e1[2], o[0] * e1[1] - o[1] * e1[0]];
          const v = f * (dx * q[0] + dy * q[1] + dz * q[2]);
          if (v < 0 || u + v > 1) continue;
          const d = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
          if (d > 0 && d < best) best = d;
        }
      }
    }
    return best <= cap ? best : Infinity;
  }
  /** Component of a triangle (its first index into the triangle array). */
  componentOf(t: number): number { return this.component[t / 3]; }
  /**
   * Distance to the nearest triangle that `keep` accepts, searched out to `cap`; Infinity when none
   * is that close. `closest`, when given, receives the nearest surface point.
   */
  distance(x: number, y: number, z: number, cap: number, keep?: (t: number) => boolean, closest?: number[]): number {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
    const seen = new Set<number>(); let best = Infinity;
    for (let ring = 0; ring * this.cell - this.cell < Math.min(best, cap) && ring <= Math.ceil(cap / this.cell) + 1; ring++) {
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) for (let k = -ring; k <= ring; k++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== ring) continue;
        for (const t of this.cells.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
          if (seen.has(t)) continue; seen.add(t);
          if (keep && !keep(t)) continue;
          const point: number[] = [], d = pointTriangle(x, y, z, this.points, this.triangles[t] * 3, this.triangles[t + 1] * 3, this.triangles[t + 2] * 3, point);
          if (d < best) { best = d; if (closest) closest.splice(0, 3, ...point); }
        }
      }
    }
    return best;
  }
}

/** Distance from a point to a triangle (Ericson, Real-Time Collision Detection 5.1.5); `out` receives the closest point. */
function pointTriangle(px: number, py: number, pz: number, p: Float64Array, a: number, b: number, c: number, out: number[] = []): number {
  const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
  const ap = [px - p[a], py - p[a + 1], pz - p[a + 2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (s: number, t: number) => {
    out[0] = p[a] + s * ab[0] + t * ac[0]; out[1] = p[a + 1] + s * ab[1] + t * ac[1]; out[2] = p[a + 2] + s * ab[2] + t * ac[2];
    return Math.hypot(out[0] - px, out[1] - py, out[2] - pz);
  };
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = [px - p[b], py - p[b + 1], pz - p[b + 2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = [px - p[c], py - p[c + 1], pz - p[c + 2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return at(1 - w, w); }
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

/** Area-weighted vertex normals of posed points. */
function normals(points: Float64Array, triangles: Uint32Array): Float64Array {
  const out = new Float64Array(points.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const u = [points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2]];
    const v = [points[c] - points[a], points[c + 1] - points[a + 1], points[c + 2] - points[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) out[i + k] += n[k];
  }
  for (let i = 0; i < out.length; i += 3) {
    const length = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    for (let k = 0; k < 3; k++) out[i + k] /= length;
  }
  return out;
}

/** Self-check query points sit just off the surface, outward, so a point is never inside its own skin at rest. */
const SELF_OFFSET = 0.0005;

export async function checkGarments(bytes: Uint8Array, options: GarmentCheckOptions = {}): Promise<GarmentReport> {
  const samples = options.samples ?? 16, tolerance = options.tolerance ?? 0.002, selfRadius = options.selfRadius ?? 0.03;
  if (!Number.isInteger(samples) || samples < 1 || samples > 240) throw Object.assign(new Error('samples must be an integer from 1 to 240'), { code: 'CLI_ARGUMENT_ERROR' });
  if (!Number.isFinite(tolerance) || tolerance < 0) throw Object.assign(new Error('tolerance must be a nonnegative number of meters'), { code: 'CLI_ARGUMENT_ERROR' });
  const crossingDepth = options.crossingDepth ?? 0.004, crossingVertices = options.crossingVertices ?? 8;
  if (!Number.isFinite(crossingDepth) || crossingDepth < 0) throw Object.assign(new Error('crossingDepth must be a nonnegative number of meters'), { code: 'CLI_ARGUMENT_ERROR' });
  if (!Number.isInteger(crossingVertices) || crossingVertices < 1) throw Object.assign(new Error('crossingVertices must be a positive integer'), { code: 'CLI_ARGUMENT_ERROR' });
  const gltf = await new GLTFLoader().parseAsync(geometryOnly(bytes), '');
  const scene = gltf.scene; scene.updateMatrixWorld(true);
  const available = gltf.animations.map(clip => clip.name);
  const names = options.clips ?? available;
  const missing = names.filter(name => !available.includes(name));
  if (missing.length) throw Object.assign(new Error(`No clip named ${missing.join(', ')} (clips: ${available.join(', ') || 'none'})`), { code: 'GARMENT_CLIP' });
  const clips = names.map(name => gltf.animations.find(clip => clip.name === name)!) as AnimationClip[];
  const parts = collectParts(scene, options.garments ?? DEFAULT_GARMENTS, options.ignore);
  const volumes = (points: Float64Array[]) => parts.map((part, i) => (part.closed ? new Volume(points[i], part.triangles, part.triangleComponent) : null));
  const restPoints = parts.map(part => part.rest), restVolumes = volumes(restPoints);
  const restNormals = parts.map(part => normals(part.rest, part.triangles));
  // Pairs (intruder, container) worth checking, and which intruder vertices were already inside at rest.
  const pairs: { a: number; b: number; kind: IntrusionKind; inside: Uint8Array }[] = [];
  parts.forEach((a, i) => parts.forEach((b, j) => {
    if (!b.closed || (!a.garment && !b.garment)) return;
    const kind: IntrusionKind = i === j ? 'self' : a.garment && b.garment ? 'garment-garment' : 'garment-body';
    const inside = new Uint8Array(a.sources.length), points = restPoints[i], n = restNormals[i];
    // A piece spanning under three self radii (a lace, an eyelet, a button) has no far surface to fold
    // through; its kinks are bending, not a fold. Such vertices are left out of the self check.
    const small = new Set<number>();
    if (i === j) {
      const box = new Map<number, number[]>();
      for (let v = 0; v < inside.length; v++) {
        const c = a.vertexComponent[v], b = box.get(c) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], points[v * 3 + k]); b[k + 3] = Math.max(b[k + 3], points[v * 3 + k]); }
        box.set(c, b);
      }
      for (const [c, b] of box) if (Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < 3 * selfRadius) small.add(c);
    }
    for (let v = 0; v < inside.length; v++) {
      if (small.has(a.vertexComponent[v])) { inside[v] = 1; continue; }
      const offset = i === j ? SELF_OFFSET : 0, only = i === j ? a.vertexComponent[v] : undefined;
      inside[v] = restVolumes[j]!.contains(points[v * 3] + n[v * 3] * offset, points[v * 3 + 1] + n[v * 3 + 1] * offset, points[v * 3 + 2] + n[v * 3 + 2] * offset, only).length ? 1 : 0;
    }
    pairs.push({ a: i, b: j, kind, inside });
  }));
  const intrusions: Intrusion[] = restCrossings(parts, restVolumes, restNormals, crossingDepth, crossingVertices);
  const mixer = new AnimationMixer(scene);
  for (const clip of clips) {
    const action = mixer.clipAction(clip); action.play();
    for (let k = 0; k < samples; k++) {
      const phase = k / samples;
      mixer.setTime(phase * clip.duration); scene.updateMatrixWorld(true);
      const points = parts.map(posed), posedVolumes = volumes(points);
      const posedNormals = parts.map((part, i) => normals(points[i], part.triangles));
      for (const pair of pairs) {
        const volume = posedVolumes[pair.b]!, p = points[pair.a], n = posedNormals[pair.a], self = pair.kind === 'self';
        const rest = parts[pair.a].rest, triangles = parts[pair.b].triangles, own = parts[pair.a].vertexComponent;
        let count = 0, depth = 0, at: Vec3 = [0, 0, 0], from: Vec3 = [0, 0, 0];
        const listed: NonNullable<Intrusion['points']> = [];
        for (let v = 0; v < pair.inside.length; v++) {
          if (pair.inside[v]) continue;
          const offset = self ? SELF_OFFSET : 0;
          const x = p[v * 3] + n[v * 3] * offset, y = p[v * 3 + 1] + n[v * 3 + 1] * offset, z = p[v * 3 + 2] + n[v * 3 + 2] * offset;
          // A self-fold stays within one connected piece; merged pieces may overlap each other.
          const within = volume.contains(x, y, z, self ? own[v] : undefined);
          if (!within.length) continue;
          // Depth is to the containing pieces' surface; a fold's, to surface not next to the vertex along the
          // cloth. Cloth near in space but far along the surface (an arm against the torso side) still counts.
          const local = self ? nearby(parts[pair.a], v, selfRadius) : undefined;
          const keep = (t: number) => within.includes(volume.componentOf(t)) && (!local || [0, 1, 2].every(e => !local.has(triangles[t + e])));
          // No surface of its own far enough away: a small piece cannot fold through itself.
          let d = volume.distance(x, y, z, DEPTH_CAP, keep);
          if (d === Infinity && self) continue;
          // A pinch folds cloth over cloth right beside it, which the neighbourhood leaves out: the way
          // out along the vertex's own normal, through any surface but its own corner, also bounds the fold.
          if (self) d = Math.min(d, volume.ray(x, y, z, n[v * 3], n[v * 3 + 1], n[v * 3 + 2], DEPTH_CAP,
            t => within.includes(volume.componentOf(t)) && triangles[t] !== v && triangles[t + 1] !== v && triangles[t + 2] !== v));
          d = Math.min(d, DEPTH_CAP);
          if (d <= tolerance) continue;
          count++;
          if (options.points) listed.push({ from: [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]], at: [x, y, z], depth: d });
          if (d > depth) { depth = d; at = [x, y, z]; from = [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]]; }
        }
        if (count) intrusions.push({ clip: clip.name, phase, kind: pair.kind, part: parts[pair.a].name, into: parts[pair.b].name, vertices: count, depth, at, from, ...(options.points ? { points: listed } : {}) });
      }
    }
    action.stop();
  }
  const summary = new Map<string, PairSummary>();
  for (const hit of intrusions) {
    const key = `${hit.part}\u0000${hit.into}`, entry = summary.get(key);
    if (!entry) { summary.set(key, { part: hit.part, into: hit.into, kind: hit.kind, depth: hit.depth, vertices: hit.vertices, clips: [hit.clip], phases: [hit.phase] }); continue; }
    entry.depth = Math.max(entry.depth, hit.depth); entry.vertices = Math.max(entry.vertices, hit.vertices);
    if (!entry.clips.includes(hit.clip)) entry.clips.push(hit.clip);
    if (!entry.phases.includes(hit.phase)) entry.phases.push(hit.phase);
  }
  for (const entry of summary.values()) entry.phases.sort((a, b) => a - b);
  return {
    format: GARMENT_CHECK_FORMAT, ok: intrusions.length === 0, tolerance, samples, clips: names,
    parts: { garments: parts.filter(p => p.garment).map(p => p.name), bodies: parts.filter(p => !p.garment).map(p => p.name), open: parts.filter(p => !p.closed).map(p => p.name) },
    intrusions, pairs: [...summary.values()].sort((a, b) => b.depth - a.depth),
  };
}

/** A buried surface counts as covered when the way out of its container runs along its own normal. */
const COVER_ALIGN = 0.5;

/**
 * Garment pairs already showing through each other at rest. A vertex of one part inside another is
 * covered when the shortest way out runs along its own outward normal: that surface faced the viewer
 * and the other part now hides it. Layering covers one way only (a hem tucked in a shaft, a pocket
 * over a leg); a slab's embedded back face points inward and never counts. When each part covers a
 * patch of the other, they cross, and the inner one pokes out through the outer in jagged patches.
 * The report names the part with more of its surface covered first, and gives the smaller of the
 * two buried patches and depths. Body parts are left out: a hand leaving a glove is design.
 */
function restCrossings(parts: Part[], volumes: (Volume | null)[], normals: Float64Array[], deeper: number, patch: number): Intrusion[] {
  const covered = (i: number, j: number) => {
    const points = parts[i].rest, n = normals[i], volume = volumes[j]!, closest: number[] = [];
    let count = 0, depth = 0, at: Vec3 = [0, 0, 0];
    for (let v = 0; v < parts[i].sources.length; v++) {
      const x = points[v * 3], y = points[v * 3 + 1], z = points[v * 3 + 2];
      if (!volume.near(x, y, z)) continue;
      const within = volume.contains(x, y, z);
      if (!within.length) continue;
      const d = volume.distance(x, y, z, DEPTH_CAP, t => within.includes(volume.componentOf(t)), closest);
      if (d <= deeper || d === Infinity) continue;
      const out = ((closest[0] - x) * n[v * 3] + (closest[1] - y) * n[v * 3 + 1] + (closest[2] - z) * n[v * 3 + 2]) / d;
      if (out < COVER_ALIGN) continue;
      count++;
      if (d > depth) { depth = d; at = [x, y, z]; }
    }
    return { count, depth, at };
  };
  const found: Intrusion[] = [];
  parts.forEach((a, i) => parts.forEach((b, j) => {
    if (j <= i || !a.closed || !b.closed || !a.garment || !b.garment) return;
    const ab = covered(i, j); if (ab.count < patch) return;
    const ba = covered(j, i); if (ba.count < patch) return;
    const [inner, outer, hidden] = ab.count / a.sources.length >= ba.count / b.sources.length ? [a, b, ba] : [b, a, ab];
    const kind: IntrusionKind = 'rest-crossing';
    found.push({ clip: 'rest', phase: 0, kind, part: inner.name, into: outer.name, vertices: Math.min(ab.count, ba.count), depth: Math.min(ab.depth, ba.depth), at: hidden.at, from: hidden.at });
  }));
  return found;
}

/** One line per offending pair, deepest first, for a terminal. */
export function garmentSummary(report: GarmentReport): string[] {
  return report.pairs.map(pair => pair.kind === 'rest-crossing'
    ? `rest-crossing: ${pair.part} and ${pair.into} show through each other at rest, each hiding ${pair.vertices}+ outward-facing vertices of the other up to ${(pair.depth * 1000).toFixed(1)} mm deep`
    : `${pair.kind}: ${pair.part} into ${pair.into}, ${(pair.depth * 1000).toFixed(1)} mm deep, up to ${pair.vertices} vertices, ${pair.clips.join('/')} phases ${pair.phases.map(p => +p.toFixed(4)).join(', ')}`);
}
