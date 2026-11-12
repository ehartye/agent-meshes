import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { browserLaunchOptions } from './browser.ts';
import { errorDetails } from './errors.ts';
import type { SpriteManifest } from './sprite-atlas.ts';
import { bakeFingerprint, bakeSprites, manifestFingerprint, parseBakeOptions, pluginVersion, type BakeOptions, type BakeResult, type BakeSettings } from './sprite-bake.ts';

/**
 * Bake a list of models in one process and one browser: `bake-batch <list.json>`.
 *
 * The list is `{ "version": 1, "defaults": { ... }, "bakes": [ { "glb": "...", "clip": "...", ... } ] }`. Every entry is one
 * `bake`: it takes the same options under the names of `BakeOptions` (`pixelsPerMetre`, `contactSheet`, `yaws` and so on),
 * `defaults` fills in what an entry leaves out, and an entry sets an option to `null` to drop a default. `glb`, `out` and
 * `palette` are paths from the folder of the list file. Each entry writes exactly the files `bake` writes for the same
 * model and options, byte for byte, as soon as it finishes.
 *
 * Every entry's options are checked before the browser starts, and a fault in any of them refuses the whole list with
 * nothing baked. After that the entries run in order and one that fails (a missing GLB or clip, a clipped cell) is
 * recorded and the rest still run.
 *
 * An entry is skipped when its output folder already holds this bake: the manifest there was written by this version for
 * a model with the same SHA-256 and the same options, and `sheet.png` and `atlas.json` still have the hashes it records
 * (with `contactSheet` or `viewer`, that file must also be there). So a run that was stopped part way is resumed by running
 * the same command again, and a run with nothing to do never starts the browser. `force` bakes every entry.
 */
export const BAKE_LIST_VERSION = 1;
export const BAKE_LIST_LIMIT = 1000;
const OPTION_KEYS = ['clip', 'directions', 'phases', 'cell', 'palette', 'outline', 'look', 'bands', 'anchor', 'pixelsPerMetre', 'elevation', 'azimuth', 'yaws', 'oblique', 'contactSheet', 'viewer'] as const;
const ENTRY_KEYS: readonly string[] = ['glb', 'out', ...OPTION_KEYS];

export type BakeBatchStatus = 'baked' | 'skipped' | 'failed';
export interface BakeBatchEntry {
  /** Position in `bakes`, from 0. */
  index: number;
  /** Absolute paths of the model and of the output folder. */
  glb: string; clip: string; output: string;
  status: BakeBatchStatus;
  /** Wall time of this entry in milliseconds, the check for a finished bake included. */
  ms: number;
  /** Set for `baked` and `skipped`. */
  sheetSha256?: string; atlasSha256?: string;
  /** Set for `baked`. */
  files?: BakeResult['files']; size?: BakeResult['size']; frames?: number;
  /** Set for `failed`. */
  error?: ReturnType<typeof errorDetails>;
}
export interface BakeBatchResult { ok: boolean; list: string; total: number; baked: number; skipped: number; failed: number; ms: number; bakes: BakeBatchEntry[] }
export interface BakeBatchOptions {
  /** Bake every entry, whether or not its output is already there. */
  force?: boolean;
  /** Called after each entry, in order, with the entries finished so far and the total. */
  onEntry?: (entry: BakeBatchEntry, done: number, total: number) => void;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fault = (message: string, errorCode = 'BAKE_LIST_INVALID') => Object.assign(new Error(message), { code: errorCode });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exists = (path: string) => access(path).then(() => true, () => false);

interface Planned { index: number; glb: string; output: string; options: BakeOptions; settings: BakeSettings }

/** Read and check a list file: the shape, every path and every entry's options. Nothing is rendered. Raises `BAKE_LIST_INVALID` and `CLI_ARGUMENT_ERROR`. */
export async function readBakeList(listPath: string): Promise<Planned[]> {
  const file = resolve(listPath), base = dirname(file);
  let list: unknown;
  try { list = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    throw fault(`The bake list ${file} cannot be read as JSON: ${(error as Error).message}`);
  }
  if (!isRecord(list)) throw fault('The bake list must be an object: { "version": 1, "defaults": { ... }, "bakes": [ { "glb": "model.glb", "clip": "walk" } ] }');
  for (const key of Object.keys(list)) if (!['version', 'defaults', 'bakes'].includes(key)) throw fault(`The bake list has an unknown key "${key}"; its keys are version, defaults and bakes`);
  if (list.version !== BAKE_LIST_VERSION) throw fault(`The bake list needs "version": ${BAKE_LIST_VERSION}, got ${JSON.stringify(list.version)}`);
  const defaults = list.defaults ?? {};
  if (!isRecord(defaults)) throw fault('defaults must be an object of bake options');
  for (const key of Object.keys(defaults)) if (!(OPTION_KEYS as readonly string[]).includes(key)) throw fault(`defaults has an unknown key "${key}"; it takes ${OPTION_KEYS.join(', ')}`);
  if (!Array.isArray(list.bakes) || list.bakes.length < 1 || list.bakes.length > BAKE_LIST_LIMIT) throw fault(`bakes must be a list of 1 to ${BAKE_LIST_LIMIT} entries`);
  const planned: Planned[] = [], outputs = new Map<string, number>();
  list.bakes.forEach((entry: unknown, index: number) => {
    const at = `bakes[${index}]`;
    if (!isRecord(entry)) throw fault(`${at} must be an object with at least glb and clip`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) throw fault(`${at} has an unknown key "${key}"; an entry takes ${ENTRY_KEYS.join(', ')}`);
    if (typeof entry.glb !== 'string' || !entry.glb) throw fault(`${at}.glb must be the path of a GLB file`);
    if (entry.out !== undefined && (typeof entry.out !== 'string' || !entry.out)) throw fault(`${at}.out must be a folder path`);
    // An entry's own value wins; null drops the default, so an entry can leave out what the defaults set.
    const merged: Record<string, unknown> = {};
    for (const key of OPTION_KEYS) {
      const value = key in entry ? entry[key] : defaults[key];
      if (value !== undefined && value !== null) merged[key] = value;
    }
    if (typeof merged.palette === 'string' && merged.palette) merged.palette = resolve(base, merged.palette);
    const glb = resolve(base, entry.glb);
    const output = entry.out !== undefined ? resolve(base, entry.out as string) : join(dirname(glb), `${basename(glb, extname(glb))}-sprites`);
    const options = { ...merged, out: output } as unknown as BakeOptions;
    let settings: BakeSettings;
    try { settings = parseBakeOptions(options); } catch (error) {
      throw Object.assign(new Error(`${at} (${entry.glb}): ${(error as Error).message}`, { cause: error }), { code: (error as { code?: string }).code ?? 'CLI_ARGUMENT_ERROR' });
    }
    const key = process.platform === 'win32' ? output.toLowerCase() : output, earlier = outputs.get(key);
    if (earlier !== undefined) throw fault(`${at} and bakes[${earlier}] both write to ${output}. Give each entry its own "out" (two clips of one model need two folders).`);
    outputs.set(key, index);
    planned.push({ index, glb, output, options, settings });
  });
  return planned;
}

/** The manifest in `output` when that folder already holds the bake with this fingerprint and its files are intact, else null. */
async function finished(output: string, fingerprint: string, settings: BakeSettings): Promise<SpriteManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as SpriteManifest;
    if (manifestFingerprint(manifest) !== fingerprint) return null;
    if (sha256(await readFile(join(output, 'sheet.png'))) !== manifest.sheet?.sha256 || sha256(await readFile(join(output, 'atlas.json'))) !== manifest.atlas?.sha256) return null;
    if (settings.contactSheet && !await exists(join(output, 'contact.png'))) return null;
    if (settings.viewer && !await exists(join(output, 'viewer.html'))) return null;
    return manifest;
  } catch { return null; }
}

/** Bake every entry of a list file in one browser. See the module comment. */
export async function bakeBatch(listPath: string, options: BakeBatchOptions = {}): Promise<BakeBatchResult> {
  const started = Date.now(), planned = await readBakeList(listPath), version = await pluginVersion();
  const bakes: BakeBatchEntry[] = [];
  let browser: Browser | undefined;
  try {
    for (const plan of planned) {
      const began = Date.now(), head = { index: plan.index, glb: plan.glb, clip: plan.settings.clip, output: plan.output };
      let entry: BakeBatchEntry;
      try {
        const done = options.force ? null : await finished(plan.output, bakeFingerprint(plan.settings, sha256(await readFile(plan.glb)), version), plan.settings);
        if (done) entry = { ...head, status: 'skipped', ms: Date.now() - began, sheetSha256: done.sheet.sha256, atlasSha256: done.atlas.sha256 };
        else {
          // The browser starts at the first entry that needs it, and is started again if it has gone away.
          if (!browser?.isConnected()) browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
          const result = await bakeSprites(plan.glb, plan.options, { browser });
          entry = { ...head, status: 'baked', ms: Date.now() - began, sheetSha256: result.sheetSha256, atlasSha256: result.atlasSha256, files: result.files, size: result.size, frames: result.frames };
        }
      } catch (error) { entry = { ...head, status: 'failed', ms: Date.now() - began, error: errorDetails(error) }; }
      bakes.push(entry);
      options.onEntry?.(entry, bakes.length, planned.length);
    }
  } finally { await browser?.close().catch(() => undefined); }
  const count = (status: BakeBatchStatus) => bakes.filter(entry => entry.status === status).length;
  return { ok: count('failed') === 0, list: resolve(listPath), total: planned.length, baked: count('baked'), skipped: count('skipped'), failed: count('failed'), ms: Date.now() - started, bakes };
}
