import { finite, freeze, length, pathDistances, samplePath, subtract } from './mobile-math.ts';
import type { Vec3 } from './mobile-math.ts';
export type { Vec3, Quat } from './mobile-math.ts';

export interface MobileWire {
  readonly points: readonly Vec3[];
  readonly radius: number;
  readonly density: number;
}
export interface MobileSheet {
  /** Ordered convex polygon in local XY. Thickness is centered on local Z = 0. */
  readonly contour: readonly (readonly [number, number])[];
  readonly thickness: number;
  readonly density: number;
  /** Uniform XY scaling about the local origin; must include the authored scale 1. */
  readonly scaleRange?: readonly [number, number];
}
export interface MobileHanger {
  /** Wire whose base follows the rail and whose tip is the piece's suspension anchor. */
  readonly wire: number;
  readonly path: readonly Vec3[];
  /** Normalized distance along the rail, not a sample index. */
  readonly initial: number;
}
export interface MobilePiece {
  readonly name: string;
  readonly wires: readonly MobileWire[];
  readonly leaf?: MobileSheet;
  readonly suspension: {
    /** null is the one fixed ceiling; its parentAnchor is a world coordinate. */
    readonly parent: string | null;
    readonly parentAnchor: Vec3;
    readonly anchor: Vec3;
  };
  readonly hanger?: MobileHanger;
}
/** Meters, kilograms, seconds; Y up. Pieces start with identity rotation. */
export interface MobileSpec { readonly nodes: readonly MobilePiece[] }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} needs ${min}..${max} entries`);
  return value;
}
export function coordinates(value: unknown, label: string): Vec3 {
  const p = array(value, 3, 3, label);
  return [finite(p[0], -1000, 1000, label), finite(p[1], -1000, 1000, label), finite(p[2], -1000, 1000, label)];
}
function curve(value: unknown, label: string): readonly Vec3[] {
  const points = array(value, 2, 128, label).map(p => coordinates(p, label));
  for (let i = 1; i < points.length; i++) if (length(subtract(points[i], points[i - 1])) < 1e-7) throw new Error(`${label} has repeated samples`);
  return points;
}
export function polygonInfo(points: MobileSheet['contour']): { area: number; centroid: Vec3; winding: number } {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross; x += (a[0] + b[0]) * cross; y += (a[1] + b[1]) * cross;
  }
  return { area: Math.abs(twiceArea) / 2, centroid: [x / (3 * twiceArea), y / (3 * twiceArea), 0], winding: Math.sign(twiceArea) };
}
function contour(value: unknown): MobileSheet['contour'] {
  const points = array(value, 3, 128, 'Leaf contour').map(p => {
    const xy = array(p, 2, 2, 'Contour point');
    return [finite(xy[0], -1000, 1000, 'Contour X'), finite(xy[1], -1000, 1000, 'Contour Y')] as const;
  });
  const { area, winding } = polygonInfo(points);
  if (area < 5e-9) throw new Error('Leaf contour has zero area');
  // Every other vertex must lie on the same side of each edge. This also rejects
  // concave and self-crossing input instead of silently replacing it by a hull.
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-7) throw new Error('Repeated contour point');
    for (let j = 0; j < points.length; j++) {
      if (j === i || j === (i + 1) % points.length) continue;
      const c = points[j], cross = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * winding;
      if (cross < -1e-10) throw new Error('Leaf contour must be convex and ordered');
      if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-7) throw new Error('Repeated contour point');
    }
  }
  return points;
}

/** Return detached, deeply frozen geometry. No engine initialization or allocation. */
export function validateMobileSpec(input: unknown): MobileSpec {
  const source = record(input, 'Mobile'), names = new Set<string>();
  let segmentCount = 0;
  const nodes: MobilePiece[] = array(source.nodes, 1, 32, 'Mobile pieces').map(value => {
    const raw = record(value, 'Piece');
    if (typeof raw.name !== 'string' || !/^[A-Za-z][\w.-]{0,63}$/.test(raw.name) || names.has(raw.name)) throw new Error('Piece names must be unique identifiers of at most 64 characters');
    names.add(raw.name);
    const wires: MobileWire[] = array(raw.wires, 0, 8, 'Wire paths').map(value => {
      const wire = record(value, 'Wire'), points = curve(wire.points, 'Wire points');
      segmentCount += points.length - 1;
      return { points, radius: finite(wire.radius, 1e-5, 1, 'Wire radius'), density: finite(wire.density, 1, 50000, 'Wire density') };
    });
    let leaf: MobileSheet | undefined;
    if (raw.leaf !== undefined) {
      const sheet = record(raw.leaf, 'Leaf'), range = array(sheet.scaleRange ?? [1, 1], 2, 2, 'Leaf scale range');
      const min = finite(range[0], .1, 4, 'Minimum scale'), max = finite(range[1], .1, 4, 'Maximum scale');
      if (min > 1 || max < 1 || min > max) throw new Error('Leaf scale range must contain authored scale 1');
      leaf = { contour: contour(sheet.contour), thickness: finite(sheet.thickness, 1e-5, 1, 'Sheet thickness'), density: finite(sheet.density, 1, 50000, 'Sheet density'), scaleRange: [min, max] };
    }
    if (!wires.length && !leaf) throw new Error('Piece needs physical geometry');
    const joint = record(raw.suspension, 'Suspension');
    if (joint.parent !== null && typeof joint.parent !== 'string') throw new Error('Suspension parent must be a name or null ceiling');
    const suspension = { parent: joint.parent, parentAnchor: coordinates(joint.parentAnchor, 'Parent anchor'), anchor: coordinates(joint.anchor, 'Child anchor') };
    let hanger: MobileHanger | undefined;
    if (raw.hanger !== undefined) {
      if (leaf) throw new Error('Sliding hanger is only supported on wire pieces');
      const h = record(raw.hanger, 'Hanger'), wire = finite(h.wire, 0, wires.length - 1, 'Hanger wire index');
      if (!Number.isInteger(wire)) throw new Error('Hanger wire index must be an integer');
      hanger = { wire, path: curve(h.path, 'Hanger rail'), initial: finite(h.initial, 0, 1, 'Initial hanger') };
      const points = wires[wire].points;
      if (length(subtract(points.at(-1)!, suspension.anchor)) > 1e-6) throw new Error('Hanger wire must end at its suspension anchor');
      if (length(subtract(samplePath(hanger.path, pathDistances(hanger.path), hanger.initial), points[0])) > 1e-6) throw new Error('Initial hanger must start on its rail');
    }
    let mass = leaf ? polygonInfo(leaf.contour).area * leaf.thickness * leaf.density : 0;
    for (const wire of wires) mass += pathDistances(wire.points).at(-1)! * Math.PI * wire.radius ** 2 * wire.density;
    finite(mass, 1e-6, 1e5, 'Authored piece mass');
    return { name: raw.name, wires, ...(leaf ? { leaf } : {}), suspension, ...(hanger ? { hanger } : {}) };
  });
  if (segmentCount > 2048) throw new Error('Mobile exceeds 2048 wire segments');
  if (nodes.filter(n => n.suspension.parent === null).length !== 1) throw new Error('Mobile needs exactly one ceiling root');
  const byName = new Map(nodes.map(n => [n.name, n]));
  for (const node of nodes) {
    const seen = new Set<string>(); let current = node;
    while (true) {
      if (seen.has(current.name)) throw new Error('Suspension cycle');
      seen.add(current.name);
      if (current.suspension.parent === null) break;
      const parent = byName.get(current.suspension.parent);
      if (!parent) throw new Error(`Unknown parent: ${current.suspension.parent}`);
      current = parent;
    }
  }
  return freeze({ nodes });
}
