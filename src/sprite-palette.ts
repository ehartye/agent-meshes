import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * A fixed colour palette for the sprite bake, with no renderer and no browser. A palette file is read by extension: a
 * `.gpl` file is a GIMP palette (`GIMP Palette`, optional `Name:` and `Columns:` lines and `#` comments, then `R G B  name`
 * lines of 0 to 255 integers) and any other extension is a hex list (one strict `#rrggbb` per line, blank lines ignored,
 * lines starting with `;` are comments). Duplicates are dropped keeping the first, and a palette holds 1 to 256 colours.
 * Colours are matched in OKLab, so the nearest colour is the one that looks nearest, and a tie goes to the earlier entry.
 * The reader is synchronous so the bake can call it before Chromium starts; every fault raises `CLI_ARGUMENT_ERROR`.
 */
export const PALETTE_MAX_COLORS = 256;

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

export interface Palette {
  /** Normalised lowercase `#rrggbb`, in palette order after de-duplication. */
  hex: string[];
  rgb: Rgb[];
  /** The OKLab value of each colour, computed once. */
  lab: Lab[];
}

const argumentError = (message: string) => Object.assign(new Error(message), { code: 'CLI_ARGUMENT_ERROR' });
const toHex = ([r, g, b]: Rgb) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

/** sRGB byte to linear light, for all 256 values. */
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** 8-bit sRGB to OKLab (Bjorn Ottosson's matrices): lightness `L` 0 to 1, then the green-red `a` and blue-yellow `b` axes. */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lr = LINEAR[r], lg = LINEAR[g], lb = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** A palette from colours already known to be valid bytes; duplicates are dropped keeping the first. */
export function makePalette(colors: Rgb[]): Palette {
  const seen = new Set<string>();
  const palette: Palette = { hex: [], rgb: [], lab: [] };
  for (const color of colors) {
    const hex = toHex(color);
    if (seen.has(hex)) continue;
    seen.add(hex);
    palette.hex.push(hex);
    palette.rgb.push(color);
    palette.lab.push(srgbToOklab(...color));
  }
  return palette;
}

/** The index of the palette entry nearest to an OKLab point by squared distance; the earlier entry wins a tie. */
export function nearestIndexOklab(palette: Pick<Palette, 'lab'>, [L, a, b]: Lab): number {
  let best = 0, bestDistance = Infinity;
  palette.lab.forEach(([pl, pa, pb], i) => {
    const distance = (pl - L) ** 2 + (pa - a) ** 2 + (pb - b) ** 2;
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  });
  return best;
}

/** The index of the palette entry nearest to an sRGB colour in OKLab. */
export function nearestIndex(palette: Palette, r: number, g: number, b: number): number {
  return nearestIndexOklab(palette, srgbToOklab(r, g, b));
}

/**
 * A new RGBA buffer in which every pixel with alpha 255 has the RGB of its nearest palette colour. Pixels with any other
 * alpha, including the transparent form 0, 0, 0, 0, are copied unchanged, and the input is not modified.
 */
export function snapToPalette(rgba: Buffer, palette: Palette): Buffer {
  if (rgba.length % 4 !== 0) throw new RangeError(`An RGBA buffer holds 4 bytes per pixel, got ${rgba.length} bytes`);
  const out = Buffer.from(rgba);
  const cache = new Map<number, number>();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] !== 255) continue;
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let index = cache.get(key);
    if (index === undefined) { index = nearestIndex(palette, out[i], out[i + 1], out[i + 2]); cache.set(key, index); }
    const [r, g, b] = palette.rgb[index];
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
}

/** The palette colour with the lowest OKLab lightness as `#rrggbb`; the earlier entry wins a tie. */
export function darkestColor(palette: Palette): string {
  let best = 0;
  palette.lab.forEach(([L], i) => { if (L < palette.lab[best][0]) best = i; });
  return palette.hex[best];
}

/** What the manifest records: the colour count and the SHA-256 of the normalised colours joined by newlines. */
export function paletteManifest(palette: Palette): { colors: number; sha256: string } {
  return { colors: palette.hex.length, sha256: createHash('sha256').update(palette.hex.join('\n')).digest('hex') };
}

/** Parse palette text; `kind` is `gpl` or `hex` and `source` names the file in error messages. */
export function parsePalette(text: string, kind: 'gpl' | 'hex', source = 'palette'): Palette {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const colors: Rgb[] = [];
  const bad = (line: number, why: string) => argumentError(`${source}, line ${line}: ${why}`);
  if (kind === 'gpl') {
    if (lines[0].trim() !== 'GIMP Palette') throw bad(1, 'a .gpl palette must start with the line "GIMP Palette"');
    for (let n = 2; n <= lines.length; n++) {
      const line = lines[n - 1].trim();
      if (!line || line.startsWith('#') || /^(Name|Columns):/.test(line)) continue;
      const match = /^(\d+)\s+(\d+)\s+(\d+)(?:\s+.*)?$/.exec(line);
      const rgb = match && [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      if (!rgb || rgb.some(v => v > 255)) throw bad(n, `expected "R G B name" with integers from 0 to 255, got "${line}"`);
      colors.push(rgb);
    }
  } else {
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith(';')) return;
      if (!/^#[0-9a-fA-F]{6}$/.test(line)) throw bad(i + 1, `expected one #rrggbb colour, got "${line}"`);
      colors.push([parseInt(line.slice(1, 3), 16), parseInt(line.slice(3, 5), 16), parseInt(line.slice(5, 7), 16)]);
    });
  }
  const palette = makePalette(colors);
  if (!palette.hex.length) throw argumentError(`${source} holds no colours`);
  if (palette.hex.length > PALETTE_MAX_COLORS) throw argumentError(`${source} holds ${palette.hex.length} colours; a palette has 1 to ${PALETTE_MAX_COLORS}`);
  return palette;
}

/** Read a palette file, by extension: `.gpl` is a GIMP palette and anything else is a hex list. */
export function readPalette(file: string): Palette {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw argumentError(`Cannot read the palette file ${file}: ${(error as Error).message}`);
  }
  return parsePalette(text, extname(file).toLowerCase() === '.gpl' ? 'gpl' : 'hex', file);
}
