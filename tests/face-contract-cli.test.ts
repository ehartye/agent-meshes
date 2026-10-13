import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeHead, mesh, passingHead } from './helpers/face-glb.ts';

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 20000, windowsHide: true });

it('verify --contract arkit-face/1 prints a JSON report and exits 0 or 1 with a list of failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-cli-')); directories.push(directory);
  const good = join(directory, 'good.glb'), bad = join(directory, 'bad.glb');
  await writeFile(good, encodeHead(passingHead()));
  const broken = passingHead(); mesh(broken, 'teeth_lower').targets = [];
  await writeFile(bad, encodeHead(broken));

  const passed = await cli('verify', good, '--contract', 'arkit-face/1');
  const report = JSON.parse(passed.stdout);
  expect(report).toMatchObject({ ok: true, contract: 'arkit-face/1', failures: [] });
  expect(passed.stderr).toBe('');

  const failure = await cli('verify', bad, '--contract', 'arkit-face/1').then(() => undefined, error => error as { code: number; stdout: string; stderr: string });
  expect(failure?.code).toBe(1);
  expect(JSON.parse(failure!.stdout).ok).toBe(false);
  expect(failure!.stderr).toMatch(/arkit-face\/1: 2 checks failed/);
  expect(failure!.stderr).toMatch(/FAIL teeth: jawOpen lowers the lower teeth/);
  expect(failure!.stderr).toMatch(/FAIL mouth-open: at jawOpen=1 the lower teeth's top still sits 2.00 mm above/);

  // Without --contract, verify keeps its plain glTF validation behavior.
  expect(JSON.parse((await cli('verify', good)).stdout)).toMatchObject({ ok: true, errors: 0 });
  await expect(cli('verify', good, '--contract', 'arkit-face/9')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown contract') });
}, 60000);

it('verify --contract arkit-face/1 --lid-grid judges lid-penetration in the whole blink x squint x wide grid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-face-cli-grid-')); directories.push(directory);
  const good = join(directory, 'good.glb');
  await writeFile(good, encodeHead(passingHead()));
  const contract = JSON.parse((await cli('verify', good, '--contract', 'arkit-face/1')).stdout);
  expect(contract.measurements.eyes.L.penetration).toMatchObject({ mode: 'contract', crossingPoses: 0 });
  const grid = JSON.parse((await run(process.execPath, [resolve('scripts/agent-meshes.mjs'), 'verify', good, '--contract', 'arkit-face/1', '--lid-grid'], { timeout: 120000, windowsHide: true })).stdout);
  expect(grid).toMatchObject({ ok: true });
  expect(grid.measurements.eyes.L.penetration.mode).toBe('grid');
  expect(grid.measurements.eyes.L.penetration.poses).toBeGreaterThan(200);
  // The flag belongs to the contract check.
  await expect(cli('verify', good, '--lid-grid')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--lid-grid') });
}, 180000);
