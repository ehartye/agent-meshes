import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { previewHTML, viewerScript } from '../src/preview-html.ts';
import { viewDirection, viewNames } from '../src/web/viewer.ts';
import type { createSweep } from '../src/render/sweep.ts';
import type { createPlanarFigure, planarFigureProfile } from '../src/render/planar-figure.ts';
import type { createPlanarLinkage } from '../src/mechanisms/planar-linkage.ts';
import type { createBeltDrive } from '../src/mechanisms/belt-drive.ts';

const run = promisify(execFile);
let bundled: Promise<string> | null = null;
const bundle = () => (bundled ??= viewerScript());
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
  const code = await bundle();
  expect(code.length).toBeGreaterThan(100000);
  expect(code).toMatch(/MeshViewer\s*=/);
  expect(code).toContain('mount');
  expect(code).not.toContain('getElementById("asset")');
  expect(code).not.toContain("getElementById('asset')");
  const scope = {} as { MeshViewer: { createSweep: typeof createSweep; createCarver: unknown; createPlanarFigure: typeof createPlanarFigure; planarFigureProfile: typeof planarFigureProfile; createPlanarLinkage: typeof createPlanarLinkage; createBeltDrive: typeof createBeltDrive } };
  runInNewContext(code,scope);
  expect(typeof scope.MeshViewer.createCarver).toBe('function');
  const belt=scope.MeshViewer.createBeltDrive({driver:{center:[0,0],radius:.2},driven:{center:[1,0],radius:.4}});
  expect(belt.sample(4).drivenAngle).toBe(2);expect(belt.point(0).point).toEqual(belt.point(belt.length).point);
  const linkage = scope.MeshViewer.createPlanarLinkage({ fixed: { O: [0, 0] }, crank: { name: 'C', center: 'O', radius: 2 }, joints: [] });
  expect(linkage.sample(Math.PI / 2).points.C[1]).toBe(2);
  const sweep = scope.MeshViewer.createSweep({ centers:[[0,0,0],[0,0,1]], radii:[.1,.1] });
  expect(sweep.length).toBe(1); expect(sweep.samplePath(.5).position[2]).toBe(.5);
  sweep.update({centers:[[0,0,0],[0,0,2]],radii:[.1,.2]}); expect(sweep.length).toBe(2); sweep.dispose();
  // The existing offline global contains the pure figure API without creating a viewer/DOM.
  const figure=scope.MeshViewer.createPlanarFigure(), initial=figure.snapshot();
  expect(scope.MeshViewer.planarFigureProfile.name).toBe('dance-v1');
  const changed=figure.setTargets({leftHand:[-128,-70]});
  expect(changed.points.length).toBe(420); expect(changed.points).not.toEqual(initial.points);
  expect(()=>figure.setTargets({leftHand:[NaN,0]})).toThrow(); expect(figure.snapshot()).toBe(changed);
  expect(figure.reset()).toBe(initial);
}, 60000);

it('exposes the multi-model stage and ID-render helpers on the global', async () => {
  const scope = {} as { MeshViewer: { mountStage: unknown; countColors(image: { width: number; height: number; data: Uint8ClampedArray }): Record<string, number> } };
  runInNewContext(await bundle(), scope);
  expect(typeof scope.MeshViewer.mountStage).toBe('function');
  expect(scope.MeshViewer.countColors({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) })).toEqual({ '#010203': 1 });
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
