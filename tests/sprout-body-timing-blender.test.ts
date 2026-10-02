import {expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {loadGait,analyzeGait,evaluateGait} from '../src/gait-analysis.ts';

(findBlender()?it:it.skip)('coordinates reference body timing on adult and child without losing contact or knee limits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-sprout-body-timing-'));
 const references=JSON.parse(await readFile('tests/fixtures/sprout-body-reference.json','utf8'));
 try{
 for(const age of ['child','adult']){
  const output=join(dir,`${age}.glb`),script=join(dir,`${age}.py`);
  await writeFile(script,`import runpy,json\nEXPORT_ANIMATION_MODE='NLA_TRACKS'\ndef build():\n with open(${JSON.stringify(resolve('tests/fixtures/sprout-body-reference.json'))}) as f:refs=json.load(f)\n return runpy.run_path(${JSON.stringify(resolve('tests/blender_sprout_swing_fixture.py'))})['build']('${age}',body_references=refs)\n`);
  await authorGLB(script,output);
  const source=await loadGait(await readFile(output));
  for(const clip of ['walk','jog'] as const){
   const report=analyzeGait(source,{clip,samples:128,references:[references[clip]],referenceLabels:[`body-only-${clip}`]});
   const checks=evaluateGait(report,clip,{curveScore:'symmetric'});
   await writeFile(join(dir,`${age}-${clip}.json`),JSON.stringify({...report,evaluation:checks},null,2));
   console.log(JSON.stringify({age,clip,dir,bodyR:report.comparisons![0]!.symmetric.r,failures:checks.checks.filter(c=>!c.pass)}));
   expect(checks.checks.filter(c=>!c.pass),`${age} ${clip}: four body curves and unchanged movement limits`).toEqual([]);
   expect(Object.keys(report.comparisons![0]!.symmetric.r)).toEqual(['pelvisHeight','pelvisRoll','chestPitch','headPitch']);
  }
 }
 }finally{
  // mkdtemp owns this exact directory; never widen a recursive cleanup target.
  if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('mesh-sprout-body-timing-'))throw new Error('Unexpected fixture cleanup path');
  await rm(dir,{recursive:true,force:true});
 }
},120000);
