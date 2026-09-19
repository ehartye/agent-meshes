import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createProject, applyOperation } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';
import { decorateBuild, captureProject } from '../src/capture.ts';
const directory = resolve('artifacts/animated-check'); await mkdir(directory, { recursive: true });
let project = createProject('Motion-study');
for (const operation of [
  { op: 'bone.add', bone: { name: 'root_joint' } },
  { op: 'bone.add', bone: { name: 'bend_joint', parent: 'root_joint', position: [0, 1, 0] } },
  { op: 'add', part: { name: 'limb', geometry: { type: 'box', size: [0.4, 2, 0.4] }, position: [0, 1, 0], color: '#dcab55' } },
  { op: 'bind', name: 'limb', binding: { type: 'linear', bones: ['root_joint', 'bend_joint'], axis: 'y', range: [-0.5, 0.5] } },
  { op: 'clip.set', clip: { name: 'sway', duration: 2, tracks: [{ bone: 'bend_joint', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0, 0, 0.5, Math.sqrt(0.75)] }, { time: 1, value: [0, 0, 0, 1] }, { time: 1.5, value: [0, 0, -0.5, Math.sqrt(0.75)] }, { time: 2, value: [0, 0, 0, 1] }] }] } },
]) project = applyOperation(project, operation);
project.bones[0].pose = [0, Math.sin(0.3), 0, Math.cos(0.3)];
await writeFile(join(directory, 'source.json'), JSON.stringify(project));
await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, project: 'source.json', output: 'dist' }));
const result = await buildAsset(join(directory, 'build.json'), { decorate: decorateBuild });
assert.ok(result.files.includes('sway-contact.png')); assert.ok(result.files.includes('preview.html'));
assert.equal(JSON.parse(await readFile(join(result.output, 'verification.json'), 'utf8')).ok, true);
assert.equal(JSON.parse(await readFile(join(result.output, 'verification.json'), 'utf8')).warnings, 0);
const neutral = structuredClone(project); for (const bone of neutral.bones) bone.pose = [0, 0, 0, 1];
await captureProject(neutral, join(directory, 'reference-views'));
assert.deepEqual(await readFile(join(result.output, 'front.png')), await readFile(join(directory, 'reference-views/front.png')), 'Build capture must use the exported rest pose');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(join(result.output, 'preview.html')).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.meshPreview);
  const change = await page.evaluate(() => {
    const p = window.meshPreview; p.setPlaying(false); p.seek(0);
    const bone = p.gltf.scene.getObjectByName('bend_joint'); const initial = bone.quaternion.z;
    p.seek(0.5); return Math.abs(bone.quaternion.z - initial);
  });
  assert.ok(change > 0.4); assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'preview.png') });
  console.log(JSON.stringify({ ok: true, files: result.files, loadedGLBAnimationDelta: change }));
} finally { await browser.close(); }
