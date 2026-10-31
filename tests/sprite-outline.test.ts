/** @lane merge
 * @subject src/sprite-outline.ts
 */
import { describe, expect, it } from 'vitest';
import { outlineCell } from '../src/sprite-outline.ts';

const SOLID: [number, number, number, number] = [200, 60, 40, 255];
const OUTLINE: [number, number, number] = [20, 12, 28];

/** A cell with the given opaque rectangle (x, y, w, h) filled with `SOLID` and every other pixel 0, 0, 0, 0. */
function cellWith(cell: number, ...blocks: [number, number, number, number][]): Buffer {
  const rgba = Buffer.alloc(cell * cell * 4);
  for (const [bx, by, bw, bh] of blocks) for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) rgba.set(SOLID, (y * cell + x) * 4);
  return rgba;
}
const pixel = (rgba: Buffer, cell: number, x: number, y: number): number[] => [...rgba.subarray((y * cell + x) * 4, (y * cell + x) * 4 + 4)];
/** The coordinates of every pixel that differs between two buffers, as "x,y" strings in row-major order. */
function changed(before: Buffer, after: Buffer, cell: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < cell * cell; i++) if (!before.subarray(i * 4, i * 4 + 4).equals(after.subarray(i * 4, i * 4 + 4))) out.push(`${i % cell},${Math.floor(i / cell)}`);
  return out;
}

describe('outer outline', () => {
  it('adds exactly the 12 edge neighbours of a 3 by 3 block and nothing on the interior or the corners', () => {
    const cell = 7;
    const before = cellWith(cell, [2, 2, 3, 3]);
    const after = outlineCell(before, cell, OUTLINE);
    const expected = [
      '2,1', '3,1', '4,1', // above
      '2,5', '3,5', '4,5', // below
      '1,2', '1,3', '1,4', // left
      '5,2', '5,3', '5,4', // right
    ].sort();
    expect(changed(before, after, cell).sort()).toEqual(expected);
    for (const key of expected) {
      const [x, y] = key.split(',').map(Number);
      expect(pixel(after, cell, x!, y!)).toEqual([...OUTLINE, 255]);
    }
    // The four diagonal corners stay transparent, so the outline did not grow diagonally.
    for (const [x, y] of [[1, 1], [5, 1], [1, 5], [5, 5]] as const) expect(pixel(after, cell, x, y)).toEqual([0, 0, 0, 0]);
    // The 3 by 3 interior keeps its colour.
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) expect(pixel(after, cell, x, y)).toEqual(SOLID);
  });

  it('does not chain: a second ring is never added around the first', () => {
    const cell = 9;
    const before = cellWith(cell, [3, 3, 3, 3]);
    const after = outlineCell(before, cell, OUTLINE);
    for (const [x, y] of [[3, 0], [4, 0], [5, 0], [3, 1], [0, 4], [1, 4], [7, 4], [8, 4], [4, 7], [4, 8]] as const) expect(pixel(after, cell, x, y)).toEqual([0, 0, 0, 0]);
    expect(changed(before, after, cell)).toHaveLength(12);
    // Outlining the result again adds a further ring, which shows the first call used the input only.
    expect(changed(after, outlineCell(after, cell, OUTLINE), cell)).toHaveLength(16);
  });

  it('outlines a single opaque pixel with its four neighbours only', () => {
    const cell = 5;
    const before = cellWith(cell, [2, 2, 1, 1]);
    expect(changed(before, outlineCell(before, cell, OUTLINE), cell).sort()).toEqual(['1,2', '2,1', '2,3', '3,2']);
  });

  it('leaves a transparent cell and a fully opaque cell unchanged', () => {
    const blank = Buffer.alloc(4 * 4 * 4);
    expect(outlineCell(blank, 4, OUTLINE).equals(blank)).toBe(true);
    const full = cellWith(4, [0, 0, 4, 4]);
    expect(outlineCell(full, 4, OUTLINE).equals(full)).toBe(true);
  });

  it('treats the outside of the cell as transparent: a block on the border adds nothing outside and keeps its own edge', () => {
    const cell = 6;
    const before = cellWith(cell, [0, 0, 3, 3]);
    const after = outlineCell(before, cell, OUTLINE);
    expect(after.length).toBe(before.length);
    expect(changed(before, after, cell).sort()).toEqual(['0,3', '1,3', '2,3', '3,0', '3,1', '3,2']);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) expect(pixel(after, cell, x, y)).toEqual(SOLID);
    expect(pixel(after, cell, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('outlines the cell border ring itself when the model sits one pixel inside it', () => {
    const cell = 6;
    const before = cellWith(cell, [1, 1, 4, 4]);
    const after = outlineCell(before, cell, OUTLINE);
    const ring: string[] = [];
    for (let i = 1; i < 5; i++) ring.push(`${i},0`, `${i},5`, `0,${i}`, `5,${i}`);
    expect(changed(before, after, cell).sort()).toEqual(ring.sort());
    for (const key of ring) {
      const [x, y] = key.split(',').map(Number);
      expect(pixel(after, cell, x!, y!)).toEqual([...OUTLINE, 255]);
    }
    for (const [x, y] of [[0, 0], [5, 0], [0, 5], [5, 5]] as const) expect(pixel(after, cell, x, y)).toEqual([0, 0, 0, 0]);
  });

  it('fills a one-pixel gap between two shapes', () => {
    const cell = 7;
    const before = cellWith(cell, [1, 2, 2, 2], [4, 2, 2, 2]);
    const after = outlineCell(before, cell, OUTLINE);
    expect(pixel(after, cell, 3, 2)).toEqual([...OUTLINE, 255]);
    expect(pixel(after, cell, 3, 3)).toEqual([...OUTLINE, 255]);
  });

  it('never changes an opaque pixel and keeps every other transparent pixel at 0, 0, 0, 0', () => {
    const cell = 8;
    const before = cellWith(cell, [2, 2, 3, 3], [5, 5, 1, 1]);
    const after = outlineCell(before, cell, OUTLINE);
    for (let i = 0; i < cell * cell; i++) {
      const was = [...before.subarray(i * 4, i * 4 + 4)], now = [...after.subarray(i * 4, i * 4 + 4)];
      if (was[3] === 255) expect(now).toEqual(was);
      else expect(now).toEqual(now[3] === 255 ? [...OUTLINE, 255] : [0, 0, 0, 0]);
    }
  });

  it('returns a new buffer and leaves the input as it was', () => {
    const cell = 5;
    const before = cellWith(cell, [2, 2, 1, 1]);
    const copy = Buffer.from(before);
    const after = outlineCell(before, cell, OUTLINE);
    expect(after).not.toBe(before);
    expect(before.equals(copy)).toBe(true);
  });

  it('does not count a partly transparent pixel as a neighbour', () => {
    const cell = 3;
    const before = Buffer.alloc(cell * cell * 4);
    before.set([200, 60, 40, 128], (1 * cell + 1) * 4);
    expect(outlineCell(before, cell, OUTLINE).equals(before)).toBe(true);
  });

  it('uses the colour it is given', () => {
    const cell = 3;
    const after = outlineCell(cellWith(cell, [1, 1, 1, 1]), cell, [1, 2, 3]);
    expect(pixel(after, cell, 1, 0)).toEqual([1, 2, 3, 255]);
  });

  it.each([
    [0], [2.5], [-1],
  ])('rejects the cell size %j', cell => {
    expect(() => outlineCell(Buffer.alloc(0), cell, OUTLINE)).toThrowError(expect.objectContaining({ code: 'SPRITE_OUTLINE_INVALID', message: expect.stringMatching(/cell/) }));
  });

  it('rejects a buffer of the wrong length and a bad colour', () => {
    expect(() => outlineCell(Buffer.alloc(4 * 4 * 4 - 4), 4, OUTLINE)).toThrow(/needs 64/);
    expect(() => outlineCell(Buffer.alloc(64), 4, [0, 0, 256])).toThrow(/outline colour/);
    expect(() => outlineCell(Buffer.alloc(64), 4, [0, 1.5, 2])).toThrow(/outline colour/);
  });
});
