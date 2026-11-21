/**
 * A dependency-free GIF89a codec for one shape of file: a global colour table, a NETSCAPE2.0 loop block, and every frame
 * as palette indices behind its own graphic control extension, LZW-compressed (variable code size, clear and end codes,
 * a clear when the table reaches 4096 codes).
 * After the first frame the encoder stores only the rectangle that changed, with disposal 1 (leave in place), so a frame
 * decodes to exactly the indices it was given. The decoder reads this shape and composites frames the same way.
 */
export type Rgb = readonly [number, number, number];

export interface GifOptions {
  width: number;
  height: number;
  /** Up to 256 colours; the table is padded with black to a power of two, at least 2. */
  palette: readonly Rgb[];
  /** Delay of every frame in hundredths of a second. */
  delayCs: number;
  /** NETSCAPE2.0 loop count; 0 loops forever. */
  loop: number;
  /**
   * Grow the colour table by one slot, if needed, so later frames can mark unchanged pixels transparent (default false).
   * A spare padding slot is always used this way; this option makes one when the palette fills its power of two.
   */
  reserveTransparent?: boolean;
}

export interface GifFrame {
  /** The composited frame: `width * height` palette indices, row-major. */
  indices: Uint8Array;
  delayCs: number;
  /** The rectangle this frame's image data covers. */
  rect: { left: number; top: number; width: number; height: number };
}

export interface DecodedGif {
  width: number;
  height: number;
  /** The global colour table, padding included. */
  palette: Rgb[];
  /** The NETSCAPE2.0 loop count, or null when there is no loop block. */
  loop: number | null;
  frames: GifFrame[];
}

function gifError(message: string): Error {
  return Object.assign(new Error(message), { code: 'GIF_INVALID' });
}

/** Growable byte output. */
class Bytes {
  private buffer = new Uint8Array(1 << 16);
  length = 0;
  byte(value: number): void {
    if (this.length === this.buffer.length) { const next = new Uint8Array(this.buffer.length * 2); next.set(this.buffer); this.buffer = next; }
    this.buffer[this.length++] = value & 255;
  }
  word(value: number): void { this.byte(value); this.byte(value >> 8); }
  bytes(values: ArrayLike<number>): void { for (let i = 0; i < values.length; i++) this.byte(values[i]!); }
  result(): Uint8Array { return this.buffer.slice(0, this.length); }
}

/** LZW-compress `indices` with the given minimum code size and write it as data sub-blocks, ending with the terminator. */
function writeLzw(out: Bytes, indices: Uint8Array, minCodeSize: number): void {
  const clearCode = 1 << minCodeSize, endCode = clearCode + 1;
  const table = new Int16Array(4096 << 8).fill(-1);
  let codeSize = minCodeSize + 1, nextCode = endCode + 1;
  const block = new Uint8Array(255);
  let blockLength = 0, bits = 0, bitCount = 0;
  const flushByte = (value: number) => { block[blockLength++] = value; if (blockLength === 255) { out.byte(255); out.bytes(block); blockLength = 0; } };
  const emit = (code: number) => {
    bits |= code << bitCount; bitCount += codeSize;
    while (bitCount >= 8) { flushByte(bits & 255); bits >>>= 8; bitCount -= 8; }
  };
  out.byte(minCodeSize);
  emit(clearCode);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!, key = prefix << 8 | k, code = table[key]!;
    if (code >= 0) { prefix = code; continue; }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      table.fill(-1);
      codeSize = minCodeSize + 1; nextCode = endCode + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table[key] = nextCode++;
    }
    prefix = k;
  }
  emit(prefix);
  // A decoder defines one more entry on reading that last code, and may widen its codes before it reads the end code.
  if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++;
  emit(endCode);
  if (bitCount > 0) flushByte(bits & 255);
  if (blockLength) { out.byte(blockLength); out.bytes(block.subarray(0, blockLength)); }
  out.byte(0);
}

/** The bounding rectangle of the pixels that differ between two frames, or a 1 by 1 rectangle when none do. */
function changedRect(previous: Uint8Array, frame: Uint8Array, width: number, height: number): GifFrame['rect'] {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) if (previous[row + x] !== frame[row + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? { left: 0, top: 0, width: 1, height: 1 } : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Encode frames of palette indices as a looping GIF89a with a global colour table. */
export function encodeGif(frames: readonly Uint8Array[], options: GifOptions): Uint8Array {
  const { width, height, palette, delayCs, loop } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 0xffff || height > 0xffff)
    throw gifError(`GIF width and height must be integers from 1 to 65535, got ${width} by ${height}`);
  if (!frames.length) throw gifError('A GIF needs at least one frame');
  if (!palette.length || palette.length > 256) throw gifError(`A GIF palette holds 1 to 256 colours, got ${palette.length}`);
  if (!Number.isInteger(delayCs) || delayCs < 0 || delayCs > 0xffff) throw gifError(`GIF delay must be an integer from 0 to 65535 hundredths of a second, got ${delayCs}`);
  if (!Number.isInteger(loop) || loop < 0 || loop > 0xffff) throw gifError(`GIF loop count must be an integer from 0 to 65535, got ${loop}`);
  const area = width * height;
  frames.forEach((frame, n) => {
    if (frame.length !== area) throw gifError(`GIF frame ${n} has ${frame.length} indices, expected ${area} for ${width} by ${height}`);
    for (let i = 0; i < area; i++) if (frame[i]! >= palette.length) throw gifError(`GIF frame ${n} has index ${frame[i]} at pixel ${i}, outside the ${palette.length}-colour palette`);
  });
  const slots = palette.length + (options.reserveTransparent && frames.length > 1 && palette.length < 256 ? 1 : 0);
  let bitsPerEntry = 1;
  while (1 << bitsPerEntry < slots) bitsPerEntry++;
  const out = new Bytes();
  out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  out.word(width); out.word(height);
  out.byte(0x80 | (bitsPerEntry - 1) << 4 | (bitsPerEntry - 1)); // global table, colour resolution, table size
  out.byte(0); out.byte(0); // background index, pixel aspect ratio
  for (let i = 0; i < 1 << bitsPerEntry; i++) { const [r, g, b] = palette[i] ?? [0, 0, 0]; out.byte(r); out.byte(g); out.byte(b); }
  out.bytes([0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', c => c.charCodeAt(0)), 3, 1]); out.word(loop); out.byte(0);
  const minCodeSize = Math.max(2, bitsPerEntry);
  // A spare padding slot marks the pixels a later frame leaves unchanged as transparent, which compresses to long runs.
  const clear = palette.length < 1 << bitsPerEntry ? palette.length : -1;
  frames.forEach((frame, n) => {
    const rect = n === 0 ? { left: 0, top: 0, width, height } : changedRect(frames[n - 1]!, frame, width, height);
    const keep = n > 0 && clear >= 0;
    out.bytes([0x21, 0xf9, 4, 1 << 2 | (keep ? 1 : 0)]); out.word(delayCs); out.byte(keep ? clear : 0); out.byte(0); // disposal 1 (leave in place)
    out.byte(0x2c); out.word(rect.left); out.word(rect.top); out.word(rect.width); out.word(rect.height); out.byte(0);
    let data = frame;
    if (rect.width !== width || rect.height !== height) {
      data = new Uint8Array(rect.width * rect.height);
      for (let y = 0; y < rect.height; y++) data.set(frame.subarray((rect.top + y) * width + rect.left, (rect.top + y) * width + rect.left + rect.width), y * rect.width);
    }
    if (keep) {
      const previous = frames[n - 1]!;
      if (data === frame) data = frame.slice();
      for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
        const at = (rect.top + y) * width + rect.left + x;
        if (previous[at] === frame[at]) data[y * rect.width + x] = clear;
      }
    }
    writeLzw(out, data, minCodeSize);
  });
  out.byte(0x3b);
  return out.result();
}

/** Decode LZW image data of `count` pixels from concatenated sub-block bytes. */
function readLzw(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clearCode = 1 << minCodeSize, endCode = clearCode + 1;
  const prefixes = new Int16Array(4096), suffixes = new Uint8Array(4096), lengths = new Uint16Array(4096);
  for (let i = 0; i < clearCode; i++) { prefixes[i] = -1; suffixes[i] = i; lengths[i] = 1; }
  let codeSize = minCodeSize + 1, nextCode = endCode + 1, previous = -1, written = 0;
  let bits = 0, bitCount = 0, pos = 0;
  const writeCode = (code: number) => {
    const length = lengths[code]!;
    if (written + length > count) throw gifError('GIF image data holds more pixels than its rectangle');
    for (let c = code, at = written + length - 1; at >= written; at--) { out[at] = suffixes[c]!; c = prefixes[c]!; }
    written += length;
  };
  const first = (code: number) => { let c = code; while (prefixes[c]! >= 0) c = prefixes[c]!; return suffixes[c]!; };
  for (;;) {
    while (bitCount < codeSize) { if (pos >= data.length) throw gifError('GIF image data ends without an end code'); bits |= data[pos++]! << bitCount; bitCount += 8; }
    const code = bits & (1 << codeSize) - 1; bits >>>= codeSize; bitCount -= codeSize;
    if (code === clearCode) { codeSize = minCodeSize + 1; nextCode = endCode + 1; previous = -1; continue; }
    if (code === endCode) break;
    if (previous < 0) {
      if (code >= clearCode) throw gifError(`GIF image data starts with code ${code}`);
      writeCode(code); previous = code; continue;
    }
    if (code > nextCode || (code === nextCode && nextCode === 4096)) throw gifError(`GIF image data has code ${code} before it is defined`);
    const known = code < nextCode;
    if (nextCode < 4096) {
      prefixes[nextCode] = previous; suffixes[nextCode] = first(known ? code : previous); lengths[nextCode] = lengths[previous]! + 1;
      nextCode++;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    writeCode(code);
    previous = code;
  }
  if (written !== count) throw gifError(`GIF image data holds ${written} pixels, expected ${count}`);
  return out;
}

/** Decode a GIF written by `encodeGif` (or any GIF with a global colour table and no interlacing), compositing each frame. */
export function decodeGif(bytes: Uint8Array): DecodedGif {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF89a' && header !== 'GIF87a') throw gifError('Not a GIF: the GIF89a header is missing');
  let pos = 6;
  const u16 = () => { const value = bytes[pos]! | bytes[pos + 1]! << 8; pos += 2; return value; };
  const need = (n: number) => { if (pos + n > bytes.length) throw gifError('GIF is truncated'); };
  need(7);
  const width = u16(), height = u16(), packed = bytes[pos]!; pos += 3;
  if (!(packed & 0x80)) throw gifError('GIF has no global colour table');
  const entries = 1 << ((packed & 7) + 1);
  need(entries * 3);
  const palette: Rgb[] = Array.from({ length: entries }, (_, i) => [bytes[pos + i * 3]!, bytes[pos + i * 3 + 1]!, bytes[pos + i * 3 + 2]!] as Rgb);
  pos += entries * 3;
  const subBlocks = () => {
    const parts: Uint8Array[] = [];
    for (;;) { need(1); const size = bytes[pos++]!; if (!size) break; need(size); parts.push(bytes.subarray(pos, pos + size)); pos += size; }
    return parts;
  };
  let loop: number | null = null, delayCs = 0, disposal = 0, transparent = -1;
  const frames: GifFrame[] = [];
  let canvas = new Uint8Array(width * height);
  for (;;) {
    need(1);
    const introducer = bytes[pos++]!;
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      need(1);
      const label = bytes[pos++]!, parts = subBlocks();
      if (label === 0xf9 && parts[0] && parts[0].length >= 4) { disposal = parts[0][0]! >> 2 & 7; delayCs = parts[0][1]! | parts[0][2]! << 8; transparent = parts[0][0]! & 1 ? parts[0][3]! : -1; }
      if (label === 0xff && parts[0] && String.fromCharCode(...parts[0]) === 'NETSCAPE2.0' && parts[1]?.[0] === 1) loop = parts[1][1]! | parts[1][2]! << 8;
      continue;
    }
    if (introducer !== 0x2c) throw gifError(`GIF has an unknown block 0x${introducer.toString(16)} at byte ${pos - 1}`);
    need(9);
    const rect = { left: u16(), top: u16(), width: u16(), height: u16() };
    const flags = bytes[pos++]!;
    if (flags & 0x80) throw gifError('GIF frame has a local colour table, which this decoder does not read');
    if (flags & 0x40) throw gifError('GIF frame is interlaced, which this decoder does not read');
    if (rect.left + rect.width > width || rect.top + rect.height > height) throw gifError('GIF frame lies outside the logical screen');
    need(1);
    const minCodeSize = bytes[pos++]!;
    const parts = subBlocks();
    const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0; for (const part of parts) { data.set(part, at); at += part.length; }
    const pixels = readLzw(data, minCodeSize, rect.width * rect.height);
    const before = canvas.slice();
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      const value = pixels[y * rect.width + x]!;
      if (value !== transparent) canvas[(rect.top + y) * width + rect.left + x] = value;
    }
    frames.push({ indices: canvas.slice(), delayCs, rect });
    if (disposal === 3) canvas = before;
    else if (disposal === 2) for (let y = 0; y < rect.height; y++) canvas.fill(0, (rect.top + y) * width + rect.left, (rect.top + y) * width + rect.left + rect.width);
    delayCs = 0; disposal = 0; transparent = -1;
  }
  return { width, height, palette, loop, frames };
}

/** Map each RGBA pixel to the index of the nearest palette colour (squared RGB distance; alpha is ignored). */
export function quantize(rgba: Uint8Array, palette: readonly Rgb[]): Uint8Array {
  if (!palette.length || palette.length > 256) throw gifError(`A GIF palette holds 1 to 256 colours, got ${palette.length}`);
  const out = new Uint8Array(rgba.length >> 2);
  const cache = new Map<number, number>();
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!, key = r << 16 | g << 8 | b;
    let best = cache.get(key);
    if (best === undefined) {
      let distance = Infinity; best = 0;
      for (let c = 0; c < palette.length; c++) {
        const [pr, pg, pb] = palette[c]!, d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (d < distance) { distance = d; best = c; }
      }
      cache.set(key, best);
    }
    out[p] = best;
  }
  return out;
}
