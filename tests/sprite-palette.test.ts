/** @lane merge
 * @subject src/sprite-palette.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  darkestColor, makePalette, nearestIndex, nearestIndexOklab, paletteManifest, parsePalette, readPalette, snapToPalette, srgbToOklab,
  type Lab, type Palette,
} from '../src/sprite-palette.ts';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sprite-palette-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** Write a palette file into the temp folder and return its path. */
async function file(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

/** The error a call raises, so a test can read its code and message. */
function raised(fn: () => unknown): Error & { code?: string } {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('Expected the call to throw');
}

/** A one-pixel-per-colour RGBA buffer. */
const pixels = (...px: number[][]) => Buffer.from(px.flat());

const HEX_LIST = '; a comment\n#140C1C\n\n#442434\n  #30346d  \n; another\n#442434\n#deeed6\n';
const GPL = 'GIMP Palette\nName: test\nColumns: 4\n# comment\n 20  12  28  dark\n\n68 36 52\n48\t52\t109\tblue\n68 36 52 again\n222 238 214 pale\n';
const COLORS = ['#140c1c', '#442434', '#30346d', '#deeed6'];

describe('reading a palette file', () => {
  it('parses a hex list and a .gpl file to the same colours', async () => {
    const hex = readPalette(await file('p.hex', HEX_LIST));
    const gpl = readPalette(await file('p.gpl', GPL));
    expect(hex.hex).toEqual(COLORS);
    expect(gpl.hex).toEqual(COLORS);
    expect(gpl.rgb).toEqual(hex.rgb);
    expect(gpl.rgb[0]).toEqual([20, 12, 28]);
  });

  it('chooses the format by extension: .gpl in any case is GIMP, anything else is a hex list', async () => {
    expect(readPalette(await file('upper.GPL', GPL)).hex).toEqual(COLORS);
    for (const name of ['p.txt', 'p', 'p.hex.gpl.txt']) expect(readPalette(await file(name, HEX_LIST)).hex).toEqual(COLORS);
    expect(raised(() => parsePalette(HEX_LIST, 'gpl')).code).toBe('CLI_ARGUMENT_ERROR');
  });

  it('ignores comment and blank lines, tolerates CRLF and a byte order mark, and normalises case', () => {
    expect(parsePalette('﻿; c\r\n\r\n#AbCdEf\r\n   \r\n; d\r\n#010203', 'hex').hex).toEqual(['#abcdef', '#010203']);
    expect(parsePalette('GIMP Palette\r\n# c\r\n\r\nName: n\r\n255 0 0\r\n', 'gpl').hex).toEqual(['#ff0000']);
  });

  it('drops duplicates keeping the first, so palette order is the order of first appearance', () => {
    const palette = parsePalette('#222222\n#111111\n#222222\n#333333\n#111111\n#222222', 'hex');
    expect(palette.hex).toEqual(['#222222', '#111111', '#333333']);
    expect(palette.rgb.length).toBe(3);
    expect(palette.lab.length).toBe(3);
    expect(parsePalette('GIMP Palette\n0 0 1 first\n0 0 1 second\n0 0 2', 'gpl').hex).toEqual(['#000001', '#000002']);
  });

  it('accepts 256 colours after de-duplication, however many lines it took', () => {
    const lines = Array.from({ length: 256 }, (_, i) => '#' + i.toString(16).padStart(2, '0').repeat(3));
    expect(parsePalette(lines.join('\n'), 'hex').hex.length).toBe(256);
    expect(parsePalette([...lines, lines[0], lines[1]].join('\n'), 'hex').hex.length).toBe(256);
    expect(parsePalette('#000000', 'hex').hex.length).toBe(1);
  });
});

describe('palette errors raise CLI_ARGUMENT_ERROR', () => {
  it('rejects an empty palette, whether the file is blank, only comments or only a header', () => {
    for (const [text, kind] of [['', 'hex'], ['; nothing\n\n', 'hex'], ['GIMP Palette\nName: x\n# none\n', 'gpl']] as const) {
      const error = raised(() => parsePalette(text, kind));
      expect(error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(error.message).toMatch(/no colours/);
    }
  });

  it('rejects a 257-colour palette in both formats', () => {
    const rgb = Array.from({ length: 257 }, (_, i) => [i >> 4, i & 15, 7]);
    const hex = rgb.map(([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')).join('\n');
    const gpl = 'GIMP Palette\n' + rgb.map(c => c.join(' ')).join('\n');
    for (const [text, kind] of [[hex, 'hex'], [gpl, 'gpl']] as const) {
      const error = raised(() => parsePalette(text, kind));
      expect(error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(error.message).toMatch(/257 colours/);
    }
  });

  it('names the line of a bad hex line', () => {
    for (const bad of ['#12345', '#1234567', '#gggggg', 'ff0000', '#ff0000 red', '#ff 00 00', 'red']) {
      const error = raised(() => parsePalette(`#112233\n; note\n${bad}\n#445566`, 'hex', 'colors.hex'));
      expect(error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(error.message).toContain('colors.hex, line 3');
      expect(error.message).toContain(bad);
    }
  });

  it('rejects a malformed .gpl and names the line', () => {
    const header = raised(() => parsePalette('Not a palette\n1 2 3', 'gpl'));
    expect(header.code).toBe('CLI_ARGUMENT_ERROR');
    expect(header.message).toContain('line 1');
    expect(raised(() => parsePalette('\nGIMP Palette\n1 2 3', 'gpl')).code).toBe('CLI_ARGUMENT_ERROR');
    for (const bad of ['255 0', '256 0 0', '1 2 x', '-1 2 3', '1.5 2 3', '1,2,3']) {
      const error = raised(() => parsePalette(`GIMP Palette\nName: n\n10 20 30 ok\n${bad}`, 'gpl'));
      expect(error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(error.message).toContain('line 4');
    }
  });

  it('rejects a missing file and a folder as unreadable', () => {
    for (const path of [join(dir, 'missing.hex'), dir]) {
      const error = raised(() => readPalette(path));
      expect(error.code).toBe('CLI_ARGUMENT_ERROR');
      expect(error.message).toMatch(/Cannot read the palette file/);
    }
  });

  it('raises the error from a file read, naming the file and the line', async () => {
    const path = await file('bad.hex', '#112233\noops\n');
    const error = raised(() => readPalette(path));
    expect(error.code).toBe('CLI_ARGUMENT_ERROR');
    expect(error.message).toContain(path);
    expect(error.message).toContain('line 2');
  });
});

describe('OKLab and the nearest colour', () => {
  it('converts sRGB to OKLab with the reference values', () => {
    const near = (actual: Lab, expected: number[]) => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 3));
    near(srgbToOklab(0, 0, 0), [0, 0, 0]);
    near(srgbToOklab(255, 255, 255), [1, 0, 0]);
    near(srgbToOklab(255, 0, 0), [0.62796, 0.22486, 0.12585]);
    near(srgbToOklab(0, 255, 0), [0.86644, -0.23389, 0.1795]);
    near(srgbToOklab(0, 0, 255), [0.45201, -0.03246, -0.31153]);
    const grey = srgbToOklab(119, 119, 119);
    expect(Math.abs(grey[1]) + Math.abs(grey[2])).toBeLessThan(1e-4);
  });

  it('picks the colour that is nearest in OKLab, which is not the nearest in RGB', () => {
    // Mid grey is nearer to white than to red by RGB distance, but nearer to red by OKLab distance.
    const grey: [number, number, number] = [128, 128, 128], white: [number, number, number] = [255, 255, 255], red: [number, number, number] = [255, 0, 0];
    const rgbDistance = (c: number[]) => c.reduce((s, v, i) => s + (v - grey[i]) ** 2, 0);
    expect(rgbDistance(white)).toBeLessThan(rgbDistance(red));
    const palette = makePalette([white, red]);
    expect(palette.hex[nearestIndex(palette, ...grey)]).toBe('#ff0000');
    // The answer does not depend on the order of the palette.
    const reversed = makePalette([red, white]);
    expect(reversed.hex[nearestIndex(reversed, ...grey)]).toBe('#ff0000');
    // A dark grey is nearer black than white in both spaces.
    const dark = makePalette([[255, 255, 255], [0, 0, 0]]);
    expect(dark.hex[nearestIndex(dark, 40, 40, 40)]).toBe('#000000');
  });

  it('returns the exact colour for a pixel that is in the palette', () => {
    const palette = parsePalette(HEX_LIST, 'hex');
    palette.rgb.forEach((c, i) => expect(nearestIndex(palette, ...c)).toBe(i));
  });

  it('gives a tie to the earlier palette entry, whichever way round the entries are', () => {
    // Two entries exactly 0.1 either side of the query on the a axis have identical squared distances.
    const left: Lab = [0.5, -0.1, 0], right: Lab = [0.5, 0.1, 0], query: Lab = [0.5, 0, 0];
    expect(nearestIndexOklab({ lab: [left, right] }, query)).toBe(0);
    expect(nearestIndexOklab({ lab: [right, left] }, query)).toBe(0);
    expect(nearestIndexOklab({ lab: [left, right, left] }, query)).toBe(0);
    // A later entry that is strictly nearer still wins.
    expect(nearestIndexOklab({ lab: [left, [0.5, 0.05, 0]] }, query)).toBe(1);
  });
});

describe('snapping pixels', () => {
  const palette = makePalette([[255, 255, 255], [255, 0, 0], [0, 0, 0]]);

  it('replaces the RGB of opaque pixels with the nearest palette colour', () => {
    const out = snapToPalette(pixels([128, 128, 128, 255], [250, 10, 10, 255], [30, 30, 30, 255], [255, 255, 255, 255]), palette);
    expect([...out]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('leaves alpha, partial alpha and the transparent form 0, 0, 0, 0 untouched', () => {
    const input = pixels([0, 0, 0, 0], [128, 128, 128, 0], [128, 128, 128, 254], [128, 128, 128, 1], [128, 128, 128, 255]);
    const out = snapToPalette(input, palette);
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.subarray(4, 20)]).toEqual([128, 128, 128, 0, 128, 128, 128, 254, 128, 128, 128, 1, 255, 0, 0, 255]);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(input[i]);
  });

  it('returns a new buffer and does not mutate the input', () => {
    const input = pixels([128, 128, 128, 255], [3, 4, 5, 0]);
    const before = Buffer.from(input);
    const out = snapToPalette(input, palette);
    expect(out).not.toBe(input);
    expect(input.equals(before)).toBe(true);
    expect(out.equals(input)).toBe(false);
  });

  it('gives only palette colours for any opaque pixel and is stable when applied twice', () => {
    const full = parsePalette(HEX_LIST, 'hex');
    const rgba = Buffer.alloc(64 * 4);
    for (let i = 0; i < 64; i++) { rgba[i * 4] = i * 4; rgba[i * 4 + 1] = (i * 37) & 255; rgba[i * 4 + 2] = 255 - i * 3; rgba[i * 4 + 3] = i % 5 === 0 ? 0 : 255; }
    const once = snapToPalette(rgba, full);
    for (let i = 0; i < 64; i++) {
      if (once[i * 4 + 3] === 0) continue;
      expect(full.rgb.some(([r, g, b]) => r === once[i * 4] && g === once[i * 4 + 1] && b === once[i * 4 + 2])).toBe(true);
    }
    expect(snapToPalette(once, full).equals(once)).toBe(true);
  });

  it('rejects a buffer that is not whole RGBA pixels', () => {
    expect(() => snapToPalette(Buffer.alloc(6), palette)).toThrow(/4 bytes per pixel/);
    expect(snapToPalette(Buffer.alloc(0), palette).length).toBe(0);
  });
});

describe('the darkest colour and the manifest', () => {
  it('picks the colour with the lowest OKLab lightness, wherever it sits in the list', () => {
    expect(darkestColor(parsePalette(HEX_LIST, 'hex'))).toBe('#140c1c');
    expect(darkestColor(makePalette([[255, 255, 255], [20, 20, 20], [200, 0, 0]]))).toBe('#141414');
    // Pure red, green and blue have the same channel sum; only OKLab lightness ranks blue the darkest.
    for (const order of [[[255, 0, 0], [0, 255, 0], [0, 0, 255]], [[0, 0, 255], [255, 0, 0], [0, 255, 0]], [[0, 255, 0], [0, 0, 255], [255, 0, 0]]] as [number, number, number][][])
      expect(darkestColor(makePalette(order))).toBe('#0000ff');
  });

  it('gives a tie in lightness to the earlier entry', () => {
    const base = makePalette([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
    expect(darkestColor({ ...base, lab: [[0.4, 0, 0], [0.2, 0.1, 0], [0.2, -0.1, 0]] })).toBe('#020202');
    expect(darkestColor({ ...base, lab: [[0.2, 0, 0], [0.2, 0.1, 0], [0.9, 0, 0]] })).toBe('#010101');
  });

  it('reports the colour count and a SHA-256 of the normalised list, independent of the source format', async () => {
    const hex = readPalette(await file('m.hex', HEX_LIST));
    const gpl = readPalette(await file('m.gpl', GPL));
    const expected = createHash('sha256').update('#140c1c\n#442434\n#30346d\n#deeed6').digest('hex');
    expect(paletteManifest(hex)).toEqual({ colors: 4, sha256: expected });
    expect(paletteManifest(gpl)).toEqual({ colors: 4, sha256: expected });
    expect(Object.keys(paletteManifest(hex))).toEqual(['colors', 'sha256']);
  });

  it('changes the SHA-256 when the order or the colours change', () => {
    const a = paletteManifest(parsePalette('#000000\n#ffffff', 'hex')).sha256;
    expect(paletteManifest(parsePalette('#ffffff\n#000000', 'hex')).sha256).not.toBe(a);
    expect(paletteManifest(parsePalette('#000000\n#fffffe', 'hex')).sha256).not.toBe(a);
    expect(paletteManifest(parsePalette('#000000\n#FFFFFF\n#000000', 'hex')).sha256).toBe(a);
  });
});
