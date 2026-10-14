/**
 * Lid penetration (arkit-face/1, rig-contract invariant 1): in every pose of an eye's blink, squint and wide morphs, no
 * triangle that moves with the eye passes through a triangle it is not joined to, unless the two surfaces already cross
 * at rest.
 *
 * Morphs add linearly, and consumers soft-union their layers (an idle blink fires while a squint slider or a squinting
 * emotion holds), so every point of the blink x squint x wide cube is reached. Lids that each look right alone can
 * still cross when two morphs add: the P1a round-8 critic's continuous lids sent the lower lid's skin up in front of
 * the closing upper lid once squint reached about 0.75 with blink 0.5 or more, tearing the lash line, with 0 iris
 * pixels, no flipped triangle and the verifier passing; and a lone blink crossed beside the corners.
 *
 * Two poses lists judge it. `contract` mode (the default) poses the 12 eye-coverage states, the 20 named crossing poses
 * the lid construction was tuned against, and lid follow's extremes (at most `LID_CONTRACT_MAX_POSES`, so the check
 * costs seconds); `grid` mode poses every weight of each morph (0, .25, .5, .75, 1) and the same grid with lid follow's
 * extremes soft-unioned in, 324 poses besides rest.
 *
 * The crossing test is `surfaceCrossings` (the mouth check's bounded-volume tree and welded-edge ownership), with the
 * exclusions that make it a lid test and not a mesh-quality one:
 * - only triangles within `LID_REACH` eyeball radii of the eye at rest, and not the attached parts (brows, ridges,
 *   nostrils), which have their own check;
 * - only pairs in which at least one triangle moves with this eye's own three morphs (the other eye's never move it);
 * - a pair that shares a welded vertex (identical rest position, in whatever primitive) is no crossing: at the canthus
 *   the two lids' triangles meet in one point and pivot about it;
 * - a pair that already crosses at rest is not judged, nor is any other pair between the same two welded pieces: a blade
 *   standing in a lens well, or a part seated in the skin by design, crosses new triangles of it as it slides.
 *
 * Cost. The crossing test builds a bounding-volume tree and the objects under it from whatever it is given, and a face has
 * thousands of triangles near each eye, most of which cannot meet any other in any pose. So the default pass first finds,
 * once, every pair of triangles whose swept boxes (the box each triangle can reach over the weights the poses use) touch,
 * and in each pose keeps the pairs whose posed boxes touch and whose planes do not already part them by more than the
 * tolerance (a pair that is parted cannot straddle each other: `intersection` would return nothing). The crossing test then
 * sees only the triangles of those pairs and the triangles across their edges, which is all the edge ownership it reads, and
 * finds what it would have found among every triangle. `exhaustive` runs it on every triangle of every pose instead: the
 * slow reference the default pass is tested against.
 */
import { surfaceCrossings, type CrossingSurface, type SkipPair, type SurfaceCrossing } from './surface-crossings.ts';

export const LID_GRID_WEIGHTS: readonly number[] = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
/** Lid follow when the file declares none: what the library writes by default (the inversion check falls back to a smaller `up`). */
export const LID_FOLLOW_DEFAULT: Readonly<{ down: number; up: number }> = Object.freeze({ down: 0.35, up: 0.8 });
/** Triangles whose three vertices lie within this many eyeball radii of the eye center at rest are judged. */
export const LID_REACH = 3;
/** The most poses `contract` mode judges per eye. */
export const LID_CONTRACT_MAX_POSES = 40;
/** The most crossing pairs counted in one pose (and the most poses listed in a report). */
export const LID_PAIR_LIMIT = 40;
const LID_POSES_LISTED = 12, LID_EXAMPLES = 4;
/** A vertex moves with the eye when one of its eye morphs moves it farther than this (m). */
const LID_MOTION = 0.00001;
/** Rest positions closer than this (m) are one vertex (primitives split per material repeat their seam vertices). */
const WELD = 1e-7;
const TOLERANCE = 1e-6;
/** A triangle wholly farther than this (m) from another's plane, on one side, cannot straddle it: the tolerance and a margin for rounding. */
const PLANE_PARTED = TOLERANCE + 1e-9;
/** A corner this close (m) to a plane is on it, as `surfaceCrossings` reads it. */
const PLANE_ZERO = 1e-10;
/** The most triangle pairs the default pass keeps from the swept boxes: a morph that sweeps the whole face leaves the exhaustive pass cheaper. */
const LID_CANDIDATE_CAP = 4_000_000;

export interface LidPose { blink: number; squint: number; wide: number }

/**
 * Poses that crossed on agent-meshes' own heads before the lid construction nested the lids (blink .5-1 with squint
 * .75-1, with and without wide, the squeezed shut eye with everything, a lone blink, and the poses an idle blink reaches
 * over lid follow's look-down or look-up), as (blink, squint, wide): the same list the library's tests pose.
 */
export const LID_CROSSING_POSES: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.5, 0.75, 0], [0.5, 1, 0], [0.6, 1, 0], [0.675, 1, 0], [0.75, 0.75, 0], [0.75, 1, 0], [0.9, 1, 0], [1, 0.75, 0], [1, 1, 0],
  [1, 1, 0.25], [1, 1, 1], [1, 0.5, 0.5], [1, 0, 1], [1, 0, 0], [0.75, 1, 0.5], [0, 1, 1], [0.35, 1, 0.25],
  [0.75, 0, 0], [0.8375, 0, 0], [1, 0, 0.8],
] as const);

const union = (a: number, b: number) => 1 - (1 - a) * (1 - b);
const keyOf = (p: LidPose) => `${+p.blink.toFixed(6)},${+p.squint.toFixed(6)},${+p.wide.toFixed(6)}`;

function distinct(poses: LidPose[]): LidPose[] {
  const seen = new Map<string, LidPose>();
  for (const pose of poses) if (!seen.has(keyOf(pose))) seen.set(keyOf(pose), pose);
  return [...seen.values()].sort((a, b) => a.blink - b.blink || a.squint - b.squint || a.wide - b.wide);
}

/** `eyeBlinkLeft=1 + eyeSquintLeft=0.5`, or `rest`. */
export function poseLabel(pose: LidPose, suffix: string): string {
  const parts = ([['eyeBlink', pose.blink], ['eyeSquint', pose.squint], ['eyeWide', pose.wide]] as const).filter(([, w]) => w).map(([name, w]) => `${name}${suffix}=${+w.toFixed(4)}`);
  return parts.length ? parts.join(' + ') : 'rest';
}

/** Every weight of blink, squint and wide, and the grid with lid follow's extremes soft-unioned in: 324 poses besides rest. */
export function lidGridPoses(follow: { down: number; up: number } = LID_FOLLOW_DEFAULT): LidPose[] {
  const poses: LidPose[] = [];
  for (const blink of LID_GRID_WEIGHTS) for (const squint of LID_GRID_WEIGHTS) for (const wide of LID_GRID_WEIGHTS) {
    poses.push({ blink, squint, wide }, { blink: union(blink, follow.down), squint, wide }, { blink, squint, wide: union(wide, follow.up) });
  }
  return distinct(poses).filter(p => p.blink || p.squint || p.wide);
}

/**
 * The poses `contract` mode judges: the eye-coverage states the caller names, the named crossing poses, and lid follow
 * alone and with the other lid morphs (looking down adds blink `down`, looking up adds wide `up`): at most
 * `LID_CONTRACT_MAX_POSES`, 33 with the 12 coverage states and lid follow's defaults.
 */
export function lidContractPoses(follow: { down: number; up: number } = LID_FOLLOW_DEFAULT, coverage: LidPose[] = []): LidPose[] {
  const { down: d, up: u } = follow;
  const looks: [number, number, number][] = [[d, 0, 0], [d, 1, 0], [d, 0, 1], [d, 1, 1], [0, 0, u], [0, 1, u], [0.5, 0, u], [0.5, 1, u]];
  const named = [...LID_CROSSING_POSES, ...looks].map(([blink, squint, wide]) => ({ blink, squint, wide }));
  return distinct([...coverage, ...named]).filter(p => p.blink || p.squint || p.wide);
}

/** One primitive of the face as the check reads it: rest positions, the three eye morphs' deltas (this eye's own) and triangles. */
export interface LidSurface {
  label: string;
  rest: Float64Array;
  /** Per-morph position deltas, as in the glTF targets (missing when the surface lacks that morph). */
  blink?: Float64Array; squint?: Float64Array; wide?: Float64Array;
  triangles: Uint32Array;
  /** Triangles to leave out (attached parts, judged by their own check): 1 = skip. */
  skip?: Uint8Array;
  /** Original primitive triangle indices when `triangles` is a view of a larger primitive. */
  sourceTriangles?: Uint32Array;
}

export interface LidCrossingPose { pose: string; pairs: number }
export interface LidCrossingExample { part: string; triangle: number; other: string; otherTriangle: number }
export interface EyePenetration {
  mode: 'contract' | 'grid' | 'custom';
  /** Poses judged, the triangles judged near the eye and how many of them move with its morphs. */
  poses: number; triangles: number; moving: number;
  /** Poses with at least one crossing pair, and the first of them (at most 12) with their pair counts. */
  crossingPoses: number; crossing: LidCrossingPose[];
  /** The pose with the most crossing pairs: its label, pair count (capped), a few pairs and their heights above the eye center in eyeball radii. */
  worstCrossing: { pose: string; pairs: number; examples: LidCrossingExample[]; heights: [number, number] } | null;
  /** Triangle pairs that already cross at rest, and the pairs of welded pieces they join (not judged). */
  restPairs: number; restPieces: number;
}

export interface LidOptions {
  /** Judge all 324 poses of the weight grid instead of the contract poses. */
  grid?: boolean;
  /** Judge exactly these poses. */
  poses?: LidPose[];
  /** The eye-coverage states to include in the contract poses. */
  coverage?: LidPose[];
  /** The most crossing pairs counted per pose. */
  pairLimit?: number;
  /** Cross every triangle of every pose, as the check first did, instead of only the triangles that can meet: slower, and the reference the default pass is tested against. */
  exhaustive?: boolean;
  /** The most triangle pairs the default pass keeps before it falls back to the exhaustive pass (`LID_CANDIDATE_CAP`): lowered by a test to reach the fallback. */
  maxCandidates?: number;
}

interface Piece {
  label: string; rest: Float64Array; deltas: Float64Array[];
  /** Triangles near the eye (corner indices into the compacted vertices) and the moving ones, with the check's number of each. */
  all: Uint32Array; mov: Uint32Array; idsAll: Uint32Array; idsMov: Uint32Array;
}

/** The judged triangles, numbered across the pieces in order. */
interface Judged {
  pieces: Piece[]; total: number;
  /** Per triangle: its piece, its three corners (indices into that piece's vertices), its three weld ids and whether it moves with the eye. */
  pieceIndex: Int32Array; corner: Int32Array; weld: number[][]; moves: Uint8Array;
}

/**
 * The default pass's index of which triangles can meet. Built once for an eye from the boxes each triangle can reach over the
 * weights `ranges` (per morph, its lowest and highest weight in the poses), it returns a function that crosses a pose: it
 * keeps the pairs (one of them moving, not welded) whose swept boxes touched, then in the pose the pairs whose boxes touch and
 * neither of which lies wholly beyond the tolerance of the other's plane, hands `surfaceCrossings` those triangles with the
 * ones across their edges (which its edge ownership reads), and returns what it finds. Null when more pairs than
 * `cap` could meet.
 */
function meetingIndex(judged: Judged, ranges: [number, number][], welded: (a: number, b: number) => boolean, cap: number):
  ((points: Float64Array[], skip: SkipPair, limit: number) => SurfaceCrossing[]) | null {
  const { pieces, total, pieceIndex, corner, moves, weld } = judged;

  // The box each triangle can reach: its corners' rest positions moved by each delta at the lowest and highest weight.
  const lo = new Float64Array(3 * total).fill(Infinity), hi = new Float64Array(3 * total).fill(-Infinity);
  const reach = pieces.map(piece => {
    const vlo = Float64Array.from(piece.rest), vhi = Float64Array.from(piece.rest);
    piece.deltas.forEach((d, m) => {
      const [w0, w1] = ranges[m];
      for (let i = 0; i < d.length; i++) { const a = d[i] * w0, b = d[i] * w1; vlo[i] += Math.min(a, b); vhi[i] += Math.max(a, b); }
    });
    return { vlo, vhi };
  });
  for (let g = 0; g < total; g++) {
    const { vlo, vhi } = reach[pieceIndex[g]];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
      const v = corner[3 * g + c] * 3 + k;
      if (vlo[v] < lo[3 * g + k]) lo[3 * g + k] = vlo[v];
      if (vhi[v] > hi[3 * g + k]) hi[3 * g + k] = vhi[v];
    }
    for (let k = 0; k < 3; k++) { lo[3 * g + k] -= TOLERANCE; hi[3 * g + k] += TOLERANCE; }
  }

  // The pairs those boxes let meet, by a sweep along the axis the boxes overlap least on.
  let axis = 0, least = Infinity;
  for (let k = 0; k < 3; k++) {
    let low = Infinity, high = -Infinity, extent = 0;
    for (let g = 0; g < total; g++) { low = Math.min(low, lo[3 * g + k]); high = Math.max(high, hi[3 * g + k]); extent += hi[3 * g + k] - lo[3 * g + k]; }
    const cover = extent / Math.max(high - low, 1e-12);
    if (cover < least) { least = cover; axis = k; }
  }
  const order = Uint32Array.from({ length: total }, (_, g) => g).sort((a, b) => lo[3 * a + axis] - lo[3 * b + axis]);
  const found: number[] = [];
  for (let x = 0; x < total; x++) {
    const a = order[x], top = hi[3 * a + axis];
    for (let y = x + 1; y < total; y++) {
      const b = order[y];
      if (lo[3 * b + axis] > top) break;
      if (!moves[a] && !moves[b]) continue;
      if (lo[3 * a] > hi[3 * b] || lo[3 * b] > hi[3 * a] || lo[3 * a + 1] > hi[3 * b + 1] || lo[3 * b + 1] > hi[3 * a + 1] || lo[3 * a + 2] > hi[3 * b + 2] || lo[3 * b + 2] > hi[3 * a + 2]) continue;
      if (welded(a, b)) continue;
      if (a < b) found.push(a, b); else found.push(b, a);
      if (found.length >= 2 * cap) return null;
    }
  }
  // Grouped by their lower triangle, so a pose reads that triangle's box once for all its pairs.
  const start = new Int32Array(total + 1);
  for (let p = 0; p < found.length; p += 2) start[found[p] + 1]++;
  for (let g = 0; g < total; g++) start[g + 1] += start[g];
  const partner = new Int32Array(found.length / 2), cursor = start.slice(0, total);
  for (let p = 0; p < found.length; p += 2) partner[cursor[found[p]]++] = found[p + 1];

  // The triangles across each triangle's edges, by the weld ids of its corners: built when a pose first needs them.
  let width = 1;
  for (const ids of weld) for (const id of ids) width = Math.max(width, id + 1);
  const edgeKey = (g: number, e: number) => { const x = weld[g][e], y = weld[g][(e + 1) % 3]; return x < y ? x * width + y : y * width + x; };
  let edges: Map<number, number[]> | null = null;
  const across = (g: number, e: number): number[] => {
    if (!edges) {
      edges = new Map();
      for (let t = 0; t < total; t++) for (let k = 0; k < 3; k++) {
        const key = edgeKey(t, k), list = edges.get(key);
        if (list) list.push(t); else edges.set(key, [t]);
      }
    }
    return edges.get(edgeKey(g, e)) ?? [];
  };

  // The pose's triangles: corner positions, boxes and unit normals (a triangle with no area is not crossed, as in `surfaceCrossings`).
  // Boxes hold lo x, y, z then hi x, y, z; a triangle with no area gets an empty box, so no pair with it meets.
  const vx = new Float64Array(9 * total), box = new Float64Array(6 * total), normal = new Float64Array(3 * total), mark = new Uint8Array(total);
  // Whether two triangles whose boxes touch cannot cross, by the arithmetic of `intersection`'s first steps and sure of it with a
  // margin for rounding: one lies wholly beyond the tolerance of the other's plane, or each straddles the other's plane and
  // the stretches in which they cut the line of the two planes do not overlap by more than the tolerance. Anything less sure
  // (a corner within the tolerance of the plane, the edge ownership then decides) is left to `surfaceCrossings`.
  const da = new Float64Array(3), db = new Float64Array(3), cutA = new Float64Array(9), cutB = new Float64Array(9);
  const distances = (i: number, j: number, out: Float64Array) => {
    const o = 9 * j, n = 3 * j;
    for (let c = 0; c < 3; c++) {
      const q = 9 * i + 3 * c;
      out[c] = (vx[q] - vx[o]) * normal[n] + (vx[q + 1] - vx[o + 1]) * normal[n + 1] + (vx[q + 2] - vx[o + 2]) * normal[n + 2];
    }
  };
  /** -1: wholly beyond the tolerance of the plane, on one side. 1: corners surely on both sides of it. 0: neither. */
  const side = (d: Float64Array): number => {
    const low = Math.min(d[0], d[1], d[2]), high = Math.max(d[0], d[1], d[2]);
    if (low > PLANE_PARTED || high < -PLANE_PARTED) return -1;
    return low < -PLANE_PARTED && high > PLANE_PARTED ? 1 : 0;
  };
  /** Where the triangle's edges cut the plane its distances `d` are from, as in `cut`: the number of points, written to `out`. */
  const cutBy = (g: number, d: Float64Array, out: Float64Array): number => {
    let count = 0;
    for (let c = 0; c < 3; c++) {
      const e = (c + 1) % 3, dc = Math.abs(d[c]) <= PLANE_ZERO ? 0 : d[c], de = Math.abs(d[e]) <= PLANE_ZERO ? 0 : d[e];
      const from = 9 * g + 3 * c, to = 9 * g + 3 * e;
      if (dc === 0 && count < 3) { out[3 * count] = vx[from]; out[3 * count + 1] = vx[from + 1]; out[3 * count + 2] = vx[from + 2]; count++; }
      if (dc * de < 0 && count < 3) {
        const t = dc / (dc - de);
        out[3 * count] = vx[from] + t * (vx[to] - vx[from]); out[3 * count + 1] = vx[from + 1] + t * (vx[to + 1] - vx[from + 1]); out[3 * count + 2] = vx[from + 2] + t * (vx[to + 2] - vx[from + 2]);
        count++;
      }
    }
    return count;
  };
  const cannotCross = (i: number, j: number): boolean => {
    distances(i, j, da); distances(j, i, db);
    const sa = side(da), sb = side(db);
    if (sa < 0 || sb < 0) return true;
    if (sa === 0 || sb === 0) return false;
    if (cutBy(i, da, cutA) !== 2 || cutBy(j, db, cutB) !== 2) return false;
    const ax = normal[3 * i + 1] * normal[3 * j + 2] - normal[3 * i + 2] * normal[3 * j + 1];
    const ay = normal[3 * i + 2] * normal[3 * j] - normal[3 * i] * normal[3 * j + 2];
    const az = normal[3 * i] * normal[3 * j + 1] - normal[3 * i + 1] * normal[3 * j];
    const length = Math.hypot(ax, ay, az);
    if (length < 1e-9) return false;
    const a0 = (cutA[0] * ax + cutA[1] * ay + cutA[2] * az) / length, a1 = (cutA[3] * ax + cutA[4] * ay + cutA[5] * az) / length;
    const b0 = (cutB[0] * ax + cutB[1] * ay + cutB[2] * az) / length, b1 = (cutB[3] * ax + cutB[4] * ay + cutB[5] * az) / length;
    return Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)) <= TOLERANCE - 1e-9;
  };

  return (points, skip, limit) => {
    for (let g = 0; g < total; g++) {
      const q = points[pieceIndex[g]], o = 9 * g;
      for (let c = 0; c < 3; c++) {
        const v = corner[3 * g + c] * 3;
        vx[o + 3 * c] = q[v]; vx[o + 3 * c + 1] = q[v + 1]; vx[o + 3 * c + 2] = q[v + 2];
      }
      for (let k = 0; k < 3; k++) {
        box[6 * g + k] = Math.min(vx[o + k], vx[o + 3 + k], vx[o + 6 + k]);
        box[6 * g + 3 + k] = Math.max(vx[o + k], vx[o + 3 + k], vx[o + 6 + k]);
      }
      const ux = vx[o + 3] - vx[o], uy = vx[o + 4] - vx[o + 1], uz = vx[o + 5] - vx[o + 2];
      const wx = vx[o + 6] - vx[o], wy = vx[o + 7] - vx[o + 1], wz = vx[o + 8] - vx[o + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, length = Math.hypot(nx, ny, nz);
      normal[3 * g] = nx / length; normal[3 * g + 1] = ny / length; normal[3 * g + 2] = nz / length;
      if (!(length > 1e-20)) for (let k = 0; k < 3; k++) { box[6 * g + k] = Infinity; box[6 * g + 3 + k] = -Infinity; }
    }
    mark.fill(0);
    let met = 0;
    for (let i = 0; i < total; i++) {
      const from = start[i], to = start[i + 1];
      if (from === to) continue;
      const x0 = box[6 * i], y0 = box[6 * i + 1], z0 = box[6 * i + 2], x1 = box[6 * i + 3], y1 = box[6 * i + 4], z1 = box[6 * i + 5];
      for (let p = from; p < to; p++) {
        const j = partner[p], q = 6 * j;
        if (x0 > box[q + 3] || box[q] > x1 || y0 > box[q + 4] || box[q + 1] > y1 || z0 > box[q + 5] || box[q + 2] > z1) continue;
        if (cannotCross(i, j) || skip(i, j)) continue;
        mark[i] = mark[j] = 1; met++;
      }
    }
    if (!met) return [];
    // The meeting triangles (bit 1) and, for the crossing test's edge ownership, the triangles across their edges (bit 2).
    for (let g = 0; g < total; g++) if (mark[g] & 1) for (let e = 0; e < 3; e++) for (const h of across(g, e)) mark[h] |= 2;
    const skinCorners = pieces.map(() => [] as number[]), skinIds = pieces.map(() => [] as number[]), partCorners = pieces.map(() => [] as number[]), partIds = pieces.map(() => [] as number[]);
    for (let g = 0; g < total; g++) {
      if (!mark[g]) continue;
      const n = pieceIndex[g];
      skinCorners[n].push(corner[3 * g], corner[3 * g + 1], corner[3 * g + 2]); skinIds[n].push(g);
      if (moves[g]) { partCorners[n].push(corner[3 * g], corner[3 * g + 1], corner[3 * g + 2]); partIds[n].push(g); }
    }
    const gather = (corners: number[][], ids: number[][]): CrossingSurface[] => pieces.flatMap((_, n) => ids[n].length
      ? [{ label: String(n), points: points[n], triangles: Uint32Array.from(corners[n]), sourceTriangles: Uint32Array.from(ids[n]), ids: Uint32Array.from(ids[n]) }] : []);
    return surfaceCrossings(gather(skinCorners, skinIds), gather(partCorners, partIds), TOLERANCE, limit, skip);
  };
}

/**
 * Judge one eye. `surfaces` are the face's opaque, non-eyeball primitives with that eye's own morph deltas, `skip`
 * marking the triangles of attached parts.
 */
export function eyePenetration(surfaces: LidSurface[], center: [number, number, number], radius: number, follow: { down: number; up: number },
  suffix: string, options: LidOptions = {}): EyePenetration {
  const reach2 = (LID_REACH * radius) ** 2, pairLimit = options.pairLimit ?? LID_PAIR_LIMIT;
  const mode = options.poses ? 'custom' : options.grid ? 'grid' : 'contract';
  const poses = options.poses ?? (options.grid ? lidGridPoses(follow) : lidContractPoses(follow, options.coverage ?? []));

  // The judged triangles: near the eye at rest and not an attached part. Vertices are compacted per surface.
  const weldIds = new Map<string, number>(), parent: number[] = [];
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const triangleWelds: number[][] = [], triangleSurface: number[] = [], triangleSource: number[] = [], triangleMoves: boolean[] = [];
  const kept: { n: number; a: number; b: number; c: number; source: number; moves: boolean }[][] = [];
  const pieces: Piece[] = [];
  // How far each moving vertex can reach over every weight of the three morphs: its rest position moved by each delta
  // that carries it that way. A still triangle outside the union of those boxes cannot be crossed in any pose.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  surfaces.forEach((surface, n) => {
    const deltas = [surface.blink, surface.squint, surface.wide];
    const near = (v: number) => (surface.rest[v * 3] - center[0]) ** 2 + (surface.rest[v * 3 + 1] - center[1]) ** 2 + (surface.rest[v * 3 + 2] - center[2]) ** 2 <= reach2;
    const moves = (v: number) => deltas.some(d => !!d && Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) > LID_MOTION);
    const list: (typeof kept)[number] = [];
    const moving = new Map<number, boolean>();
    for (let t = 0; t < surface.triangles.length; t += 3) {
      if (surface.skip?.[t / 3]) continue;
      const a = surface.triangles[t], b = surface.triangles[t + 1], c = surface.triangles[t + 2];
      if (!near(a) || !near(b) || !near(c)) continue;
      let any = false;
      for (const v of [a, b, c]) {
        let m = moving.get(v);
        if (m === undefined) {
          m = moves(v); moving.set(v, m);
          if (m) for (let k = 0; k < 3; k++) {
            let low = surface.rest[v * 3 + k], high = low;
            for (const d of deltas) if (d) { low += Math.min(0, d[v * 3 + k]); high += Math.max(0, d[v * 3 + k]); }
            lo[k] = Math.min(lo[k], low, surface.rest[v * 3 + k]); hi[k] = Math.max(hi[k], high, surface.rest[v * 3 + k]);
          }
        }
        any = any || m;
      }
      list.push({ n, a, b, c, source: surface.sourceTriangles?.[t / 3] ?? t / 3, moves: any });
    }
    kept.push(list);
  });
  const box = (surface: LidSurface, ...corners: number[]) => {
    const l = [Infinity, Infinity, Infinity], h = [-Infinity, -Infinity, -Infinity];
    for (const v of corners) for (let k = 0; k < 3; k++) { l[k] = Math.min(l[k], surface.rest[v * 3 + k]); h[k] = Math.max(h[k], surface.rest[v * 3 + k]); }
    return [l, h];
  };
  surfaces.forEach((surface, n) => {
    const map = new Map<number, number>(), used: number[] = [];
    const take = (v: number) => { let i = map.get(v); if (i === undefined) { i = used.length; map.set(v, i); used.push(v); } return i; };
    const all: number[] = [], mov: number[] = [], idsAll: number[] = [], idsMov: number[] = [];
    for (const t of kept[n]) {
      if (!t.moves && lo[0] <= hi[0]) {
        // A still triangle too far from where anything moves is never crossed.
        const [l, h] = box(surface, t.a, t.b, t.c);
        if ([0, 1, 2].some(k => h[k] < lo[k] - TOLERANCE || l[k] > hi[k] + TOLERANCE)) continue;
      }
      const g = triangleWelds.length, ia = take(t.a), ib = take(t.b), ic = take(t.c);
      all.push(ia, ib, ic); idsAll.push(g);
      if (t.moves) { mov.push(ia, ib, ic); idsMov.push(g); }
      const ids = [t.a, t.b, t.c].map(v => {
        const key = [0, 1, 2].map(k => Math.round(surface.rest[v * 3 + k] / WELD)).join(',');
        let id = weldIds.get(key);
        if (id === undefined) { id = parent.length; parent.push(id); weldIds.set(key, id); }
        return id;
      });
      for (const id of ids.slice(1)) { const x = find(ids[0]), y = find(id); if (x !== y) parent[x] = y; }
      triangleWelds.push(ids); triangleSurface.push(n); triangleSource.push(t.source); triangleMoves.push(t.moves);
    }
    const gather = (source: Float64Array | undefined) => {
      const out = new Float64Array(used.length * 3);
      if (source) used.forEach((v, i) => { out[i * 3] = source[v * 3]; out[i * 3 + 1] = source[v * 3 + 1]; out[i * 3 + 2] = source[v * 3 + 2]; });
      return out;
    };
    pieces.push({ label: surface.label, rest: gather(surface.rest), deltas: [surface.blink, surface.squint, surface.wide].map(gather),
      all: Uint32Array.from(all), mov: Uint32Array.from(mov), idsAll: Uint32Array.from(idsAll), idsMov: Uint32Array.from(idsMov) });
  });
  const total = triangleWelds.length, movingCount = triangleMoves.filter(Boolean).length;
  const empty: EyePenetration = { mode, poses: poses.length, triangles: total, moving: movingCount, crossingPoses: 0, crossing: [], worstCrossing: null, restPairs: 0, restPieces: 0 };
  if (!movingCount || !poses.length) return empty;

  /** Every piece's vertices in a pose: its rest positions and each morph's deltas at the pose's weights. */
  const posedPoints = (pose: LidPose): Float64Array[] => {
    const weights = [pose.blink, pose.squint, pose.wide];
    return pieces.map(piece => {
      const points = Float64Array.from(piece.rest);
      weights.forEach((w, m) => { if (w) { const d = piece.deltas[m]; for (let i = 0; i < points.length; i++) points[i] += w * d[i]; } });
      return points;
    });
  };
  /** The posed pieces as crossing surfaces: every judged triangle, or only the moving ones. */
  const surfacesOf = (points: Float64Array[], which: 'all' | 'mov'): CrossingSurface[] => {
    const out: CrossingSurface[] = [];
    pieces.forEach((piece, n) => {
      const triangles = which === 'all' ? piece.all : piece.mov;
      if (!triangles.length) return;
      const ids = which === 'all' ? piece.idsAll : piece.idsMov;
      out.push({ label: String(n), points: points[n], triangles, sourceTriangles: ids, ids });
    });
    return out;
  };
  const pairKey = (a: number, b: number) => a < b ? a * total + b : b * total + a;
  const pieceOf = (g: number) => find(triangleWelds[g][0]);
  const welded = (a: number, b: number) => triangleWelds[a].some(v => triangleWelds[b].includes(v));

  // The default pass crosses only the triangles that can meet (see the header); `exhaustive`, or a morph that sweeps so much
  // of the face that too many pairs could meet, crosses them all.
  const corner = new Int32Array(3 * total);
  for (const piece of pieces) piece.idsAll.forEach((g, k) => { for (let c = 0; c < 3; c++) corner[3 * g + c] = piece.all[3 * k + c]; });
  const meeting = options.exhaustive ? null : meetingIndex({
    pieces, total, corner, pieceIndex: Int32Array.from(triangleSurface), moves: Uint8Array.from(triangleMoves, m => m ? 1 : 0), weld: triangleWelds,
  }, [0, 1, 2].map(m => {
    const weights = [0, ...poses.map(p => [p.blink, p.squint, p.wide][m])];
    return [Math.min(...weights), Math.max(...weights)] as [number, number];
  }), welded, options.maxCandidates ?? LID_CANDIDATE_CAP);
  const crossingsAt = (pose: LidPose, skip: SkipPair, limit: number): SurfaceCrossing[] => {
    const points = posedPoints(pose);
    return meeting ? meeting(points, skip, limit) : surfaceCrossings(surfacesOf(points, 'all'), surfacesOf(points, 'mov'), TOLERANCE, limit, skip);
  };

  // Pairs that cross at rest, and the pairs of welded pieces they join: a part seated in the skin by design, or a blade
  // in a lens well, is not judged in any pose. (Triangles that share a welded corner are no crossing in any pose.)
  const still: LidPose = { blink: 0, squint: 0, wide: 0 };
  const restHits = crossingsAt(still, welded, 1_000_000);
  const restPairs = new Set<number>(), sunk = new Set<string>();
  for (const h of restHits) {
    restPairs.add(pairKey(h.triangle, h.skinTriangle));
    const x = pieceOf(h.triangle), y = pieceOf(h.skinTriangle);
    if (x !== y) sunk.add(x < y ? `${x},${y}` : `${y},${x}`);
  }
  const exempt = (a: number, b: number) => {
    if (welded(a, b) || restPairs.has(pairKey(a, b))) return true;
    const x = pieceOf(a), y = pieceOf(b);
    return x !== y && sunk.has(x < y ? `${x},${y}` : `${y},${x}`);
  };

  const crossing: LidCrossingPose[] = [];
  let crossingPoses = 0, worst: EyePenetration['worstCrossing'] = null, worstDepth = 0;
  for (const pose of poses) {
    // A pair judged exempt is skipped before it costs anything, and does not count against the limit.
    const hits = crossingsAt(pose, exempt, 2 * pairLimit);
    const fresh = new Map<number, { a: number; b: number; y: number }>();
    for (const h of hits) { const key = pairKey(h.triangle, h.skinTriangle); if (!fresh.has(key)) fresh.set(key, { a: h.triangle, b: h.skinTriangle, y: h.at[1] }); }
    if (!fresh.size) continue;
    crossingPoses++;
    const found = [...fresh.entries()].sort((x, y) => x[0] - y[0]).slice(0, pairLimit);
    const label = poseLabel(pose, suffix);
    if (crossing.length < LID_POSES_LISTED) crossing.push({ pose: label, pairs: found.length });
    // The most pairs wins (the count is capped, so ties are common): of equal counts, the pose with the larger weights, the deeper one.
    const depth = pose.blink + pose.squint + pose.wide;
    if (!worst || found.length > worst.pairs || found.length === worst.pairs && depth >= worstDepth) {
      worstDepth = depth;
      const heights = found.map(([, f]) => (f.y - center[1]) / radius);
      worst = {
        pose: label, pairs: found.length, heights: [Number(Math.min(...heights).toFixed(2)), Number(Math.max(...heights).toFixed(2))],
        examples: found.slice(0, LID_EXAMPLES).map(([, f]) => ({ part: pieces[triangleSurface[f.a]].label, triangle: triangleSource[f.a], other: pieces[triangleSurface[f.b]].label, otherTriangle: triangleSource[f.b] })),
      };
    }
  }
  return { ...empty, crossingPoses, crossing, worstCrossing: worst, restPairs: restPairs.size, restPieces: sunk.size };
}
