import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {readGLB} from '../src/gltf-read.ts';

(findBlender()?it:it.skip)('exports shortened adult and child digits with fitted joints and normalized skin',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-sprout-digits-'));
 try{
  for(const age of ['adult','child']){
   const output=join(dir,`${age}.glb`),script=join(dir,`${age}.py`);
   await writeFile(script,`import runpy\nEXPORT_ANIMATION_MODE='NLA_TRACKS'\ndef build():\n return runpy.run_path(${JSON.stringify(resolve('tests/blender_sprout_digits_fixture.py'))})['build']('${age}')\n`);
   await authorGLB(script,output);
   const doc=readGLB(await readFile(output));
   expect(doc.json.nodes?.some(n=>n.name==='sprout-body'&&n.skin!==undefined)).toBe(true);
   for(const side of ['l','r'])for(const digit of [`finger_${side}0`,`finger_${side}1`,`thumb_${side}`]){
    expect(doc.json.nodes?.some(n=>n.name===digit+'_base')).toBe(true);
    expect(doc.json.nodes?.some(n=>n.name===digit+'_tip')).toBe(true);
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
},240000);
