import { AnimationMixer, Mesh, PropertyBinding, SkinnedMesh, Vector3 } from 'three';
import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Enclosure verifier: a helmet (or dome, jar, cockpit) must hold what it declares at every pose the file can play.
 *
 * A node declares it in its glTF extras:
 *   "encloses": { "parts": ["face", "left-ear", ...], "clearance": 0.015, "maxClearance": 0.04, "with": ["helmet-shell"] }
 * The enclosure surface is that node's mesh plus the meshes named in `with` (for example the opaque back of a
 * glass bubble). Every vertex of every named part must stay at least `clearance` metres inside that surface at
 * rest, at sampled phases of every clip, and with each morph target alone at full weight; `maxClearance`, when
 * given, also fails an enclosure whose closest approach to anything it holds is farther than that (a helmet far
 * bigger than its head). Vertices are posed as three.js poses them (skinning and morphs), so a verdict here is
 * what the viewer shows.
 *
 * Inside and outside are judged against the enclosure's vertex centroid: a vertex is outside when it lies beyond
 * its closest surface point as seen from that centre, so the enclosure must be star-shaped around its centroid
 * (bubbles, domes and capsules are). An opening (a helmet's neck) is not glass: a vertex whose closest surface
 * point is on the open border, or that lies in a direction the surface does not cover, counts as inside.
 */
export interface EnclosureDeclaration { parts: string[]; clearance: number; maxClearance?: number; with?: string[] }
export interface EnclosureApproach { pose: string; part: string; vertex: number; clearance: number }
export interface EnclosureReport {
  enclosure: string; parts: string[]; with: string[]; clearance: number; maxClearance: number | null;
  /** Poses sampled: rest, every clip phase, every morph target. */
  poses: number;
  /** The closest approach over every held part and pose (negative when a vertex is outside). */
  closest: EnclosureApproach;
  /** Each held part's closest approach. */
  byPart: Record<string, EnclosureApproach>;
  ok: boolean; problems: string[];
}
export interface EnclosuresReport { ok: boolean; enclosures: EnclosureReport[]; failures: string[] }

/** Uniform phases sampled per clip, besides every keyframe time. */
export const ENCLOSURE_PHASES = 24;
const MAX_SAMPLES_PER_CLIP = 240;
/** Far vertices refined exactly per part and pose: the ones the radius map puts closest to (or beyond) the surface. */
const REFINE = 8;
/** Direction bins of the centre-to-surface radius map: LAT rows of 2 * LAT columns (3 degrees). */
const LAT = 60, BIN = Math.PI / LAT;

const mm = (metres: number) => (metres * 1000).toFixed(1);
const mmShort = (metres: number) => mm(metres).replace(/\.0$/, '');

function declarationProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['extras.encloses must be an object'];
  const d = value as Record<string, unknown>, problems: string[] = [];
  const names = (key: string, required: boolean) => {
    const list = d[key];
    if (list === undefined && !required) return;
    if (!Array.isArray(list) || (required && !list.length) || !list.every(n => typeof n === 'string' && n)) problems.push(`extras.encloses.${key} must be a ${required ? 'non-empty ' : ''}list of node names`);
  };
  names('parts', true); names('with', false);
  if (typeof d.clearance !== 'number' || !Number.isFinite(d.clearance) || d.clearance <= 0) problems.push('extras.encloses.clearance must be a positive number of metres');
  if (d.maxClearance !== undefined && (typeof d.maxClearance !== 'number' || !Number.isFinite(d.maxClearance) || d.maxClearance <= Number(d.clearance))) problems.push('extras.encloses.maxClearance must be a number of metres above clearance');
  return problems;
}

function meshesUnder(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
  return meshes;
}

/** Squared distance from p to triangle `t` of `tri` (9 floats each); the closest point goes to `out` (Ericson 5.1.5). */
function closestOnTriangle(tri: Float64Array, t: number, px: number, py: number, pz: number, out: Float64Array): number {
  const o = t * 9, ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
  const abx = tri[o + 3] - ax, aby = tri[o + 4] - ay, abz = tri[o + 5] - az, acx = tri[o + 6] - ax, acy = tri[o + 7] - ay, acz = tri[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  let u: number, v: number;
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
  else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - v; }
  else { const denom = 1 / (va + vb + vc); u = vb * denom; v = vc * denom; }
  out[0] = ax + abx * u + acx * v; out[1] = ay + aby * u + acy * v; out[2] = az + abz * u + acz * v;
  const dx = px - out[0], dy = py - out[1], dz = pz - out[2];
  return dx * dx + dy * dy + dz * dz;
}

/** World-space vertex positions of a mesh as posed now (morphs and skinning applied), 3 floats each. */
function posedVertices(mesh: Mesh): Float64Array {
  const position = mesh.geometry.getAttribute('position'), out = new Float64Array(position.count * 3), v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

/**
 * Triangle indices of a mesh and, per triangle, a bit per edge (ab, bc, ca) on its open border. Found once from rest
 * positions, welded, so a mesh that splits vertices for normals or UVs has no false border.
 */
const topologies = new WeakMap<Mesh, { order: Uint32Array; border: Uint8Array }>();
function topology(mesh: Mesh): { order: Uint32Array; border: Uint8Array } {
  const cached = topologies.get(mesh);
  if (cached) return cached;
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex();
  const order = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: position.count }, (_, i) => i);
  const weld = new Map<string, number>(), id = new Uint32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`;
    let value = weld.get(key); if (value === undefined) { value = weld.size; weld.set(key, value); }
    id[i] = value;
  }
  const edge = (a: number, b: number) => { const x = id[a], y = id[b]; return x < y ? x * weld.size + y : y * weld.size + x; };
  const uses = new Map<number, number>();
  for (let i = 0; i + 2 < order.length; i += 3) for (let e = 0; e < 3; e++) { const k = edge(order[i + e], order[i + (e + 1) % 3]); uses.set(k, (uses.get(k) ?? 0) + 1); }
  const border = new Uint8Array(Math.floor(order.length / 3));
  for (let i = 0; i + 2 < order.length; i += 3) for (let e = 0; e < 3; e++) if (uses.get(edge(order[i + e], order[i + (e + 1) % 3])) === 1) border[i / 3] |= 1 << e;
  const result = { order, border };
  topologies.set(mesh, result);
  return result;
}

/**
 * Signed distance queries against a posed triangle surface, positive inside. Exact within `reach` (a uniform grid of
 * triangles); farther points are judged inside or outside by a centre-to-surface radius map and given the radial
 * gap (never less than `reach`), which `exact` refines where it matters.
 */
class Surface {
  private tri: Float64Array;
  private open: Uint8Array; // per triangle, a bit per edge (ab, bc, ca) on the open border
  private cells: Int32Array[];
  private lo = [Infinity, Infinity, Infinity];
  private dims: number[];
  private size: number;
  private radius = new Float64Array(LAT * LAT * 2).fill(Infinity);
  private center = [0, 0, 0];
  private stamp: Uint32Array; private query = 0;
  private q = new Float64Array(3); private keep = new Float64Array(3);
  private count: number;

  private reach: number;

  constructor(meshes: Mesh[], reach: number) {
    this.reach = reach;
    const tris: number[] = [], open: number[] = [];
    let vertices = 0;
    for (const mesh of meshes) {
      const v = posedVertices(mesh), { order, border } = topology(mesh);
      for (let i = 0; i < v.length; i++) this.center[i % 3] += v[i];
      vertices += v.length / 3;
      for (let i = 0; i + 2 < order.length; i += 3) {
        for (let e = 0; e < 3; e++) for (let k = 0; k < 3; k++) tris.push(v[order[i + e] * 3 + k]);
        open.push(border[i / 3]);
      }
    }
    for (let k = 0; k < 3; k++) this.center[k] /= Math.max(vertices, 1);
    this.tri = Float64Array.from(tris); this.open = Uint8Array.from(open); this.count = open.length;
    this.stamp = new Uint32Array(this.count);
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.tri.length; i++) { const k = i % 3; this.lo[k] = Math.min(this.lo[k], this.tri[i]); hi[k] = Math.max(hi[k], this.tri[i]); }
    this.size = Math.max(reach / 2, Math.max(hi[0] - this.lo[0], hi[1] - this.lo[1], hi[2] - this.lo[2]) / 64, 1e-4);
    this.dims = [0, 1, 2].map(k => Math.max(1, Math.floor((hi[k] - this.lo[k]) / this.size) + 1));
    const buckets: number[][] = Array.from({ length: this.dims[0] * this.dims[1] * this.dims[2] }, () => []);
    for (let t = 0; t < this.count; t++) {
      const o = t * 9, cell = (k: number, pick: (...values: number[]) => number) => Math.floor((pick(this.tri[o + k], this.tri[o + 3 + k], this.tri[o + 6 + k]) - this.lo[k]) / this.size);
      for (let x = cell(0, Math.min); x <= cell(0, Math.max); x++) for (let y = cell(1, Math.min); y <= cell(1, Math.max); y++)
        for (let z = cell(2, Math.min); z <= cell(2, Math.max); z++) buckets[(x * this.dims[1] + y) * this.dims[2] + z].push(t);
    }
    this.cells = buckets.map(list => Int32Array.from(list));
    // Radius map: the nearest surface along each direction from the centre, from barycentric samples of every triangle.
    const t9 = this.tri, [cx, cy, cz] = this.center;
    for (let o = 0; o < t9.length; o += 9) {
      const ax = t9[o] - cx, ay = t9[o + 1] - cy, az = t9[o + 2] - cz, bx = t9[o + 3] - cx, by = t9[o + 4] - cy, bz = t9[o + 5] - cz;
      const qx = t9[o + 6] - cx, qy = t9[o + 7] - cy, qz = t9[o + 8] - cz;
      const near = Math.max(1e-6, Math.min(Math.hypot(ax, ay, az), Math.hypot(bx, by, bz), Math.hypot(qx, qy, qz)));
      const span = Math.max(Math.hypot(ax - bx, ay - by, az - bz), Math.hypot(bx - qx, by - qy, bz - qz), Math.hypot(qx - ax, qy - ay, qz - az));
      const steps = Math.min(32, Math.max(1, Math.ceil(span / (near * BIN * 0.5))));
      for (let i = 0; i <= steps; i++) for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        const x = w * ax + u * bx + v * qx, y = w * ay + u * by + v * qy, z = w * az + u * bz + v * qz;
        const bin = this.bin(x, y, z), r = Math.hypot(x, y, z);
        if (r < this.radius[bin]) this.radius[bin] = r;
      }
    }
  }

  private bin(x: number, y: number, z: number): number {
    const r = Math.hypot(x, y, z) || 1;
    const lat = Math.min(LAT - 1, Math.floor(Math.acos(Math.max(-1, Math.min(1, y / r))) / BIN));
    const lon = Math.min(2 * LAT - 1, Math.floor((Math.atan2(x, z) + Math.PI) / BIN));
    return lat * 2 * LAT + lon;
  }

  /** Signs a distance by the centre rule; a closest point on an open edge is beside the opening, so inside. */
  private signed(px: number, py: number, pz: number, q: Float64Array, distance: number, triangle: number): number {
    const outward = (px - q[0]) * (q[0] - this.center[0]) + (py - q[1]) * (q[1] - this.center[1]) + (pz - q[2]) * (q[2] - this.center[2]);
    if (outward <= 0) return distance;
    const bits = this.open[triangle], o = triangle * 9;
    for (let e = 0; e < 3; e++) {
      if (!(bits & (1 << e))) continue;
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      const ex = this.tri[b] - this.tri[a], ey = this.tri[b + 1] - this.tri[a + 1], ez = this.tri[b + 2] - this.tri[a + 2];
      const qx = q[0] - this.tri[a], qy = q[1] - this.tri[a + 1], qz = q[2] - this.tri[a + 2];
      if (Math.hypot(qy * ez - qz * ey, qz * ex - qx * ez, qx * ey - qy * ex) <= 1e-9 * Math.max(1e-6, Math.hypot(ex, ey, ez))) return distance;
    }
    return -distance;
  }

  /** Signed distance, exact when within `reach` of the surface. */
  near(px: number, py: number, pz: number): { distance: number; exact: boolean } {
    const rings = Math.ceil(this.reach / this.size), g = [px, py, pz].map((v, k) => Math.floor((v - this.lo[k]) / this.size));
    let best = Infinity, triangle = -1;
    if (++this.query === 0xffffffff) { this.stamp.fill(0); this.query = 1; }
    for (let x = Math.max(0, g[0] - rings); x <= Math.min(this.dims[0] - 1, g[0] + rings); x++)
      for (let y = Math.max(0, g[1] - rings); y <= Math.min(this.dims[1] - 1, g[1] + rings); y++)
        for (let z = Math.max(0, g[2] - rings); z <= Math.min(this.dims[2] - 1, g[2] + rings); z++) {
          for (const t of this.cells[(x * this.dims[1] + y) * this.dims[2] + z]) {
            if (this.stamp[t] === this.query) continue; this.stamp[t] = this.query;
            const d = closestOnTriangle(this.tri, t, px, py, pz, this.q);
            if (d < best) { best = d; triangle = t; this.keep.set(this.q); }
          }
        }
    const distance = Math.sqrt(best);
    if (distance <= this.reach) return { distance: this.signed(px, py, pz, this.keep, distance, triangle), exact: true };
    const x = px - this.center[0], y = py - this.center[1], z = pz - this.center[2], surface = this.radius[this.bin(x, y, z)];
    if (!Number.isFinite(surface)) return { distance: this.reach, exact: false };
    const gap = surface - Math.hypot(x, y, z);
    return { distance: gap >= 0 ? Math.max(gap, this.reach) : Math.min(gap, -this.reach), exact: false };
  }

  /** Exact signed distance, testing every triangle. */
  exact(px: number, py: number, pz: number): number {
    let best = Infinity, triangle = -1;
    for (let t = 0; t < this.count; t++) { const d = closestOnTriangle(this.tri, t, px, py, pz, this.q); if (d < best) { best = d; triangle = t; this.keep.set(this.q); } }
    return triangle < 0 ? Infinity : this.signed(px, py, pz, this.keep, Math.sqrt(best), triangle);
  }
}

interface Pose { label: string; apply(): void }

function clipTimes(clip: AnimationClip): number[] {
  const times = new Set<number>();
  for (let i = 0; i < ENCLOSURE_PHASES; i++) times.add(clip.duration * i / ENCLOSURE_PHASES);
  for (const track of clip.tracks) for (const t of track.times) times.add(t);
  const sorted = [...times].filter(t => t >= 0 && t <= clip.duration).sort((a, b) => a - b);
  if (sorted.length <= MAX_SAMPLES_PER_CLIP) return sorted;
  return Array.from({ length: MAX_SAMPLES_PER_CLIP }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (MAX_SAMPLES_PER_CLIP - 1))]);
}

/** Check every `extras.encloses` declaration in a GLB. A file that declares none passes with nothing to check. */
export async function verifyEnclosures(bytes: Uint8Array): Promise<EnclosuresReport> {
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  const scene = gltf.scene;
  const declaring: Object3D[] = [];
  scene.traverse(object => { if (object.userData?.encloses !== undefined) declaring.push(object); });
  if (!declaring.length) return { ok: true, enclosures: [], failures: [] };

  // Rest state, restored before every pose.
  const nodes: Object3D[] = []; scene.traverse(object => nodes.push(object));
  const rest = nodes.map(o => [o.position.clone(), o.quaternion.clone(), o.scale.clone()] as const);
  const meshes = nodes.filter((o): o is Mesh => o instanceof Mesh);
  const restWeights = meshes.map(m => m.morphTargetInfluences?.slice() ?? []);
  const reset = () => {
    nodes.forEach((o, i) => { o.position.copy(rest[i][0]); o.quaternion.copy(rest[i][1]); o.scale.copy(rest[i][2]); });
    meshes.forEach((m, i) => { if (m.morphTargetInfluences) m.morphTargetInfluences.splice(0, Infinity, ...restWeights[i]); });
  };
  const settle = () => {
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
  };

  const poses: Pose[] = [{ label: 'rest', apply: () => {} }];
  const mixer = new AnimationMixer(scene);
  for (const clip of gltf.animations) for (const time of clipTimes(clip)) {
    poses.push({
      label: `clip ${clip.name} @ ${time.toFixed(2)} s`,
      apply: () => { mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.setTime(time); },
    });
  }
  const morphNames = [...new Set(meshes.flatMap(m => Object.keys(m.morphTargetDictionary ?? {})))].sort();
  for (const name of morphNames) poses.push({
    label: `morph ${name} = 1`,
    apply: () => { for (const m of meshes) { const i = m.morphTargetDictionary?.[name]; if (i !== undefined && m.morphTargetInfluences) m.morphTargetInfluences[i] = 1; } },
  });

  // A bone may share a part's name (a `head` bone and a `head` mesh, which the loader renames `head_1`):
  // the part is the object with geometry whose glTF name matches.
  const find = (name: string) => {
    const wanted = PropertyBinding.sanitizeNodeName(name); let found: Object3D | undefined;
    scene.traverse(object => { if (!found && (object.userData?.name === name || object.name === wanted) && meshesUnder(object).length) found = object; });
    return found;
  };
  const enclosures: EnclosureReport[] = [], failures: string[] = [];
  for (const node of declaring) {
    const label = String(node.userData.name ?? node.name);
    const problems = declarationProblems(node.userData.encloses);
    const declaration = node.userData.encloses as EnclosureDeclaration;
    const valid = !problems.length;
    const withNames = valid ? declaration.with ?? [] : [], parts = valid ? declaration.parts : [];
    const held = new Map<string, Mesh[]>(), shell: Mesh[] = meshesUnder(node);
    for (const name of parts) { const object = find(name); if (!object) problems.push(`encloses ${name}, which the file lacks as a mesh`); else held.set(name, meshesUnder(object)); }
    for (const name of withNames) { const object = find(name); if (!object) problems.push(`is closed with ${name}, which the file lacks as a mesh`); else shell.push(...meshesUnder(object)); }
    const byPart: Record<string, EnclosureApproach> = {};
    let closest: EnclosureApproach = { pose: 'rest', part: '', vertex: -1, clearance: Infinity };
    let sampled = 0;
    if (!problems.length) {
      const reach = Math.max(declaration.clearance, declaration.maxClearance ?? 0) + 0.01;
      for (const pose of poses) {
        reset(); pose.apply(); settle(); sampled++;
        const surface = new Surface(shell, reach);
        const note = (name: string, vertex: number, clearance: number) => {
          if (!byPart[name] || clearance < byPart[name].clearance) byPart[name] = { pose: pose.label, part: name, vertex, clearance };
          if (clearance < closest.clearance) closest = { pose: pose.label, part: name, vertex, clearance };
        };
        for (const [name, list] of held) {
          const far: { vertex: number; gap: number; x: number; y: number; z: number }[] = [];
          let base = 0;
          for (const mesh of list) {
            const v = posedVertices(mesh), n = v.length / 3;
            for (let i = 0; i < n; i++) {
              const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2], { distance, exact } = surface.near(x, y, z);
              if (exact) note(name, base + i, distance); else far.push({ vertex: base + i, gap: distance, x, y, z });
            }
            base += n;
          }
          far.sort((a, b) => a.gap - b.gap);
          for (const f of far.slice(0, REFINE)) note(name, f.vertex, surface.exact(f.x, f.y, f.z));
        }
      }
      mixer.stopAllAction(); reset();
      for (const approach of Object.values(byPart)) {
        if (approach.clearance < 0) problems.push(`${approach.part} pokes ${mm(-approach.clearance)} mm outside the glass at ${approach.pose}`);
        else if (approach.clearance < declaration.clearance) problems.push(`${approach.part} comes within ${mm(approach.clearance)} mm of the glass at ${approach.pose} (needs ${mmShort(declaration.clearance)} mm)`);
      }
      if (declaration.maxClearance !== undefined && closest.clearance > declaration.maxClearance) {
        problems.push(`the closest part is ${mm(closest.clearance)} mm from the glass (at most ${mmShort(declaration.maxClearance)} mm): the enclosure is larger than what it holds`);
      }
    }
    failures.push(...problems.map(problem => `${label}: ${problem}`));
    enclosures.push({
      enclosure: label, parts, with: withNames, clearance: valid ? declaration.clearance : 0, maxClearance: valid ? declaration.maxClearance ?? null : null,
      poses: sampled, closest, byPart, ok: !problems.length, problems,
    });
  }
  return { ok: !failures.length, enclosures, failures };
}
