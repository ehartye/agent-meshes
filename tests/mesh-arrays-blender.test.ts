import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorGLB } from '../src/author.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { blenderIt } from './helpers/blender.ts';

const vertices = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [2, 3, 0]];
const corners = [0, 1, 2, 1, 3, 2];
const uvs = [[.1, .2], [.9, .2], [.1, .8], [.3, .4], [.7, .8], [.2, .9]];
const colors = [[.1, .2, .3, .25], [.3, .4, .5, .5], [.6, .7, .8, .75],
  [.8, .2, .1, 1], [.5, .2, .4, .4], [.2, .8, .6, .6]];

blenderIt('mesh arrays retain native FLOAT_COLOR, UV/color corner seams and opaque RGBA in a normal GLB export', async () => {
  const parent = process.env.AGENT_MESHES_ARRAYS_PROOF || tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'mesh-arrays-'));
  const source = join(directory, 'asset.py'), output = join(directory, 'model.glb');
  let ok = false;
  try {
    await writeFile(source, await readFile(resolve('tests/fixtures/mesh_arrays_asset.py')));
    const result = await authorGLB(source, output, { factoryStartup: true,
      pythonCachePrefix: join(directory, 'fresh-python-cache') });
    const doc = readGLB(await readFile(output));
    const primitive = doc.json.meshes![0].primitives[0];
    const rows = (index: number) => {
      const accessor = readAccessor(doc, index);
      return Array.from({ length: accessor.count }, (_, i) => Array.from(accessor.data.slice(i * accessor.size, (i + 1) * accessor.size)));
    };
    const positions = rows(primitive.attributes.POSITION);
    const decodedUVs = rows(primitive.attributes.TEXCOORD_0);
    const decodedColors = rows(primitive.attributes.COLOR_0);
    const indices = rows(primitive.indices!).map(row => row[0]);
    expect(positions).toHaveLength(6); // Four geometric points, six authored UV/color corners.
    expect(new Set(indices).size).toBe(6);
    expect(readAccessor(doc, primitive.attributes.COLOR_0).size).toBe(4);
    const near = (actual: number[], expected: number[]) => actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) < 2 / 65535);
    const expected = corners.map((vertex, i) => ({ position: vertices[vertex], uv: uvs[i], color: colors[i] }));
    for (const index of indices) {
      expect(expected.some(corner => near(positions[index], corner.position) && near(decodedUVs[index], corner.uv) && near(decodedColors[index], corner.color))).toBe(true);
    }
    for (const corner of expected) {
      expect(indices.some(index => near(positions[index], corner.position) && near(decodedUVs[index], corner.uv) && near(decodedColors[index], corner.color))).toBe(true);
    }
    expect(doc.json.materials![0].alphaMode ?? 'OPAQUE').toBe('OPAQUE');
    const report = JSON.parse(await readFile(source + '.native.json', 'utf8'));
    expect(report).toMatchObject({ nativeColor: { type: 'FLOAT_COLOR', domain: 'CORNER' },
      pointColorPreserved: true, legacyShadingPreserved: true, invalidCases: 9,
      legacyEmptyAndPointOnlyPreserved: true,
      priorScenePreserved: true, selectionPreserved: true });
    await writeFile(join(directory, 'report.json'), JSON.stringify({ ok: true,
      result: { output: result.output, bytes: result.bytes, meshes: result.meshes, blender: result.blender }, native: report,
      positions, colors: decodedColors, uvs: decodedUVs, indices,
      material: doc.json.materials![0], scope: 'Native arrays and GLB data only; no target-engine shader or collision acceptance' }, null, 2) + '\n');
    ok = true;
  } finally {
    if (!ok || process.env.AGENT_MESHES_ARRAYS_PROOF) console.error('Retained mesh-array proof:', directory);
    else await rm(directory, { recursive: true, force: true });
  }
}, 120000);
