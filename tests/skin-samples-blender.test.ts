import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';

(findBlender()?it:it.skip)('samples isolated scaled NLA clips and restores animation state after success and errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-skin-samples-'));
 try{
  const output=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_skin_samples_fixture.py'),output);
  expect((await readFile(output)).length).toBeGreaterThan(1000);
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
