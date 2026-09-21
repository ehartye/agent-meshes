import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Vector3 } from 'three';

type Triple = readonly [number, number, number];
/** Open centerline with closed end caps. Distances use the consumer's scene units; twist is radians. */
export interface SweepSpec {
  centers: readonly Triple[];
  radii: readonly (number | readonly [number, number])[];
  radialSegments?: number;
  twist?: readonly number[];
  /** Fix the frame orientation across a family of shapes. Must not parallel the first tangent. */
  initialNormal?: Triple;
}
/** A fresh immutable sample of the piecewise-linear centerline. */
export interface SweepSample { readonly position: Triple; readonly tangent: Triple; readonly segment: number; readonly t: number }
export interface Sweep {
  readonly geometry: BufferGeometry;
  readonly length: number;
  /** Replace the shape, retaining its ring count, radial count and GPU attributes. Omitted radial count keeps the original. */
  update(spec: SweepSpec): void;
  /** u is normalized distance along the current centerline, in 0..1. */
  samplePath(u: number): SweepSample;
  dispose(): void;
}
interface Data {
  positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
  centers: Vector3[]; segments: Vector3[]; distances: number[]; length: number; radial: number; seed: Vector3;
}
const finite = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
};
function vector(value: Triple, label: string): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} needs three coordinates`);
  return new Vector3(...value.map(n => finite(n, label)) as [number, number, number]);
}
function normalize(value: Vector3, label: string): Vector3 {
  const length = value.length();
  if (!Number.isFinite(length) || length < 1e-12) throw new Error(`Degenerate ${label}`);
  return value.divideScalar(length);
}
function buildData(spec: SweepSpec, previous?: Data): Data {
  if (!Array.isArray(spec.centers) || spec.centers.length < 2 || spec.centers.length > 4096) throw new Error('Sweep needs 2..4096 centers');
  const count = spec.centers.length, radial = spec.radialSegments ?? previous?.radial ?? 24;
  if (!Number.isInteger(radial) || radial < 3 || radial > 256) throw new Error('Radial segments must be an integer from 3 to 256');
  if (previous && (count !== previous.centers.length || radial !== previous.radial)) throw new Error('Sweep update must retain topology');
  const ring = radial + 1, body = count * ring, vertexCount = body + 2 * (radial + 1);
  if (vertexCount > 1000000) throw new Error('Sweep exceeds one million vertices');
  const centers = spec.centers.map(p => vector(p, 'Center'));
  if (!Array.isArray(spec.radii) || spec.radii.length !== count) throw new Error('Radii must match centers');
  const radii = spec.radii.map(radius => {
    const pair = typeof radius === 'number' ? [radius, radius] : radius;
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Radius must be a number or an ellipse pair');
    for (const r of pair) if (finite(r, 'Radius') <= 0) throw new Error('Radius must be positive');
    return pair;
  });
  const twist = spec.twist ?? Array<number>(count).fill(0);
  if (!Array.isArray(twist) || twist.length !== count) throw new Error('Twist must match centers');
  twist.forEach(t => finite(t, 'Twist'));
  const segments: Vector3[] = [], distances = [0];
  for (let i = 1; i < count; i++) {
    const delta = centers[i].clone().sub(centers[i-1]), length = delta.length();
    segments.push(normalize(delta, 'path segment (repeated or overflowing center)'));
    distances.push(finite(distances[i-1] + length, 'Path length'));
  }
  const length = distances[count-1];
  const tangents = centers.map((_, i) => {
    if (i === 0) return segments[0].clone();
    if (i === count-1) return segments[count-2].clone();
    if (segments[i-1].dot(segments[i]) < -.99999) throw new Error('Antiparallel path cusp');
    return normalize(segments[i-1].clone().add(segments[i]), 'path tangent');
  });
  const seed = spec.initialNormal ? vector(spec.initialNormal, 'Initial normal') : previous?.seed.clone()
    ?? [new Vector3(1,0,0), new Vector3(0,1,0), new Vector3(0,0,1)].sort((a,b) => Math.abs(a.dot(tangents[0])) - Math.abs(b.dot(tangents[0])))[0];
  const normal = normalize(seed.clone().addScaledVector(tangents[0], -seed.dot(tangents[0])), 'initial normal (parallel to tangent)');
  const positions = new Float32Array(vertexCount*3), normals = new Float32Array(vertexCount*3), uv = new Float32Array(vertexCount*2);
  const axis = new Vector3(), firstCross = new Vector3(), secondCross = new Vector3(), binormal = new Vector3();
  const write = (index: number, x: number, y: number, z: number) => {
    if (![x,y,z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e30)) throw new Error('Sweep position exceeds supported range');
    positions[index*3] = x; positions[index*3+1] = y; positions[index*3+2] = z;
  };
  for (let i = 0; i < count; i++) {
    const tangent = tangents[i], previousTangent = tangents[Math.max(0,i-1)], c = Math.max(-1,Math.min(1,previousTangent.dot(tangent)));
    if (c < -.99999) throw new Error('Antiparallel frame cusp');
    axis.crossVectors(previousTangent,tangent); firstCross.crossVectors(axis,normal); secondCross.crossVectors(axis,firstCross);
    normal.add(firstCross).addScaledVector(secondCross,1/(1+c));
    normalize(normal.addScaledVector(tangent,-normal.dot(tangent)), 'transported normal');
    binormal.crossVectors(tangent,normal);
    const cosine = Math.cos(twist[i]), sine = Math.sin(twist[i]), center = centers[i];
    for (let j = 0; j <= radial; j++) {
      const angle = (j === radial ? 0 : j)/radial*Math.PI*2;
      const x = radii[i][0]*Math.cos(angle), y = radii[i][1]*Math.sin(angle), rx = x*cosine-y*sine, ry = x*sine+y*cosine;
      write(i*ring+j, center.x+normal.x*rx+binormal.x*ry, center.y+normal.y*rx+binormal.y*ry, center.z+normal.z*rx+binormal.z*ry);
      uv[(i*ring+j)*2] = j/radial; uv[(i*ring+j)*2+1] = distances[i]/length;
    }
  }
  const bodyIndices = (count-1)*radial*6;
  const indices = previous?.indices ?? new Uint32Array(bodyIndices+radial*6);
  if (!previous) {
    let offset = 0;
    for (let i = 0; i < count-1; i++) for (let j = 0; j < radial; j++) {
      const a = i*ring+j, b = a+1, c = a+ring, d = c+1;
      indices.set([a,b,c,b,d,c],offset); offset += 6;
    }
    for (let end = 0; end < 2; end++) {
      const base = body+end*(radial+1), center = base+radial;
      for (let j = 0; j < radial; j++) { indices.set(end ? [center,base+j,base+(j+1)%radial] : [center,base+(j+1)%radial,base+j],offset); offset += 3; }
    }
  }
  // Area-weighted normals only use body faces, so caps stay flat. Accumulate
  // directly into arrays: this path runs for every interactive shape update.
  const sums = new Float64Array(body*3);
  for (let i = 0; i < bodyIndices; i += 3) {
    const a = indices[i]*3, b = indices[i+1]*3, c = indices[i+2]*3;
    const ux = positions[b]-positions[a], uy = positions[b+1]-positions[a+1], uz = positions[b+2]-positions[a+2];
    const vx = positions[c]-positions[a], vy = positions[c+1]-positions[a+1], vz = positions[c+2]-positions[a+2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    for (const index of [a,b,c]) { sums[index] += nx; sums[index+1] += ny; sums[index+2] += nz; }
  }
  for (let i = 0; i < count; i++) {
    const a = i*ring*3, b = (i*ring+radial)*3;
    for (let k = 0; k < 3; k++) sums[a+k] = sums[b+k] = sums[a+k]+sums[b+k];
  }
  for (let i = 0; i < body; i++) {
    const k = i*3, magnitude = Math.hypot(sums[k],sums[k+1],sums[k+2]);
    if (!Number.isFinite(magnitude) || magnitude < 1e-20) throw new Error('Degenerate sweep surface normal');
    normals[k] = sums[k]/magnitude; normals[k+1] = sums[k+1]/magnitude; normals[k+2] = sums[k+2]/magnitude;
  }
  for (let end = 0; end < 2; end++) {
    const base = body+end*(radial+1), source = (end ? count-1 : 0)*ring, tangent = tangents[end ? count-1 : 0], sign = end ? 1 : -1;
    for (let j = 0; j <= radial; j++) {
      const index = base+j, center = centers[end ? count-1 : 0];
      if (j === radial) { write(index,center.x,center.y,center.z); uv[index*2] = uv[index*2+1] = .5; }
      else { const k = (source+j)*3; write(index,positions[k],positions[k+1],positions[k+2]); uv[index*2] = .5+.5*Math.cos(j/radial*Math.PI*2); uv[index*2+1] = .5+.5*Math.sin(j/radial*Math.PI*2); }
      normals[index*3] = tangent.x*sign; normals[index*3+1] = tangent.y*sign; normals[index*3+2] = tangent.z*sign;
    }
  }
  return { positions, normals, uv, indices, centers, segments, distances, length, radial, seed };
}

/** Create a capped, elliptical sweep usable in Node or any Three renderer. Owns only its geometry. */
export function createSweep(spec: SweepSpec): Sweep {
  let data = buildData(spec), disposed = false;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',new BufferAttribute(data.positions,3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('normal',new BufferAttribute(data.normals,3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('uv',new BufferAttribute(data.uv,2).setUsage(DynamicDrawUsage));
  geometry.setIndex(new BufferAttribute(data.indices,1)); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const alive = () => { if (disposed) throw new Error('Sweep is disposed'); };
  const tuple = (v: Vector3): Triple => Object.freeze([v.x,v.y,v.z] as [number,number,number]);
  return {
    geometry,
    get length() { return data.length; },
    update(next) {
      alive();
      // Finish validation and generation in scratch buffers before committing anything.
      const fresh = buildData(next,data);
      for (const [name, values] of [['position',fresh.positions],['normal',fresh.normals],['uv',fresh.uv]] as const) {
        const attribute = geometry.getAttribute(name) as BufferAttribute;
        attribute.array.set(values); attribute.needsUpdate = true;
      }
      data = fresh; geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    },
    samplePath(u) {
      alive(); finite(u,'Path fraction'); if (u < 0 || u > 1) throw new Error('Path fraction must be 0..1');
      const distance = u*data.length; let low = 0, high = data.centers.length-1;
      while (high-low > 1) { const middle = (low+high)>>1; if (data.distances[middle] <= distance) low = middle; else high = middle; }
      const segment = Math.min(low,data.centers.length-2), t = (distance-data.distances[segment])/(data.distances[segment+1]-data.distances[segment]);
      return Object.freeze({ position: tuple(data.centers[segment].clone().lerp(data.centers[segment+1],t)), tangent: tuple(data.segments[segment]), segment, t });
    },
    dispose() { if (!disposed) { geometry.dispose(); disposed = true; } },
  };
}
