import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {blenderIt} from './helpers/blender.ts';

blenderIt('keeps child and adult hip surfaces clear through both leg diagnostics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-digitigrade-hip-'));
 try{
  const output=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_digitigrade_hip_fixture.py'),output);
  expect((await readFile(output)).length).toBeGreaterThan(1000);
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
