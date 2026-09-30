import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {readGLB,readAccessor,sceneGraph,triangles} from '../src/gltf-read.ts';
import {Vector3} from 'three';

(findBlender()?it:it.skip)('keeps donor and shell triangles stable through offset fitting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-surface-triangles-'));
 try{
  const output=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_surface_triangles_fixture.py'),output);
  const doc=readGLB(await readFile(output));
  const index=doc.json.nodes!.findIndex(node=>node.name==='frozen-shell');
  const node=doc.json.nodes![index];
  const expected=(node.extras as {testedTriangles:number[][][]}).testedTriangles;
  const world=sceneGraph(doc.json).world.get(index)!;
  const actual:number[][][]=[];
  for(const primitive of doc.json.meshes![node.mesh!].primitives){
   const positions=readAccessor(doc,primitive.attributes.POSITION);
   const indices=triangles(doc,primitive,positions.count);
   for(let i=0;i<indices.length;i+=3)actual.push(Array.from(indices.slice(i,i+3),v=>
    new Vector3().fromArray(positions.data,v*3).applyMatrix4(world).toArray()));
  }
  // Match cyclic rotations, but reject reversed winding or a changed diagonal.
  expect(actual).toHaveLength(expected.length);
  for(const face of expected){
   const match=actual.findIndex(candidate=>[0,1,2].some(shift=>face.every((point,i)=>
    point.every((value,axis)=>Math.abs(value-candidate[(i+shift)%3][axis])<1e-7))));
   expect(match,'Export must preserve each collision-tested triangle').toBeGreaterThanOrEqual(0);
   actual.splice(match,1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
