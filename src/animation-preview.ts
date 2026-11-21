/**
 * Looping GIF previews of FBX animation clips, rendered on a mannequin in headless Chromium.
 * The harness page (`src/web/animation-preview-harness.ts`) is bundled once with `vite build` into an IIFE and cached
 * under `.cache/animation-preview/` beside the package, keyed by a hash of its source and the three.js and Vite versions.
 * The page runs in an offline browser context. Frames come back as PNG screenshots, are snapped to a fixed 16-colour
 * palette from the workbench ink to its stage colour, and are encoded with the in-repo GIF encoder.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build } from 'vite';
import { browserLaunchOptions } from './browser.ts';
import { encodeGif, quantize, type Rgb } from './gif.ts';
import { decodePng } from './png.ts';

const INK: Rgb = [0x21, 0x38, 0x44], LINE: Rgb = [0xd6, 0xe0, 0xe4], STAGE: Rgb = [0xdc, 0xe7, 0xeb];
/** Fourteen even steps from --ink towards --stage, then --line and --stage themselves: darkest first. */
export const PREVIEW_PALETTE: readonly Rgb[] = Object.freeze([
  ...Array.from({ length: 14 }, (_, i) => INK.map((v, c) => Math.round(v + (STAGE[c]! - v) * i / 14)) as unknown as Rgb),
  LINE, STAGE,
]);

export interface PreviewOptions {
  /** Width and height in pixels (default 192). */
  size?: number;
  /** Frames per second before the cap lowers it (default 12). */
  fps?: number;
  /** Most frames in one GIF (default 96). */
  maxFrames?: number;
  /**
   * Longest time one render may take, from opening the page through loading the FBX and capturing every frame
   * (default 60000 ms). Past it the render rejects with code `PREVIEW_TIMEOUT` and its page is discarded.
   */
  timeoutMs?: number;
}

/** The default limit on one render: far above the seconds a 96-frame preview takes, well below a stalled queue. */
export const PREVIEW_TIMEOUT_MS = 60_000;
/** How long discarding a hung page or context may take before the browser itself is closed. */
const DISCARD_MS = 5_000;

export interface PreviewSession {
  /** The browser every render in this session shares. A browser that has gone away is replaced at the next render. */
  readonly browser: Browser;
  /**
   * Render one clip. Renders in one session run one at a time. A render that times out, or whose page crashed, has its
   * page discarded, so the next render starts on a fresh page.
   */
  render(fbxPath: string, options?: PreviewOptions): Promise<{ gif: Uint8Array }>;
  /** Close the browser. */
  close(): Promise<void>;
}

interface HarnessWindow { AnimationPreview: { load(data: string, size: number): { duration: number }; frame(t: number): string } }

const HARNESS = new URL('./web/animation-preview-harness.ts', import.meta.url);
const CACHE = new URL('../.cache/animation-preview/', import.meta.url);
let harnessBundle: Promise<string> | undefined;

/** The harness IIFE: from the on-disk cache when its key matches, otherwise built with Vite and cached. Once per process. */
export function harnessScript(): Promise<string> {
  harnessBundle ??= (async () => {
    // three and Vite are pinned exactly in package.json, so their pins name the code the bundle inlines.
    const { dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const key = createHash('sha256').update(await readFile(HARNESS)).update(`three@${dependencies.three} vite@${dependencies.vite}`).digest('hex').slice(0, 16);
    const cached = new URL(`harness-${key}.js`, CACHE);
    try { return await readFile(cached, 'utf8'); } catch { /* not built yet */ }
    const result = await build({ configFile: false, logLevel: 'error', build: { write: false, lib: { entry: fileURLToPath(HARNESS), formats: ['iife'], name: 'AnimationPreview' }, minify: true } });
    const output = Array.isArray(result) ? result[0] : result;
    const chunk = output && 'output' in output ? output.output.find(item => item.type === 'chunk') : undefined;
    if (!chunk || chunk.type !== 'chunk') throw new Error('The animation preview harness bundle did not produce a script');
    try {
      // Write then rename, so a concurrent process never reads half a file. A read-only install just skips the cache.
      await mkdir(CACHE, { recursive: true });
      const partial = new URL(`harness-${key}.${process.pid}.tmp`, CACHE);
      await writeFile(partial, chunk.code);
      await rename(partial, cached);
      // Bundles of older harness sources are never read again.
      for (const name of await readdir(CACHE)) if (/^harness-[0-9a-f]{16}\.js$/.test(name) && name !== `harness-${key}.js`) await rm(new URL(name, CACHE), { force: true });
    } catch { /* cache is optional */ }
    return chunk.code;
  })();
  harnessBundle.catch(() => { harnessBundle = undefined; });
  return harnessBundle;
}

const FBX_MAGIC = Buffer.from('Kaydara FBX Binary  \0', 'latin1');

function checkOptions({ size = 192, fps = 12, maxFrames = 96, timeoutMs = PREVIEW_TIMEOUT_MS }: PreviewOptions): Required<PreviewOptions> {
  if (!Number.isInteger(size) || size < 8 || size > 2048) throw new Error(`Preview size must be an integer from 8 to 2048 pixels, got ${size}`);
  if (!(fps > 0) || fps > 100) throw new Error(`Preview fps must be above 0 and at most 100, got ${fps}`);
  if (!Number.isInteger(maxFrames) || maxFrames < 2) throw new Error(`Preview maxFrames must be an integer of at least 2, got ${maxFrames}`);
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new Error(`Preview timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`);
  return { size, fps, maxFrames, timeoutMs };
}

/** Settle within `ms`, or resolve false: a step that may itself hang on an unresponsive page. */
const within = (work: Promise<unknown>, ms: number): Promise<boolean> => new Promise(done => {
  const timer = setTimeout(() => done(false), ms);
  work.then(() => true, () => false).then(ok => { clearTimeout(timer); done(ok); });
});

/** Frame count and delay: `fps` over the whole clip, at most `maxFrames` (lowering the rate), at least 2. */
export function previewTiming(duration: number, { fps = 12, maxFrames = 96 }: PreviewOptions = {}): { frames: number; delayCs: number } {
  const frames = Math.max(2, Math.min(maxFrames, Math.ceil(duration * fps - 1e-9)));
  const delayCs = duration > 0 ? Math.max(2, Math.round(100 * duration / frames)) : Math.max(2, Math.round(100 / fps));
  return { frames, delayCs };
}

async function renderOnPage(page: Page, fbxPath: string, options: PreviewOptions): Promise<{ gif: Uint8Array }> {
  const { size, fps, maxFrames } = checkOptions(options);
  const bytes = await readFile(fbxPath);
  if (bytes.length < FBX_MAGIC.length || !bytes.subarray(0, FBX_MAGIC.length).equals(FBX_MAGIC))
    throw Object.assign(new Error(`${fbxPath} is not a binary FBX file`), { code: 'PREVIEW_NOT_FBX' });
  const { duration } = await page.evaluate(({ data, size }) => (window as unknown as HarnessWindow).AnimationPreview.load(data, size), { data: bytes.toString('base64'), size });
  const { frames, delayCs } = previewTiming(duration, { fps, maxFrames });
  const times = Array.from({ length: frames }, (_, i) => duration * i / frames);
  const indices: Uint8Array[] = [];
  for (let at = 0; at < times.length; at += 16) {
    const urls = await page.evaluate(batch => batch.map(t => (window as unknown as HarnessWindow).AnimationPreview.frame(t)), times.slice(at, at + 16));
    for (const url of urls) {
      const image = decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      if (image.width !== size || image.height !== size) throw new Error(`The preview frame is ${image.width} by ${image.height}, not ${size} by ${size}`);
      indices.push(quantize(image.rgba, PREVIEW_PALETTE));
    }
  }
  return { gif: encodeGif(indices, { width: size, height: size, palette: PREVIEW_PALETTE, delayCs, loop: 0, reserveTransparent: true }) };
}

/** Start one offline Chromium page for a batch of previews. Close it when done. */
export async function createPreviewSession(): Promise<PreviewSession> {
  const script = await harnessScript();
  const launch = () => chromium.launch({ headless: true, ...browserLaunchOptions() });
  let browser = await launch();
  let context: BrowserContext | undefined, page: Page | undefined, crashed = false, closed = false;
  const openPage = async () => {
    if (!browser.isConnected()) { browser = await launch(); context = undefined; }
    context ??= await browser.newContext({ offline: true, viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    const next = await context.newPage();
    crashed = false;
    next.on('crash', () => { crashed = true; });
    await next.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><body style="margin:0"><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`, { waitUntil: 'load' });
    if (!await next.evaluate(() => typeof (window as unknown as HarnessWindow).AnimationPreview?.load === 'function')) throw new Error('The animation preview harness did not load');
    return next;
  };
  /** Drop a hung or crashed page: close it, else its context, else the browser, which the next render relaunches. */
  const discard = async (stale: Page | undefined) => {
    page = undefined;
    if (stale && await within(stale.close({ runBeforeUnload: false }), DISCARD_MS)) return;
    const staleContext = context;
    context = undefined;
    if (staleContext && await within(staleContext.close(), DISCARD_MS)) return;
    await within(browser.close(), DISCARD_MS);
  };
  try { page = await openPage(); } catch (error) { await browser.close(); throw error; }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get browser() { return browser; },
    render(fbxPath, options = {}) {
      const run = queue.then(async () => {
        if (closed) throw new Error('The preview session is closed');
        const { timeoutMs } = checkOptions(options);
        let timer: ReturnType<typeof setTimeout> | undefined, current: Page | undefined;
        const work = (async () => {
          if (!page || page.isClosed() || crashed || !browser.isConnected()) { if (page && !page.isClosed()) await discard(page); page = await openPage(); }
          current = page;
          return renderOnPage(current, fbxPath, options);
        })();
        // The abandoned render rejects once its page is closed; nothing is waiting for it then.
        work.catch(() => undefined);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`The preview of ${fbxPath} did not finish within ${timeoutMs} ms, so it was stopped`), { code: 'PREVIEW_TIMEOUT' })), timeoutMs);
        });
        try { return await Promise.race([work, timeout]); }
        catch (error) {
          if ((error as { code?: string }).code === 'PREVIEW_TIMEOUT' || crashed) await discard(current ?? page);
          throw error;
        } finally { clearTimeout(timer); }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    async close() { closed = true; await queue; await browser.close(); },
  };
}

/** Render one FBX clip as a looping GIF preview. With a `session` it renders in that browser; otherwise it starts and closes its own. */
export async function renderClipPreview(fbxPath: string, options: PreviewOptions & { session?: PreviewSession } = {}): Promise<{ gif: Uint8Array }> {
  const { session, ...rest } = options;
  checkOptions(rest);
  if (session) return session.render(fbxPath, rest);
  const own = await createPreviewSession();
  try { return await own.render(fbxPath, rest); } finally { await own.close(); }
}
