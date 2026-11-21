/** @lane merge
 * @subject src/web/animations.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { createAnimationServer, type AnimationServer } from '../src/animation-server.ts';
import { browserLaunchOptions } from '../src/browser.ts';
import { animatedFbx } from './helpers/animated-fbx.ts';

/** A 1 x 1 GIF89a, as a stub renderer returns. */
const TINY_GIF = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
const stubRender = async () => ({ gif: new Uint8Array(TINY_GIF) });

let browser: Browser, server: AnimationServer, page: Page, library: string;
const folders: string[] = [];
const temp = async (label: string) => { const path = await mkdtemp(join(tmpdir(), `mesh-anim-ui-${label}-`)); folders.push(path); return path; };
const sidecar = async (id: string) => JSON.parse(await readFile(join(library, `mixamo/clips/${id}.json`), 'utf8'));
const until = async (check: () => Promise<boolean>, ms = 10000) => {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(done => setTimeout(done, 50)); }
};

beforeAll(async () => {
  // The page is the second entry of the project's Vite build, served by the animations server from dist-web.
  await build({ configFile: resolve('vite.config.ts'), logLevel: 'error' });
  expect(existsSync(resolve('dist-web/animations.html'))).toBe(true);
  library = await temp('lib');
  const home = await temp('home'), downloads = await temp('dl');
  await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 1 }));
  await writeFile(join(downloads, 'Idle.fbx'), animatedFbx());
  const env = { ...process.env, AGENT_MESHES_HOME: home, AGENT_MESHES_MIXAMO_DIR: library };
  server = await createAnimationServer({ port: 0, library, downloads, env, render: stubRender });
  browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.setDefaultTimeout(10000);
  await page.goto(server.url);
}, 180000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

const cards = () => page.locator('[data-card]');
const card = (id: string) => page.locator(`[data-card="${id}"]`);

describe('the animations page', () => {
  it('imports two Downloads, showing a result row and a new card for each', async () => {
    await page.getByRole('checkbox', { name: 'Walk.fbx' }).check();
    await page.getByRole('checkbox', { name: 'Idle.fbx' }).check();
    await page.getByRole('button', { name: 'Import selected' }).click();
    const rows = page.locator('[data-import-row]');
    await expect.poll(() => rows.count()).toBe(2);
    await expect.poll(() => page.locator('[data-import-row][data-status="imported"]').count(), { timeout: 15000 }).toBe(2);
    await page.getByRole('tab', { name: 'Library' }).click();
    await expect.poll(() => cards().count()).toBe(2);
    expect((await cards().evaluateAll(items => items.map(item => item.getAttribute('data-card')))).sort()).toEqual(['idle', 'walk']);
  });

  it('shift-selects both cards and adds a tag to both sidecars', async () => {
    const [first, second] = await cards().evaluateAll(items => items.map(item => item.getAttribute('data-card')!));
    await card(first!).click();
    await card(second!).click({ modifiers: ['Shift'] });
    await expect.poll(() => page.locator('[data-card][aria-selected="true"]').count()).toBe(2);
    const input = page.getByLabel('Add tags');
    await input.fill('ronin');
    await input.press('Enter');
    await until(async () => (await sidecar('walk')).tags.includes('ronin') && (await sidecar('idle')).tags.includes('ronin'));
  });

  it('edits one card title in the sidecar, keeping its id', async () => {
    await card('walk').click();
    await expect.poll(() => page.locator('[data-card][aria-selected="true"]').count()).toBe(1);
    const title = page.getByLabel('Title');
    await title.fill('Ronin stride');
    await title.press('Enter');
    await until(async () => (await sidecar('walk')).title === 'Ronin stride');
    expect((await sidecar('walk')).id).toBe('walk');
    expect(existsSync(join(library, 'mixamo/clips/walk.json'))).toBe(true);
    await expect.poll(() => card('walk').textContent()).toContain('Ronin stride');
  });

  it('copies the selection as a move set under the heading it asks for', async () => {
    const order = await cards().evaluateAll(items => items.map(item => item.getAttribute('data-card')!));
    await card(order[0]!).click();
    await card(order[1]!).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Copy move set' }).click();
    const name = page.getByLabel('Heading');
    expect(await name.inputValue()).toBe('Move set');
    await name.fill('Ronin');
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__lastCopied)).toBe('string');
    const text: string = await page.evaluate(() => (window as any).__lastCopied);

    const bullet = async (id: string) => {
      const meta = await sidecar(id);
      const motion = meta.motion.inPlace ? 'in place' : `root motion, travels ${meta.motion.travelMeters.toFixed(1)} m`;
      return `- ${meta.title} (\`${id}\`): ${meta.note ? `${meta.note}. ` : ''}${meta.tags.join(', ')}. ${meta.motion.seconds.toFixed(1)} s, ${motion}.`;
    };
    const expected = [
      '## Ronin',
      "Mixamo clips from the agent-meshes animation library. Load each by id with `agent_meshes_mixamo.import_fbx('<id>')`, or get its path with `node <runtime>/scripts/mixamo-library.mjs path <id>`.",
      ...await Promise.all(order.map(bullet)),
    ].join('\n');
    expect(text.startsWith('## Ronin')).toBe(true);
    expect(text.trimEnd()).toBe(expected);
    expect(text.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
    expect(text).toContain('(`walk`): ');
    expect(text).toContain('ronin');
    expect(text).toMatch(/root motion, travels 1\.0 m\./);
    expect(text).toMatch(/in place\./);
  });
});
