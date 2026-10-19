import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildAsset, type BuildOptions } from './build.ts';
import { NativeBuildSession } from './build-session.ts';
import { errorDetails } from './errors.ts';

type AssetResult = { config: string; ok: true; result: Awaited<ReturnType<typeof buildAsset>> } | { config: string; ok: false; error: ReturnType<typeof errorDetails> };

/** Sequential, fail-fast and transactional per asset, not across the whole list. */
export async function buildAssets(configPaths: string[], options: BuildOptions = {}) {
  if (!Array.isArray(configPaths) || !configPaths.length || configPaths.length > 1000) throw new Error('Build batch needs 1 to 1000 explicit configs');
  const configs = await Promise.all(configPaths.map(path => realpath(resolve(path))));
  const keys = configs.map(path => process.platform === 'win32' ? path.toLowerCase() : path);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate canonical build config in batch');
  const session = new NativeBuildSession(), assets: AssetResult[] = [];
  try {
    for (const config of configs) {
      try { assets.push({ config, ok: true, result: await buildAsset(config, options, session) }); }
      catch (error) { assets.push({ config, ok: false, error: errorDetails(error) }); break; }
    }
    return { ok: assets.every(asset => asset.ok), assets, unattempted: configs.slice(assets.length), toolchain: session.stats() };
  } finally { session.close(); }
}
