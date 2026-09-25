/**
 * Attached parts for `arkit-face/1`: every small part joined to a face (brows, brow ridges, nostrils, freckles, fins)
 * must sit on the skin at rest and while each morph plays, with no air gap and without sinking out of sight.
 *
 * Parts are found by geometry, not names: the face's surfaces are welded by position into connected pieces. A piece
 * is part of an eye when an eye morph moves it (lids, shutters), it is named `socket`, or it lies wholly inside the
 * reach of that eye's lids (a shutter housing); part of the mouth when it is teeth, tongue or cavity; skin when it is
 * at least a third the size of the largest piece (a head, a skull or chin plate, a hair cap). Every other piece is an
 * attached part, and it is judged against the skin and the lids (a lowered brow may rest on a lid). A part that fails
 * there but sits on a larger attached part that passes (a nostril on a nose ball) is judged against that host too.
 *
 * Contact is measured along the part's length: its surface is sampled densely and cut into slices across its longest
 * axis, and every slice must come within `ATTACH_TOLERANCE` of the skin (or dip into it). A ridge that touches the
 * skin at one end and hangs over it elsewhere fails, as does one hovering over the whole dome (round 4). Only an
 * appendage (an ear or fin beside or behind the eyes, a horn that rises from the skin further than its base spreads
 * along it) need touch the skin just at its root.
 *
 * A part seated in the skin must also be sealed across its width: along its length, wherever it dips more than
 * `ATTACH_TOLERANCE` into the skin, its surface that faces the skin must not stand out of it (a ridge pushed off its dome
 * still dips in along its middle, while its underside hangs off it). A part resting on the skin (a round tube) is
 * judged by its gap alone.
 *
 * While a morph plays, the skin under a part must not slide away beneath it: where the part touches the skin at rest,
 * the skin's own delta there is compared with the part's, and skin moving more than `ATTACH_TOLERANCE` under a part
 * that stays (moves less than half as far) fails; attach_to_skin gives each part vertex exactly the skin's delta there.
 */
export const ATTACH_TOLERANCE = 0.0005;
/** A morph that leaves less than this share of a part's rest visibility above the skin buries it. */
export const ATTACH_MIN_VISIBLE = 0.5;
const STANDS_OUT = 0.003, BASE_SHARE = 1 / 3, SLICE = 0.0015, MAX_SLICES = 32, SAMPLE = 0.0015, CELL = 0.002, SEARCH = 0.012, SKIN_SHARE = 1 / 3, EYE_REACH = 1.1;

export interface AttachSurface {
  label: string; names: string[]; count: number; rest: Float64Array; targets: Map<string, Float64Array>; triangles: Uint32Array;
}
export interface AttachEye { center: [number, number, number]; radius: number; suffix: 'Left' | 'Right' }
/** One attached part: where it is, which morphs move it, and its worst slice gap over rest and every morph at weight 1 (m). */
export interface AttachedPart {
  part: string; vertices: number; center: number[]; morphs: string[]; restGap: number; gap: number; worst: string; poses: number;
  restVisible: number;
  /**
   * `lies` for a part on the face: brows, ridges (however heavy), nostrils, which must touch the skin along their whole
   * length; `root` for an appendage beside or behind the eyes (an ear, a fin) or one that rises out of the skin more
   * than 3 mm and further than its base spreads along the skin (a horn at a brow corner), which may stand out from the
   * head but must touch it somewhere.
   */
  contact: 'lies' | 'root';
  /** How far the part rises above the skin (or its own underside, when it floats), and how far its base (the lowest third of that rise) spreads along the skin (m). */
  rise: number; base: number;
  /** How far the underside of a part lying on the face stands out of the skin it is seated in at rest, in slices that dip into it (0 when sealed) (m). */
  overhang: number;
  /** The most the skin slides under the part, while it stays, at any morph at weight 1 (m). */
  slide: number;
  /** The attached part(s) this one sits on, when it touches them rather than the skin (a nostril on a nose ball). */
  host?: string;
}
export interface AttachReport { parts: AttachedPart[]; problems: string[] }

const mm = (value: number) => `${(value * 1000).toFixed(2)} mm`;
const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const LID_MORPHS = ['Left', 'Right'].flatMap(side => ['eyeBlink', 'eyeSquint', 'eyeWide'].map(m => `${m}${side}`));
const mouthName = (n: string) => /teeth|tooth|tongue|cavity|throat|mouth[_ -]?interior/i.test(n);
const socketName = (n: string) => /socket/i.test(n);

class UnionFind {
  parent: Int32Array;
  constructor(size: number) { this.parent = Int32Array.from({ length: size }, (_, i) => i); }
  find(i: number): number { while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; } return i; }
  union(a: number, b: number) { const x = this.find(a), y = this.find(b); if (x !== y) this.parent[x] = y; }
}

interface Piece { tris: [number, number][]; verts: [number, number][]; lo: number[]; hi: number[]; kind: 'eye' | 'lid' | 'mouth' | 'skin' | 'part' }

/** Closest point on triangle abc to p (Ericson), written into out; returns the squared distance. */
function closest(p: number[], a: number[], b: number[], c: number[], out: number[]): number {
  const ab0 = b[0] - a[0], ab1 = b[1] - a[1], ab2 = b[2] - a[2], ac0 = c[0] - a[0], ac1 = c[1] - a[1], ac2 = c[2] - a[2];
  const ap0 = p[0] - a[0], ap1 = p[1] - a[1], ap2 = p[2] - a[2];
  const d1 = ab0 * ap0 + ab1 * ap1 + ab2 * ap2, d2 = ac0 * ap0 + ac1 * ap1 + ac2 * ap2;
  const set = (x: number, y: number, z: number) => { out[0] = x; out[1] = y; out[2] = z; return (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2; };
  if (d1 <= 0 && d2 <= 0) return set(a[0], a[1], a[2]);
  const bp0 = p[0] - b[0], bp1 = p[1] - b[1], bp2 = p[2] - b[2];
  const d3 = ab0 * bp0 + ab1 * bp1 + ab2 * bp2, d4 = ac0 * bp0 + ac1 * bp1 + ac2 * bp2;
  if (d3 >= 0 && d4 <= d3) return set(b[0], b[1], b[2]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(a[0] + v * ab0, a[1] + v * ab1, a[2] + v * ab2); }
  const cp0 = p[0] - c[0], cp1 = p[1] - c[1], cp2 = p[2] - c[2];
  const d5 = ab0 * cp0 + ab1 * cp1 + ab2 * cp2, d6 = ac0 * cp0 + ac1 * cp1 + ac2 * cp2;
  if (d6 >= 0 && d5 <= d6) return set(c[0], c[1], c[2]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(a[0] + w * ac0, a[1] + w * ac1, a[2] + w * ac2); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return set(b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])); }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator;
  return set(a[0] + ab0 * v + ac0 * w, a[1] + ab1 * v + ac1 * w, a[2] + ab2 * v + ac2 * w);
}

/**
 * Signed distances from points to a triangle soup (outward normals: positive outside), capped at SEARCH. With `feet`,
 * each point's nearest surface point is written there (NaN when nothing lies within SEARCH), and with `owners` the
 * index of the triangle it lies on (-1).
 */
function signedDistances(points: number[][], tris: number[][][], feet?: Float64Array, owners?: Int32Array): Float64Array {
  if (feet) feet.fill(NaN);
  if (owners) owners.fill(-1);
  const out = new Float64Array(points.length).fill(SEARCH);
  if (!tris.length) return out;
  const cell = (v: number) => Math.floor(v / CELL);
  const lo = [0, 1, 2].map(k => cell(Math.min(...tris.map(t => Math.min(t[0][k], t[1][k], t[2][k]))))), hi = [0, 1, 2].map(k => cell(Math.max(...tris.map(t => Math.max(t[0][k], t[1][k], t[2][k])))));
  const nx = hi[0] - lo[0] + 1, ny = hi[1] - lo[1] + 1, nz = hi[2] - lo[2] + 1;
  const grid = new Map<number, number[]>(), key = (i: number, j: number, k: number) => ((i - lo[0]) * ny + (j - lo[1])) * nz + (k - lo[2]);
  tris.forEach((t, index) => {
    const a = [0, 1, 2].map(k => cell(Math.min(t[0][k], t[1][k], t[2][k]))), b = [0, 1, 2].map(k => cell(Math.max(t[0][k], t[1][k], t[2][k])));
    for (let i = a[0]; i <= b[0]; i++) for (let j = a[1]; j <= b[1]; j++) for (let k = a[2]; k <= b[2]; k++) {
      const list = grid.get(key(i, j, k)); if (list) list.push(index); else grid.set(key(i, j, k), [index]);
    }
  });
  const normals = tris.map(([a, b, c]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  });
  const stamp = new Int32Array(tris.length).fill(-1), q = [0, 0, 0], best = [0, 0, 0];
  const rings = Math.ceil(SEARCH / CELL);
  points.forEach((p, n) => {
    const ci = cell(p[0]), cj = cell(p[1]), ck = cell(p[2]);
    let found = Infinity, owner = -1;
    for (let r = 0; r <= rings; r++) {
      // Any triangle in ring r is at least (r - 1) cells away: stop once the best is nearer than that.
      if (owner >= 0 && Math.sqrt(found) <= (r - 1) * CELL) break;
      for (let i = Math.max(lo[0], ci - r); i <= Math.min(hi[0], ci + r); i++) for (let j = Math.max(lo[1], cj - r); j <= Math.min(hi[1], cj + r); j++) {
        const edge = Math.abs(i - ci) === r || Math.abs(j - cj) === r;
        const ks = edge || r === 0 ? Array.from({ length: Math.max(0, Math.min(hi[2], ck + r) - Math.max(lo[2], ck - r) + 1) }, (_, x) => Math.max(lo[2], ck - r) + x)
          : [ck - r, ck + r].filter(k => k >= lo[2] && k <= hi[2]);
        for (const k of ks) {
          const list = grid.get(key(i, j, k)); if (!list) continue;
          for (const index of list) {
            if (stamp[index] === n) continue; stamp[index] = n;
            const d = closest(p, tris[index][0], tris[index][1], tris[index][2], q);
            if (d < found) { found = d; owner = index; best[0] = q[0]; best[1] = q[1]; best[2] = q[2]; }
          }
        }
      }
    }
    if (owner < 0 || Math.sqrt(found) > SEARCH) return;
    if (feet) { feet[n * 3] = best[0]; feet[n * 3 + 1] = best[1]; feet[n * 3 + 2] = best[2]; }
    if (owners) owners[n] = owner;
    const normal = normals[owner], side = (p[0] - best[0]) * normal[0] + (p[1] - best[1]) * normal[1] + (p[2] - best[2]) * normal[2];
    out[n] = side < 0 ? -Math.sqrt(found) : Math.sqrt(found);
  });
  return out;
}

/** Where each point of a cloud lies along its principal (longest) axis, and the cloud's length along it. */
function principal(points: number[][]): { along: number[]; length: number } {
  const mean = [0, 1, 2].map(k => points.reduce((sum, p) => sum + p[k], 0) / (points.length || 1));
  const cov = [0, 1, 2].map(r => [0, 1, 2].map(c => points.reduce((sum, p) => sum + (p[r] - mean[r]) * (p[c] - mean[c]), 0)));
  let axis = [1, 1, 1];
  for (let n = 0; n < 50; n++) { const next = [0, 1, 2].map(r => cov[r][0] * axis[0] + cov[r][1] * axis[1] + cov[r][2] * axis[2]); const len = Math.hypot(...next) || 1; axis = next.map(x => x / len); }
  const along = points.map(p => (p[0] - mean[0]) * axis[0] + (p[1] - mean[1]) * axis[1] + (p[2] - mean[2]) * axis[2]);
  return { along, length: along.length ? Math.max(...along) - Math.min(...along) : 0 };
}

/** Barycentric weights of p (on or near triangle abc) for a, b and c. */
function barycentric(p: number[], a: number[], b: number[], c: number[]): number[] {
  const v0 = [0, 1, 2].map(k => b[k] - a[k]), v1 = [0, 1, 2].map(k => c[k] - a[k]), v2 = [0, 1, 2].map(k => p[k] - a[k]);
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1), det = d00 * d11 - d01 * d01;
  if (Math.abs(det) < 1e-30) return [1, 0, 0];
  const v = (d11 * d20 - d01 * d21) / det, w = (d00 * d21 - d01 * d20) / det;
  return [1 - v - w, v, w];
}

const moves = (s: AttachSurface, v: number, names: Iterable<string>) => {
  for (const name of names) { const d = s.targets.get(name); if (d && Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) > 0.00001) return true; }
  return false;
};

/**
 * Sort welded pieces into mouth parts, eyes, lids, skin and attached parts. A piece an eye morph moves is a lid, unless
 * it is skin-sized: a continuous eye's lids are the skin itself (`eye_hole(style='continuous')`), and that skin is still
 * judged as skin (a part it slides under fails).
 */
function classify(surfaces: AttachSurface[], pieces: Map<number, Piece>, eyes: AttachEye[]): void {
  const size = (p: Piece) => Math.hypot(p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]);
  for (const piece of pieces.values()) {
    const names = new Set(piece.tris.flatMap(([i]) => surfaces[i].names));
    if ([...names].some(mouthName)) piece.kind = 'mouth';
    else if ([...names].some(n => /^eye_(white|iris|pupil)/.test(n))) piece.kind = 'eye';
    else if (piece.verts.some(([i, v]) => moves(surfaces[i], v, LID_MORPHS))) piece.kind = 'lid';
  }
  const biggest = Math.max(0, ...[...pieces.values()].filter(p => p.kind === 'part' || p.kind === 'lid').map(size));
  for (const piece of pieces.values()) if (piece.kind === 'lid' && size(piece) >= SKIN_SHARE * biggest) piece.kind = 'skin';
  // How far each eye's separate lids reach from its center: a piece wholly inside that belongs to the eye (a shutter housing).
  const eyeMorphs = eyes.map(e => ['eyeBlink', 'eyeSquint', 'eyeWide'].map(m => `${m}${e.suffix}`));
  const reach = eyes.map((eye, e) => {
    let far = 0;
    for (const piece of pieces.values()) if (piece.kind === 'lid') for (const [i, v] of piece.verts) {
      const s = surfaces[i];
      if (moves(s, v, eyeMorphs[e])) far = Math.max(far, Math.hypot(s.rest[v * 3] - eye.center[0], s.rest[v * 3 + 1] - eye.center[1], s.rest[v * 3 + 2] - eye.center[2]));
    }
    return far;
  });
  for (const piece of pieces.values()) {
    if (piece.kind !== 'part') continue;
    const names = new Set(piece.tris.flatMap(([i]) => surfaces[i].names));
    if ([...names].some(socketName) || eyes.some((eye, e) => reach[e] > 0 && piece.verts.every(([i, v]) =>
      Math.hypot(surfaces[i].rest[v * 3] - eye.center[0], surfaces[i].rest[v * 3 + 1] - eye.center[1], surfaces[i].rest[v * 3 + 2] - eye.center[2]) <= EYE_REACH * reach[e]))) piece.kind = 'eye';
  }
  const largest = Math.max(0, ...[...pieces.values()].filter(p => p.kind === 'part' || p.kind === 'skin').map(size));
  for (const piece of pieces.values()) if (piece.kind === 'part' && size(piece) >= SKIN_SHARE * largest) piece.kind = 'skin';
}

/** The surfaces welded by position into connected pieces (the pieces split by materials and sharp edges join again). */
function weld(surfaces: AttachSurface[]): Map<number, Piece> {
  // Weld every surface by position so the pieces split by materials and sharp edges join again.
  const ids = new Map<string, number>(), node: Int32Array[] = [];
  for (const s of surfaces) {
    const index = new Int32Array(s.count);
    for (let v = 0; v < s.count; v++) {
      const key = `${Math.round(s.rest[v * 3] * 1e6)},${Math.round(s.rest[v * 3 + 1] * 1e6)},${Math.round(s.rest[v * 3 + 2] * 1e6)}`;
      let id = ids.get(key); if (id === undefined) { id = ids.size; ids.set(key, id); }
      index[v] = id;
    }
    node.push(index);
  }
  const sets = new UnionFind(ids.size);
  surfaces.forEach((s, i) => { for (let t = 0; t < s.triangles.length; t += 3) { sets.union(node[i][s.triangles[t]], node[i][s.triangles[t + 1]]); sets.union(node[i][s.triangles[t]], node[i][s.triangles[t + 2]]); } });
  const pieces = new Map<number, Piece>();
  surfaces.forEach((s, i) => {
    for (let t = 0; t < s.triangles.length; t += 3) {
      const root = sets.find(node[i][s.triangles[t]]);
      let piece = pieces.get(root);
      if (!piece) { piece = { tris: [], verts: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], kind: 'part' }; pieces.set(root, piece); }
      piece.tris.push([i, t]);
    }
    const added = new Set<number>();
    for (let t = 0; t < s.triangles.length; t++) {
      const v = s.triangles[t]; if (added.has(v)) continue; added.add(v);
      const piece = pieces.get(sets.find(node[i][v]))!;
      piece.verts.push([i, v]);
      for (let k = 0; k < 3; k++) { piece.lo[k] = Math.min(piece.lo[k], s.rest[v * 3 + k]); piece.hi[k] = Math.max(piece.hi[k], s.rest[v * 3 + k]); }
    }
  });
  return pieces;
}

/** Per surface, 1 for each triangle (index / 3) of an attached part: a brow, ridge, nostril or freckle lying on the face. */
export function attachedTriangles(surfaces: AttachSurface[], eyes: AttachEye[]): Uint8Array[] {
  const pieces = weld(surfaces);
  classify(surfaces, pieces, eyes);
  const out = surfaces.map(s => new Uint8Array(s.triangles.length / 3));
  for (const piece of pieces.values()) if (piece.kind === 'part') for (const [i, t] of piece.tris) out[i][t / 3] = 1;
  return out;
}

/**
 * Find the attached parts of a face and judge their contact with the skin at rest and at each morph at weight 1.
 * `surfaces` are the face's opaque, non-eyeball primitives; `eyes` gives each eye's center (and morph side).
 */
export function attachedParts(surfaces: AttachSurface[], eyes: AttachEye[], morphNames: string[]): AttachReport {
  const pieces = weld(surfaces);
  const size = (p: Piece) => Math.hypot(p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]);
  classify(surfaces, pieces, eyes);
  const contact = [...pieces.values()].filter(p => p.kind === 'skin' || p.kind === 'lid');
  const parts = [...pieces.values()].filter(p => p.kind === 'part');

  const posed = new Map<string, Float64Array[]>();
  const pose = (name: string | null) => {
    const key = name ?? '';
    let cached = posed.get(key);
    if (!cached) {
      cached = surfaces.map(s => {
        const d = name ? s.targets.get(name) : undefined;
        if (!d) return s.rest;
        const out = Float64Array.from(s.rest); for (let k = 0; k < out.length; k++) out[k] += d[k]; return out;
      });
      posed.set(key, cached);
    }
    return cached;
  };
  // The farthest any morph moves any vertex: how far skin can travel toward a part.
  let reachOf = 0;
  for (const s of surfaces) for (const d of s.targets.values()) for (let v = 0; v < s.count; v++) reachOf = Math.max(reachOf, Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]));
  const judge = (piece: Piece, against: Piece[], host?: string): { entry: AttachedPart; problems: string[] } => {
    const labels = [...new Set(piece.tris.map(([i]) => surfaces[i].label))];
    const morphs = morphNames.filter(name => piece.verts.some(([i, v]) => moves(surfaces[i], v, [name])));
    const center = [0, 1, 2].map(k => (piece.lo[k] + piece.hi[k]) / 2);
    const label = `${labels.join(' + ')} part at (${center.map(c => (c * 1000).toFixed(0)).join(', ')}) mm${morphs.length ? ` moved by ${morphs.slice(0, 3).join(', ')}${morphs.length > 3 ? ', ...' : ''}` : ''}`;
    // Sample the part's surface: barycentric points on each triangle, about SAMPLE apart.
    const samples: { i: number; a: number; b: number; c: number; u: number; v: number }[] = [];
    for (const [i, t] of piece.tris) {
      const s = surfaces[i], [a, b, c] = [s.triangles[t], s.triangles[t + 1], s.triangles[t + 2]];
      const p = (v: number) => [s.rest[v * 3], s.rest[v * 3 + 1], s.rest[v * 3 + 2]];
      const edge = Math.max(Math.hypot(...p(a).map((x, k) => x - p(b)[k])), Math.hypot(...p(b).map((x, k) => x - p(c)[k])), Math.hypot(...p(c).map((x, k) => x - p(a)[k])));
      const n = Math.min(3, Math.max(1, Math.ceil(edge / SAMPLE)));
      for (let x = 0; x <= n; x++) for (let y = 0; x + y <= n; y++) samples.push({ i, a, b, c, u: x / n, v: y / n });
    }
    const at = (positions: Float64Array[], sample: typeof samples[number]) => {
      const q = positions[sample.i], w = 1 - sample.u - sample.v;
      return [0, 1, 2].map(k => w * q[sample.a * 3 + k] + sample.u * q[sample.b * 3 + k] + sample.v * q[sample.c * 3 + k]);
    };
    // Contact triangles that could come near the part in any pose: within SEARCH plus the largest morph motion.
    const expand = SEARCH + reachOf;
    // Each candidate remembers its piece and whether that is a lid (lids slide under brows and skin rims by design).
    const candidates: [number, number, boolean, Piece][] = [];
    for (const other of against) for (const [i, t] of other.tris) {
      const s = surfaces[i], q = s.rest;
      const tri = [s.triangles[t], s.triangles[t + 1], s.triangles[t + 2]];
      if ([0, 1, 2].some(k => Math.max(...tri.map(v => q[v * 3 + k])) < piece.lo[k] - expand || Math.min(...tri.map(v => q[v * 3 + k])) > piece.hi[k] + expand)) continue;
      candidates.push([i, t, other.kind === 'lid', other]);
    }
    /** The candidate triangles near the points in this pose; `ids` receives each one's candidate index. */
    const trianglesNear = (positions: Float64Array[], points: number[][], ids?: number[]) => {
      const lo = [0, 1, 2].map(k => Math.min(...points.map(p => p[k])) - SEARCH), hi = [0, 1, 2].map(k => Math.max(...points.map(p => p[k])) + SEARCH);
      const tris: number[][][] = [];
      candidates.forEach(([i, t], id) => {
        const s = surfaces[i], q = positions[i], a = s.triangles[t] * 3, b = s.triangles[t + 1] * 3, c = s.triangles[t + 2] * 3;
        let outside = false;
        for (let k = 0; k < 3 && !outside; k++) outside = Math.max(q[a + k], q[b + k], q[c + k]) < lo[k] || Math.min(q[a + k], q[b + k], q[c + k]) > hi[k];
        if (!outside) { tris.push([[q[a], q[a + 1], q[a + 2]], [q[b], q[b + 1], q[b + 2]], [q[c], q[c + 1], q[c + 2]]]); ids?.push(id); }
      });
      return tris;
    };
    // Slices along the part's length, by where each sample meets the skin: each rest sample is replaced by its nearest
    // skin point (its footprint) before it is placed along the principal axis, so the top of a thick ridge curved round
    // a dome shares its slice with the base under it instead of reaching past the base at the ends.
    const rest = samples.map(s => at(pose(null), s));
    const feet = new Float64Array(rest.length * 3);
    const restIds: number[] = [], restTris = trianglesNear(pose(null), rest, restIds), restOwners = new Int32Array(rest.length);
    const restDistance = signedDistances(rest, restTris, feet, restOwners);
    const footed = rest.map((_, n) => !Number.isNaN(feet[n * 3]));
    const foot = rest.map((p, n) => footed[n] ? [feet[n * 3], feet[n * 3 + 1], feet[n * 3 + 2]] : p);
    // Samples too far out to find the skin (the top of a ridge more than SEARCH proud) take no part in placing the
    // slices: they join the end slice nearest them rather than making slices of their own that only seem to float.
    const { along } = principal(foot), placed = footed.some(Boolean) ? along.filter((_, n) => footed[n]) : along;
    const from = Math.min(...placed), length = Math.max(...placed) - from;
    const count = Math.min(MAX_SLICES, Math.max(1, Math.ceil(length / SLICE)));
    const slice = along.map(t => Math.max(0, Math.min(count - 1, Math.floor((t - from) / (length || 1) * count))));
    // A part lies on the face (brows, ridges, nostrils: touching along its whole length) unless it is an appendage,
    // by placement or by shape: it sits beside or behind the eyes (an ear, a fin), or it rises out of the skin more than
    // STANDS_OUT and further than its base spreads along the skin (a horn at a brow corner). A ridge is long along the
    // skin however heavy it is. The rise is measured from the skin, or from the part's own underside when it floats (a
    // gap must not make a ridge a horn); the base is the part's lowest third of that rise, so a ridge touching at one
    // end and hanging off along the rest keeps its whole underside in its base.
    const within = [...restDistance].filter(d => d < SEARCH);
    const level = within.length ? Math.max(0, Math.min(...within)) : 0, rise = within.length ? Math.max(...within) - level : 0;
    const bottom = foot.filter((_, n) => footed[n] && restDistance[n] <= level + BASE_SHARE * rise);
    const base = bottom.length > 1 ? principal(bottom).length : 0;
    const behind = eyes.length > 0 && center[2] < Math.min(...eyes.map(e => e.center[2] - e.radius));
    const lies = !behind && !(rise > STANDS_OUT && rise > base);

    // Where the part touches the skin at rest (its vertices within ATTACH_TOLERANCE of it, or in it): the skin triangle
    // under each and its barycentric weights there, as attach_to_skin records them. Lid triangles are left out.
    const touching: { i: number; v: number; s: number; tri: number[]; w: number[] }[] = [];
    {
      const points = piece.verts.map(([i, v]) => [surfaces[i].rest[v * 3], surfaces[i].rest[v * 3 + 1], surfaces[i].rest[v * 3 + 2]]);
      const ids: number[] = [], vertexFeet = new Float64Array(points.length * 3), owners = new Int32Array(points.length);
      const distance = signedDistances(points, trianglesNear(pose(null), points, ids), vertexFeet, owners);
      piece.verts.forEach(([i, v], n) => {
        if (distance[n] > ATTACH_TOLERANCE || owners[n] < 0) return;
        const [s, t, lid] = candidates[ids[owners[n]]];
        if (lid) return;
        const q = surfaces[s].rest, tri = [surfaces[s].triangles[t], surfaces[s].triangles[t + 1], surfaces[s].triangles[t + 2]];
        const corner = (k: number) => [q[tri[k] * 3], q[tri[k] * 3 + 1], q[tri[k] * 3 + 2]];
        touching.push({ i, v, s, tri, w: barycentric([vertexFeet[n * 3], vertexFeet[n * 3 + 1], vertexFeet[n * 3 + 2]], corner(0), corner(1), corner(2)) });
      });
    }
    /** The most the skin moves under the part, relative to it, where the part stays (moves less than half as far). */
    const slides = (name: string) => {
      let worst = 0;
      for (const { i, v, s, tri, w } of touching) {
        const skinDelta = surfaces[s].targets.get(name), own = surfaces[i].targets.get(name);
        const under = [0, 1, 2].map(k => skinDelta ? w[0] * skinDelta[tri[0] * 3 + k] + w[1] * skinDelta[tri[1] * 3 + k] + w[2] * skinDelta[tri[2] * 3 + k] : 0);
        const moved = [0, 1, 2].map(k => own ? own[v * 3 + k] : 0);
        if (Math.hypot(...moved) >= 0.5 * Math.hypot(...under)) continue;
        worst = Math.max(worst, Math.hypot(under[0] - moved[0], under[1] - moved[1], under[2] - moved[2]));
      }
      return worst;
    };

    // The underside at rest, where the part is seated in the skin: in a slice that dips more than ATTACH_TOLERANCE into
    // the skin it sits in (the surface pieces it touches, not a lid), the underside was meant to be sealed, so where the
    // part's surface faces that skin and stands out of it, light shows under its edge. A ridge pushed out from its dome
    // still dips into it in every slice while its underside hangs off it along its length (the round-6 frog). A part
    // resting on the skin (a round rubber mouth tube laid 0.3 mm in front of it, a bead sitting on it) is judged by its
    // gap alone: its underside curves away from the skin by its own shape. Winding is taken from the part: the surface
    // out of the skin mostly faces away from it.
    const overhang = new Float64Array(count), seatedDepth = new Float64Array(count).fill(Infinity);
    restDistance.forEach((d, n) => { seatedDepth[slice[n]] = Math.min(seatedDepth[slice[n]], d); });
    if (lies) {
      const normal = (a: number[], b: number[], c: number[]) => {
        const u = [0, 1, 2].map(k => b[k] - a[k]), v = [0, 1, 2].map(k => c[k] - a[k]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], length = Math.hypot(...n) || 1;
        return n.map(x => x / length);
      };
      const candidateOf = (n: number) => restOwners[n] >= 0 ? candidates[restIds[restOwners[n]]] : undefined;
      const seated = new Set(rest.flatMap((_, n) => { const c = candidateOf(n); return c && !c[2] && restDistance[n] <= ATTACH_TOLERANCE ? [c[3]] : []; }));
      const facing = samples.map((sample, n) => {
        const c = candidateOf(n);
        if (!c || c[2] || !seated.has(c[3]) || restDistance[n] >= SEARCH) return NaN;
        const q = pose(null)[sample.i], corner = (v: number) => [q[v * 3], q[v * 3 + 1], q[v * 3 + 2]];
        const own = normal(corner(sample.a), corner(sample.b), corner(sample.c)), t = restTris[restOwners[n]], under = normal(t[0], t[1], t[2]);
        return own[0] * under[0] + own[1] * under[1] + own[2] * under[2];
      });
      let sense = 0;
      facing.forEach((f, n) => { if (!Number.isNaN(f) && restDistance[n] > ATTACH_TOLERANCE) sense += f; });
      facing.forEach((f, n) => { if ((sense < 0 ? -f : f) < -0.5 && seatedDepth[slice[n]] < -ATTACH_TOLERANCE) overhang[slice[n]] = Math.max(overhang[slice[n]], restDistance[n]); });
    }
    const hangs = Math.max(0, ...overhang), hanging = overhang.filter(h => h > ATTACH_TOLERANCE).length;

    const evaluate = (name: string | null) => {
      const positions = pose(name);
      const points = samples.map(s => at(positions, s));
      const tris = trianglesNear(positions, points);
      const distance = signedDistances(points, tris);
      const low = new Float64Array(count).fill(Infinity);
      let outside = 0;
      distance.forEach((d, n) => { low[slice[n]] = Math.min(low[slice[n]], d); if (d > 0) outside++; });
      let gap = 0, floating = 0, nearest = Infinity;
      for (let k = 0; k < count; k++) if (Number.isFinite(low[k])) { gap = Math.max(gap, low[k]); nearest = Math.min(nearest, low[k]); if (low[k] > ATTACH_TOLERANCE) floating++; }
      // An appendage only has to touch the skin at its root: its gap is its nearest slice's.
      return { gap: lies ? gap : Math.max(0, nearest), floating: lies ? floating : nearest > ATTACH_TOLERANCE ? count : 0, visible: outside / samples.length };
    };
    const measured = evaluate(null);
    const entry: AttachedPart = { part: label, vertices: piece.verts.length, center: center.map(c => round(c)), morphs, restGap: round(measured.gap), gap: round(measured.gap), worst: 'rest', poses: 1, restVisible: round(measured.visible, 4), contact: lies ? 'lies' : 'root', rise: round(rise), base: round(base), overhang: round(hangs), slide: 0 };
    if (host) entry.host = host;
    const skin = host ? `the skin or ${host}, the part it sits on,` : 'the skin';
    const problems: string[] = [];
    const fix = 'lay it on the skin (brow_ridge_geometry(..., skin=...), skin_brow_geometry) or seat it with attach_to_skin(part, skin, depth=...)';
    if (measured.gap > ATTACH_TOLERANCE) problems.push(lies
      ? `${label} floats ${mm(measured.gap)} off ${skin} at rest along ${measured.floating} of its ${count} slices (allowed ${mm(ATTACH_TOLERANCE)}): a part joined to the face must sit on the skin along its whole length with no air gap; ${fix}`
      : `${label} floats ${mm(measured.gap)} off the head at rest: an ear, fin or horn may stand out from the head but must touch it at its root; sink its root into the skin (attach_to_skin(part, skin, depth=...))`);
    else if (hangs > ATTACH_TOLERANCE) problems.push(`${label} hangs ${mm(hangs)} off ${skin} at rest along ${hanging} of its ${count} slices (allowed ${mm(ATTACH_TOLERANCE)}): its underside stands out of the skin at its edges, so light shows under it; a part joined to the face must sit on the skin across its whole width; ${fix}`);
    // Every morph that moves the part or the skin and lids near it, at weight 1.
    const near = (s: AttachSurface, q: Float64Array, v: number) => q[v * 3] >= piece.lo[0] - SEARCH && q[v * 3] <= piece.hi[0] + SEARCH && q[v * 3 + 1] >= piece.lo[1] - SEARCH && q[v * 3 + 1] <= piece.hi[1] + SEARCH && q[v * 3 + 2] >= piece.lo[2] - SEARCH && q[v * 3 + 2] <= piece.hi[2] + SEARCH;
    for (const name of morphNames) {
      const relevant = morphs.includes(name) || candidates.some(([i, t]) => [0, 1, 2].some(k => { const v = surfaces[i].triangles[t + k]; return near(surfaces[i], surfaces[i].rest, v) && moves(surfaces[i], v, [name]); }));
      if (!relevant) continue;
      const result = evaluate(name);
      entry.poses++;
      if (result.gap > entry.gap) { entry.gap = round(result.gap); entry.worst = `${name}=1`; }
      if (result.gap > ATTACH_TOLERANCE && measured.gap <= ATTACH_TOLERANCE) problems.push(`${name}=1 lifts ${label} ${mm(result.gap)} off ${skin}${lies ? ` along ${result.floating} of its ${count} slices` : ''} (allowed ${mm(ATTACH_TOLERANCE)}): the part must follow the skin while its morphs play; give it the skin's own deltas with attach_to_skin(part, skin) and keep its own morphs on the skin`);
      if (measured.visible > 0 && result.visible < ATTACH_MIN_VISIBLE * measured.visible) problems.push(`${name}=1 buries ${label} in the skin: ${(result.visible * 100).toFixed(0)}% of it shows, against ${(measured.visible * 100).toFixed(0)}% at rest (it sinks where the skin moves and the part does not); carry the skin's ${name} deltas on it with attach_to_skin(part, skin)`);
      const slide = slides(name);
      if (slide > entry.slide) entry.slide = round(slide);
      if (slide > ATTACH_TOLERANCE) problems.push(`${name}=1 slides ${host ? `the surface (the skin or ${host})` : 'the skin'} ${mm(slide)} under ${label} while the part stays (allowed ${mm(ATTACH_TOLERANCE)}): carry the skin's ${name} deltas on it with attach_to_skin(part, skin)`);
    }
    if (problems.length > 3) problems.splice(3, problems.length - 3, `${label}: ${problems.length - 3} more morphs lift, bury or slide under it`);
    return { entry, problems };
  };
  // Judge every part against the skin and lids first. A part that fails may sit on another attached part instead (a
  // nostril seated on a nose ball with attach_to_skin(bead, ball)): judge it again against the skin, the lids and the
  // larger parts that passed and lie within reach of it, until nothing changes (a chain of parts settles in turn).
  const results = new Map(parts.map(piece => [piece, judge(piece, contact)]));
  const shortLabel = (piece: Piece) => results.get(piece)!.entry.part.replace(/ moved by .*$/, '');
  const tried = new Map<Piece, number>();
  for (let changed = true; changed;) {
    changed = false;
    for (const piece of parts) {
      if (!results.get(piece)!.problems.length) continue;
      const hosts = parts.filter(other => other !== piece && !results.get(other)!.problems.length && size(other) > size(piece)
        && [0, 1, 2].every(k => other.lo[k] <= piece.hi[k] + SEARCH && other.hi[k] >= piece.lo[k] - SEARCH));
      if (hosts.length <= (tried.get(piece) ?? 0)) continue;
      tried.set(piece, hosts.length);
      const again = judge(piece, [...contact, ...hosts], hosts.map(shortLabel).join(' + '));
      if (!again.problems.length) changed = true;
      if (!again.problems.length || again.entry.gap < results.get(piece)!.entry.gap) results.set(piece, again);
    }
  }
  const report: AttachReport = { parts: [], problems: [] };
  for (const piece of parts) { const { entry, problems } = results.get(piece)!; report.parts.push(entry); report.problems.push(...problems); }
  return report;
}
