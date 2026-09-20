import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from './server.ts';
import type { Project } from './core/types.ts';
import { previewHTML } from './preview-html.ts';

/** Render through the same browser adapter as the editing workbench. */
export async function captureProject(project: Project, directory: string): Promise<string[]> {
  if (!project.parts.some(part => part.geometry.type !== 'group')) throw new Error('Add mesh geometry before rendering views');
  await mkdir(directory, { recursive: true });
  const server = await createServer({ port: 0 });
  let browser;
  try {
    const response = await fetch(`${server.url}/api/project`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) });
    if (!response.ok) throw new Error(`Capture project rejected: ${await response.text()}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 }, deviceScaleFactor: 1 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).meshWorkbench?.project.parts.length, undefined, { timeout: 15000 });
    await page.addStyleTag({ content: '.masthead,.library,.inspector,.stage-toolbar,.timeline,.statusbar,.stage-caption{display:none!important}.workbench{display:block;height:100vh}.stage-section{height:100vh}#viewport{height:100vh}' });
    await page.evaluate(() => { const input = document.getElementById('show-bones') as HTMLInputElement; input.checked = false; input.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(100);
    const files: string[] = [];
    for (const view of ['front', 'side', 'perspective']) {
      await page.evaluate(view => { const w = (window as any).meshWorkbench; w.animation.play(false); w.animation.seek(0); w.setCamera(view); w.renderFrame(); }, view);
      const filename = `${view}.png`; await page.locator('#viewport canvas').screenshot({ path: join(directory, filename) }); files.push(filename);
    }
    for (const clip of project.clips) {
      const frames: string[] = [];
      for (let i = 0; i < 8; i++) {
        frames.push(await page.evaluate(({ time, name }) => { const w = (window as any).meshWorkbench; w.animation.seek(time, name); w.renderFrame(); return w.renderer.domElement.toDataURL('image/png'); }, { time: clip.duration * i / 8, name: clip.name }));
      }
      const sheet = await page.evaluate(async ({ frames, label }) => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#f3f6f7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < frames.length; i++) {
          const img = new Image(); img.src = frames[i]; await img.decode();
          const x = (i % 4) * 320, y = Math.floor(i / 4) * 360;
          const height = 320 * img.height / img.width;
          ctx.drawImage(img, x, y + (320 - height) / 2, 320, height); ctx.fillStyle = '#213844'; ctx.font = '13px sans-serif'; ctx.fillText(`${label} · ${i + 1}/8`, x + 12, y + 343);
        }
        return canvas.toDataURL('image/png');
      }, { frames, label: clip.name });
      const filename = `${clip.name}-contact.png`; await writeFile(join(directory, filename), Buffer.from(sheet.split(',')[1], 'base64')); files.push(filename);
    }
    if (errors.length) throw new Error(`Capture renderer: ${errors.join('; ')}`);
    return files;
  } finally { await browser?.close(); await server.close(); }
}
/** Which decorator a build uses: nothing without a browser, renders only, or renders plus preview.html. */
export function decoratorFor(flags: { preview: boolean; previewPage: boolean }): ((project: Project, directory: string) => Promise<string[]>) | undefined {
  if (!flags.preview) return undefined;
  return flags.previewPage ? decorateBuild : captureProject;
}
export async function decorateBuild(project: Project, directory: string): Promise<string[]> {
  const exported = structuredClone(project);
  for (const bone of exported.bones) bone.pose = [0, 0, 0, 1];
  const files = await captureProject(exported, directory);
  const glb = await readFile(join(directory, 'model.glb'));
  await writeFile(join(directory, 'preview.html'), await previewHTML(project.name, glb));
  return [...files, 'preview.html'];
}
