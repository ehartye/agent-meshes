import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
const server = await createServer({ port: 0 }); const browser = await chromium.launch();
try {
  const project = JSON.parse(await readFile('artifacts/animated-check/source.json', 'utf8'));
  await fetch(`${server.url}/api/project`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) });
  const page = await browser.newPage(); await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.meshWorkbench?.project.clips.length === 1);
  await page.locator('#time-scrub').fill('0.25');
  const visible = await page.evaluate(() => window.meshWorkbench.root.getObjectByName('bend_joint').quaternion.z);
  assert.ok(visible > 0.2);
  await page.locator('#record-key').click();
  await page.waitForFunction(() => window.meshWorkbench.project.clips[0].tracks[0].keys.some(key => key.time === 0.25));
  const saved = await page.evaluate(() => window.meshWorkbench.project.clips[0].tracks[0].keys.find(key => key.time === 0.25).value[2]);
  assert.ok(Math.abs(saved - visible) < 0.00001, `Visible ${visible}, recorded ${saved}`);
  const afterKey = await page.evaluate(() => window.meshWorkbench.root.getObjectByName('bend_joint').quaternion.z);
  assert.ok(Math.abs(afterKey - visible) < 0.00001, 'Recording a key changed the visible pose');
  await page.locator('#time-scrub').fill('0.5');
  await page.locator('.bone-row').filter({ hasText: 'root_joint' }).click();
  await page.locator('#rx').fill('15'); await page.locator('#apply-pose').click();
  await page.waitForFunction(() => window.meshWorkbench.project.bones[0].pose[0] > 0.1);
  const retained = await page.evaluate(() => window.meshWorkbench.root.getObjectByName('bend_joint').quaternion.z);
  assert.ok(Math.abs(retained - 0.5) < 0.00001, 'Editing one joint lost the visible pose on another joint');
  await page.evaluate(async () => {
    await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'clip.set', clip: { name: 'short', duration: 0.0505, tracks: [{ bone: 'bend_joint', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 0.0505, value: [0, 0, 0, 1] }] }] } }) });
  });
  await page.waitForFunction(() => window.meshWorkbench.project.clips.length === 2);
  await page.evaluate(() => window.meshWorkbench.animation.seek(0.0505, 'short'));
  await page.locator('#record-key').click();
  await page.waitForFunction(() => window.meshWorkbench.project.clips.find(c => c.name === 'short').tracks.length > 1);
  assert.ok(await page.evaluate(() => window.meshWorkbench.project.clips.find(c => c.name === 'short').tracks.every(t => t.keys.at(-1).time === 0.0505)));
  console.log('PASS: key visible scrubbed pose, retain other joints during pose edit');
} finally { await browser.close(); await server.close(); }
