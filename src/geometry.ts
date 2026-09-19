import { BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry } from 'three';
import type { BufferGeometry } from 'three';
import type { Part } from './core/types.ts';

/** CPU-only geometry shared by model validation, rendering and export. */
export function geometryFor(part: Part): BufferGeometry {
  const { type, size: [x, y, z], segments } = part.geometry;
  let geometry: BufferGeometry;
  switch (type) {
    case 'sphere': geometry = new SphereGeometry(0.5, segments, Math.max(4, Math.floor(segments / 2))); break;
    case 'cylinder': geometry = new CylinderGeometry(0.5, 0.5, 1, segments, 8); break;
    case 'cone': geometry = new ConeGeometry(0.5, 1, segments, 8); break;
    case 'capsule': geometry = new CapsuleGeometry(0.25, 0.5, 4, segments); geometry.scale(2, 1, 2); break;
    default: geometry = new BoxGeometry(1, 1, 1, 1, 8, 1);
  }
  geometry.scale(x, y, z);
  return geometry;
}
