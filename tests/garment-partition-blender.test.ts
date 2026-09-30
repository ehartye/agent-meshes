import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AnimationMixer,SkinnedMesh,Vector3} from 'three';
import {authorGLB} from '../src/author.ts';
import {findBlender} from '../src/refine.ts';
import {loadGait} from '../src/gait-analysis.ts';

(findBlender()?it:it.skip)('keeps exported donor and cut vertices coincident throughout a bend',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-garment-partition-'));
 try{
  const path=join(dir,'model.glb');
  await authorGLB(resolve('tests/blender_garment_partition_fixture.py'),path);
  const asset=await loadGait(await readFile(path));
  const source=asset.scene.getObjectByName('source') as SkinnedMesh;
  const garment=asset.scene.getObjectByName('garment') as SkinnedMesh;
  expect(source.isSkinnedMesh&&garment.isSkinnedMesh).toBe(true);
  const sourceRest=Array.from({length:source.geometry.attributes.position.count},(_,i)=>new Vector3().fromBufferAttribute(source.geometry.attributes.position,i));
  const garmentRest=Array.from({length:garment.geometry.attributes.position.count},(_,i)=>new Vector3().fromBufferAttribute(garment.geometry.attributes.position,i));
  const mapping=garmentRest.map(p=>sourceRest.findIndex(q=>p.distanceTo(q)<1e-7));
  expect(mapping.every(i=>i>=0)).toBe(true);
  const clip=asset.clips.find(c=>c.name==='bend')!;expect(clip).toBeDefined();
  const mixer=new AnimationMixer(asset.scene);mixer.clipAction(clip).play();
  let motion=0;
  for(let step=0;step<=32;step++){
   mixer.setTime(clip.duration*step/32);asset.scene.updateMatrixWorld(true);
   source.skeleton.update();garment.skeleton.update();
   for(let i=0;i<mapping.length;i++){
    const p=garment.getVertexPosition(i,new Vector3()).applyMatrix4(garment.matrixWorld);
    const q=source.getVertexPosition(mapping[i],new Vector3()).applyMatrix4(source.matrixWorld);
    expect(p.distanceTo(q)).toBeLessThan(1e-6);
    motion=Math.max(motion,p.distanceTo(garmentRest[i]));
   }
  }
  expect(motion).toBeGreaterThan(.1);
 }finally{await rm(dir,{recursive:true,force:true});}
},120000);
