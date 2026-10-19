import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnrealImportOptions, parseUnrealCollision } from '../src/unreal-import-options.ts';
import { verifyUnreal } from '../src/unreal.ts';

describe('strict, explicit Unreal import options',()=>{
 it('keeps real booleans and separates Interchange configuration from post-import BodySetup settings',()=>{
  const input={schema:1,interchange:{buildNanite:false,useFullPrecisionUVs:true,collision:false,importCollisionAccordingToMeshName:false,generateLightmapUVs:false},postImport:{collisionTraceFlag:'complex-as-simple',doubleSidedGeometry:true}};
  expect(parseUnrealImportOptions(input)).toEqual(input);
 });
 it.each([
  null, [], {}, {schema:2,interchange:{buildNanite:false}}, {schema:1},
  {schema:1,interchange:{}}, {schema:1,interchange:{buildNanite:'off'}},
  {schema:1,interchange:{buildNanite:false,typo:true}}, {schema:1,pipelineAsset:'/Game/Pipeline'},
  {schema:1,postImport:{doubleSidedGeometry:0}}, {schema:1,postImport:{collisionTraceFlag:'guess'}},
  {schema:1,postImport:{naniteEnabled:false}},
 ])('rejects malformed or unsupported configuration %j',value=>expect(()=>parseUnrealImportOptions(value)).toThrow(/import options/i));
 it('validates canonical collision aliases, keeping the stored default separate from resolved project behavior',()=>{
  expect(parseUnrealCollision('default')).toBe('default');
  expect(parseUnrealCollision('complex-as-simple')).toBe('complex-as-simple');
  expect(()=>parseUnrealCollision('CTF_MAX')).toThrow(/collision/i);
 });
 it('reads and validates the file before input inspection or any engine discovery/launch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'unreal invalid options '));
  const file=join(directory,'options.json');
  try {
   await writeFile(file,JSON.stringify({schema:1,interchange:{buildNanite:false,unrecognized:true}}));
   await expect(verifyUnreal(join(directory,'not-present.glb'),{morphs:[],bones:[],requireSkeletalMesh:false,importOptionsFile:file})).rejects.toMatchObject({code:'CLI_ARGUMENT_ERROR',message:expect.stringContaining('unsupported interchange field "unrecognized"')});
   await writeFile(file,'{not json');
   await expect(verifyUnreal(join(directory,'not-present.glb'),{morphs:[],bones:[],requireSkeletalMesh:false,importOptionsFile:file})).rejects.toMatchObject({code:'CLI_ARGUMENT_ERROR',message:expect.stringContaining('Cannot read Unreal import options')});
  } finally {await rm(directory,{recursive:true,force:true});}
 });
});
