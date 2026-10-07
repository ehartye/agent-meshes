/**
 * Lid penetration (arkit-face/1, rig-contract invariant 1 and 6): over every mix of an eye's blink, squint and wide
 * morphs, the lids must neither pass through each other or the skin round them nor fold over.
 *
 * Morphs add linearly, and consumers soft-union their layers (an idle blink fires while a squint slider or a
 * squinting emotion holds), so every point of the blink x squint x wide cube is reached. Lids that each look right
 * alone can still cross when two morphs add: the P1a round-8 critic's continuous lids sent the lower lid's skin up in
 * front of the closing upper lid once squint reached about 0.75 with blink 0.5 or more, tearing the lash line, with 0
 * iris pixels, no flipped triangle and the verifier passing. This check poses the eye at every weight in
 * `PENETRATION_WEIGHTS` for each morph (5 x 5 x 5 mixes), and again with lid follow's extremes soft-unioned in
 * (eyeLookDown = 1 adds blink `lidFollow.down`, eyeLookUp = 1 adds wide `lidFollow.up`), and counts:
 * - triangle pairs near the eye that intersect in that pose but not at rest, where at least one of them moves with the
 *   eye's morphs (a lid passing through the other lid, its margin, or the skin round it), and
 * - moving triangles that turn over (or collapse) against their rest orientation (a fold).
 */

export const PENETRATION_WEIGHTS: readonly number[] = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
/** Triangles whose three vertices lie within this many eyeball radii of the eye center at rest are judged. */
export const PENETRATION_REACH = 3;
/** A vertex moves with the eye when one of its eye morphs moves it farther than this (m). */
const MOVES = 0.00001;
/** Rest positions closer than this (m) are one vertex (primitives split per material repeat their seam vertices). */
const WELD = 1e-7;
/** Intersections are proper crossings: an edge must pierce the other triangle this far inside (barycentric) and along. */
const EPS = 1e-7;

export interface LidSurface {
  label: string;
  rest: Float64Array;
  /** Per-morph position deltas, as in the glTF targets (missing when the surface lacks that morph). */
  blink?: Float64Array; squint?: Float64Array; wide?: Float64Array;
  triangles: Uint32Array;
  /** Triangles to leave out (attached parts, judged by their own check): 1 = skip. */
  skip?: Uint8Array;
}

export interface LidPose { blink: number; squint: number; wide: number }

export interface EyePenetration {
  /** Poses checked, triangles judged near the eye and how many of them move. */
  poses: number; triangles: number; moving: number;
  /** Poses where some triangles cross (or fold), and the worst of each. */
  crossingPoses: number; foldPoses: number;
  worstCrossing: { pose: string; pairs: number; lowerThroughUpper: number; heights: [number, number] } | null;
  worstFold: { pose: string; triangles: number } | null;
  /** Triangle pairs already intersecting at rest (not judged: a part tucked under the skin by design). */
  restPairs: number;
}

export function poseLabel(pose: LidPose, suffix: string): string {
  const parts = ([['eyeBlink', pose.blink], ['eyeSquint', pose.squint], ['eyeWide', pose.wide]] as const).filter(([, w]) => w).map(([name, w]) => `${name}${suffix}=${+w.toFixed(4)}`);
  return parts.length ? parts.join(' + ') : 'rest';
}

/** The poses judged: the weight grid for each of blink, squint and wide, and the grid with lid follow's extremes soft-unioned in. */
export function penetrationPoses(follow: { down: number; up: number }): LidPose[] {
  const union = (a: number, b: number) => 1 - (1 - a) * (1 - b);
  const seen = new Map<string, LidPose>();
  const add = (pose: LidPose) => { const key = [pose.blink, pose.squint, pose.wide].map(v => v.toFixed(6)).join(','); if (!seen.has(key)) seen.set(key, pose); };
  for (const blink of PENETRATION_WEIGHTS) for (const squint of PENETRATION_WEIGHTS) for (const wide of PENETRATION_WEIGHTS) {
    add({ blink, squint, wide });
    add({ blink: union(blink, follow.down), squint, wide });
    add({ blink, squint, wide: union(wide, follow.up) });
  }
  return [...seen.values()];
}

/** Does an edge of triangle `a` pierce triangle `b`? (points: xyz triples in `p`) */
function edgePierces(p: Float64Array, a: number[], b: number[]): boolean {
  const b0 = b[0] * 3, b1 = b[1] * 3, b2 = b[2] * 3;
  const e1x = p[b1] - p[b0], e1y = p[b1 + 1] - p[b0 + 1], e1z = p[b1 + 2] - p[b0 + 2];
  const e2x = p[b2] - p[b0], e2y = p[b2 + 1] - p[b0 + 1], e2z = p[b2 + 2] - p[b0 + 2];
  for (let k = 0; k < 3; k++) {
    const o = a[k] * 3, q = a[(k + 1) % 3] * 3;
    const dx = p[q] - p[o], dy = p[q + 1] - p[o + 1], dz = p[q + 2] - p[o + 2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-30) continue;
    const inv = 1 / det;
    const sx = p[o] - p[b0], sy = p[o + 1] - p[b0 + 1], sz = p[o + 2] - p[b0 + 2];
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u <= EPS || u >= 1 - EPS) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v <= EPS || u + v >= 1 - EPS) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > EPS && t < 1 - EPS) return true;
  }
  return false;
}

/**
 * Judge one eye: `surfaces` are the face's opaque, non-eyeball primitives with that eye's morph deltas; `up` is the
 * head's up axis (glTF +Y), used only to tell the upper lid (blink moves it down) from the lower one.
 */
export function eyePenetration(surfaces: LidSurface[], center: [number, number, number], radius: number, follow: { down: number; up: number }, suffix: string): EyePenetration {
  const reach = PENETRATION_REACH * radius;
  // Gather the judged triangles into one list over a welded vertex set.
  const weldId = new Map<string, number>();
  const verts: { surface: number; index: number }[] = [];
  const localToGlobal = surfaces.map(s => new Int32Array(s.rest.length / 3).fill(-1));
  const tris: number[][] = [], welded: number[][] = [];
  const near = (s: LidSurface, v: number) => Math.hypot(s.rest[v * 3] - center[0], s.rest[v * 3 + 1] - center[1], s.rest[v * 3 + 2] - center[2]) <= reach;
  surfaces.forEach((s, n) => {
    for (let t = 0; t < s.triangles.length; t += 3) {
      if (s.skip?.[t / 3]) continue;
      const corner = [s.triangles[t], s.triangles[t + 1], s.triangles[t + 2]];
      if (!corner.every(v => near(s, v))) continue;
      const ids = corner.map(v => {
        if (localToGlobal[n][v] < 0) { localToGlobal[n][v] = verts.length; verts.push({ surface: n, index: v }); }
        return localToGlobal[n][v];
      });
      tris.push(ids);
      welded.push(corner.map(v => {
        const key = [0, 1, 2].map(k => Math.round(s.rest[v * 3 + k] / WELD)).join(',');
        let id = weldId.get(key); if (id === undefined) { id = weldId.size; weldId.set(key, id); } return id;
      }));
    }
  });
  const count = verts.length;
  const rest = new Float64Array(count * 3), deltas = { blink: new Float64Array(count * 3), squint: new Float64Array(count * 3), wide: new Float64Array(count * 3) };
  const moving = new Uint8Array(count);
  verts.forEach(({ surface, index }, g) => {
    const s = surfaces[surface];
    for (let k = 0; k < 3; k++) rest[g * 3 + k] = s.rest[index * 3 + k];
    for (const name of ['blink', 'squint', 'wide'] as const) {
      const d = s[name]; if (!d) continue;
      for (let k = 0; k < 3; k++) deltas[name][g * 3 + k] = d[index * 3 + k];
      if (Math.hypot(d[index * 3], d[index * 3 + 1], d[index * 3 + 2]) > MOVES) moving[g] = 1;
    }
  });
  const movingTri = tris.map(t => t.some(v => moving[v]));
  // Upper lid vertices move down (-Y) at blink, lower ones up.
  const side = (v: number) => deltas.blink[v * 3 + 1] < -MOVES ? 'upper' : deltas.blink[v * 3 + 1] > MOVES ? 'lower' : 'still';
  const triSide = tris.map(t => { const sides = t.map(side); return sides.includes('upper') ? (sides.includes('lower') ? 'still' : 'upper') : sides.includes('lower') ? 'lower' : 'still'; });

  const pose = (w: LidPose) => {
    const out = Float64Array.from(rest);
    for (const [name, weight] of [['blink', w.blink], ['squint', w.squint], ['wide', w.wide]] as const) {
      if (!weight) continue;
      const d = deltas[name];
      for (let i = 0; i < out.length; i++) out[i] += weight * d[i];
    }
    return out;
  };
  // Candidate pairs from a spatial hash of the posed triangles' boxes (at least one triangle moving, no shared vertex).
  let edge = 0, edges = 0;
  for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k] * 3, b = t[(k + 1) % 3] * 3; edge += Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]); edges++; }
  const cell = Math.max(1e-5, 2 * (edges ? edge / edges : radius / 10));
  const crossings = (p: Float64Array, only?: Set<number>) => {
    const grid = new Map<string, number[]>();
    const lo = new Float64Array(tris.length * 3), hi = new Float64Array(tris.length * 3);
    tris.forEach((t, n) => {
      for (let k = 0; k < 3; k++) {
        lo[n * 3 + k] = Math.min(p[t[0] * 3 + k], p[t[1] * 3 + k], p[t[2] * 3 + k]);
        hi[n * 3 + k] = Math.max(p[t[0] * 3 + k], p[t[1] * 3 + k], p[t[2] * 3 + k]);
      }
      const i0 = Math.floor(lo[n * 3] / cell), i1 = Math.floor(hi[n * 3] / cell), j0 = Math.floor(lo[n * 3 + 1] / cell), j1 = Math.floor(hi[n * 3 + 1] / cell), k0 = Math.floor(lo[n * 3 + 2] / cell), k1 = Math.floor(hi[n * 3 + 2] / cell);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 4096) return;   // a sliver stretched across the eye: too costly, and its neighbours are judged
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
        const key = `${i},${j},${k}`; const list = grid.get(key); if (list) list.push(n); else grid.set(key, [n]);
      }
    });
    const found = new Set<number>();
    const tested = new Set<number>();
    for (const list of grid.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const a = list[x], b = list[y];
      if (!movingTri[a] && !movingTri[b]) continue;
      const key = a < b ? a * tris.length + b : b * tris.length + a;
      if (tested.has(key)) continue;
      tested.add(key);
      if (only && !only.has(key)) continue;
      let apart = false;
      for (let k = 0; k < 3; k++) if (lo[a * 3 + k] > hi[b * 3 + k] || lo[b * 3 + k] > hi[a * 3 + k]) { apart = true; break; }
      if (apart) continue;
      const wa = welded[a], wb = welded[b];
      if (wa.some(v => wb.includes(v))) continue;
      if (edgePierces(p, tris[a], tris[b]) || edgePierces(p, tris[b], tris[a])) found.add(key);
    }
    return found;
  };
  const atRest = crossings(rest);
  // Welded pieces (connected through shared vertex positions). Two pieces that already pass through each other at rest
  // are a part sunk into the skin (a brow ridge riding the lid's skin, judged by attached-parts): their pairs are not
  // judged. Surfaces apart at rest (and a continuous lid's own skin) are.
  const parent = Array.from({ length: weldId.size }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const w of welded) for (const v of w.slice(1)) { const a = find(w[0]), b = find(v); if (a !== b) parent[a] = b; }
  const piece = welded.map(w => find(w[0]));
  const sunk = new Set<string>();
  for (const key of atRest) { const a = piece[Math.floor(key / tris.length)], b = piece[key % tris.length]; if (a !== b) sunk.add(a < b ? `${a},${b}` : `${b},${a}`); }
  const judged = (key: number) => {
    if (atRest.has(key)) return false;
    const a = piece[Math.floor(key / tris.length)], b = piece[key % tris.length];
    return a === b || !sunk.has(a < b ? `${a},${b}` : `${b},${a}`);
  };
  const restNormals = triangleNormals(rest, tris);
  const poses = penetrationPoses(follow).filter(w => w.blink || w.squint || w.wide);
  let crossingPoses = 0, foldPoses = 0;
  let worstCrossing: EyePenetration['worstCrossing'] = null, worstFold: EyePenetration['worstFold'] = null;
  for (const w of poses) {
    const p = pose(w);
    const pairs = [...crossings(p)].filter(judged);
    if (pairs.length) {
      crossingPoses++;
      if (!worstCrossing || pairs.length > worstCrossing.pairs) {
        let lowerThroughUpper = 0, h0 = Infinity, h1 = -Infinity;
        for (const key of pairs) {
          const a = Math.floor(key / tris.length), b = key % tris.length;
          if ((triSide[a] === 'lower' && triSide[b] === 'upper') || (triSide[a] === 'upper' && triSide[b] === 'lower')) lowerThroughUpper++;
          for (const t of [a, b]) {
            const y = (p[tris[t][0] * 3 + 1] + p[tris[t][1] * 3 + 1] + p[tris[t][2] * 3 + 1]) / 3;
            h0 = Math.min(h0, (y - center[1]) / radius); h1 = Math.max(h1, (y - center[1]) / radius);
          }
        }
        worstCrossing = { pose: poseLabel(w, suffix), pairs: pairs.length, lowerThroughUpper, heights: [Number(h0.toFixed(2)), Number(h1.toFixed(2))] };
        if (process.env.LIDDEBUG) for (const key of pairs.slice(0, 6)) {
          const a = Math.floor(key / tris.length), b = key % tris.length;
          const where = (t: number) => `${surfaces[verts[tris[t][0]].surface].label}/${triSide[t]}${movingTri[t] ? '*' : ''} ` + [0, 1, 2].map(k => ((rest[tris[t][0] * 3 + k] + rest[tris[t][1] * 3 + k] + rest[tris[t][2] * 3 + k]) / 3 - center[k]) / radius).map(v => v.toFixed(2)).join(',');
          console.error('LIDDEBUG', poseLabel(w, suffix), where(a), '|', where(b));
        }
      }
    }
    const after = triangleNormals(p, tris);
    let folds = 0;
    for (let n = 0; n < tris.length; n++) {
      if (!movingTri[n]) continue;
      const bx = restNormals[n * 3], by = restNormals[n * 3 + 1], bz = restNormals[n * 3 + 2];
      const area = Math.hypot(bx, by, bz);
      if (area < 1e-14) continue;
      const ax = after[n * 3], ay = after[n * 3 + 1], az = after[n * 3 + 2];
      if (bx * ax + by * ay + bz * az <= 0 || Math.hypot(ax, ay, az) < 1e-3 * area) folds++;
    }
    if (folds) {
      foldPoses++;
      if (!worstFold || folds > worstFold.triangles) worstFold = { pose: poseLabel(w, suffix), triangles: folds };
    }
  }
  return { poses: poses.length, triangles: tris.length, moving: movingTri.filter(Boolean).length, crossingPoses, foldPoses, worstCrossing, worstFold, restPairs: atRest.size };
}

function triangleNormals(p: Float64Array, tris: number[][]): Float64Array {
  const out = new Float64Array(tris.length * 3);
  tris.forEach((t, n) => {
    const a = t[0] * 3, b = t[1] * 3, c = t[2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    out[n * 3] = uy * vz - uz * vy; out[n * 3 + 1] = uz * vx - ux * vz; out[n * 3 + 2] = ux * vy - uy * vx;
  });
  return out;
}
