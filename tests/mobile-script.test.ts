import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mobilePhysicsScript, viewerScript } from '../src/preview-html.ts';
import type { createHangingMobile, validateMobileSpec } from '../src/physics/mobile.ts';

const run = promisify(execFile), cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('bundles optional offline physics independently of the viewer and runs the embedded WASM', async () => {
  const code = await mobilePhysicsScript(), viewer = await viewerScript();
  expect(code).toMatch(/MobilePhysics\s*=/); expect(code).not.toContain('WebGLRenderer');
  expect(code).toContain('Apache License'); expect(code).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
  expect(viewer).not.toContain('MobilePhysics'); expect(viewer.toLowerCase()).not.toContain('rapier');
  // Run the compiled IIFE in the native WASM realm, as a browser script does.
  const api = new Function(`${code}\nreturn MobilePhysics;`)() as { createHangingMobile: typeof createHangingMobile; validateMobileSpec: typeof validateMobileSpec };
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hanging-mobile.json', import.meta.url), 'utf8'));
  const mobile = await api.createHangingMobile(fixture);
  try { expect(mobile.snapshot().counts).toEqual({ bodies: 14, colliders: 511, joints: 13 }); mobile.setLeafScale('leaf0', 1.65); for (let i = 0; i < 2400; i++) mobile.advance(1 / 120); expect(mobile.snapshot().maxJointGap).toBeLessThan(.004); }
  finally { mobile.dispose(); }
}, 60000);

it('exports the optional runtime through the CLI to a configurable nested output path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-physics-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'lib', 'mobile-physics.js');
  const { stdout } = await run(process.execPath, [resolve('scripts/agent-meshes.mjs'), 'mobile-physics', output], { timeout: 60000, windowsHide: true });
  const result = JSON.parse(stdout), code = await readFile(output, 'utf8');
  expect(result.output).toBe(output); expect(result.bytes).toBe(Buffer.byteLength(code)); expect(code.startsWith('/*! agent-meshes mobile physics')).toBe(true); expect(code).toMatch(/MobilePhysics\s*=/);
}, 90000);
