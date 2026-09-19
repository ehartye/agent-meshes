import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AnimationMixer, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { chromium } from 'playwright';
import { creatureKinds, creatureInfo } from '../src/recipes/index.ts';
import { validateProject } from '../src/core/model.ts';
import { verifyGLB } from '../src/export.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const gallery = resolve(repository, 'artifacts/creatures');
const evidence = resolve(repository, 'artifacts/creature-check');
await mkdir(evidence, { recursive: true });
const results = [];
const browser = await chromium.launch();
const context = await browser.newContext({ offline: true, viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
try {
  for (const kind of creatureKinds) {
    const directory = join(gallery, kind);
    const project = validateProject(JSON.parse(await readFile(join(directory, 'project.mesh.json'), 'utf8')));
    const source = validateProject(JSON.parse(await readFile(resolve(repository, 'artifacts/creature-sources', kind, 'source.mesh.json'), 'utf8')));
    assert.deepEqual(project, source, `${kind}: saved editable source differs from built project`);
    const bytes = new Uint8Array(await readFile(join(directory, 'model.glb')));
    const verification = await verifyGLB(bytes);
    assert.equal(verification.errors, 0, `${kind}: invalid GLB`);
    assert.equal(verification.warnings, 0, `${kind}: GLB warnings`);
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
    const skins = [], bones = [];
    gltf.scene.traverse(object => { if (object instanceof SkinnedMesh) skins.push(object); if (object.isBone) bones.push(object); });
    assert.equal(skins.length, project.parts.filter(part => part.binding).length);
    assert.equal(bones.length, project.bones.length);
    assert.equal(bones.filter(bone => /^leg_.*_hip$/.test(bone.name)).length, creatureInfo[kind].legs);
    assert.deepEqual(gltf.animations.map(clip => clip.name), project.clips.map(clip => clip.name));
    const weighted = skins.filter(mesh => { const weights = mesh.geometry.getAttribute('skinWeight'); return Array.from({ length: weights.count }, (_, i) => i).some(i => weights.getX(i) > 0 && weights.getY(i) > 0); });
    if (kind === 'biped' || kind === 'quadruped') assert.ok(weighted.length > 0, `${kind}: expected weighted surfaces`);
    const vertex = (mesh, i) => mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), i)).applyMatrix4(mesh.matrixWorld);
    const clips = [];
    for (const clip of gltf.animations) {
      const mixer = new AnimationMixer(gltf.scene); mixer.clipAction(clip).play();
      const seek = time => { mixer.setTime(time); gltf.scene.updateMatrixWorld(true); };
      seek(0);
      const initial = skins.map(mesh => vertex(mesh, 0));
      const initialBones = bones.map(bone => [...bone.position, ...bone.quaternion]);
      const shape = weighted.map(mesh => Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, i) => vertex(mesh, i).distanceTo(vertex(mesh, 0))));
      let maxMotion = 0, maxShapeChange = 0, maxBoneChange = 0;
      for (const phase of [0.13, 0.3, 0.52, 0.76]) {
        seek(clip.duration * phase);
        skins.forEach((mesh, i) => { maxMotion = Math.max(maxMotion, vertex(mesh, 0).distanceTo(initial[i])); });
        bones.forEach((bone, i) => { [...bone.position, ...bone.quaternion].forEach((value, j) => { maxBoneChange = Math.max(maxBoneChange, Math.abs(value - initialBones[i][j])); }); });
        weighted.forEach((mesh, m) => { shape[m].forEach((distance, i) => { maxShapeChange = Math.max(maxShapeChange, Math.abs(vertex(mesh, i).distanceTo(vertex(mesh, 0)) - distance)); }); });
      }
      assert.ok(maxMotion > 0.05, `${kind}/${clip.name}: vertices do not move`);
      assert.ok(maxBoneChange > 0.03, `${kind}/${clip.name}: rig does not move`);
      if (weighted.length) assert.ok(maxShapeChange > 0.001, `${kind}/${clip.name}: weighted surfaces do not deform`);
      seek(clip.duration * (1 - 1e-6));
      const loopError = Math.max(...skins.map((mesh, i) => vertex(mesh, 0).distanceTo(initial[i])));
      assert.ok(loopError < 0.0001, `${kind}/${clip.name}: discontinuous loop (${loopError})`);
      clips.push({ name: clip.name, duration: clip.duration, maxMotion, maxBoneChange, maxShapeChange, loopError });
      mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
    }

    const page = await context.newPage();
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.goto(pathToFileURL(join(directory, 'preview.html')).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.meshPreview, undefined, { timeout: 15000 });
    const browserFrame = await page.evaluate(() => {
      const preview = window.meshPreview; preview.setPlaying(false); preview.seek(0);
      const meshes = []; preview.gltf.scene.traverse(object => { if (object.isSkinnedMesh) meshes.push(object); });
      const vertex = mesh => mesh.getVertexPosition(0, mesh.position.clone()).applyMatrix4(mesh.matrixWorld);
      const start = meshes.map(vertex);
      preview.renderer.render(preview.scene, preview.camera);
      const firstFrame = preview.renderer.domElement.toDataURL();
      preview.seek(preview.gltf.animations[0].duration * 0.3);
      preview.renderer.render(preview.scene, preview.camera);
      return { motion: Math.max(...meshes.map((mesh, i) => vertex(mesh).distanceTo(start[i]))), changed: preview.renderer.domElement.toDataURL() !== firstFrame };
    });
    assert.ok(browserFrame.motion > 0.05, `${kind}: browser model did not move`);
    assert.equal(browserFrame.changed, true, `${kind}: rendered animation frame did not change`);
    await page.screenshot({ path: join(evidence, `${kind}-preview.png`) });
    const beforePlayback = await page.evaluate(() => {
      const preview = window.meshPreview; preview.seek(0); preview.setPlaying(true);
      const values = []; preview.gltf.scene.traverse(object => { if (object.isBone) values.push(...object.quaternion); }); return values;
    });
    await page.waitForTimeout(180);
    const playbackMotion = await page.evaluate(before => {
      const preview = window.meshPreview; preview.setPlaying(false);
      const values = []; preview.gltf.scene.traverse(object => { if (object.isBone) values.push(...object.quaternion); });
      return Math.max(...values.map((value, i) => Math.abs(value - before[i])));
    }, beforePlayback);
    assert.ok(playbackMotion > 0.01, `${kind}: playback clock did not advance the rig`);
    assert.deepEqual(errors, [], `${kind}: browser errors`);
    assert.deepEqual(network, [], `${kind}: offline preview made network requests`);
    await page.close();
    const result = { kind, name: project.name, ok: true, errors: verification.errors, warnings: verification.warnings, skins: skins.length, bones: bones.length, weightedMeshes: weighted.length, clips, browserMotion: browserFrame.motion, renderedFrameChanged: browserFrame.changed, playbackMotion, screenshot: `${kind}-preview.png` };
    results.push(result); console.log(`${kind}: ${skins.length} skins, ${bones.length} bones, ${clips.length} clips; validated and replayed offline`);
  }
  const page = await context.newPage();
  await page.goto(pathToFileURL(join(gallery, 'index.html')).href);
  assert.equal(await page.evaluate(() => [...document.images].every(image => image.complete && image.naturalWidth > 0)), true, 'Gallery images did not load');
  const galleryURL = new URL('.', pathToFileURL(join(gallery, 'index.html'))).href;
  for (const href of await page.locator('a').evaluateAll(links => links.map(link => link.href))) {
    assert.ok(href.startsWith(galleryURL), 'Gallery links must remain inside the portable gallery directory');
    await access(fileURLToPath(href));
  }
  await page.screenshot({ path: join(evidence, 'gallery-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Gallery overflows mobile viewport');
  await page.screenshot({ path: join(evidence, 'gallery-mobile.png'), fullPage: true });
  await page.close();
  await writeFile(join(evidence, 'verification.json'), `${JSON.stringify({ ok: true, creatures: results }, null, 2)}\n`);
  console.log(`PASS: all four creatures. Evidence → ${evidence}`);
} catch (error) {
  await writeFile(join(evidence, 'verification.json'), `${JSON.stringify({ ok: false, error: String(error), creatures: results }, null, 2)}\n`);
  throw error;
} finally { await context.close(); await browser.close(); }
