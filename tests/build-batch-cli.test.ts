import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
const { buildAsset, buildAssets, decoratorFor } = vi.hoisted(() => ({ buildAsset: vi.fn(), buildAssets: vi.fn(), decoratorFor: vi.fn() }));
vi.mock('../src/build.ts', () => ({ buildAsset }));
vi.mock('../src/build-batch.ts', () => ({ buildAssets }));
vi.mock('../src/capture.ts', () => ({ decoratorFor }));
beforeEach(() => { vi.spyOn(process.stdout,'write').mockReturnValue(true); buildAssets.mockReset().mockResolvedValue({ok:true,assets:[],unattempted:[],toolchain:{captures:{}}}); decoratorFor.mockReset().mockReturnValue(undefined); });
afterEach(() => {vi.restoreAllMocks();process.exitCode=0;});
it('forwards the complete config list and flags through one batch with no preview', async()=>{
  await main(['node','meshes','build-batch','a.json','b.json','--if-changed','--no-preview']);
  expect(buildAssets).toHaveBeenCalledOnce();
  expect(buildAssets.mock.calls[0][0]).toEqual(['a.json','b.json']);
  expect(buildAssets.mock.calls[0][1]).toMatchObject({ifChanged:true,decorateAsset:undefined});
  expect(decoratorFor).toHaveBeenCalledWith({preview:false,previewPage:true});
});
it('prints structured partial results and exits1 on an asset failure',async()=>{
  const result={ok:false,assets:[{config:'a.json',ok:false,error:{code:'TEST',message:'fixture'}}],unattempted:['b.json'],toolchain:{captures:{}}};
  buildAssets.mockResolvedValueOnce(result);
  await main(['node','meshes','build-batch','a.json','b.json','--force']);
  expect(process.stdout.write).toHaveBeenCalledWith(JSON.stringify(result)+'\n');
  expect(process.exitCode).toBe(1);expect(buildAssets.mock.calls[0][1].force).toBe(true);
});
it('accepts --preview and --preview-page as the explicit form of the defaults, for build and build-batch', async()=>{
  buildAsset.mockReset().mockResolvedValue({output:'dist',files:[]});
  await main(['node','meshes','build','a.json','--preview','--preview-page']);
  expect(decoratorFor).toHaveBeenLastCalledWith({preview:true,previewPage:true});
  await main(['node','meshes','build-batch','a.json','--preview','--preview-page']);
  expect(decoratorFor).toHaveBeenLastCalledWith({preview:true,previewPage:true});
  await main(['node','meshes','build','a.json']);
  expect(decoratorFor).toHaveBeenLastCalledWith({preview:true,previewPage:true});
  await main(['node','meshes','build','a.json','--no-preview']);
  expect(decoratorFor).toHaveBeenLastCalledWith({preview:false,previewPage:true});
  expect(process.exitCode ?? 0).toBe(0);
});
