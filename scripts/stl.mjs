// STL without dependencies: reading binary and ASCII files, writing binary ones, and a small software
// renderer that draws a mesh as a 640x480 PNG thumbnail (flat-shaded, seen from the front, above and
// a little to the right). The CLI uses it when a model's preview is an STL and no --thumbnail is
// given; the dev stack draws its seeded models with it.
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

export function binaryStl(triangles, header = "203c") {
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

// RGB pixels → PNG.
export function encodePng(width, height, rgb) {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(zlib.deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// A flat-shaded thumbnail of a mesh on a black tile, in the community's colours: the 3D viewer's neutral light
// grey (#d0d0d3) on its stage (the site's --tile-3, #0b0b0c).
export function renderThumbnail(triangles, {width = 640, height = 480, color = [208, 208, 211], background = [11, 11, 12]} = {}) {
  if (!triangles.length) throw new Error("The STL has no triangles");
  // Rotate: 35° about the vertical axis, then tilt 25° towards the viewer (z is up in most CAD exports).
  const yaw = 35 * Math.PI / 180, pitch = 25 * Math.PI / 180;
  const view = ([x, y, z]) => {
    const x1 = x * Math.cos(yaw) - y * Math.sin(yaw), y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
    return [x1, z * Math.cos(pitch) - y1 * Math.sin(pitch), z * Math.sin(pitch) + y1 * Math.cos(pitch)];
  };
  const projected = triangles.map(tri => tri.map(view));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const tri of projected) for (const [x, y] of tri) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const scale = 0.8 * Math.min(width / ((maxX - minX) || 1), height / ((maxY - minY) || 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(background, i * 3);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const light = [0.35, 0.8, 0.5];
  const lightLength = Math.hypot(...light);
  for (const tri of projected) {
    const n = normal(tri);
    const shade = 0.25 + 0.75 * Math.abs((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / lightLength);
    const pts = tri.map(([x, y, z]) => [(x - cx) * scale + width / 2, height / 2 - (y - cy) * scale, z]);
    const [a, b, c] = pts;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const at = y * width + x;
        if (z <= depth[at]) continue;
        depth[at] = z;
        rgb[at * 3] = Math.min(255, color[0] * shade); rgb[at * 3 + 1] = Math.min(255, color[1] * shade); rgb[at * 3 + 2] = Math.min(255, color[2] * shade);
      }
    }
  }
  return encodePng(width, height, rgb);
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
