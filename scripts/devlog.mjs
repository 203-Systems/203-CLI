// 203cli log: a device's log over its USB cable, for trying a build on one's own Cardenza (and a test on a computer with one
// plugged in: --until). No sign-in, like flash. Where the log is:
//   a firmware on CardenzaHAL that started USB (no serial port): its console on the HAL's system channel (usb/usb.cpp,
//     the command 0x43): asked for as SysEx F0 23 43 01 F7, the text comes as F0 24 43 <text> F7 (the last KB first: the
//     HAL keeps a ring); else over HID, report 0xCB [0x43, 1], answered 0xCB [0xC3, length, text]. Turned off again at the
//     end (F0 23 43 00 F7), so the firmware stops sending. Found as restart.mjs finds it: Linux ALSA raw MIDI, else hidraw;
//     macOS CoreMIDI through python3 (as cardenza_usb.py console does it, with ctypes).
//   the 203 Launcher, or a firmware without USB (the template: ESP-IDF's console on USB-Serial-JTAG): the serial port
//     (/dev/ttyACM*, /dev/cu.usbmodem*), read as flash reads it (stty raw).
// Windows: no serial or MIDI API without native modules: the HAL's cardenza_usb.py console (hidapi) does it there.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import {spawn} from "node:child_process";
import {findFirmware, macPython, COREMIDI_PRELUDE} from "./restart.mjs";
import {HAL_REPORT} from "./launcher-usb.mjs";
import {listPorts, openSerial} from "./flash.mjs";
import {CliError, EXIT} from "./guide.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const CONSOLE = 0x43;
export const consoleSysex = on => [0xf0, 0x23, CONSOLE, on ? 1 : 0, 0xf7];
export function consoleReport(on) {
  const report = new Uint8Array(64);
  report[0] = HAL_REPORT; report[1] = CONSOLE; report[2] = on ? 1 : 0;
  return report;
}
// A firmware that crashed: ESP-IDF's panic handler, abort(), a failed assert, the task watchdog, a restart after them (not the
// boot ROM's banner: a serial port read from before the firmware starts shows that every time).
export const CRASH = /Guru Meditation Error|abort\(\) was called|^Backtrace:|Rebooting\.\.\.|assert failed:|Task watchdog got triggered|Brownout detector was triggered/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Console text out of what was read over MIDI: the SysEx F0 24 43 … F7 messages (anything else skipped: notes, other
 * answers), returned with the bytes still waiting for their F7.
 */
export function sysexConsole(buffer) {
  let text = "", at = 0;
  for (;;) {
    const start = buffer.indexOf(0xf0, at);
    if (start < 0) return {text, rest: new Uint8Array(0)};
    const end = buffer.indexOf(0xf7, start + 1);
    if (end < 0) return {text, rest: buffer.slice(start)};
    if (buffer[start + 1] === 0x24 && buffer[start + 2] === CONSOLE) {
      for (const b of buffer.subarray(start + 3, end)) if (b < 0x80) text += String.fromCharCode(b);   // real-time bytes inside: not text
    }
    at = end + 1;
  }
}
/** Console text out of HID input reports (0xCB, 0xC3, length, text …, 64 bytes each). */
export function hidConsole(buffer) {
  let text = "", at = 0;
  for (; at + 64 <= buffer.length; at += 64) {
    if (buffer[at] === HAL_REPORT && buffer[at + 1] === (CONSOLE | 0x80)) text += Buffer.from(buffer.subarray(at + 3, at + 3 + Math.min(buffer[at + 2], 61))).toString("latin1");
  }
  return {text, rest: buffer.slice(at)};
}

// CoreMIDI (macOS): the console turned on, its text printed as it comes, turned off at SIGTERM / SIGINT or after `seconds`.
export const COREMIDI_CONSOLE_HEAD = String.raw`
import json, sys
def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr); sys.exit(3)
`;
export const COREMIDI_CONSOLE = String.raw`
import signal
seconds = float(sys.argv[1])
running = [True]
def stop(*_):
    running[0] = False
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def send(data):
    packet_list = ctypes.create_string_buffer(struct.pack("<IQH", 1, 0, len(data)) + data)
    return cm.MIDISend(out, destination, packet_list) == 0
if not send(bytes([0xF0, 0x23, 0x43, 1, 0xF7])):
    print(json.dumps({"error": "MIDISend failed"}), file=sys.stderr); sys.exit(3)
end = time.monotonic() + seconds if seconds > 0 else None
pending = b""
while running[0] and (end is None or time.monotonic() < end):
    with lock:
        pending += bytes(received); received.clear()
    while True:
        start = pending.find(b"\xf0")
        if start < 0:
            pending = b""; break
        stop_at = pending.find(b"\xf7", start + 1)
        if stop_at < 0:
            pending = pending[start:]; break
        if pending[start + 1:start + 3] == b"\x24\x43":
            sys.stdout.write(bytes(b for b in pending[start + 3:stop_at] if b < 0x80).decode("latin-1")); sys.stdout.flush()
        pending = pending[stop_at + 1:]
    time.sleep(0.02)
send(bytes([0xF0, 0x23, 0x43, 0, 0xF7]))
time.sleep(0.05)
`;

/** Where to read: {via: serial|rawmidi|hidraw|coremidi, path?, name} or a CliError. */
export function logSource({port = null, platform = process.platform} = {}) {
  if (port) return {via: "serial", path: port, name: port};
  if (!["linux", "darwin"].includes(platform)) {
    throw new CliError("unsupported_platform", "203cli log reads the USB cable on macOS and Linux", {exit: EXIT.refused,
      hint: "On Windows: pip install hidapi, then python components/CardenzaHAL/tools/cardenza_usb.py console 60 (a firmware that started USB); " +
        "a firmware without USB or the Launcher: any serial monitor on its COM port (idf.py -p COM5 monitor)"});
  }
  const firmware = findFirmware({platform});
  if (firmware) return {via: "firmware", firmware, name: firmware.name};
  const ports = listPorts(platform);
  if (ports.length === 1) return {via: "serial", path: ports[0], name: ports[0]};
  throw new CliError(ports.length ? "port_ambiguous" : "port_not_found",
    ports.length ? `Several USB serial ports: ${ports.join(", ")}` : "No Cardenza on USB: no firmware on CardenzaHAL with USB and no serial port",
    {exit: EXIT.refused, field: "port", hint: ports.length ? "Say which with --port" : "Plug it in with a data cable (not a charging-only one) and turn it on; then run it again"});
}

/** Reads text from a device file (raw MIDI, hidraw) after writing `start`; `stop` written at the end. */
function deviceReader(file, {start, stop, decode}) {
  const {O_RDWR, O_NOCTTY, O_NONBLOCK} = fs.constants;
  let fd = fs.openSync(file, O_RDWR | O_NOCTTY | O_NONBLOCK);
  const write = async bytes => {
    for (let at = 0; at < bytes.length;) {
      try { at += fs.writeSync(fd, bytes, at, bytes.length - at); } catch (error) { if (error.code !== "EAGAIN") throw error; await sleep(2); }
    }
  };
  let rest = new Uint8Array(0);
  const chunk = Buffer.alloc(1024);
  return {
    open: () => write(Uint8Array.from(start)),
    async read() {
      for (;;) {
        let n;
        try { n = fs.readSync(fd, chunk, 0, chunk.length, null); } catch (error) {
          if (error.code === "EAGAIN") { await sleep(20); return ""; }
          throw error;
        }
        if (n === 0) { await sleep(20); return ""; }
        const all = new Uint8Array(rest.length + n);
        all.set(rest); all.set(chunk.subarray(0, n), rest.length);
        const got = decode(all);
        rest = got.rest;
        return got.text;
      }
    },
    async close() {
      if (fd === null) return;
      try { await write(Uint8Array.from(stop)); } catch { /* gone */ }
      try { fs.closeSync(fd); } catch { /* gone */ }
      fd = null;
    },
  };
}

function serialReader(file) {
  const port = openSerial(file);
  const reader = port.readable.getReader();
  let waiting = null;
  return {
    open: async () => {},
    async read() {
      waiting ??= reader.read();
      const got = await Promise.race([waiting, sleep(100).then(() => null)]);
      if (!got) return "";
      waiting = null;
      if (got.done) throw Object.assign(new Error("the port closed"), {code: "EIO"});
      return Buffer.from(got.value).toString("utf8");
    },
    async close() { try { reader.releaseLock(); } catch { /* reading */ } await port.close(); },
  };
}

function coremidiReader(seconds) {
  const python = macPython();
  if (!python) throw new CliError("python_missing", "203cli log reads a firmware's MIDI on macOS with python3 (CoreMIDI)", {exit: EXIT.refused, hint: "xcode-select --install"});
  const child = spawn(python, ["-I", "-c", COREMIDI_CONSOLE_HEAD + COREMIDI_PRELUDE + COREMIDI_CONSOLE, String(seconds > 0 ? seconds + 1 : 0)], {stdio: ["ignore", "pipe", "pipe"]});
  let text = "", errors = "", ended = false;
  child.stdout.on("data", chunk => { text += chunk.toString("latin1"); });
  child.stderr.on("data", chunk => { errors += chunk; });
  child.on("close", () => { ended = true; });
  return {
    open: async () => {},
    async read() {
      if (!text && ended) throw Object.assign(new Error(errors.trim().split("\n").pop() || "CoreMIDI ended"), {code: "coremidi"});
      if (!text) { await sleep(50); return ""; }
      const out = text; text = "";
      return out;
    },
    async close() { if (!ended) { child.kill("SIGTERM"); await new Promise(resolve => child.once("close", resolve)); } },
  };
}

function readerFor(source, seconds) {
  if (source.via === "serial") return [serialReader(source.path), source.path];
  const tried = [];
  for (const way of source.firmware.candidates) {
    try {
      if (way.via === "rawmidi") return [deviceReader(way.path, {start: consoleSysex(true), stop: consoleSysex(false), decode: sysexConsole}), way.path];
      if (way.via === "hidraw") return [deviceReader(way.path, {start: consoleReport(true), stop: consoleReport(false), decode: hidConsole}), way.path];
      if (way.via === "coremidi") return [coremidiReader(seconds), "CoreMIDI"];
    } catch (error) {
      tried.push(`${way.path ?? way.via}: ${error.code || error.message}`);
    }
  }
  throw new CliError("firmware_unreachable", `${source.name} is on USB but its console cannot be opened (${tried.join("; ")})`, {exit: EXIT.refused,
    hint: "Linux: raw MIDI is the seat user's or the audio group's (sudo usermod -aG audio $USER, then log in again); close any program that holds the device's MIDI port"});
}

export async function deviceLog(ctx) {
  const o = ctx.flags;
  const test = o.until !== undefined;
  const regex = (flag, value) => {
    try { return new RegExp(value); } catch (error) { throw ctx.usage(`--${flag} is not a regular expression: ${error.message}`, {field: flag}); }
  };
  const until = test ? regex("until", o.until) : null;
  const failure = o.fail !== undefined ? regex("fail", o.fail) : test ? CRASH : null;
  // How long: --seconds, else until Ctrl-C on a terminal; a program gets 20 s (an agent's call has to end).
  const seconds = o.seconds ?? (ctx.interactive && !test ? 0 : test ? 60 : 20);
  const source = logSource({port: o.port ? String(o.port) : null});
  const [reader, where] = readerFor(source, seconds);
  const out = o.out ? fs.openSync(ctx.path("out", {exists: false}), "a") : null;
  const lines = [];
  let partial = "", matched = null, failed = null, failedAt = 0, stopped = false;
  const onSignal = () => { stopped = true; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  ctx.say(`Reading the log of ${source.name} (${source.via === "serial" ? "serial port" : "USB console"} ${where})${seconds ? ` for ${seconds} s` : ": Ctrl-C stops"}${until ? `, until /${o.until}/` : ""}…`);
  const take = line => {
    const clean = line.replace(ANSI, "").replace(/\r$/, "");
    lines.push(clean);
    if (lines.length > 2000) lines.shift();
    if (!ctx.json) process.stdout.write(clean + "\n");
    if (out !== null) fs.writeSync(out, clean + "\n");
    if (until && !matched && until.test(clean)) matched = clean;
    if (failure && !failed && failure.test(clean)) { failed = clean; failedAt = Date.now(); }
  };
  const started = Date.now();
  try {
    await reader.open();
    while (!stopped && !matched && (!seconds || Date.now() - started < seconds * 1000)) {
      // After a crash line, the backtrace that follows (two seconds), then stop.
      if (failed && Date.now() - failedAt > 2000) break;
      let text;
      try { text = await reader.read(); } catch (error) {
        if (lines.length || partial) { take(partial || "(the device went away: it restarted or was unplugged)"); partial = ""; break; }
        throw new CliError("port_failed", `Reading ${where} failed: ${error.code || error.message}`, {exit: EXIT.later, next: [ctx.cmd()],
          hint: error.code === "EACCES" ? "No permission: on Linux add yourself to the dialout (serial) or audio (MIDI) group, then log in again" : "Plug the USB cable in again and run it again"});
      }
      if (!text) continue;
      partial += text;
      const parts = partial.split("\n");
      partial = parts.pop();
      for (const line of parts) { take(line); if (matched) break; }
    }
    if (partial && !matched) take(partial);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await reader.close();
    if (out !== null) fs.closeSync(out);
  }
  const elapsed = Math.round((Date.now() - started) / 100) / 10;
  const base = {via: source.via === "serial" ? "serial" : "console", port: where, device: source.name, seconds: elapsed, lines: lines.length};
  if (failed && !matched) {
    throw new CliError("device_crashed", `The device crashed or restarted: ${failed}`, {exit: EXIT.refused, data: {...base, log_tail: lines.slice(-30).join("\n")},
      hint: "Decode the backtrace with the build's ELF: xtensa-esp32s3-elf-addr2line -pfiaC -e build/<project>.elf <addresses> (idf.py monitor does it too)"});
  }
  if (until && !matched) {
    throw new CliError("log_timeout", `No line matched /${o.until}/ in ${elapsed} s`, {exit: EXIT.refused, data: {...base, log_tail: lines.slice(-30).join("\n")},
      hint: "The firmware did not print it: read the log above; a longer --seconds if it starts slowly"});
  }
  return {json: {status: matched ? "matched" : "done", ...base, ...(matched ? {matched} : {}), log: lines.slice(-200).join("\n")},
    text: matched ? `Matched: ${matched}` : `${lines.length} lines in ${elapsed} s.`};
}
