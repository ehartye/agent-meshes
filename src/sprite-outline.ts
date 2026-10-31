/**
 * The one-pixel outer outline for a baked sprite cell, with no renderer and no file access.
 * A transparent pixel with an opaque 4-neighbour becomes the outline colour at alpha 255. The neighbour test reads the
 * input cell only, so the outline never grows further than one pixel and never chains, and neighbours outside the
 * cell count as transparent.
 */
function outlineError(message: string): Error {
  return Object.assign(new Error(message), { code: 'SPRITE_OUTLINE_INVALID' });
}

/**
 * Returns a new row-major RGBA `Buffer` of `cell * cell * 4` bytes with the outer outline added. Opaque pixels are never
 * changed, and transparent pixels that are not on the outline keep their bytes.
 */
export function outlineCell(rgba: Buffer, cell: number, color: readonly [number, number, number]): Buffer {
  if (!Number.isInteger(cell) || cell < 1) throw outlineError(`cell must be a positive integer, got ${cell}`);
  if (rgba.length !== cell * cell * 4) throw outlineError(`The cell buffer holds ${rgba.length} bytes but a ${cell} by ${cell} RGBA cell needs ${cell * cell * 4}`);
  if (color.length !== 3 || color.some(c => !Number.isInteger(c) || c < 0 || c > 255)) throw outlineError(`The outline colour must be three integers from 0 to 255, got ${color.join(', ')}`);
  const out = Buffer.from(rgba);
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < cell && y < cell && rgba[(y * cell + x) * 4 + 3] === 255;
  for (let y = 0; y < cell; y++)
    for (let x = 0; x < cell; x++) {
      if (rgba[(y * cell + x) * 4 + 3] !== 0) continue;
      if (opaque(x, y - 1) || opaque(x, y + 1) || opaque(x - 1, y) || opaque(x + 1, y)) out.set([color[0], color[1], color[2], 255], (y * cell + x) * 4);
    }
  return out;
}
