import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { glbStats, diffStats } from '../src/glb-stats.ts';
import { lintSilhouette, silhouette } from '../src/silhouette.ts';
import type { Vec2 } from '../src/core/types.ts';

const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 20000, windowsHide: true });

/** A 1 m turned piece standing on y=0 (radius = profile radius x size, base 0.5 m): a wide base, a neck at y=0.4 and a second ring. */
async function turned(profile: Vec2[], lift = 0.5): Promise<Uint8Array> {
  const project = applyOperation(createProject('turned'), { op: 'add', part: { name: 'lathe', geometry: { type: 'lathe', size: [1, 1, 1], segments: 32, profile }, position: [0, lift, 0] } });
  return exportGLB(project);
}
const notched: Vec2[] = [[0, -0.5], [0.5, -0.5], [0.5, -0.2], [0.2, -0.1], [0.2, 0], [0.4, 0.1], [0.4, 0.3], [0, 0.5]];
const monotone: Vec2[] = [[0, -0.5], [0.5, -0.5], [0.5, -0.3], [0.3, 0], [0.2, 0.3], [0, 0.5]];

it('reports the radius against height of the exported geometry, exact between vertices', async () => {
  const profile = await silhouette(await turned(monotone), { axis: 'y', bins: 10 });
  expect(profile).toMatchObject({ axis: 'y', min: expect.closeTo(0, 4), max: expect.closeTo(1, 4) });
  expect(profile.bins).toHaveLength(10);
  expect(profile.bins[0].radius).toBeGreaterThan(0.49);
  // The cone from (0.5, 0.2) to (0.3, 0.5): the bin 0.4-0.5 holds its lowest vertex-free span.
  expect(profile.bins[4].radius).toBeLessThan(0.5);
  expect(profile.bins.at(-1)!.radius).toBeLessThan(0.15);
});

it('lints a notch: a local radius minimum followed by a larger radius', async () => {
  const bytes = await turned(notched);
  const findings = lintSilhouette(await silhouette(bytes, { axis: 'y', bins: 50 }));
  expect(findings).toHaveLength(1);
  expect(findings[0].y).toBeGreaterThan(0.35); expect(findings[0].y).toBeLessThan(0.55);
  expect(findings[0].radius).toBeCloseTo(0.2, 2);
  expect(findings[0].depth).toBeGreaterThan(0.15);
});

it('lints nothing for a profile that only narrows, and allows named zones', async () => {
  expect(lintSilhouette(await silhouette(await turned(monotone), { axis: 'y', bins: 50 }))).toEqual([]);
  const profile = await silhouette(await turned(notched), { axis: 'y', bins: 50 });
  expect(lintSilhouette(profile, { allow: [[0.3, 0.6]] })).toEqual([]);
  expect(lintSilhouette(profile, { allow: [[0.7, 0.9]] })).toHaveLength(1);
  expect(lintSilhouette(profile, { tolerance: 0.5 })).toEqual([]);
});

it('supports another axis and an off-origin axis centre', async () => {
  const profile = await silhouette(await turned(monotone), { axis: 'x', bins: 8 });
  expect(profile.axis).toBe('x');
  const shifted = await silhouette(await turned(monotone), { axis: 'y', bins: 4, center: [0.5, 0] });
  expect(shifted.bins[0].radius).toBeGreaterThan(0.9);
});

it('silhouette --json and --lint print the profile and exit 1 on a notch, honouring --allow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-silhouette-')); directories.push(directory);
  const file = join(directory, 'notched.glb'); await writeFile(file, await turned(notched));
  const plain = await cli('silhouette', file, '--axis', 'y', '--bins', '20', '--json');
  expect(JSON.parse(plain.stdout).bins).toHaveLength(20);
  await expect(cli('silhouette', file, '--bins', '50', '--lint')).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"findings"'), stderr: expect.stringContaining('notch') });
  const allowed = await cli('silhouette', file, '--bins', '50', '--lint', '--allow', '0.3:0.6');
  expect(JSON.parse(allowed.stdout).findings).toEqual([]);
}, 60000);

it('stats and diff compare triangle count, materials, bounds and a profile hash', async () => {
  const a = glbStats(await turned(monotone)), b = glbStats(await turned(monotone)), c = glbStats(await turned(notched));
  expect(diffStats(a, b)).toEqual([]);
  expect(diffStats(a, c).map(d => d.field)).toEqual(expect.arrayContaining(['triangles', 'profileHash']));
  const directory = await mkdtemp(join(tmpdir(), 'mesh-diff-')); directories.push(directory);
  const first = join(directory, 'a.glb'), second = join(directory, 'b.glb');
  await writeFile(first, await turned(monotone)); await writeFile(second, await turned(notched));
  expect(JSON.parse((await cli('stats', first)).stdout)).toMatchObject({ triangles: a.triangles, profileHash: a.profileHash });
  await expect(cli('diff', first, second)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"differences"') });
  expect(JSON.parse((await cli('diff', first, first)).stdout)).toMatchObject({ same: true, differences: [] });
}, 60000);
