// 203cli board's transport: the development channel of a firmware on CardenzaHAL (CardenzaHAL docs/usb-dev.md), the HAL's system
// command 0x45 over the system channel the firmware's USB already has (no task or buffer in the firmware until a computer asks).
// A request is [id, op, args]; its answer is one or more messages carrying the same id, counted by seq (14 bits, from 0,
// wrapping), the last flagged LAST (or ERROR: its payload is the reason). Here: the bytes both ways, an answer put back
// together (or a gap found: asked again), ARG for args longer than a request, CANCEL, pipelined requests.
//   SysEx  request F0 23 45 id op <args, 7-bit packed> F7 (args at most 52 bytes unpacked)
//          answer  F0 24 45 id seq_lo seq_hi flags <payload, packed> F7 (payload at most 48 bytes)
//   HID    report 0xCB, 63 bytes: request [0x45, id, op, length, args (length of them, at most 52, raw)]; answer [0xC5, id,
//          seq_lo, seq_hi, flags, length, payload (at most 57)]. On hidraw (and hidapi) a report is 64 bytes, its ID first.
// Where the bytes go (found as restart.mjs finds the firmware; Node has no MIDI or HID API):
//   Linux    ALSA raw MIDI (/dev/snd/midiC<card>D<n>, SysEx), else hidraw (/dev/hidrawN): a file descriptor kept open for
//            the whole command and polled (Node has no readiness event for a character device).
//   macOS    CoreMIDI through python3's ctypes (COREMIDI_PRELUDE), one bridge process for the whole command: SysEx bytes in on
//            its stdin, what the device sends out on its stdout, both as hex lines; the protocol stays here.
//   Windows  its HID through node-hid (hidapi, 203cli's optional dependency there, prebuilt): the HAL's system channel, the
//            first vendor collection of the device (restart.mjs systemCollections), read as node-hid's data events.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {findFirmware, macPython, nodeHid, systemCollections, COREMIDI_PRELUDE} from "./restart.mjs";
import {HAL_COMMAND, HAL_REPORT, halReport, halSysex, LauncherConsole} from "./launcher-usb.mjs";
import {serialPorts, openPort} from "./flash.mjs";
import {CliError, EXIT} from "./guide.mjs";

export const DEV_COMMAND = 0x45;
// IDENTIFY's protocol: 2 from the development channel on, 3 from the board's settings on (CardenzaHAL 2026-11-23).
export const PROTOCOL = 2;
export const SETTINGS_PROTOCOL = 3;
export const OP = Object.freeze({HELLO: 0x00, INFO: 0x01, PARTITIONS: 0x02, MEMORY: 0x03, STORAGE: 0x04, STATUS: 0x05, I2C: 0x06, ARG: 0x0e,
  SCREEN: 0x10, KEYS: 0x11, COREDUMP_INFO: 0x20, COREDUMP_READ: 0x21, COREDUMP_ERASE: 0x22,
  LS: 0x30, GET: 0x31, PUT_BEGIN: 0x32, PUT_DATA: 0x33, PUT_END: 0x34, PUT_ABORT: 0x35, RM: 0x36, MKDIR: 0x37, MV: 0x38,
  SETTINGS: 0x40, SETTING_GET: 0x41, SETTING_SET: 0x42, SETTINGS_RESET: 0x43, CANCEL: 0x7f});
export const FLAG = Object.freeze({LAST: 1, ERROR: 2});
export const LIMITS = Object.freeze({args: 52, sysexPayload: 48, hidPayload: 57, argBuffer: 512, queue: 8, path: 255, putChunk: 48});
export const SEQ_SPAN = 1 << 14;
const EMPTY = new Uint8Array(0);
const REPORT = 64;   // a HID report on hidraw / hidapi: the report ID, then the HAL's 63 bytes
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

export const bytesOf = value => value instanceof Uint8Array ? value : typeof value === "string" ? enc.encode(value) : Uint8Array.from(value ?? []);
export function concat(...parts) {
  const all = parts.map(bytesOf);
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
export const u32 = n => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
/** A signed 32-bit number, little-endian (two's complement: the same bytes as u32 of its unsigned value). */
export const i32 = n => u32(n | 0);
export const readU32 = (b, at = 0) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

// ---------------------------------------------------------------------------------------------
// Bytes on the wire

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

/** A request as SysEx: F0 23 45 id op <args, packed> F7. */
export function sysexRequest(id, op, args = EMPTY) {
  const packed = pack7(args);
  const out = new Uint8Array(6 + packed.length);
  out.set([0xf0, 0x23, DEV_COMMAND, id & 0x7f, op & 0x7f]);
  out.set(packed, 5);
  out[out.length - 1] = 0xf7;
  return out;
}
/** A request as a HID output report: the report ID 0xCB, then [0x45, id, op, length, args], zeros to 64 bytes. */
export function hidRequest(id, op, args = EMPTY) {
  const raw = bytesOf(args);
  if (raw.length > LIMITS.args) throw new RangeError(`a request's args are at most ${LIMITS.args} bytes (${raw.length})`);
  const out = new Uint8Array(REPORT);
  out.set([HAL_REPORT, DEV_COMMAND, id & 0x7f, op & 0x7f, raw.length]);
  out.set(raw, 5);
  return out;
}
/** One answer message out of a whole SysEx (F0 … F7): {id, seq, flags, payload}, or null (not the development channel's). */
export function sysexAnswer(message) {
  const m = bytesOf(message);
  if (m.length < 8 || m[0] !== 0xf0 || m[1] !== 0x24 || m[2] !== DEV_COMMAND || m[m.length - 1] !== 0xf7) return null;
  return {id: m[3], seq: m[4] | (m[5] << 7), flags: m[6], payload: unpack7(m.subarray(7, m.length - 1))};
}
/** One answer message out of a HID input report (64 bytes, the report ID first), or null. */
export function hidAnswer(report) {
  const r = bytesOf(report);
  if (r.length < 7 || r[0] !== HAL_REPORT || r[1] !== (DEV_COMMAND | 0x80)) return null;
  const length = Math.max(0, Math.min(r[6], LIMITS.hidPayload, r.length - 7));
  return {id: r[2] & 0x7f, seq: (r[3] & 0x7f) | ((r[4] & 0x7f) << 7), flags: r[5], payload: r.slice(7, 7 + length)};
}

/** Whole SysEx messages out of a MIDI byte stream: real-time bytes inside skipped; notes, running status and the rest passed over. */
export class SysexReader {
  constructor(max = 1024) { this.max = max; this.message = null; }
  push(bytes) {
    const out = [];
    for (const b of bytesOf(bytes)) {
      if (b >= 0xf8) continue;
      if (b === 0xf0) { this.message = [b]; continue; }
      if (this.message === null) continue;
      if (b === 0xf7) { this.message.push(b); out.push(Uint8Array.from(this.message)); this.message = null; continue; }
      if (b & 0x80) { this.message = null; continue; }   // another status byte: that SysEx was cut short
      this.message.push(b);
      if (this.message.length > this.max) this.message = null;
    }
    return out;
  }
}
/**
 * The system channel's reports (0xCB, 64 bytes) out of what is read from HID. A hidraw read is one report: one that starts
 * with another report ID (the keyboard's, the consumer keys') is passed over whole; a stream (a pty, a bridge) is cut in 64s.
 */
export class HidReader {
  constructor() { this.part = null; }
  push(bytes) {
    const b = bytesOf(bytes), out = [];
    for (let at = 0; at < b.length;) {
      if (this.part === null) {
        if (b[at] !== HAL_REPORT && b[at] !== 0xff) break;
        this.part = [];
      }
      const take = Math.min(REPORT - this.part.length, b.length - at);
      for (let i = 0; i < take; i++) this.part.push(b[at + i]);
      at += take;
      if (this.part.length === REPORT) {
        if (this.part[0] === HAL_REPORT) out.push(Uint8Array.from(this.part));
        this.part = null;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// A session: requests and their answers over one link

/** Part of an answer that had started was lost: worth asking again. */
export const lostPart = error => error instanceof BoardError && (error.code === "gap" || (error.code === "timeout" && error.got > 0));

/** What went wrong on the channel: code device (the firmware's reason), timeout, gap, cancelled, gone, closed, bad_answer, too_long. */
export class BoardError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * The development channel over a link ({kind: "sysex" | "hid", via, where, start(onBytes, onError), send(bytes), close()}:
 * a backend below, or a stand-in in the tests). Requests may overlap (each its own id); the firmware answers them in turn.
 */
export class Board {
  constructor(link, {timeout = 5000} = {}) {
    this.link = link;
    this.kind = link.kind;
    this.timeout = timeout;
    this.maxArgs = LIMITS.args;
    this.nextId = Math.floor(Math.random() * 128);   // not where another run left off: its late answers are not ours
    this.waiting = new Map();
    this.watchers = new Set();
    this.reader = link.kind === "hid" ? new HidReader() : new SysexReader();
    this.heard = 0;
    this.failure = null;
    this.closed = false;
    this.cleanups = [];
    link.start(bytes => this.take(bytes), error => this.lost(error));
  }

  take(bytes) {
    for (const message of this.reader.push(bytes)) {
      const answer = this.kind === "hid" ? hidAnswer(message) : sysexAnswer(message);
      if (!answer) { for (const watch of [...this.watchers]) watch(message); continue; }
      this.heard = Date.now();
      this.waiting.get(answer.id)?.message(answer);
    }
  }

  lost(error) {
    if (this.failure || this.closed) return;
    this.failure = new BoardError("gone", `the device went away (${error?.code || error?.message || error})`);
    for (const waiter of [...this.waiting.values()]) waiter.fail(this.failure);
  }

  takeId() {
    for (let i = 0; i < 128; i++) {
      const id = this.nextId;
      this.nextId = (this.nextId + 1) & 0x7f;
      if (!this.waiting.has(id)) return id;
    }
    throw new BoardError("busy", "128 requests are waiting");
  }
  frame(id, op, args = EMPTY) { return this.kind === "hid" ? hidRequest(id, op, args) : sysexRequest(id, op, args); }
  async send(bytes) {
    if (this.failure) throw this.failure;
    if (this.closed) throw new BoardError("closed", "the connection is closed");
    try { await this.link.send(bytes); } catch (error) {
      if (error instanceof BoardError) throw error;
      this.lost(error);
      throw this.failure;
    }
  }

  /**
   * Sends a request and returns {id, done} at once: `done` resolves to the answer's bytes (or, with onPayload, calls it with
   * each message's payload in order and resolves to undefined). Rejects with a BoardError. Args longer than a request go
   * ahead in ARG requests of the same id. `timeout`: how long with no message from the channel (the firmware works through
   * its queue in turn) before it gives up.
   */
  async start(op, args = EMPTY, {timeout = this.timeout, onPayload = null, onProgress = null} = {}) {
    if (this.failure) throw this.failure;
    if (this.interrupted) throw new BoardError("cancelled", "stopped (Ctrl-C)");
    const data = bytesOf(args);
    const ahead = [];
    let own = data;
    while (own.length > this.maxArgs) {
      ahead.push(own.subarray(0, this.maxArgs));
      own = own.subarray(this.maxArgs);
    }
    if (data.length - own.length > LIMITS.argBuffer) throw new BoardError("too_long", `a request's arguments are at most about ${LIMITS.argBuffer + this.maxArgs} bytes (${data.length})`);
    const id = this.takeId();
    const chunks = [];
    let expect = 0, settle, timer = null;
    const done = new Promise((resolve, reject) => { settle = (error, value) => (error ? reject(error) : resolve(value)); });
    const finish = (error, value) => {
      if (!this.waiting.has(id) || this.waiting.get(id) !== waiter) return;
      this.waiting.delete(id);
      clearTimeout(timer);
      settle(error, value);
    };
    const waiter = {
      id, op, sent: Date.now(), got: 0, bytes: 0,
      message: answer => {
        if (answer.seq !== expect) {
          return finish(new BoardError("gap", `part of the answer was lost (message ${expect} expected, ${answer.seq} came)`, {op, got: waiter.got}));
        }
        expect = (expect + 1) % SEQ_SPAN;
        waiter.got++;
        if (answer.flags & FLAG.ERROR) {
          const reason = dec.decode(answer.payload).replace(/\0+$/, "").trim() || "error";
          return finish(new BoardError("device", reason, {op, reason}));
        }
        if (answer.payload.length) {
          if (onPayload) {
            try { onPayload(answer.payload); } catch (error) { return finish(error); }
          } else {
            chunks.push(answer.payload);
            waiter.bytes += answer.payload.length;
            onProgress?.(waiter.bytes);
          }
        }
        if (answer.flags & FLAG.LAST) finish(null, onPayload ? undefined : concat(...chunks));
      },
      fail: error => finish(error),
    };
    const check = () => {
      const idle = Date.now() - Math.max(this.heard, waiter.sent);
      if (idle >= timeout) {
        finish(new BoardError("timeout", waiter.got ? `the answer stopped after ${waiter.got} messages (${Math.round(timeout / 1000)} s without one)`
          : `no answer in ${Math.round(timeout / 1000)} s`, {op, got: waiter.got}));
      } else timer = setTimeout(check, timeout - idle);
    };
    this.waiting.set(id, waiter);
    try {
      for (const chunk of ahead) await this.send(this.frame(id, OP.ARG, chunk));
      waiter.sent = Date.now();
      await this.send(this.frame(id, op, own));
    } catch (error) {
      finish(error);
      done.catch(() => {});
      throw error;
    }
    waiter.sent = Date.now();
    timer = setTimeout(check, timeout);
    return {id, done};
  }

  /** A request's whole answer (bytes; undefined with onPayload). */
  async request(op, args, options) { return (await this.start(op, args, options)).done; }

  /**
   * A request asked again when part of its answer was lost (a gap, or an answer that stopped before its end) or the
   * firmware's queue was full (busy). For requests that change nothing: retries 0 for the others.
   */
  async ask(op, args = EMPTY, {retries = 2, ...options} = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(op, args, options); } catch (error) {
        if (!(error instanceof BoardError) || attempt >= retries) throw error;
        if (lostPart(error)) await this.cancel();
        else if (error.code === "device" && error.reason === "busy") await sleep(250);
        else throw error;
      }
    }
  }

  /** A JSON answer, parsed. */
  async json(op, args = EMPTY, options = {}) {
    const bytes = await this.ask(op, args, options);
    const text = dec.decode(bytes);
    try { return JSON.parse(text); } catch {
      throw new BoardError("bad_answer", `the answer is not JSON: ${text.slice(0, 120)}`, {op});
    }
  }

  /**
   * CANCEL: the firmware stops the answer it is sending (it ends with the error "cancelled"), drops what is queued and
   * lets go of keys pressed from here. What is still waiting here then fails with "cancelled".
   */
  async cancel({ms = 400} = {}) {
    if (this.failure || this.closed) return;
    const first = this.waiting.keys().next();
    try { await this.send(this.frame(first.done ? this.takeId() : first.value, OP.CANCEL)); } catch { return; }
    // Nothing waits here (a gap's answer, already given up): a moment for the firmware to stop sending it.
    if (!this.waiting.size) { await sleep(Math.min(ms, 100)); return; }
    for (const end = Date.now() + ms; this.waiting.size && Date.now() < end;) await sleep(10);
    for (const waiter of [...this.waiting.values()]) waiter.fail(new BoardError("cancelled", "cancelled"));
  }

  /** IDENTIFY (0x44), the HAL's own system command: {protocol, product}, or null when nothing answers in `ms`. */
  identify(ms = 1500) {
    const ask = this.kind === "hid" ? halReport(HAL_COMMAND.identify) : Uint8Array.from(halSysex(HAL_COMMAND.identify));
    const want = (HAL_COMMAND.identify | 0x80) & 0xff;
    return new Promise(resolve => {
      let timer = null;
      const done = value => { clearTimeout(timer); this.watchers.delete(watch); resolve(value); };
      const watch = m => {
        let body = null;
        if (this.kind === "hid" && m[0] === HAL_REPORT && m[1] === want) body = m.subarray(2);
        if (this.kind !== "hid" && m[1] === 0x24 && m[2] === (want & 0x7f)) body = m.subarray(3, m.length - 1);
        if (!body || !body.length) return;
        const name = body.subarray(1);
        const end = name.indexOf(0);
        done({protocol: body[0], product: Buffer.from(end < 0 ? name : name.subarray(0, end)).toString("latin1")});
      };
      this.watchers.add(watch);
      timer = setTimeout(() => done(null), ms);
      this.send(ask).catch(() => done(null));
    });
  }

  /** HELLO: {protocol, max_args}; the request size it says is used from here on. */
  async hello(timeout = 3000) {
    const said = await this.json(OP.HELLO, EMPTY, {timeout, retries: 0});
    if (Number.isInteger(said?.max_args) && said.max_args > 0) this.maxArgs = Math.min(said.max_args, LIMITS.args);
    this.protocol = said?.protocol ?? null;
    return said;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiting.values()]) waiter.fail(new BoardError("closed", "the connection was closed"));
    try { await this.link.close(); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Links: the bytes to and from one device

/**
 * A device file open for the whole command: ALSA raw MIDI (kind sysex) or hidraw (kind hid). Read by polling (non-blocking
 * reads every 2 ms while nothing comes); throws when it cannot be opened (EBUSY: another program has it; EACCES).
 */
export function fileLink(file, kind) {
  const {O_RDWR, O_NOCTTY, O_NONBLOCK} = fs.constants;
  const fd = fs.openSync(file, O_RDWR | O_NOCTTY | O_NONBLOCK);
  const buffer = Buffer.alloc(4096);
  let open = true, timer = null;
  return {
    kind, via: kind === "hid" ? "hidraw" : "rawmidi", where: file,
    start(onBytes, onError) {
      const poll = () => {
        timer = null;
        if (!open) return;
        let got = false;
        for (let i = 0; i < 64 && open; i++) {
          let n;
          try { n = fs.readSync(fd, buffer, 0, buffer.length, null); } catch (error) {
            if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") break;
            open = false;
            onError(error);
            return;
          }
          if (!n) break;
          got = true;
          onBytes(Uint8Array.from(buffer.subarray(0, n)));
        }
        if (open) { timer = setTimeout(poll, got ? 0 : 2); timer.unref?.(); }
      };
      poll();
    },
    async send(bytes) {
      for (let at = 0; at < bytes.length;) {
        if (!open) throw new BoardError("gone", "the device went away");
        try { at += fs.writeSync(fd, bytes, at, bytes.length - at); } catch (error) {
          if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
          await sleep(1);
        }
      }
    },
    async close() {
      open = false;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* gone */ }
    },
  };
}

// The bridges: python3 holds the device for the whole command. Its first line on stdout is JSON, {"ready": true, "name"} or
// {"error"}; then each line is hex: bytes the device sent ("!" and a reason when it failed). Lines of hex on its stdin are
// sent to the device. It ignores Ctrl-C (203cli sends CANCEL through it first) and ends when its stdin closes.
const BRIDGE_HEAD = String.raw`
import json, signal, sys
signal.signal(signal.SIGINT, signal.SIG_IGN)
def fail(message):
    print(json.dumps({"error": message})); sys.stdout.flush(); sys.exit(0)
`;
// CoreMIDI (macOS): SysEx both ways, through the first destination and source whose name has Cardenza.
export const COREMIDI_BRIDGE = BRIDGE_HEAD + COREMIDI_PRELUDE + String.raw`
if source is None:
    fail("no MIDI source named Cardenza")
said = threading.Lock()
def say(text):
    with said:
        sys.stdout.write(text + "\n"); sys.stdout.flush()
say(json.dumps({"ready": True, "name": name}))
def pump():
    while True:
        with lock:
            data = bytes(received)
            del received[:]
        if data:
            say(data.hex())
        time.sleep(0.002)
threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    data = bytes.fromhex(line)
    packet_list = ctypes.create_string_buffer(struct.pack("<IQH", 1, 0, len(data)) + data)
    if cm.MIDISend(out, destination, packet_list) != 0:
        say("!MIDISend failed")
time.sleep(0.05)
`;
/** A bridge process as a link: resolves once it holds the device; rejects with {code: its error} when it cannot. */
export function bridgeLink([command, ...pre], script, {kind, via, ms = 15000}) {
  const child = spawn(command, [...pre, "-I", "-c", script], {stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
  let onBytes = null, onError = null, text = "", errors = "", ended = false;
  const early = [];
  return new Promise((resolve, reject) => {
    let first = true;
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("the bridge did not start"), {code: "bridge_timeout"})); }, ms);
    const link = {
      kind, via, where: via,
      start(bytes, error) { onBytes = bytes; onError = error; for (const b of early.splice(0)) bytes(b); },
      async send(bytes) {
        if (ended) throw new BoardError("gone", "the device went away");
        child.stdin.write(Buffer.from(bytes).toString("hex") + "\n");
      },
      async close() {
        if (ended) return;
        child.stdin.end();
        const gone = new Promise(resolve => child.once("close", resolve));
        if (await Promise.race([gone.then(() => true), sleep(1500).then(() => false)]) === false) child.kill();
      },
    };
    child.stdout.on("data", chunk => {
      text += chunk.toString("latin1");
      for (let at; (at = text.indexOf("\n")) >= 0;) {
        const line = text.slice(0, at).trim();
        text = text.slice(at + 1);
        if (first) {
          first = false;
          clearTimeout(timer);
          let said = null;
          try { said = JSON.parse(line); } catch { said = {error: line || "no answer"}; }
          if (said?.ready) { link.where = said.name || via; link.name = said.name; resolve(link); }
          else reject(Object.assign(new Error(String(said?.error || "the bridge failed")), {code: String(said?.error || "bridge_failed")}));
          continue;
        }
        if (!line) continue;
        if (line.startsWith("!")) { onError?.(new Error(line.slice(1))); continue; }
        const bytes = Uint8Array.from(Buffer.from(line, "hex"));
        if (onBytes) onBytes(bytes); else early.push(bytes);
      }
    });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.stdin.on("error", () => { /* it ended: the close below says so */ });
    child.on("error", error => { clearTimeout(timer); ended = true; reject(Object.assign(error, {code: error.code || "bridge_failed"})); });
    child.on("close", status => {
      ended = true;
      clearTimeout(timer);
      if (first) reject(Object.assign(new Error(errors.trim().split("\n").pop() || `python ended (${status})`), {code: "bridge_failed"}));
      else onError?.(new Error("the bridge ended"));
    });
  });
}

/**
 * The HAL's system channel over node-hid (Windows): reports of 64 bytes, the report ID first, both ways. `hid`: node-hid
 * (the tests give a stand-in). Rejects with {code: no_hid} when it is not installed, {code: not_found} when no Cardenza is
 * on HID, {code: open_failed} when none of its collections opens (another program has it).
 */
export async function nodeHidLink({hid = nodeHid()} = {}) {
  if (!hid) throw Object.assign(new Error("node-hid is not installed"), {code: "no_hid"});
  const ways = systemCollections(hid.devices());
  if (!ways.length) throw Object.assign(new Error("no Cardenza on HID"), {code: "not_found"});
  let device = null, way = null, last = null;
  for (const candidate of ways) {
    try { device = await hid.HIDAsync.open(candidate.path); way = candidate; break; } catch (error) { last = error; }
  }
  if (!device) throw Object.assign(new Error(`its HID cannot be opened (${last?.message || last})`), {code: "open_failed"});
  let open = true;
  const name = String(way.product || "Cardenza").trim();
  return {
    kind: "hid", via: "hidapi", where: name, name,
    start(onBytes, onError) {
      device.on("data", data => onBytes(Uint8Array.from(data)));
      device.on("error", error => { if (!open) return; open = false; onError(error); });
    },
    async send(bytes) {
      if (!open) throw new BoardError("gone", "the device went away");
      await device.write(Array.from(bytes));
    },
    async close() {
      if (!open) return;
      open = false;
      try { await device.close(); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Finding the board and opening the channel

const RELINK_HINT = "Linux: raw MIDI is the seat user's or the audio group's (sudo usermod -aG audio $USER, then log in again); close what holds the device's MIDI port " +
  "(a 203cli log, a DAW, a web page with Web MIDI) and run it again";
export const REBUILD_HINT = "Rebuild the firmware with a current CardenzaHAL (update the HAL submodule to its main branch: git -C components/CardenzaHAL pull origin main, " +
  "or the project's own way, e.g. make hal-update), install it with 203cli flash --bin build/<project>.bin, then run this again";
export const SETTINGS_HINT = "Rebuild the firmware with a CardenzaHAL from 2026-11-23 on (the board's settings came then): update the HAL submodule to its main branch " +
  "(git -C components/CardenzaHAL pull origin main, or the project's own way, e.g. make hal-update), install it with 203cli flash --bin build/<project>.bin, then run this again";
/** The firmware's HAL predates the board's settings (protocol 2 answers their requests "unknown request"). */
export const settingsTooOld = (product, protocol = null) => new CliError("hal_too_old",
  `The firmware on ${product} was built with a CardenzaHAL older than the board's settings${protocol !== null ? ` (its USB protocol is ${protocol}; 203cli board settings needs ${SETTINGS_PROTOCOL})` : ""}`,
  {exit: EXIT.refused, hint: SETTINGS_HINT, data: {protocol, needs: SETTINGS_PROTOCOL}});
const DEV_OFF_HINT = "Turn it on (idf.py menuconfig, or CONFIG_CARDENZA_HAL_USB_DEV=y in sdkconfig.defaults), build and install it again; 203cli board settings works without it";

/** The ways to this computer's Cardenza running a firmware: [{via, where, open(): link}] ([] when there is none), or a CliError. */
export function boardLinks({platform = process.platform} = {}) {
  if (platform === "linux" || platform === "darwin") {
    const found = findFirmware({platform});
    if (!found) return [];
    if (platform === "darwin") {
      return found.candidates.map(way => ({via: "coremidi", where: "CoreMIDI", name: found.name, open: () => {
        const python = macPython();
        if (!python) throw new CliError("python_missing", "203cli board reaches a firmware's MIDI on macOS with python3 (CoreMIDI)", {exit: EXIT.refused, hint: "xcode-select --install"});
        return bridgeLink([python], COREMIDI_BRIDGE, {kind: "sysex", via: way.via});
      }}));
    }
    return found.candidates.map(way => ({via: way.via, where: way.path, name: found.name, open: () => fileLink(way.path, way.via === "hidraw" ? "hid" : "sysex")}));
  }
  if (platform === "win32") return [{via: "hidapi", where: "HID", name: "Cardenza", open: () => nodeHidLink()}];
  throw new CliError("unsupported_platform", `203cli board reaches a device over USB on macOS, Linux and Windows, not ${platform}`, {exit: EXIT.refused});
}

/**
 * Opens the development channel to the board: the first way that opens and answers IDENTIFY, then HELLO. Throws a CliError
 * that says what to do: hal_too_old (its HAL is older than the channel, or than the settings), dev_channel_off,
 * firmware_unreachable. `links`: the ways to try (boardLinks; the tests give a stand-in device). `need`: "dev", the
 * development channel's questions (protocol 2; a firmware built without them is dev_channel_off), or "settings", the
 * board's settings (protocol 3; answered with the development channel off too).
 */
export async function openBoard({links = null, platform = process.platform, timeout = 5000, need = "dev"} = {}) {
  const ways = links ?? boardLinks({platform});
  if (!ways.length) throw await withoutChannel(platform);
  const tried = [];
  let silent = null;
  for (const way of ways) {
    let link;
    try { link = await way.open(); } catch (error) {
      if (error instanceof CliError) throw error;
      if (error.code === "no_hid") {
        throw new CliError("hidapi_missing", "203cli board reaches a firmware on Windows over its HID through node-hid (hidapi), which comes with 203cli and is not installed", {exit: EXIT.refused,
          hint: "Install 203cli again (npm install -g 203cli: node-hid comes prebuilt), then run this again"});
      }
      // No Cardenza on HID: what is there instead (its Launcher's serial port, a firmware without USB), as on the others.
      if (error.code === "not_found") throw await withoutChannel(platform);
      tried.push(`${way.where ?? way.via}: ${error.code || error.message}`);
      continue;
    }
    const board = new Board(link, {timeout});
    board.name = way.name ?? link.name ?? "Cardenza";
    board.via = link.via;
    board.where = link.where;
    const identity = await board.identify();
    if (!identity) {
      // Nothing answered here: another way (its HID beside its MIDI) may; else the HAL predates IDENTIFY too.
      silent = board.name;
      tried.push(`${way.where ?? way.via}: no answer`);
      await board.close();
      continue;
    }
    board.identity = identity;
    if (need === "settings" && identity.protocol < SETTINGS_PROTOCOL) {
      await board.close();
      throw settingsTooOld(identity.product || board.name, identity.protocol);
    }
    if (identity.protocol < PROTOCOL) {
      await board.close();
      throw new CliError("hal_too_old", `The firmware on ${identity.product || board.name} was built with a CardenzaHAL older than the development channel (its USB protocol is ${identity.protocol}; 203cli board needs ${PROTOCOL})`, {
        exit: EXIT.refused, hint: REBUILD_HINT, data: {protocol: identity.protocol, product: identity.product}});
    }
    try {
      board.helloed = await board.hello();
    } catch (error) {
      await board.close();
      // Protocol 2 answered every request "off" (HELLO too) in a firmware built without the channel; 3 answers HELLO.
      if (need !== "settings" && error.code === "device" && error.reason === "off") {
        throw new CliError("dev_channel_off", "This firmware was built without the development channel (CONFIG_CARDENZA_HAL_USB_DEV is off in its sdkconfig)", {exit: EXIT.refused,
          hint: DEV_OFF_HINT});
      }
      throw new CliError("hal_too_old", `The firmware on ${identity.product || board.name} does not answer the development channel's HELLO (${error.message}): its CardenzaHAL is older than the channel, or the firmware is stuck`, {
        exit: EXIT.refused, hint: (need === "settings" ? SETTINGS_HINT : REBUILD_HINT) + "; if it is a current build, restart the device (press HOME, or unplug it) and try again"});
    }
    // Protocol 3: HELLO says whether the development channel's questions are answered (dev) beside the settings.
    if (need !== "settings" && board.helloed?.dev === false) {
      await board.close();
      throw new CliError("dev_channel_off", "This firmware was built without the development channel (CONFIG_CARDENZA_HAL_USB_DEV is off in its sdkconfig)", {exit: EXIT.refused,
        hint: DEV_OFF_HINT});
    }
    return board;
  }
  if (silent) {
    throw new CliError("hal_too_old", `${silent} is on USB but its firmware does not answer the HAL's system commands (IDENTIFY): its CardenzaHAL is older than the development channel, or the firmware is stuck`, {
      exit: EXIT.refused, hint: REBUILD_HINT + "; if it is a current build, restart the device and try again", data: {tried}});
  }
  throw new CliError("firmware_unreachable", `The firmware is on USB but 203cli cannot open it (${tried.join("; ")})`, {exit: EXIT.refused, hint: RELINK_HINT, data: {tried}});
}

/**
 * No firmware on MIDI or HID: what is there instead. A serial port (USB-Serial-JTAG) is the 203 Launcher (it answers
 * `version` with "Launcher …") or a firmware that does not start CardenzaHAL's USB device (the template does not), which has
 * no development channel. Answers the CliError that says which.
 */
export async function withoutChannel(platform = process.platform, {ms = 1200} = {}) {
  // Windows: Espressif's COM ports, without the serial binding none (flash says what it lacks).
  let ports = [];
  try { ports = await serialPorts(platform); } catch { ports = []; }
  if (!ports.length) {
    return new CliError("board_not_found", "No Cardenza on USB: no firmware with CardenzaHAL's USB device and no serial port", {exit: EXIT.refused,
      hint: "Plug it in with a data cable (not a charging-only one), turn it on and start the firmware"});
  }
  const unasked = [];
  for (const port of ports.slice(0, 3)) {
    let version = null;
    try { version = await launcherVersion(port, ms, platform); } catch (error) { unasked.push(`${port}: ${error.code === "port_unavailable" ? error.message : error.code || error.message}`); continue; }
    if (version !== null) {
      return new CliError("board_in_launcher", `The Cardenza on ${port} is in its 203 Launcher (${version}), not running a firmware: the development channel is a firmware's`, {exit: EXIT.refused,
        hint: "Start the firmware from the Launcher (or install a build: 203cli flash --bin build/<project>.bin), then run this again", data: {port, launcher: version}});
    }
  }
  return new CliError("board_no_usb", "This firmware does not start CardenzaHAL's USB device, so the development channel is not available: add `CardenzaHAL::USB::Init();` after " +
    "`CardenzaHAL::Init()` in app_main (usb/usb.h), rebuild, flash", {exit: EXIT.refused,
    hint: `It is on the serial port ${ports.join(", ")} (USB-Serial-JTAG)${unasked.length ? ` (not asked: ${unasked.join("; ")})` : ""}; 203cli log still reads its console there. ` +
      "After the change: build, 203cli flash --bin build/<project>.bin, then run this again", data: {ports}});
}

/** The 203 Launcher's version on a serial port (it answers `version` with "Launcher …"), or null when nothing says so in `ms`. */
async function launcherVersion(port, ms, platform = process.platform) {
  const launcher = new LauncherConsole(await openPort(port, platform));
  try {
    for (let i = 0; i < 2; i++) {
      await launcher.send("version");
      const line = await launcher.lines.next(l => l.startsWith("Launcher "), ms / 2);
      if (line) return line.slice(9).trim() || "?";
    }
    return null;
  } finally { await launcher.close(); }
}
