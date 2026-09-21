import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProject, applyOperation } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { buildAsset } from '../src/build.ts';

const { authorGLB } = vi.hoisted(() => ({ authorGLB: vi.fn() }));
vi.mock('../src/author.ts', () => ({ authorGLB }));
const directories: string[] = [];
beforeEach(() => { authorGLB.mockReset(); });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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

it('builds verified authored assets without inventing an editable primitive project', async () => {
  const { config, output, directory, source } = await fixture();
  const decorate = vi.fn();
  const decorateAsset = vi.fn(async (asset: { name: string }, stage: string) => {
    expect(asset.name).toBe('Bird'); expect((await readFile(join(stage, 'model.glb'))).length).toBeGreaterThan(0);
    await writeFile(join(stage, 'preview.html'), '<html>authored</html>'); return ['preview.html'];
  });
  const result = await buildAsset(config, { decorate, decorateAsset });
  expect(result.files).toEqual(['model.glb', 'verification.json', 'authoring.json', 'preview.html']);
  expect(authorGLB.mock.calls[0][0]).toBe(await realpath(join(directory, 'bird.py'))); expect(decorate).not.toHaveBeenCalled();
  expect(decorateAsset).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
  expect(JSON.parse(await readFile(join(output, 'authoring.json'), 'utf8'))).toMatchObject({ version: 1, blender: '5.0.1', source: { script: 'bird.py', sha256: createHash('sha256').update(source).digest('hex') } });
  expect(await readdir(output)).not.toContain('project.mesh.json');
  await buildAsset(config);
  expect(await readdir(output)).not.toContain('preview.html');
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
