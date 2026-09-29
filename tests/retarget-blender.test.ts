import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';

const realBlender = findBlender() ? it : it.skip;
for (const [fixture, description] of [
  ['import_rest', 'reference import resets an animated GLB to rest while retaining playable clips'],
  ['regions', 'limb isolation excludes remote spine weights and keeps normalized skin weights'],
  ['neutral', 'neutral calibration preserves the reference articulation of unconfigured descendants'],
]) realBlender(description, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-retarget-'));
  try {
    const result = await authorGLB(resolve(`tests/fixtures/retarget/${fixture}.py`), join(dir, 'model.glb'));
    expect(result.meshes).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120000);
