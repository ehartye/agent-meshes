import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { findBlender } from '../src/refine.ts';

const native = findBlender();
const colors = [[.13, .24, .35, .25], [.41, .52, .63, .5], [.69, .71, .83, .75], [.21, .37, .59, 1]];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

(native ? it : it.skip)('normal authored builds preserve selected CORNER RGBA, omit colors with NONE and reject invalid controls safely', async () => {
  const parent = process.env.AGENT_MESHES_VERTEX_PROOF || tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'mesh-vertex-build-'));
  const source = await readFile(resolve('tests/fixtures/vertex_color_build_asset.py'), 'utf8');
  const script = join(directory, 'asset.py'), config = join(directory, 'build.json');
  const output = join(directory, 'generated', 'model.glb');
  const report: Record<string, unknown> = { scope: 'Native normal build() export/accessor/validation/output-protection proof; no visual or engine acceptance', cases: {} };
  let succeeded = false;
  try {
    await writeFile(config, JSON.stringify({ version: 1, blender: { script: 'asset.py' }, output: 'generated' }));
    const run = async (name: string, constants: string) => {
      await writeFile(script, source.replace("EXPORT_VERTEX_COLOR = 'ACTIVE'\nEXPORT_ALL_VERTEX_COLORS = False", constants));
      await buildAsset(config);
      const bytes = await readFile(output), doc = readGLB(bytes);
      const primitive = doc.json.meshes![0].primitives[0];
      (report.cases as Record<string, unknown>)[name] = { sha256: sha256(bytes), attributes: primitive.attributes };
      return { bytes, doc, primitive };
    };
    const active = await run('active', "EXPORT_VERTEX_COLOR = 'ACTIVE'\nEXPORT_ALL_VERTEX_COLORS = False");
    expect(Object.keys(active.primitive.attributes).filter(key => key.startsWith('COLOR_'))).toEqual(['COLOR_0']);
    const decoded = readAccessor(active.doc, active.primitive.attributes.COLOR_0);
    expect(decoded.size).toBe(4);
    const values = Array.from({ length: decoded.count }, (_, index) => Array.from(decoded.data.slice(index * 4, index * 4 + 4)));
    for (const value of values) expect(colors.some(color => color.every((component, index) => Math.abs(component - value[index]) < 2 / 65535))).toBe(true);
    for (const color of colors) expect(values.some(value => color.every((component, index) => Math.abs(component - value[index]) < 2 / 65535))).toBe(true);
    expect(active.doc.json.materials![0].alphaMode ?? 'OPAQUE').toBe('OPAQUE');
    (report.cases as Record<string, unknown>).active = { sha256: sha256(active.bytes), attributes: active.primitive.attributes, colors: values };
    const none = await run('none', "EXPORT_VERTEX_COLOR = 'NONE'\nEXPORT_ALL_VERTEX_COLORS = False");
    expect(Object.keys(none.primitive.attributes).some(key => key.startsWith('COLOR_'))).toBe(false);
    const legacy = await run('omitted', '');
    const explicitDefault = await run('explicit-none', 'EXPORT_VERTEX_COLOR = None\nEXPORT_ALL_VERTEX_COLORS = None');
    expect(explicitDefault.doc.json).toEqual(legacy.doc.json);
    expect(explicitDefault.bytes).toEqual(legacy.bytes);
    for (const [name, constants, expected] of [
      ['invalid-mode', "EXPORT_VERTEX_COLOR = 'active'", /vertex_color must be/],
      ['invalid-all', "EXPORT_ALL_VERTEX_COLORS = 'false'", /all_vertex_colors must be/],
    ] as const) {
      await writeFile(script, source.replace("EXPORT_VERTEX_COLOR = 'ACTIVE'\nEXPORT_ALL_VERTEX_COLORS = False", constants));
      await expect(buildAsset(config)).rejects.toThrow(expected);
      expect(await readFile(output)).toEqual(legacy.bytes);
      (report.cases as Record<string, unknown>)[name] = { rejected: true, previousOutputPreserved: true };
    }
    report.blender = JSON.parse(await readFile(join(directory, 'generated', 'authoring.json'), 'utf8')).blender;
    report.verification = JSON.parse(await readFile(join(directory, 'generated', 'verification.json'), 'utf8'));
    succeeded = true;
  } finally {
    report.ok = succeeded;
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (!succeeded || process.env.AGENT_MESHES_VERTEX_PROOF) console.error('Retained vertex build proof:', directory);
    else await rm(directory, { recursive: true, force: true });
  }
}, 120000);
