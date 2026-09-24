/**
 * Renderer quality, so a page can trade image quality for frame time. `high` (the default) is
 * antialiased, uses the device pixel ratio up to 2, lights with a room environment map and casts
 * 2048² soft shadows. `fast` turns off MSAA, the shadow map and the environment map, and renders
 * at pixel ratio 1: under software GL that is the difference between ~50 ms and ~17 ms frames for
 * three 12k-vertex heads at 1280x720. Painted surfaces keep nearly the same exposure without the
 * environment (the hemisphere, key and fill lights carry them); metals lose their reflections.
 */
export type QualityPreset = 'high' | 'fast';
export interface QualityOptions {
  /** Start from a preset, then apply the other fields. Default `high`. */
  preset?: QualityPreset;
  /** Multisampled edges. Fixed when the renderer is created. */
  antialias?: boolean;
  /** Drawing-buffer pixels per CSS pixel, 0.25 to 4. */
  pixelRatio?: number;
  /** Cast shadows from the key light: true, false, or a power-of-two shadow map size from 256 to 8192. */
  shadows?: boolean | number;
  /** Image-based light from a procedural room: believable speculars and metals, at the cost of per-pixel environment lookups. */
  environment?: boolean;
}
export type QualityInput = QualityPreset | QualityOptions;
export interface Quality { antialias: boolean; pixelRatio: number; shadows: boolean; shadowMapSize: number; environment: boolean }

const keys = ['preset', 'antialias', 'pixelRatio', 'shadows', 'environment'];

/** Resolve a quality input against the device pixel ratio. Invalid input throws before any renderer exists. */
export function parseQuality(input: QualityInput | undefined, devicePixelRatio: number): Quality {
  const options: QualityOptions = typeof input === 'string' ? { preset: input } : input ?? {};
  if (typeof options !== 'object' || options === null || Array.isArray(options) || (options.preset !== undefined && options.preset !== 'high' && options.preset !== 'fast')) {
    throw new Error(`quality must be "high", "fast" or an object with preset, antialias, pixelRatio, shadows and environment: ${JSON.stringify(input)}`);
  }
  for (const key of Object.keys(options)) if (!keys.includes(key)) throw new Error(`Unknown quality option "${key}"; use ${keys.join(', ')}`);
  const fast = options.preset === 'fast';
  const quality: Quality = { antialias: !fast, pixelRatio: fast ? 1 : Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, 2), shadows: !fast, shadowMapSize: 2048, environment: !fast };
  if (options.environment !== undefined) {
    if (typeof options.environment !== 'boolean') throw new Error(`quality environment must be true or false: ${JSON.stringify(options.environment)}`);
    quality.environment = options.environment;
  }
  if (options.antialias !== undefined) {
    if (typeof options.antialias !== 'boolean') throw new Error(`quality antialias must be true or false: ${JSON.stringify(options.antialias)}`);
    quality.antialias = options.antialias;
  }
  if (options.pixelRatio !== undefined) {
    if (typeof options.pixelRatio !== 'number' || !(options.pixelRatio >= 0.25 && options.pixelRatio <= 4)) throw new Error(`quality pixelRatio must be a number from 0.25 to 4: ${JSON.stringify(options.pixelRatio)}`);
    quality.pixelRatio = options.pixelRatio;
  }
  if (options.shadows !== undefined) {
    const size = options.shadows;
    if (typeof size === 'boolean') quality.shadows = size;
    else if (typeof size === 'number' && Number.isInteger(size) && size >= 256 && size <= 8192 && (size & (size - 1)) === 0) { quality.shadows = true; quality.shadowMapSize = size; }
    else throw new Error(`quality shadows must be true, false or a power-of-two map size from 256 to 8192: ${JSON.stringify(size)}`);
  }
  return quality;
}
