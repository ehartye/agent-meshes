import { readAccessor, readGLB, triangles } from '../../src/gltf-read.ts';

/**
 * Streaks along a lip crease, as the exported shading normals draw them. Along level lines across the lips (every
 * 1/40 of the lip height from 0.9 below the mouth line to 0.8 above, glTF y up), each skin triangle edge the line
 * crosses gives a point with its interpolated NORMAL; along the line, the normal's up-down tilt and left-right yaw
 * are compared with a local quadratic fit over a quarter of the mouth width. `max` is the largest residual in degrees
 * (a comb of short vertical streaks shows as several degrees at the blank's column spacing); `reversals` is the most
 * turns per 10 mm of the tilt's direction of change by more than 0.25 degree (streaks alternate).
 */
export function lipCreaseStreak(bytes: Uint8Array, mouthY: number, halfWidth: number, height = 0.45 * halfWidth): { max: number; reversals: number } {
  const doc = readGLB(bytes);
  const face = doc.json.meshes!.find(m => m.name === 'face')!;
  const segments: number[][] = [];
  for (const primitive of face.primitives) {
    if (!/skin/.test(doc.json.materials![primitive.material!].name ?? '')) continue;
    const P = readAccessor(doc, primitive.attributes.POSITION).data, N = readAccessor(doc, primitive.attributes.NORMAL).data;
    const tris = triangles(doc, primitive, P.length / 3);
    for (let t = 0; t < tris.length; t += 3) {
      const v = [tris[t], tris[t + 1], tris[t + 2]];
      if (!v.every(i => Math.abs(P[i * 3]) < 1.1 * halfWidth && Math.abs(P[i * 3 + 1] - mouthY) < 1.4 * height && P[i * 3 + 2] > 0.02)) continue;
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        segments.push([P[a * 3], P[a * 3 + 1], N[a * 3], N[a * 3 + 1], N[a * 3 + 2], P[b * 3], P[b * 3 + 1], N[b * 3], N[b * 3 + 1], N[b * 3 + 2]]);
      }
    }
  }
  const fit = (points: number[][], index: number, x0: number) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const p of points) {
      const d = (p[0] - x0) * 1000, row = [1, d, d * d];
      for (let i = 0; i < 3; i++) { b[i] += row[i] * p[index]; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const f = A[j][i] / (A[i][i] || 1e-30); for (let k = 0; k < 3; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < 3; k++) s -= A[i][k] * x[k]; x[i] = s / (A[i][i] || 1e-30); }
    return x[0];
  };
  let max = 0, reversals = 0;
  for (let step = -36; step <= 32; step++) {
    const y = mouthY + step / 40 * height + 1e-7;
    if (Math.abs(y - mouthY) < 0.02 * height) continue;
    const seen = new Set<string>(), points: number[][] = [];
    for (const [xa, ya, ax, ay, az, xb, yb, bx, by, bz] of segments) {
      if ((ya - y) * (yb - y) >= 0) continue;
      const w = (y - ya) / (yb - ya), x = xa + w * (xb - xa);
      if (Math.abs(x) >= 0.8 * halfWidth) continue;
      const key = x.toFixed(9);
      if (seen.has(key)) continue;
      seen.add(key);
      const n = [ax + w * (bx - ax), ay + w * (by - ay), az + w * (bz - az)], size = Math.hypot(...n);
      points.push([x, Math.asin(n[1] / size) * 180 / Math.PI, Math.atan2(n[0], n[2]) * 180 / Math.PI]);
    }
    points.sort((p, q) => p[0] - q[0]);
    if (points.length < 8) continue;
    for (const [x0, tilt, yaw] of points) {
      const near = points.filter(p => Math.abs(p[0] - x0) < 0.25 * halfWidth);
      if (near.length >= 4) max = Math.max(max, Math.abs(tilt - fit(near, 1, x0)), Math.abs(yaw - fit(near, 2, x0)));
    }
    const change: number[] = [];
    for (let k = 1; k < points.length; k++) if (Math.abs(points[k][1] - points[k - 1][1]) > 0.25) change.push(points[k][1] - points[k - 1][1]);
    let turns = 0;
    for (let k = 1; k < change.length; k++) if (change[k] * change[k - 1] < 0) turns++;
    reversals = Math.max(reversals, turns / ((points[points.length - 1][0] - points[0][0]) * 100));
  }
  return { max, reversals };
}
