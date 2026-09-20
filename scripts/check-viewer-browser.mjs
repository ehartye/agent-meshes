// Exercises the standalone viewer runtime in Chromium: mount from base64, pose, recolor, play,
// reduced-motion start state and screenshots. Writes evidence under artifacts/viewer-check.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createCreature } from '../src/recipes/index.ts';
import { exportGLB } from '../src/export.ts';
import { viewerScript } from '../src/preview-html.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(repository, 'artifacts/viewer-check');
await mkdir(evidence, { recursive: true });
const runtime = join(evidence, 'mesh-viewer.js');
await writeFile(runtime, await viewerScript());
const glb = Buffer.from(await exportGLB(createCreature('vulpine'))).toString('base64');
const page_ = join(evidence, 'harness.html');
await writeFile(page_, `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage{width:800px;height:500px}</style>
<div id="stage"></div><script id="glb" type="text/plain">${glb}</script><script src="mesh-viewer.js"></script>
<script>window.ready = MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: '#f4efe6' }).then(v => (window.viewer = v));</script></html>`);

const browser = await chromium.launch();
try {
  for (const [label, reducedMotion] of [['default', 'no-preference'], ['reduced', 'reduce']]) {
    const context = await browser.newContext({ offline: true, viewport: { width: 800, height: 500 }, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(pathToFileURL(page_).href, { waitUntil: 'load' });
    await page.evaluate(() => window.ready);
    const state = await page.evaluate(() => ({ playing: viewer.playing, clips: viewer.clips, bones: viewer.bones.length, parts: viewer.parts.length, version: MeshViewer.version, environment: !!viewer.scene.environment, outlines: viewer.scene.children.filter(o => o.userData.outline).length }));
    assert.equal(state.environment, true, `${label}: the scene has environment lighting`);
    assert.equal(state.outlines, 0, `${label}: no outline meshes unless asked`);
    assert.equal(state.playing, reducedMotion === 'no-preference', `${label}: autoplay should follow reduced-motion preference`);
    assert.deepEqual(state.clips, ['walk', 'trot']);
    assert.ok(state.bones > 10 && state.parts > 5, `${label}: puppet lists bones and parts`);
    if (label === 'default') {
      const result = await page.evaluate(async () => {
        viewer.pause(); viewer.seek(0);
        const before = viewer.screenshot();
        const head = viewer.bones.find(name => /head/.test(name)) ?? viewer.bones[0];
        viewer.setPose(head, { rotation: [0, 60, 0] });
        const posed = viewer.screenshot();
        const part = viewer.parts[0]; viewer.setColor(part, '#ff0066');
        const recolored = viewer.screenshot();
        const matte = viewer.getMaterial(part); viewer.setMaterial(part, { metalness: 1, roughness: 0.1 });
        const chromed = viewer.screenshot();
        viewer.resetPose(); viewer.play('trot');
        await new Promise(resolve => setTimeout(resolve, 250));
        const played = viewer.screenshot();
        viewer.view('front'); const front = viewer.screenshot(), time = viewer.time, clip = viewer.clip;
        // Every named view moves the camera somewhere different; an unknown name is a plain Error that lists them.
        const views = {}; for (const name of ['front', 'back', 'left', 'right', 'side', 'top', 'bottom', 'perspective']) { viewer.view(name); views[name] = viewer.camera.position.toArray().map(v => Math.round(v * 100) / 100); }
        let rejected = null; try { viewer.view('rear'); } catch (error) { rejected = { type: error.constructor.name, message: error.message }; }
        viewer.view('front');
        // Patterns re-bake in place: dots change the frame, null restores the flat part's look, getPattern reports.
        viewer.pause(); viewer.seek(0);
        const plain = viewer.screenshot(); viewer.setPattern(part, { type: 'dots', color: '#ffffff', size: 0.05 });
        const dotted = viewer.screenshot(), pattern = viewer.getPattern(part); viewer.setPattern(part, null);
        const restored = viewer.screenshot(); viewer.play('trot');
        return { head, part, color: viewer.getColor(part), matte, material: viewer.getMaterial(part), pose: viewer.getPose(head), changedByPose: before !== posed, changedByColor: posed !== recolored, changedByMaterial: recolored !== chromed, changedByPlay: chromed !== played, time, clip, front, changedByPattern: plain !== dotted, restoredByNull: restored === plain, pattern, cleared: viewer.getPattern(part), views, rejected };
      });
      assert.equal(result.changedByPose, true, 'posing a bone changes the rendered frame');
      assert.equal(result.changedByColor, true, 'recoloring a part changes the rendered frame');
      assert.equal(result.changedByMaterial, true, 'switching a part to chrome changes the rendered frame');
      assert.equal(result.changedByPlay, true, 'playing a clip changes the rendered frame');
      assert.equal(result.changedByPattern, true, 'painting dots on a part changes the rendered frame');
      assert.equal(result.restoredByNull, true, 'clearing the pattern restores the frame');
      assert.deepEqual(result.pattern, { type: 'dots', color: '#ffffff', size: 0.05 });
      assert.equal(result.cleared, null);
      assert.equal(result.color, '#ff0066');
      assert.deepEqual(result.matte, { metalness: 0.08, roughness: 0.65 });
      assert.deepEqual(result.material, { metalness: 1, roughness: 0.1 });
      assert.deepEqual(result.pose, { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] });
      assert.equal(result.clip, 'trot');
      assert.ok(result.time > 0.1, `playback advanced (${result.time})`);
      const { views } = result;
      assert.deepEqual(views.side, views.right, 'side is the right view');
      assert.ok(views.back[2] < 0 && views.front[2] > 0 && views.left[0] < 0 && views.right[0] > 0, `back, front, left and right face the model from their own sides: ${JSON.stringify(views)}`);
      assert.ok(views.bottom[1] < views.top[1] && views.bottom[1] < 0, `bottom looks up from below the floor: ${JSON.stringify(views)}`);
      assert.equal(new Set(Object.values(views).filter((p, i, all) => all.indexOf(p) === i).map(p => p.join())).size, 7, 'seven distinct camera positions for eight names');
      assert.equal(result.rejected?.type, 'Error', `unknown view is a plain Error: ${JSON.stringify(result.rejected)}`);
      assert.match(result.rejected?.message ?? '', /Unknown view "rear"; use one of front, back, left, right, side, top, bottom, perspective/);
      await writeFile(join(evidence, 'front.png'), Buffer.from(result.front.split(',')[1], 'base64'));
      // Ink outlines: an inverted hull per mesh, following the same skeleton.
      const outlined = await page.evaluate(async () => {
        viewer.dispose();
        const v = await MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: '#f4efe6', outline: 0.02, autoplay: false });
        const hulls = []; v.scene.traverse(o => { if (o.userData.outline) hulls.push(o); });
        const skinned = hulls.filter(h => h.isSkinnedMesh).length;
        const before = v.screenshot(); v.setPose(v.bones[0], { rotation: [0, 40, 0] }); const after = v.screenshot();
        v.setMaterial(v.parts[0], { metalness: 1, roughness: 0.1 });
        const hull = hulls.find(h => h.name === `${v.parts[0]}_outline`);
        window.viewer = v; return { hulls: hulls.length, skinned, parts: v.parts.length, moved: before !== after, color: hulls[0] && hulls[0].material.color.getHexString(), hullMaterial: hull && hull.material.type, hullMetalness: hull && hull.material.metalness };
      });
      assert.equal(outlined.hulls, outlined.parts, 'one outline hull per visible part');
      assert.ok(outlined.skinned > 0, 'skinned parts get skinned hulls');
      assert.equal(outlined.moved, true, 'outlined puppet still poses');
      assert.equal(outlined.color, '111111');
      assert.equal(outlined.hullMaterial, 'MeshBasicMaterial', 'setMaterial leaves the outline hull ink alone');
      assert.equal(outlined.hullMetalness, undefined, 'setMaterial does not write metalness onto the hull');
      await page.screenshot({ path: join(evidence, 'outline.png') });
    }
    await page.screenshot({ path: join(evidence, `${label}.png`) });
    assert.deepEqual(errors, [], `${label}: console errors`);
    await context.close();
  }
  console.log(`Viewer runtime verified. Evidence in ${evidence}`);
} finally {
  await browser.close();
}
