import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { findBlender } from '../src/refine.ts';
import { auditGlass } from '../src/gltf-materials.ts';
import { unrealAvailable, verifyUnreal } from '../src/unreal.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function built() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-glass-')); directories.push(directory);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'glass_helmet', blender: { script: resolve('tests/fixtures/glass/glass_helmet.py') }, output: 'generated' }));
  const result = await buildAsset(config);
  return { output: result.output, glb: join(result.output, 'model.glb') };
}

// Real Blender only: CI skips this, like the refine stage.
const maybe = findBlender() ? it : it.skip;
maybe('material(opacity=..., transmission=..., ior=...) exports glTF glass that validates with no warnings', async () => {
  const { output, glb } = await built();
  const verification = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(verification.issues.numErrors).toBe(0);
  expect(verification.issues.numWarnings).toBe(0);
  const glass = auditGlass(await readFile(glb));
  expect(glass.map(g => [g.name, g.alphaMode, Number(g.opacity.toFixed(2)), g.transmission, g.doubleSided])).toEqual([
    ['visor-glass', 'BLEND', 0.2, 0, true],
    ['lens-glass', 'OPAQUE', 1, 1, true],
  ]);
  expect(glass[1].ior).toBeCloseTo(1.45);
  // The bubble's extras.encloses survives Blender's exporter, and the build checks it at every pose.
  expect(verification.enclosures.ok).toBe(true);
  expect(verification.enclosures.enclosures[0]).toMatchObject({ enclosure: 'bubble', parts: ['head'], ok: true });
  expect(verification.enclosures.enclosures[0].closest.clearance).toBeGreaterThan(0.05);
  expect(verification.enclosures.enclosures[0].closest.clearance).toBeLessThan(0.06);
}, 240000);

const both = findBlender() && unrealAvailable() && !process.env.AGENT_MESHES_SKIP_UNREAL ? it : it.skip;
both('Blender glass imports into Unreal translucent (verify-unreal)', async () => {
  const { glb } = await built();
  const report = await verifyUnreal(glb, { morphs: [], bones: ['head'], requireSkeletalMesh: true, quiet: true });
  expect(report.failures).toEqual([]);
  expect(report.glass?.map(g => [g.material, g.blendMode, g.ok])).toEqual([
    ['visor-glass', 'BLEND_TRANSLUCENT', true],
    ['lens-glass', 'BLEND_TRANSLUCENT', true],
  ]);
}, 1800000);
