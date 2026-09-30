import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {readGLB} from '../src/gltf-read.ts';

(findBlender()?it:it.skip)('exports object and facial NLA tracks as one playable clip',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-nla-groups-'));
 try {
  const path=join(dir,'model.glb');
  await authorGLB(resolve('tests/fixtures/face-rig/test_nla_groups.py'),path);
  const doc=readGLB(await readFile(path));
  const animations=(doc.json as unknown as {animations:{name:string;channels:{target:{path:string}}[]}[]}).animations;
  expect(animations.map(a=>a.name)).toEqual(['idle']);
  const paths=animations[0].channels.map(c=>c.target.path);
  expect(paths).toContain('translation');expect(paths).toContain('weights');
  const defaultSource=join(dir,'default.py');
  await writeFile(defaultSource,(await readFile(resolve('tests/fixtures/face-rig/test_nla_groups.py'),'utf8')).replace("EXPORT_ANIMATION_MODE = 'NLA_TRACKS'",''));
  await authorGLB(defaultSource,path);
  const legacy=readGLB(await readFile(path)).json as unknown as {animations:{channels:{target:{path:string}}[]}[]};
  expect(legacy.animations).toHaveLength(2);
  expect(legacy.animations.some(a=>a.channels.some(c=>c.target.path==='weights')&&a.channels.some(c=>c.target.path==='translation'))).toBe(false);
 } finally {await rm(dir,{recursive:true,force:true})}
},120000);
