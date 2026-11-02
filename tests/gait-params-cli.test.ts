/** @lane merge
 * @subject src/cli.ts
 */
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile), directories: string[] = [];
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 20000, windowsHide: true });
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-gait-params-')); directories.push(directory);
  return { directory, invoke: async (...args: string[]) => JSON.parse((await cli('--workspace', directory, ...args)).stdout) };
}
async function failure(directory: string, ...args: string[]) {
  try { await cli('--workspace', directory, ...args); throw new Error('Expected CLI failure'); }
  catch (error) { expect(error).toMatchObject({ code: 1 }); return JSON.parse((error as { stderr: string }).stderr).error as { code: string; message: string }; }
}

it('tunes a biped walk end to end: recipe, export, then gait reports the effective stride and travel speed', async () => {
  const { directory, invoke } = await setup(), glb = join(directory, 'walk.glb');
  const measure = async (...options: string[]) => {
    await invoke('recipe', 'biped', ...options); await invoke('export', glb);
    return (await invoke('gait', glb, '--clip', 'walk')).metrics.stride as { meters: number; travelSpeed: number };
  };
  const base = await measure();
  const tuned = await measure('--gait-params', '{"walk":{"stride":0.4}}');
  // Stride over stance: the foot travels 0.4 in 0.62 of the cycle.
  expect(tuned.meters).toBeCloseTo(0.4 / 0.62, 2);
  expect(tuned.meters / base.meters).toBeCloseTo(0.4 / 0.52, 2);
  expect(tuned.travelSpeed).toBeCloseTo(0.4 / (0.62 * 1.2), 2);
}, 30000);

it('refuses a bad --gait-params with the setting named, the code reported and the project untouched', async () => {
  const { directory, invoke } = await setup();
  await invoke('recipe', 'biped');
  const before = JSON.stringify(await invoke('state'));
  const cases: [string[], RegExp][] = [
    [['biped', '--gait-params', '{"walk":{"stride":-0.1}}'], /gait-params walk\.stride/],
    [['biped', '--gaits', 'walk,run', '--gait-params', '{"run":{"stride":1.0}}'], /gait-params run\.stride=1.*Unreachable leg target/],
    [['equine', '--gait-params', '{"walk":{"stride":5}}'], /gait-params walk\.stride=5.*Unreachable leg target/],
    [['insectoid', '--gait-params', '{"walk":{"stride":0.4}}'], /--gait-params.*insectoid/],
  ];
  for (const [args, message] of cases) {
    const error = await failure(directory, 'recipe', ...args);
    expect(error.message).toMatch(message);
    expect(JSON.stringify(await invoke('state'))).toBe(before);
  }
  // Unparsable JSON keeps the code the other JSON options report.
  expect((await failure(directory, 'recipe', 'biped', '--gait-params', 'not json')).code).toBe((await failure(directory, 'recipe', 'insectoid', '--leg-phases', 'not json')).code);
}, 60000);

it('lists --gait-params in the recipe help with the four settings', async () => {
  const { stdout } = await cli('recipe', '--help');
  expect(stdout).toContain('--gait-params <json>');
  for (const setting of ['stride', 'lift', 'stance', 'bob']) expect(stdout).toContain(setting);
});
