import { BufferAttribute, BufferGeometry } from 'three';
import InlineWorker from './carver-worker.ts?worker&inline';
import { solidOptions } from '../render/carving.ts';
import { createCarverSession } from './carver-session.ts';
import type { Project, Shell } from '../core/types.ts';
import type { CarveRequest, SolidOptions, SolidMesh, SolidResult } from '../render/carving.ts';

export interface CarverOptions extends SolidOptions {
  project: Project;
  shell: Shell;
  /** Immutable body clipping plane: retain Y >= floorY. Include margin below it in bounds. */
  floorY?: number;
}
export interface CarverResult {
  geometry: BufferGeometry;
  removed: BufferGeometry | null;
  stats: SolidResult['stats'];
}
export interface Carver {
  /** Returns null when superseded/disposed. Caller owns/disposes both returned geometries. */
  update(request: CarveRequest): Promise<CarverResult | null>;
  dispose(): void;
}
function geometry(data:SolidMesh):BufferGeometry {
  const result=new BufferGeometry();result.setAttribute('position',new BufferAttribute(data.positions,3));result.setAttribute('normal',new BufferAttribute(data.normals,3));result.setIndex(new BufferAttribute(data.indices,1));result.computeBoundingBox();result.computeBoundingSphere();return result;
}
/** Explicit worker-backed carving. Inline blob worker supports standalone file:// exhibits. */
export function createCarver(input:CarverOptions):Carver {
  const plan=solidOptions(input);
  if(input.floorY!==undefined&&(!Number.isFinite(input.floorY)||Math.abs(input.floorY)>1e6))throw new Error('Floor height must be finite and within supported bounds');
  if(!input.project||!Array.isArray(input.project.parts)||input.project.parts.length>2000)throw new Error('Carver requires a project with at most 2000 parts');
  const options={...structuredClone(input),...plan},worker=new InlineWorker(),session=createCarverSession(worker,options,plan.resolutions);
  return{
    async update(request){const result=await session.update(request);if(!result)return null;return{geometry:geometry(result.mesh),removed:result.removed?geometry(result.removed):null,stats:result.stats}},
    dispose:session.dispose,
  };
}
