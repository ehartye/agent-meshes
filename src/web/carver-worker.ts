import { validateProject, shellSchema } from '../core/model.ts';
import { shellField } from '../render/shell.ts';
import { createSolid } from '../render/carving.ts';
import type { Solid } from '../render/carving.ts';
import type { CarverOptions } from './carver.ts';

let solid:Solid|null=null;
self.onmessage=event=>{
  const data=event.data;
  try{
    if(data.type==='init'){
      if(solid)throw new Error('Carver body is immutable');
      const options=data.options as CarverOptions,shell=shellSchema.parse(options.shell),project=validateProject({...options.project,shells:[shell]});
      const body=shellField(project,shell),floor=options.floorY;
      if(floor!==undefined&&!Number.isFinite(floor))throw new Error('Floor height must be finite');
      solid=createSolid(p=>Math.max(body([...p]),floor===undefined?-Infinity:floor-p[1]),options);return;
    }
    if(!solid)throw new Error('Carving worker was not initialized');
    const result=solid.carve(data.request),transfer:ArrayBuffer[]=[result.mesh.positions.buffer as ArrayBuffer,result.mesh.normals.buffer as ArrayBuffer,result.mesh.indices.buffer as ArrayBuffer];
    if(result.removed)transfer.push(result.removed.positions.buffer as ArrayBuffer,result.removed.normals.buffer as ArrayBuffer,result.removed.indices.buffer as ArrayBuffer);
    self.postMessage({id:data.id,result},{transfer});
  }catch(error){self.postMessage({id:data.type==='init'?0:data.id,error:error instanceof Error?error.message:String(error)})}
};
