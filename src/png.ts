import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A dependency-free PNG codec for one format: 8-bit RGBA, non-interlaced.
 * The encoder writes filter 0 on every row and compresses with `zlib.deflateSync` at level 9, so equal pixels give equal bytes.
 * The decoder reads the same format, checks the signature and every chunk CRC, and undoes all five row filters.
 * Anything else (other bit depths or colour types, interlacing) is refused with `PNG_UNSUPPORTED`.
 */
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Buffer;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 of the bytes, as PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngError(message: string, code: 'PNG_INVALID' | 'PNG_UNSUPPORTED' | 'PNG_SIZE_MISMATCH'): Error {
  return Object.assign(new Error(message), { code });
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff)
    throw pngError(`PNG width and height must be positive integers, got ${width} by ${height}`, 'PNG_INVALID');
}

/** Encode row-major RGBA pixels (exactly `width * height * 4` bytes) as an 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  checkDimensions(width, height);
  const stride = width * 4;
  if (rgba.length !== stride * height)
    throw pngError(`PNG pixel data is ${rgba.length} bytes, expected ${stride * height} for ${width} by ${height} RGBA`, 'PNG_SIZE_MISMATCH');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA; compression, filter and interlace methods stay 0
  const raw = Buffer.alloc((stride + 1) * height); // each row starts with filter type 0 (None)
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Decode an 8-bit RGBA non-interlaced PNG, checking the signature, the chunk order and every CRC. */
export function decodePng(bytes: Uint8Array): PngImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    throw pngError('Not a PNG: the 8-byte signature is missing', 'PNG_INVALID');
  let width = 0, height = 0, sawHeader = false, sawEnd = false;
  const data: Buffer[] = [];
  let pos = 8;
  while (pos < buffer.length && !sawEnd) {
    if (pos + 12 > buffer.length) throw pngError('PNG is truncated inside a chunk header', 'PNG_INVALID');
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + length > buffer.length) throw pngError(`PNG is truncated inside the ${type} chunk`, 'PNG_INVALID');
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (crc32(buffer.subarray(pos + 4, pos + 8 + length)) !== buffer.readUInt32BE(pos + 8 + length))
      throw pngError(`PNG ${type} chunk has a bad CRC`, 'PNG_INVALID');
    if (!sawHeader && type !== 'IHDR') throw pngError('PNG must begin with an IHDR chunk', 'PNG_INVALID');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw pngError('PNG has a malformed IHDR chunk', 'PNG_INVALID');
      sawHeader = true;
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      checkDimensions(width, height);
      if (body[8] !== 8 || body[9] !== 6 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0)
        throw pngError(`Only 8-bit RGBA non-interlaced PNG is supported (bit depth ${body[8]}, colour type ${body[9]}, interlace ${body[12]})`, 'PNG_UNSUPPORTED');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') sawEnd = true;
    pos += 12 + length;
  }
  if (!sawEnd) throw pngError('PNG has no IEND chunk', 'PNG_INVALID');
  if (!data.length) throw pngError('PNG has no IDAT chunk', 'PNG_INVALID');
  const stride = width * 4;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data)); }
  catch (error) { throw pngError(`PNG image data does not inflate: ${(error as Error).message}`, 'PNG_INVALID'); }
  if (raw.length !== (stride + 1) * height)
    throw pngError(`PNG image data is ${raw.length} bytes, expected ${(stride + 1) * height}`, 'PNG_INVALID');
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw pngError(`PNG row ${y} uses unknown filter ${filter}`, 'PNG_INVALID');
    const row = y * stride, above = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[row + i - 4]! : 0;
      const b = y > 0 ? rgba[above + i]! : 0;
      const c = y > 0 && i >= 4 ? rgba[above + i - 4]! : 0;
      let value = raw[y * (stride + 1) + 1 + i]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[row + i] = value & 255;
    }
  }
  return { width, height, rgba };
}
