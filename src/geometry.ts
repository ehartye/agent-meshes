import { BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry, LatheGeometry, ExtrudeGeometry, Shape, Vector2 } from 'three';
import type { BufferGeometry } from 'three';
import type { Part } from './core/types.ts';
import { buildLathe } from './lathe.ts';

/** CPU-only geometry shared by model validation, rendering and export. */
export function geometryFor(part: Part): BufferGeometry {
  const { type, size: [x, y, z], segments } = part.geometry;
  let geometry: BufferGeometry;
  // Metre profiles and outlines carry their own scale, so size must not scale them again.
  let scale: [number, number, number] = [x, y, z];
  switch (type) {
    case 'sphere': geometry = new SphereGeometry(0.5, segments, Math.max(4, Math.floor(segments / 2))); break;
    case 'cylinder': geometry = new CylinderGeometry(0.5, 0.5, 1, segments, 8); break;
    case 'cone': geometry = new ConeGeometry(0.5, 1, segments, 8); break;
    case 'capsule': geometry = new CapsuleGeometry(0.25, 0.5, 4, segments); geometry.scale(2, 1, 2); break;
    case 'lathe': {
      const g = part.geometry, profile = g.profile ?? [];
      if (g.profileUnits === undefined && g.corners === undefined && g.angleRange === undefined && g.startAngle === undefined) {
        geometry = new LatheGeometry(profile.map(([r, h]) => new Vector2(r, h)), segments);
      } else {
        geometry = buildLathe({ profile, segments, corners: g.corners, angleRange: g.angleRange, startAngle: g.startAngle });
        if (g.profileUnits === 'metres') scale = [1, 1, 1];
      }
      break;
    }
    case 'prism': geometry = prismGeometry(part.geometry); scale = prismScale(part.geometry); break;
    default: geometry = new BoxGeometry(1, 1, 1, 1, 8, 1);
  }
  geometry.scale(...scale);
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

type Geometry = Part['geometry'];
/** Outline points are meters when `outlineUnits` is 'metres': the extrusion then runs from the part origin to size along the axis. */
function prismGeometry(g: Geometry): BufferGeometry {
  const metres = g.outlineUnits === 'metres', axis = g.axis ?? 'z';
  const shape = new Shape((g.outline ?? []).map(([px, py]) => new Vector2(px, py)));
  const length = metres ? g.size[axis === 'y' ? 1 : 2] : 1, bevel = g.bevel ?? 0;
  const options = bevel > 0
    // The bevel eats into the caps, so shorten the straight part to keep the overall length. bevelOffset keeps the footprint on the outline.
    ? { depth: length - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, steps: 1 }
    : { depth: length, bevelEnabled: false, steps: 1 };
  const geometry = new ExtrudeGeometry(shape, options);
  // ExtrudeGeometry spans z from -bevel to depth + bevel, that is 0 to length.
  if (bevel > 0) geometry.translate(0, 0, bevel);
  if (axis === 'z') { if (!metres) geometry.translate(0, 0, -0.5); return geometry; }
  // Outline y becomes world z and the extrusion runs along +y (rotating +90 degrees about x keeps faces outward).
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, length, 0);
  if (!metres) geometry.translate(0, -0.5, 0);
  return geometry;
}
function prismScale(g: Geometry): [number, number, number] {
  const [x, y, z] = g.size;
  return g.outlineUnits === 'metres' ? [1, 1, 1] : [x, y, z];
}
