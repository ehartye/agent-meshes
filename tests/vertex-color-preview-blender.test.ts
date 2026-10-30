import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { blender, blenderGate } from './helpers/blender.ts';
import { parsePreviewOptions, previewJob } from '../src/preview.ts';

it('passes explicit vertex shading through preview settings and worker jobs', () => {
  const settings = parsePreviewOptions({ shading: 'color,vertex', views: 'body-front' });
  expect(settings.shadings).toEqual(['color', 'vertex']);
  expect(previewJob('asset.py', 'out', settings).shadings).toEqual(['color', 'vertex']);
  expect(parsePreviewOptions({ shading: 'all' }).shadings).toContain('vertex');
});

blenderGate(!blender?.detached)('renders active POINT/CORNER RGB and exported colors without altering material or layer selection', async () => {
  const parent = process.env.AGENT_MESHES_VERTEX_PREVIEW_PROOF || tmpdir();
  await mkdir(parent, { recursive: true });
  const out = await mkdtemp(join(parent, 'mesh-vertex-preview-'));
  let succeeded = false;
  try {
    const result = spawnSync(blender!.command, ['--background', '--factory-startup', '--python-exit-code', '1', '--python',
      resolve('tests/blender_vertex_color_preview.py'), '--', '--output-dir', out], {
      encoding: 'utf8', windowsHide: true, timeout: 120000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const proof = JSON.parse(await readFile(join(out, 'proof.json'), 'utf8'));
    expect(proof).toMatchObject({ ok: true, cases: { POINT: { sourceGreen: true, exportedGreen: true }, CORNER: { sourceGreen: true, exportedGreen: true } } });
    succeeded = true;
  } finally {
    if (!succeeded || process.env.AGENT_MESHES_VERTEX_PREVIEW_PROOF) console.error('Retained vertex preview proof:', out);
    else await rm(out, { recursive: true, force: true });
  }
}, 120000);
