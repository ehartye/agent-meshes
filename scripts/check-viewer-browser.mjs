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
    const state = await page.evaluate(() => ({ playing: viewer.playing, clips: viewer.clips, bones: viewer.bones.length, parts: viewer.parts.length, version: MeshViewer.version }));
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
        viewer.resetPose(); viewer.play('trot');
        await new Promise(resolve => setTimeout(resolve, 250));
        const played = viewer.screenshot();
        viewer.view('front'); const front = viewer.screenshot();
        return { head, part, color: viewer.getColor(part), pose: viewer.getPose(head), changedByPose: before !== posed, changedByColor: posed !== recolored, changedByPlay: recolored !== played, time: viewer.time, clip: viewer.clip, front };
      });
      assert.equal(result.changedByPose, true, 'posing a bone changes the rendered frame');
      assert.equal(result.changedByColor, true, 'recoloring a part changes the rendered frame');
      assert.equal(result.changedByPlay, true, 'playing a clip changes the rendered frame');
      assert.equal(result.color, '#ff0066');
      assert.deepEqual(result.pose, { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] });
      assert.equal(result.clip, 'trot');
      assert.ok(result.time > 0.1, `playback advanced (${result.time})`);
      await writeFile(join(evidence, 'front.png'), Buffer.from(result.front.split(',')[1], 'base64'));
    }
    await page.screenshot({ path: join(evidence, `${label}.png`) });
    assert.deepEqual(errors, [], `${label}: console errors`);
    await context.close();
  }
  console.log(`Viewer runtime verified. Evidence in ${evidence}`);
} finally {
  await browser.close();
}
