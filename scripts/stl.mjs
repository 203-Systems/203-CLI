// STL without dependencies: reading binary and ASCII files, writing binary ones, and a small software
// renderer that draws a mesh as the card's picture: a 1280x720 PNG with a transparent background (the community's
// cards put it on their stage, a grey field with a fine-line grid), seen from the front, above and a little to the
// right, in the site's studio look as far as a CPU allows: a matte grey, smooth where the surface is curved and sharp
// at its edges, a key light, a fill and a rim, a soft contact shadow under it, drawn at twice the size and halved. The
// CLI uses it when a model's preview is an STL and no --thumbnail is given; the dev stack draws its seeded models with
// it. The site draws the card again with its own renderer (WebGL) when the model's author opens its page.
import zlib from "node:zlib";

export function isBinaryStl(bytes) {
  return bytes.length >= 84 && bytes.length === 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
}

// Triangles as [[x, y, z] × 3].
export function parseStl(bytes) {
  const triangles = [];
  if (isBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    for (let i = 0; i < count; i++) {
      const at = 84 + i * 50 + 12;
      const vertex = k => [view.getFloat32(at + k * 12, true), view.getFloat32(at + k * 12 + 4, true), view.getFloat32(at + k * 12 + 8, true)];
      triangles.push([vertex(0), vertex(1), vertex(2)]);
    }
    return triangles;
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/i.test(text)) throw new Error("Not an STL file (neither binary nor ASCII)");
  const numbers = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let current = [], match;
  while ((match = numbers.exec(text))) {
    current.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    if (current.length === 3) { triangles.push(current); current = []; }
  }
  return triangles;
}

export function binaryStl(triangles, header = "203cli") {
  const bytes = new Uint8Array(84 + 50 * triangles.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, i) => {
    const at = 84 + i * 50;
    const n = normal(tri);
    [n, ...tri].forEach((v, k) => v.forEach((c, j) => view.setFloat32(at + k * 12 + j * 4, c, true)));
  });
  return bytes;
}

function normal([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n) || 1;
  return n.map(x => x / length);
}

// ---------------------------------------------------------------------------------------------
// Rendering

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// RGB (3 channels) or RGBA (4) pixels → PNG.
export function encodePng(width, height, pixels, channels = 3) {
  const row = width * channels;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (row + 1)] = 0;
    raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(zlib.deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// Normals per corner, creased: a corner takes the faces around its vertex that turn less than `degrees` from its own
// (weighted by their angle there), so a tessellated cylinder is round and a box keeps its edges.
function creasedNormals(tris, degrees = 35) {
  const key = v => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
  const faces = tris.map(normal);
  const around = new Map();
  tris.forEach((tri, t) => tri.forEach((v, k) => {
    const a = tri[(k + 1) % 3], b = tri[(k + 2) % 3];
    const e = [a[0] - v[0], a[1] - v[1], a[2] - v[2]], f = [b[0] - v[0], b[1] - v[1], b[2] - v[2]];
    const d = Math.hypot(...e) * Math.hypot(...f);
    const angle = d > 0 ? Math.acos(Math.max(-1, Math.min(1, (e[0] * f[0] + e[1] * f[1] + e[2] * f[2]) / d))) : 0;
    const id = key(v);
    if (!around.has(id)) around.set(id, []);
    around.get(id).push([t, angle]);
  }));
  const cos = Math.cos(degrees * Math.PI / 180);
  return tris.map((tri, t) => tri.map(v => {
    const own = faces[t];
    const sum = [0, 0, 0];
    for (const [g, w] of around.get(key(v))) {
      const n = faces[g];
      if (own[0] * n[0] + own[1] * n[1] + own[2] * n[2] >= cos) { sum[0] += n[0] * w; sum[1] += n[1] * w; sum[2] += n[2] * w; }
    }
    const length = Math.hypot(...sum);
    return length > 0 ? sum.map(x => x / length) : own;
  }));
}

const unit = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };

/**
 * The card's picture of a mesh (Z up, as printers read it): a PNG of `width` x `height` (1280 x 720), transparent around
 * the part. The part in a neutral grey (#9fa2a6), lit by a key from above the front left, a fill and a rim (the
 * outline), with a soft shadow where it meets the floor; drawn at twice the size and halved.
 */
export function renderThumbnail(triangles, {width = 1280, height = 720, color = [159, 162, 166]} = {}) {
  if (!triangles.length) throw new Error("The STL has no triangles");
  const W = width * 2, H = height * 2;
  // The view: 35° about the vertical axis, then tilted 28° towards the viewer (z is up in most CAD exports); the viewer
  // on the +y side looking back, so x runs right to left on the screen (not mirrored: a part's lettering reads).
  const yaw = 35 * Math.PI / 180, pitch = 28 * Math.PI / 180;
  const view = ([x, y, z]) => {
    const x1 = x * Math.cos(yaw) - y * Math.sin(yaw), y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
    return [-x1, z * Math.cos(pitch) - y1 * Math.sin(pitch), z * Math.sin(pitch) + y1 * Math.cos(pitch)];
  };
  let zMin = Infinity;
  for (const tri of triangles) for (const v of tri) zMin = Math.min(zMin, v[2]);
  const projected = triangles.map(tri => tri.map(view));
  const normals = creasedNormals(triangles).map(tri => tri.map(view));
  // The floor under it (each vertex dropped to the lowest z): the contact shadow's shape.
  const floor = triangles.map(tri => tri.map(([x, y]) => view([x, y, zMin])));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const tri of [...projected, ...floor]) for (const [x, y] of tri) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const scale = 0.78 * Math.min(W / ((maxX - minX) || 1), H / ((maxY - minY) || 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toScreen = ([x, y, z]) => [(x - cx) * scale + W / 2, H / 2 - (y - cy) * scale, z];
  // Fills a triangle's pixels: calls at(index, w0, w1, w2) for each pixel inside.
  const raster = (pts, at) => {
    const [a, b, c] = pts;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        at(y * W + x, w0, w1, w2);
      }
    }
  };
  // The contact shadow: the footprint at the picture's own size (a quarter of the pixels: it is blurred anyway), three box
  // blurs each way, at most 45 % dark.
  const w2 = width, h2 = height;
  let shade = new Float32Array(w2 * h2);
  for (const tri of floor) {
    const [a, b, c] = tri.map(toScreen).map(([x, y]) => [x / 2, y / 2]);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(w2 - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(h2 - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const e0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area, e1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      if (e0 >= 0 && e1 >= 0 && 1 - e0 - e1 >= 0) shade[y * w2 + x] = 1;
    }
  }
  const radius = Math.max(1, Math.round(w2 * 0.012));
  const span = 2 * radius + 1;
  const tmp = new Float32Array(w2 * h2);
  const blur = (src, dst, n, lines, step, lineStep) => {
    for (let line = 0; line < lines; line++) {
      const o = line * lineStep;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[o + Math.min(n - 1, Math.max(0, k)) * step];
      for (let k = 0; k < n; k++) {
        dst[o + k * step] = sum / span;
        sum += src[o + Math.min(n - 1, k + radius + 1) * step] - src[o + Math.max(0, k - radius) * step];
      }
    }
  };
  for (let pass = 0; pass < 3; pass++) { blur(shade, tmp, w2, h2, 1, w2); blur(tmp, shade, h2, w2, w2, 1); }
  // The part: depth-tested, shaded per pixel from its creased normals.
  const rgba = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba[(y * W + x) * 4 + 3] = shade[(y >> 1) * w2 + (x >> 1)] * 0.45;   // black, as much as the shadow
  const depth = new Float32Array(W * H).fill(-Infinity);
  const [kx, ky, kz] = unit([-0.45, 0.75, 0.6]), [fx, fy, fz] = unit([0.7, 0.1, 0.7]);   // key (above, front left) and fill (right), in view space
  const [hx, hy, hz] = unit([kx, ky, kz + 1]);   // halfway between the key and the viewer: the highlight
  const base = color.map(c => Math.pow(c / 255, 2.2));
  projected.forEach((tri, t) => {
    const pts = tri.map(toScreen);
    const [n0, n1, n2] = normals[t];
    raster(pts, (i, w0, w1, w2) => {
      const z = w0 * pts[0][2] + w1 * pts[1][2] + w2 * pts[2][2];
      if (z <= depth[i]) return;
      depth[i] = z;
      let nx = w0 * n0[0] + w1 * n1[0] + w2 * n2[0], ny = w0 * n0[1] + w1 * n1[1] + w2 * n2[1], nz = w0 * n0[2] + w1 * n1[2] + w2 * n2[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }   // a face seen from behind: its other side
      const light = 0.22 + 0.75 * Math.max(0, nx * kx + ny * ky + nz * kz) + 0.25 * Math.max(0, nx * fx + ny * fy + nz * fz);
      const extra = Math.pow(1 - nz, 3) * 0.35 + Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 24) * 0.12;   // the rim, the highlight
      rgba[i * 4] = Math.min(1, base[0] * light + extra); rgba[i * 4 + 1] = Math.min(1, base[1] * light + extra); rgba[i * 4 + 2] = Math.min(1, base[2] * light + extra);
      rgba[i * 4 + 3] = 1;
    });
  });
  // Halved (2 x 2 averaged, alpha-weighted), to sRGB bytes.
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + dy) * W + x * 2 + dx) * 4, al = rgba[i + 3];
        r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(255 * Math.pow(r / a, 1 / 2.2)); out[o + 1] = Math.round(255 * Math.pow(g / a, 1 / 2.2)); out[o + 2] = Math.round(255 * Math.pow(b / a, 1 / 2.2));
      }
      out[o + 3] = Math.round(255 * a / 4);
    }
  }
  return encodePng(width, height, out, 4);
}

// ---------------------------------------------------------------------------------------------
// Meshes for examples and the dev stack (millimetres).

const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];

export function box([x0, y0, z0], [x1, y1, z1]) {
  const p = (x, y, z) => [x, y, z];
  return [
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)),
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)),
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
  ];
}

export function cylinder([cx, cy, z0], radius, height, segments = 24) {
  const out = [];
  for (let i = 0; i < segments; i++) {
    const a = 2 * Math.PI * i / segments, b = 2 * Math.PI * (i + 1) / segments;
    const p = (angle, z) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z];
    out.push([[cx, cy, z0 + height], p(a, z0 + height), p(b, z0 + height)], [[cx, cy, z0], p(b, z0), p(a, z0)]);
    out.push(...quad(p(a, z0), p(b, z0), p(b, z0 + height), p(a, z0 + height)));
  }
  return out;
}

// A device case: a tray with walls, a screen window cut in its lid (the lid is four bars around the
// hole) and a knob on top.
export function deviceCase({width = 120, depth = 70, height = 18, wall = 2.4} = {}) {
  const lid = height - wall;
  const hole = {x0: 18, x1: 62, y0: 18, y1: 52};
  return [
    ...box([0, 0, 0], [width, depth, wall]),
    ...box([0, 0, wall], [wall, depth, lid]), ...box([width - wall, 0, wall], [width, depth, lid]),
    ...box([wall, 0, wall], [width - wall, wall, lid]), ...box([wall, depth - wall, wall], [width - wall, depth, lid]),
    ...box([0, 0, lid], [hole.x0, depth, height]), ...box([hole.x1, 0, lid], [width, depth, height]),
    ...box([hole.x0, 0, lid], [hole.x1, hole.y0, height]), ...box([hole.x0, hole.y1, lid], [hole.x1, depth, height]),
    ...cylinder([92, 35, height], 9, 7),
  ];
}

export function knob({radius = 12, height = 14} = {}) {
  return [...cylinder([0, 0, 0], radius, height * 0.7, 32), ...cylinder([0, 0, height * 0.7], radius * 0.75, height * 0.3, 32),
    ...box([-1, radius * 0.4, height - 0.1], [1, radius * 0.72, height + 1.2])];
}
