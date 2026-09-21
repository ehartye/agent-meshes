import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorGLB } from '../src/author.ts';

const { spawn, findBlender } = vi.hoisted(() => ({ spawn: vi.fn(), findBlender: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../src/refine.ts', () => ({ findBlender }));
const directories: string[] = [];
beforeEach(() => { spawn.mockReset(); findBlender.mockReset().mockReturnValue({ command: 'blender', detached: false }); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-author-test-')); directories.push(directory);
  const input = join(directory, 'source.py'), output = join(directory, 'model.glb');
  await writeFile(input, 'def build(): return []');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn((_signal?: string) => { queueMicrotask(() => child.emit('close', -1)); return true; }) });
  spawn.mockReturnValue(child);
  return { directory, input, output, child };
}

it('runs the wrapper with literal paths and reads its completion report after attached exit', async () => {
  const { input, output, child, directory } = await fixture();
  spawn.mockImplementation(() => {
    void (async () => { await writeFile(output, 'GLB'); await writeFile(`${output}.done`, JSON.stringify({ ok: true, meshes: 2, blender: '5.0.1' })); child.emit('close', 0); })();
    return child;
  });
  await expect(authorGLB(input, output)).resolves.toEqual({ output, bytes: 3, meshes: 2, blender: '5.0.1' });
  expect(spawn).toHaveBeenCalledWith('blender', expect.arrayContaining(['--python', expect.stringMatching(/blender-author\.py$/), '--', await realpath(input), output]), expect.objectContaining({ windowsHide: true }));
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['source.py', 'model.glb']));
  expect(await readdir(directory)).not.toContain('model.glb.done');
});

it('waits for Store launcher completion even after its launcher exits successfully', async () => {
  const { input, output, child } = await fixture(); findBlender.mockReturnValue({ command: 'blender-launcher', detached: true });
  spawn.mockImplementation(() => {
    setTimeout(() => child.emit('close', 0), 0);
    setTimeout(() => { void (async () => { await writeFile(output, 'GLB'); await writeFile(`${output}.done`, JSON.stringify({ ok: true, meshes: 1, blender: '5.0.1' })); })(); }, 50);
    return child;
  });
  await expect(authorGLB(input, output, { timeoutMs: 1000 })).resolves.toMatchObject({ meshes: 1 });
});

it('rejects missing Blender and spawn errors promptly', async () => {
  const { input, output, child } = await fixture(); findBlender.mockReturnValueOnce(null);
  await expect(authorGLB(input, output)).rejects.toThrow(/not installed/i); expect(spawn).not.toHaveBeenCalled();
  spawn.mockImplementation(() => { setTimeout(() => child.emit('error', new Error('ENOENT executable')), 0); return child; });
  await expect(authorGLB(input, output, { timeoutMs: 1000 })).rejects.toThrow(/ENOENT/);
});

it('rejects nonzero exits and attached exits without a report instead of waiting for the deadline', async () => {
  for (const code of [7, 0]) {
    const { input, output, child } = await fixture();
    spawn.mockImplementation(() => { setTimeout(() => child.emit('close', code), 0); return child; });
    await expect(authorGLB(input, output, { timeoutMs: 1000 })).rejects.toThrow(code ? /exit.*7/i : /without.*report/i);
  }
});

it('rejects a wrapper failure and never accepts a stale success report', async () => {
  const { input, output, child } = await fixture();
  await writeFile(`${output}.done`, JSON.stringify({ ok: true, meshes: 1, blender: 'old' }));
  spawn.mockImplementation(() => {
    void (async () => { await writeFile(`${output}.done`, JSON.stringify({ ok: false, error: 'source traceback' })); child.emit('close', 1); })();
    return child;
  });
  await expect(authorGLB(input, output)).rejects.toThrow(/source traceback/);
});

it('times out and stops a hung child, clearing runner files', async () => {
  const { directory, input, output, child } = await fixture();
  await expect(authorGLB(input, output, { timeoutMs: 30 })).rejects.toThrow(/timed out/i);
  expect(child.kill).toHaveBeenCalled();
  expect(await readdir(directory)).toEqual(['source.py']);
  expect(await readFile(input, 'utf8')).toContain('build');
});

it('waits for a killed child to close before cleaning its last output writes', async () => {
  const { directory, input, output, child } = await fixture();
  child.kill.mockImplementation(() => {
    setTimeout(() => { void writeFile(output, 'last partial bytes').then(() => child.emit('close', -1)); }, 30);
    return true;
  });
  await expect(authorGLB(input, output, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
  await new Promise(done => setTimeout(done, 50));
  expect(await readdir(directory)).toEqual(['source.py']);
});

it('protects the source through directory aliases before removing any output', async () => {
  const { directory, input } = await fixture();
  const alias = `${directory}-alias`; directories.push(alias);
  await symlink(directory, alias, 'junction');
  await expect(authorGLB(input, join(alias, 'source.py'), { timeoutMs: 20 })).rejects.toThrow(/output.*source/i);
  expect(await readFile(input, 'utf8')).toContain('build'); expect(spawn).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32')('protects the source through Windows case aliases', async () => {
  const { directory, input } = await fixture();
  await expect(authorGLB(input, join(directory, 'SOURCE.py'), { timeoutMs: 20 })).rejects.toThrow(/output.*source/i);
  expect(await readFile(input, 'utf8')).toContain('build'); expect(spawn).not.toHaveBeenCalled();
});
