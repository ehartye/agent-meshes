import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const { buildAsset, previewHTML, decoratorFor } = vi.hoisted(() => ({ buildAsset: vi.fn(), previewHTML: vi.fn(), decoratorFor: vi.fn() }));
vi.mock('../src/build.ts', () => ({ buildAsset }));
vi.mock('../src/preview-html.ts', () => ({ previewHTML }));
vi.mock('../src/capture.ts', () => ({ decoratorFor }));
const directories: string[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  buildAsset.mockReset().mockResolvedValue({ output: 'generated', files: [] });
  previewHTML.mockReset().mockResolvedValue('<html>actual GLB preview</html>');
  decoratorFor.mockReset().mockImplementation(flags => flags.preview ? vi.fn() : undefined);
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('build CLI previews authored GLBs through the asset decorator', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'mesh-author-cli-')); directories.push(stage);
  const bytes = Buffer.from('test model'); await writeFile(join(stage, 'model.glb'), bytes);
  await main(['node', 'agent-meshes', 'build', 'build.json']);
  const options = buildAsset.mock.calls[0][1];
  expect(typeof options.decorateAsset).toBe('function');
  expect(await options.decorateAsset({ name: 'Bird' }, stage)).toEqual(['preview.html']);
  expect(previewHTML).toHaveBeenCalledWith('Bird', bytes);
  expect(await readFile(join(stage, 'preview.html'), 'utf8')).toContain('actual GLB preview');
});

it('build CLI omits authored preview for both suppression flags and all decorators for no-preview', async () => {
  await main(['node', 'agent-meshes', 'build', 'build.json', '--no-preview']);
  expect(buildAsset.mock.calls[0][1]).toMatchObject({ decorate: undefined, decorateAsset: undefined });
  await main(['node', 'agent-meshes', 'build', 'build.json', '--no-preview-page']);
  expect(buildAsset.mock.calls[1][1].decorateAsset).toBeUndefined();
  expect(typeof buildAsset.mock.calls[1][1].decorate).toBe('function');
  expect(previewHTML).not.toHaveBeenCalled();
});
