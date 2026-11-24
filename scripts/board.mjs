// 203cli board: a running firmware on CardenzaHAL, seen and driven from a computer over its USB cable (the HAL's development
// channel, CardenzaHAL docs/usb-dev.md; the bytes: board-usb.mjs). What it is (info), its flash (partitions), memory and
// tasks, the SD card, the I2C bus, its screen as a PNG (and the HAL's own screenshot, kept on its card), keys pressed as if
// by a finger, its last crash (core dump), files on its SD card, and the board's settings (CardenzaHAL docs/SETTINGS.md). No
// sign-in, like flash and log. Nothing here writes the device's flash itself: files on the card, and when asked, erasing the
// core dump; a setting changed here the device writes to its flash on its own, a second after the last change.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {spawnSync} from "node:child_process";
import {BoardError, OP, LIMITS, openBoard, concat, u32, i32, readU32, lostPart, settingsTooOld} from "./board-usb.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {nearest} from "./checks.mjs";
import {isPng, decodePng, rgb565Of} from "./png.mjs";

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Keys: the Cardenza's caps, numbered as the HAL numbers them (y * 14 + x + 1, y = 0 the top row); HOME, the side key, is 57.

export const KEY_ROWS = Object.freeze([
  ["esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "del"],
  ["tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"],
  ["fn", "shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "ok"],
  ["ctrl", "opt", "alt", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "space"],
]);
export const HOME_KEY = 57;
// Other names for keys: the arrows printed on ; . , / (yellow triangles: what lists, menus and the 203 Launcher take; in text
// input fn + them), and the symbols printed on del, shift and space.
export const KEY_ALIASES = Object.freeze({enter: "ok", up: ";", down: ".", left: ",", right: "/",
  "▲": ";", "▼": ".", "◀": ",", "▶": "/", "←": "del", "⇧": "shift", "␣": "space"});
const KEY_NUMBERS = new Map([...KEY_ROWS.flatMap((row, y) => row.map((name, x) => [name, y * 14 + x + 1])), ["home", HOME_KEY]]);
const KEY_NAMES_HELP = "esc 1-0 - = del / tab q-p [ ] \\ / fn shift a-l ; ' ok / ctrl opt alt z-m , . / space, home; up down left right (; . , /), enter (ok); " +
  "a number 10-57 or k1-k57 is the HAL's key number";

/** The HAL's number of a key (a cap's name, an alias, 10-57 or k1-k57), or null. The digits 0-9 are the digit keys. */
export function keyNumber(name) {
  const text = String(name).trim();
  const lower = text.toLowerCase();
  const known = KEY_NUMBERS.get(KEY_ALIASES[lower] ?? lower);
  if (known) return known;
  const m = /^(k)?(\d{1,2})$/.exec(lower);
  if (m && (m[1] || m[2].length === 2)) {
    const n = Number(m[2]);
    if (n >= 1 && n <= HOME_KEY) return n;
  }
  return null;
}
/** A key's name (its cap), from its number. */
export const keyName = n => (n === HOME_KEY ? "home" : KEY_ROWS[Math.floor((n - 1) / 14)]?.[(n - 1) % 14] ?? `k${n}`);

/** A key or keys pressed together (fn+s): their numbers, or a usage error. */
export function parseCombo(token, usage = message => new CliError("usage", message, {exit: EXIT.usage})) {
  const text = String(token);
  // "+" joins keys; a lone "+" is no key's name.
  const parts = text === "+" ? [""] : text.split("+");
  const keys = [];
  for (const part of parts) {
    const n = keyNumber(part);
    if (n === null) throw usage(`Unknown key "${part}"${parts.length > 1 ? ` in ${text}` : ""}`, {field: "KEY", hint: `Keys: ${KEY_NAMES_HELP}; keys pressed together: fn+s`});
    if (keys.includes(n)) throw usage(`${keyName(n)} twice in ${text}`, {field: "KEY"});
    keys.push(n);
  }
  return keys;
}

// Keys pressed together go down (and up, in reverse) this far apart: a scan and a frame of the firmware see the first alone.
export const COMBO_MS = 30;
/** The steps of pressing each group in turn: [{key, down, wait (ms after it)}]; nothing to wait after the last. */
export function pressSteps(groups, {hold = 100, gap = 100} = {}) {
  const steps = [];
  for (const keys of groups) {
    keys.forEach((key, i) => steps.push({key, down: true, wait: i < keys.length - 1 ? COMBO_MS : hold}));
    [...keys].reverse().forEach((key, i) => steps.push({key, down: false, wait: i < keys.length - 1 ? COMBO_MS : gap}));
  }
  if (steps.length) steps.at(-1).wait = 0;
  return steps;
}
/** `board keys` steps: KEY:down, KEY:up (fn+s:down for several), a number = milliseconds to wait after the step before it. */
export function parseSteps(tokens, usage) {
  const steps = [];
  for (const token of tokens) {
    const text = String(token);
    if (/^\d+$/.test(text)) {
      if (!steps.length) throw usage(`A wait (${text} ms) comes after a step`, {field: "STEP", hint: "e.g. fn:down s:down 200 s:up fn:up"});
      steps.at(-1).wait += Number(text);
      continue;
    }
    const at = text.lastIndexOf(":");
    const action = at > 0 ? text.slice(at + 1).toLowerCase() : "";
    if (!["down", "d", "up", "u"].includes(action)) {
      throw usage(`"${text}" is not a step`, {field: "STEP", hint: "A step is KEY:down or KEY:up (fn+s:down for several), and a number is the milliseconds to wait after the step before it"});
    }
    for (const key of parseCombo(text.slice(0, at), usage)) steps.push({key, down: action[0] === "d", wait: 0});
  }
  return steps;
}
/**
 * KEYS requests for steps: [{args, ms (the waits in it), after (ms to wait here before the next)}]. A wait longer than a step
 * holds (2.55 s) ends its request and the rest is waited for here (keys held from the computer stay down 10 s).
 */
export function keyRequests(steps, perRequest = Math.floor(LIMITS.args / 3)) {
  const out = [];
  let current = [], ms = 0;
  const flush = (after = 0) => {
    if (current.length) out.push({args: Uint8Array.from(current.flat()), ms, after});
    current = []; ms = 0;
  };
  for (const step of steps) {
    const units = Math.max(0, Math.round(step.wait / 10));
    const kept = Math.min(units, 255);
    current.push([step.key, step.down ? 1 : 0, kept]);
    ms += kept * 10;
    if (units > 255) flush((units - 255) * 10);
    else if (current.length >= perRequest) flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// The screen: SCREEN's answer (an 8-byte header, then RGB565 pixels, raw or run-length) as a PNG.

/** {version, width, height, encoding (0 raw, 1 run-length), source (0 a new frame, 1 the last one), pixels: Uint16Array}. */
export function decodeScreen(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < 8 || b[0] !== 0x53) throw new BoardError("bad_answer", "the screen's answer does not start with its header ('S')");
  const version = b[1], width = b[2] | (b[3] << 8), height = b[4] | (b[5] << 8), encoding = b[6], source = b[7];
  if (version !== 1) throw new BoardError("bad_answer", `the screen's format ${version} is newer than this 203cli (it reads 1): update 203cli`);
  if (!width || !height || width * height > 4 << 20) throw new BoardError("bad_answer", `the screen's size ${width} × ${height} is not a screen`);
  const pixels = new Uint16Array(width * height);
  if (encoding === 0) {
    if (b.length < 8 + pixels.length * 2) throw new BoardError("bad_answer", `the screen's answer is short: ${b.length - 8} bytes of pixels for ${width} × ${height}`);
    for (let i = 0; i < pixels.length; i++) pixels[i] = b[8 + 2 * i] | (b[9 + 2 * i] << 8);
  } else if (encoding === 1) {
    let at = 8, filled = 0;
    for (; at + 2 < b.length && filled < pixels.length; at += 3) {
      const count = b[at];
      if (!count || filled + count > pixels.length) throw new BoardError("bad_answer", `a run of ${count} pixels does not fit the screen`);
      pixels.fill(b[at + 1] | (b[at + 2] << 8), filled, filled + count);
      filled += count;
    }
    if (filled !== pixels.length) throw new BoardError("bad_answer", `the screen's runs give ${filled} pixels for ${width} × ${height}`);
  } else throw new BoardError("bad_answer", `the screen's encoding ${encoding} is unknown to this 203cli: update 203cli`);
  return {version, width, height, encoding, source, pixels};
}
/** RGB565 (red in bits 15-11) to 8-bit RGB, each channel spread to the full range. */
export function rgbOf(pixels) {
  const out = new Uint8Array(pixels.length * 3);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i], r = p >> 11, g = (p >> 5) & 0x3f, bl = p & 0x1f;
    out[3 * i] = (r << 3) | (r >> 2);
    out[3 * i + 1] = (g << 2) | (g >> 4);
    out[3 * i + 2] = (bl << 3) | (bl >> 2);
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
/** CRC-32 (ISO-HDLC, the PNG's and zlib's). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = n => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
function pngChunk(type, data) {
  const body = concat(enc.encode(type), data);
  return concat(be32(data.length), body, be32(crc32(body)));
}
/** A PNG of 8-bit RGB pixels, or RGBA with channels 4 (IHDR, one IDAT of the rows deflated, each with filter 0, IEND). */
export function encodePng(width, height, rgb, channels = 3) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = concat(be32(width), be32(height), Uint8Array.of(8, channels === 4 ? 6 : 2, 0, 0, 0));
  return concat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(zlib.deflateSync(raw, {level: 9}))), pngChunk("IEND", EMPTY));
}

// ---------------------------------------------------------------------------------------------
// Paths on the SD card: from its root, "/" between names, no "." or "..", at most 255 bytes.

/** A path on the card as the firmware takes it (a leading "/" or "/sdcard/" dropped); the root is "". */
export function cardPath(text, usage, {root = true, field = "PATH"} = {}) {
  let p = String(text ?? "").replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.replace(/^\/+(sdcard(\/|$))?/, "");
  const parts = p.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) throw usage(`${field} ${text}: no . or .. on the card`, {field, hint: "A path from the card's root, e.g. Projects/song.ccproj"});
  const joined = parts.join("/");
  if (!joined && !root) throw usage(`${field} is the card's root: name a file or folder`, {field, hint: "e.g. Projects/song.ccproj (203cli board files ls lists them)"});
  if (enc.encode(joined).length > LIMITS.path) throw usage(`${field} is longer than ${LIMITS.path} bytes`, {field});
  return joined;
}

// ---------------------------------------------------------------------------------------------
// Words for numbers

const trim = x => (x >= 100 ? String(Math.round(x)) : x >= 10 ? x.toFixed(1).replace(/\.0$/, "") : x.toFixed(2).replace(/\.?0+$/, ""));
/** Bytes as people read them: 512 B, 20 KB, 1.75 MB (1024s). */
export function size(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${trim(n / 1024)} KB`;
  if (n < 1 << 30) return `${trim(n / (1 << 20))} MB`;
  return `${trim(n / (1 << 30))} GB`;
}
export const hex = (n, width = 6) => (Number.isFinite(n) ? "0x" + n.toString(16).padStart(width, "0") : "?");
const percent = (part, whole) => (Number.isFinite(part) && whole ? `${Math.round((part * 100) / whole)} %` : "?");
export function duration(ms) {
  if (!Number.isFinite(ms)) return "?";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} d ${h % 24} h`;
  if (h) return `${h} h ${m % 60} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}
/** How many columns a text takes on a terminal: CJK and fullwidth characters two, combining marks none. */
export function textWidth(text) {
  let n = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return n;
}
const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - textWidth(text)));
const padStart = (text, width) => " ".repeat(Math.max(0, width - textWidth(text))) + text;
/** Rows as aligned columns (as wide as a terminal shows them); `right`: the columns aligned right. */
export function table(rows, right = []) {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, textWidth(String(cell ?? ""))); });
  return rows.map(row => row.map((cell, i) => {
    const text = String(cell ?? "");
    return right.includes(i) ? padStart(text, widths[i]) : i === row.length - 1 ? text : padEnd(text, widths[i]);
  }).join("  ").trimEnd()).join("\n");
}

// ---------------------------------------------------------------------------------------------
// A command's time with the board: the channel opened, Ctrl-C answered (CANCEL, so the firmware stops sending; the command's
// own clean-up runs: an upload aborted, a part file removed), errors said in 203cli's terms, the channel closed.

/**
 * The firmware's refusal (its reason) or the channel's trouble as a CliError. `need` "settings": the board's settings, which
 * every firmware on a current HAL answers (never "off"); "unknown request" there is a HAL from before them.
 */
export function boardCliError(error, ctx, {need = "dev", product = "the device"} = {}) {
  if (!(error instanceof BoardError)) return error;
  const again = ctx.cmd ? [ctx.cmd()] : [];
  const reason = error.reason ?? error.message;
  switch (error.code) {
    case "device":
      if (reason === "busy") return new CliError("board_busy", "The firmware's development channel is busy (its queue of 8 requests is full)", {exit: EXIT.later, next: again,
        hint: "Another program may be asking it too: wait a moment and run it again"});
      if (need === "settings") {
        if (reason === "unknown request") return settingsTooOld(product);
        if (reason === "unknown setting") {
          const typed = typedKey(ctx.args?.KEY);
          const gone = FORMER_SETTINGS[typed] ?? FORMER_SETTINGS[SETTING_ALIASES[typed]];
          return new CliError("board_refused", `The firmware refused: ${reason}`, {exit: EXIT.refused, data: {reason},
            hint: `This firmware's CardenzaHAL does not have that setting${gone ? ` (${gone})` : ""}: 203cli board settings lists the ones it has`});
        }
        return new CliError("board_refused", `The firmware refused: ${reason}`, {exit: EXIT.refused, hint: "Read the reason; 203cli board settings lists what the device has", data: {reason}});
      }
      if (reason === "off") return new CliError("dev_channel_off", "This firmware was built without the development channel (CONFIG_CARDENZA_HAL_USB_DEV is off)", {exit: EXIT.refused,
        hint: "Turn it on (CONFIG_CARDENZA_HAL_USB_DEV=y), build and install it again; 203cli board settings works without it"});
      return new CliError("board_refused", `The firmware refused: ${reason}`, {exit: EXIT.refused, hint: refusalHint(reason), data: {reason}});
    case "timeout":
    case "gap":
      return new CliError("board_timeout", `The device stopped answering: ${error.message}`, {exit: EXIT.later, next: again,
        hint: "Run it again; when it keeps happening the firmware is stuck or too busy to answer (its log: 203cli log)"});
    case "gone":
    case "closed":
      return new CliError("board_lost", `The connection to the device was lost: ${error.message}`, {exit: EXIT.later, next: again,
        hint: "It restarted or was unplugged: plug it in, let the firmware start, and run it again"});
    case "cancelled":
      return new CliError("board_timeout", "The firmware cancelled the answer", {exit: EXIT.later, next: again, hint: "Run it again"});
    default:
      return new CliError("board_protocol", `The firmware's answer is not what this 203cli reads: ${error.message}`, {exit: EXIT.refused,
        hint: "Update 203cli (npm install -g 203cli); if it is current, the firmware's CardenzaHAL may be newer or broken: report it (feedback --kind bug)"});
  }
}
function refusalHint(reason) {
  if (/framebuffer/i.test(reason)) return "This firmware draws through the panel's handles itself (Display::GetPanel): there is no frame to copy";
  if (/memory/i.test(reason)) return "The firmware has too little free memory for it now (203cli board memory shows it): run it again in a moment, or take the frame as it is with 203cli board screen";
  if (/not found|no such|enoent/i.test(reason)) return "Check the path: 203cli board files ls lists the card";
  if (/card|mount/i.test(reason)) return "Is there an SD card? 203cli board storage says whether one is mounted";
  if (/exist/i.test(reason)) return "Something has that name already: remove it first (203cli board files rm), or choose another";
  if (/coredump|core dump/i.test(reason)) return "203cli board partitions shows whether the table has a coredump partition";
  return "Read the reason; 203cli board status and 203cli board storage say more about the device";
}

/**
 * Opens the channel, runs `work(board)`, closes it. ctx.boardLinks: the ways to the device (the tests' stand-in). `need`:
 * "dev" (the development channel's questions) or "settings" (the board's settings), as openBoard takes it.
 */
export async function session(ctx, work, {need = "dev"} = {}) {
  const board = await openBoard({links: ctx.boardLinks ?? null, need});
  let stopped = false;
  const onSignal = () => {
    if (stopped) process.exit(130);
    stopped = true;
    board.interrupted = true;
    process.stderr.write("\n203cli: stopping (the device is told to stop sending)…\n");
    board.cancel({ms: 300}).catch(() => {});
    setTimeout(() => process.exit(130), 3000).unref();
  };
  process.on("SIGINT", onSignal);
  try {
    return await work(board);
  } catch (error) {
    if (board.interrupted) { await board.close(); process.exit(130); }
    throw boardCliError(error, ctx, {need, product: board.identity?.product || board.name});
  } finally {
    process.removeListener("SIGINT", onSignal);
    await board.close();
  }
}

/** A progress line on a terminal (not with --json, not to a pipe): bytes, of how many, and KB/s. */
function meter(ctx, label) {
  const tty = !ctx.json && !!process.stderr.isTTY && typeof ctx.progress === "function";
  const started = Date.now();
  let shown = 0;
  return {
    update(got, total) {
      if (!tty) return;
      const now = Date.now();
      if (now - shown < 100 && got !== total) return;
      shown = now;
      const rate = got / Math.max(0.001, (now - started) / 1000);
      ctx.progress(`\r${label}  ${size(got)}${total ? ` of ${size(total)} (${percent(got, total)})` : ""}  ${size(Math.round(rate))}/s\x1b[K`);
    },
    end() { if (tty && shown) ctx.progress("\r\x1b[K"); },
    seconds: () => (Date.now() - started) / 1000,
  };
}
const rateOf = (bytes, seconds) => `${size(Math.round(bytes / Math.max(seconds, 0.001)))}/s`;
const usageOf = ctx => ctx.usage ?? ((message, extra = {}) => new CliError("usage", message, {exit: EXIT.usage, ...extra}));

// ---------------------------------------------------------------------------------------------
// info, partitions, memory, storage, status, i2c

const via = board => `${board.via === "rawmidi" || board.via === "coremidi" ? "MIDI" : board.via === "serial" ? "serial port" : "HID"} (${board.where})`;

export async function boardInfo(ctx) {
  return session(ctx, async board => {
    const info = await board.json(OP.INFO);
    return {json: info, text: infoText(info, board)};
  });
}
export function infoText(i, board = null) {
  const f = i.firmware ?? {}, chip = i.chip ?? {}, lines = [];
  lines.push([f.name ?? "A firmware", f.version, f.code ? `(${f.code})` : null, f.product ? `on ${f.product}` : null].filter(Boolean).join(" "));
  const row = (label, value) => { if (value !== null && value !== undefined && value !== "") lines.push(`  ${label.padEnd(12)} ${value}`); };
  row("built", [f.built, f.idf ? `ESP-IDF ${f.idf}` : null, f.secure_version ? `secure version ${f.secure_version}` : null].filter(Boolean).join(", "));
  row("ELF SHA-256", f.elf_sha256 ? `${f.elf_sha256} (decode its backtraces with that ELF)` : null);
  row("CardenzaHAL", i.hal ? `${i.hal.commit ?? "?"}${i.hal.dirty ? " (built with local changes)" : ""}` : null);
  row("Launcher", i.launcher ? [i.launcher.name ?? "203 Launcher", i.launcher.version].filter(Boolean).join(" ") : "none on this board");
  row("chip", [chip.model, chip.revision ? `rev ${chip.revision}` : null, chip.cores ? `${chip.cores} cores` : null, chip.cpu_mhz ? `${chip.cpu_mhz} MHz` : null,
    chip.flash_bytes ? `flash ${size(chip.flash_bytes)}` : null, chip.psram_bytes ? `PSRAM ${size(chip.psram_bytes)}` : chip.psram_bytes === 0 ? "no PSRAM" : null,
    chip.mac ? `MAC ${chip.mac}` : null].filter(Boolean).join(", "));
  row("running", `${duration(i.uptime_ms)} since its last reset (${i.reset ?? "?"}${i.wakeup ? `, woken by ${i.wakeup}` : ""})`);
  const init = Object.entries(i.hal_init ?? {});
  if (init.length) {
    const failed = init.filter(([, ok]) => !ok).map(([part]) => part);
    row("HAL started", init.filter(([, ok]) => ok).map(([part]) => part).join(", ") + (failed.length ? `; did not start: ${failed.join(", ")}` : ""));
  }
  if (board) row("USB", `${via(board)}, development channel protocol ${i.protocol ?? board.protocol ?? "?"}`);
  return lines.join("\n");
}

export async function boardPartitions(ctx) {
  return session(ctx, async board => {
    const parts = await board.json(OP.PARTITIONS);
    return {json: parts, text: partitionsText(parts)};
  });
}
export function partitionsText(p) {
  const rows = [["", "label", "type", "subtype", "offset", "size", "", "use"]];
  for (const part of p.partitions ?? []) {
    const running = part.running === true || (p.running && part.label === p.running);
    let use = "";
    if (part.nvs) use = `NVS: ${part.nvs.used} of ${part.nvs.entries} entries used (${percent(part.nvs.used, part.nvs.entries)}), ${part.nvs.pages} pages`;
    else if (part.type === "app") use = Number.isFinite(part.image) ? `image ${size(part.image)} (${percent(part.image, part.size)})` : "no image";
    if (running) use = `${use}${use ? ", " : ""}running`;
    rows.push([running ? "*" : "", part.label, part.type, part.subtype, hex(part.offset), hex(part.size), size(part.size), use]);
  }
  const lines = [table(rows, [6])];
  const notes = [];
  if (Number.isFinite(p.flash_bytes)) notes.push(`flash ${size(p.flash_bytes)}`);
  if (Number.isFinite(p.free_bytes)) notes.push(`${size(p.free_bytes)} free after the last partition`);
  if (p.running) notes.push(`* running: ${p.running}`);
  if (notes.length) lines.push("", notes.join("; ") + ".");
  return lines.join("\n");
}

export async function boardMemory(ctx) {
  const window = ctx.flags?.window;
  let args = EMPTY;
  if (window !== undefined) {
    if (!Number.isInteger(window) || window < 10 || window > 2550) throw usageOf(ctx)(`--window is 10-2550 ms, not ${window}`, {field: "window"});
    args = Uint8Array.of(Math.max(1, Math.min(255, Math.round(window / 10))));
  }
  return session(ctx, async board => {
    const memory = await board.json(OP.MEMORY, args, {timeout: board.timeout + (window ?? 500)});
    return {json: memory, text: memoryText(memory)};
  });
}
export function memoryText(m) {
  const heap = (name, h) => (h ? [name, size(h.total), size(h.free), size(h.min_free), size(h.largest)] : null);
  const rows = [["", "total", "free", "least free", "largest block"], heap("internal", m.internal)];
  if (m.psram && m.psram.total) rows.push(heap("PSRAM", m.psram));
  if (m.dma) rows.push(["DMA-capable", "", size(m.dma.free), "", size(m.dma.largest)]);
  const lines = [table(rows.filter(Boolean), [1, 2, 3, 4])];
  if (!(m.psram && m.psram.total)) lines.push("No PSRAM in use.");
  if (!Array.isArray(m.tasks)) {
    lines.push("", "Tasks: not known: the firmware is built without CONFIG_FREERTOS_USE_TRACE_FACILITY (set it to y in its sdkconfig.defaults; the board's defaults do).");
    return lines.join("\n");
  }
  const cpu = m.tasks.some(t => Number.isFinite(t.cpu));
  const tasks = [...m.tasks].sort(cpu ? (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || String(a.name).localeCompare(String(b.name))
    : (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.name).localeCompare(String(b.name)));
  const head = ["task", "core", "priority", "state", "stack free", ...(cpu ? ["CPU"] : [])];
  const rows2 = tasks.map(t => [t.name, t.core === -1 ? "both" : t.core ?? "?", t.priority ?? "?", t.state ?? "?", Number.isFinite(t.stack_free) ? `${t.stack_free} B` : "?",
    ...(cpu ? [Number.isFinite(t.cpu) ? `${t.cpu.toFixed(1)} %` : ""] : [])]);
  lines.push("", `${tasks.length} tasks${cpu ? `, CPU over ${m.cpu_window_ms ?? "?"} ms (percent of one core)` : ", by priority"}; stack free: the least each has had`);
  lines.push(table([head, ...rows2], [1, 2, 4, 5]));
  if (!cpu) lines.push("", "CPU per task: not measured: build the firmware with CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS=y (the board's debug defaults set it).");
  return lines.join("\n");
}

export async function boardStorage(ctx) {
  return session(ctx, async board => {
    const s = await board.json(OP.STORAGE);
    return {json: s, text: storageText(s)};
  });
}
export function storageText(s) {
  if (!s.mounted) return `No SD card mounted${s.card_bytes ? ` (a card of ${size(s.card_bytes)} is there)` : ""}.`;
  const used = Number.isFinite(s.total) && Number.isFinite(s.free) ? s.total - s.free : null;
  return [`SD card mounted at ${s.path ?? "?"}${s.card_bytes ? `: a ${size(s.card_bytes)} card` : ""}`,
    `  file system ${size(s.total)}, ${size(s.free)} free${used !== null ? `, ${size(used)} used (${percent(used, s.total)})` : ""}`].join("\n");
}

export async function boardStatus(ctx) {
  return session(ctx, async board => {
    const s = await board.json(OP.STATUS);
    return {json: s, text: statusText(s)};
  });
}
const onOff = v => (v === true ? "yes" : v === false ? "no" : "?");
export function statusText(s) {
  const lines = [];
  const row = (label, value) => lines.push(`${label.padEnd(12)} ${value}`);
  if (s.display) row("display", `ready ${onOff(s.display.ready)}, framebuffer ${onOff(s.display.framebuffer)}, backlight ${s.display.brightness ?? "?"}`);
  if (s.keyboard) {
    const down = (s.keyboard.down ?? []).map(keyName);
    row("keys", `${down.length ? `down: ${down.join(", ")}` : "none down"}; key light brightness ${s.keyboard.led_brightness ?? "?"}`);
  }
  if (s.menu) row("system menu", `${s.menu.enabled ? "on" : "off"}${s.menu.open ? ", open" : ", closed"}`);
  if (s.usb) row("USB", `mounted ${onOff(s.usb.mounted)}; audio to the computer ${s.usb.audio_in ? "on" : "off"}, from it ${s.usb.audio_out ? "on" : "off"}; playback restarts ${s.usb.playback_restarts ?? "?"}`);
  row("presence", s.presence ?? "none (no presence service in this firmware)");
  return lines.join("\n");
}

export async function boardI2c(ctx) {
  return session(ctx, async board => {
    const bus = await board.json(OP.I2C);
    return {json: bus, text: i2cText(bus)};
  });
}
export function i2cText(bus) {
  const devices = bus.devices ?? [];
  return [`I2C bus SDA GPIO${bus.sda ?? "?"}, SCL GPIO${bus.scl ?? "?"}: ${devices.length === 1 ? "1 device answers" : `${devices.length} devices answer`}`,
    ...devices.map(d => `  ${hex(d.address, 2)}  ${d.name ?? "unknown"}`)].join("\n");
}

// ---------------------------------------------------------------------------------------------
// screen

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export async function boardScreen(ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const file = path.resolve(cwd, String(ctx.flags?.out ?? `cardenza-${stamp()}.png`));
  if (!fs.existsSync(path.dirname(file))) throw new CliError("file_not_found", `The folder of --out does not exist (${path.dirname(file)})`, {field: "out"});
  return session(ctx, async board => {
    const bytes = await board.ask(OP.SCREEN, EMPTY, {timeout: board.timeout});
    const screen = decodeScreen(bytes);
    fs.writeFileSync(file, encodePng(screen.width, screen.height, rgbOf(screen.pixels)));
    const source = screen.source === 0 ? "new" : "last";
    if (!ctx.json) ctx.say?.(`${screen.width} × ${screen.height}, ${source === "new" ? "a frame the firmware presented after the request" : "the firmware's last frame (it presented none for 250 ms)"}`);
    return {json: {path: file, width: screen.width, height: screen.height, encoding: screen.encoding === 1 ? "rle" : "raw", source, bytes: bytes.length}, text: file};
  });
}

// ---------------------------------------------------------------------------------------------
// screenshot: SCREENSHOT (0x12, CardenzaHAL from 2026-11-24 on; HELLO says "screenshot": true), the HAL's own screenshot, the
// same as HOME + space on the device: a PNG of the screen saved on its SD card in /screenshot/ (queued for the account the
// device is bound to when auto-upload is on), sent back here too; or raw RGB565 instead of the PNG. Args [flags]: bit 0 save,
// 1 return, 2 raw, 3 quiet (no flash or toast). Its answer: 'K', version 1, format (0 PNG, 1 raw RGB565), saved (0 not asked,
// 1 saved, 2 no SD card, 3 the card refused the write), width and height (u16), the name's length (u8) and the name (the file
// in /screenshot/, empty when not saved), u32 the data's length, the data.

export const SHOT_FLAG = Object.freeze({save: 1, return: 2, raw: 4, quiet: 8});
/** The saved byte in words: what happened on the card. */
export const SHOT_SAVED = Object.freeze(["not_asked", "saved", "no_card", "card_refused"]);
/** The folder at the card's root the HAL saves screenshots in. */
export const SHOT_FOLDER = "screenshot";
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** The answer's head once enough of it came: {version, format, saved, width, height, name, length, at (where the data starts)}; else null. */
export function screenshotHead(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (!b.length) return null;
  if (b[0] !== 0x4b) throw new BoardError("bad_answer", "the screenshot's answer does not start with its header ('K')");
  if (b.length < 9) return null;
  const version = b[1];
  if (version !== 1) throw new BoardError("bad_answer", `the screenshot's format ${version} is newer than this 203cli (it reads 1): update 203cli`);
  const n = b[8];
  if (b.length < 13 + n) return null;
  return {version, format: b[2], saved: b[3], width: b[4] | (b[5] << 8), height: b[6] | (b[7] << 8),
    name: Buffer.from(b.subarray(9, 9 + n)).toString("latin1"), length: readU32(b, 9 + n), at: 13 + n};
}

/** The whole answer, checked: its head and `data` (the PNG, or width × height RGB565 pixels). */
export function decodeScreenshot(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const head = screenshotHead(b);
  if (!head) throw new BoardError("bad_answer", `the screenshot's answer is short: ${b.length} bytes, not its whole header`);
  const {format, width, height, name, length} = head;
  if (format !== 0 && format !== 1) throw new BoardError("bad_answer", `the screenshot's format ${format} is unknown to this 203cli: update 203cli`);
  if (!width || !height || width * height > 4 << 20) throw new BoardError("bad_answer", `the screenshot's size ${width} × ${height} is not a screen`);
  if (name && !SHOT_NAME.test(name)) throw new BoardError("bad_answer", `the screenshot's name "${name}" is not a file name`);
  const data = b.subarray(head.at, head.at + length);
  if (data.length < length) throw new BoardError("bad_answer", `the screenshot's answer is short: ${data.length} of its ${length} bytes`);
  if (length && format === 1 && length !== width * height * 2) throw new BoardError("bad_answer", `${length} bytes of RGB565 for ${width} × ${height}`);
  if (length && format === 0 && !isPng(data)) throw new BoardError("bad_answer", "the screenshot's data is not a PNG");
  return {...head, data};
}

/** RGB565 pixels as the device's raw bytes (u16 little-endian). */
const rgb565Bytes = pixels => Uint8Array.from({length: pixels.length * 2}, (_, i) => (i & 1 ? pixels[i >> 1] >> 8 : pixels[i >> 1] & 0xff));
/** The device's raw bytes as RGB565 pixels. */
const pixelsOf = data => Uint16Array.from({length: data.length >> 1}, (_, i) => data[2 * i] | (data[2 * i + 1] << 8));

/**
 * SCREENSHOT asked and its answer put together. A busy device (taking another one) is asked again a moment later. Part of the
 * answer lost: without save asked again; with save the PNG is on the card already, so it is read from there (GET).
 */
async function takeScreenshot(ctx, board, flags) {
  const save = !!(flags & SHOT_FLAG.save);
  const shown = meter(ctx, "screenshot");
  try {
    for (let attempt = 0; ; attempt++) {
      const chunks = [];
      let got = 0, head = null;
      try {
        await board.request(OP.SCREENSHOT, Uint8Array.of(flags), {timeout: board.timeout + 5000, onPayload: chunk => {
          chunks.push(Uint8Array.from(chunk));
          got += chunk.length;
          if (!head) head = screenshotHead(concat(...chunks));
          shown.update(got, head ? head.at + head.length : 0);
        }});
        return decodeScreenshot(concat(...chunks));
      } catch (error) {
        if (!(error instanceof BoardError)) throw error;
        if (error.code === "device" && error.reason === "busy") {
          if (attempt < 4) { await sleep(400); continue; }
          throw new CliError("board_busy", "The device is busy: it is taking another screenshot, or its development channel has 8 requests queued", {exit: EXIT.later,
            next: ctx.cmd ? [ctx.cmd()] : [], hint: "Run it again in a moment"});
        }
        if (!lostPart(error)) throw error;
        if (!save) {
          if (attempt >= 2) throw error;
          await board.cancel();
          continue;
        }
        let known = null;
        try { known = screenshotHead(concat(...chunks)); } catch { known = null; }
        if (known?.saved === 1 && known.name && SHOT_NAME.test(known.name)) {
          await board.cancel();
          const parts = [];
          await getFile(board, `${SHOT_FOLDER}/${known.name}`, chunk => parts.push(Uint8Array.from(chunk)));
          const data = concat(...parts);
          if (!isPng(data)) throw new BoardError("bad_answer", `/${SHOT_FOLDER}/${known.name} on the card is not a PNG`);
          return {...known, format: 0, length: data.length, data, from_card: true};
        }
        throw new CliError("board_timeout", `The screenshot's answer was cut short (${error.message})`, {exit: EXIT.later, next: ctx.cmd ? [ctx.cmd()] : [],
          hint: `The device may have saved it on its card already (203cli board files ls ${SHOT_FOLDER}); run it again, or with --no-save to only bring the pixels here`});
      }
    }
  } finally { shown.end(); }
}

/**
 * The firmware's HAL has no SCREENSHOT (HELLO does not say "screenshot", or the op answers "unknown request" / "off"): with
 * --no-save the frame comes through SCREEN instead (the same pixels, nothing on the device's screen); else it says so.
 */
async function screenshotWithoutOp(ctx, board, {save, rawFile, fileFor, why, off = false}) {
  const product = board.identity?.product || board.name || "the device";
  if (save) {
    throw new CliError("hal_too_old", (off ? `The firmware on ${product} answers the screenshot (USB op 0x12) "off": its CardenzaHAL was built without it`
      : `The firmware on ${product} was built with a CardenzaHAL older than its screenshot (USB op 0x12; ${why})`) + ": it cannot save one on its SD card or upload it", {exit: EXIT.refused,
      hint: "Only the pixels, here: the same command with --no-save (or 203cli board screen). To save it on the card and upload it to the account: rebuild the firmware " +
        "with a current CardenzaHAL (update the HAL submodule to its main branch: git -C components/CardenzaHAL pull origin main, or the project's own way, e.g. make " +
        "hal-update), install it with 203cli flash --bin build/<project>.bin, then run this again",
      next: [ctx.cmd?.({add: {no_save: true}}), ctx.run?.(["board", "screen"])].filter(Boolean), data: {needs: "screenshot", protocol: board.identity?.protocol ?? null}});
  }
  const answer = await board.ask(OP.SCREEN, EMPTY, {timeout: board.timeout});
  const screen = decodeScreen(answer);
  const bytes = rawFile ? rgb565Bytes(screen.pixels) : encodePng(screen.width, screen.height, rgbOf(screen.pixels));
  const file = fileFor("");
  fs.writeFileSync(file, bytes);
  const note = `This firmware's CardenzaHAL has no screenshot of its own (USB op 0x12; ${why}): the frame came through SCREEN instead (the same pixels; nothing saved, no flash on the device)`;
  ctx.say?.(`${screen.width} × ${screen.height}. ${note}.`);
  return {json: {path: file, name: null, saved: false, card: "not_asked", width: screen.width, height: screen.height, format: rawFile ? "rgb565" : "png",
    device_format: "rgb565", bytes: bytes.length, via: "screen", note}, text: file};
}

export async function boardScreenshot(ctx) {
  const o = ctx.flags ?? {}, cwd = ctx.cwd ?? process.cwd();
  const save = !o.no_save;
  const out = o.out !== undefined ? path.resolve(cwd, String(o.out)) : null;
  // --out a folder: one there, or a path ending in / (made when its parent is there).
  const intoFolder = !!out && ((fs.existsSync(out) && fs.statSync(out).isDirectory()) || /[\\/]$/.test(String(o.out)));
  if (out && !fs.existsSync(path.dirname(out))) throw new CliError("file_not_found", `The folder of --out does not exist (${path.dirname(out)})`, {field: "out"});
  // --out FILE.rgb565: the device's raw frame as it is; else a PNG (the device's, or made here from its raw frame with --raw).
  const rawFile = !!out && !intoFolder && /\.rgb565$/i.test(out);
  const flags = (save ? SHOT_FLAG.save : 0) | SHOT_FLAG.return | (o.raw || rawFile ? SHOT_FLAG.raw : 0) | (o.quiet ? SHOT_FLAG.quiet : 0);
  const fileFor = name => {
    if (out && !intoFolder) return out;
    if (intoFolder) fs.mkdirSync(out, {recursive: true});
    return path.join(intoFolder ? out : cwd, name || "screenshot.png");
  };
  return session(ctx, async board => {
    if (board.helloed?.screenshot !== true) return screenshotWithoutOp(ctx, board, {save, rawFile, fileFor, why: "its HELLO does not list it"});
    let shot;
    try { shot = await takeScreenshot(ctx, board, flags); } catch (error) {
      if (error instanceof BoardError && error.code === "device" && ["unknown request", "off"].includes(error.reason)) {
        return screenshotWithoutOp(ctx, board, {save, rawFile, fileFor, why: `it answered "${error.reason}"`, off: error.reason === "off"});
      }
      throw error;
    }
    let bytes;
    if (rawFile) bytes = shot.format === 1 ? shot.data : rgb565Of(pngPixels(shot.data));
    else bytes = shot.format === 0 ? shot.data : encodePng(shot.width, shot.height, rgbOf(pixelsOf(shot.data)));
    const file = fileFor(shot.name);
    fs.writeFileSync(file, bytes);
    const card = SHOT_SAVED[shot.saved] ?? `unknown (${shot.saved})`;
    const where = `/${SHOT_FOLDER}/${shot.name}`;
    const note = shot.saved === 2 ? "Not saved on the device: it has no SD card (the picture is only here)"
      : shot.saved === 3 ? "Not saved on the device: its SD card refused the write (full, read-only or failing: 203cli board storage says more); the picture is only here"
        : shot.saved === 1 && !shot.name ? "Saved on the device's SD card (it gave no name)" : null;
    // (ctx.say writes nothing with --json.)
    ctx.say?.(`${shot.width} × ${shot.height}, ${shot.format === 0 ? "the device's PNG" : "raw RGB565 from the device"}${rawFile ? ", written as RGB565" : shot.format === 1 ? ", written as a PNG" : ""} (${size(bytes.length)})` +
      `${shot.from_card ? "; read back from its card (part of the answer was lost)" : ""}.`);
    if (shot.saved === 1 && shot.name) {
      ctx.say?.(`On the device's SD card as ${where}; uploaded to the account the device is bound to when its auto-upload is on (the board's screenshot_upload, on by default) and it is online: 203cli screenshots list.`);
    }
    if (note) ctx.say?.(`${note}.`);
    return {json: {path: file, name: shot.name || null, saved: shot.saved === 1, card, ...(shot.saved === 1 && shot.name ? {card_path: where} : {}),
      width: shot.width, height: shot.height, format: rawFile ? "rgb565" : "png", device_format: shot.format === 0 ? "png" : "rgb565", bytes: bytes.length,
      quiet: !!o.quiet, via: shot.from_card ? "screenshot+card" : "screenshot", ...(note ? {note} : {})}, text: file};
  });
}
/** A PNG's pixels as 8-bit RGB (for its RGB565 bytes); a PNG this 203cli cannot read is the device's fault. */
function pngPixels(data) {
  try { return decodePng(data); } catch (error) { throw new BoardError("bad_answer", `the device's PNG cannot be read: ${error.message}`); }
}

// ---------------------------------------------------------------------------------------------
// press, keys

async function runKeys(board, steps) {
  let last = null;
  for (const request of keyRequests(steps, Math.floor(board.maxArgs / 3))) {
    last = await board.json(OP.KEYS, request.args, {timeout: board.timeout + request.ms, retries: 0});
    if (request.after) await sleep(request.after);
  }
  if (!last) last = await board.json(OP.KEYS, EMPTY, {retries: 0});
  return Array.isArray(last?.down) ? last.down : [];
}

export async function boardPress(ctx) {
  const usage = usageOf(ctx);
  const ms = (flag, fallback) => {
    const value = ctx.flags?.[flag] ?? fallback;
    if (!Number.isInteger(value) || value < 0 || value > 9000) throw usage(`--${flag} is 0-9000 ms, not ${value}`, {field: flag});
    return value;
  };
  const hold = ms("hold", 100), gap = ms("gap", 100);
  const tokens = ctx.args.KEY ?? [];
  const groups = tokens.map(token => parseCombo(token, usage));
  const steps = pressSteps(groups, {hold, gap});
  return session(ctx, async board => {
    const down = await runKeys(board, steps);
    const pressed = tokens.map(token => String(token).toLowerCase());
    return {json: {pressed, keys: groups, steps: steps.length, down},
      text: `Pressed ${pressed.join(", ")}.${down.length ? ` Still down: ${down.map(keyName).join(", ")} (let go 10 s after the last request)` : ""}`};
  });
}

export async function boardKeys(ctx) {
  const steps = parseSteps(ctx.args.STEP ?? [], usageOf(ctx));
  for (const step of steps) {
    if (step.wait > 9000) throw usageOf(ctx)(`A wait of ${step.wait} ms: keys held from the computer are let go 10 s after the last request`, {field: "STEP", hint: "Wait at most 9000 ms at a time"});
  }
  return session(ctx, async board => {
    const down = await runKeys(board, steps);
    return {json: {steps: steps.length, down},
      text: `${steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"} done. ` : ""}${down.length ? `Down from the computer: ${down.map(keyName).join(", ")}` : "No key is held from the computer"}.`};
  });
}

// ---------------------------------------------------------------------------------------------
// coredump

export const ADDR2LINE = "xtensa-esp32s3-elf-addr2line";
/** The backtrace's addresses decoded with the firmware's ELF: {lines} or {missing: true} (no addr2line on PATH) or {error}. */
export function decodeBacktrace(elf, addresses, {env = process.env} = {}) {
  const run = spawnSync(ADDR2LINE, ["-pfiaC", "-e", elf, ...addresses], {encoding: "utf8", env, windowsHide: true});
  if (run.error) return run.error.code === "ENOENT" ? {missing: true} : {error: run.error.message};
  if (run.status !== 0) return {error: String(run.stderr || run.stdout).trim().split("\n").pop() || `exit ${run.status}`};
  return {lines: String(run.stdout).trim().split("\n").filter(Boolean)};
}

export async function boardCoredump(ctx) {
  const o = ctx.flags ?? {}, cwd = ctx.cwd ?? process.cwd();
  const out = o.out ? path.resolve(cwd, String(o.out)) : null;
  const elf = o.elf ? path.resolve(cwd, String(o.elf)) : null;
  if (out && !fs.existsSync(path.dirname(out))) throw new CliError("file_not_found", `The folder of --out does not exist (${path.dirname(out)})`, {field: "out"});
  if (elf && !fs.existsSync(elf)) throw new CliError("file_not_found", `--elf ${o.elf} does not exist (looked at ${elf})`, {field: "elf", hint: "The firmware's ELF: build/<project>.elf of the build that is on the device"});
  return session(ctx, async board => {
    const info = await board.json(OP.COREDUMP_INFO);
    const result = {...info};
    const lines = [coredumpText(info)];
    if (out) {
      if (!info.present) { result.saved = null; lines.push("Nothing saved: there is no core dump."); }
      else {
        const shown = meter(ctx, "core dump");
        const dump = await board.ask(OP.COREDUMP_READ, EMPTY, {timeout: board.timeout, onProgress: got => shown.update(got, info.bytes)});
        shown.end();
        fs.writeFileSync(out, dump);
        result.saved = out;
        lines.push(`Saved to ${out} (${size(dump.length)}).`);
      }
    }
    const trace = info.summary?.backtrace ?? [];
    if (elf) {
      if (!trace.length) { result.decoded = null; lines.push("No backtrace to decode."); }
      else {
        const decoded = decodeBacktrace(elf, trace);
        result.decoded = decoded.lines ?? null;
        if (decoded.lines) lines.push(`Backtrace (${ADDR2LINE}):`, ...decoded.lines.map(l => `  ${l}`));
        else lines.push(decoded.missing ? `No ${ADDR2LINE} on PATH: export ESP-IDF first (. $IDF_PATH/export.sh), then: ${ADDR2LINE} -pfiaC -e ${elf} ${trace.join(" ")}`
          : `${ADDR2LINE} failed: ${decoded.error}`);
      }
    } else if (trace.length) lines.push(`Decode it: ${ADDR2LINE} -pfiaC -e build/<project>.elf ${trace.join(" ")} (or --elf FILE)`);
    if (info.present) lines.push(`The whole dump: esp-coredump info_corefile -c ${out ?? "<dump file from --out>"} ${elf ?? "build/<project>.elf"} (ESP-IDF)`);
    if (o.erase) {
      await board.json(OP.COREDUMP_ERASE, EMPTY, {timeout: board.timeout + 15000, retries: 0});
      result.erased = true;
      lines.push("Erased.");
    }
    return {json: result, text: lines.join("\n")};
  });
}
export function coredumpText(c) {
  if (!c.partition) return "No core dump partition in this board's partition table.";
  const lines = [];
  lines.push(c.present ? `A core dump of ${size(c.bytes)} in partition ${c.partition} (${size(c.size)})` : `No core dump in partition ${c.partition} (${size(c.size)})`);
  if (c.enabled === false) lines.push("This firmware does not write one when it crashes: CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH is off (the board's defaults set it).");
  const s = c.summary;
  if (s) lines.push(`  task ${s.task ?? "?"}, PC ${s.pc ?? "?"}${s.corrupted ? " (the backtrace is corrupted)" : ""}`, `  backtrace ${(s.backtrace ?? []).join(" ") || "none"}`);
  else if (c.present) lines.push("  No summary: not an ELF dump this firmware reads (esp-coredump reads it)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// files

const utf8 = text => enc.encode(text);

export async function filesLs(ctx) {
  const where = cardPath(ctx.args.PATH ?? "", usageOf(ctx));
  return session(ctx, async board => {
    const list = await board.json(OP.LS, utf8(where));
    return {json: list, text: lsText(list, where)};
  });
}
function when(modified) {
  if (modified === null || modified === undefined || modified === "") return "";
  if (typeof modified === "number") {
    const date = new Date(modified > 1e11 ? modified : modified * 1000);
    return Number.isNaN(date.getTime()) ? String(modified) : date.toISOString().slice(0, 16).replace("T", " ");
  }
  return String(modified);
}
export function lsText(list, where = "") {
  const entries = [...(list.entries ?? [])].sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  const shown = "/" + (list.path ?? where);
  if (!entries.length) return `${shown}: empty`;
  const files = entries.filter(e => !e.dir).length;
  return [`${shown}: ${entries.length - files} folder${entries.length - files === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`,
    table(entries.map(e => [`  ${e.name}${e.dir ? "/" : ""}`, e.dir ? "" : size(e.bytes), when(e.modified)]), [1])].join("\n");
}

/** GET: the file into `write(chunk)`; part of an answer lost (a gap, an end that never came) is asked for again from where it stopped. {size, got}. */
export async function getFile(board, remote, write, progress = () => {}) {
  let total = null, got = 0;
  for (let attempt = 0; ; attempt++) {
    const head = [];
    try {
      await board.request(OP.GET, concat(u32(got), utf8(remote)), {onPayload: chunk => {
        let at = 0;
        if (head.length < 4) {
          at = Math.min(4 - head.length, chunk.length);
          head.push(...chunk.subarray(0, at));
          if (head.length === 4) {
            const said = readU32(head);
            if (total === null) total = said;
            else if (said !== total) throw new BoardError("changed", `the file changed while it was read (${total} bytes, then ${said})`);
          }
        }
        if (at < chunk.length) {
          const data = chunk.subarray(at);
          if (total !== null && got + data.length > total) throw new BoardError("bad_answer", `more bytes than the file's ${total}`);
          write(data);
          got += data.length;
          progress(got, total);
        }
      }});
      if (total === null) throw new BoardError("bad_answer", "the answer has no size");
      if (got !== total) throw new BoardError("bad_answer", `${got} of the file's ${total} bytes came`);
      return {size: total, got};
    } catch (error) {
      if (!lostPart(error) || attempt >= 5) throw error;
      await board.cancel();
    }
  }
}

export async function filesGet(ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const remote = cardPath(ctx.args.PATH, usageOf(ctx), {root: false});
  const name = remote.split("/").pop();
  let local = path.resolve(cwd, String(ctx.args.LOCAL ?? name));
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()) local = path.join(local, name);
  if (!fs.existsSync(path.dirname(local))) throw new CliError("file_not_found", `The folder ${path.dirname(local)} does not exist`, {field: "LOCAL", hint: "Paths are relative to the current folder"});
  return session(ctx, async board => {
    const part = `${local}.part-${process.pid}`;
    let fd = fs.openSync(part, "w");
    const shown = meter(ctx, `get ${remote}`);
    try {
      const {size: bytes} = await getFile(board, remote, chunk => fs.writeSync(fd, chunk), (got, total) => shown.update(got, total));
      shown.end();
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(part, local);
      const seconds = shown.seconds();
      return {json: {path: remote, local, bytes, seconds: Math.round(seconds * 10) / 10}, text: `${remote} → ${local} (${size(bytes)} in ${seconds.toFixed(1)} s, ${rateOf(bytes, seconds)})`};
    } catch (error) {
      shown.end();
      if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
      try { fs.unlinkSync(part); } catch { /* none */ }
      throw error;
    }
  });
}

// PUT_DATA chunks in flight at once: the firmware's queue holds 8.
export const PUT_WINDOW = 4;
/** PUT_BEGIN, the bytes as pipelined PUT_DATA (48 a chunk, PUT_WINDOW at once, each acknowledged), PUT_END; aborted on failure. */
export async function putFile(board, remote, data, progress = () => {}) {
  await board.json(OP.PUT_BEGIN, concat(u32(data.length), utf8(remote)), {retries: 0});
  try {
    const inFlight = [];
    let offset = 0;
    while (offset < data.length || inFlight.length) {
      while (offset < data.length && inFlight.length < PUT_WINDOW) {
        const chunk = data.subarray(offset, offset + LIMITS.putChunk);
        const end = offset + chunk.length;
        const {done} = await board.start(OP.PUT_DATA, concat(u32(offset), chunk));
        done.catch(() => {});   // awaited in turn below
        inFlight.push({end, done});
        offset = end;
      }
      const {end, done} = inFlight.shift();
      const ack = await done;
      if (ack.length < 4) throw new BoardError("bad_answer", "PUT_DATA's answer has no count");
      const written = readU32(ack);
      if (written !== end) throw new BoardError("bad_answer", `the card has ${written} bytes where ${end} were sent`);
      progress(end, data.length);
    }
    return await board.json(OP.PUT_END, EMPTY, {timeout: board.timeout + 10000, retries: 0});
  } catch (error) {
    // The firmware stops (CANCEL drops the chunks queued), then the file is given up (PUT_ABORT).
    const interrupted = board.interrupted;
    board.interrupted = false;
    try {
      await board.cancel({ms: 300});
      await board.json(OP.PUT_ABORT, EMPTY, {timeout: 3000, retries: 0});
    } catch { /* gone */ }
    board.interrupted = interrupted;
    throw error;
  }
}

export async function filesPut(ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const local = path.resolve(cwd, String(ctx.args.LOCAL));
  if (!fs.existsSync(local)) throw new CliError("file_not_found", `${ctx.args.LOCAL} does not exist (looked at ${local})`, {field: "LOCAL", hint: "Paths are relative to the current folder"});
  if (!fs.statSync(local).isFile()) throw new CliError("file_not_found", `${ctx.args.LOCAL} is not a file`, {field: "LOCAL", hint: "Send one file at a time"});
  const name = path.basename(local);
  let wanted = ctx.args.PATH === undefined ? name : String(ctx.args.PATH);
  if (wanted === "" || wanted.endsWith("/")) wanted += name;
  let remote = cardPath(wanted, usageOf(ctx), {root: false});
  const data = new Uint8Array(fs.readFileSync(local));
  if (data.length > 0xffffffff) throw new CliError("too_large", `${ctx.args.LOCAL} is larger than 4 GB`, {field: "LOCAL"});
  return session(ctx, async board => {
    // PATH a folder on the card (without its "/"): the file goes into it, as cp does.
    if (ctx.args.PATH !== undefined && !String(ctx.args.PATH).endsWith("/")) {
      const folder = await board.json(OP.LS, utf8(remote), {retries: 0}).then(() => true, error => {
        if (error instanceof BoardError && error.code === "device") return false;
        throw error;
      });
      if (folder) remote = cardPath(`${remote}/${name}`, usageOf(ctx), {root: false});
    }
    const shown = meter(ctx, `put ${remote}`);
    try {
      const ended = await putFile(board, remote, data, (sent, total) => shown.update(sent, total));
      shown.end();
      const seconds = shown.seconds();
      return {json: {...ended, local, seconds: Math.round(seconds * 10) / 10},
        text: `${local} → ${ended.path ?? remote} (${size(ended.bytes ?? data.length)} in ${seconds.toFixed(1)} s, ${rateOf(data.length, seconds)})`};
    } finally { shown.end(); }
  });
}

export async function filesRm(ctx) {
  const remote = cardPath(ctx.args.PATH, usageOf(ctx), {root: false});
  return session(ctx, async board => {
    const said = await board.json(OP.RM, utf8(remote), {retries: 0});
    return {json: said, text: `Removed ${said.removed ?? remote}.`};
  });
}
export async function filesMkdir(ctx) {
  const remote = cardPath(ctx.args.PATH, usageOf(ctx), {root: false});
  return session(ctx, async board => {
    const said = await board.json(OP.MKDIR, utf8(remote), {retries: 0});
    return {json: said, text: `Made ${said.made ?? remote}/.`};
  });
}
export async function filesMv(ctx) {
  const usage = usageOf(ctx);
  const from = cardPath(ctx.args.FROM, usage, {root: false, field: "FROM"});
  const to = cardPath(ctx.args.TO, usage, {root: false, field: "TO"});
  return session(ctx, async board => {
    const said = await board.json(OP.MV, concat(utf8(from), Uint8Array.of(0), utf8(to)), {retries: 0});
    return {json: said, text: `Moved ${said.moved ?? from} to ${said.to ?? to}.`};
  });
}

// ---------------------------------------------------------------------------------------------
// settings: the board's settings (CardenzaHAL docs/SETTINGS.md): the volume and its limit, the screen's and the key lights'
// brightness, the language, the browser notice, screenshot uploads … They are the HAL's, the same in every firmware on it and
// in its system menu (HOME > Settings), kept in the board's flash. SETTINGS, SETTING_GET (the key), SETTING_SET (an i32, then
// the key) and SETTINGS_RESET are answered by every firmware that starts USB on a HAL from 2026-11-23 on (protocol 3), also one
// built without the development channel. 203cli checks a value against the board's range or choices before it sends it; the
// device keeps a value in its range all the same (clamped: the limit changed in between) and writes a change to its flash
// itself, a second after the last one.

// The keys are the board's: SETTINGS lists every setting it has, in its order, with its range (min, max, unit) or its
// choices (value and name), and get / set take any key in that list, checked against what the board says of it. Nothing
// here is a list of the keys a board must have; what follows only helps people type and read them.

// Keys a HAL had and no longer has, and why a current one does not list them. mic_gain was a board setting for a few hours of
// 2026-11-23 (CardenzaHAL 8746b6f made the microphone's gain the firmware's own); a board that still reports it is answered
// like any other key, since the list is the device's.
const FORMER_SETTINGS = Object.freeze({mic_gain: "since 8746b6f, 2026-11-23, the microphone's gain is a firmware's own setting, not the board's"});
// Other words taken for a key the board has (never shown): the flash's names and short ones.
const SETTING_ALIASES = Object.freeze({lang: "language", limit: "volume_limit", volume_max: "volume_limit", max_volume: "volume_limit",
  brightness: "screen_brightness", backlight: "screen_brightness", key_light: "key_brightness", key_lights: "key_brightness", mic: "mic_gain",
  auto_upload: "screenshot_upload", screenshots_upload: "screenshot_upload", upload: "screenshot_upload", shot_upload: "screenshot_upload",
  webusb: "webusb_landing", landing: "webusb_landing", usb_landing: "webusb_landing", browser_notice: "webusb_landing", notice: "webusb_landing",
  seen: "webusb_seen", usb_seen: "webusb_seen"});
// A unit a VALUE may carry besides the board's own (80% for the volumes, which the board gives no unit).
const SETTING_UNITS = Object.freeze({volume: "%", volume_limit: "%"});
// Names for the values of settings the board describes by a range alone (CardenzaHAL docs/SETTINGS.md), used only while every
// named value is in the board's range. A board that gives choices of its own is read by those instead.
const SETTING_NAMES = Object.freeze({
  // Whether the USB device names the community's page to web browsers (the WebUSB landing page; the system menu's Browser notice).
  webusb_landing: [{value: 0, name: "first", words: ["first-time", "first_time", "once", "default", "首次", "第一次"]},
    {value: 1, name: "always", words: ["总是", "每次"]}, {value: 2, name: "never", words: ["从不", "不"]}],
  // Whether the board has been seen by a 203 tool or the website (0: the first-time notice comes again).
  webusb_seen: [{value: 0, name: "no", words: ["false", "off", "否"]}, {value: 1, name: "yes", words: ["true", "on", "是"]}],
  screenshot_upload: [{value: 0, name: "off", words: ["no", "false", "关"]}, {value: 1, name: "on", words: ["yes", "true", "开"]}],
});
// Any other setting the board describes as 0-1 with no unit is a switch: these words.
const SWITCH_NAMES = Object.freeze([{value: 0, name: "off", words: ["no", "false", "关"]}, {value: 1, name: "on", words: ["yes", "true", "开"]}]);
/** The 203 Launcher's languages: its code, the tag the device names it by, its own name, and the words taken for it. */
export const LANGUAGES = Object.freeze([
  {code: 0, tag: "en", name: "English", words: ["english", "en-us", "en-gb", "英文", "英语"]},
  {code: 1, tag: "zh-Hans", name: "简体中文", words: ["zh", "zh-cn", "zh-sg", "chinese", "simplified chinese", "中文", "简体", "简体中文"]},
  {code: 3, tag: "ja", name: "日本語", words: ["jp", "ja-jp", "japanese", "日本語", "日语", "日文"]},
  {code: 4, tag: "id", name: "Bahasa Indonesia", words: ["in", "id-id", "indonesian", "bahasa", "bahasa indonesia", "印尼语"]},
  {code: 5, tag: "vi", name: "Tiếng Việt", words: ["vi-vn", "vietnamese", "tiếng việt", "tieng viet", "越南语"]},
]);
/** A language's own name from its tag (the device's choices name them by tag); an unknown tag as it is. */
export const languageName = tag => LANGUAGES.find(l => l.tag.toLowerCase() === String(tag).toLowerCase())?.name ?? String(tag);

const typedKey = text => String(text ?? "").trim().toLowerCase().replace(/-/g, "_");
/** KEY's shape, checked before any device is looked for: letters, digits and _ (any case, - for _). */
export function settingKeyShape(text, usage) {
  const typed = typedKey(text);
  if (/^[a-z][a-z0-9_]{0,47}$/.test(typed)) return typed;
  throw usage(`"${text}" cannot be a setting's key: a key is letters, digits and _ (e.g. volume, language, webusb_landing)`, {field: "KEY",
    hint: "203cli board settings lists the board's keys"});
}

/**
 * The board's entry for what was typed: its own key, else a word taken for one of its keys (SETTING_ALIASES). A key the board
 * does not list is a usage error that lists the board's keys (a guess in next), and says why for a former key.
 */
export function settingEntry(text, entries, usage, {fix = null} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const typed = typedKey(text);
  const found = list.find(s => s.key === typed) ?? list.find(s => s.key === SETTING_ALIASES[typed]);
  if (found) return found;
  const keys = list.map(s => s.key);
  const gone = FORMER_SETTINGS[typed] ?? FORMER_SETTINGS[SETTING_ALIASES[typed]];
  const aliasGuess = SETTING_ALIASES[nearest(typed, Object.keys(SETTING_ALIASES))];
  const guess = gone ? null : nearest(typed, keys) ?? (keys.includes(aliasGuess) ? aliasGuess : null);
  throw usage(`"${text}" is not one of this board's settings: ${keys.join(", ") || "it lists none"}`, {field: "KEY", data: {keys},
    hint: gone ? `This firmware's CardenzaHAL does not have it (${gone})` : `${guess ? `Did you mean ${guess}? ` : ""}203cli board settings lists them, with their ranges`,
    ...(guess && fix ? {next: [fix(guess)]} : {})});
}

/** The names a setting's values go by: the board's choices, else the names of a setting the board describes by a range. */
export function settingNames(entry) {
  if (Array.isArray(entry?.choices)) return entry.choices.map(c => ({value: c.value, name: String(c.name), words: []}));
  const inRange = names => names && names.every(n => Number.isFinite(entry.min) && Number.isFinite(entry.max) && n.value >= entry.min && n.value <= entry.max);
  if (inRange(SETTING_NAMES[entry?.key])) return SETTING_NAMES[entry.key];
  if (entry?.min === 0 && entry?.max === 1 && !entry.unit && !SETTING_NAMES[entry.key]) return SWITCH_NAMES;
  return null;
}

const listOf = names => names.map(n => `${n.name} (${n.value})`).join(", ");
/**
 * VALUE for the board's entry, checked against what the board says of it: one of its choices (by name, by value, the language
 * also by its own name or common tags: en, zh, 日本語 …), a named value (webusb_landing first / always / never, on / off for a
 * switch, or its number), or a whole number in its range (80; 80% or 6dB in its unit). Anything else is a usage error that
 * says what the board takes, with the nearest value in next when a number was out of range.
 */
export function settingValue(entry, text, usage, {fix = null} = {}) {
  const typed = String(text ?? "").trim();
  const key = entry.key;
  const names = settingNames(entry);
  const choices = Array.isArray(entry.choices);
  const number = /^[+-]?\d{1,10}$/.test(typed) ? Number(typed) : null;
  if (names) {
    const word = typed.toLowerCase().replace(/_/g, "-");
    let found = names.find(n => n.name.toLowerCase().replace(/_/g, "-") === word || (n.words ?? []).includes(word));
    if (!found && choices && key === "language") {
      const language = LANGUAGES.find(l => l.tag.toLowerCase() === word || l.words.includes(word) || l.name.toLowerCase() === word);
      if (language) found = names.find(n => n.name.toLowerCase() === language.tag.toLowerCase());
    }
    if (!found && number !== null) found = names.find(n => n.value === number);
    if (found) return found.value;
    const whole = !choices && names.length === entry.max - entry.min + 1;   // every value in the range has a name
    if (choices || whole || number === null) {
      const shown = choices && key === "language" ? entry.choices.map(c => `${c.name} (${languageName(c.name)}, ${c.value})`).join(", ") : listOf(names);
      throw usage(`${key} is one of ${shown}, not "${typed}"`, {field: "VALUE", data: {choices: names.map(n => ({value: n.value, name: n.name}))},
        hint: `e.g. 203cli board settings set ${key} ${names[Math.min(1, names.length - 1)].name}${key === "language" ? " (a language also by its own name: English, 日本語 …)" : ""}`});
    }
  }
  const m = /^([+-]?\d{1,10})\s*(%|db)?$/i.exec(typed);
  const n = m ? Number(m[1]) : NaN;
  const unit = m?.[2]?.toLowerCase();
  const units = [String(entry.unit ?? "").toLowerCase(), SETTING_UNITS[key]].filter(Boolean);
  if (!m || (unit && !units.includes(unit))) {
    throw usage(`${key} is a whole number${entry.unit ? ` (in ${entry.unit})` : ""}, not "${typed}"`, {field: "VALUE",
      hint: `${key} on this board: ${settingRange(entry)}; e.g. 203cli board settings set ${key} ${exampleValue(entry)}`});
  }
  if (Number.isFinite(entry.min) && Number.isFinite(entry.max) && (n < entry.min || n > entry.max)) {
    const near = Math.min(entry.max, Math.max(entry.min, n));
    const limit = key === "volume" ? `; the most is volume_limit (${entry.max}): raise it first to go higher` : "";
    throw usage(`${key} is ${settingRange(entry).replace(/ \(at most volume_limit\)$/, "")} on this board, not ${settingShown(entry, n)}`, {field: "VALUE",
      data: {min: entry.min, max: entry.max, nearest: near}, hint: `The nearest it takes is ${settingShown(entry, near)}${limit}`, ...(fix ? {next: [fix(near)]} : {})});
  }
  return n;
}
/** A value to show in an example: a choice's or named value's name, else the middle of the range. */
function exampleValue(entry) {
  const names = settingNames(entry);
  if (names?.length) return names[Math.min(1, names.length - 1)].name;
  if (Number.isFinite(entry.min) && Number.isFinite(entry.max)) return String(Math.round((entry.min + entry.max) / 2));
  return "1";
}

const signed = n => (n > 0 ? `+${n}` : String(n));
/** A setting's value as people read it: 64, 80 %, +6 dB, 简体中文 (zh-Hans), on, first. */
export function settingShown(entry, value = entry.value) {
  if (Array.isArray(entry.choices)) {
    const choice = entry.choices.find(c => c.value === value);
    if (!choice) return String(value);
    const name = languageName(choice.name);
    return name === String(choice.name) ? name : `${name} (${choice.name})`;
  }
  const named = settingNames(entry)?.find(n => n.value === value);
  if (named) return named.name;
  const unit = entry.unit ?? "";
  if (!Number.isFinite(value)) return "?";
  if (/^db$/i.test(unit)) return `${signed(value)} ${unit}`;
  return unit ? `${value} ${unit}` : String(value);
}
/** Its range (the volume's top is the limit), or its choices' or named values' names. */
export function settingRange(entry) {
  if (Array.isArray(entry.choices)) return entry.choices.map(c => c.name).join(" ");
  const names = settingNames(entry);
  if (names && names.length === entry.max - entry.min + 1) return names.map(n => n.name).join(" ");
  const unit = entry.unit ? ` ${entry.unit}` : "";
  const span = entry.min < 0 ? `${signed(entry.min)} to ${signed(entry.max)}${unit}` : `${entry.min}-${entry.max}${unit}`;
  return entry.key === "volume" ? `${span} (at most volume_limit)` : span;
}
const NOT_SAVED = "Not in the board's flash yet: the device writes it there a second after the last change (keep it on until then).";
const ABOUT = "The board's settings: the same in every firmware on CardenzaHAL, and in its HOME menu (Settings).";

export function settingsText(said) {
  const entries = said.settings ?? [];
  const rows = [["setting", "value", "range", "default", "stored"],
    ...entries.map(s => [s.key, settingShown(s), settingRange(s), settingShown(s, s.default), s.stored ? "yes" : "no"])];
  const lines = [table(rows), "", `${ABOUT} stored no: the default, not set on this board.`];
  if (said.saved === false) lines.push(NOT_SAVED);
  lines.push("Change one: 203cli board settings set KEY VALUE (e.g. volume 50, language zh); all but the language back to their defaults: 203cli board settings reset");
  return lines.join("\n");
}
export function settingText(said) {
  const s = said.setting ?? {};
  const lines = [`${s.key}  ${settingShown(s)}`];
  const row = (label, value) => lines.push(`  ${label.padEnd(8)} ${value}`);
  if (Array.isArray(s.choices)) row("choices", s.choices.map(c => `${settingShown(s, c.value).replace(/\)$/, `, ${c.value})`)}`).join(", "));
  else row("range", `${settingRange(s)}${Number.isFinite(s.step) && s.step > 1 ? `; the HOME menu steps by ${s.step}` : ""}`);
  row("default", settingShown(s, s.default));
  row("stored", s.stored ? "yes (in the board's flash, or set since it started)" : "no (the default: not set on this board)");
  if (said.saved === false) lines.push(NOT_SAVED);
  return lines.join("\n");
}
/** [{key, from, to}] for every key whose value differs between two lists of settings. */
function settingChanges(before, after, only = null) {
  const was = new Map((before ?? []).map(s => [s.key, s]));
  return (after ?? []).filter(s => (!only || only.includes(s.key)) && was.has(s.key) && was.get(s.key).value !== s.value)
    .map(s => ({key: s.key, from: was.get(s.key).value, to: s.value}));
}
const changeText = (entries, c) => {
  const entry = entries.find(s => s.key === c.key) ?? {};
  return `${c.key} ${settingShown(entry, c.from)} → ${settingShown(entry, c.to)}`;
};

export async function boardSettings(ctx) {
  return session(ctx, async board => {
    const said = await board.json(OP.SETTINGS);
    return {json: said, text: settingsText(said)};
  }, {need: "settings"});
}

// get and set: KEY is one the board lists (SETTINGS first: any key it has, a future one too), VALUE what it says of that key.
export async function boardSettingsGet(ctx) {
  const usage = usageOf(ctx);
  settingKeyShape(ctx.args.KEY, usage);
  return session(ctx, async board => {
    const all = await board.json(OP.SETTINGS);
    const {key} = settingEntry(ctx.args.KEY, all.settings, usage, {fix: guess => ctx.cmd?.({args: {KEY: guess}})});
    const said = await board.json(OP.SETTING_GET, utf8(key));
    return {json: said, text: settingText(said)};
  }, {need: "settings"});
}

export async function boardSettingsSet(ctx) {
  const usage = usageOf(ctx);
  settingKeyShape(ctx.args.KEY, usage);
  if (!String(ctx.args.VALUE ?? "").trim()) throw usage("VALUE is empty", {field: "VALUE", hint: "203cli board settings get KEY shows what it takes"});
  return session(ctx, async board => {
    const before = await board.json(OP.SETTINGS);
    const entry0 = settingEntry(ctx.args.KEY, before.settings, usage, {fix: guess => ctx.cmd?.({args: {KEY: guess}})});
    const key = entry0.key;
    const value = settingValue(entry0, ctx.args.VALUE, usage, {fix: near => ctx.cmd?.({args: {KEY: key, VALUE: String(near)}})});
    const said = await board.json(OP.SETTING_SET, concat(i32(value), utf8(key)), {retries: 0});
    const changed = Array.isArray(said.changed) ? said.changed : [];
    // What else moved with it (lowering the limit lowers the volume): its new value, read again.
    const after = changed.some(k => k !== key) ? (await board.json(OP.SETTINGS)).settings
      : (before.settings ?? []).map(s => (s.key === key ? {...s, ...said.setting} : s));
    const changes = settingChanges(before.settings, after, changed);
    const entry = said.setting ?? {};
    const clamped = Number.isFinite(said.asked) && said.asked !== entry.value;
    const entries = after ?? [];
    const own = changes.find(c => c.key === key);
    const lines = [own ? `${changeText(entries, own)}.` : `${key} is ${settingShown(entry)} already: nothing changed.`];
    if (clamped) {
      if (Array.isArray(entry.choices)) {
        // Checked against the choices before it was sent; a board that answers otherwise all the same is said as it is.
        lines.push(own ? `The device took ${said.asked} as ${settingShown(entry)}.`
          : `The board kept ${settingShown(entry)} (it has ${entry.choices.map(c => `${c.value} ${c.name}`).join(", ")}).`);
      } else {
        const limit = key === "volume" ? ` (the most is volume_limit, ${entry.max})` : "";
        lines.push(`The device kept it in its range ${settingRange(entry).replace(/ \(at most volume_limit\)$/, "")}${limit}: asked ${settingShown(entry, said.asked)}, set ${settingShown(entry)}.`);
      }
    }
    const others = changes.filter(c => c.key !== key);
    if (others.length) lines.push(`Also changed: ${others.map(c => changeText(entries, c) + (c.key === "volume" && key === "volume_limit" ? " (the volume stays under its limit)" : "")).join(", ")}.`);
    if (said.saved === false) lines.push(NOT_SAVED);
    return {json: {...said, changes, clamped}, text: lines.join("\n")};
  }, {need: "settings"});
}

export async function boardSettingsReset(ctx) {
  return session(ctx, async board => {
    const before = await board.json(OP.SETTINGS);
    const entries = before.settings ?? [];
    const due = entries.filter(s => s.key !== "language" && s.value !== s.default).map(s => ({key: s.key, from: s.value, to: s.default}));
    const language = entries.find(s => s.key === "language");
    const stays = language ? ` (the language stays ${settingShown(language)})` : "";
    if (!due.length) {
      return {json: {reset: false, changes: [], settings: entries, saved: before.saved},
        text: `Every setting but the language${language ? ` (${settingShown(language)})` : ""} is at its default already: nothing to reset.`};
    }
    const list = due.map(c => changeText(entries, c)).join(", ");
    // What the user chose goes (the volume limit among it): a yes on a terminal, --yes from a program.
    if (!ctx.flags?.yes && !(ctx.interactive && ctx.confirm && await ctx.confirm(`Put the board's settings back to their defaults: ${list}${stays}?`))) {
      throw new CliError("needs_confirmation", `board settings reset puts back what was chosen on this board: ${list}${stays}`, {exit: EXIT.confirm,
        hint: "Add --yes only if the user asked for it; one setting alone: 203cli board settings set KEY VALUE", next: ctx.cmd ? [ctx.cmd({add: {yes: true}})] : [],
        data: {changes: due}});
    }
    const said = await board.json(OP.SETTINGS_RESET, EMPTY, {retries: 0});
    const changes = settingChanges(entries, said.settings);
    const after = said.settings ?? entries;
    const lines = [changes.length ? `Back to their defaults${stays}:` : `Nothing changed${stays}.`,
      table(changes.map(c => {
        const entry = after.find(s => s.key === c.key) ?? {};
        return [`  ${c.key}`, settingShown(entry, c.from), "→", settingShown(entry, c.to)];
      }))].filter(Boolean);
    if (said.saved === false) lines.push(NOT_SAVED);
    return {json: {...said, changes}, text: lines.join("\n")};
  }, {need: "settings"});
}
