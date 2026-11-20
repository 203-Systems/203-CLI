// A stand-in firmware for 203c board's tests: the device side of CardenzaHAL's development channel (docs/usb-dev.md), written
// from the spec apart from scripts/board-usb.mjs (its own 7-bit packing, framing, queue), so a mistake shared by both sides
// does not hide. It answers in-process through link() (the same link interface the real backends give 203c), or behind a
// pseudo-terminal (`sink` and receive(), tests/board.test.mjs). An SD card in memory, a screen, keys, a core dump.
// It also checks what it is sent: a request longer than the HAL can collect lands in `violations`.

const OPS = {HELLO: 0x00, INFO: 0x01, PARTITIONS: 0x02, MEMORY: 0x03, STORAGE: 0x04, STATUS: 0x05, I2C: 0x06, ARG: 0x0e, SCREEN: 0x10, KEYS: 0x11,
  COREDUMP_INFO: 0x20, COREDUMP_READ: 0x21, COREDUMP_ERASE: 0x22, LS: 0x30, GET: 0x31, PUT_BEGIN: 0x32, PUT_DATA: 0x33, PUT_END: 0x34, PUT_ABORT: 0x35,
  RM: 0x36, MKDIR: 0x37, MV: 0x38, CANCEL: 0x7f};
const LAST = 1, ERROR = 2;
const text = s => Array.from(Buffer.from(s, "utf8"));
const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const at32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function packFake(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const group = Array.from(bytes.slice(i, i + 7));
    out.push(group.reduce((top, b, j) => top | (b & 0x80 ? 1 << j : 0), 0), ...group.map(b => b & 0x7f));
  }
  return out;
}
export function unpackFake(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const top = bytes[i];
    Array.from(bytes.slice(i + 1, i + 8)).forEach((b, j) => out.push(b | (((top >> j) & 1) << 7)));
  }
  return Uint8Array.from(out);
}

// What a screen shows: four bands of colour, and a white pixel at each corner.
export function fakePixel(x, y, width = 240, height = 135) {
  if ((x === 0 || x === width - 1) && (y === 0 || y === height - 1)) return 0xffff;
  return [0xf800, 0x07e0, 0x001f, 0x8410][Math.floor((x * 4) / width)];
}

export const INFO = {protocol: 2,
  firmware: {name: "CardenzaSynth", version: "0.2.0", code: "V6QK28", product: "Cardenza", idf: "v5.3.5", built: "Nov 20 2026 10:00:00",
    elf_sha256: "9f2c" + "0".repeat(60), secure_version: 0},
  hal: {commit: "acbc6bd", dirty: false}, launcher: {name: "203 Launcher", version: "0.3.1"},
  chip: {model: "ESP32-S3", revision: "0.2", cores: 2, cpu_mhz: 240, mac: "F4:12:FA:00:11:22", flash_bytes: 16777216, psram_bytes: 2097152},
  uptime_ms: 81234, reset: "power-on", wakeup: null,
  hal_init: {system: true, keyboard: true, audio: true, display: true, storage: true, ir: false}};
export const PARTITIONS = {flash_bytes: 16777216, running: "ota_0",
  partitions: [{label: "nvs", type: "data", subtype: "nvs", offset: 36864, size: 20480, nvs: {pages: 5, entries: 630, used: 211}},
    {label: "otadata", type: "data", subtype: "ota", offset: 57344, size: 8192},
    {label: "app0", type: "app", subtype: "factory", offset: 65536, size: 1376256, image: 1100000},
    {label: "ota_0", type: "app", subtype: "ota_0", offset: 1507328, size: 4194304, image: 1834208, running: true},
    {label: "coredump", type: "data", subtype: "coredump", offset: 5701632, size: 65536}],
  free_bytes: 7340032};
export const MEMORY = {internal: {total: 391000, free: 120000, min_free: 90000, largest: 60000},
  psram: {total: 2097152, free: 1500000, min_free: 1400000, largest: 1400000}, dma: {free: 110000, largest: 60000},
  tasks: [{name: "IDLE0", priority: 0, core: 0, stack_free: 900, state: "ready", cpu: 70.5}, {name: "main", priority: 1, core: 1, stack_free: 2100, state: "blocked", cpu: 12.5},
    {name: "audio", priority: 20, core: 1, stack_free: 1500, state: "blocked", cpu: 30.25}, {name: "tusb", priority: 5, core: -1, stack_free: 3000, state: "blocked", cpu: 1}],
  cpu_window_ms: 500};
export const STORAGE = {mounted: true, path: "/sdcard", card_bytes: 31914983424, total: 31902400512, free: 30000000000};
export const STATUS = {display: {ready: true, framebuffer: true, brightness: 80}, keyboard: {down: [], led_brightness: 255}, menu: {enabled: true, open: false},
  usb: {mounted: true, audio_in: false, audio_out: true, playback_restarts: 0}, presence: "connected"};
export const I2C = {sda: 2, scl: 1, devices: [{address: 8, name: "ES8156 (codec)"}]};

export class FakeBoard {
  constructor(options = {}) {
    // pace: ms the firmware takes before each answer and every 16 messages (a slow card, for Ctrl-C).
    Object.assign(this, {kind: "sysex", protocol: 2, hello: true, off: false, framebuffer: true, rle: true, noise: true, timeScale: 0.05, width: 240, height: 135,
      memory: MEMORY, pace: 0}, options);
    this.files = new Map();
    this.dirs = new Set([""]);
    for (const [name, data] of Object.entries(options.files ?? {})) this.addFile(name, data);
    this.requests = [];
    this.violations = [];
    this.down = new Set();
    this.queue = [];
    this.current = null;
    this.argBuffers = new Map();
    this.upload = null;
    this.dropOnce = null;     // {op, seq}: that message of that answer is not sent (a gap)
    this.coredump = options.coredump === undefined ? Uint8Array.from({length: 3000}, (_, i) => (i * 31) & 255) : options.coredump;
    this.sink = null;
    this.rx = [];
    this.sysex = null;
    this.n = 0;
  }

  addFile(name, data) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    this.files.set(name, Uint8Array.from(data));
  }

  /** The link 203c's Board takes: bytes in send(), out through start()'s callback. */
  link() {
    const fake = this;
    return {kind: this.kind, via: "fake", where: "fake",
      start(onBytes) { fake.sink = onBytes; fake.chunky = true; },
      async send(bytes) { fake.receive(bytes); },
      async close() { fake.sink = null; fake.closed = true; }};
  }

  out(bytes) {
    if (!this.sink) return;
    // In-process, SysEx comes cut anywhere (USB-MIDI packets, reads); a HID read is one report.
    if (this.chunky && this.kind === "sysex") {
      for (let at = 0; at < bytes.length;) {
        const n = 1 + ((this.n++ * 7) % 11);
        this.sink(Uint8Array.from(bytes.slice(at, at + n)));
        at += n;
      }
    } else this.sink(Uint8Array.from(bytes));
  }

  receive(bytes) {
    if (this.kind === "hid") {
      this.rx.push(...bytes);
      while (this.rx.length >= 64) this.report(this.rx.splice(0, 64));
      return;
    }
    for (const b of bytes) {
      if (b === 0xf0) this.sysex = [];
      else if (b === 0xf7 && this.sysex) { this.message(this.sysex); this.sysex = null; }
      else if (this.sysex) this.sysex.push(b);
    }
  }

  message(m) {
    if (m[0] !== 0x23) return;
    if (m.length - 1 > 63) { this.violations.push(`a SysEx of ${m.length - 1} bytes after F0 23: the HAL collects 63`); return; }
    if (m[1] === 0x44) { this.out([0xf0, 0x24, 0x44, this.protocol, ...text("Cardenza"), 0xf7]); return; }
    if (m[1] !== 0x45 || this.protocol < 2 || !this.hello) return;
    const args = unpackFake(m.slice(4));
    if (args.length > 52) this.violations.push(`args of ${args.length} bytes`);
    this.request(m[2], m[3], args);
  }

  report(r) {
    if (r[0] !== 0xcb) return;
    if (r[1] === 0x44) {
      const answer = [0xcb, 0xc4, this.protocol, ...text("Cardenza")];
      this.out([...answer, ...new Array(64 - answer.length).fill(0)]);
      return;
    }
    if (r[1] !== 0x45 || this.protocol < 2 || !this.hello) return;
    const length = r[4];
    if (length > 52) { this.violations.push(`a HID length of ${length}`); return; }
    this.request(r[2], r[3], Uint8Array.from(r.slice(5, 5 + length)));
  }

  request(id, op, args) {
    this.requests.push({id, op, args: Array.from(args)});
    if (op === OPS.CANCEL) {
      if (this.current) this.current.cancelled = true;
      this.queue = [];
      this.down.clear();
      return;
    }
    if (op === OPS.ARG) {
      const before = this.argBuffers.get(id) ?? [];
      if (before.length + args.length > 512) this.violations.push("an ARG buffer over 512 bytes");
      this.argBuffers.set(id, [...before, ...args]);
      return;
    }
    if (this.argBuffers.has(id)) {
      args = Uint8Array.from([...this.argBuffers.get(id), ...args]);
      this.argBuffers.delete(id);
    }
    if (this.queue.length >= 8) { this.send(id, 0, ERROR | LAST, text("busy")); return; }
    this.queue.push({id, op, args});
    this.pump();
  }

  async pump() {
    if (this.current || !this.queue.length) return;
    const job = this.current = this.queue.shift();
    await (this.pace ? wait(this.pace) : tick());
    let answer;
    try { answer = this.off ? {error: "off"} : await this.answer(job); } catch (error) { answer = {error: error.message}; }
    if (answer.error) this.send(job.id, 0, ERROR | LAST, text(job.cancelled ? "cancelled" : answer.error));
    else await this.stream(job, answer.bytes);
    this.current = null;
    this.pump();
  }

  async stream(job, payload) {
    const size = this.kind === "hid" ? 57 : 48;
    const parts = [];
    for (let i = 0; i < payload.length; i += size) parts.push(payload.slice(i, i + size));
    if (!parts.length) parts.push([]);
    for (let seq = 0; seq < parts.length; seq++) {
      if (job.cancelled) { this.send(job.id, seq, ERROR | LAST, text("cancelled")); return; }
      const drop = this.dropOnce && this.dropOnce.op === job.op && this.dropOnce.seq === seq;
      if (drop) this.dropOnce = null;
      else this.send(job.id, seq, seq === parts.length - 1 ? LAST : 0, parts[seq]);
      if (seq % 16 === 15) await (this.pace ? wait(this.pace) : tick());
    }
  }

  send(id, seq, flags, payload) {
    const s = seq % 16384;
    if (this.kind === "hid") {
      const r = [0xcb, 0xc5, id, s & 0x7f, s >> 7, flags, payload.length, ...payload];
      this.out([...r, ...new Array(64 - r.length).fill(0)]);
      return;
    }
    const m = [0xf0, 0x24, 0x45, id, s & 0x7f, s >> 7, flags, ...packFake(payload), 0xf7];
    if (this.noise && seq % 5 === 1) {
      m.splice(4, 0, 0xf8);                                                            // a clock tick inside the SysEx
      this.out([0x90, 60, 100, 0xf0, 0x24, 0x43, ...text("I (5) console\n"), 0xf7, 0xf0, 0x24, 0x7f, 1, 2, 0xf7]);   // a note, console text, an app report
    }
    this.out(m);
  }

  // The answers: {bytes} or {error}.
  async answer({op, args}) {
    const json = value => ({bytes: text(JSON.stringify(value))});
    const path = from => Buffer.from(args.slice(from)).toString("utf8");
    switch (op) {
      case OPS.HELLO: return json({protocol: 2, max_args: 52});
      case OPS.INFO: return json(INFO);
      case OPS.PARTITIONS: return json(PARTITIONS);
      case OPS.MEMORY: this.window = args[0] ?? null; return json(this.memory);
      case OPS.STORAGE: return json(STORAGE);
      case OPS.STATUS: return json({...STATUS, keyboard: {...STATUS.keyboard, down: [...this.down]}});
      case OPS.I2C: return json(I2C);
      case OPS.SCREEN: {
        if (!this.framebuffer) return {error: "no framebuffer"};
        const {width, height} = this;
        const pixels = [];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.push(fakePixel(x, y, width, height));
        const body = [];
        if (this.rle) {
          for (let i = 0; i < pixels.length;) {
            let n = 1;
            while (n < 255 && i + n < pixels.length && pixels[i + n] === pixels[i]) n++;
            body.push(n, pixels[i] & 255, pixels[i] >> 8);
            i += n;
          }
        } else for (const p of pixels) body.push(p & 255, p >> 8);
        return {bytes: [0x53, 1, width & 255, width >> 8, height & 255, height >> 8, this.rle ? 1 : 0, 0, ...body]};
      }
      case OPS.KEYS: {
        if (args.length % 3) return {error: "bad steps"};
        for (let i = 0; i < args.length; i += 3) {
          const [key, action, units] = args.slice(i, i + 3);
          if (key < 1 || key > 57) return {error: `no key ${key}`};
          if (action) this.down.add(key); else this.down.delete(key);
          (this.keyLog ??= []).push({key, down: !!action, wait: units * 10});
          if (units) await wait(units * 10 * this.timeScale);
        }
        return json({down: [...this.down]});
      }
      case OPS.COREDUMP_INFO:
        return json({partition: "coredump", size: 65536, present: !!this.coredump, bytes: this.coredump ? this.coredump.length : 0, enabled: true,
          summary: this.coredump ? {task: "main", pc: "0x42012345", backtrace: ["0x42012345", "0x42013456"], corrupted: false} : null});
      case OPS.COREDUMP_READ: return this.coredump ? {bytes: Array.from(this.coredump)} : {error: "no core dump"};
      case OPS.COREDUMP_ERASE: this.coredump = null; return json({erased: true});
      case OPS.LS: {
        const dir = path(0);
        if (!this.dirs.has(dir)) return {error: this.files.has(dir) ? "not a folder" : "not found"};
        const inside = name => (dir ? name.startsWith(dir + "/") && !name.slice(dir.length + 1).includes("/") : name && !name.includes("/"));
        const leaf = name => (dir ? name.slice(dir.length + 1) : name);
        return json({path: dir, entries: [...[...this.dirs].filter(inside).map(d => ({name: leaf(d), dir: true, bytes: 0, modified: null})),
          ...[...this.files].filter(([name]) => inside(name)).map(([name, data]) => ({name: leaf(name), dir: false, bytes: data.length, modified: 1795000000}))]});
      }
      case OPS.GET: {
        const offset = at32(args, 0), file = this.files.get(path(4));
        if (!file) return {error: this.dirs.has(path(4)) ? "is a folder" : "not found"};
        return {bytes: [...le32(file.length), ...file.slice(offset)]};
      }
      case OPS.PUT_BEGIN: {
        const size = at32(args, 0), name = path(4);
        const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
        if (!this.dirs.has(parent)) return {error: "not found"};
        this.upload = {name, size, data: []};
        return json({path: name, bytes: size});
      }
      case OPS.PUT_DATA: {
        if (!this.upload) return {error: "no upload"};
        const offset = at32(args, 0), data = Array.from(args.slice(4));
        if (data.length > 48) this.violations.push(`a PUT_DATA chunk of ${data.length} bytes`);
        if (offset !== this.upload.data.length) return {error: `offset ${offset}, have ${this.upload.data.length}`};
        this.upload.data.push(...data);
        return {bytes: le32(this.upload.data.length)};
      }
      case OPS.PUT_END: {
        const u = this.upload;
        if (!u) return {error: "no upload"};
        this.upload = null;
        if (u.data.length !== u.size) return {error: `short: ${u.data.length} of ${u.size}`};
        this.addFile(u.name, u.data);
        return json({path: u.name, bytes: u.size});
      }
      case OPS.PUT_ABORT: this.aborted = (this.aborted ?? 0) + 1; this.upload = null; return json({aborted: true});
      case OPS.RM: {
        const name = path(0);
        if (this.files.delete(name)) return json({removed: name});
        if (!this.dirs.has(name) || !name) return {error: "not found"};
        if ([...this.dirs, ...this.files.keys()].some(other => other.startsWith(name + "/"))) return {error: "not empty"};
        this.dirs.delete(name);
        return json({removed: name});
      }
      case OPS.MKDIR: {
        const name = path(0);
        if (this.dirs.has(name) || this.files.has(name)) return {error: "exists"};
        this.dirs.add(name);
        return json({made: name});
      }
      case OPS.MV: {
        const zero = args.indexOf(0);
        if (zero < 0) return {error: "no to"};
        const from = Buffer.from(args.slice(0, zero)).toString("utf8"), to = Buffer.from(args.slice(zero + 1)).toString("utf8");
        if (this.files.has(from)) { this.files.set(to, this.files.get(from)); this.files.delete(from); return json({moved: from, to}); }
        return {error: "not found"};
      }
      default: return {error: `unknown request ${op}`};
    }
  }
}
