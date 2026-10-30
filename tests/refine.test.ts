import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mesh, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { BlenderVersionError } from '../src/blender-version.ts';
import { findBlender, inspectBlender, refineGLB } from '../src/refine.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function project() {
  let p = createProject('refine');
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'hip', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -0.5, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'thigh', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.75, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'hip' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'shin', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.25, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'knee' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'hat', geometry: { type: 'sphere', size: [0.3, 0.3, 0.3] }, position: [0, 1.5, 0], color: '#cc3333' } });
  return applyOperation(p, { op: 'clip.set', clip: { name: 'kick', duration: 1, tracks: [{ bone: 'knee', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0.7071068, 0, 0, 0.7071068] }, { time: 1, value: [0, 0, 0, 1] }] }] } });
}

// A Blender that is installed but not 5.2.x throws; the real-Blender tests below are skipped in that case.
let blender: ReturnType<typeof findBlender> = null;
try { blender = findBlender(); } catch { /* unsupported Blender: skip the real runs */ }
const maybe = blender ? it : it.skip;

describe('findBlender discovery', () => {
  const exe = process.platform === 'win32' ? 'blender.exe' : process.platform === 'darwin' ? 'Blender.app/Contents/MacOS/Blender' : 'blender';
  async function fakeBlender(root: string, ...parts: string[]) {
    const path = join(root, ...parts, exe); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, ''); await chmod(path, 0o755); return path;
  }
  async function sandbox() { const home = await mkdtemp(join(tmpdir(), 'mesh-find-blender-')); directories.push(home); return home; }
  // A fake install reports the version in its folder name (`blender-5.2.2-windows-x64`), so no real Blender runs.
  const versionOf = (command: string) => /blender-(\d+\.\d+\.\d+)-/.exec(command.replaceAll('\\', '/'))?.[1] ?? null;
  // PATH is emptied so a Blender installed on the test machine cannot satisfy a search.
  const options = (home: string, env: NodeJS.ProcessEnv = {}) => ({ home, env: { PATH: '', ...env }, readVersion: versionOf });

  it('lets AGENT_MESHES_BLENDER win and says so', async () => {
    const home = await sandbox(); await fakeBlender(home, 'tools', 'blender', 'blender-5.2.2-windows-x64');
    const explicit = await fakeBlender(home, 'elsewhere', 'blender-5.2.0-windows-x64');
    expect(findBlender(options(home, { AGENT_MESHES_BLENDER: explicit }))).toEqual({ command: explicit, detached: false, source: 'AGENT_MESHES_BLENDER' });
  });
  it('finds a portable copy under ~/tools/blender/* and prefers the newest 5.2.x', async () => {
    const home = await sandbox();
    for (const version of ['4.5.0', '5.2.9', '5.2.10', '5.2.2', '5.3.0']) await fakeBlender(home, 'tools', 'blender', `blender-${version}-windows-x64`);
    // 5.2.10 is newer than 5.2.9: versions compare numerically, not as text; 5.3.0 and 4.5.0 are not 5.2.x.
    expect(findBlender(options(home))).toMatchObject({ command: join(home, 'tools', 'blender', 'blender-5.2.10-windows-x64', exe), source: 'tools-blender' });
  });
  it('picks 5.2.2 over 4.2.3 and over a newer unsupported series', async () => {
    const home = await sandbox();
    for (const version of ['4.2.3', '5.2.2', '5.3.0', '6.0.0']) await fakeBlender(home, 'tools', 'blender', `blender-${version}-windows-x64`);
    expect(findBlender(options(home))).toMatchObject({ command: join(home, 'tools', 'blender', 'blender-5.2.2-windows-x64', exe) });
  });
  it('searches ~/.agent-meshes/blender/* first, and honours AGENT_MESHES_HOME', async () => {
    const home = await sandbox(); const managed = join(home, 'elsewhere');
    await fakeBlender(home, 'tools', 'blender', 'blender-5.2.2-windows-x64');
    const inHome = await fakeBlender(home, '.agent-meshes', 'blender', 'blender-5.2.1-windows-x64');
    expect(findBlender(options(home))).toMatchObject({ command: inHome, source: 'agent-meshes-home' });
    const custom = await fakeBlender(managed, 'blender', 'blender-5.2.0-windows-x64');
    expect(findBlender(options(home, { AGENT_MESHES_HOME: managed }))).toMatchObject({ command: custom, source: 'agent-meshes-home' });
  });
  it('skips folders without an executable and returns null when nothing is installed', async () => {
    const home = await sandbox(); await mkdir(join(home, 'tools', 'blender', 'blender-5.2.2-windows-x64'), { recursive: true });
    expect(findBlender(options(home, { PATH: '' }))).toBeNull();
  });
  it('falls back to PATH and labels it', async () => {
    const home = await sandbox(); const bin = join(home, 'bin', 'blender-5.2.2-windows-x64'); await fakeBlender(bin);
    const name = process.platform === 'win32' ? 'blender.exe' : 'blender';
    if (process.platform === 'darwin') return; // macOS PATH lookup expects a plain `blender` file
    expect(findBlender(options(home, { PATH: bin }))).toMatchObject({ command: join(bin, name), source: 'path' });
  });
  it('throws one message naming the version, the 5.2 LTS series and the download when AGENT_MESHES_BLENDER is not 5.2.x', async () => {
    const home = await sandbox(); const old = await fakeBlender(home, 'old', 'blender-4.2.3-windows-x64');
    await fakeBlender(home, 'tools', 'blender', 'blender-5.2.2-windows-x64');
    const attempt = () => findBlender(options(home, { AGENT_MESHES_BLENDER: old }));
    // The installed 5.2.2 is never substituted for the explicit choice.
    expect(attempt).toThrow(BlenderVersionError);
    expect(attempt).toThrow(/Blender 4\.2\.3 at .*, but agent-meshes requires Blender 5\.2 LTS \(any 5\.2\.x\)\. Download it from https:\/\/www\.blender\.org\/download\//);
  });
  it('treats an unreadable version as unsupported and tells the user to set AGENT_MESHES_BLENDER to a portable 5.2.x copy', async () => {
    const home = await sandbox(); const launcher = await fakeBlender(home, 'WindowsApps', 'blender-launcher');
    expect(() => findBlender({ home, env: { PATH: '', AGENT_MESHES_BLENDER: launcher }, readVersion: () => null })).toThrow(/unreadable Blender version.*set AGENT_MESHES_BLENDER to a portable 5\.2\.x copy/);
  });
  it('lists every rejected candidate with its version when none qualifies', async () => {
    const home = await sandbox();
    const a = await fakeBlender(home, 'tools', 'blender', 'blender-4.2.3-windows-x64'), b = await fakeBlender(home, 'tools', 'blender', 'blender-3.4.1-windows-x64');
    let message = ''; try { findBlender(options(home)); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(`${a} (4.2.3)`); expect(message).toContain(`${b} (3.4.1)`);
    expect(message).toMatch(/requires Blender 5\.2 LTS.*blender\.org\/download/);
  });
  it('inspectBlender reports the rejected Blender without throwing', async () => {
    const home = await sandbox(); const only = await fakeBlender(home, 'tools', 'blender', 'blender-4.2.3-windows-x64');
    expect(inspectBlender(options(home))).toMatchObject({ location: { command: only }, version: '4.2.3', supported: false });
    expect(inspectBlender(options(await sandbox()))).toMatchObject({ location: null, supported: false });
  });
});

it('reports whether Blender is available without throwing', () => {
  expect(blender === null || typeof blender.command === 'string').toBe(true);
});

maybe('subdivides a GLB in Blender while keeping bones, skins, clips and validity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-refine-')); directories.push(directory);
  const input = join(directory, 'in.glb'), output = join(directory, 'out.glb');
  await writeFile(input, await exportGLB(project()));
  const before = await new GLTFLoader().parseAsync((await exportGLB(project())).slice().buffer, '');
  const result = await refineGLB(input, output, { subdivide: 1 });
  expect(result.meshes).toBeGreaterThanOrEqual(3);
  expect(result.bytes).toBeGreaterThan(0);
  const bytes = new Uint8Array(await (await import('node:fs/promises')).readFile(output));
  expect((await verifyGLB(bytes)).errors).toBe(0);
  const after = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
  const count = (scene: typeof after.scene) => { let vertices = 0, skinned = 0; scene.traverse(o => { if (o instanceof Mesh) vertices += o.geometry.getAttribute('position').count; if (o instanceof SkinnedMesh) skinned++; }); return { vertices, skinned }; };
  expect(count(after.scene).vertices).toBeGreaterThan(count(before.scene).vertices * 2);
  expect(count(after.scene).skinned).toBe(2);
  expect(after.animations.map(a => a.name)).toEqual(['kick']);
  const bones: string[] = []; after.scene.traverse(o => { if ((o as { isBone?: boolean }).isBone) bones.push(o.name); });
  expect(bones.sort()).toEqual(['hip', 'knee']);
}, 240000);
