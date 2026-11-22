// The community's standard picture for a firmware's cover and gallery (COMMUNITY.md "Pictures", the user 2026-11-20:
// "带一个统一背景图层背景，然后中间是这个截图的屏幕的截图的样式，或者中间是设计的样式，这种是最好的"): 1280 x 720, one flat
// colour, a dark bezel, and in it the device's 240 x 135 screen at 4 times, nearest neighbour (or a design of 960 x 540).
// Pure: a PNG decoder (zlib's inflate and the five filters), the frame drawn into RGB, board.mjs's PNG encoder.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {encodePng} from "./board.mjs";
import {CliError, EXIT, usage} from "./guide.mjs";

export const STANDARD_URL = "https://cardenza.203.io/community/guide/images";
export const TEMPLATE_URL = "https://cardenza.203.io/community/guide/images/template.svg";

/** The standard's numbers (the community's /guide/images and its template.svg draw the same). */
export const FRAME = Object.freeze({
  width: 1280, height: 720,
  bezel: "#1A1C1E", band: 32, radius: 32,               // the bezel: a 32 px band around the screen, its outer corners round
  screen: Object.freeze({x: 160, y: 90, width: 960, height: 540}),
  device: Object.freeze({width: 240, height: 135, scale: 4}),
});

/** Background colours to choose from (a firmware's own colour is better: --color '#RRGGBB'). */
export const COLORS = Object.freeze({
  orange: "#E85A2C", amber: "#F2A33A", mint: "#34C3A0", blue: "#3B82E6", violet: "#7B5CF0", grey: "#8C9096", paper: "#E9E5DC",
});
export const DEFAULT_COLOR = "orange";

/** A colour: a name of COLORS or #RGB / #RRGGBB (the # optional) → {hex, rgb}; null when it is neither. */
export function parseColor(text = DEFAULT_COLOR) {
  const s = String(text).trim().toLowerCase();
  const hex = COLORS[s] ?? (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(s) ? "#" + s.replace(/^#/, "") : null);
  if (!hex) return null;
  const h = hex.length === 4 ? "#" + [...hex.slice(1)].map(c => c + c).join("") : hex;
  return {hex: h.toUpperCase(), rgb: [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))};
}

// ---------------------------------------------------------------------------------------------
// PNG decoding: every colour type and bit depth, not interlaced; alpha laid over black (the screen's black).

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const MAX_SIDE = 8192;

export class PictureError extends Error {
  constructor(message) { super(message); this.name = "PictureError"; }
}

/** A PNG's bytes → {width, height, rgb} (8-bit RGB, alpha over black). Throws PictureError with a plain reason. */
export function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8 || SIGNATURE.some((v, i) => b[i] !== v)) throw new PictureError("it is not a PNG (a screenshot is saved as PNG)");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8, header = null, palette = null, trns = null;
  const data = [];
  while (at + 8 <= b.length) {
    const length = view.getUint32(at), type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const body = b.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new PictureError("the PNG is cut short");
    if (type === "IHDR") {
      header = {width: view.getUint32(at + 8), height: view.getUint32(at + 12), depth: b[at + 16], type: b[at + 17], interlace: b[at + 20]};
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new PictureError("the PNG has no header");
  const {width, height, depth, type, interlace} = header;
  const channels = CHANNELS[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && depth > 8) || ((type === 2 || type === 4 || type === 6) && depth < 8))
    throw new PictureError(`the PNG's colour type ${type} at ${depth} bits is not valid`);
  if (interlace) throw new PictureError("it is an interlaced PNG: save it again without interlacing");
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) throw new PictureError(`${width} × ${height} is not a picture size this reads (at most ${MAX_SIDE} a side)`);
  if (type === 3 && !palette) throw new PictureError("the PNG has a palette colour type but no palette");
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(data.map(d => Buffer.from(d.buffer, d.byteOffset, d.byteLength)))); } catch {
    throw new PictureError("the PNG's pixel data is damaged");
  }
  const bitsPerPixel = channels * depth, stride = Math.ceil(width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) throw new PictureError("the PNG's pixel data is short");
  // Unfilter row by row (None, Sub, Up, Average, Paeth).
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, out = y * stride, prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[out + x - bpp] : 0, up = y ? rows[prev + x] : 0, c = x >= bpp && y ? rows[prev + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (filter !== 0) throw new PictureError(`the PNG's row ${y} has an unknown filter ${filter}`);
      rows[out + x] = v;
    }
  }
  // Samples to 8-bit RGB over black.
  const sample = (row, i) => {     // the i-th sample of a row at the PNG's depth, as 0..255 (or the index, for a palette)
    if (depth === 8) return rows[row + i];
    if (depth === 16) return rows[row + 2 * i];
    const perByte = 8 / depth, byte = rows[row + Math.floor(i / perByte)], shift = 8 - depth * (i % perByte + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round(v * 255 / ((1 << depth) - 1));
  };
  const trnsKey = trns && (type === 0 || type === 2) ? (type === 0 ? [trns[1]] : [trns[1], trns[3], trns[5]]) : null;   // low bytes (8-bit)
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      let r, g, bl, alpha = 255;
      if (type === 3) {
        const index = sample(row, x);
        if (3 * index + 2 >= palette.length) throw new PictureError("a pixel names a colour the palette does not have");
        r = palette[3 * index]; g = palette[3 * index + 1]; bl = palette[3 * index + 2];
        if (trns && index < trns.length) alpha = trns[index];
      } else if (type === 0 || type === 4) {
        r = g = bl = sample(row, x * channels);
        if (type === 4) alpha = sample(row, x * channels + 1);
        else if (trnsKey && depth === 8 && r === trnsKey[0]) alpha = 0;
      } else {
        r = sample(row, x * channels); g = sample(row, x * channels + 1); bl = sample(row, x * channels + 2);
        if (type === 6) alpha = sample(row, x * channels + 3);
        else if (trnsKey && depth === 8 && r === trnsKey[0] && g === trnsKey[1] && bl === trnsKey[2]) alpha = 0;
      }
      const o = 3 * (y * width + x);
      if (alpha === 255) { rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = bl; } else {
        rgb[o] = Math.round(r * alpha / 255); rgb[o + 1] = Math.round(g * alpha / 255); rgb[o + 2] = Math.round(bl * alpha / 255);
      }
    }
  }
  return {width, height, rgb};
}

// ---------------------------------------------------------------------------------------------
// The screen area: 960 x 540 from a picture of 240 x 135 times k.

/** True when every k x k block of the picture is one colour (a screen enlarged k times, nearest neighbour). */
function blocky({width, height, rgb}, k) {
  if (k === 1) return true;
  for (let y = 0; y < height; y++) {
    const top = y - (y % k);
    for (let x = 0; x < width; x++) {
      const o = 3 * (y * width + x), s = 3 * (top * width + x - (x % k));
      if (rgb[o] !== rgb[s] || rgb[o + 1] !== rgb[s + 1] || rgb[o + 2] !== rgb[s + 2]) return false;
    }
  }
  return true;
}

/** Resample to w x h by area (each output pixel the average of what it covers): whole-number scales are exact. */
function resample(src, w, h) {
  const axis = (from, to) => {         // for each output pixel: [[source index, weight], …], weights summing to 1
    const scale = from / to, list = [];
    for (let i = 0; i < to; i++) {
      const a = i * scale, z = (i + 1) * scale, parts = [];
      for (let s = Math.floor(a); s < Math.min(from, Math.ceil(z)); s++) {
        const weight = Math.min(z, s + 1) - Math.max(a, s);
        if (weight > 1e-9) parts.push([s, weight / scale]);
      }
      list.push(parts);
    }
    return list;
  };
  const xs = axis(src.width, w), ys = axis(src.height, h);
  const mid = new Float64Array(w * src.height * 3);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < w; x++) for (const [s, weight] of xs[x]) {
    const i = 3 * (y * src.width + s), o = 3 * (y * w + x);
    mid[o] += src.rgb[i] * weight; mid[o + 1] += src.rgb[i + 1] * weight; mid[o + 2] += src.rgb[i + 2] * weight;
  }
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, bl = 0;
    for (const [s, weight] of ys[y]) { const i = 3 * (s * w + x); r += mid[i] * weight; g += mid[i + 1] * weight; bl += mid[i + 2] * weight; }
    const o = 3 * (y * w + x);
    rgb[o] = Math.min(255, Math.round(r)); rgb[o + 1] = Math.min(255, Math.round(g)); rgb[o + 2] = Math.min(255, Math.round(bl));
  }
  return {width: w, height: h, rgb};
}

/**
 * What goes in the screen area: the picture must be the screen's shape at a whole multiple (240 x 135 times k). A screen
 * (every k x k block one colour) is taken back to 240 x 135 and enlarged 4 times, nearest neighbour; any other picture
 * of that shape (a design) is resampled to 960 x 540. → {plan: {kind: "screen"|"design", factor}, area: {width, height, rgb}}
 */
export function screenArea(img) {
  const {width: dw, height: dh, scale} = FRAME.device;
  const k = img.width / dw;
  if (!Number.isInteger(k) || img.height !== dh * k) {
    const done = img.width === FRAME.width && img.height === FRAME.height;
    throw new PictureError(`it is ${img.width} × ${img.height}: ${done ? "that is already the standard picture's size (1280 × 720), nothing to frame" :
      `the screen is ${dw} × ${dh}; take the screenshot whole (${dw} × ${dh}, or a whole multiple such as ${dw * scale} × ${dh * scale}), not cropped or resized`}`);
  }
  if (k > 16) throw new PictureError(`it is ${img.width} × ${img.height}: at most 16 times the screen (${dw * 16} × ${dh * 16})`);
  const {width: aw, height: ah} = FRAME.screen;
  if (blocky(img, k)) {
    const rgb = new Uint8Array(aw * ah * 3);
    for (let y = 0; y < ah; y++) {
      const sy = Math.floor(y / scale) * k;
      for (let x = 0; x < aw; x++) {
        const sx = Math.floor(x / scale) * k, i = 3 * (sy * img.width + sx), o = 3 * (y * aw + x);
        rgb[o] = img.rgb[i]; rgb[o + 1] = img.rgb[i + 1]; rgb[o + 2] = img.rgb[i + 2];
      }
    }
    return {plan: {kind: "screen", factor: k}, area: {width: aw, height: ah, rgb}};
  }
  return {plan: {kind: "design", factor: k}, area: resample(img, aw, ah)};
}

/** The bezel's coverage of pixel (x, y): 1 inside the rounded rectangle, 0 outside, a fraction on its round corners. */
function bezelCoverage(x, y) {
  const {screen: s, band, radius} = FRAME;
  const left = s.x - band, top = s.y - band, right = s.x + s.width + band, bottom = s.y + s.height + band;
  if (x < left || y < top || x >= right || y >= bottom) return 0;
  const cx = x < left + radius ? left + radius : x >= right - radius ? right - radius : null;
  const cy = y < top + radius ? top + radius : y >= bottom - radius ? bottom - radius : null;
  if (cx === null || cy === null) return 1;
  let inside = 0;                // 4 x 4 samples in the pixel
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const px = x + (i + 0.5) / 4 - cx, py = y + (j + 0.5) / 4 - cy;
    if (px * px + py * py <= radius * radius) inside++;
  }
  return inside / 16;
}

/** The standard picture: {width: 1280, height: 720, rgb, plan, color} from a decoded picture and a colour (parseColor's). */
export function framePicture(img, color = parseColor()) {
  const {area, plan} = screenArea(img);
  const {width: W, height: H, screen: s} = FRAME;
  const bezel = parseColor(FRAME.bezel).rgb, bg = color.rgb;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 3 * (y * W + x);
    if (x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height) {
      const i = 3 * ((y - s.y) * s.width + (x - s.x));
      rgb[o] = area.rgb[i]; rgb[o + 1] = area.rgb[i + 1]; rgb[o + 2] = area.rgb[i + 2];
      continue;
    }
    const c = bezelCoverage(x, y);
    for (let ch = 0; ch < 3; ch++) rgb[o + ch] = Math.round(bezel[ch] * c + bg[ch] * (1 - c));
  }
  return {width: W, height: H, rgb, plan, color: color.hex};
}

/** framePicture's result as PNG bytes. */
export const framedPng = framed => encodePng(framed.width, framed.height, framed.rgb);

/** What a plan says, in words: "the screen (480 × 270, 2×) at 4×, pixel for pixel" / "a design of 1920 × 1080, resampled to 960 × 540". */
export function planText(plan, img) {
  const {scale} = FRAME.device;
  return plan.kind === "screen"
    ? `the screen (${img.width} × ${img.height}${plan.factor > 1 ? `, ${plan.factor}×` : ""}) ${plan.factor === scale ? "as it is" : `at ${scale}×`}, pixel for pixel`
    : `a design of ${img.width} × ${img.height} (not a pixel screen), resampled to ${FRAME.screen.width} × ${FRAME.screen.height}`;
}

// ---------------------------------------------------------------------------------------------
// images frame IMAGE… [--color] [--out]; board screen --frame uses colorFlag and framePicture

const COMMUNITY_MAX = 2 * 1024 * 1024;     // a cover's or a picture's most (COMMUNITY.md "Covers", "Pictures")

/** --color as a colour (the default without it); a bad one is a usage error naming the choices. */
export function colorFlag(ctx) {
  const given = ctx.flags?.color;
  const color = parseColor(given === undefined || given === true ? DEFAULT_COLOR : given);
  if (!color) throw usage(`--color "${given}" is not a colour: #RRGGBB, #RGB or one of ${Object.keys(COLORS).join(", ")}`, {field: "color",
    hint: `Your firmware's own colour is best (the same for its cover and every picture); the standard: ${STANDARD_URL}`});
  return color;
}

/** A picture's problem as the CLI's error: what it is, what the standard takes, where the standard is. */
function pictureError(file, error) {
  return new CliError("invalid", `${file}: ${error.message}`, {field: "IMAGE",
    hint: "A screenshot of the whole screen: 203cli board screen (the device), the simulator's SCREENSHOT (its screen alone, never the keyboard), " +
      `240 × 135 or a whole multiple; or a design of that shape. The standard and its template: ${STANDARD_URL}`});
}

/** IMAGE-framed.png beside IMAGE. */
const framedPath = file => path.join(path.dirname(file), path.basename(file).replace(/\.[^.]+$/, "") + "-framed.png");

export async function imagesFrame(ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const files = [].concat(ctx.args?.IMAGE ?? []).map(String);
  if (!files.length) throw usage("Give the screenshots to frame: images frame docs/screens/home.png …", {field: "IMAGE"});
  const color = colorFlag(ctx);
  const outFlag = ctx.flags?.out;
  if (outFlag !== undefined && files.length > 1) throw usage("--out names one file: give one IMAGE with it, or leave it out (each goes beside its IMAGE as NAME-framed.png)", {field: "out"});
  // Everything is read and checked before anything is written: one picture that is not a screen writes none.
  const made = [];
  for (const file of files) {
    const src = path.resolve(cwd, file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new CliError("file_not_found", `No such file: ${file}`, {field: "IMAGE"});
    const out = outFlag !== undefined ? path.resolve(cwd, String(outFlag)) : framedPath(src);
    if (out === src) throw usage(`The framed picture would replace ${file} itself: give --out another file`, {field: "out"});
    if (!fs.existsSync(path.dirname(out))) throw new CliError("file_not_found", `The folder of --out does not exist (${path.dirname(out)})`, {field: "out"});
    let img, framed;
    try {
      img = decodePng(fs.readFileSync(src));
      framed = framePicture(img, color);
    } catch (error) {
      if (error instanceof PictureError) throw pictureError(file, error);
      throw error;
    }
    made.push({file, src, out, img, framed});
  }
  const pictures = [];
  for (const m of made) {
    const png = framedPng(m.framed);
    fs.writeFileSync(m.out, png);
    pictures.push({image: m.src, path: m.out, kind: m.framed.plan.kind, factor: m.framed.plan.factor, from: {width: m.img.width, height: m.img.height},
      width: m.framed.width, height: m.framed.height, bytes: png.length, too_large: png.length > COMMUNITY_MAX});
    if (!ctx.json) ctx.say?.(`${path.relative(cwd, m.out) || m.out}: ${planText(m.framed.plan, m.img)}, on ${color.hex}`);
    if (png.length > COMMUNITY_MAX && !ctx.json) ctx.say?.(`  ${(png.length / 1048576).toFixed(1)} MB: the community takes 2 MB at most`);
  }
  return {json: {color: color.hex, standard: STANDARD_URL, pictures}, text: pictures.map(x => x.path).join("\n")};
}
