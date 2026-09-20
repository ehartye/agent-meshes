import { chromium } from 'playwright';
import { createServer } from '../src/server.ts';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({ port: 0 });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.locator('#add-part').click();
  await page.waitForFunction(() => window.meshWorkbench.project.parts.length === 1);
  assert.equal(await page.locator('#part-form').evaluate(form => form.checkValidity()), true);
  await page.locator('#py').fill('1.5'); await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.position[1] === 1.5);
  await page.locator('#undo').click(); await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.position[1] === 0.5);
  await page.locator('#redo').click(); await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.position[1] === 1.5);
  await page.locator('#fit').click();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/foundation.png' });
  await page.locator('#sx').fill('200'); await page.locator('#sy').fill('200'); await page.locator('#sz').fill('200');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.geometry.size[0] === 200);
  await page.locator('#fit').click();
  assert.ok(await page.evaluate(() => window.meshWorkbench.camera.position.length() > 300));
  // Metal parts reflect the room environment; without it a chrome part renders black in build captures.
  assert.equal(await page.evaluate(() => !!window.meshWorkbench.scene.environment), true, 'the workbench scene has environment lighting');
  assert.deepEqual(errors, []);
  console.log('PASS: browser add/edit/undo/redo, valid form defaults, large-model framing');
} finally { await browser.close(); server.server.closeAllConnections(); await server.close(); }
