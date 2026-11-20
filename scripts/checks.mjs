// Local checks for 203c (the Agent Skill's CLI), made before anything is sent, the way the server and
// its checker will make them: ESP32-S3 images (supabase/functions/_shared/firmware.ts validateImage,
// community/diagnosis.ts), codes, version labels, channels, the first bytes of covers, works, sound
// packs, projects and models (community/storage.ts), the limits (GET / limits; the defaults below),
// CHANGELOG entries, and "did you mean" suggestions. No network, no dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

export const MB = 1024 * 1024;
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CHANNELS = ["stable", "beta", "dev"];
export const ENGINES = ["dx7", "juno", "sampler", "drums"];
export const LICENSES = ["CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC0-1.0", "all-rights-reserved"];
export const FIRMWARE_CATEGORIES = ["instrument", "groovebox", "tool", "network", "game"];

// What the API enforces (GET / answers the same under "limits"; these are the fallbacks).
export const LIMITS = {
  image_bytes: 16 * MB, notices_bytes: 1 * MB, cover_bytes: 2 * MB, audio_bytes: 50 * MB, video_bytes: 300 * MB,
  text: {firmware_name: 64, summary: 100, description: 20000, notes: 10000, work_title: 80, work_description: 2000, post_title: 120},
  tags: {firmware: 8, post: 5, work: 5, model: 8, sound: 8, project: 8, length: 24},
  password: {min: 4, max: 64},
  pack_bytes: {preset: 2 * MB, project: 8 * MB, sample: 20 * MB, preview: 30 * MB, total: 200 * MB},
  pack_files: {preset: 16, sample: 64, project_samples: 32},
  model: {file: 100 * MB, files: 10, total: 200 * MB, preview: 50 * MB, thumbnail: 1 * MB},
  versions_per_day: {stable_beta: 30, dev: 300}, works_per_day: 20, sounds_per_day: 20, projects_per_day: 20, firmware_per_account: 50,
};

// Where the Launcher installs an app on each device (203-launcher boards/*/partitions.csv; the same
// table as community/diagnosis.ts LAUNCHER_BUDGET): from `reserved` to `apps_end`, the flash every such
// device's Launcher lays out (its bootloader's header says how much). `flash` is the chip's. The Cardenza
// has 16 MB, but a board flashed with Launcher 0.3.3 or earlier declares 8 MB until its bootloader is
// written again over USB (203-launcher docs/FLASHING.md "Flash 大小"), so one app gets at most 0x690000.
export const DEVICES = {
  "cardenza": {name: "Cardenza", flash: 16 * MB, apps_end: 8 * MB, reserved: 0x170000},
  "nullperator": {name: "NullPerator", flash: 16 * MB, apps_end: 16 * MB, reserved: 0x1a0000},
};
export const DEFAULT_TARGET = "cardenza";
// Download-only devices (COMMUNITY.md "Devices"): their builds are UF2 files their own bootloader reads,
// never installed by the Launcher. GET /targets says it too (format uf2, uf2: {family_id, max_size,
// build_name, others}); this copy serves offline checks. Mystrix and Mystrix 2 (two devices, the user
// 2026-11-17): ESP32-S3 with tinyuf2, one family; app partitions of 3776 KB and 4 MB; MatrixOS builds them
// as DEVICE=Mystrix1 and Mystrix2 (MatrixOS-Mystrix1-<version>.uf2, its app MatrixOS-Mystrix1).
export const UF2_DEVICES = {
  "mystrix": {name: "Mystrix", family: 0xc47e5767, max: 3776 * 1024, build: "Mystrix1"},
  "mystrix2": {name: "Mystrix 2", family: 0xc47e5767, max: 4 * MB, build: "Mystrix2"},
};

// Channel words people use for the three channels (refused with the right one suggested, never mapped
// silently: a wrong guess would publish to everyone).
const CHANNEL_WORDS = {
  release: "stable", releases: "stable", prod: "stable", production: "stable", main: "stable", master: "stable", latest: "stable",
  final: "stable", public: "stable", stabel: "stable", stble: "stable",
  preview: "beta", rc: "beta", pre: "beta", prerelease: "beta", "pre-release": "beta", test: "beta", testing: "beta", alpha: "beta", experimental: "beta",
  nightly: "dev", nightlies: "dev", ci: "dev", snapshot: "dev", develop: "dev", development: "dev", canary: "dev", daily: "dev", edge: "dev",
};

// ---------------------------------------------------------------------------------------------
// Small helpers

export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export function size(bytes) {
  if (bytes >= MB) return (bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " bytes";
}
const ascii = (bytes, at, text) => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
function cString(bytes, at, length) {
  if (at + length > bytes.length) return null;
  const slice = bytes.subarray(at, at + length);
  const end = slice.indexOf(0);
  const text = new TextDecoder("utf-8", {fatal: false}).decode(end >= 0 ? slice.subarray(0, end) : slice).trim();
  return text && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}

/** Damerau-Levenshtein distance (adjacent swaps count once). */
export function distance(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The closest of the candidates, or null when none is close enough to be what was meant. */
export function nearest(word, candidates) {
  const w = String(word ?? "").toLowerCase();
  if (!w) return null;
  let best = null, bestScore = Infinity;
  for (const candidate of candidates) {
    const c = String(candidate).toLowerCase();
    let score = distance(w, c);
    if (c.startsWith(w) || w.startsWith(c)) score = Math.min(score, 1);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return bestScore <= Math.max(2, Math.floor(w.length / 3)) ? best : null;
}

// ---------------------------------------------------------------------------------------------
// Codes, version labels, channels

/** A six-character firmware or version code as the API takes it: any case, spaces and - ignored. */
export function normalizeCode(input) {
  const raw = String(input ?? "").trim();
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return {code, changed: code !== raw};
  const wrong = [...new Set([...code].filter(ch => !CODE_ALPHABET.includes(ch)))];
  let hint = "A code is 6 characters of " + CODE_ALPHABET + " (never 0, 1, I or O), e.g. K7M2QX.";
  if (wrong.some(ch => "01IO".includes(ch))) hint += ` "${wrong.join("")}" cannot be in a code: read it again (0 and O, 1 and I look alike; codes use neither).`;
  const looksLikeName = /\s/.test(raw) || raw.length > 8 || /[a-z]{3}/.test(raw);
  return {error: `"${raw}" is not a code`, hint, looksLikeName};
}

/** A version label as the API takes it: 1-32 of [0-9A-Za-z._+-]. A leading v before a digit is dropped. */
export function versionLabel(input) {
  const notes = [];
  let label = String(input ?? "").trim();
  if (!label) return {error: "The version is empty", hint: "Give --version like 1.4.0 (or leave it out to use the BIN's own version)"};
  if (/^[vV]\s*\d/.test(label)) {
    const bare = label.replace(/^[vV]\s*/, "");
    notes.push(`version ${label} is published as ${bare} (labels have no leading v)`); label = bare;
  }
  if (!/^[0-9A-Za-z._+-]{1,32}$/.test(label)) {
    const fixed = label.replace(/\s+/g, "-").replace(/[^0-9A-Za-z._+-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    return {error: `"${label}" is not a version label`, hint: "A version label is 1-32 letters, digits and . _ + - (no spaces), e.g. 1.4.0 or dev.20261114.1",
      suggestion: fixed || null};
  }
  return {label, notes};
}

/** A channel as given: {channel} or {error, suggestion} (release → stable, nightly → dev …). */
export function normalizeChannel(input) {
  const word = String(input ?? "").trim().toLowerCase();
  if (CHANNELS.includes(word)) return {channel: word};
  const suggestion = CHANNEL_WORDS[word] ?? nearest(word, CHANNELS);
  return {error: `"${input}" is not a channel`, suggestion,
    hint: "Channels: stable (releases, by hand), beta (a big change to try), dev (CI builds, the newest 30 kept)" +
      (suggestion ? `; "${input}" is ${suggestion} here` : "")};
}

/** The numeric core of a label ("0.2.0-3-gabc" → [0,2,0]), or null. */
function core(label) {
  const match = /^(\d+(?:\.\d+)*)/.exec(String(label ?? ""));
  return match ? match[1].split(".").map(Number) : null;
}

/** -1, 0 or 1 comparing two version labels; null when they cannot be compared (no numbers in front). */
export function compareVersions(a, b) {
  const x = core(a), y = core(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0, q = y[i] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  // Same numbers: a release (nothing after them) comes after its pre-releases (1.0.0-rc1 < 1.0.0).
  const restA = String(a).slice(String(a).match(/^[\d.]+/)[0].length), restB = String(b).slice(String(b).match(/^[\d.]+/)[0].length);
  if (restA === restB) return 0;
  if (!restA) return 1;
  if (!restB) return -1;
  return null;
}

/** Whether the label and the BIN's own version name different releases (both have numbers in front). */
export function versionsDisagree(label, appVersion) {
  const x = core(label), y = core(String(appVersion ?? "").replace(/^v/, ""));
  if (!x || !y) return false;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return true;
  return false;
}

/** The label after this one (1.4.0 → 1.4.1, dev.7 → dev.8, beta → beta.1). */
export function nextVersion(label) {
  const match = /^(.*?)(\d+)([^\d]*)$/.exec(label);
  if (match) return match[1] + (Number(match[2]) + 1) + match[3];
  return label + ".1";
}

/** Tags as the API takes them; {tags} or {error}. */
export function normalizeTags(input, max) {
  const list = (Array.isArray(input) ? input : String(input ?? "").split(/[,\s]+/)).map(t => String(t).trim().toLowerCase().replace(/^#/, "")).filter(Boolean);
  const tags = [...new Set(list)];
  if (tags.length > max) return {error: `At most ${max} tags (${tags.length} given)`, hint: `Keep the ${max} that say most, e.g. --tags ${tags.slice(0, max).join(",")}`, fixed: tags.slice(0, max)};
  for (const tag of tags) {
    if (tag === "official") return {error: "The tag official is given by admins", hint: "Leave official out of --tags"};
    if (!/^[a-z0-9぀-ヿ㐀-䶿一-鿿가-힯]([a-z0-9぀-ヿ㐀-䶿一-鿿가-힯-]{0,22}[a-z0-9぀-ヿ㐀-䶿一-鿿가-힯])?$/.test(tag)) {
      const fixed = tag.replace(/[^a-z0-9぀-ヿ㐀-䶿一-鿿가-힯]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
      return {error: `"${tag}" is not a tag`, hint: "A tag is 1-24 lower-case letters, digits or - (comma-separated: --tags groovebox,synth)" +
        (fixed ? `; e.g. ${fixed}` : ""), fixed: fixed ? tags.map(t => t === tag ? fixed : t) : null};
    }
  }
  return {tags};
}

/** A value copied from an example or a suggested command without filling it in ("<what it does>", "TODO"). */
export function isPlaceholder(value) {
  const text = String(value ?? "").trim();
  return /^<[^<>]*>$/.test(text) || /<(one line|what|your|the |a |password|https link|path|version|code)[^<>]*>/i.test(text) ||
    /^(todo|tbd|tbc|fixme|xxx+|\.{3}|…|summary|description|notes|title|what it does.*|what changed.*|what my fork changes)$/i.test(text);
}

export function httpsUrl(value) {
  return typeof value === "string" && value.length <= 300 && /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s<>"]*)?$/.test(value);
}

/** A summary cut to fit (at a word boundary when one is near). */
export function shorten(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  // A clause boundary (", " "; " ": " " and " " with " " - ") when there is one past half, else a word boundary.
  const strong = Math.max(...[", ", "; ", ": ", " - ", " — ", ". "].map(sep => cut.lastIndexOf(sep)));
  const weak = Math.max(...[" and ", " with ", " for "].map(sep => cut.lastIndexOf(sep)));
  const word = cut.lastIndexOf(" ");
  const at = strong > max * 0.5 ? strong : weak > max * 0.5 ? weak : word > max * 0.6 ? word : max;
  return clean.slice(0, at).replace(/[\s,;:(-]+$/, "");
}

/** Whether a summary only repeats the name ("CardenzaSynth" / "CardenzaSynth firmware"). */
export function summaryRepeatsName(summary, name) {
  const words = text => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  const filler = new Set(["firmware", "the", "a", "an", "for", "app", "version", "official", "by", "fw", "固件"]);
  const s = words(summary).filter(w => !filler.has(w)), n = new Set(words(name));
  const joined = words(name).join("");
  return s.length === 0 || s.every(w => n.has(w) || w === joined) || s.join("") === joined;
}

// ---------------------------------------------------------------------------------------------
// ESP32 images

const CHIPS = {0: "esp32", 2: "esp32s2", 5: "esp32c3", 9: "esp32s3", 12: "esp32c2", 13: "esp32c6", 16: "esp32h2", 18: "esp32p4"};
const FLASH_SIZES = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"];

/** CardenzaHAL's marker "CardenzaHAL/<version>+<commit>" in an image, or null. */
export function halMarker(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let from = 0;
  while (true) {
    const at = buffer.indexOf("CardenzaHAL/", from, "latin1");
    if (at < 0) return null;
    const tail = buffer.subarray(at + 12, at + 12 + 80).toString("latin1");
    const match = /^([0-9A-Za-z][0-9A-Za-z.-]{0,31})\+([0-9a-f]{7,40}|unknown)(?![0-9A-Za-z])/.exec(tail);
    if (match) return {version: match[1], commit: match[2]};
    from = at + 1;
  }
}

// Built with CardenzaHAL before it had the marker: its log tag, the NUL-terminated "CardenzaHAL" not
// part of a longer name (diagnosis.ts halTag). {version: null, commit: null} then.
export function halOf(bytes) {
  const marker = halMarker(bytes);
  if (marker) return marker;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = buffer.indexOf("CardenzaHAL\0", 0, "latin1"); at >= 0; at = buffer.indexOf("CardenzaHAL\0", at + 1, "latin1")) {
    if (!/[0-9A-Za-z_]/.test(String.fromCharCode(at > 0 ? buffer[at - 1] : 0))) return {version: null, commit: null};
  }
  return null;
}

function partitionTable(bytes, at = 0x8000) {
  const entries = [];
  for (let i = 0; i < 95; i++) {
    const p = at + i * 32;
    if (p + 32 > bytes.length) return entries.length ? entries : null;
    if (bytes[p] === 0xaa && bytes[p + 1] === 0x50) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + p);
      entries.push({type: bytes[p + 2], subtype: bytes[p + 3], offset: view.getUint32(4, true), size: view.getUint32(8, true), label: cString(bytes, p + 12, 16) ?? ""});
    } else if (bytes[p] === 0xeb && bytes[p + 1] === 0xeb) continue;
    else break;
  }
  return entries.length ? entries : null;
}

// The hub's application image checks (validateImage): null when good, else what is wrong.
function appImageProblem(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 24, checksum = 0xef;
  for (let segment = 0; segment < data[1]; segment++) {
    if (pos + 8 > data.length) return "it ends inside a segment header (a truncated file: copy it again)";
    const length = view.getUint32(pos + 4, true); pos += 8;
    if (pos + length > data.length) return "it ends inside a segment (a truncated file: copy it again)";
    for (let i = pos; i < pos + length; i++) checksum ^= data[i];
    pos += length;
  }
  let end = (pos + 16) & ~15;
  if (end > data.length || data[end - 1] !== checksum) return "its checksum is wrong (a damaged or edited file)";
  if (data[23] !== 0 && data[23] !== 1) return "its hash flag is invalid";
  if (data[23]) {
    if (end + 32 > data.length) return "its appended SHA-256 is cut off";
    if (sha256(data.subarray(0, end)) !== Buffer.from(data.subarray(end, end + 32)).toString("hex")) return "its appended SHA-256 does not match (a damaged or edited file)";
    end += 32;
  }
  if (end !== data.length) return `${data.length - end} bytes follow the image (signed or padded images are not taken: use the .bin idf.py wrote)`;
  return null;
}

/**
 * What a BIN is and whether the community will take it for this device, as the upload and the
 * checker decide: {kind, ok, problems:[{code,message,hint}], warnings:[...], chip, project, version,
 * idf, hal, size, sha256, budget}. kind: app | merged | bootloader | partition_table | elf | …
 * firmwareKind "launcher" expects a merged full-flash image.
 */
export function inspectBin(bytes, {target = DEFAULT_TARGET, firmwareKind = "app", file = "the BIN", device = null} = {}) {
  // A download-only device (GET /targets format uf2, or one of UF2_DEVICES): its UF2 file.
  if (device?.format === "uf2" || (!device && UF2_DEVICES[target])) return inspectUf2(bytes, {target, file, firmwareKind, device});
  const report = {file, size: bytes.length, sha256: sha256(bytes), kind: "unknown", ok: false, problems: [], warnings: [],
    chip: null, project: null, version: null, idf: null, date: null, hal: null, sha256_appended: false, flash_size: null, budget: null};
  const problem = (code, message, hint) => report.problems.push({code, message, hint});
  const warn = (code, message, hint) => report.warnings.push({code, message, hint});
  const name = path.basename(file);
  if (!bytes.length) { report.kind = "empty"; problem("bin.empty", `${name} is empty`, "Build the firmware first (idf.py build) and give the .bin it writes"); return report; }
  if (bytes.length > LIMITS.image_bytes && !ascii(bytes, 0, "\x7fELF")) problem("bin.too_large", `${name} is ${size(bytes.length)}: an image is at most 16 MB`, "Give the application image (build/<project>.bin), not a whole-disk dump");
  if (ascii(bytes, 0, "\x7fELF")) {
    report.kind = "elf";
    problem("bin.elf", `${name} is an ELF file (for debugging), not a flashable image`,
      "Give the .bin next to it (idf.py writes both: build/<project>.bin); keep the ELF to decode crash backtraces");
    return report;
  }
  if (bytes[0] === 0xaa && bytes[1] === 0x50) {
    report.kind = "partition_table";
    problem("bin.partition_table", `${name} is a partition table, not the firmware`, "Give the application image: build/<project>.bin (not build/partition_table/*.bin)");
    return report;
  }
  if (ascii(bytes, 0, "PK\x03\x04")) { report.kind = "zip"; problem("bin.zip", `${name} is a ZIP archive`, "Unpack it and give the .bin inside"); return report; }
  if (ascii(bytes, 0, "UF2\n")) {
    report.kind = "uf2";
    problem("bin.uf2", `${name} is a UF2 file`, `Give the ESP-IDF application .bin (build/<project>.bin); a .uf2 is for a download-only device (${Object.keys(UF2_DEVICES).join(", ")}: --bin mystrix=<file>.uf2)`);
    return report;
  }
  if (bytes[0] === 0x3a && /^:[0-9A-Fa-f]{8}/.test(Buffer.from(bytes.subarray(0, 16)).toString("latin1"))) {
    report.kind = "hex"; problem("bin.hex", `${name} is an Intel HEX file`, "Give the binary .bin, not the .hex"); return report;
  }
  if (bytes[0] !== 0xe9 || bytes.length < 288) {
    problem("bin.not_esp_image", `${name} is not an ESP32 image (it does not start with 0xE9)`,
      "Give the .bin that idf.py build writes (build/<project>.bin); text, archives and other files are not firmware");
    return report;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  report.chip = CHIPS[view.getUint16(12, true)] ?? `unknown (${view.getUint16(12, true)})`;
  report.flash_size = FLASH_SIZES[bytes[3] >> 4] ?? null;
  const table = bytes.length > 0x8000 + 32 ? partitionTable(bytes) : null;
  const budget = DEVICES[target];
  if (table) {
    // A merged full-flash image: bootloader at 0, the partition table at 0x8000, the app after it.
    report.kind = "merged";
    const app = table.find(p => p.type === 0 && p.offset < bytes.length);
    const appAt = app?.offset;
    if (appAt !== undefined && bytes[appAt] === 0xe9 && view.getUint32(appAt + 32, true) === 0xabcd5432) {
      report.project = cString(bytes, appAt + 80, 32); report.version = cString(bytes, appAt + 48, 32); report.idf = cString(bytes, appAt + 144, 32);
      report.date = cString(bytes, appAt + 128, 16);
    }
    if (firmwareKind !== "launcher") {
      problem("bin.merged", `${name} is a merged full-flash image (bootloader + partition table + app), not an application image`,
        "Give the application image alone: build/<project>.bin (idf.py build writes it next to the merged one); only launchers are uploaded merged");
      return report;
    }
    if (!app || appAt === undefined || bytes[appAt] !== 0xe9) problem("bin.merged_no_app", `${name}: its partition table names no app image`, "Merge the launcher again with its app (esptool merge_bin)");
    if (budget && bytes.length > budget.flash) problem("bin.larger_than_flash", `${name} is larger than the ${budget.name}'s flash (${size(budget.flash)})`, "Build it for this device's flash size");
  } else {
    if (firmwareKind === "launcher") {
      problem("bin.not_merged", `${name} is not a merged full-flash image; a launcher is uploaded as one (bootloader at 0, partition table at 0x8000)`,
        "Make it with: esptool.py --chip esp32s3 merge_bin -o launcher-merged.bin 0x0 bootloader.bin 0x8000 partition-table.bin 0x10000 app.bin");
      return report;
    }
    if (report.chip !== "esp32s3") {
      problem("bin.wrong_chip", `${name} is built for the ${report.chip}, not the ESP32-S3`, "Set the target and build again: idf.py set-target esp32s3 && idf.py build");
    }
    if (bytes[1] < 1 || bytes[1] > 16) problem("bin.corrupt", `${name}: its segment count (${bytes[1]}) is invalid`, "Copy the .bin again from the build folder");
    if (view.getUint32(32, true) !== 0xabcd5432) {
      if (bytes[32] === 0x50 && bytes.length < 0x10000) {
        report.kind = "bootloader";
        problem("bin.bootloader", `${name} is the bootloader, not the firmware`, "Give the application image: build/<project>.bin (not build/bootloader/bootloader.bin)");
      } else {
        problem("bin.no_app_desc", `${name} has no application description (esp_app_desc_t): not an ESP-IDF application image`, "Give the .bin of an ESP-IDF app build (build/<project>.bin)");
      }
      return report;
    }
    report.kind = "app";
    report.project = cString(bytes, 80, 32); report.version = cString(bytes, 48, 32); report.idf = cString(bytes, 144, 32);
    report.date = cString(bytes, 128, 16);
    report.sha256_appended = bytes[23] === 1;
    if (report.project === "launcher203") {
      problem("bin.is_launcher", `${name} is the 203 Launcher itself`, "The 203 Launcher is published by 203 Systems, not as a community firmware: give your own app's .bin");
    }
    const broken = bytes[1] >= 1 && bytes[1] <= 16 ? appImageProblem(bytes) : null;
    if (broken) problem("bin.corrupt", `${name} is not a valid image: ${broken}`, "Build again and give build/<project>.bin as idf.py wrote it");
    if (budget) {
      const limit = budget.apps_end - budget.reserved;
      report.budget = {device: budget.name, limit, percent: Math.round((bytes.length / limit) * 100)};
      if (bytes.length > limit) {
        problem("bin.too_large_for_device", `${name} is ${size(bytes.length)}; the Launcher has ${size(limit)} for apps on the ${budget.name}`,
          "Make the app smaller (Release/size optimisation, fewer assets): the checks send back an app that does not fit");
      }
    }
  }
  report.hal = halOf(bytes);
  if (!report.hal && firmwareKind !== "launcher") {
    warn("bin.no_hal", `${name} was not built with CardenzaHAL (no marker, no log tag): the page will show a "no CardenzaHAL" tag`,
      "Build it with CardenzaHAL (https://github.com/203-Systems/CardenzaHAL) to drop the tag; it is published anyway");
  }
  if (/dirty/i.test(report.version ?? "")) {
    warn("bin.dirty", `${name} says its version is ${report.version}: it was built with uncommitted changes`, "Commit, build again and publish that build");
  }
  if (!budget) warn("bin.unknown_device", `No Launcher layout is known for the device ${target}: its size is not checked here`, "The checker decides");
  report.ok = report.problems.length === 0;
  return report;
}

/**
 * A download-only device's UF2 file, read as the upload reads it (community/uf2.ts): whole 512-byte
 * blocks with UF2's magics, numbered in order, no file containers, the device's family on every block
 * that names one, something written to flash and nothing past what the device takes; for an ESP32
 * family an application image for that chip at address 0 (uf2conv.py -b 0x0). The report has the
 * inspectBin fields (kind "uf2", project, version, idf from the app inside) and `uf2` (blocks, family,
 * start, end).
 */
const UF2_FAMILY_CHIPS = {0xc47e5767: "esp32s3", 0xbfdd4eee: "esp32s2", 0xd42ba06c: "esp32c3", 0x1c5f21b0: "esp32", 0x540ddf62: "esp32c6", 0x332726f6: "esp32h2", 0x3d308e94: "esp32p4"};
export function inspectUf2(bytes, {target = "mystrix", file = "the UF2 file", firmwareKind = "app", device = null} = {}) {
  const known = UF2_DEVICES[target] ?? null;
  const family = typeof device?.uf2?.family_id === "string" ? Number(device.uf2.family_id) : known?.family ?? null;
  const max = device?.uf2?.max_size ?? known?.max ?? null;
  const devName = device?.name ?? known?.name ?? target;
  // The other devices of the family (their builds are refused when the app inside names one).
  const others = Array.isArray(device?.uf2?.others) ? device.uf2.others
    : Object.entries(UF2_DEVICES).filter(([t, d]) => t !== target && d.family === family).map(([t, d]) => ({target: t, name: d.name, build_name: d.build}));
  const report = {file, size: bytes.length, sha256: sha256(bytes), kind: "unknown", ok: false, problems: [], warnings: [],
    chip: null, project: null, version: null, idf: null, date: null, hal: null, sha256_appended: false, flash_size: null, budget: null, uf2: null};
  const name = path.basename(file);
  const problem = (code, message, hint) => report.problems.push({code, message, hint});
  const make = "Make it with Matrix OS's make uf2 (uf2conv.py -f <family> -b 0x0 -c -o firmware.uf2 build/<project>.bin)";
  if (firmwareKind === "launcher") { problem("bin.launcher_uf2", `A launcher is the 203 Launcher's: not for the ${devName}`, "Launchers are built for the Launcher's devices only"); return report; }
  if (!bytes.length) { report.kind = "empty"; problem("bin.empty", `${name} is empty`, make); return report; }
  if (bytes.length > LIMITS.image_bytes) { problem("bin.too_large", `${name} is ${size(bytes.length)}: a file is at most 16 MB`, make); return report; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = at => view.getUint32(at, true);
  if (bytes.length < 512 || word(0) !== 0x0a324655 || word(4) !== 0x9e5d5157) {
    report.kind = bytes[0] === 0xe9 ? "app" : "unknown";
    problem("bin.not_uf2", `${name} is not a UF2 file${bytes[0] === 0xe9 ? " (it is an ESP32 image)" : ""}: the ${devName} takes the .uf2 its bootloader reads`, make);
    return report;
  }
  report.kind = "uf2";
  if (bytes.length % 512) { problem("bin.uf2_broken", `${name}: ${bytes.length} bytes is not whole 512-byte blocks`, make); return report; }
  const head = new Uint8Array(512);
  let numbered = 0, of = 0, flash = 0, start = Infinity, end = 0, seen = null;
  for (let at = 0; at < bytes.length; at += 512) {
    const block = at / 512;
    if (word(at) !== 0x0a324655 || word(at + 4) !== 0x9e5d5157 || word(at + 508) !== 0x0ab16f30) { problem("bin.uf2_broken", `${name}: block ${block} has wrong magic numbers`, make); return report; }
    const flags = word(at + 8), address = word(at + 12), payload = word(at + 16), blockNo = word(at + 20), total = word(at + 24);
    if (payload < 1 || payload > 476) { problem("bin.uf2_broken", `${name}: block ${block} has a payload of ${payload} bytes`, make); return report; }
    if (blockNo === 0 && numbered === of) { numbered = 0; of = total; }
    if (total < 1 || total !== of || blockNo !== numbered) { problem("bin.uf2_broken", `${name}: block ${block} is numbered ${blockNo} of ${total}`, make); return report; }
    numbered++;
    if (flags & 0x1000) { problem("bin.uf2_broken", `${name}: block ${block} carries a file, not flash`, make); return report; }
    if (flags & 0x1) continue;
    if (flags & 0x2000) {
      const id = word(at + 28) >>> 0;
      if (family !== null && id !== family) {
        problem("bin.uf2_family", `${name} is for the family 0x${id.toString(16).padStart(8, "0")}, not the ${devName}'s 0x${family.toString(16).padStart(8, "0")}`,
          `Build it for the ${devName} (its family.mk's UF2_FAMILY_ID)`);
        return report;
      }
      seen ??= id;
    }
    flash++;
    start = Math.min(start, address);
    end = Math.max(end, address + payload);
    for (let k = 0; k < payload && address + k < 512; k++) head[address + k] = bytes[at + 32 + k];
  }
  if (numbered !== of) { problem("bin.uf2_broken", `${name} ends after block ${numbered - 1} of ${of}`, make); return report; }
  if (!flash) { problem("bin.uf2_broken", `${name}: no block writes flash`, make); return report; }
  report.uf2 = {blocks: bytes.length / 512, family_id: seen === null ? null : "0x" + seen.toString(16).padStart(8, "0"), start: "0x" + start.toString(16), end: "0x" + end.toString(16)};
  if (max && end > max) problem("bin.too_large_for_device", `${name} writes up to 0x${end.toString(16)}: more than the ${size(max)} the ${devName} takes`, "Make the firmware smaller");
  const chip = family !== null ? UF2_FAMILY_CHIPS[family] : undefined;
  const hv = new DataView(head.buffer);
  if (start === 0 && head[0] === 0xe9) {
    report.chip = CHIPS[hv.getUint16(12, true)] ?? `unknown (${hv.getUint16(12, true)})`;
    if (hv.getUint32(32, true) === 0xabcd5432) {
      report.project = cString(head, 80, 32); report.version = cString(head, 48, 32); report.idf = cString(head, 144, 32); report.date = cString(head, 128, 16);
    }
  }
  const other = report.project ? others.find(o => o.build_name && new RegExp("(^|[^A-Za-z0-9])" + o.build_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i").test(report.project)) : null;
  if (other) problem("bin.uf2_other_device", `${name}: the app inside is ${report.project}, a build for the ${other.name}, not the ${devName}`,
    `Give the ${devName}'s file${known?.build ? ` (MatrixOS-${known.build}-….uf2)` : ""}, or publish this one for the ${other.name}: --bin ${other.target ?? "<device>"}=${name}`);
  if (chip && !report.chip) problem("bin.uf2_no_app", `${name} has no ESP32 application image at address 0`, make);
  else if (chip && report.chip !== chip) problem("bin.wrong_chip", `${name}: the app inside is built for the ${report.chip}, not the ${chip}`, "Build it for the device's chip");
  report.ok = report.problems.length === 0;
  return report;
}

/** App images (*.bin) below a folder, newest first: suggestions when a BIN is missing or wrong. */
export function findAppImages(dirs, {depth = 3, limit = 4} = {}) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && level < depth && !["bootloader", "partition_table", "esp-idf", "CMakeFiles"].includes(entry.name)) walk(full, level + 1);
      else if (entry.isFile() && entry.name.endsWith(".bin")) {
        try {
          const stat = fs.statSync(full);
          if (stat.size < 288 || stat.size > LIMITS.image_bytes) continue;
          const head = Buffer.alloc(36);
          const fd = fs.openSync(full, "r"); fs.readSync(fd, head, 0, 36, 0); fs.closeSync(fd);
          if (head[0] === 0xe9 && head.readUInt32LE(32) === 0xabcd5432) found.push({path: full, mtime: stat.mtimeMs, size: stat.size});
        } catch { /* unreadable: skip */ }
      }
    }
  };
  for (const dir of dirs) walk(dir, 0);
  const unique = [...new Map(found.map(f => [f.path, f])).values()];
  return unique.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Covers, works, sound packs, projects, models: what a file is from its first bytes (storage.ts)

/** A picture's type and size: {mime, width, height} (PNG, JPEG, WebP), or null. */
export function imageInfo(bytes) {
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {mime: "image/png", width: bytes.length >= 24 ? view.getUint32(16) : null, height: bytes.length >= 24 ? view.getUint32(20) : null};
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let at = 2, width = null, height = null;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = (bytes[at + 5] << 8) | bytes[at + 6]; width = (bytes[at + 7] << 8) | bytes[at + 8];
        break;
      }
      at += 2 + length;
    }
    return {mime: "image/jpeg", width, height};
  }
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    let width = null, height = null;
    if (ascii(bytes, 12, "VP8 ") && bytes.length >= 30) { width = (bytes[26] | (bytes[27] << 8)) & 0x3fff; height = (bytes[28] | (bytes[29] << 8)) & 0x3fff; }
    else if (ascii(bytes, 12, "VP8L") && bytes.length >= 25) {
      const b = bytes; width = 1 + (((b[22] & 0x3f) << 8) | b[21]); height = 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    } else if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) {
      width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)); height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    }
    return {mime: "image/webp", width, height};
  }
  return null;
}

/** A cover picture: {ok, mime, width, height, problems, warnings}. */
export function inspectCover(bytes, file = "the cover") {
  const name = path.basename(file);
  const info = imageInfo(bytes);
  const report = {file, size: bytes.length, mime: info?.mime ?? null, width: info?.width ?? null, height: info?.height ?? null, problems: [], warnings: []};
  if (!info) {
    const what = ascii(bytes, 0, "<svg") || ascii(bytes, 0, "<?xml") ? "an SVG" : ascii(bytes, 0, "GIF8") ? "a GIF" : "not a PNG, JPEG or WebP picture";
    report.problems.push({code: "cover.type", message: `${name} is ${what}`, hint: "A cover is a PNG, JPEG or WebP picture (16:9, e.g. 1280x720, up to 2 MB)"});
  }
  if (bytes.length > LIMITS.cover_bytes) {
    report.problems.push({code: "cover.too_large", message: `${name} is ${size(bytes.length)}: a cover is at most 2 MB`, hint: "Save it smaller (JPEG or WebP, 1280x720)"});
  }
  if (info?.width && info?.height) {
    const ratio = info.width / info.height;
    if (Math.abs(ratio - 16 / 9) > 0.18) {
      report.warnings.push({code: "cover.ratio", message: `${name} is ${info.width}x${info.height}; covers are shown 16:9, cropped to the centre`,
        hint: "A 16:9 picture (e.g. 1280x720) shows whole"});
    }
    if (info.width < 640) report.warnings.push({code: "cover.small", message: `${name} is only ${info.width} pixels wide: it will look blurred`, hint: "Use at least 1280x720"});
  }
  report.ok = report.problems.length === 0;
  return report;
}

/** What a media file is from its first bytes (works and previews): a MIME type or null. */
export function mediaType(bytes) {
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 0, "fLaC")) return "audio/flac";
  if (ascii(bytes, 4, "ftyp")) return /^M4[AB ]/.test(String.fromCharCode(...bytes.subarray(8, 12))) ? "audio/mp4" : "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

const WORK_TYPES = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "video/webm"};

export function inspectWork(bytes, file) {
  const name = path.basename(file), ext = path.extname(file).toLowerCase();
  const report = {file, size: bytes.length, mime: mediaType(bytes), problems: [], warnings: []};
  if (!WORK_TYPES[ext]) {
    report.problems.push({code: "work.type", message: `${name}: a work is audio (.wav .mp3 .ogg .flac .m4a) or video (.mp4 .webm)`,
      hint: ext === ".ccproj" ? "A .ccproj is a project: 203c projects upload" : ext === ".ccpreset" ? "A .ccpreset is a sound bank: 203c sounds upload" : "Export the audio or video and upload that"});
  } else if (!report.mime) {
    report.problems.push({code: "work.content", message: `${name} does not look like ${ext.slice(1).toUpperCase()} inside`, hint: "Export it again; the server checks the first bytes"});
  } else if (report.mime.split("/")[0] !== WORK_TYPES[ext].split("/")[0] || (report.mime !== WORK_TYPES[ext] && !(ext === ".mp4" && report.mime === "audio/mp4"))) {
    report.problems.push({code: "work.mismatch", message: `${name} is ${report.mime} inside, not what ${ext} says`, hint: "Rename it to its real type or export it again"});
  }
  const video = (WORK_TYPES[ext] ?? "").startsWith("video");
  const max = video ? LIMITS.video_bytes : LIMITS.audio_bytes;
  if (bytes.length > max) report.problems.push({code: "work.too_large", message: `${name} is ${size(bytes.length)}: ${video ? "a video" : "audio"} is at most ${size(max)}`, hint: "Shorten or compress it"});
  report.kind = video ? "video" : "audio";
  report.mime = report.mime ?? WORK_TYPES[ext] ?? null;
  report.ok = report.problems.length === 0;
  return report;
}

// CardenzaSynth's files (storage.ts packFile): banks, projects, samples, previews.
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const PRESET_LINE = new RegExp(`^${QUOTED} ${QUOTED} ${QUOTED} \\d+\\r?$`);
export function packFileInfo(bytes) {
  const text = Buffer.from(bytes.subarray(0, 96)).toString("latin1").replace(/^ï»¿/, "");
  const bank = /^CARDENZA_PRESETS 1 "([a-z0-9_]{1,16})"\r?\n/.exec(text);
  if (bank) {
    const lines = new TextDecoder("utf-8").decode(bytes).split("\n").slice(1);
    return {type: "preset", engine: bank[1], known_engine: ENGINES.includes(bank[1]), presets: lines.filter(line => PRESET_LINE.test(line)).length};
  }
  const project = /^CARDENZA_PROJECT ([1-9][0-9]{0,2})\r?\n/.exec(text);
  if (project) {
    const seq = /(?:^|\n)SEQ ([0-9]{2,3})(?:[ \r\n])/.exec(Buffer.from(bytes.subarray(0, 65536)).toString("latin1"));
    const bpm = seq ? Number(seq[1]) : NaN;
    // The samples its tracks play (TRACK n kind "preset" "preset" "name" "sample"): they come with the project.
    const whole = new TextDecoder("utf-8").decode(bytes);
    const samples = [...whole.matchAll(new RegExp(`^TRACK \\d+ \\d+ ${QUOTED} ${QUOTED} ${QUOTED} "((?:[^"\\\\]|\\\\.)*)"`, "gm"))]
      .map(m => m[1].replace(/\\(.)/g, "$1")).filter(Boolean);
    return {type: "project", format: Number(project[1]), bpm: bpm >= 30 && bpm <= 300 ? bpm : null, samples: [...new Set(samples)]};
  }
  const media = mediaType(bytes);
  return {type: media === "audio/wav" ? "wav" : media === "audio/mpeg" ? "mp3" : media === "audio/ogg" ? "ogg" : null};
}

/** A sound pack's or project's files: {ok, problems, warnings, files:[{name, kind, size, info}], engine, presets, format, bpm}. */
export function inspectPack(kind, entries, {engine} = {}) {
  const report = {kind, problems: [], warnings: [], files: []};
  const problem = (code, message, hint) => report.problems.push({code, message, hint});
  const names = new Set();
  let total = 0;
  for (const entry of entries) {
    const info = packFileInfo(entry.bytes);
    const lower = entry.name.toLowerCase();
    total += entry.bytes.length;
    if (names.has(lower)) problem("pack.duplicate", `Two files are named ${entry.name}`, "Rename one: names are unique, ignoring case");
    names.add(lower);
    if (entry.name.length > 80 || entry.name.startsWith(".")) problem("pack.name", `${entry.name}: a file name is 1-80 characters, not starting with .`, "Rename it");
    report.files.push({name: entry.name, kind: entry.kind, size: entry.bytes.length, ...info});
    const max = LIMITS.pack_bytes[entry.kind];
    if (max && entry.bytes.length > max) problem("pack.too_large", `${entry.name} is ${size(entry.bytes.length)}: a ${entry.kind} is at most ${size(max)}`, "Make it smaller");
    if (entry.kind === "preset") {
      if (info.type !== "preset") problem("pack.not_bank", `${entry.name} is not a CardenzaSynth preset bank (its first line is not CARDENZA_PRESETS 1 "<engine>")`,
        "Copy the bank from the card's CardenzaSynth/Presets/<engine>/ folder as the device wrote it");
      else if (!info.known_engine) problem("pack.engine", `${entry.name} is a bank of the engine "${info.engine}", which CardenzaSynth does not have`, "Engines: " + ENGINES.join(", "));
      else if (!info.presets) report.warnings.push({code: "pack.empty_bank", message: `${entry.name} holds no presets`, hint: "Save some presets into it on the device first"});
    } else if (entry.kind === "project" && info.type !== "project") {
      problem("pack.not_project", `${entry.name} is not a CardenzaSynth project (its first line is not CARDENZA_PROJECT <n>)`, "Copy the .ccproj from the card's CardenzaSynth/Projects/ folder");
    } else if (entry.kind === "sample" && info.type !== "wav") {
      problem("pack.not_wav", `${entry.name} is not a WAV file inside`, "Samples are .wav files (RIFF/WAVE)");
    } else if (entry.kind === "preview" && !["wav", "mp3", "ogg"].includes(info.type)) {
      problem("pack.preview", `${entry.name} is not WAV, MP3 or Ogg inside`, "A preview is a .wav, .mp3 or .ogg recording");
    }
  }
  const count = k => report.files.filter(f => f.kind === k).length;
  if (total > LIMITS.pack_bytes.total) problem("pack.total", `The files are ${size(total)} together: at most 200 MB`, "Leave some samples out");
  if (kind === "sound") {
    if (!count("preset") && !count("sample")) problem("pack.nothing", "A sound pack needs at least one .ccpreset bank or one .wav sample", "Give the bank files (and samples)");
    if (count("preset") > LIMITS.pack_files.preset) problem("pack.banks", `${count("preset")} banks: at most 16`, "Split it into several packs");
    if (count("sample") > LIMITS.pack_files.sample) problem("pack.samples", `${count("sample")} samples: at most 64`, "Split it into several packs");
    const engines = [...new Set(report.files.filter(f => f.kind === "preset" && f.known_engine).map(f => f.engine))];
    report.engine = engine || (engines.length > 1 ? "mixed" : engines[0] ?? null);
    if (engine && engine !== "mixed" && engines.some(e => e !== engine)) {
      problem("pack.engine_mismatch", `--engine ${engine}, but the banks are ${engines.join(", ")}`, `Leave --engine out (it is read from the banks) or use --engine ${engines.length > 1 ? "mixed" : engines[0]}`);
    }
    if (!report.engine) problem("pack.no_engine", "No bank says which engine it is for", "Give --engine dx7|juno|sampler|drums (samples alone: the engine that plays them, e.g. sampler or drums)");
    report.presets = report.files.reduce((n, f) => n + (f.presets ?? 0), 0);
  } else {
    if (count("project") !== 1) problem("pack.one_project", `A project upload has exactly one .ccproj (${count("project")} given)`, "Give one .ccproj, plus its .wav samples");
    if (count("sample") > LIMITS.pack_files.project_samples) problem("pack.samples", `${count("sample")} samples: at most 32`, "Leave unused samples out");
    const project = report.files.find(f => f.kind === "project" && f.type === "project");
    report.format = project?.format ?? null; report.bpm = project?.bpm ?? null;
    // A sample a track plays that is not in the upload: that track is silent for whoever downloads it.
    const given = new Set(report.files.filter(f => f.kind === "sample").map(f => f.name.toLowerCase()));
    const missing = (project?.samples ?? []).filter(name => !given.has(path.basename(name.replace(/\\/g, "/")).toLowerCase()));
    if (missing.length) report.warnings.push({code: "pack.missing_sample", message: `${project.name} plays ${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} not in this upload`,
      hint: "Add the .wav files from the card's CardenzaSynth/Samples/ folder, or that track is silent for whoever downloads it"});
  }
  report.ok = report.problems.length === 0;
  return report;
}

/** A model file's type from its first bytes (storage.ts modelType). */
export function modelType(bytes) {
  if (bytes.length >= 84 && bytes.length === 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true)) return "stl";
  const start = Buffer.from(bytes.subarray(0, 64)).toString("latin1").replace(/^﻿/, "").trimStart();
  if (/^solid(\s|$)/i.test(start)) return "stl";
  if (start.startsWith("ISO-10303-21;")) return "step";
  if (ascii(bytes, 0, "PK\x03\x04")) return "zip";
  if (ascii(bytes, 0, "glTF")) return "glb";
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) return "png";
  const head = bytes.subarray(0, 4096);
  if (head.length && head.every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127))) return "text";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Release notes from a CHANGELOG, git

/** The CHANGELOG entry for this version ("## [1.4.0]", "## 1.4.0 - date", "# v1.4.0"), else null. */
export function changelogEntry(text, version) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => { if (/^#{1,3}\s/.test(line)) heads.push({i, line, level: line.match(/^#+/)[0].length}); });
  const want = String(version).replace(/^v/, "");
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = heads.find(h => new RegExp(`(^|[\\s\\[v(])${escaped}($|[\\s\\])—–:,-])`).test(h.line.replace(/^#+\s*/, "")));
  if (!hit) return null;
  const next = heads.find(h => h.i > hit.i && h.level <= hit.level);
  const body = lines.slice(hit.i + 1, next ? next.i : undefined).join("\n").trim();
  return body || null;
}

/** The top entry's heading and body (for a hint), or null. */
export function changelogTop(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => /^#{2,3}\s/.test(line));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(line));
  return {heading: lines[start].replace(/^#+\s*/, ""), body: lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim()};
}

/** git facts of a folder (for suggestions only): {head, dirty, remote (https), repo} or null. */
export function gitInfo(dir) {
  const git = args => {
    try {
      const run = spawnSync("git", ["-C", dir, ...args], {encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"]});
      return run.status === 0 ? run.stdout.trim() : null;
    } catch { return null; }
  };
  const head = git(["rev-parse", "HEAD"]);
  if (!head) return null;
  let remote = git(["remote", "get-url", "origin"]);
  if (remote) {
    remote = remote.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/").replace(/\/\/[^@/]+@/, "//");
    if (!/^https:\/\//.test(remote)) remote = null;
  }
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return {head, dirty: !!status, clone_url: remote ? remote.replace(/(\.git)?$/, ".git") : null, source_url: remote ? remote.replace(/\.git$/, "") : null};
}

export function resolveCommit(value, dir) {
  if (/^[0-9a-fA-F]{7,40}$/.test(value)) return {commit: value.toLowerCase()};
  try {
    const run = spawnSync("git", ["-C", dir, "rev-parse", "--verify", value + "^{commit}"], {encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"]});
    if (run.status === 0) return {commit: run.stdout.trim(), note: `--commit ${value} is ${run.stdout.trim().slice(0, 12)}`};
  } catch { /* no git */ }
  return {error: `"${value}" is not a commit`, hint: "--commit takes 7-40 hex digits: --commit $(git rev-parse HEAD)"};
}
