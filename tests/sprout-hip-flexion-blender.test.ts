import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';

(findBlender()?it:it.skip)('keeps child and adult thighs outside the trunk throughout walk and jog',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-sprout-hip-flexion-'));
 try{
  const output=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_sprout_hip_flexion_fixture.py'),output);
  expect((await readFile(output)).length).toBeGreaterThan(1000);
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
