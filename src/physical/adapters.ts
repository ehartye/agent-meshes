import type { Group } from 'three';
import type { Bounds, PartSource, Vector } from './ldraw.ts';
import { ldrawMetersPerUnit, loadLDrawPart } from './ldraw.ts';

export interface LoadedPart { group: Group; sourceBounds: Bounds; sourceCenter: Vector; sources: PartSource[] }

/** A geometry adapter turns a part's source description into centered SI-unit geometry (meters, +Y up). */
export interface GeometryAdapter {
  readonly id: string;
  /** Throw when the part lacks the fields this adapter needs. Runs during manifest validation. */
  validatePart(part: any): void;
  load(sourceRoot: string, part: any): Promise<LoadedPart>;
  /** Recorded verbatim in robot.json so a consumer knows how source units were converted. */
  readonly sourceTransform: Record<string, unknown>;
  /** Leading lines of ATTRIBUTION.md. Per-file author/license lines are appended from `sources`. */
  readonly attributionHeader: readonly string[];
}

export const DEFAULT_ADAPTER = 'ldraw';

export const ldrawAdapter: GeometryAdapter = {
  id: DEFAULT_ADAPTER,
  validatePart(part) {
    if (typeof part.ldraw !== 'string' || !part.ldraw) throw new Error(`LDraw adapter needs an ldraw part id: ${part.name}`);
    if (!Number.isInteger(part.color) || part.color < 0) throw new Error(`LDraw adapter needs a nonnegative integer color: ${part.name}`);
  },
  load: (library, part) => loadLDrawPart(library, part.ldraw, part.color),
  sourceTransform: { metersPerLDrawUnit: ldrawMetersPerUnit, rotation: [1, 0, 0, 0], centering: 'per-part geometry bounding-box center' },
  attributionHeader: [
    '# LDraw assembly attribution', '',
    'Geometry sourced from the local LDraw Parts Library (https://www.ldraw.org/).',
    'Each file retains its own author and license metadata below. Geometry provenance is distinct from catalog mass provenance.',
    'License links: CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ ; CC BY 2.0 https://creativecommons.org/licenses/by/2.0/ ; original LDraw agreement https://www.ldraw.org/article/227.html . These links explain the per-file declarations below; they do not replace or broaden them.',
    'Modification notice: Agent Meshes converts LDraw geometry to meters, rotates axes, centers each part, bakes transforms and assembles surfaces into GLB. Edges and conditional lines are omitted.',
  ],
};

const adapters = new Map<string, GeometryAdapter>([[ldrawAdapter.id, ldrawAdapter]]);

export function registerGeometryAdapter(adapter: GeometryAdapter): void {
  if (!/^[a-z][a-z0-9-]*$/.test(adapter.id)) throw new Error(`Invalid geometry adapter id: ${adapter.id}`);
  if (adapters.has(adapter.id)) throw new Error(`Geometry adapter already registered: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
}
export function unregisterGeometryAdapter(id: string): void {
  if (id === DEFAULT_ADAPTER) throw new Error('The default geometry adapter cannot be removed');
  adapters.delete(id);
}
export function geometryAdapter(id: string): GeometryAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown geometry adapter: ${id}. Registered: ${[...adapters.keys()].join(', ')}`);
  return adapter;
}
