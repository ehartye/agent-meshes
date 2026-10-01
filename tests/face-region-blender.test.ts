import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';
import { readGLB, readAccessor } from '../src/gltf-read.ts';
import { verifyGLB } from '../src/export.ts';

(findBlender() ? it : it.skip)('exports authored face ownership through split vertices and morph pruning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-face-region-'));
  try {
    const output = join(dir, 'model.glb');
    await authorGLB(resolve('tests/blender_face_region_fixture.py'), output);
    const bytes = await readFile(output), doc = readGLB(bytes);
    let count = 0;
    for (const mesh of doc.json.meshes!) for (const primitive of mesh.primitives) {
      expect(primitive.attributes._FACE_REGION).toBeDefined();
      const membership = readAccessor(doc, primitive.attributes._FACE_REGION);
      const positions = readAccessor(doc, primitive.attributes.POSITION);
      expect(membership.size).toBe(1);
      expect(membership.count).toBe(positions.count);
      for (let v = 0; v < positions.count; v++) expect(membership.data[v]).toBe(positions.data[v * 3 + 1] > 0.5 ? 1 : 0);
      count += positions.count;
    }
    expect(count).toBeGreaterThan(8);
    expect(doc.json.meshes![0].extras?.targetNames).toEqual(['jawOpen']);
    const validation = await verifyGLB(bytes);
    expect(validation.errors).toBe(0);
    expect(validation.warnings).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120_000);
