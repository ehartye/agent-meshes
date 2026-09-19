import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/server.ts';
import { Workspace } from '../src/workspace.ts';

const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-browser-workspace-'));
const server = await createServer({ port: 0, workspacePath: directory });
const browser = await chromium.launch();
const writer = new Workspace(directory);
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByText('Connected', { exact: true }).waitFor();
  writer.transact(editor => editor.apply({ op: 'add', part: { name: 'externalPart' } }));
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.name === 'externalPart');
  await page.locator('#part-color').fill('#ff0000');
  await page.locator('#part-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.color === '#ff0000');
  assert.equal(writer.read().project.parts[0].color, '#ff0000');
  assert.equal(writer.read().revision, 2);
  await page.reload();
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.color === '#ff0000');
  await page.locator('#undo').click();
  await page.waitForFunction(() => window.meshWorkbench.project.parts[0]?.color === '#64b9c4');
  assert.equal(writer.read().revision, 3);
  assert.deepEqual(errors, []);
  console.log('PASS: external workspace edits reach the browser; browser edits persist before acknowledgement; reload and undo preserve state');
} finally { writer.close(); await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
