// 203cli board: a running firmware on CardenzaHAL, seen and driven from a computer over its USB cable (the HAL's development
// channel, CardenzaHAL docs/usb-dev.md; the bytes: board-usb.mjs). What it is (info), its flash (partitions), memory and
// tasks, the SD card, the I2C bus, its screen as a PNG, keys pressed as if by a finger, its last crash (core dump), and
// files on its SD card. No sign-in, like flash and log. Nothing here writes the device's flash: only files on the card
// and, when asked, erasing the core dump.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {spawnSync} from "node:child_process";
import {BoardError, OP, LIMITS, openBoard, concat, u32, readU32, lostPart} from "./board-usb.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {colorFlag, framePicture, framedPng} from "./pictures.mjs";

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
/** A PNG of 8-bit RGB pixels (IHDR, one IDAT of the rows deflated, each with filter 0, IEND). */
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = concat(be32(width), be32(height), Uint8Array.of(8, 2, 0, 0, 0));
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
/** Rows as aligned columns; `right`: the columns aligned right. */
export function table(rows, right = []) {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, String(cell ?? "").length); });
  return rows.map(row => row.map((cell, i) => {
    const text = String(cell ?? "");
    return right.includes(i) ? text.padStart(widths[i]) : i === row.length - 1 ? text : text.padEnd(widths[i]);
  }).join("  ").trimEnd()).join("\n");
}

// ---------------------------------------------------------------------------------------------
// A command's time with the board: the channel opened, Ctrl-C answered (CANCEL, so the firmware stops sending; the command's
// own clean-up runs: an upload aborted, a part file removed), errors said in 203cli's terms, the channel closed.

/** The firmware's refusal (its reason) or the channel's trouble as a CliError. */
export function boardCliError(error, ctx) {
  if (!(error instanceof BoardError)) return error;
  const again = ctx.cmd ? [ctx.cmd()] : [];
  const reason = error.reason ?? error.message;
  switch (error.code) {
    case "device":
      if (reason === "busy") return new CliError("board_busy", "The firmware's development channel is busy (its queue of 8 requests is full)", {exit: EXIT.later, next: again,
        hint: "Another program may be asking it too: wait a moment and run it again"});
      if (reason === "off") return new CliError("dev_channel_off", "This firmware was built without the development channel (CONFIG_CARDENZA_HAL_USB_DEV is off)", {exit: EXIT.refused,
        hint: "Turn it on (CONFIG_CARDENZA_HAL_USB_DEV=y), build and install it again"});
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
  if (/not found|no such|enoent/i.test(reason)) return "Check the path: 203cli board files ls lists the card";
  if (/card|mount/i.test(reason)) return "Is there an SD card? 203cli board storage says whether one is mounted";
  if (/exist/i.test(reason)) return "Something has that name already: remove it first (203cli board files rm), or choose another";
  if (/coredump|core dump/i.test(reason)) return "203cli board partitions shows whether the table has a coredump partition";
  return "Read the reason; 203cli board status and 203cli board storage say more about the device";
}

/** Opens the channel, runs `work(board)`, closes it. ctx.boardLinks: the ways to the device (the tests' stand-in). */
export async function session(ctx, work) {
  const board = await openBoard({links: ctx.boardLinks ?? null});
  let stopped = false;
  const onSignal = () => {
    if (stopped) process.exit(130);
    stopped = true;
    board.interrupted = true;
    process.stderr.write("\n203c: stopping (the device is told to stop sending)…\n");
    board.cancel({ms: 300}).catch(() => {});
    setTimeout(() => process.exit(130), 3000).unref();
  };
  process.on("SIGINT", onSignal);
  try {
    return await work(board);
  } catch (error) {
    if (board.interrupted) { await board.close(); process.exit(130); }
    throw boardCliError(error, ctx);
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

const via = board => `${board.via === "rawmidi" || board.via === "coremidi" ? "MIDI" : "HID"} (${board.where})`;

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
  // --frame: the community's standard picture (pictures.mjs: 1280 x 720, the colour, the bezel, the screen at 4 times).
  const frame = !!ctx.flags?.frame;
  if (ctx.flags?.color !== undefined && !frame) throw new CliError("usage", "--color is the standard picture's background: give --frame with it", {exit: EXIT.usage, field: "color"});
  const color = frame ? colorFlag(ctx) : null;
  return session(ctx, async board => {
    const bytes = await board.ask(OP.SCREEN, EMPTY, {timeout: board.timeout});
    const screen = decodeScreen(bytes);
    const rgb = rgbOf(screen.pixels);
    let framed = null;
    if (frame) {
      try { framed = framePicture({width: screen.width, height: screen.height, rgb}, color); } catch (error) {
        throw new CliError("invalid", `The screen is ${screen.width} × ${screen.height}: the standard picture frames the Cardenza's 240 × 135 (or a whole multiple); leave --frame out`, {field: "frame"});
      }
    }
    fs.writeFileSync(file, framed ? framedPng(framed) : encodePng(screen.width, screen.height, rgb));
    const source = screen.source === 0 ? "new" : "last";
    if (!ctx.json) ctx.say?.(`${screen.width} × ${screen.height}${framed ? ` in the standard picture (1280 × 720 on ${color.hex})` : ""}, ` +
      `${source === "new" ? "a frame the firmware presented after the request" : "the firmware's last frame (it presented none for 250 ms)"}`);
    return {json: {path: file, width: framed ? framed.width : screen.width, height: framed ? framed.height : screen.height,
      screen: {width: screen.width, height: screen.height}, framed: !!framed, ...(framed ? {color: color.hex} : {}),
      encoding: screen.encoding === 1 ? "rle" : "raw", source, bytes: bytes.length}, text: file};
  });
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
