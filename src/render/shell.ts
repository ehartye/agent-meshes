import { Box3, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Matrix4, Quaternion, Uint16BufferAttribute, Vector3 } from 'three';
import type { Part, Project, Shell, Vec2, Vec3 } from '../core/types.ts';
import { geometryFor } from '../geometry.ts';

/**
 * Organic shells: blend a set of parts into one smooth surface.
 * A signed distance field takes the smooth minimum of every member's distance, surface nets turn
 * the field into one watertight mesh, and each vertex takes its color and bone weights from the
 * members that own it. Adapted from the critter shells in no-claudes-sky.
 */

type Field = (p: Vec3) => number;

function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Signed distance to the unit shape of a part, in the part's local space, scaled by its size. */
function localDistance(part: Part, p: Vector3): number {
  const [sx, sy, sz] = part.geometry.size;
  const g = part.geometry;
  switch (g.type) {
    case 'box': return sdBox(p, sx / 2, sy / 2, sz / 2);
    case 'sphere': { const q = new Vector3(p.x / sx, p.y / sy, p.z / sz); return (q.length() - 0.5) * Math.min(sx, sy, sz); }
    case 'cylinder': return sdCylinder(p, (sx + sz) / 4, sy / 2);
    case 'cone': return sdCone(p, (sx + sz) / 4, sy / 2);
    case 'capsule': return sdCapsule(p, (sx + sz) / 4, sy);
    case 'lathe': return sdLathe(p, g.profile ?? [], sx / 2, sy);
    case 'prism': return sdPrism(p, g.outline ?? [], sx, sy, sz / 2);
    default: return sdBox(p, sx / 2, sy / 2, sz / 2);
  }
}
function sdBox(p: Vector3, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(p.x) - hx, qy = Math.abs(p.y) - hy, qz = Math.abs(p.z) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}
function sdCylinder(p: Vector3, r: number, h: number): number {
  const dx = Math.hypot(p.x, p.z) - r, dy = Math.abs(p.y) - h;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
/** A cone with its base (radius r) at y = -h and its tip at y = +h. */
function sdCone(p: Vector3, r: number, h: number): number {
  const q = [Math.hypot(p.x, p.z), p.y] as const;
  // Distance to the slanted edge from (r, -h) to (0, h) and to the base, as a 2D polygon.
  return polygonDistance([[0, h], [r, -h], [0, -h]], q[0], q[1], true);
}
function sdCapsule(p: Vector3, r: number, height: number): number {
  const half = Math.max(height / 2 - r, 0);
  const y = Math.max(-half, Math.min(half, p.y));
  return Math.hypot(p.x, p.y - y, p.z) - r;
}
function sdLathe(p: Vector3, profile: Vec2[], radiusScale: number, heightScale: number): number {
  const pts: Vec2[] = profile.map(([r, y]) => [r * radiusScale * 2, y * heightScale]);
  // Close the profile along the axis so the inside test works.
  const closed: Vec2[] = [...pts, [0, pts[pts.length - 1][1]], [0, pts[0][1]]];
  return polygonDistance(closed, Math.hypot(p.x, p.z), p.y, true);
}
function sdPrism(p: Vector3, outline: Vec2[], sx: number, sy: number, hz: number): number {
  const pts: Vec2[] = outline.map(([x, y]) => [x * sx, y * sy]);
  const d2 = polygonDistance(pts, p.x, p.y, true), dz = Math.abs(p.z) - hz;
  return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
}
/** Signed distance from (x, y) to a closed 2D polygon. */
function polygonDistance(pts: Vec2[], x: number, y: number, signed: boolean): number {
  let best = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(wx - t * ex, wy - t * ey));
    if ((ay > y) !== (by > y) && x < ax + (y - ay) / (by - ay) * (bx - ax)) inside = !inside;
  }
  return signed && inside ? -best : best;
}

function worldMatrix(project: Project, part: Part): Matrix4 {
  const own = new Matrix4().compose(new Vector3(...part.position), new Quaternion(...part.rotation), new Vector3(...part.scale));
  if (!part.parent) return own;
  const parent = project.parts.find(p => p.name === part.parent)!;
  return worldMatrix(project, parent).multiply(own);
}

interface Member { part: Part; inverse: Matrix4; scale: number; box: Box3 }
function members(project: Project, shell: Shell): Member[] {
  return shell.parts.map(name => {
    const part = project.parts.find(p => p.name === name)!;
    const world = worldMatrix(project, part);
    const geometry = geometryFor(part);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().applyMatrix4(world);
    geometry.dispose();
    const scale = new Vector3(); world.decompose(new Vector3(), new Quaternion(), scale);
    return { part, inverse: world.clone().invert(), scale: Math.min(scale.x, scale.y, scale.z), box };
  });
}
function memberDistance(member: Member, p: Vec3): number {
  const local = new Vector3(...p).applyMatrix4(member.inverse);
  return localDistance(member.part, local) * member.scale;
}

/** The blended signed distance field of a shell, for tests and tools. */
export function shellField(project: Project, shell: Shell): Field {
  const list = members(project, shell);
  return p => { let d = Infinity; for (const m of list) d = smoothMin(d, memberDistance(m, p), shell.blend); return d; };
}

export interface ShellMesh { geometry: BufferGeometry; boneWeights: { index: number[]; weight: number[] }[] | null }

/** Mesh a shell with surface nets and attach vertex colors and, for rigid-bound members, bone weights. */
export function buildShellGeometry(project: Project, shell: Shell, boneNames: string[]): ShellMesh {
  const list = members(project, shell);
  const field: Field = p => { let d = Infinity; for (const m of list) d = smoothMin(d, memberDistance(m, p), shell.blend); return d; };
  const box = new Box3(); for (const m of list) box.union(m.box);
  const size = box.getSize(new Vector3());
  const step = (Math.max(size.x, size.y, size.z) + 2 * shell.blend) / Math.min(96, Math.max(16, shell.resolution));
  box.expandByScalar(shell.blend + step * 2);
  const lo = box.min.toArray() as Vec3;
  const [nx, ny, nz] = box.max.clone().sub(box.min).toArray().map(n => Math.ceil(n / step));
  const sample = (x: number, y: number, z: number) => (x * (ny + 1) + y) * (nz + 1) + z;
  const cell = (x: number, y: number, z: number) => (x * ny + y) * nz + z;
  const values = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let x = 0; x <= nx; x++) for (let y = 0; y <= ny; y++) for (let z = 0; z <= nz; z++) values[sample(x, y, z)] = field([lo[0] + x * step, lo[1] + y * step, lo[2] + z * step]);
  const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1] as Vec3);
  const edges = corners.flatMap((_, i) => [1, 2, 4].filter(bit => !(i & bit)).map(bit => [i, i | bit] as [number, number]));
  const vertexOf = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [], indices: number[] = [];
  const v = new Float32Array(8);
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const o = corners[c]; v[c] = values[sample(x + o[0], y + o[1], z + o[2])]; if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let px = 0, py = 0, pz = 0, count = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]), ca = corners[a], cb = corners[b];
      px += ca[0] + (cb[0] - ca[0]) * t; py += ca[1] + (cb[1] - ca[1]) * t; pz += ca[2] + (cb[2] - ca[2]) * t; count++;
    }
    vertexOf[cell(x, y, z)] = positions.length / 3;
    positions.push(lo[0] + (x + px / count) * step, lo[1] + (y + py / count) * step, lo[2] + (z + pz / count) * step);
  }
  const quad = (a: number, b: number, c: number, d: number, inside: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (inside) indices.push(a, b, c, a, c, d); else indices.push(a, c, b, a, d, c);
  };
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    const inside = values[sample(x, y, z)] < 0;
    if (y > 0 && z > 0 && inside !== (values[sample(x + 1, y, z)] < 0)) quad(vertexOf[cell(x, y - 1, z - 1)], vertexOf[cell(x, y, z - 1)], vertexOf[cell(x, y, z)], vertexOf[cell(x, y - 1, z)], inside);
    if (x > 0 && z > 0 && inside !== (values[sample(x, y + 1, z)] < 0)) quad(vertexOf[cell(x - 1, y, z - 1)], vertexOf[cell(x - 1, y, z)], vertexOf[cell(x, y, z)], vertexOf[cell(x, y, z - 1)], inside);
    if (x > 0 && y > 0 && inside !== (values[sample(x, y, z + 1)] < 0)) quad(vertexOf[cell(x - 1, y - 1, z)], vertexOf[cell(x, y - 1, z)], vertexOf[cell(x, y, z)], vertexOf[cell(x - 1, y, z)], inside);
  }
  if (!positions.length) throw new Error(`Shell ${shell.name} produced no surface; check member sizes and blend`);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Ownership: how much each member claims a vertex. Colors blend across the whole join; skin
  // weights use a tighter band so a moving limb does not drag the body with it.
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);
  const memberColors = list.map(m => new Color(m.part.color));
  const bound = list.every(m => m.part.binding?.type === 'rigid');
  const skinIndex = bound ? new Uint16Array(count * 4) : null, skinWeight = bound ? new Float32Array(count * 4) : null;
  const boneOf = list.map(m => bound ? boneNames.indexOf((m.part.binding as { bone: string }).bone) : 0);
  const distances = new Float64Array(list.length);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    let nearest = Infinity;
    for (let m = 0; m < list.length; m++) { distances[m] = memberDistance(list[m], p); nearest = Math.min(nearest, distances[m]); }
    const mix = new Color(0, 0, 0); let total = 0;
    const weights = new Array<number>(list.length);
    for (let m = 0; m < list.length; m++) {
      const excess = Math.max(distances[m] - nearest, 0);
      const wc = Math.exp(-excess / Math.max(shell.blend * 0.5, 1e-6)); total += wc; mix.add(memberColors[m].clone().multiplyScalar(wc));
      weights[m] = Math.exp(-excess / Math.max(shell.blend * 0.15, 1e-6));
    }
    mix.multiplyScalar(1 / total); colors[i * 3] = mix.r; colors[i * 3 + 1] = mix.g; colors[i * 3 + 2] = mix.b;
    if (skinIndex && skinWeight) {
      // Merge members that share a bone, keep the four strongest, renormalise.
      const perBone = new Map<number, number>();
      weights.forEach((w, m) => perBone.set(boneOf[m], (perBone.get(boneOf[m]) ?? 0) + w));
      const top = [...perBone.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0);
      top.forEach(([bone, w], k) => { skinIndex[i * 4 + k] = bone; skinWeight[i * 4 + k] = w / sum; });
    }
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  if (skinIndex && skinWeight) { geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4)); }
  return { geometry, boneWeights: null };
}
