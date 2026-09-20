import { BufferAttribute, Color, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import type { Pattern, Vec3 } from '../core/types.ts';

/**
 * Procedural surface patterns evaluated per vertex in world space. Pure and deterministic, so the
 * authoring render, the export and the browser viewer all paint the same dots on the same spots.
 */
const AXES = { x: 0, y: 1, z: 2 } as const;
const cache = new Map<string, Color>();

/** True where the pattern's ink lands at a world point. */
export function patternHit(pattern: Pattern, point: Vec3): boolean {
  const [ox, oy, oz] = pattern.offset ?? [0, 0, 0];
  const p: Vec3 = [point[0] - ox, point[1] - oy, point[2] - oz], s = pattern.size;
  const axis = AXES[pattern.axis ?? 'y'];
  switch (pattern.type) {
    case 'dots': return Math.hypot(...p.map(v => v - Math.round(v / s) * s)) <= s * 0.3;
    case 'stripes': return Math.floor(p[axis] / (s / 2)) % 2 === 0;
    case 'checks': { const [a, b] = [0, 1, 2].filter(i => i !== axis); return (Math.floor(p[a] / s) + Math.floor(p[b] / s)) % 2 === 0; }
  }
}
/** The pattern's ink color where it lands, otherwise the base. The returned Color is shared; copy it before mutating. */
export function patternColor(pattern: Pattern, base: Color, point: Vec3): Color {
  if (!patternHit(pattern, point)) return base;
  let ink = cache.get(pattern.color);
  if (!ink) cache.set(pattern.color, ink = new Color(pattern.color));
  return ink;
}

/**
 * Base colors live in a `color_1` attribute (glTF COLOR_1): rgb is the un-patterned color of each
 * vertex and a is its shade (ambient occlusion for shells, 1 for parts). The visible `color`
 * attribute (COLOR_0) is always pattern(base.rgb) * base.a, so any pattern can be re-baked from
 * the base later, in the viewer, without a remesh, and baking `null` restores the original look.
 */
export function uniformBase(count: number, color: Color): BufferAttribute {
  const base = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) base.set([color.r, color.g, color.b, 1], i * 4);
  return new BufferAttribute(base, 4);
}
/** Write `color` from `color_1` through the pattern, sampling world points as positions times `matrix`. */
export function bakePattern(geometry: BufferGeometry, pattern: Pattern | null | undefined, matrix: Matrix4): void {
  const base = geometry.getAttribute('color_1'), positions = geometry.getAttribute('position');
  if (!base || base.itemSize !== 4 || base.count !== positions.count) throw new Error('bakePattern needs a color_1 base attribute with one rgba per vertex');
  let out = geometry.getAttribute('color') as BufferAttribute | undefined;
  if (!out || out.count !== positions.count || out.itemSize !== 3) { out = new BufferAttribute(new Float32Array(positions.count * 3), 3); geometry.setAttribute('color', out); }
  const p = new Vector3(), c = new Color();
  for (let i = 0; i < positions.count; i++) {
    p.fromBufferAttribute(positions, i).applyMatrix4(matrix);
    c.setRGB(base.getX(i), base.getY(i), base.getZ(i));
    const ink = pattern ? patternColor(pattern, c, [p.x, p.y, p.z]) : c, shade = base.getW(i);
    out.setXYZ(i, ink.r * shade, ink.g * shade, ink.b * shade);
  }
  out.needsUpdate = true;
}
