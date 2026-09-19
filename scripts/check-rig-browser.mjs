import { chromium } from 'playwright';
import { createServer } from '../src/server.ts';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({ port: 0 }); const browser = await chromium.launch();
try {
  const result = await fetch(`${server.url}/api/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: [
    { op: 'add', part: { name: 'limb', geometry: { type: 'box', size: [0.35, 2, 0.35] }, position: [0, 1, 0] } },
    { op: 'bone.add', bone: { name: 'root_joint' } },
    { op: 'bone.add', bone: { name: 'tip_joint', parent: 'root_joint', position: [0, 1, 0] } },
    { op: 'bind', name: 'limb', binding: { type: 'linear', bones: ['root_joint', 'tip_joint'], axis: 'y', range: [-0.5, 0.5] } },
  ] }) }); assert.equal(result.status, 200);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.locator('.bone-row').filter({ hasText: 'tip_joint' }).click();
  await page.locator('#rz').fill('65'); await page.locator('#apply-pose').click();
  await page.waitForFunction(() => window.meshWorkbench.project.bones[1].pose[2] > 0.5);
  await page.locator('#fit').click(); await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/skinning.png' });
  await page.locator('#part-color').fill('#e3a74f'); await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0].color === '#e3a74f');
  await page.locator('#reset-pose').click(); await page.waitForFunction(() => window.meshWorkbench.project.bones[1].pose[2] === 0);
  assert.deepEqual(errors, []); console.log('PASS: weighted rig browser pose, recolor while bound, reset');
} finally { await browser.close(); await server.close(); }
