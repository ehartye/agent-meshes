/**
 * Socket-fit checker. Parts named `socket_*` are empty group nodes marking where other parts attach.
 * A contract lists the sockets a hull must provide, where, and optionally envelope boxes its geometry
 * must stay inside. The shape follows the sector-run part-kit contract.json (metres, glTF axes, ship
 * space): `tolerance.socket` defaults to 0.001, `tolerance.envelope` to 0.01.
 *
 * Envelope bounds are the axis-aligned boxes of the built meshes in ship space (a rotated part's box
 * is its rotated geometry box, so it can be slightly larger than the true shape).
 */
import { Box3, Mesh, Vector3 } from 'three';
import { buildScene } from './render/scene.ts';
import type { Project } from './core/types.ts';

export type SocketVec3 = [number, number, number];
export interface SocketContract {
  tolerance?: { socket?: number; envelope?: number };
  /** Required sockets by role; `name` is the part name (starts with `socket_`), `position` the expected ship-space position. */
  sockets: Record<string, { name: string; position: SocketVec3; tolerance?: number }>;
  /** Optional boxes in ship space. The bounds of `parts` (default: every non-socket geometry part) must lie inside [min, max]. */
  envelopes?: Record<string, { min: SocketVec3; max: SocketVec3; parts?: string[]; tolerance?: number }>;
}
export type SocketViolation =
  | { kind: 'missing-socket'; socket: string; part: string; message: string }
  | { kind: 'socket-not-empty'; socket: string; part: string; message: string }
  | { kind: 'socket-offset'; socket: string; part: string; expected: SocketVec3; actual: SocketVec3; distance: number; tolerance: number; message: string }
  | { kind: 'envelope-exceeded'; envelope: string; expected: { min: SocketVec3; max: SocketVec3 }; actual: { min: SocketVec3; max: SocketVec3 }; excess: number; tolerance: number; message: string }
  | { kind: 'envelope-empty'; envelope: string; message: string };

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const tuple = (v: Vector3): SocketVec3 => [round(v.x), round(v.y), round(v.z)];

/** Pure check of a project against a contract. Returns [] when everything fits. Positions are ship-space (world) positions. */
export function checkSockets(project: Project, contract: SocketContract): SocketViolation[] {
  const socketTol = contract.tolerance?.socket ?? 0.001;
  const envelopeTol = contract.tolerance?.envelope ?? 0.01;
  const violations: SocketViolation[] = [];
  const scene = buildScene(project);
  try {
    for (const [role, want] of Object.entries(contract.sockets)) {
      const object = scene.objects.get(want.name);
      if (!object) { violations.push({ kind: 'missing-socket', socket: role, part: want.name, message: `Socket "${role}" needs a part named "${want.name}".` }); continue; }
      if (object instanceof Mesh) { violations.push({ kind: 'socket-not-empty', socket: role, part: want.name, message: `"${want.name}" has geometry; a socket must be a group part.` }); continue; }
      const actual = object.getWorldPosition(new Vector3());
      const distance = actual.distanceTo(new Vector3(...want.position));
      const tolerance = want.tolerance ?? socketTol;
      if (distance > tolerance) violations.push({ kind: 'socket-offset', socket: role, part: want.name, expected: want.position, actual: tuple(actual), distance: round(distance), tolerance, message: `"${want.name}" is ${round(distance)} m from [${want.position}] (tolerance ${tolerance}).` });
    }
    for (const [name, env] of Object.entries(contract.envelopes ?? {})) {
      const names = env.parts ?? project.parts.filter(p => !p.name.startsWith('socket_') && p.geometry.type !== 'group').map(p => p.name);
      const box = new Box3();
      for (const part of names) { const object = scene.objects.get(part); if (object instanceof Mesh) box.expandByObject(object); }
      if (box.isEmpty()) { violations.push({ kind: 'envelope-empty', envelope: name, message: `Envelope "${name}" has no geometry to measure.` }); continue; }
      const tolerance = env.tolerance ?? envelopeTol;
      const excess = Math.max(...box.min.toArray().map((v, i) => env.min[i] - v), ...box.max.toArray().map((v, i) => v - env.max[i]));
      if (excess > tolerance) violations.push({ kind: 'envelope-exceeded', envelope: name, expected: { min: env.min, max: env.max }, actual: { min: tuple(box.min), max: tuple(box.max) }, excess: round(excess), tolerance, message: `Envelope "${name}" is exceeded by ${round(excess)} m (tolerance ${tolerance}).` });
    }
  } finally { scene.dispose(); }
  return violations;
}
