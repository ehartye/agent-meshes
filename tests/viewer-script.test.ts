import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { previewHTML, viewerScript } from '../src/preview-html.ts';
import { viewDirection, viewNames } from '../src/web/viewer.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('names eight camera views, mirrors the opposites, and rejects an unknown name by listing them', () => {
  expect(viewNames).toEqual(['front', 'back', 'left', 'right', 'side', 'top', 'bottom', 'perspective']);
  const unit = (name: string) => viewDirection(name).normalize().toArray().map(v => Math.round(v * 1000) / 1000 || 0);
  expect(unit('front')[2]).toBeGreaterThan(0.9); expect(unit('back')[2]).toBeLessThan(-0.9);
  expect(unit('right')[0]).toBeGreaterThan(0.9); expect(unit('left')[0]).toBeLessThan(-0.9);
  expect(unit('right')).toEqual(unit('side'));
  expect(unit('top')[1]).toBeGreaterThan(0.99); expect(unit('bottom')[1]).toBeLessThan(-0.99);
  // Opposites are exact mirrors, so a back view keeps the same slight downward tilt as the front.
  expect(unit('back')).toEqual(unit('front').map((v, i) => (i === 1 ? v : -v) || 0));
  expect(() => viewDirection('rear')).toThrow(/Unknown view "rear"; use one of front, back, left, right, side, top, bottom, perspective/);
  expect(() => viewDirection('rear')).not.toThrow(TypeError);
});

it('bundles a standalone viewer runtime exposing a global mount function', async () => {
  const code = await viewerScript();
  expect(code.length).toBeGreaterThan(100000);
  expect(code).toMatch(/MeshViewer\s*=/);
  expect(code).toContain('mount');
  expect(code).not.toContain('getElementById("asset")');
  expect(code).not.toContain("getElementById('asset')");
}, 60000);

it('still inlines a working preview page that shares the viewer runtime', async () => {
  const html = await previewHTML('demo', new Uint8Array([1, 2, 3]));
  expect(html).toContain('id="asset"');
  expect(html).toContain('MeshViewer');
}, 60000);

it('writes the runtime to a file through the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-viewer-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'lib', 'mesh-viewer.js');
  const { stdout } = await run(process.execPath, [resolve('scripts/agent-meshes.mjs'), 'viewer', output], { timeout: 60000, windowsHide: true });
  const result = JSON.parse(stdout);
  expect(result.output).toBe(output);
  expect(result.bytes).toBeGreaterThan(100000);
  const code = await readFile(output, 'utf8');
  expect(code.startsWith('/*! agent-meshes viewer')).toBe(true);
  expect(code).toMatch(/MeshViewer\s*=/);
}, 90000);
