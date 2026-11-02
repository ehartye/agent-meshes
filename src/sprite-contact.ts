/**
 * The review image of a baked sprite sheet, with no renderer and no file access: every cell scaled 4 times by nearest
 * neighbour, one row per direction and one column per phase, with a 4-pixel mid-grey gutter between neighbouring cells
 * (not around the grid). Cell pixels are copied unchanged, alpha included, so a transparent pixel stays 0, 0, 0, 0 and
 * the gutter is what marks the cell edges. There are no labels, because the PNG module draws no text.
 */
export const CONTACT_SCALE = 4;
export const CONTACT_GUTTER = 4;
/** The gutter colour: opaque mid-grey. */
export const CONTACT_GREY = [128, 128, 128, 255] as const;
/** Most pixels a contact sheet may have: 16384 by 8192, the largest plain sheet the bake accepts. */
export const CONTACT_MAX_PIXELS = 134_217_728;

export interface ContactLayout { cell: number; directions: number; phases: number }

/** Width and height of the contact sheet for a sheet of `phases` columns and `directions` rows of `cell` pixels. */
export function contactSize({ cell, directions, phases }: ContactLayout): { width: number; height: number } {
  const pitch = (count: number) => count * CONTACT_SCALE * cell + (count - 1) * CONTACT_GUTTER;
  return { width: pitch(phases), height: pitch(directions) };
}

/** `sheet` is the finished sheet as row-major RGBA, `phases * cell` wide and `directions * cell` tall. Returns a new RGBA buffer. */
export function composeContactSheet(sheet: Uint8Array, layout: ContactLayout): { width: number; height: number; rgba: Buffer } {
  const { cell, directions, phases } = layout;
  const sheetWidth = phases * cell;
  if (sheet.length !== sheetWidth * directions * cell * 4) throw Object.assign(new Error(`A sheet of ${phases} by ${directions} cells of ${cell} pixels needs ${sheetWidth * directions * cell * 4} bytes, got ${sheet.length}`), { code: 'SPRITE_CONTACT_INVALID' });
  const { width, height } = contactSize(layout);
  const rgba = Buffer.alloc(width * height * 4);
  // Fill with the gutter colour; every cell block then overwrites its own area.
  for (let i = 0; i < rgba.length; i += 4) rgba.set(CONTACT_GREY, i);
  const block = CONTACT_SCALE * cell + CONTACT_GUTTER;
  for (let row = 0; row < directions; row++) for (let column = 0; column < phases; column++) {
    const left = column * block, top = row * block;
    for (let y = 0; y < cell * CONTACT_SCALE; y++) {
      const from = ((row * cell + Math.floor(y / CONTACT_SCALE)) * sheetWidth + column * cell) * 4, to = ((top + y) * width + left) * 4;
      for (let x = 0; x < cell * CONTACT_SCALE; x++) {
        const source = from + Math.floor(x / CONTACT_SCALE) * 4;
        rgba[to + x * 4] = sheet[source]; rgba[to + x * 4 + 1] = sheet[source + 1]; rgba[to + x * 4 + 2] = sheet[source + 2]; rgba[to + x * 4 + 3] = sheet[source + 3];
      }
    }
  }
  return { width, height, rgba };
}
