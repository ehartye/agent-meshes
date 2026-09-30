import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';

(findBlender()?it:it.skip)('fits bounded garment offsets against rest and animated body and self contact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-garment-fit-'));
 try{
  const output=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_garment_fit_fixture.py'),output);
  expect((await readFile(output)).length).toBeGreaterThan(100);
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
