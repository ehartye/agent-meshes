import { expect, it } from 'vitest';
import { NativeBuildSession } from '../src/build-session.ts';

it('captures each resource once and validates its saved identity before sharing', async () => {
  const session = new NativeBuildSession(); let captures = 0, valid = true, checks = 0;
  const capture = async () => ({ value: ++captures });
  const validate = async () => { checks++; if (!valid) throw new Error('changed'); };
  expect(await session.get('blenderRuntime', '/blender', capture, validate)).toEqual({ value: 1 });
  expect(await session.get('blenderRuntime', '/blender', capture, validate)).toEqual({ value: 1 });
  expect(captures).toBe(1); expect(checks).toBeGreaterThan(0);
  valid = false;
  await expect(session.get('blenderRuntime', '/blender', capture, validate)).rejects.toThrow(/BUILD_SESSION_CHANGED/);
  valid = true;
  await expect(session.get('blenderRuntime', '/blender', capture, validate)).rejects.toThrow(/BUILD_SESSION_CHANGED/);
});

it('refuses further use after close and releases snapshots', async () => {
  const session = new NativeBuildSession();
  await session.get('helperToolchain', '/helpers', async () => 'bytes', async () => {});
  session.close();
  await expect(session.get('helperToolchain', '/helpers', async () => 'other', async () => {})).rejects.toThrow(/BUILD_SESSION_CLOSED/);
  expect(session.stats().captures).toEqual({ helperToolchain: 1 });
});
