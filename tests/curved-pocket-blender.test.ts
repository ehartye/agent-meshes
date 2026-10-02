import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {readGLB} from '../src/gltf-read.ts';
import {verifyGLB} from '../src/export.ts';

(findBlender()?it:it.skip)('replaces a curved mouth pocket while retaining old skin, UV, expression and NLA',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mesh-curved-pocket-'));
  try{
    const output=join(dir,'pocket.glb');await authorGLB(resolve('tests/blender_curved_pocket_fixture.py'),output);
    const bytes=await readFile(output),doc=readGLB(bytes);
    expect((await verifyGLB(bytes)).errors).toBe(0);
    expect(doc.json.nodes!.filter(n=>n.mesh!==undefined)).toHaveLength(1);
    expect(doc.json.meshes![0].extras?.targetNames).toEqual(['mouthSmileLeft','jawOpen']);
    expect(doc.json.materials!.map(m=>m.name)).toEqual(expect.arrayContaining(['skin','mouth_cavity']));
    const animations=(doc.json as typeof doc.json & {animations?:{name?:string}[]}).animations;
    expect(animations?.some(a=>a.name==='idle')).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
},120_000);
