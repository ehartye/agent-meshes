import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { verifyUnreal } = vi.hoisted(() => ({ verifyUnreal: vi.fn() }));
vi.mock('../src/unreal.ts', async original => ({ ...(await original<typeof import('../src/unreal.ts')>()), verifyUnreal }));

import { main } from '../src/cli.ts';
import { ARKIT_FACE_REQUIRED_BONES, ARKIT_FACE_REQUIRED_MORPHS } from '../src/arkit-face.ts';

let stdout = '', stderr = '';
beforeEach(() => {
  stdout = ''; stderr = ''; process.exitCode = undefined; verifyUnreal.mockReset();
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
const run = (...args: string[]) => main(['node', 'agent-meshes', 'verify-unreal', ...args]);

it('merges the contract with --expect flags and prints the pretty report', async () => {
  verifyUnreal.mockResolvedValue({ ok: true, failures: [] });
  await run('head.glb', '--contract', 'arkit-face/1', '--expect-morphs', 'tongueOut, jawOpen', '--expect-bones', 'jaw', '--timeout', '90', '--log', 'run.log');
  expect(verifyUnreal).toHaveBeenCalledWith(expect.stringMatching(/head\.glb$/), expect.objectContaining({
    morphs: [...ARKIT_FACE_REQUIRED_MORPHS, 'tongueOut'], bones: [...ARKIT_FACE_REQUIRED_BONES, 'jaw'],
    requireSkeletalMesh: true, singleSkeletalMesh: true, contract: 'arkit-face/1', timeoutMs: 90000, logFile: expect.stringMatching(/run\.log$/), quiet: false,
  }));
  expect(JSON.parse(stdout)).toEqual({ ok: true, failures: [] });
  expect(stdout).toContain('\n  "ok"');
  expect(process.exitCode).toBeUndefined();
});

it('prints one compact JSON line in --json mode and exits non-zero listing failures', async () => {
  verifyUnreal.mockResolvedValue({ ok: false, failures: ['missing bone "eye_R"'] });
  await run('head.glb', '--json');
  expect(verifyUnreal.mock.calls[0][1]).toMatchObject({ morphs: [], bones: [], requireSkeletalMesh: false, singleSkeletalMesh: false, quiet: true });
  expect(stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(stdout).failures).toEqual(['missing bone "eye_R"']);
  expect(process.exitCode).toBe(1);
});

it('requires a SkeletalMesh when only --expect-bones is given', async () => {
  verifyUnreal.mockResolvedValue({ ok: true, failures: [] });
  await run('rig.glb', '--expect-bones', 'hip,knee');
  expect(verifyUnreal.mock.calls[0][1]).toMatchObject({ bones: ['hip', 'knee'], morphs: [], requireSkeletalMesh: true });
});

it('rejects an unknown contract and a bad timeout before starting Unreal', async () => {
  await run('head.glb', '--contract', 'arkit-face/9');
  expect(verifyUnreal).not.toHaveBeenCalled();
  expect(JSON.parse(stderr).error).toMatchObject({ code: 'CLI_ARGUMENT_ERROR', message: expect.stringContaining('Unknown contract "arkit-face/9"') });
  stderr = '';
  await run('head.glb', '--timeout', '0');
  expect(JSON.parse(stderr).error.message).toMatch(/timeout/i);
  expect(verifyUnreal).not.toHaveBeenCalled();
});
