import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from './refine.ts';

/**
 * `agent-meshes preview`: Workbench renders of a Blender-authored source from fixed cameras, inside one Blender run
 * (no GLB export, no browser), for fast iteration. Matcap and zebra show surface flaws, wire shows edge flow, cavity
 * shows creases, color shows paint. Named poses set shape-key weights. An optional persistent worker keeps one
 * headless Blender alive and runs each job dropped in its queue folder, skipping Blender's startup.
 */
export const PREVIEW_VIEWS = Object.freeze(['front', 'q34', 'side', 'below', 'above', 'close', 'eyes', 'mouth', 'mouth-q34', 'back', 'body-front', 'body-q34', 'body-side', 'body-back'] as const);
export const PREVIEW_SHADINGS = Object.freeze(['matcap', 'wire', 'cavity', 'zebra', 'color'] as const);
const VIEW_ALIASES: Record<string, string[]> = {
  head: ['front', 'q34', 'side', 'below', 'close'],
  body: ['body-front', 'body-q34', 'body-side', 'body-back'],
};
export const DEFAULT_PREVIEW_QUEUE = join(tmpdir(), 'agent-meshes-preview-worker');
/** A worker whose heartbeat is older than this is gone. */
const HEARTBEAT_SECONDS = 10;

export interface PreviewPose { name: string; shapes: Record<string, number>; phase?: number }
export interface PreviewSettings {
  views: string[]; shadings: string[]; poses: PreviewPose[]; size: number; sheet: boolean; rest: boolean; hide: string[]; target: string | null; clip: string | null;
}
export interface PreviewRawOptions {
  views?: string; shading?: string; shape?: string; pose?: string[]; size?: string | number; sheet?: boolean; rest?: boolean; hide?: string; target?: string; clip?: string; phases?: string | number;
}
export interface PreviewManifest { files: string[]; sheet?: string | null; seconds?: number; blender?: string; worker: boolean; outDir: string; [key: string]: unknown }

const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'CLI_ARGUMENT_ERROR' }); };
const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
const unique = (items: string[], label: string) => {
  const seen = new Set<string>();
  for (const item of items) { if (seen.has(item)) fail(`${label} ${item} is listed twice`); seen.add(item); }
  return items;
};

/** `key=weight,key=weight` with weights in 0..1. */
export function parseShapes(value: string): Record<string, number> {
  const shapes: Record<string, number> = {};
  for (const pair of list(value)) {
    const match = /^([A-Za-z_][\w.]*)=(.+)$/.exec(pair);
    if (!match) fail(`Shape weight must be key=weight, got ${JSON.stringify(pair)}`);
    const [, key, raw] = match!;
    const weight = Number(raw);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) fail(`Shape weight for ${key} must be a number in 0..1, got ${raw}`);
    if (key in shapes) fail(`Shape ${key} is listed twice`);
    shapes[key] = weight;
  }
  return shapes;
}

export function parsePreviewOptions(raw: PreviewRawOptions): PreviewSettings {
  const views = unique((raw.views ? list(raw.views) : ['front', 'q34', 'side']).flatMap(view => VIEW_ALIASES[view] ?? [view]), 'View');
  for (const view of views) if (!(PREVIEW_VIEWS as readonly string[]).includes(view)) fail(`Unknown view ${view}; choose from ${[...PREVIEW_VIEWS, ...Object.keys(VIEW_ALIASES)].join(', ')}`);
  const shadings = unique(raw.shading === 'all' ? [...PREVIEW_SHADINGS] : raw.shading ? list(raw.shading) : ['matcap'], 'Shading');
  for (const shading of shadings) if (!(PREVIEW_SHADINGS as readonly string[]).includes(shading)) fail(`Unknown shading ${shading}; choose from ${PREVIEW_SHADINGS.join(', ')}, all`);
  const common = raw.shape ? parseShapes(raw.shape) : {};
  if (raw.clip !== undefined) {
    // A clip: one posed render per evenly spaced phase (shape keys from --shape apply to every phase).
    if (!/^[A-Za-z0-9_.-]+$/.test(raw.clip)) fail(`Clip name must be letters, digits, _, . or -, got ${JSON.stringify(raw.clip)}`);
    if (raw.pose?.length) fail('--pose and --clip are exclusive: a clip renders its own phases (use --shape for shape keys)');
    const phases = raw.phases === undefined ? 8 : Number(raw.phases);
    if (!Number.isInteger(phases) || phases < 1 || phases > 64) fail(`Clip phases must be an integer from 1 to 64, got ${raw.phases}`);
    const size = raw.size === undefined ? 512 : Number(raw.size);
    if (!Number.isInteger(size) || size < 64 || size > 4096) fail(`Preview size must be an integer from 64 to 4096 pixels, got ${raw.size}`);
    const clipPoses = Array.from({ length: phases }, (_, k) => ({ name: `${raw.clip}-p${k}`, shapes: { ...common }, phase: k / phases }));
    return { views, shadings, poses: clipPoses, size, sheet: Boolean(raw.sheet), rest: false, hide: raw.hide ? list(raw.hide) : [], target: raw.target ?? null, clip: raw.clip };
  }
  const poses = (raw.pose?.length ? raw.pose : ['rest']).map(spec => {
    const colon = spec.indexOf(':');
    const name = colon < 0 ? spec : spec.slice(0, colon);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`Pose name must be letters, digits, _ or -, got ${JSON.stringify(name)}`);
    return { name, shapes: { ...common, ...(colon < 0 ? {} : parseShapes(spec.slice(colon + 1))) } };
  });
  unique(poses.map(pose => pose.name), 'Pose');
  const size = raw.size === undefined ? 512 : Number(raw.size);
  if (!Number.isInteger(size) || size < 64 || size > 4096) fail(`Preview size must be an integer from 64 to 4096 pixels, got ${raw.size}`);
  return { views, shadings, poses, size, sheet: Boolean(raw.sheet), rest: raw.rest ?? true, hide: raw.hide ? list(raw.hide) : [], target: raw.target ?? null, clip: null };
}

/** The files a preview writes into its output folder, in render order (pose, then view, then shading), then the sheet. */
export function previewFiles(settings: PreviewSettings): string[] {
  const files = settings.poses.flatMap(pose => settings.views.flatMap(view => settings.shadings.map(shading => `${pose.name}-${view}-${shading}.png`)));
  return settings.sheet ? [...files, 'sheet.png'] : files;
}

export function previewJob(source: string, outDir: string, settings: PreviewSettings) {
  return { source, outDir, views: settings.views, shadings: settings.shadings, poses: settings.poses, size: settings.size, sheet: settings.sheet, rest: settings.rest, hide: settings.hide, target: settings.target, clip: settings.clip };
}

/** A Blender build.json's script, or a .py source itself. */
export async function resolvePreviewSource(input: string): Promise<string> {
  const path = resolve(input);
  await stat(path);
  if (['.py', '.glb', '.gltf'].includes(extname(path).toLowerCase())) return path;
  const config = JSON.parse(await readFile(path, 'utf8')) as { blender?: { script?: unknown } };
  if (typeof config?.blender?.script !== 'string') fail(`${input} is not a Blender build.json (no blender.script), a .py source or a .glb/.gltf`);
  const script = resolve(dirname(path), config.blender!.script as string);
  await stat(script);
  return script;
}

export async function workerAlive(queue = DEFAULT_PREVIEW_QUEUE): Promise<boolean> {
  try {
    const beat = JSON.parse(await readFile(join(queue, 'worker.json'), 'utf8')) as { time?: number };
    return typeof beat.time === 'number' && Date.now() / 1000 - beat.time < HEARTBEAT_SECONDS;
  } catch { return false; }
}

const script = () => fileURLToPath(new URL('../scripts/blender-preview.py', import.meta.url));
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

async function waitForFile(path: string, deadline: number, alive?: () => Promise<boolean>): Promise<{ ok: boolean; manifest?: PreviewManifest; error?: string }> {
  let checked = Date.now();
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (alive && Date.now() - checked > 5000) { checked = Date.now(); if (!await alive()) throw new Error('The preview worker stopped before finishing the job'); }
    await wait(50);
  }
  throw new Error(`Preview did not finish within the timeout (${path})`);
}

export interface RunPreviewOptions { outDir?: string; queue?: string; useWorker?: boolean; timeoutMs?: number }

/** Render a preview: through a live worker when one is running (unless useWorker is false), else in a fresh Blender. */
export async function runPreview(input: string, settings: PreviewSettings, options: RunPreviewOptions = {}): Promise<PreviewManifest> {
  const source = await realpath(await resolvePreviewSource(input));
  const outDir = resolve(options.outDir ?? join(dirname(source), 'preview'));
  await mkdir(outDir, { recursive: true });
  const queue = resolve(options.queue ?? DEFAULT_PREVIEW_QUEUE);
  const job = previewJob(source, outDir, settings);
  const deadline = Date.now() + (options.timeoutMs ?? 600000);
  if (options.useWorker !== false && await workerAlive(queue)) {
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const done = join(queue, `${id}.done.json`);
    const temporary = join(queue, `${id}.tmp`);
    await writeFile(temporary, JSON.stringify(job));
    await (await import('node:fs/promises')).rename(temporary, join(queue, `${id}.job.json`));
    try {
      const result = await waitForFile(done, deadline, () => workerAlive(queue));
      if (!result.ok) throw new Error(`Preview failed in the worker:\n${result.error}`);
      return { ...result.manifest!, worker: true, outDir };
    } finally { await rm(done, { force: true }); }
  }
  const blender = findBlender();
  if (!blender) throw new Error('Blender is not installed. Set AGENT_MESHES_BLENDER to its executable for previews.');
  const jobFile = join(outDir, '.preview-job.json'), done = `${jobFile}.done`;
  await Promise.all([done, `${jobFile}.pid`].map(path => rm(path, { force: true })));
  await writeFile(jobFile, JSON.stringify(job));
  const child = spawn(blender.command, ['-b', '--python-exit-code', '1', '--python', script(), '--', jobFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '', exitCode: number | undefined;
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-4000); });
  child.once('close', code => { exitCode = code ?? -1; });
  try {
    while (Date.now() < deadline) {
      let result: { ok: boolean; manifest?: PreviewManifest; error?: string } | undefined;
      try { result = JSON.parse(await readFile(done, 'utf8')); } catch { /* not yet */ }
      if (result) {
        if (!result.ok) throw new Error(`Preview failed in Blender:\n${result.error}\n${log}`);
        return { ...result.manifest!, worker: false, outDir };
      }
      if (!blender.detached && exitCode !== undefined) {
        await wait(100);
        try { result = JSON.parse(await readFile(done, 'utf8')); } catch { /* none */ }
        if (!result) throw new Error(`Blender exited (${exitCode}) without finishing the preview\n${log}`);
        continue;
      }
      await wait(50);
    }
    throw new Error(`Preview timed out\n${log}`);
  } finally {
    if (exitCode === undefined && !blender.detached) child.kill('SIGKILL');
    await Promise.all([jobFile, done, `${jobFile}.pid`].map(path => rm(path, { force: true })));
  }
}

/** Start a persistent headless Blender that runs preview jobs from `queue`; resolves once its heartbeat appears. */
export async function startPreviewWorker(queue = DEFAULT_PREVIEW_QUEUE, timeoutMs = 120000): Promise<{ queue: string; pid: number; started: boolean }> {
  queue = resolve(queue);
  await mkdir(queue, { recursive: true });
  const read = async () => JSON.parse(await readFile(join(queue, 'worker.json'), 'utf8')) as { pid: number };
  if (await workerAlive(queue)) return { queue, pid: (await read()).pid, started: false };
  const blender = findBlender();
  if (!blender) throw new Error('Blender is not installed. Set AGENT_MESHES_BLENDER to its executable for previews.');
  await rm(join(queue, 'stop'), { force: true });
  const child = spawn(blender.command, ['-b', '--python', script(), '--', '--worker', queue], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await workerAlive(queue)) return { queue, pid: (await read()).pid, started: true };
    await wait(100);
  }
  throw new Error('The preview worker did not start in time');
}

/** Ask the worker on `queue` to stop after its current job. */
export async function stopPreviewWorker(queue = DEFAULT_PREVIEW_QUEUE): Promise<{ queue: string; stopping: boolean }> {
  queue = resolve(queue);
  if (!await workerAlive(queue)) return { queue, stopping: false };
  await writeFile(join(queue, 'stop'), '');
  return { queue, stopping: true };
}
