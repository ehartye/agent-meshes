import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, applyOperation } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';
import { nativeCacheFiles } from '../src/build-native-cache.ts';

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
  expect(await readFile(join(f.output, nativeCacheFiles[0]), 'utf8')).not.toContain('private-style');
  expect(authorGLB.mock.calls[1][2]).toMatchObject({ factoryStartup: true, cwd: process.cwd(), env: { MESH_TEST_STYLE: 'private-style-b' } });
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
