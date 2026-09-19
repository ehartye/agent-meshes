import { chromium } from 'playwright';
import { createServer } from '../src/server.ts';
import { creatureKinds, creatureInfo } from '../src/recipes/index.ts';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({ port: 0 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.getByText('Connected', { exact: true }).waitFor();
  await mkdir('artifacts/creature-check', { recursive: true });
  for (const kind of creatureKinds) {
    await page.locator(`[data-recipe="${kind}"]`).click();
    await page.waitForFunction(name => window.meshWorkbench.project.name === name, creatureInfo[kind].name);
    await page.getByRole('button', { name: 'Pause animation', exact: true }).waitFor();
    const clips = await page.evaluate(() => window.meshWorkbench.project.clips.map(clip => ({ name: clip.name, duration: clip.duration })));
    assert.deepEqual(await page.locator('#clip-select option').evaluateAll(options => options.map(option => option.value)), clips.map(clip => clip.name));
    for (const clip of clips) {
      await page.locator('#clip-select').selectOption(clip.name);
      assert.equal(Number(await page.locator('#time-scrub').getAttribute('max')), clip.duration);
      await page.evaluate(() => window.meshWorkbench.animation.play(true));
      const firstTime = await page.evaluate(() => window.meshWorkbench.animation.time);
      await page.waitForFunction(time => window.meshWorkbench.animation.time !== time, firstTime);
      const changed = await page.evaluate(duration => {
        const w = window.meshWorkbench; w.animation.play(false); w.animation.seek(0); w.renderFrame();
        const start = w.renderer.domElement.toDataURL();
        w.animation.seek(duration * 0.24); w.renderFrame();
        return w.renderer.domElement.toDataURL() !== start;
      }, clip.duration);
      assert.equal(changed, true, `${kind}/${clip.name}: selected clip did not change rendered frame`);
      await page.screenshot({ path: `artifacts/creature-check/${kind}-${clip.name}-workbench.png` });
      if (clip === clips[0]) await page.screenshot({ path: `artifacts/creature-check/${kind}-workbench.png` });
    }
    assert.equal(await page.locator('#show-bones').isChecked(), false);
    const info = await page.evaluate(() => ({ parts: window.meshWorkbench.project.parts.length, bones: window.meshWorkbench.project.bones.length, clips: window.meshWorkbench.project.clips.length }));
    console.log(JSON.stringify({ kind, ...info }));
  }
  await page.locator('#undo').click();
  await page.waitForFunction(() => window.meshWorkbench.project.name === 'Jade scarab');
  await page.locator('#redo').click();
  await page.waitForFunction(() => window.meshWorkbench.project.name === 'Indigo weaver');
  await page.locator('#show-bones').check();
  await page.screenshot({ path: 'artifacts/creature-check/arachnid-rig.png' });
  assert.deepEqual(errors, []);
  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  await reduced.goto(server.url, { waitUntil: 'domcontentloaded' });
  await reduced.locator('[data-recipe="biped"]').click();
  await reduced.waitForFunction(() => window.meshWorkbench.project.name === 'Copper courier');
  await reduced.getByRole('button', { name: 'Play animation', exact: true }).waitFor();
  console.log('PASS: all recipe selectors and clips load and animate; loading is undoable; reduced motion starts paused');
} finally { await browser.close(); await server.close(); }
