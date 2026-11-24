// A device on the cable that runs a firmware instead of its 203 Launcher, from 203cli (the user, 2026-11-18: "自动让设备重启回
// Launcher 再刷"): `flash` restarts it into its Launcher (and `devices recover --port` into the ROM's download mode) the way
// the website does over Web MIDI (site/firmware-usb.js), then takes the serial port that appears. What a firmware on
// CardenzaHAL is on USB and the bytes it takes: launcher-usb.mjs, "A firmware running" (vendor 0x0203, a product named
// Cardenza, the system command as SysEx F0 23 <command> F7 or HID report 0xCB; never sent to anything else: a Mystrix would go
// to its own update mode). Node has no MIDI or HID API, so:
//   Linux  the USB device found in sysfs (/sys/bus/usb/devices: idVendor 0203, product with Cardenza); its MIDI as ALSA raw
//          MIDI (/dev/snd/midiC<card>D<n>, the sound card under that USB device), written and read as a file; else its HID
//          (/dev/hidrawN under it), report 0xCB. Raw MIDI is the seat user's (or the audio group's); hidraw is usually root's.
//   macOS  the USB device found with ioreg (no permission needed); the command sent through CoreMIDI with Python's ctypes
//          (python3 of the Command Line Tools or Homebrew: no package; as CardenzaSynth's tools/usb/cardenza_usb.py does).
//          HID is not used there (macOS asks for Input Monitoring for a device that is also a keyboard).
//   Windows  its HID through node-hid (hidapi; 203cli's optional dependency there, prebuilt, the user 2026-11-23: no Python):
//          the HAL's system channel is the first vendor collection (usage page 0xFF00) of vendor 0203 named Cardenza, report
//          0xCB, as `203cli board` reaches it there. Without node-hid the device is still found (PowerShell's Get-PnpDevice),
//          so the error says what is missing.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {HAL_COMMAND, HAL_VENDOR, halSysex, halReport, halAnswer, isCardenza} from "./launcher-usb.mjs";

export {HAL_COMMAND};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; } };
const real = file => { try { return fs.realpathSync(file); } catch { return null; } };
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const VENDOR = HAL_VENDOR.toString(16).padStart(4, "0");

/** The present USB devices of vendor 0203 as PowerShell's Get-PnpDevice lists them: "InstanceId|FriendlyName" lines. */
export function windowsPnp() {
  const script = "Get-PnpDevice -PresentOnly -InstanceId 'USB\\VID_0203*' -ErrorAction SilentlyContinue | " +
    "ForEach-Object { $_.InstanceId + '|' + $_.FriendlyName }";
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {encoding: "utf8", windowsHide: true, timeout: 20000});
  return run.status === 0 ? run.stdout : "";
}

/**
 * A firmware on CardenzaHAL on this computer's USB: {name, usb, candidates: [{via: rawmidi|hidraw|coremidi|hidapi, path?}]}, or
 * null. The tests give `sys` and `dev` (or C203_SYS, C203_DEV) instead of /sys and /dev, `ioreg`: its output, and `pnp`:
 * windowsPnp's (or C203_PNP).
 */
export function findFirmware({platform = process.platform, sys = process.env.C203_SYS || "/sys", dev = process.env.C203_DEV || "/dev", ioreg = null,
  pnp = process.env.C203_PNP ?? null} = {}) {
  if (platform === "win32") {
    // node-hid's list when it is there (no process to start); PowerShell's otherwise, so a missing node-hid is named.
    const lib = pnp === null ? nodeHid() : null;
    if (lib) {
      const way = systemCollections(lib.devices())[0];
      return way ? {name: String(way.product).trim(), usb: null, candidates: [{via: "hidapi"}]} : null;
    }
    for (const line of String(pnp ?? windowsPnp()).split(/\r?\n/)) {
      const [id = "", name = ""] = line.split("|");
      if (/^USB\\VID_0203&/i.test(id) && isCardenza(name)) return {name: name.trim(), usb: null, candidates: [{via: "hidapi"}]};
    }
    return null;
  }
  if (platform === "linux") {
    for (const entry of list(path.join(sys, "bus/usb/devices"))) {
      const dir = path.join(sys, "bus/usb/devices", entry);
      if (read(path.join(dir, "idVendor")) !== VENDOR) continue;
      const name = read(path.join(dir, "product")) || "";
      if (!isCardenza(name)) continue;
      const usb = real(dir);
      if (!usb) continue;
      const under = file => { const at = real(file); return !!at && at.startsWith(usb + path.sep); };
      const candidates = [];
      for (const card of list(path.join(sys, "class/sound"))) {
        const m = /^card(\d+)$/.exec(card);
        if (!m || !under(path.join(sys, "class/sound", card, "device"))) continue;
        for (const node of list(path.join(dev, "snd")).filter(n => new RegExp(`^midiC${m[1]}D\\d+$`).test(n)).sort()) {
          candidates.push({via: "rawmidi", path: path.join(dev, "snd", node)});
        }
      }
      for (const node of list(path.join(sys, "class/hidraw")).sort()) {
        if (under(path.join(sys, "class/hidraw", node, "device"))) candidates.push({via: "hidraw", path: path.join(dev, node)});
      }
      return {name, usb, candidates};
    }
    return null;
  }
  if (platform === "darwin") {
    let text = ioreg;
    if (text === null) {
      const run = spawnSync("ioreg", ["-p", "IOUSB", "-l", "-w0"], {encoding: "utf8", maxBuffer: 16 << 20});
      text = run.status === 0 ? run.stdout : "";
    }
    // One block a USB device ("+-o Name@…"), its properties as "key" = value lines.
    for (const block of String(text).split(/\n(?=[ |]*\+-o )/)) {
      const vendor = /"idVendor" = (\d+)/.exec(block);
      const name = (/"USB Product Name" = "([^"]*)"/.exec(block) || [])[1] || "";
      if (vendor && Number(vendor[1]) === HAL_VENDOR && isCardenza(name)) return {name, usb: null, candidates: [{via: "coremidi"}]};
    }
    return null;
  }
  return null;
}

/** Writes `bytes` to a device file and reads until `done(bytes read)` or `ms`: true when it answered. */
async function exchange(file, bytes, done, ms) {
  const {O_RDWR, O_NOCTTY, O_NONBLOCK} = fs.constants;
  const fd = fs.openSync(file, O_RDWR | O_NOCTTY | O_NONBLOCK);
  try {
    for (let at = 0; at < bytes.length;) {
      try { at += fs.writeSync(fd, bytes, at, bytes.length - at); } catch (error) { if (error.code !== "EAGAIN") throw error; await sleep(2); }
    }
    const got = [];
    const buffer = Buffer.alloc(256);
    for (const end = Date.now() + ms; Date.now() < end;) {
      let n = 0;
      try { n = fs.readSync(fd, buffer, 0, buffer.length, null); } catch (error) {
        if (error.code === "EAGAIN") { await sleep(10); continue; }
        return false;   // gone: it is restarting
      }
      if (n === 0) { await sleep(10); continue; }
      got.push(...buffer.subarray(0, n));
      if (done(Uint8Array.from(got))) return true;
    }
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* gone */ }
  }
}

// ---- Windows: HID through node-hid ----------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);
let hid;

/** node-hid, or null when it is not installed (C203_HID: a CommonJS module that stands in for it, for the tests). */
export function nodeHid() {
  if (hid === undefined) {
    try { hid = require(process.env.C203_HID ? path.resolve(process.env.C203_HID) : "node-hid"); } catch { hid = null; }
  }
  return hid;
}

/**
 * The HAL's system channel of each Cardenza in node-hid's list: the vendor collections (usage page 0xFF00) of vendor 0203
 * whose product has Cardenza, the system channel's first (the HAL's descriptor has it before the app channel, report 0xFF;
 * Windows numbers the collections in that order, &ColNN in the path). Never a Mystrix.
 */
export function systemCollections(devices) {
  const col = d => Number((/&col(\d+)/i.exec(String(d.path || "")) || [])[1] || 0);
  return devices.filter(d => d.vendorId === HAL_VENDOR && isCardenza(d.product || "") && d.usagePage === 0xff00)
    .sort((a, b) => col(a) - col(b));
}

/** One HAL system command as HID report 0xCB through node-hid, and its answer read for `ms`: {path, answered}. */
async function hidCommand(command, ms) {
  const lib = nodeHid();
  if (!lib) throw Object.assign(new Error("node-hid is not installed: install 203cli again (npm install -g 203cli)"), {code: "no_hid"});
  const ways = systemCollections(lib.devices());
  if (!ways.length) throw Object.assign(new Error("no Cardenza on HID"), {code: "not_found"});
  const report = halReport(command);
  let last = null;
  for (const way of ways) {
    let device;
    try { device = await lib.HIDAsync.open(way.path); } catch (error) { last = error; continue; }
    try {
      await device.write(Array.from(report));
      let answered = false;
      for (const end = Date.now() + ms; !answered && Date.now() < end;) {
        let data;
        try { data = await device.read(50); } catch { break; }   // gone: it is restarting
        if (data && data.length) answered = !!halAnswer(Uint8Array.from(data), command);
      }
      return {path: way.path, answered};
    } catch (error) {
      last = error;   // a collection without report 0xCB refuses it: the next one
    } finally {
      try { await device.close(); } catch { /* gone */ }
    }
  }
  throw Object.assign(new Error(String(last?.message || last || "cannot open its HID")), {code: "hid_failed"});
}

// CoreMIDI through Python's ctypes, the part every use shares: the first destination and source whose name has "Cardenza",
// an output port, an input port collecting what the device sends into `received` (under `lock`). It calls fail(message),
// which the script defines before it, when something is missing.
export const COREMIDI_PRELUDE = String.raw`
import ctypes, ctypes.util, json, struct, sys, threading, time
try:
    cm = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreMIDI"))
    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
except OSError as error:
    fail("CoreMIDI: %s" % error)
u32, vp = ctypes.c_uint32, ctypes.c_void_p
cf.CFStringCreateWithCString.restype = vp
cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, u32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_long, u32]
cf.CFRelease.argtypes = [vp]
cf.CFRelease.restype = None
READ = ctypes.CFUNCTYPE(None, vp, vp, vp)
cm.MIDIClientCreate.argtypes = [vp, vp, vp, ctypes.POINTER(u32)]
cm.MIDIOutputPortCreate.argtypes = [u32, vp, ctypes.POINTER(u32)]
cm.MIDIInputPortCreate.argtypes = [u32, vp, READ, vp, ctypes.POINTER(u32)]
cm.MIDIPortConnectSource.argtypes = [u32, u32, vp]
cm.MIDIGetNumberOfSources.restype = ctypes.c_ulong
cm.MIDIGetNumberOfDestinations.restype = ctypes.c_ulong
cm.MIDIGetSource.restype = u32
cm.MIDIGetSource.argtypes = [ctypes.c_ulong]
cm.MIDIGetDestination.restype = u32
cm.MIDIGetDestination.argtypes = [ctypes.c_ulong]
cm.MIDIObjectGetStringProperty.argtypes = [u32, vp, ctypes.POINTER(vp)]
cm.MIDISend.argtypes = [u32, u32, vp]
for name in ("MIDIClientCreate", "MIDIOutputPortCreate", "MIDIInputPortCreate", "MIDIPortConnectSource", "MIDIObjectGetStringProperty", "MIDISend"):
    getattr(cm, name).restype = ctypes.c_int32
def cfstring(text):
    return cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)
client, out, inp = u32(), u32(), u32()
label = cfstring("203cli")
status = cm.MIDIClientCreate(label, None, None, ctypes.byref(client))
if status:
    fail("MIDIClientCreate: %d" % status)
prop = vp.in_dll(cm, "kMIDIPropertyDisplayName").value
def display(endpoint):
    value = vp()
    if cm.MIDIObjectGetStringProperty(endpoint, prop, ctypes.byref(value)) != 0 or not value.value:
        return ""
    buffer = ctypes.create_string_buffer(256)
    cf.CFStringGetCString(value, buffer, 256, 0x08000100)
    cf.CFRelease(value)
    return buffer.value.decode(errors="replace")
def find(count, get):
    for index in range(count()):
        endpoint = get(index)
        name = display(endpoint)
        if "cardenza" in name.lower():
            return endpoint, name
    return None, ""
destination, name = find(cm.MIDIGetNumberOfDestinations, cm.MIDIGetDestination)
if destination is None:
    fail("no MIDI destination named Cardenza")
source, _ = find(cm.MIDIGetNumberOfSources, cm.MIDIGetSource)
received, lock = bytearray(), threading.Lock()
def on_read(packets, _port, _source):
    count = ctypes.c_uint32.from_address(packets).value
    packet = packets + 4
    for _ in range(count):
        length = ctypes.c_uint16.from_address(packet + 8).value
        data = ctypes.string_at(packet + 10, length)
        with lock:
            received.extend(data)
        packet = (packet + 10 + length + 3) & ~3
proc = READ(on_read)
for kind, port in (("out", out), ("in", inp)):
    label = cfstring(kind)
    if kind == "out":
        cm.MIDIOutputPortCreate(client, label, ctypes.byref(port))
    else:
        cm.MIDIInputPortCreate(client, label, proc, None, ctypes.byref(port))
if source is not None:
    cm.MIDIPortConnectSource(inp, source, None)
`;

// A system command (restartFirmware): sent as one SysEx packet, the answer awaited. Prints one JSON line: {"name", "sent",
// "answered"} or {"error"}.
export const COREMIDI = String.raw`
import json, sys
def fail(message):
    print(json.dumps({"error": message})); sys.exit(0)
command, seconds = int(sys.argv[1]), float(sys.argv[2])
` + COREMIDI_PRELUDE + String.raw`
data = bytes([0xF0, 0x23, command & 0x7F, 0xF7])
packet_list = ctypes.create_string_buffer(struct.pack("<IQH", 1, 0, len(data)) + data)
sent = cm.MIDISend(out, destination, packet_list) == 0
want = bytes([0xF0, 0x24, (command | 0x80) & 0x7F])
answered = False
end = time.monotonic() + seconds
while sent and time.monotonic() < end and not answered:
    with lock:
        answered = want in bytes(received)
    time.sleep(0.01)
print(json.dumps({"name": name, "sent": sent, "answered": answered}))
`;

/** A python3 for CoreMIDI, or null: the Command Line Tools' stub (/usr/bin/python3 without them) would ask to install them. */
export function macPython(env = process.env) {
  const which = spawnSync("/bin/sh", ["-c", "command -v python3"], {encoding: "utf8", env}).stdout?.trim();
  if (!which) return null;
  if (which === "/usr/bin/python3" && spawnSync("xcode-select", ["-p"], {stdio: "ignore"}).status !== 0) return null;
  return which;
}

/**
 * Sends a HAL system command (HAL_COMMAND.launcher, .download) to the firmware findFirmware found, through the first of its
 * ways that works: {via, answered}. Throws {code: "unreachable", tried: [{via, path, error}]} when none does.
 */
export async function restartFirmware(found, command = HAL_COMMAND.launcher, {ms = 1500} = {}) {
  const tried = [];
  for (const way of found.candidates) {
    try {
      if (way.via === "rawmidi") {
        const answered = await exchange(way.path, Uint8Array.from(halSysex(command)), got => !!halAnswer(got, command), ms);
        return {via: way.via, path: way.path, answered};
      }
      if (way.via === "hidraw") {
        const answered = await exchange(way.path, halReport(command), got => !!halAnswer(got, command), ms);
        return {via: way.via, path: way.path, answered};
      }
      if (way.via === "coremidi") {
        const python = macPython();
        if (!python) { tried.push({via: way.via, error: "no python3 (xcode-select --install)"}); continue; }
        const run = spawnSync(python, ["-I", "-c", COREMIDI, String(command), String(ms / 1000)], {encoding: "utf8", timeout: ms + 15000});
        let said = null;
        try { said = JSON.parse(String(run.stdout || "").trim().split("\n").at(-1)); } catch { said = null; }
        if (said && said.sent) return {via: way.via, answered: !!said.answered};
        tried.push({via: way.via, error: (said && said.error) || String(run.stderr || run.error?.message || run.status).trim().split("\n").at(-1)});
        continue;
      }
      if (way.via === "hidapi") {
        const sent = await hidCommand(command, ms);
        return {via: way.via, path: "node-hid", answered: sent.answered};
      }
    } catch (error) {
      tried.push({via: way.via, path: way.path, error: way.via === "hidapi" ? error.message : error.code || error.message});
    }
  }
  throw Object.assign(new Error("the firmware cannot be reached"), {code: "unreachable", tried});
}

/**
 * The serial port the device comes back on: `want` when it appears, else the first one that was not there `before`;
 * null after `ms`. `ports()`: the ports there are now, or a promise of them (flash.mjs serialPorts).
 */
export async function waitForPort(before, ports, {want = null, ms = 15000, every = 50} = {}) {
  const had = new Set(before);
  for (const end = Date.now() + ms; Date.now() < end;) {
    const now = await ports();
    if (want && now.includes(want)) return want;
    const fresh = now.find(p => !had.has(p));
    if (fresh && !want) return fresh;
    if (fresh && want) {
      // Another name than the one given (a second device, a renumbered tty): give the given one a moment.
      await sleep(1000);
      const again = await ports();
      return again.includes(want) ? want : again.find(p => !had.has(p)) || null;
    }
    await sleep(every);
  }
  return null;
}
