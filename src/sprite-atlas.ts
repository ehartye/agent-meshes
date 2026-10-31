/**
 * The sheet layout, Aseprite-format atlas and manifest for a baked sprite sheet, with no renderer and no file access.
 * Rows are directions and columns are phases: frame `i = direction * phases + phase`, and the tag `dir-k` spans
 * frames `k * phases` to `k * phases + phases - 1`. The atlas carries no plugin version, timestamp or path, so the
 * same inputs give the same bytes on every machine and release; the version lives in the manifest only.
 */
export const SPRITE_MANIFEST_FORMAT = 'agent-meshes/sprite-bake/1';
export const SPRITE_ATLAS_IMAGE = 'sheet.png';

export interface SheetSpec {
  /** Cell edge in pixels. */
  cell: number;
  directions: number;
  phases: number;
  /** Duration of the baked clip in milliseconds; each frame lasts this divided by `phases`, rounded. */
  clipDurationMs: number;
}

export interface SheetFrame { index: number; direction: number; phase: number; x: number; y: number; w: number; h: number }
export interface SheetLayout { width: number; height: number; cell: number; directions: number; phases: number; frames: SheetFrame[] }

export interface AtlasFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  duration: number;
}
export interface AtlasTag { name: string; from: number; to: number; direction: 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse' }
export interface AtlasSliceKey { frame: number; bounds: { x: number; y: number; w: number; h: number }; pivot: { x: number; y: number } }
export interface AtlasSlice { name: string; color: string; keys: AtlasSliceKey[] }
export interface Atlas {
  frames: AtlasFrame[];
  /** `slices` is present only when a pivot was given; it is never an empty list. */
  meta: { app: string; image: string; format: string; size: { w: number; h: number }; scale: string; frameTags: AtlasTag[]; slices?: AtlasSlice[] };
}

/** An integer cell pixel from the top-left of the cell, y down. */
export interface SlicePivot { x: number; y: number }

export const SPRITE_PIVOT_SLICE = 'pivot';
const PIVOT_SLICE_COLOR = '#0000ffff';

function sheetError(message: string): Error {
  return Object.assign(new Error(message), { code: 'SPRITE_SHEET_INVALID' });
}

/** Reject a zero, negative or fractional cell, direction or phase count, and a clip duration that rounds a frame to zero. */
export function assertSheetSpec(spec: SheetSpec): void {
  for (const key of ['cell', 'directions', 'phases'] as const) {
    const value = spec[key];
    if (!Number.isInteger(value) || value < 1) throw sheetError(`${key} must be a positive integer, got ${value}`);
  }
  if (!Number.isFinite(spec.clipDurationMs) || spec.clipDurationMs <= 0)
    throw sheetError(`clipDurationMs must be a positive number, got ${spec.clipDurationMs}`);
  if (Math.round(spec.clipDurationMs / spec.phases) < 1)
    throw sheetError(`A ${spec.clipDurationMs} ms clip over ${spec.phases} phases gives frames shorter than 1 ms`);
}

/** Where every cell sits in the sheet. */
export function sheetLayout(spec: SheetSpec): SheetLayout {
  assertSheetSpec(spec);
  const { cell, directions, phases } = spec;
  const frames: SheetFrame[] = [];
  for (let direction = 0; direction < directions; direction++)
    for (let phase = 0; phase < phases; phase++)
      frames.push({ index: direction * phases + phase, direction, phase, x: phase * cell, y: direction * cell, w: cell, h: cell });
  return { width: phases * cell, height: directions * cell, cell, directions, phases, frames };
}

/**
 * The Aseprite-format atlas: array frames named by decimal index and one forward tag per direction. With a `pivot`
 * it also carries one slice named `pivot` whose single key sits at frame 0, spans the whole cell and holds the pivot.
 */
export function buildAtlas(spec: SheetSpec, pivot?: SlicePivot): Atlas {
  const layout = sheetLayout(spec);
  const duration = Math.round(spec.clipDurationMs / spec.phases);
  const { cell } = spec;
  if (pivot && (!Number.isInteger(pivot.x) || !Number.isInteger(pivot.y) || pivot.x < 0 || pivot.y < 0 || pivot.x >= cell || pivot.y >= cell))
    throw sheetError(`The pivot must be an integer pixel inside the ${cell} by ${cell} cell, got ${pivot.x}, ${pivot.y}`);
  return {
    frames: layout.frames.map(f => ({
      filename: String(f.index),
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cell, h: cell },
      sourceSize: { w: cell, h: cell },
      duration,
    })),
    meta: {
      app: 'agent-meshes',
      image: SPRITE_ATLAS_IMAGE,
      format: 'RGBA8888',
      size: { w: layout.width, h: layout.height },
      scale: '1',
      frameTags: Array.from({ length: spec.directions }, (_, k) => ({
        name: `dir-${k}`, from: k * spec.phases, to: k * spec.phases + spec.phases - 1, direction: 'forward' as const,
      })),
      ...(pivot ? { slices: [{
        name: SPRITE_PIVOT_SLICE,
        color: PIVOT_SLICE_COLOR,
        keys: [{ frame: 0, bounds: { x: 0, y: 0, w: cell, h: cell }, pivot: { x: pivot.x, y: pivot.y } }],
      }] } : {}),
    },
  };
}

/** The exact bytes written to `atlas.json`: one-space indent and a trailing newline. */
export function serializeAtlas(atlas: Atlas): string {
  return JSON.stringify(atlas, null, 1) + '\n';
}

export interface ManifestInput {
  model: { sha256: string };
  clip: { name: string; durationMs: number };
  directions: number;
  phases: number;
  cell: number;
  /** Camera parameters as plain values (numbers, strings, number arrays); written with their keys sorted. */
  camera: Record<string, number | string | number[]>;
  sheetSha256: string;
  atlasSha256: string;
  pluginVersion: string;
  /** Each optional key below is written to the manifest only when it is given. */
  look?: string;
  bands?: number;
  palette?: { colors: number; sha256: string };
  outline?: string;
  anchor?: { name: string; x: number; y: number };
}
export interface SpriteManifest {
  format: typeof SPRITE_MANIFEST_FORMAT;
  pluginVersion: string;
  model: { sha256: string };
  clip: { name: string; durationMs: number };
  directions: number;
  phases: number;
  cell: number;
  camera: Record<string, number | string | number[]>;
  sheet: { file: string; width: number; height: number; sha256: string };
  atlas: { file: string; frames: number; sha256: string };
  look?: string;
  bands?: number;
  palette?: { colors: number; sha256: string };
  outline?: string;
  anchor?: { name: string; x: number; y: number };
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The manifest from plain inputs. It holds no timestamp and no path, and its key order is fixed. */
export function buildManifest(input: ManifestInput): SpriteManifest {
  const layout = sheetLayout({ cell: input.cell, directions: input.directions, phases: input.phases, clipDurationMs: input.clip.durationMs });
  for (const [label, value] of [['model', input.model.sha256], ['sheet', input.sheetSha256], ['atlas', input.atlasSha256]] as const)
    if (!SHA256.test(value)) throw sheetError(`The ${label} SHA-256 must be 64 lowercase hex digits, got "${value}"`);
  if (!input.clip.name) throw sheetError('The clip name must not be empty');
  if (!input.pluginVersion) throw sheetError('The plugin version must not be empty');
  return {
    format: SPRITE_MANIFEST_FORMAT,
    pluginVersion: input.pluginVersion,
    model: { sha256: input.model.sha256 },
    clip: { name: input.clip.name, durationMs: input.clip.durationMs },
    directions: input.directions,
    phases: input.phases,
    cell: input.cell,
    camera: Object.fromEntries(Object.entries(input.camera).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    sheet: { file: SPRITE_ATLAS_IMAGE, width: layout.width, height: layout.height, sha256: input.sheetSha256 },
    atlas: { file: 'atlas.json', frames: layout.frames.length, sha256: input.atlasSha256 },
    ...(input.look !== undefined ? { look: input.look } : {}),
    ...(input.bands !== undefined ? { bands: input.bands } : {}),
    ...(input.palette !== undefined ? { palette: { colors: input.palette.colors, sha256: input.palette.sha256 } } : {}),
    ...(input.outline !== undefined ? { outline: input.outline } : {}),
    ...(input.anchor !== undefined ? { anchor: { name: input.anchor.name, x: input.anchor.x, y: input.anchor.y } } : {}),
  };
}

export interface ContractOptions {
  /** Tag names that must be present, for example `dir-0` to `dir-7`. */
  expectedTags?: string[];
  /** The decoded sheet size when it is known; defaults to the size the atlas states. */
  sheet?: { width: number; height: number };
}

/**
 * Checks an atlas against the agent-sprites atlas contract (`validateAtlas`) plus this command's own promise that the
 * tags tile the frames: every frame inside the sheet, unique filenames, positive integer durations, a trimmed rectangle
 * that fits its source, and tags that start at frame 0, follow one another without a gap or overlap and end at the last
 * frame. Returns the problems found; an empty list means the atlas is valid.
 */
export function checkAtlasContract(atlas: Atlas, options: ContractOptions = {}): string[] {
  const problems: string[] = [];
  const isRect = (r: { x: number; y: number; w: number; h: number } | undefined): r is { x: number; y: number; w: number; h: number } =>
    !!r && ['x', 'y', 'w', 'h'].every(k => Number.isInteger((r as unknown as Record<string, number>)[k])) && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0;
  const frames = Array.isArray(atlas?.frames) ? atlas.frames : [];
  if (!frames.length) problems.push('The atlas has no frames');
  const stated = atlas?.meta?.size;
  const width = options.sheet?.width ?? stated?.w, height = options.sheet?.height ?? stated?.h;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width! < 1 || height! < 1) problems.push('The sheet size must be positive integers');
  else if (stated && (stated.w !== width || stated.h !== height)) problems.push(`meta.size is ${stated.w} by ${stated.h} but the sheet is ${width} by ${height}`);
  const names = new Set<string>();
  frames.forEach((f, i) => {
    const at = `frame ${i}`;
    if (typeof f.filename !== 'string' || !f.filename) problems.push(`${at} has no filename`);
    else if (names.has(f.filename)) problems.push(`${at} repeats the filename "${f.filename}"`);
    else names.add(f.filename);
    if (!isRect(f.frame) || f.frame.x + f.frame.w > width! || f.frame.y + f.frame.h > height!)
      problems.push(`${at} is not a whole rectangle inside the ${width} by ${height} sheet`);
    if (!Number.isInteger(f.duration) || f.duration <= 0) problems.push(`${at} has duration ${f.duration}; durations must be positive integers`);
    const src = f.sourceSize, trim = f.spriteSourceSize;
    if (!src || !Number.isInteger(src.w) || !Number.isInteger(src.h) || src.w < 1 || src.h < 1 || !isRect(trim) || trim.x + trim.w > src.w || trim.y + trim.h > src.h)
      problems.push(`${at} has a spriteSourceSize that does not fit its sourceSize`);
    else if (isRect(f.frame) && (trim.w !== (f.rotated ? f.frame.h : f.frame.w) || trim.h !== (f.rotated ? f.frame.w : f.frame.h)))
      problems.push(`${at} has a spriteSourceSize that does not match its frame rectangle`);
  });
  const tags = atlas?.meta?.frameTags;
  const tagNames = new Set<string>();
  if (!Array.isArray(tags)) problems.push('meta.frameTags must be an array');
  else {
    let next = 0;
    tags.forEach((tag, i) => {
      const at = `tag ${i}`;
      if (typeof tag.name !== 'string' || !tag.name || tagNames.has(tag.name)) problems.push(`${at} needs a unique, non-empty name`);
      tagNames.add(tag.name);
      if (!Number.isInteger(tag.from) || !Number.isInteger(tag.to) || tag.from < 0 || tag.to < tag.from || tag.to >= frames.length)
        problems.push(`${at} ("${tag.name}") range ${tag.from} to ${tag.to} does not address existing frames in ascending order`);
      else {
        if (tag.from !== next) problems.push(`${at} ("${tag.name}") starts at frame ${tag.from} but frame ${next} is the first one not yet covered`);
        next = tag.to + 1;
      }
      if (!['forward', 'reverse', 'pingpong', 'pingpong_reverse'].includes(tag.direction ?? 'forward')) problems.push(`${at} ("${tag.name}") has an unsupported direction`);
    });
    if (frames.length && next !== frames.length) problems.push(`The tags cover ${next} of ${frames.length} frames; every frame must be in a tag`);
  }
  const slices: unknown = atlas?.meta?.slices;
  if (slices !== undefined) {
    if (!Array.isArray(slices) || !slices.length) problems.push('meta.slices must be a non-empty array when present');
    else {
      const cellW = frames[0]?.sourceSize?.w, cellH = frames[0]?.sourceSize?.h;
      const inside = (v: unknown, max: number | undefined): boolean => Number.isInteger(v) && (v as number) >= 0 && max !== undefined && (v as number) < max;
      (slices as AtlasSlice[]).forEach((slice, i) => {
        const at = `slice ${i}`;
        if (slice?.name !== SPRITE_PIVOT_SLICE) problems.push(`${at} is named "${slice?.name}" but only "${SPRITE_PIVOT_SLICE}" is supported`);
        if (!Array.isArray(slice?.keys) || !slice.keys.length) { problems.push(`${at} needs at least one key`); return; }
        const seen = new Set<number>();
        slice.keys.forEach((key, k) => {
          const keyAt = `${at} key ${k}`;
          if (!Number.isInteger(key?.frame) || key.frame < 0) problems.push(`${keyAt} needs a non-negative integer frame, got ${key?.frame}`);
          else if (seen.has(key.frame)) problems.push(`${keyAt} repeats frame ${key.frame}`);
          else seen.add(key.frame);
          const b = key?.bounds;
          if (!isRect(b) || b.x + b.w > width! || b.y + b.h > height!) problems.push(`${keyAt} bounds are not a whole rectangle inside the ${width} by ${height} sheet`);
          const p = key?.pivot;
          if (!p || !inside(p.x, cellW) || !inside(p.y, cellH)) problems.push(`${keyAt} pivot ${p?.x}, ${p?.y} is not an integer pixel inside the ${cellW} by ${cellH} cell`);
        });
      });
    }
  }
  for (const name of options.expectedTags ?? []) if (!tagNames.has(name)) problems.push(`The required tag "${name}" is missing`);
  return problems;
}
