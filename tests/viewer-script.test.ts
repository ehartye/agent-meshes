import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { previewHTML, viewerScript } from '../src/preview-html.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

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
