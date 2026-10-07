import { describe, expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { checkDetached } from '../src/verify-detached.ts';
import type { Operation, Project } from '../src/core/types.ts';
import { checkLimits } from '../src/glb-limits.ts';
import { buildAsset } from '../src/build.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const build = (operations: Operation[], name = 'kit'): Project => operations.reduce(applyOperation, createProject(name));
const detached = async (operations: Operation[], options = {}) => checkDetached(await exportGLB(build(operations)), options);
const add = (part: Extract<Operation, { op: 'add' }>['part']): Operation => ({ op: 'add', part });
const quarterX: [number, number, number, number] = [0.7071068, 0, 0, 0.7071068];
const quarterY: [number, number, number, number] = [0, 0.7071068, 0, 0.7071068];

// Reduced from the Sector Run part kit (agent-meshes lessons, friction 6): each passed batch --dry-run, verify and a
// glTF validator while a piece floated clear of the body.
describe('the three part-kit cases', () => {
  const spine = add({ name: 'spine', geometry: { type: 'box', size: [1.4, 1.2, 6.6] }, position: [0, 0, -0.2] });
  const pod = (x: number) => add({ name: 'pod_l', geometry: { type: 'cylinder', size: [1.5, 3.8, 1.5], segments: 10 }, position: [x, -0.15, -1.1], rotation: quarterX });

  it('hull-hauler: a drum 0.14 m off the spine is reported with its gap; the overlapping fix is silent', async () => {
    const report = await detached([spine, pod(-1.55)]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([expect.objectContaining({ code: 'DETACHED_PART', parts: ['pod_l'], nearest: 'spine' })]);
    // The drum's inner face is 1.55 - 0.75 = 0.80 m from the axis against a 0.70 m spine; facets bring it slightly closer.
    expect(report.findings[0].gap).toBeGreaterThan(0.12);
    expect(report.findings[0].gap).toBeLessThan(0.1501);
    expect(report.findings[0].message).toMatch(/^DETACHED_PART: pod_l touches nothing else: 0\.1\d+ m from the nearest part \(spine\)/);
    expect(await detached([spine, pod(-1.4)])).toMatchObject({ ok: true, groups: 1, findings: [] });
  });

  const block = add({ name: 'block', geometry: { type: 'box', size: [1.4, 0.6, 1] }, position: [0, 0, -0.2] });
  const nozzle = add({ name: 'nozzle_l', geometry: { type: 'cylinder', size: [0.55, 1, 0.55], segments: 12 }, position: [-0.5, 0, -1], rotation: [0.7032332, 0.0739128, -0.0739128, 0.7032332] });
  const vane = (x: number, z: number) => add({ name: 'vane_l', geometry: { type: 'prism', size: [0.9, 0.7, 0.1], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.2]] }, position: [x, 0, z], rotation: quarterY });

  it('engine-vector: a steering vane clear of the block and the angled nozzle is reported; against them it is silent', async () => {
    const report = await detached([block, nozzle, vane(-1.05, -0.9)]);
    expect(report.findings).toEqual([expect.objectContaining({ parts: ['vane_l'], nearest: 'nozzle_l' })]);
    expect(report.findings[0].gap).toBeGreaterThan(0.1);
    expect(await detached([block, nozzle, vane(-0.75, -0.75)])).toMatchObject({ ok: true, findings: [] });
  });

  const wings = (outline: [number, number][]) => add({ name: 'wings', geometry: { type: 'prism', size: [7, 2.6, 0.25], outline }, position: [0, -0.05, -0.4], rotation: quarterX });
  const winglet = (x: number, z: number, length: number) => add({ name: 'winglet_l', geometry: { type: 'prism', size: [length, 1.1, 0.18], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.1], [-0.2, 0.5]] }, position: [x, 0.45, z], rotation: quarterY });
  const swept: [number, number][] = [[-0.2, 0.5], [0.2, 0.5], [0.5, -0.5], [-0.5, -0.5]];

  it('hull-wing: a winglet clear of the swept tip is reported; one whose root overlaps the tip is joined', async () => {
    const clear = await detached([wings(swept), winglet(-3.3, 0.2, 1.3)]);
    expect(clear.findings).toEqual([expect.objectContaining({ parts: ['winglet_l'], nearest: 'wings' })]);
    // The original placement hung mostly in front of the leading edge, but its rear 0.2 m overlaps the pointed tip,
    // so it is attached, not detached; this lint measures contact, not how much of a part is supported.
    expect(await detached([wings(swept), winglet(-3.3, -0.9, 1.3)])).toMatchObject({ ok: true });
    expect(await detached([wings([[-0.2, 0.5], [0.2, 0.5], [0.5, -0.2], [0.5, -0.5], [-0.5, -0.5], [-0.5, -0.2]]), winglet(-3.38, -1.27, 0.85)])).toMatchObject({ ok: true });
  });
});

describe('connected models stay silent', () => {
  const base = add({ name: 'base', geometry: { type: 'box', size: [1, 1, 1] } });
  it('accepts touching faces, overlaps, nesting and gaps inside the tolerance', async () => {
    expect(await detached([base, add({ name: 'touching', geometry: { type: 'box', size: [1, 1, 1] }, position: [1, 0, 0] })])).toMatchObject({ ok: true, parts: 2, groups: 1 });
    expect(await detached([base, add({ name: 'overlap', geometry: { type: 'sphere', size: [1, 1, 1] }, position: [0.8, 0, 0] })])).toMatchObject({ ok: true });
    // A core wholly inside a closed shell touches no surface but is held by it.
    expect(await detached([base, add({ name: 'core', geometry: { type: 'sphere', size: [0.2, 0.2, 0.2] } })])).toMatchObject({ ok: true, groups: 1 });
    expect(await detached([base, add({ name: 'near', geometry: { type: 'box', size: [1, 1, 1] }, position: [1.005, 0, 0] })])).toMatchObject({ ok: true });
  });

  it('applies parent groups (sockets) and their transforms, and does not count empty groups as parts', async () => {
    const report = await detached([base,
      add({ name: 'socket_side', geometry: { type: 'group' }, position: [2, 0, 0] }),
      add({ name: 'on_socket', geometry: { type: 'box', size: [1, 1, 1] }, position: [-1, 0, 0], parent: 'socket_side' })]);
    expect(report).toMatchObject({ ok: true, parts: 2 });
  });

  it('measures rotated parts by their real surface, not their bounds', async () => {
    // A long bar turned 45 degrees about y: its bounds overlap the cube, its surface does not come near it.
    const bar = (x: number) => add({ name: 'bar', geometry: { type: 'box', size: [3, 0.2, 0.2] }, position: [x, 0, x], rotationEuler: [0, 45, 0] });
    const report = await detached([base, bar(1.4)]);
    expect(report.findings).toEqual([expect.objectContaining({ parts: ['bar'], nearest: 'base' })]);
    expect(report.findings[0].gap).toBeGreaterThan(0.3);
    expect(await detached([base, bar(0.5)])).toMatchObject({ ok: true });
  });
});

describe('reporting', () => {
  const body = add({ name: 'body', geometry: { type: 'box', size: [1, 1, 1] } });
  const floater = (name: string, x: number) => add({ name, geometry: { type: 'box', size: [0.2, 0.2, 0.2] }, position: [x, 1, 0] });

  it('names a floating group once with every part in it, against the largest connected body', async () => {
    const report = await detached([body, floater('left', 0), floater('right', 0.2)]);
    expect(report.findings).toEqual([expect.objectContaining({ parts: ['left', 'right'], nearest: 'body' })]);
    expect(report.findings[0].gap).toBeCloseTo(0.4, 3);
    expect(report.findings[0].message).toContain('left, right touch each other but nothing else');
  });

  it('takes a tolerance and an allow list', async () => {
    const ops = [body, add({ name: 'halo', geometry: { type: 'box', size: [0.2, 0.2, 0.2] }, position: [0, 0.62, 0] })];
    expect((await detached(ops)).findings[0]).toMatchObject({ parts: ['halo'], gap: 0.02 });
    expect(await detached(ops, { tolerance: 0.05 })).toMatchObject({ ok: true, tolerance: 0.05 });
    expect(await detached(ops, { allow: ['halo'] })).toMatchObject({ ok: true, groups: 2 });
  });

  it('skips skinned or animated models and says why', async () => {
    const rigged = [body, { op: 'bone.add', bone: { name: 'root' } }, floater('loose', 0), { op: 'bind', name: 'loose', binding: { type: 'rigid', bone: 'root' } }] as Operation[];
    const report = await detached(rigged);
    expect(report).toMatchObject({ ok: true, findings: [] });
    expect(report.skipped).toMatch(/skinned or animated/);
  });

  it('has nothing to say about a single part or a merged model', async () => {
    expect(await detached([body])).toMatchObject({ ok: true, parts: 1, groups: 1 });
    const merged = checkDetached(await exportGLB(build([body, floater('loose', 0)]), { merge: 'byMaterial' }));
    expect(merged).toMatchObject({ ok: true, parts: 1 });
  });
});

describe('verify, budgets and build', () => {
  const run = promisify(execFile);
  const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 30000, windowsHide: true });
  const kit = [add({ name: 'spine', geometry: { type: 'box', size: [1.4, 1.2, 6.6] } }),
    add({ name: 'pod_l', geometry: { type: 'cylinder', size: [1.5, 3.8, 1.5], segments: 10 }, position: [-1.55, 0, 0], rotation: quarterX })];
  const withTemp = async (body: (directory: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-detached-'));
    try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
  };

  it('verify warns by default without failing, and --max-gap makes it a budget', () => withTemp(async directory => {
    const file = join(directory, 'hauler.glb'); await writeFile(file, await exportGLB(build(kit)));
    const warned = await cli('verify', file);
    expect(JSON.parse(warned.stdout)).toMatchObject({ ok: true, detached: { ok: false, tolerance: 0.01, findings: [{ code: 'DETACHED_PART', parts: ['pod_l'], nearest: 'spine' }] } });
    expect(warned.stderr).toMatch(/^WARN DETACHED_PART: pod_l touches nothing else/m);
    await expect(cli('verify', file, '--max-gap', '0.05')).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/FAIL DETACHED_PART: pod_l/) });
    expect(JSON.parse((await cli('verify', file, '--max-gap', '0.2')).stdout)).toMatchObject({ detached: { ok: true, tolerance: 0.2 }, limits: { ok: true } });
    expect(JSON.parse((await cli('verify', file, '--max-gap', '0.05', '--warn-only')).stdout).limits).toMatchObject({ ok: false, warnOnly: true });
    const allowed = await cli('verify', file, '--allow-detached', 'pod_l');
    expect(JSON.parse(allowed.stdout).detached).toMatchObject({ ok: true }); expect(allowed.stderr).toBe('');
    const joined = join(directory, 'joined.glb'); await writeFile(joined, await exportGLB(build([kit[0]])));
    const clean = await cli('verify', joined);
    expect(JSON.parse(clean.stdout).detached).toMatchObject({ ok: true, groups: 1 }); expect(clean.stderr).toBe('');
    await expect(cli('verify', file, '--max-gap', '-1')).rejects.toMatchObject({ stderr: expect.stringContaining('--max-gap') });
  }), 60000);

  it('checkLimits reports maxGap like the other budgets', async () => {
    const bytes = await exportGLB(build(kit));
    const report = checkLimits(bytes, { maxGap: 0.01 });
    expect(report.checks).toEqual([expect.objectContaining({ name: 'maxGap', ok: false, expected: 0.01 })]);
    expect(report.failures[0]).toMatch(/^DETACHED_PART: pod_l/);
    expect(checkLimits(bytes, { maxGap: 0.01, allowDetached: ['pod_l'] }).ok).toBe(true);
  });

  it('a build records the lint in verification.json and the result, and fails on a verify.maxGap budget', () => withTemp(async directory => {
    await writeFile(join(directory, 'ops.json'), JSON.stringify(kit));
    const config = join(directory, 'build.json');
    await writeFile(config, JSON.stringify({ version: 1, name: 'hauler', operations: 'ops.json', output: 'dist' }));
    const result = await buildAsset(config);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'DETACHED_PART', parts: ['pod_l'] })]);
    expect(JSON.parse(await readFile(join(result.output, 'verification.json'), 'utf8')).detached).toMatchObject({ ok: false, findings: [{ parts: ['pod_l'] }] });
    await writeFile(config, JSON.stringify({ version: 1, name: 'hauler', operations: 'ops.json', output: 'dist', verify: { maxGap: 0.01 } }));
    await expect(buildAsset(config)).rejects.toMatchObject({ code: 'VERIFY_LIMITS_FAILED', message: expect.stringContaining('DETACHED_PART: pod_l') });
    await writeFile(config, JSON.stringify({ version: 1, name: 'hauler', operations: 'ops.json', output: 'dist', verify: { maxGap: 0.01, allowDetached: ['pod_l'] } }));
    expect((await buildAsset(config)).warnings).toBeUndefined();
  }), 60000);
});
