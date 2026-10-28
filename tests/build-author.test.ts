import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProject, applyOperation } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';
import { captureBuildToolchain } from '../src/build-provenance.ts';

const { authorGLB } = vi.hoisted(() => ({ authorGLB: vi.fn() }));
vi.mock('../src/author.ts', () => ({ authorGLB }));
const directories: string[] = [];
beforeEach(() => { authorGLB.mockReset(); });
afterEach(async ({ task }) => {
  const paths = directories.splice(0);
  if (task.result?.state === 'fail') { console.error('Retained authored build fixtures:', paths); return; }
  await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-build-author-')); directories.push(directory);
  const source = 'def build():\n    return []\n';
  await writeFile(join(directory, 'bird.py'), source);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'Bird', blender: { script: 'bird.py' }, output: 'generated' }));
  const bytes = await exportGLB(applyOperation(createProject('fixture'), { op: 'add', part: { name: 'body' } }));
  authorGLB.mockImplementation(async (_input: string, output: string) => {
    await writeFile(output, bytes);
    return { output, bytes: bytes.length, meshes: 1, blender: '5.0.1' };
  });
  return { directory, config, source, output: join(directory, 'generated') };
}

it('accepts declared trees through build JSON and protects the prior output from membership changes', async () => {
  const { directory, config, output } = await fixture();
  await mkdir(join(directory, 'lib'));
  await writeFile(join(directory, 'lib', 'shape.py'), 'WIDTH=1\n');
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', inputs: [{ dir: 'lib', include: ['**/*.py'] }] }, output: 'generated' }));
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  const receipt = JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'));
  expect(receipt.provenance.inputTrees[0].paths).toEqual(['lib/shape.py']);
  expect(receipt.provenance.inputs.map((file: { path: string }) => file.path)).toEqual(['bird.py', 'lib/shape.py']);
  await expect(buildAsset(config, { decorateAsset: async () => {
    await writeFile(join(directory, 'lib', 'added.py'), '# added during generation');
    return [];
  } })).rejects.toThrow(/tree.*changed/i);
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
});

it('builds verified authored assets, renders them from the built GLB and owns every render', async () => {
  const { config, output, directory, source } = await fixture();
  // A Blender build has no editable project, so the project decorator is never offered one; its renders come from renderAsset.
  const decorate = vi.fn();
  const renderAsset = vi.fn(async (asset: { name: string }, stage: string) => {
    expect(asset.name).toBe('Bird'); expect((await readFile(join(stage, 'model.glb'))).length).toBeGreaterThan(0);
    const names = ['front.png', 'side.png', 'perspective.png', 'Walk-contact.png'];
    for (const name of names) await writeFile(join(stage, name), name);
    return { files: names, warnings: [{ code: 'CLIP_CONTACT_SKIPPED', message: 'odd clip' }] };
  });
  const decorateAsset = vi.fn(async (asset: { name: string }, stage: string) => {
    expect(asset.name).toBe('Bird'); expect((await readFile(join(stage, 'model.glb'))).length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(stage, 'authoring.json'), 'utf8')).source.script).toBe('bird.py');
    expect(await readFile(join(stage, 'front.png'), 'utf8')).toBe('front.png');
    await writeFile(join(stage, 'preview.html'), '<html>authored</html>'); return ['preview.html'];
  });
  const result = await buildAsset(config, { decorate, renderAsset, decorateAsset });
  expect(result.files).toEqual(['model.glb', 'verification.json', 'authoring.json', 'front.png', 'side.png', 'perspective.png', 'Walk-contact.png', 'preview.html']);
  expect(result.warnings).toContainEqual({ code: 'CLIP_CONTACT_SKIPPED', message: 'odd clip' });
  expect((await readdir(output)).sort()).toEqual([...result.files, '.agent-meshes-build.json'].sort());
  expect(authorGLB.mock.calls[0][0]).toBe(await realpath(join(directory, 'bird.py'))); expect(decorate).not.toHaveBeenCalled();
  expect(renderAsset).toHaveBeenCalledOnce(); expect(decorateAsset).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
  expect(JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'))).toMatchObject({ version: 1, blender: '5.0.1', source: { script: 'bird.py', sha256: createHash('sha256').update(source).digest('hex') } });
  const receipt = JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'));
  expect(receipt.provenance.dependencyDiscovery).toBe('entry-and-declared-only');
  expect(receipt.provenance.pins).toEqual({ inputs: [], toolchain: null });
  expect(receipt.provenance.output).toEqual({ path: 'model.glb', sha256: createHash('sha256').update(await readFile(join(output, 'model.glb'))).digest('hex') });
  expect(await readdir(output)).not.toContain('project.mesh.json');
  await buildAsset(config);
  expect((await readdir(output)).filter(name => /\.png$|preview\.html$/.test(name))).toEqual([]);
});

it('refuses a render the build did not list, so a stray PNG cannot be published as owned output', async () => {
  const { config, output } = await fixture();
  await expect(buildAsset(config, { renderAsset: async (_asset, stage) => { await writeFile(join(stage, 'front.png'), 'x'); return []; } })).rejects.toThrow(/BUILD_OUTPUT_UNOWNED_FILE|unowned/i);
  expect(await readdir(join(output, '..')).then(names => names.includes('generated'))).toBe(false);
});

it('rejects missing or stale declared imports and wrong toolchain before invoking the author', async () => {
  const { directory, config } = await fixture();
  const toolchain = { ...(await captureBuildToolchain()).identity, blenderVersion: '5.0.1' };
  await writeFile(join(directory, 'design.py'), 'WIDTH = 1\n');
  for (const blender of [
    { script: 'bird.py', inputs: [{ path: 'missing.py' }] },
    { script: 'bird.py', inputs: [{ path: 'design.py', sha256: '0'.repeat(64) }] },
    { script: 'bird.py', toolchain: { ...toolchain, helpersSha256: '0'.repeat(64) } },
    { script: 'bird.py', toolchain: { ...toolchain, agentMeshesVersion: '999.0.0' } },
  ]) {
    await writeFile(config, JSON.stringify({ version: 1, blender, output: 'generated' }));
    await expect(buildAsset(config)).rejects.toThrow(/missing|pin/i);
    expect(authorGLB).not.toHaveBeenCalled();
    expect((await readdir(directory)).some(name => /generated|\.lock|\.stage-/.test(name))).toBe(false);
  }
});

it('records valid pinned entry/import/data and actual tools without absolute runtime paths', async () => {
  const { directory, config, output, source } = await fixture();
  await mkdir(join(directory, 'data'));
  await writeFile(join(directory, 'design.py'), 'WIDTH = 1\n');
  await writeFile(join(directory, 'data', 'shape.bin'), new Uint8Array([0, 255, 1]));
  const toolchain = { ...(await captureBuildToolchain()).identity, blenderVersion: '5.0.1' };
  const inputs = [
    { path: 'design.py', sha256: createHash('sha256').update('WIDTH = 1\n').digest('hex') },
    { path: 'data/shape.bin' },
    { path: 'bird.py', sha256: createHash('sha256').update(source).digest('hex') },
  ];
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', inputs, toolchain }, output: 'generated' }));
  await buildAsset(config);
  const receipt = JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'));
  expect(receipt.provenance.toolchain).toEqual(toolchain);
  expect(receipt.provenance.inputs.map((file: { path: string }) => file.path)).toEqual(['bird.py', 'data/shape.bin', 'design.py']);
  expect(receipt.provenance.helpers.some((file: { path: string }) => file.path.endsWith('hm08_head.npz'))).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain(directory);
  expect(JSON.stringify(receipt)).not.toMatch(/__pycache__|\.pyc/);
});

it('preserves output and cleans staging when inputs mutate or Blender reports a wrong pin', async () => {
  const { directory, config, output } = await fixture();
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  const toolchain = { ...(await captureBuildToolchain()).identity, blenderVersion: '5.0.1' };
  await writeFile(join(directory, 'design.py'), 'WIDTH = 1\n');
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', inputs: [{ path: 'design.py' }], toolchain }, output: 'generated' }));
  const original = authorGLB.getMockImplementation()!;
  authorGLB.mockImplementationOnce(async (...args: unknown[]) => ({ ...await original(...args), blender: '4.0.0' }));
  await expect(buildAsset(config)).rejects.toThrow(/toolchain.*pin/i);
  for (const mutate of [
    () => writeFile(join(directory, 'design.py'), 'WIDTH = 2\n'),
    () => rm(join(directory, 'design.py')),
    () => writeFile(join(directory, 'bird.py'), '# changed entry\n'),
    () => writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py' }, output: 'other' })),
  ]) {
    await writeFile(join(directory, 'design.py'), 'WIDTH = 1\n');
    // Mutation happens after authoring, during the existing decoration seam.
    await expect(buildAsset(config, { decorateAsset: async () => { await mutate(); return []; } })).rejects.toThrow(/changed|missing/i);
    expect(await readFile(join(output, 'model.glb'))).toEqual(before);
    expect((await readdir(directory)).filter(name => name.includes('.stage-') || name.includes('.lock') || name.includes('.backup-'))).toEqual([]);
  }
});

it('protects declared inputs from output overlap and rejects missing/directories/links visibly', async () => {
  const { directory, config } = await fixture();
  const owned = join(directory, 'protected'); await mkdir(owned);
  await writeFile(join(owned, 'design.py'), 'keep me');
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', inputs: [{ path: 'protected/design.py' }] }, output: 'protected' }));
  await expect(buildAsset(config)).rejects.toThrow(/contain|overlap/i);
  expect(await readFile(join(owned, 'design.py'), 'utf8')).toBe('keep me');
  await symlink(owned, join(directory, 'alias'), 'junction');
  for (const path of ['protected', 'alias/design.py']) {
    await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', inputs: [{ path }] }, output: 'generated' }));
    await expect(buildAsset(config)).rejects.toThrow(/file|link/i);
  }
  expect(authorGLB).not.toHaveBeenCalled();
});

it('keeps the extension strict and optional without accepting partial tool locks or path patterns', async () => {
  const { config } = await fixture();
  for (const extra of [
    { toolchain: {} }, { toolchain: { agentMeshesVersion: '0.19.0' } },
    { inputs: ['design.py'] }, { inputs: [{ path: '*.py' }] }, { inputs: [{ path: '../design.py' }] },
    { inputs: [{ path: 'bird.py', sha256: 'not-a-digest' }] },
    { inputs: [{ path: 'bird.py', extra: true }] }, { unexpected: true },
    { inputs: [{ path: 'bird.py' }, { path: 'bird.py' }] },
  ]) {
    await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py', ...extra }, output: 'generated' }));
    await expect(buildAsset(config)).rejects.toThrow();
  }
  expect(authorGLB).not.toHaveBeenCalled();
});

it('hashes the final staged model after decoration and preserves receipt availability in the callback', async () => {
  const { config, output } = await fixture();
  const finalBytes = await exportGLB(applyOperation(applyOperation(createProject('final fixture'), { op: 'add', part: { name: 'different_body' } }), { op: 'add', part: { name: 'extra', position: [2, 0, 0] } }));
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py' }, output: 'generated', verify: { maxTriangles: 1000 } }));
  let initialTriangles = 0;
  await buildAsset(config, { decorateAsset: async (_asset, stage) => {
    expect(JSON.parse(await readFile(join(stage, 'authoring.json'), 'utf8')).blender).toBe('5.0.1');
    initialTriangles = JSON.parse(await readFile(join(stage, 'verification.json'), 'utf8')).limits.triangles;
    await writeFile(join(stage, 'model.glb'), finalBytes); return [];
  } });
  const receipt = JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'));
  expect(await readFile(join(output, 'model.glb'))).toEqual(Buffer.from(finalBytes));
  expect(receipt.provenance.output.sha256).toBe(createHash('sha256').update(finalBytes).digest('hex'));
  const verified = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(verified.ok).toBe(true);
  expect(verified.limits.triangles).toBeGreaterThan(initialTriangles);
});

it('does not write through a linked receipt created during decoration and cleans the failed stage', async () => {
  const { config, directory, output, source } = await fixture();
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  const changed = await exportGLB(applyOperation(createProject('replacement'), { op: 'add', part: { name: 'replacement' } }));
  for (const name of ['authoring.json', 'verification.json']) {
    await expect(buildAsset(config, { decorateAsset: async (_asset, stage) => {
      await rm(join(stage, name));
      await link(join(directory, 'bird.py'), join(stage, name));
      if (name === 'verification.json') await writeFile(join(stage, 'model.glb'), changed);
      return [];
    } })).rejects.toThrow(/link/i);
    expect(await readFile(join(directory, 'bird.py'), 'utf8')).toBe(source);
    expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  }
  expect((await readdir(directory)).filter(name => /\.stage-|\.lock|\.backup-/.test(name))).toEqual([]);
});

it('preserves the last authored output and releases staging/lock on runner or validation failure', async () => {
  const { config, directory, output } = await fixture(); await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  authorGLB.mockRejectedValueOnce(new Error('Blender author failed: source error'));
  await expect(buildAsset(config)).rejects.toThrow('source error');
  authorGLB.mockImplementationOnce(async (_input: string, out: string) => { await writeFile(out, 'invalid GLB'); return { blender: '5.0.1', meshes: 1 }; });
  await expect(buildAsset(config)).rejects.toThrow();
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  expect((await readdir(directory)).filter(name => name.includes('.stage-') || name.includes('.lock'))).toEqual([]);
});

it('rejects ambiguous inputs/refinement and sources inside the output before launching Blender', async () => {
  const { directory, config } = await fixture();
  for (const fields of [{ project: 'bird.py' }, { operations: 'bird.py' }, { refine: {} }, { output: '.' }]) {
    await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py' }, output: 'generated', ...fields }));
    await expect(buildAsset(config)).rejects.toThrow(/one|refine|contain/i);
  }
  expect(authorGLB).not.toHaveBeenCalled();
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: '../missing.py' }, output: 'generated' }));
  await expect(buildAsset(config)).rejects.toThrow();
  expect(await readdir(directory)).not.toContain('generated');
});

it('holds the output lock during authored execution and rejects unlisted authored artifacts', async () => {
  const { config, output } = await fixture(); await buildAsset(config);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = authorGLB.getMockImplementation()!;
  authorGLB.mockImplementationOnce(async (...args: unknown[]) => { entered(); await gate; return original(...args); });
  const first = buildAsset(config); await started;
  try { await expect(buildAsset(config)).rejects.toThrow(/locked/i); } finally { release(); await first; }
  await expect(buildAsset(config, { decorateAsset: async (_asset, stage) => { await writeFile(join(stage, 'unlisted.txt'), 'bad'); return []; } })).rejects.toThrow(/unexpected/i);
  expect(await readdir(output)).not.toContain('unlisted.txt');
});


it('preserves canonical legacy config aliases and hard-linked entry files without declarations', async () => {
  const { directory, config } = await fixture();
  const real = join(directory, 'real'); await mkdir(real);
  await writeFile(join(real, 'bird.py'), 'def build():\n    return []\n');
  await writeFile(join(real, 'build.json'), JSON.stringify({ version: 1, blender: { script: 'bird.py' }, output: 'generated' }));
  await symlink(real, join(directory, 'alias'), 'junction');
  const result = await buildAsset(join(directory, 'alias', 'build.json'));
  expect(result.output).toBe(join(await realpath(real), 'generated'));
  expect(authorGLB.mock.calls.at(-1)![0]).toBe(await realpath(join(real, 'bird.py')));
  await writeFile(join(real, 'build.json'), JSON.stringify({ version: 1, blender: { script: '../alias/bird.py' }, output: 'generated' }));
  await expect(buildAsset(join(real, 'build.json'))).resolves.toHaveProperty('output');
  expect(authorGLB.mock.calls.at(-1)![0]).toBe(await realpath(join(real, 'bird.py')));
  await link(join(real, 'bird.py'), join(real, 'entry-linked.py'));
  await writeFile(join(real, 'build.json'), JSON.stringify({ version: 1, blender: { script: 'entry-linked.py' }, output: 'generated' }));
  await expect(buildAsset(join(real, 'build.json'))).resolves.toHaveProperty('output');
});


it('rejects invalid or over-budget decorated models while preserving the last verified output', async () => {
  const { config, output, directory } = await fixture();
  await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'bird.py' }, output: 'generated', verify: { maxTriangles: 68 } }));
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  const overBudget = await exportGLB(applyOperation(applyOperation(createProject('over budget'), { op: 'add', part: { name: 'one' } }), { op: 'add', part: { name: 'two', position: [2, 0, 0] } }));
  for (const replacement of [Buffer.from('invalid GLB'), Buffer.from(overBudget)]) {
    await expect(buildAsset(config, { decorateAsset: async (_asset, stage) => {
      await writeFile(join(stage, 'model.glb'), replacement); return [];
    } })).rejects.toThrow();
    expect(await readFile(join(output, 'model.glb'))).toEqual(before);
    expect((await readdir(directory)).filter(name => /\.stage-|\.lock|\.backup-/.test(name))).toEqual([]);
  }
});
