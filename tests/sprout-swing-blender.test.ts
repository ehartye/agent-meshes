import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {loadGait,analyzeGait,evaluateGait} from '../src/gait-analysis.ts';

(findBlender()?it:it.skip)('fits adult and child swing clearance without moving planted toes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-sprout-swing-'));
 try{
  for(const age of ['child','adult']){
   const output=join(dir,`${age}.glb`),script=join(dir,`${age}.py`);
   await writeFile(script,`import runpy\nEXPORT_ANIMATION_MODE='NLA_TRACKS'\ndef build():\n return runpy.run_path(${JSON.stringify(resolve('tests/blender_sprout_swing_fixture.py'))})['build']('${age}')\n`);
   await authorGLB(script,output);
   const source=await loadGait(await readFile(output));
   for(const clip of ['walk','jog'] as const){
    const report=analyzeGait(source,{clip});
    expect(evaluateGait(report,clip).checks.filter(c=>!c.pass),`${age} ${clip} movement checks`).toEqual([]);
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
