import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetFixture } from './fixtures/budget-glb.ts';

const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 15000, windowsHide: true });

it('prints opt-in UEFN geometry warnings and exits successfully for a structurally valid GLB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-budget-cli-')); directories.push(directory);
  const file = join(directory, 'asset.glb'); await writeFile(file, budgetFixture());
  const result = await cli('verify', file, '--target', 'uefn', '--render-vertex-budget', '5');
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true,
    geometryBudget: { target: 'uefn', renderVertexBudget: 5, warnings: [{ code: 'RENDER_VERTEX_BUDGET_EXCEEDED' }] } });
}, 30000); // Fresh Windows Node processes can exceed Vitest's five-second default.

it('rejects a budget without a target before trying to open a GLB', async () => {
  await expect(cli('verify', 'missing.glb', '--render-vertex-budget', '30000')).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('--render-vertex-budget requires --target uefn') });
}, 30000);

it('rejects unsupported targets and fractional budgets', async () => {
  await expect(cli('verify', 'missing.glb', '--target', 'unknown')).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('--target must be uefn') });
  await expect(cli('verify', 'missing.glb', '--target', 'uefn', '--render-vertex-budget', '1.5')).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('positive safe integer') });
}, 30000);
