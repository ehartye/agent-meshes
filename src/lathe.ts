import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';

export interface LatheSpec {
  /** [radius, height] points, already in meters (or unit space; the caller scales the result). */
  profile: [number, number][];
  /** Segments around the full circle; the grid every full lathe and sector of this count shares. */
  segments: number;
  /** Indices of profile points that are hard edges. */
  corners?: number[];
  /** [startDeg, endDeg]; absent means a full revolution. */
  angleRange?: [number, number];
  /** Phase of the segment grid in degrees. */
  startAngle?: number;
}

const RAD = Math.PI / 180;
const EPS = 1e-9;
/** Grid angle k in degrees: one formula for every lathe and sector so shared vertices are bit-identical. */
const gridAngle = (startAngle: number, step: number, k: number) => startAngle + k * step;

/** Angles (degrees) of the columns: the full grid, or a sector's two ends plus the grid points strictly inside. */
export function latheColumns(segments: number, startAngle = 0, range?: [number, number]): number[] {
  const step = 360 / segments;
  if (!range || range[1] - range[0] >= 360 - EPS) return Array.from({ length: segments + 1 }, (_, k) => gridAngle(startAngle, step, k));
  const [a, b] = range, out = [a];
  for (let k = Math.floor((a - startAngle) / step) + 1; ; k++) {
    const g = gridAngle(startAngle, step, k);
    if (g >= b - EPS) break;
    if (g > a + EPS) out.push(g);
  }
  out.push(b);
  return out;
}

interface Ring { r: number; h: number; nx: number; ny: number }

/**
 * Revolve a profile around y like three's LatheGeometry (angle measured from +z toward +x) but with optional hard
 * edges and a partial sweep. Smooth joints share one vertex ring; a corner gets two rings with their own normals.
 * A partial sweep closes the profile with a wall back to its first point and caps both radial ends.
 */
export function buildLathe(spec: LatheSpec): BufferGeometry {
  const { profile, segments, startAngle = 0 } = spec;
  const partial = !!spec.angleRange && spec.angleRange[1] - spec.angleRange[0] < 360 - EPS;
  const points = profile.map(([r, h]) => [r, h] as [number, number]);
  const corner = new Set(spec.corners ?? []);
  // A profile that already ends where it began is a closed loop; point 0 and the last point are one joint.
  const same = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
  let closed = partial && points.length > 2 && same(points[0], points[points.length - 1]);
  if (closed) { points.pop(); if (corner.has(points.length)) corner.add(0); }
  // A partial profile that is not already a loop gets a wall from its last point back to its first; its two joints are hard.
  const autoWall = partial && !closed;
  if (autoWall) closed = true;
  const n = points.length, segCount = closed ? n : n - 1;
  // Unit normal of each profile segment in the (r, h) plane, oriented like three's lathe: (dy, -dx).
  const seg: ([number, number] | null)[] = [];
  for (let s = 0; s < segCount; s++) {
    const [r0, h0] = points[s], [r1, h1] = points[(s + 1) % n];
    const dx = r1 - r0, dy = h1 - h0, len = Math.hypot(dx, dy);
    seg.push(len < EPS ? null : [dy / len, -dx / len]);
  }
  /** The nearest non-degenerate segment at or beyond `s` in the given direction. */
  const nearest = (s: number, direction: 1 | -1): [number, number] => {
    for (let k = 0; k < segCount; k++) { const v = seg[(((s + direction * k) % segCount) + segCount) % segCount]; if (v) return v; }
    return [1, 0];
  };
  const rings: Ring[] = [], startRing: number[] = [], endRing: number[] = [];
  for (let j = 0; j < n; j++) {
    const [r, h] = points[j];
    const prevSeg = closed ? (j + n - 1) % n : j > 0 ? j - 1 : -1, nextSeg = closed ? j : j < n - 1 ? j : -1;
    const prev = prevSeg >= 0 ? nearest(prevSeg, -1) : null, next = nextSeg >= 0 ? nearest(nextSeg, 1) : null;
    const hard = !!prev && !!next && (corner.has(j) || (autoWall && (j === 0 || j === n - 1)));
    const push = (v: [number, number]) => { rings.push({ r, h, nx: v[0], ny: v[1] }); return rings.length - 1; };
    if (prev && next && !hard) {
      let nx = prev[0] + next[0], ny = prev[1] + next[1];
      const len = Math.hypot(nx, ny);
      if (len < EPS) { nx = next[0]; ny = next[1]; } else { nx /= len; ny /= len; }
      endRing[prevSeg] = startRing[nextSeg] = push([nx, ny]);
    } else {
      if (prev) endRing[prevSeg] = push(prev);
      if (next) startRing[nextSeg] = push(next);
    }
  }
  const columns = latheColumns(segments, startAngle, spec.angleRange);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const cols = columns.length, ringCount = rings.length;
  columns.forEach((deg, c) => {
    const phi = deg * RAD, sin = Math.sin(phi), cos = Math.cos(phi);
    for (const ring of rings) {
      positions.push(ring.r * sin, ring.h, ring.r * cos);
      normals.push(ring.nx * sin, ring.ny, ring.nx * cos);
      uvs.push(c / (cols - 1), ring.h);
    }
  });
  const flat = (id: number) => rings[id].r < EPS;
  for (let c = 0; c < cols - 1; c++) {
    for (let s = 0; s < segCount; s++) {
      if (!seg[s]) continue;
      const a = c * ringCount + startRing[s], b = (c + 1) * ringCount + startRing[s];
      const d = c * ringCount + endRing[s], e = (c + 1) * ringCount + endRing[s];
      if (!flat(startRing[s])) indices.push(a, b, d);
      if (!flat(endRing[s])) indices.push(e, d, b);
    }
  }
  if (partial) {
    // Cap polygon: the closed profile in the (r, h) plane, triangulated once and placed at both radial ends.
    const contour = points.map(([r, h]) => new Vector2(r, h));
    const area = ShapeUtils.area(contour);
    if (Math.abs(area) > EPS * EPS) {
      const tris = ShapeUtils.triangulateShape(contour, []);
      for (const [c, sign] of [[0, -1], [cols - 1, 1]] as const) {
        const phi = columns[c] * RAD, sin = Math.sin(phi), cos = Math.cos(phi);
        // Increasing angle moves along (cos, 0, -sin); each end face points away from the swept sector.
        const out = [sign * cos, 0, -sign * sin];
        const base = positions.length / 3;
        for (const [r, h] of points) { positions.push(r * sin, h, r * cos); normals.push(...out); uvs.push(r, h); }
        for (const [i, j, k] of tris) {
          const at = (v: number) => [positions[(base + v) * 3], positions[(base + v) * 3 + 1], positions[(base + v) * 3 + 2]];
          const [p, q, w] = [at(i), at(j), at(k)];
          const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
          const facing = (u[1] * v[2] - u[2] * v[1]) * out[0] + (u[2] * v[0] - u[0] * v[2]) * out[1] + (u[0] * v[1] - u[1] * v[0]) * out[2];
          if (facing >= 0) indices.push(base + i, base + j, base + k); else indices.push(base + i, base + k, base + j);
        }
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}
