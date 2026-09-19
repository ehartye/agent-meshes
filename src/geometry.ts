import { BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry, LatheGeometry, ExtrudeGeometry, Shape, Vector2 } from 'three';
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
    case 'lathe': geometry = new LatheGeometry((part.geometry.profile ?? []).map(([r, h]) => new Vector2(r, h)), segments); break;
    case 'prism': {
      const shape = new Shape((part.geometry.outline ?? []).map(([px, py]) => new Vector2(px, py)));
      geometry = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 }); geometry.translate(0, 0, -0.5); break;
    }
    default: geometry = new BoxGeometry(1, 1, 1, 1, 8, 1);
  }
  geometry.scale(x, y, z);
  if (part.geometry.mirrorX) {
    // Preserve vertex indices so authored per-vertex skin weights remain attached.
    geometry.scale(-1, 1, 1);
    const indices = geometry.getIndex();
    if (indices) {
      for (let i = 0; i < indices.count; i += 3) {
        const second = indices.getX(i + 1);
        indices.setX(i + 1, indices.getX(i + 2)); indices.setX(i + 2, second);
      }
      indices.needsUpdate = true;
    }
  }
  return geometry;
}
