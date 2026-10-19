import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, applyOperation } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';
import { nativeCacheFiles } from '../src/build-native-cache.ts';
import { buildAssets } from '../src/build-batch.ts';

const { authorGLB, findBlender, helperRevision } = vi.hoisted(() => ({ authorGLB: vi.fn(), findBlender: vi.fn(), helperRevision: { sha: undefined as string | undefined } }));
vi.mock('../src/author.ts', () => ({ authorGLB }));
vi.mock('../src/refine.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/refine.ts')>(), findBlender }));
vi.mock('../src/build-provenance.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/build-provenance.ts')>();
  return { ...original, captureBuildToolchain: async (...args: Parameters<typeof original.captureBuildToolchain>) => {
    const captured = await original.captureBuildToolchain(...args);
    return helperRevision.sha ? { ...captured, identity: { ...captured.identity, helpersSha256: helperRevision.sha } } : captured;
  } };
});
const directories: string[] = [];
beforeEach(() => { authorGLB.mockReset(); findBlender.mockReset(); helperRevision.sha = undefined; });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-incremental-'))); directories.push(root);
  const installation = join(root, 'blender-portable');
  for (const name of ['scripts', 'datafiles', 'python']) await mkdir(join(installation, '5.2', name), { recursive: true });
  const command = join(installation, process.platform === 'win32' ? 'blender.exe' : 'blender');
  await writeFile(command, 'fixture executable');
  findBlender.mockReturnValue({ command, detached: false, source: 'AGENT_MESHES_BLENDER' });
  const script = join(root, 'bird.py'), data = join(root, 'design.py'), config = join(root, 'build.json'), output = join(root, 'generated');
  await writeFile(script, 'def build():\n    return []\n'); await writeFile(data, 'WIDTH = 1\n');
  const settings = { version: 1, blender: { script: 'bird.py', inputs: [{ path: 'design.py' }] }, output: 'generated' };
  await writeFile(config, JSON.stringify(settings));
  const bytes = await exportGLB(applyOperation(createProject('fixture'), { op: 'add', part: { name: 'body' } }));
  authorGLB.mockImplementation(async (source: string, destination: string) => {
    await writeFile(destination, bytes); return { output: destination, bytes: bytes.length, meshes: 1, blender: '5.2.2 LTS', readAudit: { schema: 1, installed: true, reads: [source, data], runtimeRoots: [installation], unresolvedEvents: 0, truncated: false } };
  });
  return { root, installation, command, script, data, config, output, settings, bytes };
}

it('ignores undeclared environment variables in both reuse identity and the actual child environment', async () => {
  const f = await fixture();
  await writeFile(f.config,JSON.stringify({...f.settings,blender:{...f.settings.blender,environment:{inputs:['MESH_STYLE']}}}));
  vi.stubEnv('MESH_STYLE','ink');vi.stubEnv('MESH_RUN_ID','first');
  await buildAsset(f.config,{ifChanged:true});
  expect(authorGLB.mock.calls[0][2].env.MESH_STYLE).toBe('ink');expect(authorGLB.mock.calls[0][2].env.MESH_RUN_ID).toBeUndefined();
  vi.stubEnv('MESH_RUN_ID','second');expect((await buildAsset(f.config,{ifChanged:true})).incremental?.blender).toBe('reused');
  vi.stubEnv('MESH_STYLE','paper');
  expect((await buildAsset(f.config,{ifChanged:true})).incremental).toMatchObject({blender:'built',reason:'cache-key-changed',changedComponents:['environment']});
  const receipt=JSON.parse(await readFile(join(f.output,'authoring.json'),'utf8'));
  expect(receipt.provenance.environment).toMatchObject({mode:'declared',inputs:['MESH_STYLE']});
  expect(JSON.stringify(receipt.provenance.environment)).not.toContain('paper');
});

it.each(['plain','forced','fallback'] as const)('uses the same declared child environment for %s generation',async mode=>{
  const f=await fixture();
  await writeFile(f.config,JSON.stringify({...f.settings,blender:{...f.settings.blender,environment:{inputs:[]}}}));
  vi.stubEnv('MESH_RUN_ID','not-an-input');vi.stubEnv('PYTHONPATH','excluded-parent-override');
  if(mode==='fallback')findBlender.mockReturnValue({...findBlender(),detached:true});
  const result=await buildAsset(f.config,mode==='plain'?{}:mode==='forced'?{force:true}:{ifChanged:true});
  expect(authorGLB.mock.calls[0][2].env.MESH_RUN_ID).toBeUndefined();expect(authorGLB.mock.calls[0][2].env.PYTHONPATH).toBeUndefined();
  if(mode==='fallback')expect(result.incremental?.reason).toBe('unsupported-blender-launcher');
});

it('builds two rooted assets from shared defaults/library and enforces reads across the root',async()=>{
  const f=await fixture(),shared=join(f.root,'lib','shared.py');await mkdir(join(f.root,'lib'));await writeFile(shared,'WIDTH=1');
  await writeFile(join(f.root,'defaults.json'),JSON.stringify({version:1,blender:{projectRoot:'../..',inputs:[{dir:'lib'}],readAudit:'strict'}}));
  const configs:string[]=[];
  for(const name of ['barrel','tank']){const leaf=join(f.root,'assets',name);await mkdir(leaf,{recursive:true});await writeFile(join(leaf,'asset.py'),'#asset');const config=join(leaf,'build.json');await writeFile(config,JSON.stringify({extends:'../../defaults.json',blender:{script:'asset.py'},output:'generated'}));configs.push(config);}
  authorGLB.mockImplementation(async(source:string,destination:string)=>{await writeFile(destination,f.bytes);return{meshes:1,blender:'5.2.2 LTS',readAudit:{schema:1,installed:true,reads:[source,shared],runtimeRoots:[f.installation],unresolvedEvents:0,truncated:false}};});
  expect((await buildAssets(configs,{ifChanged:true})).ok).toBe(true);
  const warm=await buildAssets(configs,{ifChanged:true});expect(warm.assets.map(a=>a.ok&&a.result.incremental?.blender)).toEqual(['reused','reused']);
  const output=join(f.root,'assets','barrel','generated'),previous=await readFile(join(output,'authoring.json'));
  const receipt=JSON.parse(previous.toString());expect(receipt.provenance.inputRoot).toEqual({relativeToConfig:'../..',scope:'project-root'});expect(receipt.provenance.inputs.map((file:{path:string})=>file.path)).toContain('lib/shared.py');expect(receipt.provenance.readAudit.scope).toBe('project-root');
  const original=authorGLB.getMockImplementation()!;authorGLB.mockImplementationOnce(async(...args:unknown[])=>{const r=await original(...args);return{...r,readAudit:{...r.readAudit,reads:[...r.readAudit.reads,join(f.root,'missed.py')]}};});
  const failed=await buildAssets(configs,{force:true});expect(failed.ok).toBe(false);expect(failed.unattempted).toEqual([configs[1]]);expect(await readFile(join(output,'authoring.json'))).toEqual(previous);
  await writeFile(shared,'WIDTH=2');const changed=await buildAssets(configs,{ifChanged:true});expect(changed.assets.map(a=>a.ok&&a.result.incremental?.changedComponents)).toEqual([['inputs'],['inputs']]);
});

it('keeps full external diagnostics locally while writing the portable schema2 receipt',async()=>{
  const f=await fixture(),original=authorGLB.getMockImplementation()!;
  authorGLB.mockImplementation(async(...args:unknown[])=>{const r=await original(...args);return{...r,readAudit:{...r.readAudit,reads:[...r.readAudit.reads,join(f.root,'..','machine-cache','file.bin')]}};});
  const result=await buildAsset(f.config,{ifChanged:true});expect(result.readAudit?.externalReads).toEqual(['../machine-cache/file.bin']);
  const receipt=JSON.parse(await readFile(join(f.output,'authoring.json'),'utf8'));expect(receipt.provenance.readAudit).toMatchObject({schema:2,status:'clean',externalReads:{count:1,paths:'omitted',coverage:'outside-enforced-scope'}});expect(JSON.stringify(receipt)).not.toContain('machine-cache');
  expect((await buildAsset(f.config,{ifChanged:true})).readAudit).toEqual(result.readAudit);
});

it('inherits shared defaults, records every config and invalidates changed ancestor bytes', async () => {
  const f = await fixture();
  const defaults = join(f.root, 'defaults.json');
  await writeFile(defaults, JSON.stringify({ version: 1, blender: { inputs: f.settings.blender.inputs, readAudit: 'strict' }, verify: { maxTriangles: 1000 } }));
  await writeFile(f.config, JSON.stringify({ extends: 'defaults.json', blender: { script: 'bird.py' }, output: 'generated' }));
  await buildAsset(f.config, { ifChanged: true });
  expect((await buildAsset(f.config, { ifChanged: true })).incremental?.blender).toBe('reused');
  const receipt = JSON.parse(await readFile(join(f.output, 'authoring.json'), 'utf8'));
  expect(receipt.provenance.configurations.map((file: {path: string}) => file.path)).toEqual(['build.json', 'defaults.json']);
  expect(receipt.provenance.inputs.map((file: {path: string}) => file.path)).toContain('design.py');
  await writeFile(defaults, JSON.stringify({ version: 1, blender: { inputs: f.settings.blender.inputs, readAudit: 'strict' }, verify: { maxTriangles: 2000 } }));
  expect((await buildAsset(f.config, { ifChanged: true })).incremental).toMatchObject({ blender: 'built', reason: 'cache-key-changed', changedComponents: ['inputs'] });
  expect(authorGLB).toHaveBeenCalledTimes(2);
});

it('rejects ancestor config changes during decoration and preserves previous output', async () => {
  const f = await fixture(), defaults = join(f.root, 'defaults.json');
  await writeFile(defaults, JSON.stringify({ version: 1 }));
  await writeFile(f.config, JSON.stringify({ ...f.settings, extends: 'defaults.json' }));
  await buildAsset(f.config);
  const previous = await readFile(join(f.output, 'authoring.json'));
  await expect(buildAsset(f.config, { decorateAsset: async () => { await writeFile(defaults, '{"version":1,"name":"changed"}'); return []; } })).rejects.toThrow(/Build config changed/);
  expect(await readFile(join(f.output, 'authoring.json'))).toEqual(previous);
});

it('rejects output containing an inherited config before launching Blender', async () => {
  const f = await fixture();
  await mkdir(f.output);
  await writeFile(join(f.output, 'defaults.json'), '{"version":1}');
  await writeFile(f.config, JSON.stringify({ ...f.settings, extends: 'generated/defaults.json' }));
  await expect(buildAsset(f.config)).rejects.toThrow(/output cannot contain/i);
  expect(authorGLB).not.toHaveBeenCalled();
});

it('reuses unchanged native authoring while running current decoration and verification', async () => {
  const { config, output } = await fixture();
  let count = 0;
  const decorateAsset = vi.fn(async (_asset, stage: string) => {
    await writeFile(join(stage, 'preview.html'), `preview ${++count}`); return ['preview.html'];
  });
  const first = await buildAsset(config, { ifChanged: true, decorateAsset });
  const second = await buildAsset(config, { ifChanged: true, decorateAsset });
  expect(authorGLB).toHaveBeenCalledOnce(); expect(decorateAsset).toHaveBeenCalledTimes(2);
  expect(first.incremental?.blender).toBe('built'); expect(second.incremental?.blender).toBe('reused');
  expect(await readFile(join(output, 'preview.html'), 'utf8')).toBe('preview 2');
  expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
});

it('reports undeclared reads in warning mode and never reuses that generation', async () => {
  const f = await fixture();
  const original = authorGLB.getMockImplementation()!;
  authorGLB.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    return { ...result, readAudit: { ...result.readAudit, reads: [...result.readAudit.reads, join(f.root, 'undeclared.json')] } };
  });
  const first = await buildAsset(f.config, { ifChanged: true });
  expect(first.readAudit?.status).toBe('undeclared');
  expect(first.readAudit?.undeclaredReads).toEqual(['undeclared.json']);
  expect(first.incremental?.reason).toBe('read-audit-undeclared');
  expect(first.files).not.toContain(nativeCacheFiles[0]);
  await buildAsset(f.config, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(2);
});

it('strict audit rejects undeclared or unavailable observations and preserves previous output', async () => {
  const f = await fixture();
  await buildAsset(f.config, { ifChanged: true });
  const previous = await readFile(join(f.output, 'authoring.json'));
  await writeFile(f.config, JSON.stringify({ ...f.settings, blender: { ...f.settings.blender, readAudit: 'strict' } }));
  const original = authorGLB.getMockImplementation()!;
  for (const readAudit of [undefined, { schema: 1, installed: true, reads: [f.script, join(f.root, 'secret.bin')], runtimeRoots: [], unresolvedEvents: 0, truncated: false }]) {
    authorGLB.mockImplementationOnce(async (...args: unknown[]) => ({ ...await original(...args), readAudit }));
    await expect(buildAsset(f.config, { ifChanged: true })).rejects.toThrow(/READ_AUDIT_FAILED/);
    expect(await readFile(join(f.output, 'authoring.json'))).toEqual(previous);
  }
});

it('regenerates legacy caches without audit evidence and replays clean reports on a hit', async () => {
  const f = await fixture();
  const first = await buildAsset(f.config, { ifChanged: true });
  const recordPath = join(f.output, nativeCacheFiles[0]);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.readAudit;
  await writeFile(recordPath, JSON.stringify(record));
  const regenerated = await buildAsset(f.config, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(2);
  const reused = await buildAsset(f.config, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(2);
  expect(reused.incremental?.blender).toBe('reused');
  expect(reused.readAudit).toEqual(first.readAudit);
  expect(reused.readAudit).toEqual(regenerated.readAudit);
});

it('invalidates changed declared input bytes and force refreshes the reusable result', async () => {
  const { config, data } = await fixture();
  await buildAsset(config, { ifChanged: true });
  await writeFile(data, 'WIDTH = 2\n');
  await buildAsset(config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledTimes(2);
  await buildAsset(config, { force: true }); expect(authorGLB).toHaveBeenCalledTimes(3);
  await buildAsset(config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledTimes(3);
});

it('keeps default builds regenerating without incremental artifacts or result fields', async () => {
  const { config } = await fixture();
  const first = await buildAsset(config); await buildAsset(config);
  expect(authorGLB).toHaveBeenCalledTimes(2); expect(first).not.toHaveProperty('incremental');
  expect(first.files).toEqual(['model.glb', 'verification.json', 'authoring.json']);
});

it.each(['entry', 'data', 'config', 'executable', 'runtime-data', 'runtime-addition'] as const)('invalidates %s changes without touching another asset cache', async change => {
  const f = await fixture();
  const second = join(f.root, 'second.json');
  await writeFile(join(f.root, 'second.py'), 'def build():\n    return []\n');
  await writeFile(second, JSON.stringify({ ...f.settings, blender: { ...f.settings.blender, script: 'second.py' }, output: 'second' }));
  const runtimeData = join(f.installation, '5.2', 'datafiles', 'defaults.txt'); await writeFile(runtimeData, 'before');
  await buildAsset(f.config, { ifChanged: true }); await buildAsset(second, { ifChanged: true });
  if (change === 'entry') await writeFile(f.script, 'def build():\n    return [1]\n');
  if (change === 'data') { const before = await stat(f.data); await writeFile(f.data, 'WIDTH = 2\n'); await utimes(f.data, before.atime, before.mtime); }
  if (change === 'config') await writeFile(f.config, JSON.stringify({ ...f.settings, name: 'Renamed' }));
  if (change === 'executable') await writeFile(f.command, 'changed executable');
  if (change === 'runtime-data') await writeFile(runtimeData, 'after!');
  if (change === 'runtime-addition') await writeFile(join(f.installation, '5.2', 'scripts', 'new.py'), '# new tool script');
  await buildAsset(f.config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledTimes(3);
  await buildAsset(second, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(['entry', 'config'].includes(change) ? 3 : 4);
});

it('invalidates changed helper identity and checks new pins before reusing anything', async () => {
  const f = await fixture(); await buildAsset(f.config, { ifChanged: true });
  helperRevision.sha = '1'.repeat(64);
  await buildAsset(f.config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledTimes(2);
  await writeFile(f.config, JSON.stringify({ ...f.settings, blender: { ...f.settings.blender, toolchain: { agentMeshesVersion: '0.19.0', helpersSha256: '0'.repeat(64) } } }));
  await expect(buildAsset(f.config, { ifChanged: true })).rejects.toThrow(/pin mismatch/i);
  expect(authorGLB).toHaveBeenCalledTimes(2);
});

it('checks environment values without writing them into cache records', async () => {
  const f = await fixture();
  vi.stubEnv('MESH_TEST_STYLE', 'private-style-a'); await buildAsset(f.config, { ifChanged: true });
  vi.stubEnv('MESH_TEST_STYLE', 'private-style-b'); await buildAsset(f.config, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(2);
  const reason = (await buildAsset(f.config, { ifChanged: true })).incremental;
  expect(reason?.blender).toBe('reused');
  expect(await readFile(join(f.output, nativeCacheFiles[0]), 'utf8')).not.toContain('private-style');
  expect(authorGLB.mock.calls[1][2]).toMatchObject({ factoryStartup: true, cwd: process.cwd(), env: { MESH_TEST_STYLE: 'private-style-b' } });
});

it.each(['inputs', 'environment', 'tools', 'runtime'] as const)('explains a changed %s digest without recording environment values', async component => {
  const f = await fixture();
  expect((await buildAsset(f.config, { ifChanged: true })).incremental?.reason).toBe('cache-record-missing');
  if (component === 'inputs') await writeFile(f.data, 'WIDTH=9\n');
  if (component === 'environment') vi.stubEnv('MESH_PRIVATE_SECRET', 'must-not-appear');
  if (component === 'tools') helperRevision.sha = '1'.repeat(64);
  if (component === 'runtime') await writeFile(f.command, 'different executable');
  const result = await buildAsset(f.config, { ifChanged: true });
  expect(result.incremental).toMatchObject({ blender: 'built', reason: 'cache-key-changed', changedComponents: [component] });
  const record = JSON.parse(await readFile(join(f.output, nativeCacheFiles[0]), 'utf8'));
  expect(record.schema).toBe('agent-meshes/native-blender-cache@2');
  expect(Object.keys(record.components)).toEqual(['inputs', 'tools', 'runtime', 'environment', 'cwd', 'location', 'platform', 'policy']);
  expect(JSON.stringify(record)).not.toContain('must-not-appear');
  expect(JSON.stringify(record)).not.toContain('MESH_PRIVATE_SECRET');
});

it('distinguishes legacy/invalid records and missing/corrupt cache bytes', async () => {
  const f = await fixture(); await buildAsset(f.config, { ifChanged: true });
  const record = join(f.output, nativeCacheFiles[0]), data = join(f.output, nativeCacheFiles[1]);
  for (const [reason, mutate] of [
    ['legacy-cache-record', async () => { const old = JSON.parse(await readFile(record, 'utf8')); old.schema='agent-meshes/native-blender-cache@1'; await writeFile(record,JSON.stringify(old)); }],
    ['cache-record-invalid', () => writeFile(record,'{bad json')],
    ['cache-output-missing', () => rm(data)],
    ['cache-output-corrupt', () => writeFile(data,'bad bytes')],
  ] as const) { await mutate(); expect((await buildAsset(f.config,{ifChanged:true})).incremental?.reason).toBe(reason); }
});

it('explains moved source/tool locations independently of identical bytes',async()=>{
  const first=await fixture();await buildAsset(first.config,{ifChanged:true});
  const moved=await fixture();await cp(first.output,moved.output,{recursive:true});
  const result=await buildAsset(moved.config,{ifChanged:true});
  expect(result.incremental).toMatchObject({blender:'built',reason:'cache-key-changed',changedComponents:['location']});
});

it('explains cwd changes without persisting its value',async()=>{
  const f=await fixture();await buildAsset(f.config,{ifChanged:true});
  const cwd=vi.spyOn(process,'cwd').mockReturnValue(f.root);
  try{expect((await buildAsset(f.config,{ifChanged:true})).incremental).toMatchObject({reason:'cache-key-changed',changedComponents:['cwd']});}
  finally{cwd.mockRestore();}
});

it('shares full tool captures within an explicit sequential batch and retains independent keys', async () => {
  const f = await fixture(), second = join(f.root,'second.json');
  await writeFile(second,JSON.stringify({...f.settings,output:'second'}));
  const cold = await buildAssets([f.config,second],{ifChanged:true});
  expect(cold.ok).toBe(true); expect(cold.assets.map(x=>x.ok&&x.result.incremental?.blender)).toEqual(['built','built']);
  expect(cold.toolchain.captures).toEqual({helperToolchain:1,blenderRuntime:1,nativeImplementation:1});
  const warm = await buildAssets([f.config,second],{ifChanged:true});
  expect(warm.assets.map(x=>x.ok&&x.result.incremental?.blender)).toEqual(['reused','reused']);
  expect(authorGLB).toHaveBeenCalledTimes(2);
  await writeFile(second,JSON.stringify({...f.settings,name:'Changed',output:'second'}));
  const edit = await buildAssets([f.config,second],{ifChanged:true});
  expect(edit.assets.map(x=>x.ok&&x.result.incremental?.blender)).toEqual(['reused','built']);
  expect(authorGLB).toHaveBeenCalledTimes(3);
});

it('stops a batch after tool mutation, preserves failed output and lists unattempted configs', async () => {
  const f=await fixture(), second=join(f.root,'second.json'),third=join(f.root,'third.json');
  await writeFile(second,JSON.stringify({...f.settings,output:'second'}));await writeFile(third,JSON.stringify({...f.settings,output:'third'}));
  let n=0;
  const result=await buildAssets([f.config,second,third],{ifChanged:true,decorateAsset:async()=>{if(++n===2)await writeFile(f.command,'mutated during second asset');return [];}});
  expect(result.ok).toBe(false);expect(result.assets).toHaveLength(2);expect(result.assets[0].ok).toBe(true);expect(result.assets[1].ok).toBe(false);expect(result.unattempted).toEqual([third]);
  expect((await readdir(f.root))).not.toContain('second');expect((await readdir(f.root))).not.toContain('third');
});

it('rejects duplicate canonical configs before writing any output', async () => {
  const f=await fixture();
  await expect(buildAssets([f.config,f.config],{ifChanged:true})).rejects.toThrow(/duplicate/i);
  expect(authorGLB).not.toHaveBeenCalled();
});

it('repairs missing/corrupt generated artifacts and rebuilds missing/corrupt native cache', async () => {
  const f = await fixture(); await buildAsset(f.config, { ifChanged: true });
  for (const mutate of [
    () => writeFile(join(f.output, 'model.glb'), 'broken final artifact'),
    () => rm(join(f.output, 'model.glb')),
    () => rm(join(f.output, 'verification.json')),
  ]) {
    await mutate(); await buildAsset(f.config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledOnce();
    expect(await readFile(join(f.output, 'model.glb'))).toEqual(Buffer.from(f.bytes));
  }
  let calls = 1;
  for (const mutate of [
    () => writeFile(join(f.output, nativeCacheFiles[0]), 'not-json'),
    () => rm(join(f.output, nativeCacheFiles[0])),
    () => writeFile(join(f.output, nativeCacheFiles[1]), 'broken cached bytes'),
    () => rm(join(f.output, nativeCacheFiles[1])),
  ]) {
    await mutate(); await buildAsset(f.config, { ifChanged: true }); expect(authorGLB).toHaveBeenCalledTimes(++calls);
  }
});

it('reuses pristine author bytes rather than applying decorations to last final output', async () => {
  const f = await fixture();
  const changed = await exportGLB(applyOperation(applyOperation(createProject('changed'), { op: 'add', part: { name: 'one' } }), { op: 'add', part: { name: 'two', position: [2, 0, 0] } }));
  const decorateAsset = async (_asset: unknown, stage: string) => {
    expect(await readFile(join(stage, 'model.glb'))).toEqual(Buffer.from(f.bytes));
    await writeFile(join(stage, 'model.glb'), changed); return [];
  };
  await buildAsset(f.config, { ifChanged: true, decorateAsset });
  await buildAsset(f.config, { ifChanged: true, decorateAsset });
  expect(authorGLB).toHaveBeenCalledOnce();
  expect(await readFile(join(f.output, nativeCacheFiles[1]))).toEqual(Buffer.from(f.bytes));
  expect(await readFile(join(f.output, 'model.glb'))).toEqual(Buffer.from(changed));
  await expect(buildAsset(f.config, { ifChanged: true, decorateAsset: async (_asset, stage) => { await writeFile(join(stage, 'model.glb'), 'invalid'); return []; } })).rejects.toThrow();
  expect(await readFile(join(f.output, 'model.glb'))).toEqual(Buffer.from(changed));
  expect(authorGLB).toHaveBeenCalledOnce();
});

it('preserves owned output on runtime mutation and refuses cache links or poisoned cache paths', async () => {
  const f = await fixture(); await buildAsset(f.config, { ifChanged: true });
  const before = await readFile(join(f.output, nativeCacheFiles[0]));
  await expect(buildAsset(f.config, { ifChanged: true, decorateAsset: async () => {
    await writeFile(join(f.installation, '5.2', 'datafiles', 'changed.txt'), 'mutation'); return [];
  } })).rejects.toThrow(/runtime changed/i);
  expect(await readFile(join(f.output, nativeCacheFiles[0]))).toEqual(before);
  const keep = join(f.root, 'keep.txt'); await writeFile(keep, 'keep source');
  await expect(buildAsset(f.config, { force: true, decorateAsset: async (_asset, stage) => {
    await link(keep, join(stage, nativeCacheFiles[1])); return [];
  } })).rejects.toThrow(/exist/i);
  expect(await readFile(keep, 'utf8')).toBe('keep source');
  await rm(join(f.output, nativeCacheFiles[0])); await link(keep, join(f.output, nativeCacheFiles[0]));
  await expect(buildAsset(f.config, { ifChanged: true })).rejects.toThrow(/without links/i);
  expect(await readFile(keep, 'utf8')).toBe('keep source');
  expect((await readdir(f.root)).filter(name => /\.stage-|\.lock$|\.backup-/.test(name))).toEqual([]);
});

it.each(['override', 'bytecode-prefix', 'local-helper', 'detached', 'layout', 'linked-runtime'] as const)('falls back to generation for unsupported %s instead of claiming reuse', async unsupported => {
  const f = await fixture();
  if (unsupported === 'override') vi.stubEnv('BLENDER_USER_SCRIPTS', join(f.root, 'external'));
  if (unsupported === 'bytecode-prefix') vi.stubEnv('PYTHONPYCACHEPREFIX', join(f.root, 'external'));
  if (unsupported === 'local-helper') await writeFile(join(f.root, 'agent_meshes_author.py'), '# untracked local helper override');
  if (unsupported === 'detached') findBlender.mockReturnValue({ command: f.command, detached: true, source: 'windows-store' });
  if (unsupported === 'layout') await rm(join(f.installation, '5.2', 'python'), { recursive: true });
  if (unsupported === 'linked-runtime') await symlink(f.root, join(f.installation, 'external'), 'junction');
  const result = await buildAsset(f.config, { ifChanged: true }); await buildAsset(f.config, { ifChanged: true });
  expect(authorGLB).toHaveBeenCalledTimes(2); expect(result.incremental?.blender).toBe('built');
  expect(result.incremental?.reason).toMatch(/unsupported|override/);
  expect(result.files).not.toContain(nativeCacheFiles[0]);
});

it('rejects incremental flags on non-native inputs before creating output', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'project.json'), JSON.stringify(createProject('project')));
  await writeFile(f.config, JSON.stringify({ version: 1, project: 'project.json', output: 'generated' }));
  await expect(buildAsset(f.config, { ifChanged: true })).rejects.toThrow(/native blender.script/i);
  expect(authorGLB).not.toHaveBeenCalled(); expect(await readdir(f.root)).not.toContain('generated');
});
