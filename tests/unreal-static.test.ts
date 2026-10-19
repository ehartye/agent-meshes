import { describe, expect, it } from 'vitest';
import { buildUnrealReport, reviewUnrealReport, parseUnrealBounds, type UnrealRawReport } from '../src/unreal.ts';
import { createUnrealAxisCalibrationGLB, UNREAL_AXIS_CALIBRATION } from '../src/unreal-calibration.ts';
import { verifyGLB } from '../src/export.ts';
const clean = { importErrors: [], importWarnings: [], otherErrors: [], interchangeCompleted: true, windowFound: true };
const mesh = (name = 'Prop') => ({ path: `/Game/Verify/${name}`, lods: 1, vertices: [24], triangles: [12], naniteEnabled: false, fullPrecisionUVs: [false], boundsCm: { space: 'asset-local' as const, includesBoundsExtensions: true as const, min: [-50, -100, 0] as [number,number,number], max: [50,100,300] as [number,number,number], center: [0,0,150] as [number,number,number], size: [100,200,300] as [number,number,number] } });
const report = (meshes = [mesh()]) => buildUnrealReport({ ok: true, destination: '/Game/Verify', importReturned: true, assets: meshes.map(m => ({path:m.path,class:'StaticMesh'})), skeletalMeshes: [], staticMeshes: meshes } as UnrealRawReport, clean, { input: 'prop.glb', editor:'ue', version:'5.8.2', exitCode:0, logFile:'ue.log', elapsedMs:1 });
const base = { morphs: [], bones: [], requireSkeletalMesh: false };
describe('static-prop expectations', () => {
 it('checks the stored collision enum and double-sided geometry on exactly one selected mesh', () => {
  const facts=report([mesh('A'),mesh('B')]);
  Object.assign(facts.staticMeshes[1],{collisionTraceFlag:'CTF_USE_COMPLEX_AS_SIMPLE',doubleSidedGeometry:true});
  expect(reviewUnrealReport(facts,{...base,staticMesh:'B',staticCollision:'complex-as-simple',staticDoubleSided:true}).failures).toEqual([]);
  expect(reviewUnrealReport(facts,{...base,staticMesh:'B',staticCollision:'simple-and-complex',staticDoubleSided:false}).failures).toHaveLength(2);
  expect(reviewUnrealReport(facts,{...base,staticDoubleSided:true}).failures.join('')).toContain('exactly one');
 });
 it('fails required unknown collision settings instead of coercing them to defaults', () => {
  const facts=report(); Object.assign(facts.staticMeshes[0],{collisionTraceFlag:null,doubleSidedGeometry:null,measurementErrors:{collisionTraceFlag:'BodySetup unavailable',doubleSidedGeometry:'BodySetup unavailable'}});
  const failures=reviewUnrealReport(facts,{...base,staticCollision:'default',staticDoubleSided:false}).failures;
  expect(failures).toHaveLength(2); expect(failures.join('')).toContain('BodySetup unavailable');
 });
 it('parses finite positive full-size bounds in centimetres', () => { expect(parseUnrealBounds(' 100, 200, 300 ')).toEqual([100,200,300]); for (const v of ['1,2','1,NaN,3','0,2,3','1,2,Infinity']) expect(() => parseUnrealBounds(v)).toThrow(/bounds/i); });
 it('compares full sizes with a centimetre tolerance', () => {
  expect(reviewUnrealReport(report(), {...base, staticBounds:{size:[100,200,300],toleranceCm:0.1}}).failures).toEqual([]);
  expect(reviewUnrealReport(report(), {...base, staticBounds:{size:[100,200,301],toleranceCm:0.1}}).failures).toEqual([expect.stringContaining('bounds size')]);
 });
 it('fails an unavailable measurement and ambiguous targets instead of silently passing', () => {
  const unknown=report(); unknown.staticMeshes[0].boundsCm=null; unknown.staticMeshes[0].measurementErrors={boundsCm:'API unavailable'};
  expect(reviewUnrealReport(unknown, {...base, staticBounds:{size:[100,200,300]}}).failures.join('')).toContain('API unavailable');
  expect(reviewUnrealReport(report([mesh('A'),mesh('B')]),{...base,staticBounds:{size:[100,200,300]}}).failures.join('')).toContain('select one');
  expect(reviewUnrealReport(report([mesh('A'),mesh('B')]),{...base,staticBounds:{size:[100,200,300],mesh:'B'}}).failures).toEqual([]);
 });
 it('does not treat unknown Nanite or UV settings as disabled', () => {
  const facts=report(); facts.staticMeshes[0].naniteEnabled=null; facts.staticMeshes[0].fullPrecisionUVs=[null];
  const failures=reviewUnrealReport(facts,{...base,staticNanite:false,staticFullPrecisionUVs:false}).failures;
  expect(failures).toHaveLength(2); expect(failures.join('')).toContain('unavailable');
 });
 it('detects wrong Nanite and any LOD precision setting', () => {
  const facts=report(); facts.staticMeshes[0].fullPrecisionUVs=[false,true];
  expect(reviewUnrealReport(facts,{...base,staticNanite:true,staticFullPrecisionUVs:false}).failures).toHaveLength(2);
 });
});
describe('axis calibration', () => {
 it('exports a valid self-contained asymmetric GLB with named signed-axis probes', async () => { const verified=await verifyGLB(createUnrealAxisCalibrationGLB()); expect(verified.errors).toBe(0); expect(verified.warnings).toBe(0); expect(UNREAL_AXIS_CALIBRATION).toHaveLength(4); });
 it('passes labeled centers and fails mirroring even when all box sizes stay identical', () => {
  const all=UNREAL_AXIS_CALIBRATION.map(marker=>({...mesh(marker.name),boundsCm:{...mesh().boundsCm,center:marker.unrealCenterCm,size:marker.unrealSizeCm}}));
  expect(reviewUnrealReport(report(all),{...base,axisCalibration:true}).failures).toEqual([]);
  all[1].boundsCm.center=[-100,0,0];
  expect(reviewUnrealReport(report(all),{...base,axisCalibration:true}).failures.join('')).toContain('axis calibration');
 });
});
