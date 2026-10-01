import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {readGLB,readAccessor} from '../src/gltf-read.ts';

(findBlender()?it:it.skip)('repairs shortened sprout thumb roots with bounded opt-in weights',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-sprout-thumb-'));
 try{
  for(const age of ['child','adult']){
   const output=join(dir,`${age}.glb`),script=join(dir,`${age}.py`);
   await writeFile(script,`import runpy\nEXPORT_ANIMATION_MODE='NLA_TRACKS'\ndef build():\n return runpy.run_path(${JSON.stringify(resolve('tests/blender_sprout_thumb_fixture.py'))})['build']('${age}')\n`);
   await authorGLB(script,output);
   const doc=readGLB(await readFile(output));
   const body=doc.json.nodes!.find(n=>n.name==='sprout-body')!;
   expect(body.skin).toBeDefined();
   for(const primitive of doc.json.meshes![body.mesh!].primitives){
    const weights=readAccessor(doc,primitive.attributes.WEIGHTS_0).data;
    for(let i=0;i<weights.length;i+=4){
     const row=Array.from(weights.slice(i,i+4));
     expect(row.every(w=>Number.isFinite(w)&&w>=0)).toBe(true);
     expect(Math.abs(row.reduce((a,b)=>a+b,0)-1)).toBeLessThan(1e-6);
    }
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
},300000);
