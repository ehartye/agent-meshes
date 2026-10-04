import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { findBlender } from '../src/refine.ts';

// Real Blender only: CI skips this. The Windows Store launcher exits before the script finishes, so it is skipped too.
const blender = findBlender();
const maybe = blender && !blender.detached ? it : it.skip;

maybe('agent_meshes_props self-test: lathe cost, oriented ellipsoids, metaball units, boolean cleanup and the static GLB export flags', () => {
  const run = spawnSync(blender!.command, ['-b', '--python', resolve('scripts/blender_lib/agent_meshes_props.py'), '--', '--self-test'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  const line = (run.stdout ?? '').split(/\r?\n/).find(l => l.startsWith('AGENT_MESHES_PROPS_SELFTEST '));
  expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
  const report = JSON.parse(line!.slice('AGENT_MESHES_PROPS_SELFTEST '.length));
  expect(report.error).toBeUndefined();
  expect(report.ok).toBe(true);
  expect(report.glb.materials).toEqual(['Ivory']);
  expect(report.glb.attributes).not.toContain('COLOR_0');
}, 200000);
