// PNG pictures read back into pixels, and made larger pixel for pixel: a screenshot from the community (a device's, colour
// type 3 with a palette or 2, 8 bits; or any PNG someone uploaded) for 203cli screenshots download --scale, and a PNG from the
// device for board screenshot --out FILE.rgb565. Writing them is board.mjs's encodePng. Part of the Agent Skill
// skill/203-community.
import zlib from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Channels a pixel has in each colour type: 0 grey, 2 RGB, 3 a palette index, 4 grey and alpha, 6 RGBA.
const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

export class PngError extends Error {
  constructor(message) { super(message); this.code = "bad_png"; }
}

/** Whether the bytes start with the PNG signature. */
export const isPng = bytes => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

/** A PNG's size from its IHDR (the first chunk): {width, height}, or null when it is not a PNG. */
export function pngSize(bytes) {
  if (!isPng(bytes) || bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const be = at => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  return {width: be(16), height: be(20)};
}

/**
 * A PNG's pixels: {width, height, channels (3 RGB, or 4 RGBA when it has transparency), data}. Every colour type, bit
 * depths 1-16 (16 bits read as their high byte); not interlaced (Adam7 is refused with a PngError).
 */
export function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (!isPng(bytes)) throw new PngError("not a PNG (no PNG signature)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header = null, palette = null, transparency = null;
  const idat = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (data.length < length) throw new PngError(`the ${type} chunk is cut short`);
    if (type === "IHDR") {
      header = {width: view.getUint32(at + 8), height: view.getUint32(at + 12), depth: data[8], type: data[9], interlace: data[12]};
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new PngError("no IHDR chunk");
  const {width, height, depth, type, interlace} = header;
  const channels = CHANNELS[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && ![0, 3].includes(type)) || (type === 3 && depth === 16)) {
    throw new PngError(`colour type ${type} at ${depth} bits is not a PNG colour`);
  }
  if (interlace) throw new PngError("an interlaced PNG (Adam7): 203cli reads only PNGs that are not interlaced");
  if (!width || !height || width * height > 1 << 26) throw new PngError(`a PNG of ${width} × ${height}`);
  if (type === 3 && !palette) throw new PngError("a palette PNG without its palette (PLTE)");
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat.map(d => Buffer.from(d.buffer, d.byteOffset, d.byteLength)))); }
  catch (error) { throw new PngError(`its pixels do not inflate (${error.code || error.message})`); }
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  if (raw.length < (stride + 1) * height) throw new PngError(`${raw.length} bytes of pixels for ${width} × ${height}`);
  // Undo each row's filter (0 none, 1 sub, 2 up, 3 average, 4 Paeth).
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new PngError(`row ${y} has the filter ${filter}`);
      out[i] = v & 255;
    }
  }
  // A sample of channel k of pixel x in row y, as 8 bits.
  const sample = (y, x, k) => {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    if (depth === 8) return row[x * channels + k];
    if (depth === 16) return row[(x * channels + k) * 2];
    const bit = (x * channels + k) * depth;
    const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const sample16 = (y, x, k) => {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    return (row[(x * channels + k) * 2] << 8) | row[(x * channels + k) * 2 + 1];
  };
  const alpha = type === 4 || type === 6 || !!transparency;
  const out = alpha ? 4 : 3;
  const data = new Uint8Array(width * height * out);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * out;
      let r, g, b, a = 255;
      if (type === 3) {
        const index = sample(y, x, 0);
        r = palette[index * 3] ?? 0; g = palette[index * 3 + 1] ?? 0; b = palette[index * 3 + 2] ?? 0;
        if (transparency && index < transparency.length) a = transparency[index];
      } else if (type === 0 || type === 4) {
        r = g = b = sample(y, x, 0);
        if (type === 4) a = sample(y, x, 1);
        else if (transparency?.length >= 2) {
          const key = (transparency[0] << 8) | transparency[1];
          const v = depth === 16 ? sample16(y, x, 0) : depth === 8 ? r : (r * ((1 << depth) - 1)) / 255;
          if (Math.round(v) === key) a = 0;
        }
      } else {
        r = sample(y, x, 0); g = sample(y, x, 1); b = sample(y, x, 2);
        if (type === 6) a = sample(y, x, 3);
        else if (transparency?.length >= 6) {
          const key = [0, 2, 4].map(i => (transparency[i] << 8) | transparency[i + 1]);
          const v = depth === 16 ? [0, 1, 2].map(k => sample16(y, x, k)) : [r, g, b];
          if (v.every((n, i) => n === key[i])) a = 0;
        }
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
      if (alpha) data[o + 3] = a;
    }
  }
  return {width, height, channels: out, data};
}

/** Pixels made `factor` times larger, each one a block of factor × factor (nearest neighbour): {width, height, channels, data}. */
export function scalePixels({width, height, channels, data}, factor) {
  const w = width * factor, h = height * factor;
  const out = new Uint8Array(w * h * channels);
  const row = new Uint8Array(w * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * channels;
      for (let d = 0; d < factor; d++) row.set(data.subarray(from, from + channels), (x * factor + d) * channels);
    }
    for (let d = 0; d < factor; d++) out.set(row, (y * factor + d) * w * channels);
  }
  return {width: w, height: h, channels, data: out};
}

/** 8-bit RGB (3 a pixel) as RGB565, u16 little-endian, red in bits 15-11: the device's raw frame. */
export function rgb565Of({width, height, channels, data}) {
  const out = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
    const p = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[2 * i] = p & 255;
    out[2 * i + 1] = p >> 8;
  }
  return out;
}
