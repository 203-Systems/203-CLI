// Every 203 device on a USB cable, whatever it runs (the user, 2026-11-24: "条条大路通往罗马……无论是哪一种协议都能够识别到。并且
// 确定不会重复识别就OK了。可以保证无论它是旧的HAL还是什么协议，都可以让它进入到烧录中。"): what each state is on USB, how a
// port is told apart, a CardenzaHAL firmware's serial port, the ROM's SYNC and the chip's MAC, the resets esptool does, the
// HAL's system channel (identify, its development channel's INFO) as bytes for SysEx, HID and serial lines, and one entry per
// physical device (its MAC) whatever channels see it. The website's site/usb-devices.js is this file (203-CLI is its
// source); 203cli uses it too. Plain ES module: no DOM, no Node, no import (the twins' names differ: .js and .mjs).
//
// The states (COMMUNITY.md "Every way to a device on the cable"; CardenzaHAL usb/usb.h, docs/usb-dev.md):
//   ROM download mode          303A:1001  Espressif, USB JTAG/serial debug unit, serial number = the MAC "70:AF:09:BC:EB:30";
//                                         esptool's SYNC (SLIP)
//   203 Launcher               303A:1001  the same USB device (the chip's USB-Serial-JTAG): its console, lines
//   Launcher, USB drive mode   0203:10CF  (Launchers after 0.3.3) MSC and a serial port with the same console;
//                              303A:4002  (0.3.3 and older) MSC only: no way to talk to it
//   CardenzaHAL firmware       0203:<its PID; 10C0 by default>, product "Cardenza" (protocol 4; older HALs: the firmware's own
//                                         name, "203 Systems Cardenza"), serial number the MAC ("70AF09BCEB30" before
//                                         protocol 4): whichever command channels it has: SysEx (MIDI), HID report 0xCB, a
//                                         serial port (protocol 4: lines, below). Protocol 3 and older: SysEx and HID only.
//   a firmware without USB     303A:1001  (the template before CardenzaHAL started USB by default, a firmware not on the HAL)
//                                         its own log on the chip's USB-Serial-JTAG, nothing answered: esptool's
//                                         USB-Serial-JTAG reset, into the Launcher (a plain reset) or the ROM
// Never assume a 303A:1001 port is the Launcher: probePort asks it.
//
// A HAL firmware's serial port (protocol 4): lines; `version` → "Firmware <project> <version>" (the Launcher answers
// "Launcher <version>"); `info` → one JSON line (docs/usb-dev.md INFO: firmware, hal, launcher, chip.mac, …); `partitions`,
// `storage`, `status`, … → one JSON line; `launcher` / `download` / `reboot` → "OK <word>", then it restarts; `sys <hex>` →
// a system report in HID form, answered by `sys <hex>` lines (63 bytes each); "ERR <reason>". esptool's DTR/RTS reset (or
// 1200 baud) puts it in the ROM's download mode too.
//
// One device, one entry (Cable): channels that see the same chip are merged by its MAC (12 hex digits; "70:AF:…" and
// "70af…" are the same), and an action on a device runs once (act): a second asked meanwhile gets the first one's promise.

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------------------------
// What a port is

export const HAL_VID = 0x0203;
export const ESPRESSIF_VID = 0x303a;
/** The chip's USB-Serial-JTAG: the ROM's download mode, the Launcher's console, a firmware that does not start USB. */
export const USJ = Object.freeze({usbVendorId: ESPRESSIF_VID, usbProductId: 0x1001});
/** The Launcher's USB drive mode before it had a serial port (0.3.3 and older): mass storage only. */
export const DRIVE_OLD = Object.freeze({usbVendorId: ESPRESSIF_VID, usbProductId: 0x4002});
/** The Launcher's USB drive mode with its console (after 0.3.3). */
export const LAUNCHER_DRIVE = Object.freeze({usbVendorId: HAL_VID, usbProductId: 0x10cf});
/** One chooser for every 203 port: any of 203 Systems' (a HAL firmware's serial port, the Launcher's drive mode), the chip's
 *  USB-Serial-JTAG, the old drive mode. */
export const PORT_FILTERS = Object.freeze([{usbVendorId: HAL_VID}, {...USJ}, {...DRIVE_OLD}]);
/** The HAL's protocol with the serial port and INFO on every channel. */
export const SERIAL_PROTOCOL = 4;

/** A port's USB ids ({usbVendorId, usbProductId}), {} when it has none. */
export function portInfo(port) {
  try { return (port && typeof port.getInfo === 'function' ? port.getInfo() : port) || {}; } catch { return {}; }
}
/**
 * What a port (or its getInfo()) is by its ids alone: 'usj' (the chip's USB-Serial-JTAG: ROM, Launcher or a firmware without
 * USB: probePort tells which), 'drive' (the Launcher's USB drive mode with its console), 'hal' (a CardenzaHAL firmware's serial
 * port), 'drive-old' (mass storage only), or null.
 */
export function portKind(port) {
  const {usbVendorId: vid, usbProductId: pid} = portInfo(port);
  if (vid === USJ.usbVendorId && pid === USJ.usbProductId) return 'usj';
  if (vid === LAUNCHER_DRIVE.usbVendorId && pid === LAUNCHER_DRIVE.usbProductId) return 'drive';
  if (vid === HAL_VID) return 'hal';
  if (vid === DRIVE_OLD.usbVendorId && pid === DRIVE_OLD.usbProductId) return 'drive-old';
  return null;
}

/** A chip's MAC as the one key of a device: 12 lowercase hex digits from "70:AF:09:BC:EB:30", "70AF09BCEB30", "70-af-…" or six
 *  bytes; null when it is not one. */
export function macKey(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && value.length === 6) {
    return Array.from(value, (b) => (Number(b) & 0xff).toString(16).padStart(2, '0')).join('');
  }
  const hex = String(value).trim().toLowerCase().replace(/[:\-\s]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) && hex !== '000000000000' ? hex : null;
}
/** The MAC as people (and USB-Serial-JTAG's serial number) write it: "70:AF:09:BC:EB:30". */
export const macText = (value) => {
  const key = macKey(value);
  return key ? key.toUpperCase().match(/../g).join(':') : '';
};

// ---------------------------------------------------------------------------------------------
// Bytes from a port

/**
 * What a Web Serial port (or 203cli's stand-in for one) sends: its lines, and its raw bytes for SLIP. One reader on the port
 * until close(). `seen(line)`: every line as it comes (a log).
 */
export class PortReader {
  constructor(port, seen = () => {}) {
    this.reader = port.readable.getReader();
    this.raw = new Uint8Array(0);
    this.lines = [];
    this.part = '';
    this.closed = false;
    this.wake = null;
    (async () => {
      try {
        for (;;) {
          const {value, done} = await this.reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const next = new Uint8Array(Math.min(65536, this.raw.length + value.length));
          const keep = Math.max(0, next.length - value.length);
          next.set(this.raw.subarray(this.raw.length - keep), 0);
          next.set(value.subarray(Math.max(0, value.length - next.length)), keep);
          this.raw = next;
          this.part += dec.decode(value, {stream: true});
          let at;
          while ((at = this.part.indexOf('\n')) >= 0) {
            const line = this.part.slice(0, at).replace(/\r$/, '');
            this.part = this.part.slice(at + 1);
            this.lines.push(line);
            try { seen(line); } catch { /* the caller's */ }
          }
          if (this.part.length > 8192) this.part = '';
          this.poke();
        }
      } catch { /* closed or gone */ }
      this.closed = true;
      this.poke();
    })();
  }
  poke() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }
  /** Waits until `test()` is true (checked as bytes come), or `ms`: whether it became true. */
  async until(test, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (test()) return true;
      if (this.closed || Date.now() >= end) return false;
      await new Promise((resolve) => {
        this.wake = resolve;
        setTimeout(() => { if (this.wake === resolve) { this.wake = null; resolve(); } }, Math.min(100, Math.max(1, end - Date.now())));
      });
    }
  }
  /** The next line `re` matches (lines before it dropped), or null after `ms`. */
  async line(re, ms) {
    let found = null;
    await this.until(() => {
      while (this.lines.length) {
        const l = this.lines.shift();
        if (re.test(l)) { found = l; return true; }
      }
      return false;
    }, ms);
    return found;
  }
  /** Forgets what came so far (before a new question). */
  drop() { this.lines = []; this.raw = new Uint8Array(0); }
  async close() {
    try { await this.reader.cancel(); } catch { /* gone */ }
    try { this.reader.releaseLock(); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------------------------------------
// The ROM's download mode: SYNC, and the chip's MAC from its eFuses (esptool's ESP32-S3 read_mac)

/** esptool's SYNC as one SLIP frame (no byte in it needs escaping). */
export const SYNC_FRAME = Uint8Array.from([0xc0, 0x00, 0x08, 0x24, 0x00, 0, 0, 0, 0, 0x07, 0x07, 0x12, 0x20, ...new Array(32).fill(0x55), 0xc0]);
/** Bytes that hold the ROM's answer to SYNC: a SLIP frame C0 01 08 … */
export function answersSync(bytes) {
  for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0xc0 && bytes[i + 1] === 0x01 && bytes[i + 2] === 0x08) return true;
  return false;
}
export const ROM_READ_REG = 0x0a;
/** ESP32-S3: EFUSE_BASE 0x60007000, the MAC's two words at 0x044 and 0x048. */
export const S3_MAC_REGS = Object.freeze([0x60007044, 0x60007048]);

/** One ROM request as a SLIP frame: direction 0, the op, the length, a checksum of 0 (only writes use it), the data. */
export function romRequest(op, data = new Uint8Array(0)) {
  const body = new Uint8Array(8 + data.length);
  body.set([0x00, op & 0xff, data.length & 0xff, (data.length >> 8) & 0xff, 0, 0, 0, 0]);
  body.set(data, 8);
  const out = [0xc0];
  for (const b of body) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return Uint8Array.from(out);
}
/** The ROM's answers in `bytes`: [{op, value, data}] (SLIP frames of direction 1), in order. */
export function romAnswers(bytes) {
  const out = [];
  let frame = null;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xc0) {
      if (frame && frame.length >= 8 && frame[0] === 0x01) {
        const value = (frame[4] | (frame[5] << 8) | (frame[6] << 16) | (frame[7] << 24)) >>> 0;
        out.push({op: frame[1], value, data: Uint8Array.from(frame.slice(8))});
      }
      frame = [];
      continue;
    }
    if (frame === null) continue;
    if (b === 0xdb && i + 1 < bytes.length) {
      const n = bytes[++i];
      frame.push(n === 0xdc ? 0xc0 : n === 0xdd ? 0xdb : n);
    } else frame.push(b);
  }
  return out;
}
const le32 = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
/** The MAC from the two eFuse words, as esptool reads it (struct.pack(">II", mac1, mac0)[2:]): its key. */
export function s3Mac(word0, word1) {
  return macKey([(word1 >>> 8) & 0xff, word1 & 0xff, (word0 >>> 24) & 0xff, (word0 >>> 16) & 0xff, (word0 >>> 8) & 0xff, word0 & 0xff]);
}

// ---------------------------------------------------------------------------------------------
// Resets over the cable (esptool reset.py; Web Serial's setSignals: DTR = dataTerminalReady, RTS = requestToSend)

const signals = (port, dtr, rts) => port.setSignals({dataTerminalReady: dtr, requestToSend: rts});
/**
 * esptool's USBJTAGSerialReset on the chip's USB-Serial-JTAG: the chip restarts into the ROM's download mode, whatever it
 * ran (a firmware without USB, the Launcher). Each call as esptool makes it (through (1,1), never (0,0) while in reset).
 */
export async function romReset(port, {sleep = sleepFor} = {}) {
  await signals(port, false, false);
  await sleep(100);
  await signals(port, true, false);
  await sleep(100);
  await signals(port, true, true);
  await signals(port, false, true);
  await sleep(100);
  await signals(port, false, false);
}
/** esptool's HardReset on USB-Serial-JTAG: RTS (EN) pulsed, IO0 left high: the chip starts as from power-on (the Launcher's
 *  bootloader, which may count down to the firmware: hold it). */
export async function hardReset(port, {sleep = sleepFor} = {}) {
  await signals(port, false, true);
  await sleep(200);
  await signals(port, false, false);
  await sleep(200);
}
/** esptool's ClassicReset as a USB-to-serial bridge sees it (what a HAL firmware's serial port takes for the ROM's download
 *  mode, as esptool and Arduino send it). */
export async function classicReset(port, {sleep = sleepFor, delay = 50} = {}) {
  await signals(port, false, false);
  await signals(port, false, true);
  await sleep(100);
  await signals(port, true, true);
  await signals(port, true, false);
  await sleep(delay);
  await signals(port, false, false);
}

// ---------------------------------------------------------------------------------------------
// What is on a port: probePort

const LAUNCHER_LINE = /^Launcher (\S+)/;
const FIRMWARE_LINE = /^Firmware (\S+)(?:\s+(\S+))?/;

/** A Launcher's `account` line: its device_id (the chip's MAC) and the rest (launcher-usb's parseAccount, kept here: no import). */
export function accountFacts(line) {
  if (!/^ACCOUNT /.test(line || '')) return null;
  const f = {};
  for (const part of line.slice(8).trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) f[part.slice(0, at)] = part.slice(at + 1);
  }
  const val = (k) => {
    if (f[k] === undefined || f[k] === '-' || f[k] === '') return null;
    try { return decodeURIComponent(f[k]); } catch { return null; }
  };
  return {bound: f.bound === '1', device_id: macKey(f.device_id), target: val('target'), version: val('version')};
}
/** A JSON line, or null. */
export function jsonLine(line) {
  if (!/^\s*\{/.test(line || '')) return null;
  try { const v = JSON.parse(line); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * What is on `port` (Web Serial's, or 203cli's stand-in; not open, or `opened`): opened, asked, closed again (unless `keep`).
 * Answers one of
 *   {kind: 'firmware', name, version, info, mac, protocol}   a CardenzaHAL firmware's serial port (`version`, `info`)
 *   {kind: 'launcher', version, mac, info?, account?, busy?} the 203 Launcher's console (`info`, else `account`: its device_id
 *                                                             is the chip's MAC; away from its home screen, or counting down
 *                                                             to its last app: busy, `version` answered ERR)
 *   {kind: 'rom', mac}                                        the ROM's download mode (SYNC answered; the MAC from its eFuses)
 *   {kind: 'silent'}                                          nothing answered: on 303A:1001, a firmware without USB
 *   {kind: 'unavailable', error}                              it would not open (another tab or program has it)
 * with `port` and `usb` (portKind). `ms`: how long for `version`; ROM's SYNC is tried `tries` times, `syncMs` each.
 */
export async function probePort(port, {ms = 1500, syncMs = 400, tries = 3, log = () => {}, opened = false, keep = false, rom = true} = {}) {
  const usb = portKind(port);
  if (!opened) {
    try { await port.open({baudRate: 115200}); } catch (e) { return {kind: 'unavailable', port, usb, error: String((e && e.message) || e)}; }
  }
  const reader = new PortReader(port, (l) => log('< ' + l));
  const writer = port.writable.getWriter();
  const say = async (text) => { log('> ' + text); await writer.write(enc.encode(text + '\n')); };
  let out = {kind: 'silent'};
  try {
    // A line of its own first: whatever a console had half-read is ended (it answers ERR and forgets it).
    await writer.write(enc.encode('\r\n'));
    await say('version');
    const first = await reader.line(/^(Launcher |Firmware |ERR\b)/, ms);
    if (first && /^ERR\b/.test(first)) {
      // A console that took the line and is busy: the Launcher away from its home screen (counting down to its last app,
      // in a menu). Esc is the caller's to send (it would stop a countdown the person may want).
      out = {kind: 'launcher', version: null, busy: true};
    } else if (first && LAUNCHER_LINE.test(first)) {
      out = {kind: 'launcher', version: LAUNCHER_LINE.exec(first)[1]};
      await say('info');
      const said = await reader.line(/^(\{|ERR\b)/, ms);
      const info = jsonLine(said);
      if (info) { out.info = info; out.mac = macKey(info.chip && info.chip.mac); }
      if (!out.mac) {
        await say('account');
        const line = await reader.line(/^(ACCOUNT |ERR\b)/, ms);
        const account = accountFacts(line);
        if (account) { out.account = account; out.mac = account.device_id; await reader.line(/^(OK|ERR)\b/, 300); }
        else if (line && !/unknown command/i.test(line)) out.busy = true;
      }
    } else if (first && FIRMWARE_LINE.test(first)) {
      const m = FIRMWARE_LINE.exec(first);
      out = {kind: 'firmware', name: m[1], version: m[2] || null};
      await say('info');
      const info = jsonLine(await reader.line(/^(\{|ERR\b)/, ms * 2));
      if (info) {
        out.info = info;
        out.mac = macKey(info.chip && info.chip.mac);
        out.protocol = info.protocol ?? null;
      }
    } else if (rom && usb !== 'hal' && usb !== 'drive') {
      reader.drop();
      for (let i = 0; i < tries && !answersSync(reader.raw); i++) {
        await writer.write(SYNC_FRAME);
        await reader.until(() => answersSync(reader.raw), syncMs);
      }
      if (answersSync(reader.raw)) {
        out = {kind: 'rom'};
        // The ROM answers SYNC several times: what follows them is READ_REG's.
        await reader.until(() => false, 100);
        reader.drop();
        const words = [];
        for (const reg of S3_MAC_REGS) {
          await writer.write(romRequest(ROM_READ_REG, le32(reg)));
          let got = null;
          await reader.until(() => { got = romAnswers(reader.raw).find((a) => a.op === ROM_READ_REG); return !!got; }, 500);
          reader.drop();
          if (!got) break;
          words.push(got.value);
        }
        if (words.length === 2) out.mac = s3Mac(words[0], words[1]);
      } else {
        // Not the ROM: a console that read SYNC's bytes ends that line (it answers ERR and forgets it).
        try { await writer.write(enc.encode('\n')); } catch { /* gone */ }
      }
    }
  } catch (e) {
    out = {kind: 'silent', error: String((e && e.message) || e)};
  } finally {
    try { writer.releaseLock(); } catch { /* gone */ }
    await reader.close();
    if (!keep) { try { await port.close(); } catch { /* gone */ } }
  }
  if (out.mac) out.mac = macKey(out.mac);
  return {...out, port, usb};
}

// ---------------------------------------------------------------------------------------------
// The HAL's system channel as bytes (CardenzaHAL usb/usb.h, docs/usb-dev.md): SysEx, HID report 0xCB, serial `sys` lines

export const HAL = Object.freeze({report: 0xcb, launcher: 0x40, reboot: 0x41, download: 0x42, console: 0x43, identify: 0x44, dev: 0x45});
export const DEV_OP = Object.freeze({HELLO: 0x00, INFO: 0x01, PARTITIONS: 0x02, STORAGE: 0x04, STATUS: 0x05});
export const DEV_FLAG = Object.freeze({LAST: 1, ERROR: 2});
const REPORT = 64;   // a HID report with its ID first: 0xCB, then the HAL's 63 bytes
const bytesOf = (v) => (v instanceof Uint8Array ? v : typeof v === 'string' ? enc.encode(v) : Uint8Array.from(v ?? []));

/** 7-bit packing: each group of up to 7 bytes becomes a byte of their top bits (bit i: byte i's), then their low 7 bits. */
export function pack7(data) {
  const bytes = bytesOf(data);
  const out = new Uint8Array(bytes.length + Math.ceil(bytes.length / 7));
  let o = 0;
  for (let at = 0; at < bytes.length; at += 7) {
    const n = Math.min(7, bytes.length - at);
    let top = 0;
    for (let i = 0; i < n; i++) top |= ((bytes[at + i] >> 7) & 1) << i;
    out[o++] = top;
    for (let i = 0; i < n; i++) out[o++] = bytes[at + i] & 0x7f;
  }
  return out;
}
/** The bytes pack7 packed (a last group of only its top-bits byte holds nothing). */
export function unpack7(data) {
  const bytes = bytesOf(data);
  const out = new Uint8Array(bytes.length - Math.ceil(bytes.length / 8));
  let o = 0;
  for (let at = 0; at < bytes.length; at += 8) {
    const top = bytes[at];
    const n = Math.min(7, bytes.length - at - 1);
    for (let i = 0; i < n; i++) out[o++] = (bytes[at + 1 + i] & 0x7f) | (((top >> i) & 1) << 7);
  }
  return out.subarray(0, o);
}
/** A development-channel request as SysEx: F0 23 45 id op <args, packed> F7. */
export function sysexRequest(id, op, args = new Uint8Array(0)) {
  const packed = pack7(args);
  const out = new Uint8Array(6 + packed.length);
  out.set([0xf0, 0x23, HAL.dev, id & 0x7f, op & 0x7f]);
  out.set(packed, 5);
  out[out.length - 1] = 0xf7;
  return out;
}
/** A development-channel request as a HID report (64 bytes, 0xCB first): [0x45, id, op, length, args]. */
export function hidRequest(id, op, args = new Uint8Array(0)) {
  const raw = bytesOf(args);
  if (raw.length > 52) throw new RangeError(`a request's args are at most 52 bytes (${raw.length})`);
  const out = new Uint8Array(REPORT);
  out.set([HAL.report, HAL.dev, id & 0x7f, op & 0x7f, raw.length]);
  out.set(raw, 5);
  return out;
}
/** One answer message out of a whole SysEx (F0 … F7): {id, seq, flags, payload}, or null. */
export function sysexAnswer(message) {
  const m = bytesOf(message);
  if (m.length < 8 || m[0] !== 0xf0 || m[1] !== 0x24 || m[2] !== HAL.dev || m[m.length - 1] !== 0xf7) return null;
  return {id: m[3], seq: m[4] | (m[5] << 7), flags: m[6], payload: unpack7(m.subarray(7, m.length - 1))};
}
/** One answer message out of a HID report (64 bytes, 0xCB first), or null. */
export function hidAnswer(report) {
  const r = bytesOf(report);
  if (r.length < 7 || r[0] !== HAL.report || r[1] !== (HAL.dev | 0x80)) return null;
  const length = Math.max(0, Math.min(r[6], 57, r.length - 7));
  return {id: r[2] & 0x7f, seq: (r[3] & 0x7f) | ((r[4] & 0x7f) << 7), flags: r[5], payload: r.slice(7, 7 + length)};
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** A HID-form report (64 bytes with 0xCB first, or the 63 after it) as a serial line: "sys <hex of the 63 bytes, trailing zeros
 *  dropped>". */
export function sysLine(report) {
  let r = bytesOf(report);
  if (r.length === REPORT && r[0] === HAL.report) r = r.subarray(1);
  let end = r.length;
  while (end > 1 && r[end - 1] === 0) end--;
  return 'sys ' + hex(r.subarray(0, end));
}
/** A serial `sys` line as the HID report it carries (64 bytes, 0xCB first), or null. */
export function sysReport(line) {
  const m = /^sys\s+([0-9a-fA-F\s]+)$/.exec(String(line || '').trim());
  if (!m) return null;
  const digits = m[1].replace(/\s+/g, '');
  if (digits.length % 2 || digits.length > 126) return null;
  const out = new Uint8Array(REPORT);
  out[0] = HAL.report;
  for (let i = 0; i < digits.length / 2; i++) out[1 + i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  return out;
}
/** IDENTIFY's answer (0x44: protocol, then the product's name), from SysEx (F0 24 44 …) or HID (0xCB 0xC4 …): {protocol,
 *  product}, or null. */
export function identifyAnswer(bytes) {
  const b = bytesOf(bytes);
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0xf0 && b[i + 1] === 0x24 && b[i + 2] === ((HAL.identify | 0x80) & 0x7f)) {
      const end = b.indexOf(0xf7, i + 3);
      if (end > i + 3) return {protocol: b[i + 3], product: dec.decode(b.subarray(i + 4, end)).replace(/\0.*$/s, '')};
    }
  }
  if (b[0] === HAL.report && b[1] === (HAL.identify | 0x80)) return {protocol: b[2], product: dec.decode(b.subarray(3)).replace(/\0.*$/s, '')};
  return null;
}
/** A system command's answer (command | 0x80) from SysEx or HID: what follows the command byte, or null. */
export function commandAnswer(bytes, command) {
  const b = bytesOf(bytes);
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xf0 && b[i + 1] === 0x24 && b[i + 2] === ((command | 0x80) & 0x7f)) {
      const end = b.indexOf(0xf7, i + 3);
      if (end > 0) return b.slice(i + 3, end);
    }
  }
  return b[0] === HAL.report && b[1] === (command | 0x80) ? b.slice(2) : null;
}

/**
 * One development-channel answer put back together from its messages (each {id, seq, flags, payload}, in order): push()
 * answers null while more are to come, then {ok: true, bytes, json()} or {ok: false, reason}; a gap in seq is a failure.
 */
export class DevAnswer {
  constructor(id) { this.id = id; this.parts = []; this.seq = 0; }
  push(message) {
    if (!message || message.id !== this.id) return null;
    if (message.seq !== this.seq) return {ok: false, reason: 'gap'};
    this.seq = (this.seq + 1) & 0x3fff;
    if (message.flags & DEV_FLAG.ERROR) return {ok: false, reason: dec.decode(message.payload)};
    this.parts.push(message.payload);
    if (!(message.flags & DEV_FLAG.LAST)) return null;
    const bytes = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) { bytes.set(p, at); at += p.length; }
    return {ok: true, bytes, json: () => JSON.parse(dec.decode(bytes))};
  }
}

/** Whole SysEx messages out of a MIDI byte stream (real-time bytes skipped; anything else passed over). */
export class SysexSplitter {
  constructor() { this.message = null; }
  push(bytes) {
    const out = [];
    for (const b of bytesOf(bytes)) {
      if (b >= 0xf8) continue;
      if (b === 0xf0) { this.message = [b]; continue; }
      if (this.message === null) continue;
      if (b === 0xf7) { this.message.push(b); out.push(Uint8Array.from(this.message)); this.message = null; continue; }
      if (b & 0x80) { this.message = null; continue; }
      this.message.push(b);
      if (this.message.length > 1024) this.message = null;
    }
    return out;
  }
}

/** What a HAL's INFO says of the device, for Cable.see: {name, version, protocol, mac, launcher, hal, flash_bytes}. */
export function infoFacts(info) {
  if (!info || typeof info !== 'object') return {};
  const fw = info.firmware || {};
  return {name: fw.name || null, version: fw.version || null, code: fw.code || null, protocol: info.protocol ?? null,
    mac: macKey(info.chip && info.chip.mac), launcher: info.launcher && info.launcher.version ? info.launcher.version : null,
    hal: info.hal && info.hal.commit ? info.hal.commit : null, flash_bytes: (info.chip && info.chip.flash_bytes) || null};
}
/** PARTITIONS' answer as a line's facts: {free_bytes, apps: [{label, size, image}], flash_bytes}. */
export function partitionFacts(p) {
  if (!p || !Array.isArray(p.partitions)) return {};
  return {free_bytes: p.free_bytes ?? null, flash_bytes: p.flash_bytes ?? null,
    apps: p.partitions.filter((x) => x.type === 'app').map((x) => ({label: x.label, size: x.size, image: x.image ?? null, running: !!x.running}))};
}
/** STORAGE's answer: {card: true|false, free_bytes, total_bytes} (docs/usb-dev.md: mounted, free, total). */
export function storageFacts(s) {
  if (!s || typeof s !== 'object') return {};
  const card = s.card && typeof s.card === 'object' ? s.card : s;
  const mounted = card.mounted ?? card.present ?? null;
  return {card: mounted === null ? null : !!mounted, card_free: card.free_bytes ?? card.free ?? null, card_total: card.total_bytes ?? card.total ?? null};
}

// ---------------------------------------------------------------------------------------------
// One entry per device: Cable

let anonymous = 0;
/**
 * The devices on the cable, one entry each whatever channels see them. see({via, ref, kind, mac, …facts}): `via` is the
 * channel (serial, midi, hid), `ref` its handle (a port, a MIDI output, a HID device), `kind` what it runs now (firmware,
 * launcher, rom, silent). Facts merge by the MAC; a channel without one (a Launcher older than `account`, an old HAL on
 * MIDI) stays with the entry it was seen on, or goes to the entry that expect()ed it (the device just sent to its Launcher
 * or the ROM), else it is an entry of its own until its MAC is known (then the two merge). drop(ref): a channel gone.
 * act(entry, fn): one action at a time a device; asked again meanwhile, the same promise (never twice).
 */
export class Cable {
  constructor({now = () => Date.now()} = {}) {
    this.now = now;
    this.entries = [];
  }
  list() { return this.entries.filter((e) => e.channels.length || e.expecting); }
  byRef(ref) { return this.entries.find((e) => e.channels.some((c) => c.ref === ref)) || null; }
  byMac(mac) { const key = macKey(mac); return key ? this.entries.find((e) => e.mac === key) || null : null; }
  /** The device `ref` is seen on, with `facts`; answers its entry. */
  see({via, ref, kind = null, mac = null, ...facts}) {
    const key = macKey(mac);
    const held = this.byRef(ref);
    let entry = (key && this.byMac(key)) || held;
    if (key && held && entry && held !== entry && !held.mac) {
      // The channel's entry had no MAC yet: it is this chip's, and joins it.
      entry.channels.push(...held.channels.filter((c) => !entry.channels.some((o) => o.ref === c.ref)));
      entry.facts = {...held.facts, ...entry.facts};
      if (!entry.acting && held.acting) entry.acting = held.acting;
      this.entries = this.entries.filter((e) => e !== held);
    } else if (key && held && entry && held !== entry && held.mac && held.mac !== key) {
      // The ref was another chip's (a port name used again): it leaves that entry.
      held.channels = held.channels.filter((c) => c.ref !== ref);
    }
    if (!entry && !key) {
      const now = this.now();
      entry = this.entries.find((e) => e.expecting && e.expecting.until >= now && (!kind || e.expecting.kinds.includes(kind))) || null;
    }
    if (!entry) {
      entry = {id: 'dev' + (++anonymous), mac: null, kind: null, facts: {}, channels: [], acting: null, expecting: null, seen: 0};
      this.entries.push(entry);
    }
    if (key && entry.mac && entry.mac !== key) {
      // The ref was another chip's (a port name used again): it leaves that entry.
      this.drop(ref);
      return this.see({via, ref, kind, mac: key, ...facts});
    }
    if (key && !entry.mac) {
      // Its MAC is known now: an entry that already had it takes this one in.
      const other = this.byMac(key);
      if (other && other !== entry) {
        other.channels.push(...entry.channels.filter((c) => !other.channels.some((o) => o.ref === c.ref)));
        other.facts = {...entry.facts, ...other.facts};
        if (!other.acting && entry.acting) other.acting = entry.acting;
        this.entries = this.entries.filter((e) => e !== entry);
        entry = other;
      }
      entry.mac = key;
    }
    const channel = entry.channels.find((c) => c.ref === ref);
    if (channel) Object.assign(channel, {via, kind, seen: this.now()});
    else if (ref !== undefined && ref !== null) entry.channels.push({via, ref, kind, seen: this.now()});
    for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== null) entry.facts[k] = v;
    if (kind) entry.kind = kind;
    if (entry.expecting && (!kind || entry.expecting.kinds.includes(kind))) entry.expecting = null;
    entry.seen = this.now();
    return entry;
  }
  /** The channel `ref` went away (a port unplugged, the device restarted). */
  drop(ref) {
    for (const e of this.entries) e.channels = e.channels.filter((c) => c.ref !== ref);
    this.entries = this.entries.filter((e) => e.channels.length || e.mac || e.expecting || e.acting);
  }
  /** `entry` was sent to `kinds` (launcher, rom): the next channel without a MAC that is one of them within `ms` is it. */
  expect(entry, kinds, ms = 15000) { entry.expecting = {kinds: [].concat(kinds), until: this.now() + ms}; }
  /** Runs `fn(entry)` as the device's one action now: asked again meanwhile, the same promise. */
  act(entry, fn) {
    if (entry.acting) return entry.acting;
    const run = Promise.resolve().then(() => fn(entry));
    entry.acting = run;
    const clear = () => { if (entry.acting === run) entry.acting = null; };
    run.then(clear, clear);
    return run;
  }
}

/** A device's line in words' parts (the pages put them in their language): {state, firmware, launcher, free, card}. */
export function summary(entry) {
  if (!entry) return null;
  const f = entry.facts || {};
  return {state: entry.kind, mac: entry.mac ? macText(entry.mac) : null, firmware: f.name ? {name: f.name, version: f.version || null} : null,
    launcher: f.launcher || null, free_bytes: f.free_bytes ?? null, flash_bytes: f.flash_bytes ?? null,
    card: f.card ?? null, card_free: f.card_free ?? null, channels: entry.channels.map((c) => c.via)};
}

// ---------------------------------------------------------------------------------------------
// The demo chip (the tests; the pages' ?usb=demo-chip…): one ESP32-S3 that is, as things happen to it, a HAL firmware (on its
// MIDI, HID and/or serial port), the 203 Launcher on USB-Serial-JTAG (the console: `launcherPort`, launcher-usb's demoPort,
// handed in: no import here), the ROM's download mode, or a firmware without USB. Times are scaled by `speed`.
//   hal.protocol   4 (serial port, INFO everywhere), 3, 2 (INFO over the development channel), 1 (identify only)
//   hal.classes    of midi, hid, serial
//   hal.restart    'ticket' (the Launcher's home), 'plain' (the Launcher counts down to the firmware: Esc holds it)
//   launcher       null: no Launcher on the chip (a reset runs the firmware again); else {version, info (it answers `info`)}
//   state          firmware, launcher, rom, bare (a firmware without USB)

export function demoChip({mac = '70af09bceb30', state = 'firmware', name = 'CardenzaSynth', version = '0.3.0',
  hal = {}, launcher = {version: '0.3.3-cardenza', info: false, resume: true}, launcherPort = null, speed = 1} = {}) {
  const ms = (n) => Math.max(1, Math.round(n * speed));
  const chip = {mac: macKey(mac), state, home: true, port: null, sent: [], restarts: 0, lostToCountdown: 0, resets: [], flashed: 0,
    hal: {protocol: 4, classes: ['midi', 'hid'], restart: 'ticket', ...hal}, launcher: launcher ? {resume: true, ...launcher} : null,
    // What runs when the Launcher starts its last app: a firmware on the HAL, or one without USB.
    runs: state === 'bare' ? 'bare' : 'firmware'};
  const midiListeners = new Set(), hidListeners = new Set(), ports = new Set();
  let timer = null;
  const later = (n, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms(n)); };
  const unplug = () => { for (const p of ports) p.unplug(); ports.clear(); chip.port = null; };
  /** The chip leaves USB and comes back `n` ms later as `next`. */
  const go = (next, n = 300, after = () => {}) => {
    unplug();
    chip.escape = null;
    chip.state = 'off';
    later(n, () => { chip.state = next; chip.port = null; after(); });
  };
  const toFirmware = () => go(chip.runs, 300);
  /** The Launcher's bootloader: its home (a ticket, FN, no app to resume) or a countdown to the last app that Esc stops. */
  const boot = (home) => {
    if (!chip.launcher) { toFirmware(); return; }
    go('launcher', 300, () => {
      chip.home = home || !chip.launcher.resume;
      if (chip.home) return;
      let cleared = false;
      setTimeout(() => { cleared = true; }, ms(120));
      chip.escape = () => { if (cleared && !chip.home) chip.home = true; };
      setTimeout(() => { if (chip.state === 'launcher' && !chip.home) { chip.lostToCountdown += 1; toFirmware(); } }, ms(1120));
    });
  };
  chip.command = (command) => {
    chip.sent.push(command);
    if (command === HAL.launcher) { chip.restarts += 1; boot(chip.hal.restart === 'ticket'); return true; }
    if (command === HAL.download) { go('rom', 300); return true; }
    if (command === HAL.reboot) { toFirmware(); return true; }
    return false;
  };
  /** HOME pressed, Back to Launcher chosen (the HAL's system menu): the Launcher's home. */
  chip.menu = () => { if (chip.state !== 'firmware') return false; chip.restarts += 1; boot(true); return true; };
  const v4 = () => chip.hal.protocol >= SERIAL_PROTOCOL;
  const product = () => (v4() ? 'Cardenza' : '203 Systems Cardenza');
  chip.info = () => ({protocol: chip.hal.protocol, ...(v4() ? {board: 'Cardenza'} : {}),
    firmware: {name, version, code: null, product: product()}, hal: {commit: 'demo', dirty: false},
    launcher: chip.launcher ? {name: '203 Launcher', version: chip.launcher.version.replace(/-.*$/, '')} : null,
    chip: {model: 'ESP32-S3', mac: macText(chip.mac), flash_bytes: 16777216},
    ...(v4() ? {usb: {vid: HAL_VID, pid: 0x10c0, serial_number: macText(chip.mac), classes: chip.hal.classes}} : {})});
  chip.partitions = () => ({flash_bytes: 16777216, running: 'ota_0', free_bytes: 4194304,
    partitions: [{label: 'ota_0', type: 'app', subtype: 'ota_0', offset: 0x170000, size: 0x690000, image: 1834208, running: true}]});
  chip.storage = () => ({mounted: true, free_bytes: 12 * 2 ** 30, total_bytes: 15 * 2 ** 30});
  const devJson = (op) => (op === DEV_OP.INFO ? chip.info() : op === DEV_OP.PARTITIONS ? chip.partitions() : op === DEV_OP.STORAGE ? chip.storage()
    : op === DEV_OP.HELLO ? {protocol: chip.hal.protocol, max_args: 52, dev: true, settings: true, serial: chip.hal.classes.includes('serial')} : null);
  /** A development-channel request's answer: [{id, seq, flags, payload}] (protocol 1 has no development channel: nothing). */
  const devMessages = (id, op, chunk) => {
    if (chip.hal.protocol < 2) return [];
    const json = devJson(op);
    if (!json) return [{id, seq: 0, flags: DEV_FLAG.LAST | DEV_FLAG.ERROR, payload: enc.encode('unknown request')}];
    const payload = enc.encode(JSON.stringify(json));
    const out = [];
    for (let at = 0, seq = 0; ; at += chunk, seq++) {
      const last = at + chunk >= payload.length;
      out.push({id, seq, flags: last ? DEV_FLAG.LAST : 0, payload: payload.subarray(at, at + chunk)});
      if (last) return out;
    }
  };
  const has = (cls) => chip.state === 'firmware' && chip.hal.classes.includes(cls);
  const restartCommand = (command) => [HAL.launcher, HAL.download, HAL.reboot].includes(command);

  // MIDI (Web MIDI's shape): SysEx in, SysEx out.
  const sysexOut = (bytes) => setTimeout(() => { for (const l of midiListeners) l(Uint8Array.from(bytes)); }, ms(5));
  const midiIn = (data) => {
    const b = Uint8Array.from(data);
    if (!has('midi') || b[0] !== 0xf0 || b[1] !== 0x23) return;
    const command = b[2];
    if (command === HAL.identify) { sysexOut([0xf0, 0x24, 0x44, chip.hal.protocol, ...enc.encode(product()), 0xf7]); return; }
    if (command === HAL.dev) {
      for (const m of devMessages(b[3], b[4], 48)) sysexOut([0xf0, 0x24, HAL.dev, m.id, m.seq & 0x7f, (m.seq >> 7) & 0x7f, m.flags, ...pack7(m.payload), 0xf7]);
      return;
    }
    if (restartCommand(command)) {
      sysexOut([0xf0, 0x24, (command | 0x80) & 0x7f, 0xf7]);
      setTimeout(() => chip.command(command), ms(20));
    }
  };
  const midiPort = (type) => {
    let handler = null, listener = null;
    return {id: type + '-demo-' + chip.mac, type, manufacturer: '203 Systems',
      get name() { return product(); },
      get state() { return has('midi') ? 'connected' : 'disconnected'; },
      get onmidimessage() { return handler; },
      set onmidimessage(fn) {
        if (listener) midiListeners.delete(listener);
        handler = fn;
        listener = fn ? (data) => fn({data}) : null;
        if (listener) midiListeners.add(listener);
      },
      send(data) { if (type === 'output') midiIn(data); }};
  };
  chip.midiOutput = midiPort('output');
  chip.midiInput = midiPort('input');
  /** Web MIDI's access as the chip has it now. */
  chip.midiAccess = () => ({outputs: new Map(has('midi') ? [[chip.midiOutput.id, chip.midiOutput]] : []),
    inputs: new Map(has('midi') ? [[chip.midiInput.id, chip.midiInput]] : [])});

  // HID (WebHID's shape: sendReport(id, data); inputreport events {reportId, data: DataView}).
  const report = (bytes) => { const r = new Uint8Array(REPORT); r.set(bytes); return r; };
  const devReports = (id, op) => devMessages(id, op, 57).map((m) => {
    const r = report([HAL.report, HAL.dev | 0x80, m.id, m.seq & 0x7f, (m.seq >> 7) & 0x7f, m.flags, m.payload.length]);
    r.set(m.payload, 7);
    return r;
  });
  const hidOut = (r) => setTimeout(() => {
    for (const l of hidListeners) l({reportId: r[0], data: new DataView(Uint8Array.from(r.subarray(1)).buffer)});
  }, ms(5));
  chip.hidDevice = {vendorId: HAL_VID, productId: 0x10c0, collections: [{usagePage: 0xff00, usage: 1}], opened: false,
    get productName() { return product(); },
    async open() { this.opened = true; }, async close() { this.opened = false; },
    addEventListener(type, fn) { if (type === 'inputreport') hidListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'inputreport') hidListeners.delete(fn); },
    async sendReport(id, data) {
      if (!has('hid')) throw new DOMException('The device has been lost.', 'NotFoundError');
      const d = Uint8Array.from(data);
      if (id !== HAL.report) return;
      const command = d[0];
      if (command === HAL.identify) { hidOut(report([HAL.report, 0xc4, chip.hal.protocol, ...enc.encode(product())])); return; }
      if (command === HAL.dev) { for (const r of devReports(d[1], d[2])) hidOut(r); return; }
      if (restartCommand(command)) { hidOut(report([HAL.report, command | 0x80])); setTimeout(() => chip.command(command), ms(20)); }
    }};
  /** WebHID's devices as the chip has them now. */
  chip.hidDevices = () => (has('hid') ? [chip.hidDevice] : []);

  // Serial ports (Web Serial's shape) for the state it is in.
  const serialPort = (info, onLine, onBytes = null) => {
    let out = null, lost = false, text = '';
    const port = {
      demo: true,
      getInfo: () => ({...info}),
      readable: null, writable: null,
      signals: {dataTerminalReady: false, requestToSend: false},
      async open() {
        if (lost) throw new DOMException('Failed to open serial port.', 'NetworkError');
        port.readable = new ReadableStream({start(c) { out = c; }});
        port.writable = new WritableStream({write(chunk) {
          if (lost) throw new DOMException('The device has been lost.', 'NetworkError');
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (onBytes && onBytes(bytes)) return;
          text += dec.decode(bytes);
          let at;
          while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at).replace(/\r$/, '').trim(); text = text.slice(at + 1); if (line) onLine(line); }
        }});
      },
      async close() { try { if (out) out.close(); } catch { /* closed */ } out = null; port.readable = null; port.writable = null; },
      async setSignals(s) {
        if (lost) throw new DOMException('The device has been lost.', 'NetworkError');
        Object.assign(port.signals, s);
        if (port.onSignals) port.onSignals({...port.signals});
      },
      say(line, n = 10) { setTimeout(() => { if (out && !lost) { try { out.enqueue(enc.encode(line + '\r\n')); } catch { /* closed */ } } }, ms(n)); },
      raw(bytes, n = 5) { setTimeout(() => { if (out && !lost) { try { out.enqueue(Uint8Array.from(bytes)); } catch { /* closed */ } } }, ms(n)); },
      get lost() { return lost; },
      unplug() { lost = true; try { if (out) out.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* closed */ } },
    };
    ports.add(port);
    return port;
  };
  // esptool's resets on USB-Serial-JTAG, as the peripheral does them: RTS with DTR low holds the chip in reset; let go after DTR
  // (IO0) was set, it starts in the ROM's download mode; else as from power-on (the Launcher's bootloader, its countdown).
  const watchResets = (port) => {
    let held = false, download = false, lastDtr = false;
    port.onSignals = ({dataTerminalReady: dtr, requestToSend: rts}) => {
      if (rts && !dtr) { if (!held) download = lastDtr; held = true; }
      else if (held && !rts) {
        held = false;
        chip.resets.push(download ? 'rom' : 'run');
        if (download) go('rom', 200); else boot(false);
      }
      lastDtr = dtr;
    };
  };
  const halSerial = () => {
    const port = serialPort({usbVendorId: HAL_VID, usbProductId: 0x10c0}, (line) => {
      const cmd = line.split(/\s+/)[0].toLowerCase();
      if (cmd === 'version') { port.say(`Firmware ${name} ${version}`); return; }
      const op = {info: DEV_OP.INFO, partitions: DEV_OP.PARTITIONS, storage: DEV_OP.STORAGE, hello: DEV_OP.HELLO}[cmd];
      if (op !== undefined) { port.say(JSON.stringify(devJson(op))); return; }
      if (cmd === 'launcher' || cmd === 'download' || cmd === 'reboot') {
        port.say('OK ' + cmd);
        setTimeout(() => chip.command(HAL[cmd]), ms(30));
        return;
      }
      if (cmd === 'sys') {
        const r = sysReport(line);
        if (!r) { port.say('ERR bad report'); return; }
        const command = r[1];
        if (command === HAL.identify) port.say(sysLine(report([HAL.report, 0xc4, chip.hal.protocol, ...enc.encode(product())])));
        else if (command === HAL.dev) for (const a of devReports(r[2], r[3])) port.say(sysLine(a), 5);
        else if (restartCommand(command)) { port.say(sysLine(report([HAL.report, command | 0x80]))); setTimeout(() => chip.command(command), ms(30)); }
        return;
      }
      port.say("ERR unknown command, type 'help' for command list");
    });
    // esptool's ClassicReset / UnixTightReset as a bridge's lines (RTS with DTR low, then DTR with RTS low, then both low): the ROM.
    const seen = [];
    port.onSignals = ({dataTerminalReady: dtr, requestToSend: rts}) => {
      const s = (dtr ? 2 : 0) | (rts ? 1 : 0);
      if (seen[seen.length - 1] !== s) seen.push(s);
      if (/1,(3,)?2,0$/.test(seen.slice(-4).join(','))) { seen.length = 0; chip.resets.push('rom'); chip.command(HAL.download); }
    };
    return port;
  };
  const romPort = () => {
    const port = serialPort({...USJ}, () => {}, (bytes) => {
      for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] !== 0xc0 || bytes[i + 1] !== 0x00) continue;
        const op = bytes[i + 2];
        if (op === 0x08) { for (let k = 0; k < 4; k++) port.raw(romAnswerFrame(0x08, 0)); }
        else if (op === ROM_READ_REG) {
          const reg = (bytes[i + 9] | (bytes[i + 10] << 8) | (bytes[i + 11] << 16) | (bytes[i + 12] << 24)) >>> 0;
          const m = chip.mac.match(/../g).map((x) => parseInt(x, 16));
          const word = reg === S3_MAC_REGS[0] ? ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0 : reg === S3_MAC_REGS[1] ? ((m[0] << 8) | m[1]) >>> 0 : 0;
          port.raw(romAnswerFrame(ROM_READ_REG, word));
        }
      }
      return true;
    });
    watchResets(port);
    return port;
  };
  const barePort = () => {
    const port = serialPort({...USJ}, () => {});
    // A firmware without USB prints its own log and answers nothing.
    const tick = setInterval(() => { if (port.lost) clearInterval(tick); else port.say('I (1234) app: running', 1); }, ms(250));
    watchResets(port);
    return port;
  };
  const launcherSerial = () => {
    if (!launcherPort) throw new Error('demoChip: launcherPort (launcher-usb.js demoPort) is needed for the Launcher');
    const port = launcherPort({id: chip.mac, info: !!chip.launcher.info, version: chip.launcher.version, pace: 400 * speed, onLine(line) {
      const text = line.trim();
      if (/^nav\s+(EscPress|esc)$/i.test(text) && chip.escape) chip.escape();
      if (/^flash\s+firmware\s/i.test(text)) chip.flashed += 1;
      if (/^reboot$/i.test(text)) { setTimeout(() => toFirmware(), ms(30)); return true; }
      return false;
    }});
    port.getInfo = () => ({...USJ});
    port.signals = {dataTerminalReady: false, requestToSend: false};
    port.setSignals = async (s) => { Object.assign(port.signals, s); if (port.onSignals) port.onSignals({...port.signals}); };
    // Closed after a flash: the Launcher starts what it installed.
    const close = port.close.bind(port);
    port.close = async () => {
      await close();
      if (chip.port !== port) return;
      if (chip.flashed) { chip.flashed = 0; chip.runs = 'firmware'; toFirmware(); } else chip.port = null;
    };
    watchResets(port);
    ports.add(port);
    return port;
  };
  /** The serial port the chip shows now (the same object while it stays), or null. */
  chip.serialPort = () => {
    if (chip.port && !chip.port.lost) return chip.port;
    let p = null;
    if (chip.state === 'firmware' && chip.hal.classes.includes('serial')) p = halSerial();
    else if (chip.state === 'launcher') p = launcherSerial();
    else if (chip.state === 'rom') p = romPort();
    else if (chip.state === 'bare') p = barePort();
    chip.port = p;
    return p;
  };
  chip.stop = () => { clearTimeout(timer); unplug(); };
  return chip;
}

/** One ROM answer as a SLIP frame (the demo's): direction 1, the op, its value, a status of two zero bytes. */
function romAnswerFrame(op, value) {
  const body = [0x01, op, 0x02, 0x00, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff, 0x00, 0x00];
  const out = [0xc0];
  for (const b of body) { if (b === 0xc0) out.push(0xdb, 0xdc); else if (b === 0xdb) out.push(0xdb, 0xdd); else out.push(b); }
  out.push(0xc0);
  return out;
}
