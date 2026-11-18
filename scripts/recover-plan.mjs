// A recovery flash (恢复刷机): what goes into a device's internal flash to bring it back to the official
// state, the 203 Launcher and the device's official firmware at their newest stable versions, laid out
// exactly as the Launcher itself leaves it after installing that firmware from its catalog. Pure (no DOM,
// no network): the site (pages/recover.js), 203c (`devices recover`, its copy recover-plan.mjs) and the
// tests use it. Sources (203-launcher 0.2.0, read 2026-11-16):
// - src/partition_table_model.cpp: the table at 0x8000 (entries, the MD5 entry), its checks
//   (launcherPartitionValidate), where an app goes (launcherPartitionCreateOtaApp: the first free range,
//   0x10000-aligned, alignUp(image, 0x10000) long, the next free OTA subtype) and its label
//   (launcherPartitionNextAppLabel: up to 6 lower-case letters or digits of the name, padded with 0).
// - src/app_registry.cpp, src/onlineLauncher.cpp: the registry, one NVS string per partition label in
//   namespace l_apps_v2 of the shared `nvs` partition, schema 2, written as a catalog install writes it
//   (source "catalog", the hub's app_id, version, build, SHA-256 and size), so the Launcher lists the
//   firmware as registered and offers its updates.
// - ESP-IDF's NVS format (nvs_partition_gen.py, format version 2): 4 KB pages, a 32-byte header, the
//   entry state bitmap, 126 entries of 32 bytes; a string spans 1 + ceil(len / 32) entries.
// The plan erases the whole chip first: nothing of what was there (apps, settings, Wi-Fi, the account in
// NVS) is kept. The SD card is not in the flash and is not touched.

export const SECTOR = 0x1000;
export const APP_ALIGN = 0x10000;
export const TABLE_AT = 0x8000;
export const TABLE_SIZE = 0x1000;
export const TABLE_MAX = 0xc00;
export const REGISTRY_NAMESPACE = 'l_apps_v2';
export const REGISTRY_SCHEMA = 2;

export class RecoveryError extends Error {
  constructor(code, params = {}, detail = '') {
    super(detail || code);
    this.name = 'RecoveryError';
    this.code = code;
    this.params = params;
  }
}

const hex = (n, w = 6) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
export const alignUp = (n, a) => Math.ceil(n / a) * a;
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const put32 = (b, at, v) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; b[at + 2] = (v >>> 16) & 255; b[at + 3] = (v >>> 24) & 255; };
const put16 = (b, at, v) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; };
const utf8 = (s) => new TextEncoder().encode(s);
const cstr = (b) => { const end = b.indexOf(0); return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end)); };

// ---------------------------------------------------------------------------------------------
// Checksums: CRC-32 as ESP-IDF's NVS computes it (zlib.crc32(data, 0xFFFFFFFF)), MD5 (the partition
// table's MD5 entry, esptool's flash verification), SHA-256 (WebCrypto).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib's crc32(data, start): the register starts at ~start and the result is inverted. */
export function crc32(bytes, start = 0) {
  let c = ~start >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (~c) >>> 0;
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 of bytes as 32 lower-case hex digits (RFC 1321). */
export function md5Hex(bytes) {
  const n = bytes.length;
  const total = alignUp(n + 9, 64);
  const m = new Uint8Array(total);
  m.set(bytes);
  m[n] = 0x80;
  const bits = n * 8;
  put32(m, total - 8, bits >>> 0);
  put32(m, total - 4, Math.floor(bits / 2 ** 32) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = u32(m, off + i * 4);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i] + w[g]) >>> 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => put32(out, i * 4, v));
  return Array.from(out, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Images

const FLASH_SIZES = {0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 6: 64, 7: 128};

/**
 * An ESP-IDF application image at `at`: its measured length (segments, checksum, appended SHA-256),
 * chip, flash size from the header and the app descriptor. Null when it is not one.
 */
export function readAppImage(bytes, at = 0) {
  if (at + 288 > bytes.length || bytes[at] !== 0xe9) return null;
  const segments = bytes[at + 1];
  if (segments < 1 || segments > 16) return null;
  let pos = at + 24;
  for (let s = 0; s < segments; s++) {
    if (pos + 8 > bytes.length) return null;
    const size = u32(bytes, pos + 4);
    pos += 8;
    if (pos + size > bytes.length) return null;
    pos += size;
  }
  let end = alignUp(pos + 1, 16);
  const hashed = bytes[at + 23] === 1;
  if (hashed) end += 32;
  if (end > bytes.length) return null;
  const desc = at + 32;
  const described = u32(bytes, desc) === 0xabcd5432;
  return {
    offset: at, length: end - at, chip: u16(bytes, at + 12), hashed,
    flashMb: FLASH_SIZES[bytes[at + 3] >> 4] || 0,
    project: described ? cstr(bytes.subarray(desc + 48, desc + 80)) : '',
    version: described ? cstr(bytes.subarray(desc + 16, desc + 48)) : '',
    idf: described ? cstr(bytes.subarray(desc + 112, desc + 144)) : '',
  };
}

/** The partition table at the start of `bytes` (the 0x1000 bytes at 0x8000): entries, whether it had an MD5. */
export function parsePartitionTable(bytes) {
  const entries = [];
  for (let at = 0; at + 32 <= Math.min(bytes.length, TABLE_MAX); at += 32) {
    const magic = u16(bytes, at);
    if (magic === 0xebeb) {
      if (md5Hex(bytes.subarray(0, at)) !== Array.from(bytes.subarray(at + 16, at + 32), (x) => x.toString(16).padStart(2, '0')).join('')) {
        throw new RecoveryError('table_md5', {}, 'The partition table\'s MD5 does not match');
      }
      return {entries, md5: true};
    }
    if (magic === 0xffff || magic === 0) return {entries, md5: false};
    if (magic !== 0x50aa) throw new RecoveryError('table', {}, 'Not a partition table');
    entries.push({type: bytes[at + 2], subtype: bytes[at + 3], offset: u32(bytes, at + 4), size: u32(bytes, at + 8),
      label: cstr(bytes.subarray(at + 12, at + 28)), flags: u32(bytes, at + 28)});
  }
  throw new RecoveryError('table', {}, 'The partition table has no end');
}

/** 0x1000 bytes: the entries (sorted by the caller), the MD5 entry, 0xFF after it (gen_esp32part.py, the Launcher's own builder). */
export function buildPartitionTable(entries) {
  if ((entries.length + 1) * 32 > TABLE_MAX) throw new RecoveryError('table_full');
  const out = new Uint8Array(TABLE_SIZE).fill(0xff);
  entries.forEach((e, i) => {
    const at = i * 32;
    put16(out, at, 0x50aa);
    out[at + 2] = e.type;
    out[at + 3] = e.subtype;
    put32(out, at + 4, e.offset);
    put32(out, at + 8, e.size);
    out.fill(0, at + 12, at + 28);
    out.set(utf8(e.label).subarray(0, 15), at + 12);
    put32(out, at + 28, e.flags || 0);
  });
  const md5At = entries.length * 32;
  put16(out, md5At, 0xebeb);
  const digest = md5Hex(out.subarray(0, md5At));
  for (let i = 0; i < 16; i++) out[md5At + 16 + i] = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const isApp = (e) => e.type === 0;
const isOta = (e) => e.type === 0 && e.subtype >= 0x10 && e.subtype <= 0x1f;
const isLauncherApp = (e) => e.type === 0 && (e.subtype === 0x00 || e.subtype === 0x20);

/** The Launcher's checks on a table it writes (launcherPartitionValidate). */
export function validateTable(entries, flashSize) {
  const fail = (why, params = {}) => { throw new RecoveryError('table_invalid', {why, ...params}, why); };
  if (!entries.length) fail('no entries');
  if ((entries.length + 1) * 32 > TABLE_MAX) fail('too many entries');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.size) fail(`${e.label}: zero size`);
    if (e.offset % SECTOR || e.size % SECTOR) fail(`${e.label}: not sector aligned`);
    if (e.offset < TABLE_AT + TABLE_SIZE) fail(`${e.label}: overlaps the bootloader or the table`);
    if (e.offset + e.size > flashSize) fail(`${e.label}: beyond the flash`);
    if (!e.label) fail('empty label');
    if (isApp(e) && e.offset % APP_ALIGN) fail(`${e.label}: app not 64 KB aligned`);
    for (const o of entries.slice(i + 1)) {
      if (e.offset < o.offset + o.size && o.offset < e.offset + e.size) fail(`${e.label} and ${o.label} overlap`);
      if (e.label === o.label && !isOta(e) && !isOta(o)) fail(`duplicate label ${e.label}`);
    }
  }
  if (!entries.some(isLauncherApp)) fail('no factory or test Launcher partition');
  if (!entries.some((e) => e.type === 1 && e.subtype === 0)) fail('no otadata');
}

/**
 * The official Launcher's merged full-flash image (bootloader at 0, the table at 0x8000, otadata, the
 * Launcher at its app/test partition): what it says about the device.
 */
export function readMergedLauncher(bytes, target) {
  const boot = readAppImage(bytes, 0);
  if (!boot) throw new RecoveryError('launcher_not_merged');
  if (boot.chip !== 9) throw new RecoveryError('launcher_chip');
  if (bytes.length < TABLE_AT + TABLE_SIZE) throw new RecoveryError('launcher_not_merged');
  let entries;
  try { ({entries} = parsePartitionTable(bytes.subarray(TABLE_AT, TABLE_AT + TABLE_SIZE))); } catch { throw new RecoveryError('launcher_not_merged'); }
  const flashSize = (boot.flashMb || 0) * 1024 * 1024;
  if (!flashSize) throw new RecoveryError('launcher_flash_size');
  const app = entries.find(isLauncherApp);
  const nvs = entries.find((e) => e.type === 1 && e.subtype === 2 && e.label === 'nvs') || entries.find((e) => e.type === 1 && e.subtype === 2);
  if (!app || !nvs || !entries.some((e) => e.type === 1 && e.subtype === 0)) throw new RecoveryError('launcher_layout');
  const image = readAppImage(bytes, app.offset);
  if (!image) throw new RecoveryError('launcher_layout');
  if (image.project !== 'launcher203') throw new RecoveryError('launcher_project', {project: image.project});
  // Its descriptor's version carries the board ("0.2.0-cardenza"): a Launcher for another device is refused.
  const board = (image.version.match(/-([a-z][a-z0-9_-]*)$/) || [])[1] || '';
  if (target && board.replace(/_/g, '-') !== target) throw new RecoveryError('launcher_board', {board, target});
  if (bytes.length > app.offset + app.size) throw new RecoveryError('launcher_layout');
  return {flashSize, flashMb: boot.flashMb, entries, app, nvs, version: image.version, length: bytes.length};
}

// ---------------------------------------------------------------------------------------------
// Where an app goes, as the Launcher would put it

/** launcherPartitionNextAppLabel: up to 6 lower-case letters or digits of the name, padded with 0; then variants. */
export function nextAppLabel(entries, name) {
  let base = '';
  for (const ch of String(name || '').toLowerCase()) {
    if (base.length >= 6) break;
    if (/[a-z0-9]/.test(ch)) base += ch;
  }
  if (!base) base = 'app';
  base = base.padEnd(6, '0');
  const taken = (l) => entries.some((e) => e.label === l);
  if (!taken(base)) return base;
  const prefix = base.slice(0, 5);
  for (let i = 1; i <= 9; i++) if (!taken(prefix + i)) return prefix + i;
  if (!taken(prefix + '0')) return prefix + '0';
  for (let i = 1; i < 100; i++) if (!taken('app' + i)) return 'app' + i;
  return 'app';
}

/** launcherPartitionCreateOtaApp: the first free range that holds it, 64 KB aligned; the next free OTA subtype. */
export function placeApp(entries, imageSize, label, flashSize) {
  let subtype = -1;
  for (let i = 0; i < 16; i++) if (!entries.some((e) => isApp(e) && e.subtype === 0x10 + i)) { subtype = 0x10 + i; break; }
  if (subtype < 0) throw new RecoveryError('no_subtype');
  const size = alignUp(imageSize, APP_ALIGN);
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  let cursor = TABLE_AT + TABLE_SIZE;
  const ranges = [];
  for (const e of sorted) {
    if (e.offset > cursor) ranges.push({offset: cursor, size: e.offset - cursor});
    cursor = Math.max(cursor, e.offset + e.size);
  }
  if (flashSize > cursor) ranges.push({offset: cursor, size: flashSize - cursor});
  for (const r of ranges) {
    const at = alignUp(r.offset, APP_ALIGN);
    if (r.size >= at - r.offset && r.size - (at - r.offset) >= size) return {type: 0, subtype, offset: at, size, label, flags: 0};
  }
  throw new RecoveryError('no_space', {need: size});
}

// ---------------------------------------------------------------------------------------------
// NVS (format version 2), only what the registry needs: namespaces and strings

const NVS_PAGE = 4096, NVS_ENTRIES = 126, NVS_ACTIVE = 0xfffffffe, NVS_FULL = 0xfffffffc;

/**
 * An NVS partition image of `size` bytes holding `data` ({namespace: {key: string}}, in order), byte for
 * byte what ESP-IDF's nvs_partition_gen.py writes for the same CSV: entries fill pages in order, a page
 * that is left gets FULL, the last written one stays ACTIVE, the rest are empty.
 */
export function nvsImage(size, data) {
  if (size % NVS_PAGE || size < 3 * NVS_PAGE) throw new RecoveryError('nvs_size');
  const pages = [];
  let page, used;
  const newPage = () => {
    if (page) put32(page, 0, NVS_FULL);
    if ((pages.length + 2) * NVS_PAGE > size) throw new RecoveryError('nvs_full');   // one page stays free for NVS itself
    page = new Uint8Array(NVS_PAGE).fill(0xff);
    used = 0;
    put32(page, 0, NVS_ACTIVE);
    put32(page, 4, pages.length);
    page[8] = 0xfe;
    put32(page, 28, crc32(page.subarray(4, 28), 0xffffffff));
    pages.push(page);
  };
  const write = (entry, payload = new Uint8Array(0)) => {
    const span = 1 + Math.ceil(payload.length / 32);
    if (used + span > NVS_ENTRIES - (payload.length ? 1 : 0)) newPage();
    const at = 64 + used * 32;
    page.set(entry, at);
    page.set(payload, at + 32);
    for (let i = 0; i < span; i++) {
      const bit = (used + i) * 2;
      page[32 + (bit >> 3)] &= ~(1 << (bit & 7));
    }
    used += span;
  };
  const head = (ns, type, span, key) => {
    const e = new Uint8Array(32).fill(0xff);
    e[0] = ns; e[1] = type; e[2] = span; e[3] = 0xff;
    e.fill(0, 8, 24);
    const k = utf8(key);
    if (!k.length || k.length > 15) throw new RecoveryError('nvs_key', {key});
    e.set(k, 8);
    return e;
  };
  const seal = (e) => {
    const crcData = new Uint8Array(28);
    crcData.set(e.subarray(0, 4), 0);
    crcData.set(e.subarray(8, 32), 4);
    put32(e, 4, crc32(crcData, 0xffffffff));
    return e;
  };
  newPage();
  let index = 0;
  for (const [namespace, values] of Object.entries(data)) {
    index += 1;
    const ns = head(0, 0x01, 1, namespace);
    ns[24] = index;
    write(seal(ns));
    for (const [key, value] of Object.entries(values)) {
      const bytes = utf8(String(value) + '\0');
      if (bytes.length > 4000) throw new RecoveryError('nvs_value', {key});
      const e = head(index, 0x21, 1 + Math.ceil(bytes.length / 32), key);
      put16(e, 24, bytes.length);
      e[26] = 0xff; e[27] = 0xff;
      put32(e, 28, crc32(bytes, 0xffffffff));
      const payload = new Uint8Array(alignUp(bytes.length, 32)).fill(0xff);
      payload.set(bytes);
      write(seal(e), payload);
    }
  }
  const out = new Uint8Array(size).fill(0xff);
  pages.forEach((p, i) => out.set(p, i * NVS_PAGE));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The registry record of a catalog install (launcherSaveAppMetadata, schema 2)

const validText = (s, max) => utf8(s).length <= max && !/[\u0000-\u001f\u007f]/.test(s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Text cut to `max` UTF-8 bytes on a character boundary, control characters dropped. */
function fitText(s, max) {
  let out = '';
  for (const ch of String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()) {
    if (utf8(out + ch).length > max) break;
    out += ch;
  }
  return out.trim();
}

/**
 * The record the Launcher keeps for a firmware installed from its catalog, or null when the catalog would
 * not have taken it (softwareCatalogMatches): it is then installed but not registered (an "Unknown App",
 * still started from the Launcher's list).
 */
export function registryRecord(item, slot, target, backupKey) {
  const appId = String(item.app_id || '').toLowerCase();
  const version = String(item.version || '');
  const build = Number(item.build);
  const sha = String(item.sha256 || '').toLowerCase();
  const name = fitText(item.name, 64);
  if (!UUID.test(appId) || !['cardenza', 'nullperator'].includes(target) || item.target !== target || !version || !validText(version, 32)
    || !Number.isInteger(build) || build < 1 || build > 2147483647 || !(item.size >= 288 && item.size <= 16 * 1024 * 1024)
    || !/^[0-9a-f]{64}$/.test(sha) || !name || !UUID.test(backupKey)) return null;
  // Key order as ArduinoJson writes it in launcherSaveAppMetadata.
  return JSON.stringify({schema: REGISTRY_SCHEMA, id: appId, target, name, description: fitText(item.description, 160), version, build,
    source: 'catalog', image_sha256: sha, offset: slot.offset, image_size: item.size, backup_key: backupKey, spiffs: '', fat: []});
}

// ---------------------------------------------------------------------------------------------
// The plan

/**
 * launcher: {bytes, item}; apps: [{bytes, item}] (in install order); uuid(): a fresh UUID v4 (the backup key
 * the Launcher gives each install). Checks every image against what the API said (size; the SHA-256 is the
 * caller's, it is async) and answers:
 *   {target, flashSize, erase: "all", partitions: [...], writes: [{address, data, size, what, name?}],
 *    apps: [{name, version, label, offset, size, slot, registered}], launcher: {version, size}}
 * Writes: the Launcher's merged image with the new partition table and the registry's NVS in it, at 0;
 * each firmware at its slot. Nothing is written outside them; the chip is erased first.
 */
export function recoveryPlan({target, launcher, apps = [], uuid}) {
  const info = readMergedLauncher(launcher.bytes, target);
  if (launcher.item && launcher.item.size && launcher.item.size !== launcher.bytes.length) {
    throw new RecoveryError('size_differs', {name: launcher.item.name || 'Launcher', got: launcher.bytes.length, want: launcher.item.size});
  }
  const entries = info.entries.map((e) => ({...e}));
  const registry = {};
  const placed = [];
  for (const app of apps) {
    const image = readAppImage(app.bytes, 0);
    if (!image) throw new RecoveryError('app_image', {name: app.item.name});
    if (image.chip !== 9) throw new RecoveryError('app_chip', {name: app.item.name});
    if (image.project === 'launcher203') throw new RecoveryError('app_is_launcher', {name: app.item.name});
    if (image.length !== app.bytes.length) throw new RecoveryError('app_image', {name: app.item.name});
    if (app.item.size !== app.bytes.length) throw new RecoveryError('size_differs', {name: app.item.name, got: app.bytes.length, want: app.item.size});
    const label = nextAppLabel(entries, app.item.name);
    const slot = placeApp(entries, app.bytes.length, label, info.flashSize);
    entries.push(slot);
    entries.sort((a, b) => a.offset - b.offset);
    const record = registryRecord(app.item, slot, target, uuid());
    if (record) registry[label] = record;
    placed.push({app, slot, record});
  }
  validateTable(entries, info.flashSize);
  const table = buildPartitionTable(entries);
  const base = launcher.bytes.slice();
  base.set(table, TABLE_AT);
  if (Object.keys(registry).length) {
    if (info.nvs.offset + info.nvs.size > base.length) throw new RecoveryError('launcher_layout');
    base.set(nvsImage(info.nvs.size, {[REGISTRY_NAMESPACE]: registry}), info.nvs.offset);
  }
  const writes = [{address: 0, data: base, size: base.length, what: 'launcher', name: launcher.item?.name || '203 Launcher', version: launcher.item?.version || info.version}];
  for (const {app, slot} of placed) {
    writes.push({address: slot.offset, data: app.bytes, size: app.bytes.length, what: 'firmware', name: app.item.name, version: app.item.version, label: slot.label});
  }
  return {
    target, flashSize: info.flashSize, erase: 'all', partitions: entries,
    launcher: {version: info.version, size: launcher.bytes.length, name: launcher.item?.name || '203 Launcher'},
    apps: placed.map(({app, slot, record}) => ({name: app.item.name, version: app.item.version, app_id: app.item.app_id, label: slot.label,
      offset: slot.offset, slot: slot.size, size: app.bytes.length, registered: !!record})),
    registry: Object.entries(registry).map(([label, record]) => ({label, record: JSON.parse(record)})),
    writes,
  };
}

/** The whole flash as the device has it after the plan (erased flash is 0xFF): for QEMU and the tests. */
export function assembleFlash(plan, size = plan.flashSize) {
  const out = new Uint8Array(size).fill(0xff);
  for (const w of plan.writes) out.set(w.data, w.address);
  return out;
}

/** One line per write and per partition, for logs and 203c. */
export function describePlan(plan) {
  return [
    `erase: the whole flash (${plan.flashSize / 1048576} MB)`,
    ...plan.writes.map((w) => `write ${hex(w.address)} ${w.size} bytes: ${w.name} ${w.version}${w.label ? ` (partition ${w.label})` : ''}`),
    ...plan.partitions.map((p) => `partition ${p.label.padEnd(8)} type ${p.type} subtype ${hex(p.subtype, 2)} at ${hex(p.offset)} size ${hex(p.size)}`),
  ];
}
