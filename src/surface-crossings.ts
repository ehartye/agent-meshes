/** Strict surface crossings, rather than contact or visibility through an opening.
 * Both surfaces must straddle the other's plane; a shared lip/lining boundary is allowed.
 * This does not prove that a disconnected part is enclosed, or sweep between poses. */
export interface CrossingSurface { label: string; points: Float64Array; triangles: Uint32Array; sourceTriangles?: Uint32Array }
export interface SurfaceCrossing { part: string; skin: string; triangle: number; skinTriangle: number; at: number[] }
type V = [number, number, number];
interface Tri { surface: CrossingSurface; index: number; ids: [number, number, number]; p: V[]; normal: V; lo: V; hi: V; neighbors?: Tri[][]; link?: { built: boolean; build(): void } }
interface Tree { lo: V; hi: V; children?: [Tree, Tree]; tris?: Tri[] }
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const overlap = (a: {lo: V; hi: V}, b: {lo: V; hi: V}) => [0, 1, 2].every(k => a.lo[k] <= b.hi[k] && b.lo[k] <= a.hi[k]);

function triangles(surface: CrossingSurface, window?: { lo: V; hi: V }): Tri[] {
  const out: Tri[] = [];
  for (let index = 0; index < surface.triangles.length / 3; index++) {
    const a = surface.triangles[index * 3] * 3, b = surface.triangles[index * 3 + 1] * 3, c = surface.triangles[index * 3 + 2] * 3, q = surface.points;
    const lo: V = [Math.min(q[a], q[b], q[c]), Math.min(q[a + 1], q[b + 1], q[c + 1]), Math.min(q[a + 2], q[b + 2], q[c + 2])];
    const hi: V = [Math.max(q[a], q[b], q[c]), Math.max(q[a + 1], q[b + 1], q[c + 1]), Math.max(q[a + 2], q[b + 2], q[c + 2])];
    // Cull against the window before building any per-triangle arrays: most skin triangles lie far from the mouth.
    if (window && !overlap({ lo, hi }, window)) continue;
    const p: V[] = [[q[a], q[a + 1], q[a + 2]], [q[b], q[b + 1], q[b + 2]], [q[c], q[c + 1], q[c + 2]]];
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0])), length = Math.hypot(...n);
    if (length <= 1e-20) continue; // Degenerate triangles are diagnosed by the inversion check.
    out.push({ surface, index, ids: [a / 3, b / 3, c / 3], p, normal: n.map(v => v / length) as V, lo, hi });
  }
  return out;
}

function tree(tris: Tri[]): Tree {
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t.lo[k]); hi[k] = Math.max(hi[k], t.hi[k]); }
  if (tris.length <= 12) return { lo, hi, tris };
  const axis = [0, 1, 2].sort((a, b) => (hi[b] - lo[b]) - (hi[a] - lo[a]))[0];
  tris.sort((a, b) => (a.lo[axis] + a.hi[axis]) - (b.lo[axis] + b.hi[axis]));
  const middle = Math.floor(tris.length / 2);
  return { lo, hi, children: [tree(tris.slice(0, middle)), tree(tris.slice(middle))] };
}

/** Weld identical positions across primitive/UV seams for edge ownership. Internal
 * triangulation edges are not surface boundaries and must not hide a crossing.
 * Each distinct vertex is keyed by its position once, then an edge by its two weld ids as a number.
 * Ownership is only read when a vertex lies within tolerance of the other triangle's plane, so it is built on first use. */
function connect(tris: Tri[]): void {
  const link = { built: false, build() { link.built = true; ownership(tris); } };
  for (const t of tris) t.link = link;
}

function ownership(tris: Tri[]): void {
  const welds = new Map<string, number>(), perSurface = new Map<CrossingSurface, Int32Array>(), edges = new Map<number, Tri[]>();
  const weld = (t: Tri, k: number): number => {
    let ids = perSurface.get(t.surface);
    if (!ids) { ids = new Int32Array(t.surface.points.length / 3).fill(-1); perSurface.set(t.surface, ids); }
    const vertex = t.ids[k];
    if (ids[vertex] < 0) {
      const key = t.p[k][0] + ',' + t.p[k][1] + ',' + t.p[k][2];
      let id = welds.get(key);
      if (id === undefined) { id = welds.size; welds.set(key, id); }
      ids[vertex] = id;
    }
    return ids[vertex];
  };
  const keys = new Map<Tri, number[]>();
  for (const t of tris) {
    const w = [weld(t, 0), weld(t, 1), weld(t, 2)];
    const edge = [0, 1, 2].map(i => Math.min(w[i], w[(i + 1) % 3]) * 67108864 + Math.max(w[i], w[(i + 1) % 3]));
    keys.set(t, edge);
    for (const key of edge) { const owners = edges.get(key); if (owners) owners.push(t); else edges.set(key, [t]); }
  }
  for (const t of tris) t.neighbors = keys.get(t)!.map(key => edges.get(key)!);
}

const PLANE_EPSILON = 1e-10;
function straddles(t: Tri, plane: Tri, distances: number[], tolerance: number): boolean {
  let low = Math.min(distances[0], distances[1], distances[2]), high = Math.max(distances[0], distances[1], distances[2]);
  if (low < -tolerance && high > tolerance) return true;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(distances[i]) > tolerance || Math.abs(distances[(i + 1) % 3]) > tolerance) continue;
    if (t.link && !t.link.built) t.link.build();
    for (const neighbor of t.neighbors?.[i] ?? []) for (const p of neighbor.p) {
      const d = dot(sub(p, plane.p[0]), plane.normal); low = Math.min(low, d); high = Math.max(high, d);
    }
    if (low < -tolerance && high > tolerance) return true;
  }
  return false;
}

/** Intersection with the other plane, in world coordinates. */
function cut(p: V[], d: number[]): V[] {
  d = d.map(v => Math.abs(v) <= PLANE_EPSILON ? 0 : v);
  const out: V[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if (d[i] === 0) out.push(p[i]);
    if (d[i] * d[j] < 0) {
      const t = d[i] / (d[i] - d[j]);
      out.push(p[i].map((v, k) => v + t * (p[j][k] - v)) as V);
    }
  }
  return out;
}

function intersection(a: Tri, b: Tri, tolerance: number): V | null {
  const da = a.p.map(p => dot(sub(p, b.p[0]), b.normal));
  const db = b.p.map(p => dot(sub(p, a.p[0]), a.normal));
  // Ignore coplanar overlap and tangencies. Neither is evidence of passing through skin.
  if (!straddles(a, b, da, tolerance) || !straddles(b, a, db, tolerance)) return null;
  const line = cross(a.normal, b.normal), length = Math.hypot(...line);
  if (length < 1e-12) return null;
  const axis = line.map(v => v / length) as V;
  const ac = cut(a.p, da), bc = cut(b.p, db);
  if (ac.length < 2 || bc.length < 2) return null;
  const av = ac.map(p => dot(p, axis)), bv = bc.map(p => dot(p, axis));
  const low = Math.max(Math.min(...av), Math.min(...bv)), high = Math.min(Math.max(...av), Math.max(...bv));
  if (high - low <= tolerance) return null;
  const distance = (low + high) / 2 - av[0];
  return ac[0].map((v, k) => v + axis[k] * distance) as V;
}

/** Returns bounded examples with original primitive triangle indices; no all-clear for enclosure is implied. */
export function surfaceCrossings(skin: CrossingSurface[], parts: CrossingSurface[], tolerance = 1e-6, limit = 20): SurfaceCrossing[] {
  const partTriangles = parts.flatMap(s => triangles(s));
  if (!partTriangles.length) return [];
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const t of partTriangles) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t.lo[k]); hi[k] = Math.max(hi[k], t.hi[k]); }
  // Keep neighboring triangles through the same tolerance used for straddling.
  // Otherwise moving across a tessellation edge by a tiny amount drops its owner
  // before the adjacency check and hides an arbitrarily deep crossing.
  const window = { lo: lo.map(v => v - tolerance) as V, hi: hi.map(v => v + tolerance) as V };
  const skinTriangles = skin.flatMap(s => triangles(s, window));
  if (!skinTriangles.length) return [];
  connect(skinTriangles); connect(partTriangles);
  const root = tree(skinTriangles), found: SurfaceCrossing[] = [];
  const visit = (node: Tree, part: Tri) => {
    if (found.length >= limit || !overlap(node, part)) return;
    if (node.children) { visit(node.children[0], part); visit(node.children[1], part); return; }
    for (const s of node.tris!) {
      if (!overlap(s, part)) continue;
      const at = intersection(s, part, tolerance);
      if (at) found.push({ part: part.surface.label, skin: s.surface.label,
        triangle: part.surface.sourceTriangles?.[part.index] ?? part.index,
        skinTriangle: s.surface.sourceTriangles?.[s.index] ?? s.index, at });
      if (found.length >= limit) return;
    }
  };
  for (const t of partTriangles) { visit(root, t); if (found.length >= limit) return found; }
  return found;
}
