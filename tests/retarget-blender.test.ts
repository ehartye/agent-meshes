import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';

const realBlender = findBlender() ? it : it.skip;
for (const [fixture, description] of [
  ['import_rest', 'reference import resets an animated GLB to rest while retaining playable clips'],
  ['regions', 'limb isolation excludes remote spine weights and keeps normalized skin weights'],
  ['neutral', 'neutral calibration preserves the reference articulation of unconfigured descendants'],
  ['weight_limits', 'an anatomical weight limit keeps collarbone motion out of the chin with a blended boundary'],
]) realBlender(description, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-retarget-'));
  try {
    const result = await authorGLB(resolve(`tests/fixtures/retarget/${fixture}.py`), join(dir, 'model.glb'));
    expect(result.meshes).toBe(1);
    if (fixture === 'weight_limits') {
      const bytes = new Uint8Array(await readFile(join(dir, 'model.glb')));
      const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
      let checked = 0;
      gltf.scene.traverse(object => {
        if (!(object instanceof SkinnedMesh)) return;
        const p = object.geometry.getAttribute('position');
        const indices = object.geometry.getAttribute('skinIndex'), weights = object.geometry.getAttribute('skinWeight');
        for (let i = 0; i < p.count; i++) {
          if (Math.abs(p.getX(i) - .02) > 1e-5 || Math.abs(p.getY(i) - 1.04) > 1e-5) continue;
          const skin = Object.fromEntries([0, 1, 2, 3].map(k => [object.skeleton.bones[indices.getComponent(i, k)]!.name, weights.getComponent(i, k)]));
          expect(skin.head).toBeCloseTo(.2, 5);
          expect(Object.values(skin).reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5);
          checked++;
        }
      });
      expect(checked).toBeGreaterThan(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120000);
