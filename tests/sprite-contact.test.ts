/** @lane merge
 * @subject src/sprite-contact.ts
 */
import { describe, expect, it } from 'vitest';
import { CONTACT_MAX_PIXELS, composeContactSheet, contactSize } from '../src/sprite-contact.ts';

// The compositor is pure, so the layout is read pixel by pixel from a tiny synthetic sheet and no browser is needed.
const GREY = [128, 128, 128, 255];

/** A sheet of `directions` rows and `phases` columns of `cell` pixel cells; every cell has its own colour, and pixel 0 of each cell is transparent. */
function syntheticSheet(cell: number, directions: number, phases: number): Buffer {
  const width = phases * cell, sheet = Buffer.alloc(width * directions * cell * 4);
  for (let row = 0; row < directions; row++) for (let column = 0; column < phases; column++) for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const at = ((row * cell + y) * width + column * cell + x) * 4, id = row * phases + column;
    if (x === 0 && y === 0) continue;
    sheet.set([10 + id * 20, 200 - id * 15, 30 + (y * cell + x) * 7, 255], at);
  }
  return sheet;
}
const pixel = (image: { width: number; rgba: Buffer }, x: number, y: number) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

describe('the contact sheet layout', () => {
  const sheet = syntheticSheet(2, 2, 3), image = composeContactSheet(sheet, { cell: 2, directions: 2, phases: 3 });

  it('is phases * (4 * cell) + (phases - 1) * 4 wide and directions * (4 * cell) + (directions - 1) * 4 tall', () => {
    expect([image.width, image.height]).toEqual([32, 20]);
    expect(image.rgba.length).toBe(32 * 20 * 4);
  });

  it('repeats every source pixel as a 4 by 4 block of the same RGBA, at a pitch of 8 plus the gutter', () => {
    for (let row = 0; row < 2; row++) for (let column = 0; column < 3; column++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const from = ((row * 2 + Math.floor(y / 4)) * 6 + column * 2 + Math.floor(x / 4)) * 4;
      expect(pixel(image, 12 * column + x, 12 * row + y), `cell ${row},${column} pixel ${x},${y}`).toEqual([...sheet.subarray(from, from + 4)]);
    }
  });

  it('fills the gutter columns 8 to 11 and 20 to 23 and the rows 8 to 11 with opaque grey, crossings included', () => {
    for (let y = 0; y < 20; y++) for (const x of [8, 9, 10, 11, 20, 21, 22, 23]) expect(pixel(image, x, y), `${x},${y}`).toEqual(GREY);
    for (let x = 0; x < 32; x++) for (const y of [8, 9, 10, 11]) expect(pixel(image, x, y), `${x},${y}`).toEqual(GREY);
  });

  it('starts at the first cell with no outer margin, and keeps a transparent source pixel as 16 pixels of 0, 0, 0, 0', () => {
    expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 0]);
    let clear = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (pixel(image, x, y).every(v => v === 0)) clear++;
    expect(clear).toBe(16);
    // The next source pixel is opaque and starts at column 4, so the first cell is not preceded by a gutter.
    expect(pixel(image, 4, 0)).toEqual([...sheet.subarray(4, 8)]);
  });

  it('is exactly the cell scaled 4 times, with no gutter, for one direction and one phase', () => {
    const one = syntheticSheet(3, 1, 1), scaled = composeContactSheet(one, { cell: 3, directions: 1, phases: 1 });
    expect([scaled.width, scaled.height]).toEqual([12, 12]);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      const from = (Math.floor(y / 4) * 3 + Math.floor(x / 4)) * 4;
      expect(pixel(scaled, x, y)).toEqual([...one.subarray(from, from + 4)]);
    }
  });

  it('does not change the sheet it reads', () => {
    expect(sheet.equals(syntheticSheet(2, 2, 3))).toBe(true);
  });

  it('refuses a sheet whose length does not match the layout', () => {
    expect(() => composeContactSheet(Buffer.alloc(10), { cell: 2, directions: 2, phases: 3 })).toThrow(expect.objectContaining({ code: 'SPRITE_CONTACT_INVALID' }));
  });
});

describe('the contact sheet size', () => {
  it('gives 16444 by 8220 for cell 256, 8 directions and 16 phases, and 1564 by 1564 for the defaults', () => {
    expect(contactSize({ cell: 256, directions: 8, phases: 16 })).toEqual({ width: 16444, height: 8220 });
    expect(contactSize({ cell: 48, directions: 8, phases: 8 })).toEqual({ width: 1564, height: 1564 });
  });

  it('bounds the contact sheet at the largest plain sheet, 16384 by 8192 pixels', () => {
    expect(CONTACT_MAX_PIXELS).toBe(16384 * 8192);
    const inside = contactSize({ cell: 256, directions: 8, phases: 8 }), over = contactSize({ cell: 256, directions: 8, phases: 16 });
    expect(inside.width * inside.height).toBe(67_568_400);
    expect(inside.width * inside.height).toBeLessThanOrEqual(CONTACT_MAX_PIXELS);
    expect(over.width * over.height).toBeGreaterThan(CONTACT_MAX_PIXELS);
  });
});
