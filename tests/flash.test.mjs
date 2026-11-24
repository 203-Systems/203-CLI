// 203cli flash (线刷: a firmware over a USB cable through the device's 203 Launcher), signed out (the user, 2026-11-18:
// no account for the cable): against a stand-in API (the code, the firmware, the counted download with the community's
// signature trailer) and the demo Launcher of scripts/launcher-usb.mjs (the website's own file: the community serves it) behind a
// real pseudo-terminal, so 203cli opens, sets up and talks to a tty as it does to /dev/ttyACM0. Python makes the pty (Node
// has no API for one); without python3, or on Windows, the cable tests are skipped. The pty's path is always given with
// --port: these tests never look for a real device.
// Run: node --test tests/flash.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {ROOT, NO_UPDATES} from "./fixtures.mjs";
import {image} from "./fixtures.mjs";
import {demoPort} from "../scripts/launcher-usb.mjs";

const CLI = path.join(ROOT, "scripts/203cli.mjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const PTY = process.platform !== "win32" && spawnSync("python3", ["-I", "-c", "import pty, tty"]).status === 0;
let server, api, dir, app, trailer, requests = [];

// The community's signature trailer after an image (signed builds): what the demo Launcher reads back.
function trailerOf(statement) {
  const text = Buffer.from(JSON.stringify(statement));
  const total = Math.ceil((88 + text.length + 16) / 16) * 16;
  const out = Buffer.alloc(total);
  out.write("203SIGN1", 0, "latin1"); out.writeUInt32LE(total, 8); out.writeUInt16LE(text.length, 12); out[14] = 1;
  text.copy(out, 88);
  out.writeUInt32LE(total, total - 16); out.write("203SIGN1", total - 8, "latin1");
  return out;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-flash-"));
  app = Buffer.from(await image({project: "TestSynth", version: "1.2.0", size: 9000}));
  trailer = trailerOf({type: "203.build", kind: "app", target: "cardenza", name: "Test Synth", version: "1.2.0", code: "VER234"});
  const firmware = {code: "ABC234", name: "Test Synth", kind: "app", builds: [
    {target: "cardenza", channel: "stable", version: {code: "VER234", version: "1.2.0"}, build: 3, size: app.length, sha256: sha(app), format: "esp"},
    {target: "cardenza", channel: "beta", version: {code: "BET234", version: "1.3.0-beta.1"}, build: 4, size: app.length, sha256: sha(app), format: "esp"}]};
  server = http.createServer((req, res) => {
    requests.push({method: req.method, url: req.url, auth: req.headers.authorization || null});
    const send = (status, body, type = "application/json") => { res.writeHead(status, {"content-type": type}); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    if (req.url === "/api/codes/ABC234") return send(200, {kind: "firmware", firmware: "ABC234", version: null});
    if (req.url === "/api/codes/LCH234") return send(200, {kind: "firmware", firmware: "LCH234", version: null});
    if (req.url === "/api/firmware/ABC234") return send(200, firmware);
    if (req.url === "/api/firmware/LCH234") return send(200, {code: "LCH234", name: "Other Launcher", kind: "launcher", builds: []});
    const m = /^\/api\/versions\/([A-Z0-9]+)\/download$/.exec(req.url);
    if (m && req.method === "POST") {
      return send(200, {url: `${api.replace(/\/api$/, "")}/files/${m[1]}.bin`, size: app.length, sha256: sha(app), target: "cardenza",
        trailer: trailer.toString("base64"), file_size: app.length + trailer.length});
    }
    if (/^\/files\/[A-Z0-9]+\.bin$/.test(req.url)) return send(200, app, "application/octet-stream");
    send(404, {error: "Not found", code: "not_found"});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });

// Signed out: no token anywhere (no COMMUNITY_TOKEN, an empty config folder).
function cli(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, "--api", api, ...args], {cwd: dir, env: {...process.env, ...NO_UPDATES, XDG_CONFIG_HOME: path.join(dir, "config"),
      COMMUNITY_TOKEN: "", COMMUNITY_API: "", LANG: "en_US.UTF-8", ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      let error = null;
      try { error = JSON.parse(stderr.trim().split("\n").at(-1)); } catch { error = null; }
      resolve({code, stdout, stderr, json, error});
    });
  });
}

// The demo Launcher on the master side of a pty (python3 relays its bytes); `fn(slavePath, port)`.
const BRIDGE = `
import os, pty, select, sys, tty
m, s = pty.openpty()
tty.setraw(s)
sys.stdout.write(os.ttyname(s) + "\\n"); sys.stdout.flush()
while True:
    r, _, _ = select.select([m, 0], [], [])
    if m in r:
        try: data = os.read(m, 65536)
        except OSError: data = b""
        if data: os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data: break
        os.write(m, data)
`;
async function withLauncher(mode, fn) {
  const port = demoPort({mode, pace: 40});
  await port.open({baudRate: 115200});
  const py = spawn("python3", ["-I", "-c", BRIDGE], {stdio: ["pipe", "pipe", "inherit"]});
  const writer = port.writable.getWriter();
  const slave = await new Promise((resolve, reject) => {
    let head = "";
    let found = false;
    py.on("error", reject);
    py.stdout.on("data", chunk => {
      if (found) { writer.write(new Uint8Array(chunk)); return; }
      head += chunk.toString("latin1");
      const at = head.indexOf("\n");
      if (at < 0) return;
      found = true;
      resolve(head.slice(0, at));
      const rest = Buffer.from(head.slice(at + 1), "latin1");
      if (rest.length) writer.write(new Uint8Array(rest));
    });
  });
  const reader = port.readable.getReader();
  (async () => { for (;;) { const {value, done} = await reader.read().catch(() => ({done: true})); if (done) break; py.stdin.write(Buffer.from(value)); } })();
  try { return await fn(slave, port); } finally { py.kill(); await port.close(); }
}

test("flash CODE, signed out: the device's newest build, downloaded with its signature, written over the cable", {skip: !PTY && "no python3 pty"}, async () => {
  requests = [];
  await withLauncher("home", async (slave, port) => {
    const r = await cli(["flash", "ABC234", "--port", slave, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, "installed");
    assert.equal(r.json.target, "cardenza", "the device said what it is");
    assert.equal(r.json.launcher, "0.3.0-cardenza");
    assert.deepEqual(r.json.version, {code: "VER234", version: "1.2.0", channel: "stable"});
    assert.equal(r.json.signed, true);
    assert.equal(r.json.file_size, app.length + trailer.length);
    const installed = port.state.apps.at(-1);
    assert.deepEqual([installed.name, installed.size, installed.community, installed.code], ["Test_Synth", app.length + trailer.length, true, "VER234"],
      "the Launcher got the image and the community's signature after it");
    assert.deepEqual(r.json.installed, {how: "free", name: "Test_Synth", version: "1.2.0"}, "what the Launcher said it did");
  });
  assert.ok(requests.length >= 3, "it asked the API");
  assert.ok(requests.every(q => q.auth === null), "no credential was sent: none is needed");
  assert.ok(requests.some(q => q.method === "POST" && q.url === "/api/versions/VER234/download"), "the counted download");
});

test("flash --bin: a local application image; --channel picks a firmware's line", {skip: !PTY && "no python3 pty"}, async () => {
  const file = path.join(dir, "local.bin");
  fs.writeFileSync(file, app);
  await withLauncher("home", async (slave, port) => {
    const r = await cli(["flash", "--bin", "local.bin", "--port", slave, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.source, "file");
    assert.equal(r.json.name, "TestSynth", "named after the image's project");
    assert.deepEqual([port.state.apps.at(-1).name, port.state.apps.at(-1).community], ["TestSynth", false]);
    // The same build again: the Launcher replaces its installed copy, and 203cli says so.
    const again = await cli(["flash", "--bin", "local.bin", "--port", slave]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Replaced TestSynth 1\.2\.0 → 1\.2\.0\./);
  });
  await withLauncher("full", async (slave) => {
    const r = await cli(["flash", "--bin", "local.bin", "--port", slave, "--json"]);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.error.code, "launcher_full");
    assert.match(r.error.error, /Delete Old Synth 0\.1\.0/, "what to delete, as the Launcher said it");
  });
  await withLauncher("home", async (slave) => {
    const r = await cli(["flash", "ABC234", "--channel", "beta", "--port", slave, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version.code, "BET234");
  });
});

test("flash: a Launcher in a menu, a device of another type", {skip: !PTY && "no python3 pty"}, async () => {
  await withLauncher("busy", async (slave) => {
    const r = await cli(["flash", "ABC234", "--port", slave, "--json"]);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(r.error.code, "launcher_busy");
    assert.match(r.error.hint, /home screen/);
  });
  await withLauncher("home", async (slave) => {
    const r = await cli(["flash", "ABC234", "--target", "nullperator", "--port", slave, "--json"]);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.error.code, "wrong_device");
  });
});

test("flash --dry-run: the plan, signed out, nothing downloaded or written", async () => {
  requests = [];
  const r = await cli(["flash", "ABC234", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.dry_run, true);
  assert.deepEqual([r.json.target, r.json.version.code, r.json.size, r.json.sha256], ["cardenza", "VER234", app.length, sha(app)]);
  assert.ok(!requests.some(q => q.url.includes("/download")), "a dry run counts no download");
  const text = await cli(["flash", "ABC234", "--dry-run"]);
  assert.match(text.stdout, /No account needed/);
});

test("flash: what it refuses before touching a port", async () => {
  const both = await cli(["flash", "ABC234", "--bin", "x.bin", "--json"]);
  assert.equal(both.code, 2);
  const none = await cli(["flash", "--json"]);
  assert.equal(none.code, 2);
  const launcher = await cli(["flash", "LCH234", "--dry-run", "--json"]);
  assert.equal(launcher.code, 1);
  assert.equal(launcher.error.code, "launcher_image");
  const help = JSON.parse((await cli(["flash", "--help", "--json"])).stdout);
  assert.equal(help.signin, false, "listed as needing no sign-in");
});

// ---------------------------------------------------------------------------------------------
// A device running a firmware (restart.mjs; the user, 2026-11-18: "自动让设备重启回 Launcher 再刷"): found in a stand-in sysfs,
// asked over its MIDI (ALSA raw MIDI) or HID (hidraw), both a pty here that a stand-in firmware answers; then the Launcher's
// port it comes back on, in a stand-in /dev (C203_SYS, C203_DEV).

/** A pty whose other side is `answer(bytes) → bytes | null` (the firmware): {slave, got, close}. */
async function fakeFirmware(answer) {
  const py = spawn("python3", ["-I", "-c", BRIDGE], {stdio: ["pipe", "pipe", "inherit"]});
  const got = [];
  const slave = await new Promise((resolve, reject) => {
    let head = "", found = false;
    py.on("error", reject);
    py.stdout.on("data", chunk => {
      if (!found) {
        head += chunk.toString("latin1");
        const at = head.indexOf("\n");
        if (at < 0) return;
        found = true;
        resolve(head.slice(0, at));
        chunk = Buffer.from(head.slice(at + 1), "latin1");
      }
      got.push(...chunk);
      const reply = answer(Uint8Array.from(got));
      if (reply) py.stdin.write(Buffer.from(reply));
    });
  });
  return {slave, got, send: bytes => py.stdin.write(Buffer.from(bytes)), close: () => py.kill()};
}

/** A stand-in sysfs and /dev with a Cardenza running a firmware on USB (its sound card and hidraw under it). */
function fakeSystem({product = "203 Systems Cardenza", vendor = "0203", midi = null, hid = null} = {}) {
  const root = fs.mkdtempSync(path.join(dir, "sys-"));
  const sys = path.join(root, "sys"), dev = path.join(root, "dev");
  const usb = path.join(sys, "devices/usb1/1-2");
  fs.mkdirSync(path.join(usb, "1-2:1.0"), {recursive: true});
  fs.mkdirSync(path.join(usb, "1-2:1.5/0003:0203:2040.0001"), {recursive: true});
  fs.writeFileSync(path.join(usb, "idVendor"), vendor + "\n");
  fs.writeFileSync(path.join(usb, "product"), product + "\n");
  fs.mkdirSync(path.join(sys, "bus/usb/devices"), {recursive: true});
  fs.symlinkSync(usb, path.join(sys, "bus/usb/devices/1-2"));
  fs.mkdirSync(path.join(sys, "class/sound/card1"), {recursive: true});
  fs.symlinkSync(path.join(usb, "1-2:1.0"), path.join(sys, "class/sound/card1/device"));
  fs.mkdirSync(path.join(sys, "class/hidraw/hidraw3"), {recursive: true});
  fs.symlinkSync(path.join(usb, "1-2:1.5/0003:0203:2040.0001"), path.join(sys, "class/hidraw/hidraw3/device"));
  fs.mkdirSync(path.join(dev, "snd"), {recursive: true});
  if (midi) fs.symlinkSync(midi, path.join(dev, "snd/midiC1D0"));
  if (hid) fs.symlinkSync(hid, path.join(dev, "hidraw3"));
  return {sys, dev, unplug: () => fs.rmSync(path.join(sys, "bus/usb/devices/1-2"))};
}

test("restart.mjs: the firmware found in sysfs (never a Mystrix), and in macOS's ioreg", {skip: process.platform === "win32" && "a stand-in sysfs (its names have colons)"}, async () => {
  const {findFirmware} = await import("../scripts/restart.mjs");
  const s = fakeSystem({midi: "/dev/null", hid: "/dev/null"});
  const found = findFirmware({platform: "linux", sys: s.sys, dev: s.dev});
  assert.equal(found.name, "203 Systems Cardenza");
  assert.deepEqual(found.candidates, [{via: "rawmidi", path: path.join(s.dev, "snd/midiC1D0")}, {via: "hidraw", path: path.join(s.dev, "hidraw3")}]);
  const mystrix = fakeSystem({product: "203 Systems Mystrix"});
  assert.equal(findFirmware({platform: "linux", sys: mystrix.sys, dev: mystrix.dev}), null, "a Mystrix would go to its own update mode");
  const launcher = fakeSystem({vendor: "303a", product: "USB JTAG/serial debug unit"});
  assert.equal(findFirmware({platform: "linux", sys: launcher.sys, dev: launcher.dev}), null, "the Launcher is no firmware");
  const ioreg = [
    "+-o Root  <class IORegistryEntry, id 0x100000100, retain 26>",
    "  +-o AppleT8103USBXHCI@01000000  <class AppleT8103USBXHCI, id 0x1000002f2>",
    "    | +-o 203 Systems Cardenza@01100000  <class IOUSBHostDevice, id 0x100000a11>",
    "    |     {", '    |       "idProduct" = 8256', '    |       "USB Product Name" = "203 Systems Cardenza"', '    |       "idVendor" = 515', "    |     }",
    "    +-o USB JTAG/serial debug unit@01200000  <class IOUSBHostDevice, id 0x100000a12>",
    '          "idVendor" = 12346', '          "USB Product Name" = "USB JTAG/serial debug unit"',
  ].join("\n");
  assert.deepEqual(findFirmware({platform: "darwin", ioreg}), {name: "203 Systems Cardenza", usb: null, candidates: [{via: "coremidi"}]});
  assert.equal(findFirmware({platform: "darwin", ioreg: ioreg.replace("203 Systems Cardenza\"", "203 Systems Mystrix\"")}), null);
});

test("restart.mjs: the command over raw MIDI and over HID, the answer read; CoreMIDI's script compiles", {skip: !PTY && "no python3 pty"}, async () => {
  const {findFirmware, restartFirmware, COREMIDI, HAL_COMMAND} = await import("../scripts/restart.mjs");
  const midi = await fakeFirmware(got => (got.length === 4 && got[0] === 0xf0 && got[1] === 0x23 ? [0xf0, 0x24, got[2] | 0, 0xf7] : null));
  const s = fakeSystem({midi: midi.slave});
  const found = findFirmware({platform: "linux", sys: s.sys, dev: s.dev});
  const sent = await restartFirmware(found, HAL_COMMAND.launcher, {ms: 2000});
  assert.deepEqual([sent.via, sent.answered], ["rawmidi", true]);
  assert.deepEqual(midi.got, [0xf0, 0x23, 0x40, 0xf7], "SysEx F0 23 40 F7 and nothing else");
  midi.close();

  // No raw MIDI (another program has it, no permission): its HID, report 0xCB, answered 0xCB 0xC0.
  const hid = await fakeFirmware(got => (got.length >= 64 && got[0] === 0xcb ? [0xcb, got[1] | 0x80, ...new Array(62).fill(0)] : null));
  const h = fakeSystem({midi: path.join(dir, "no-such-midi"), hid: hid.slave});
  const both = findFirmware({platform: "linux", sys: h.sys, dev: h.dev});
  const viaHid = await restartFirmware(both, HAL_COMMAND.download, {ms: 2000});
  assert.deepEqual([viaHid.via, viaHid.answered], ["hidraw", true]);
  assert.deepEqual(hid.got.slice(0, 3), [0xcb, 0x42, 0], "report 0xCB, the command, padded");
  assert.equal(hid.got.length, 64);
  hid.close();

  // Neither: what was tried, for the error.
  const none = fakeSystem({midi: path.join(dir, "gone-1"), hid: path.join(dir, "gone-2")});
  await assert.rejects(restartFirmware(findFirmware({platform: "linux", sys: none.sys, dev: none.dev})), e => e.code === "unreachable" && e.tried.length === 2);
  const compiled = spawnSync("python3", ["-I", "-c", "import sys; compile(sys.stdin.read(), 'coremidi', 'exec')"], {input: COREMIDI, encoding: "utf8"});
  assert.equal(compiled.status, 0, compiled.stderr);
});

test("flash with a firmware running: restarted over its MIDI, the Launcher's port it comes back on, then written", {skip: (!PTY || process.platform !== "linux") && "no python3 pty"}, async () => {
  await withLauncher("home", async (launcherTty, port) => {
    let system = null;
    const midi = await fakeFirmware(got => {
      if (got.length === 4 && got[2] === 0x40) {
        // It answers, leaves USB, and its Launcher comes up as a serial port a moment later.
        setTimeout(() => { system.unplug(); setTimeout(() => fs.symlinkSync(launcherTty, path.join(system.dev, "ttyACM0")), 300); }, 50);
        return [0xf0, 0x24, 0x40, 0xf7];
      }
      return null;
    });
    system = fakeSystem({midi: midi.slave});
    const env = {C203_SYS: system.sys, C203_DEV: system.dev};
    const dry = await cli(["flash", "ABC234", "--dry-run", "--json"], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual([dry.json.running, dry.json.restart], ["203 Systems Cardenza", true], "a dry run says it would restart it");
    assert.deepEqual(midi.got, [], "and sends nothing");
    const r = await cli(["flash", "ABC234", "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, "installed");
    assert.equal(r.json.restarted, "203 Systems Cardenza");
    assert.equal(r.json.port, path.join(system.dev, "ttyACM0"));
    assert.deepEqual(midi.got, [0xf0, 0x23, 0x40, 0xf7]);
    assert.equal(port.state.apps.at(-1).code, "VER234", "written through the Launcher");
    midi.close();
  });
});

test("flash with a firmware that cannot be reached: what to do, and nothing else is tried", {skip: process.platform !== "linux" && "linux"}, async () => {
  const system = fakeSystem({midi: path.join(dir, "absent-midi"), hid: path.join(dir, "absent-hid")});
  const r = await cli(["flash", "ABC234", "--json"], {C203_SYS: system.sys, C203_DEV: system.dev});
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.error.code, "firmware_unreachable");
  assert.match(r.error.hint, /hold FN/);
});

// ---------------------------------------------------------------------------------------------
// 203cli log: a running firmware's console over the HAL's system channel (raw MIDI: SysEx F0 23 43 01 F7 on, the text as
// F0 24 43 … F7, F0 23 43 00 F7 off at the end; HID: report 0xCB), and a serial port's text; --until as a test.

const sysexText = text => [0xf0, 0x24, 0x43, ...Buffer.from(text, "latin1"), 0xf7];
const ends = (got, tail) => got.length >= tail.length && tail.every((b, i) => got[got.length - tail.length + i] === b);

test("log: a firmware's console over raw MIDI until a line, other MIDI skipped, the console turned off at the end", {skip: (!PTY || process.platform !== "linux") && "linux pty"}, async () => {
  let answered = false;
  const midi = await fakeFirmware(got => {
    if (answered || !ends(got, [0xf0, 0x23, 0x43, 1, 0xf7])) return null;
    answered = true;
    // Its ring first (half a line in one SysEx, a note-on between), then the line the test waits for.
    return [...sysexText("I (812) CardenzaHAL: init ok\nI (90"), 0x90, 60, 100, ...sysexText("0) app: pocket_metronome 0.1.0 ready\r\n"), ...sysexText("\x1b[0;32mI (950) app: tick\x1b[0m\n")];
  });
  const system = fakeSystem({midi: midi.slave});
  const r = await cli(["log", "--until", "metronome .* ready", "--seconds", "5", "--json"], {C203_SYS: system.sys, C203_DEV: system.dev});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.status, "matched");
  assert.equal(r.json.matched, "I (900) app: pocket_metronome 0.1.0 ready");
  assert.equal(r.json.via, "console");
  assert.match(r.json.log, /CardenzaHAL: init ok/);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(midi.got.slice(0, 5), [0xf0, 0x23, 0x43, 1, 0xf7], "the console asked for");
  assert.ok(ends(midi.got, [0xf0, 0x23, 0x43, 0, 0xf7]), "and turned off: " + midi.got);
  midi.close();
});

test("log: a crash ends a test with device_crashed and the backtrace; a line that never comes is log_timeout", {skip: (!PTY || process.platform !== "linux") && "linux pty"}, async () => {
  let answered = false;
  const midi = await fakeFirmware(got => {
    if (answered || got.length < 5) return null;
    answered = true;
    return sysexText("Guru Meditation Error: Core  0 panic'ed (LoadProhibited)\nBacktrace: 0x42001234:0x3fc9 0x42005678:0x3fca\n");
  });
  const system = fakeSystem({midi: midi.slave});
  const env = {C203_SYS: system.sys, C203_DEV: system.dev};
  const r = await cli(["log", "--until", "ready", "--seconds", "6", "--json"], env);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.error.code, "device_crashed");
  assert.match(r.error.log_tail, /Backtrace: 0x42001234/);
  midi.close();

  const quiet = await fakeFirmware(() => null);
  const silent = fakeSystem({midi: quiet.slave});
  const t = await cli(["log", "--until", "ready", "--seconds", "1", "--json"], {C203_SYS: silent.sys, C203_DEV: silent.dev});
  assert.equal(t.code, 1, t.stderr);
  assert.equal(t.error.code, "log_timeout");
  quiet.close();
});

test("log: over HID when there is no raw MIDI (report 0xCB, the console's reports 0xCB 0xC3)", {skip: (!PTY || process.platform !== "linux") && "linux pty"}, async () => {
  let answered = false;
  const report = text => { const r = new Array(64).fill(0); r[0] = 0xcb; r[1] = 0xc3; r[2] = text.length; Buffer.from(text, "latin1").forEach((b, i) => { r[3 + i] = b; }); return r; };
  const hid = await fakeFirmware(got => {
    if (answered || got.length < 64) return null;
    answered = true;
    return [...report("I (10) app: hello over hid\n"), ...report("I (20) app: ready\n")];
  });
  const system = fakeSystem({midi: path.join(dir, "no-midi-here"), hid: hid.slave});
  const r = await cli(["log", "--until", "ready", "--seconds", "5", "--json"], {C203_SYS: system.sys, C203_DEV: system.dev});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.log, /hello over hid/);
  assert.deepEqual(hid.got.slice(0, 3), [0xcb, 0x43, 1]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(hid.got.slice(-64, -61), [0xcb, 0x43, 0], "turned off");
  hid.close();
});

test("log: a serial port's text (the Launcher, a firmware without USB), lines to --out", {skip: (!PTY || process.platform !== "linux") && "linux pty"}, async () => {
  const serial = await fakeFirmware(() => null);
  const out = path.join(dir, "boot.log");
  const running = cli(["log", "--port", serial.slave, "--seconds", "2", "--out", out, "--json"]);
  setTimeout(() => serial.send(Buffer.from("ESP-ROM:esp32s3-20210327\r\nI (300) app: hello\r\n")), 600);
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.via, "serial");
  assert.match(fs.readFileSync(out, "utf8"), /I \(300\) app: hello/);
  serial.close();
});

test("log on Windows says what to use there", async () => {
  const {logSource} = await import("../scripts/devlog.mjs");
  assert.throws(() => logSource({platform: "win32"}), e => e.code === "unsupported_platform" && /cardenza_usb\.py console/.test(e.hint));
  const {sysexConsole, hidConsole} = await import("../scripts/devlog.mjs");
  const cut = sysexConsole(Uint8Array.from([...sysexText("ab"), 0xf0, 0x24, 0x43, 0x63]));
  assert.equal(cut.text, "ab");
  assert.deepEqual([...cut.rest], [0xf0, 0x24, 0x43, 0x63], "a message cut in two waits for its end");
  assert.equal(hidConsole(Uint8Array.from([0xcb, 0xc3, 2, 0x68, 0x69, ...new Array(59).fill(0)])).text, "hi");
});

// Windows: COM ports through @serialport/bindings-cpp, here its stand-in (tests/serial-standin.mjs: the demo Launcher on COM7,
// an Arduino on COM3), and a running firmware's HID through node-hid, here its stand-in (tests/hid-standin.cjs: a Cardenza
// and a Mystrix). These run everywhere; the whole command only on Windows, where flash takes that way.
const STAND_IN = path.join(ROOT, "tests/serial-standin.mjs");
const HID_STAND_IN = path.join(ROOT, "tests/hid-standin.cjs");

test("Windows: only Espressif's USB serial is offered, in number order; the firmware found in PnP (never a Mystrix)", async () => {
  const {launcherPorts} = await import("../scripts/flash.mjs");
  assert.deepEqual(launcherPorts([
    {path: "COM12", vendorId: "303a"}, {path: "COM3", vendorId: "2341", pnpId: String.raw`USB\VID_2341&PID_0043\1`},
    {path: "COM4", pnpId: String.raw`USB\VID_303A&PID_1001&MI_00\6&2B&0&0000`}, {path: "COM60", vendorId: "0203", pnpId: String.raw`USB\VID_0203&PID_1080\1`},
  ]), ["COM4", "COM12"], "the Launcher's ports, never a Mystrix or an Arduino");
  const {findFirmware} = await import("../scripts/restart.mjs");
  const lines = [String.raw`USB\VID_0203&PID_1080\5&1|203 Systems Mystrix 2`, String.raw`USB\VID_303A&PID_1001\7&2|USB JTAG/serial debug unit`,
    String.raw`USB\VID_0203&PID_2040\6&3|203 Systems Cardenza`];
  assert.deepEqual(findFirmware({platform: "win32", pnp: lines.join("\r\n")}), {name: "203 Systems Cardenza", usb: null, candidates: [{via: "hidapi"}]});
  assert.equal(findFirmware({platform: "win32", pnp: lines.slice(0, 2).join("\r\n")}), null, "a Mystrix or the Launcher is no Cardenza firmware");
});

test("Windows: the restart over node-hid goes to the HAL's system channel only (never the app channel or a Mystrix), answered", async () => {
  const {createRequire} = await import("node:module");
  const standIn = createRequire(import.meta.url)(HID_STAND_IN);
  const {systemCollections, findFirmware, restartFirmware, HAL_COMMAND} = await import("../scripts/restart.mjs");
  assert.deepEqual(systemCollections(standIn.devices()).map(d => d.path), [standIn.SYSTEM, standIn.APP], "the system channel's collection first, then the app's; no Mystrix, no keys");
  process.env.C203_HID = HID_STAND_IN;
  try {
    const found = findFirmware({platform: "win32"});
    assert.deepEqual(found, {name: "203 Systems Cardenza", usb: null, candidates: [{via: "hidapi"}]}, "node-hid's list, no PowerShell");
    const sent = await restartFirmware(found, HAL_COMMAND.launcher, {ms: 500});
    assert.deepEqual(sent, {via: "hidapi", path: "node-hid", answered: true});
    assert.deepEqual(standIn.seen.written, [{path: standIn.SYSTEM, bytes: [0xcb, 0x40, 0, 0]}], "report 0xCB, command 0x40, once");
    assert.ok(!standIn.seen.opened.includes(standIn.MYSTRIX), "a Mystrix is never opened");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(findFirmware({platform: "win32"}), null, "restarted: no firmware on HID any more");
    await assert.rejects(restartFirmware(found, HAL_COMMAND.launcher, {ms: 200}), e => e.code === "unreachable" && /no Cardenza on HID/.test(e.tried[0].error));
  } finally {
    delete process.env.C203_HID;
    standIn.device.running = true;
    delete globalThis.c203StandIn;   // the serial stand-in's COM7 is there again for the tests after this one
  }
});

test("Windows: a COM port through the binding, DTR and RTS left alone, talks to the Launcher as a tty does", async () => {
  const record = path.join(dir, "serial-unit.json");
  process.env.C203_SERIAL = STAND_IN;
  process.env.C203_SERIAL_STATE = record;
  try {
    const {serialPorts, openPort} = await import("../scripts/flash.mjs");
    const {LauncherConsole} = await import("../scripts/launcher-usb.mjs");
    assert.deepEqual(await serialPorts("win32"), ["COM7"]);
    const dev = new LauncherConsole(await openPort("COM7", "win32"));
    const launcher = await dev.find();
    assert.match(launcher, /0\.3\.0-cardenza/);
    assert.equal(await dev.flash("Win_Synth", new Uint8Array(app)), "OK flashed, rebooting");
    await dev.close();
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(seen.opened, [{path: "COM7", baudRate: 115200, hupcl: false, rtscts: false}]);
    assert.deepEqual(seen.apps.map(a => [a.name, a.size]), [["Win_Synth", app.length]]);
    await assert.rejects(openPort("COM3", "win32"), e => e.code === "port_unavailable" && /Another program/.test(e.hint));
  } finally {
    delete process.env.C203_SERIAL;
    delete process.env.C203_SERIAL_STATE;
  }
});

test("flash on Windows: over the COM port, the one there is or --port; log says what to use there", {skip: process.platform !== "win32" && "Windows"}, async () => {
  fs.writeFileSync(path.join(dir, "win.bin"), app);
  const record = path.join(dir, "serial-cli.json");
  const env = {C203_SERIAL: STAND_IN, C203_SERIAL_STATE: record, C203_PNP: ""};
  for (const args of [["--port", "COM7"], []]) {
    const r = await cli(["flash", "--bin", "win.bin", ...args, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, "installed");
    assert.equal(r.json.port, "COM7", "the Launcher's port, not the Arduino's");
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(seen.opened.map(o => [o.path, o.hupcl, o.rtscts]), [["COM7", false, false]], "nothing else opened");
    assert.equal(seen.apps.at(-1).size, app.length);
  }
  const missing = await cli(["flash", "--bin", "win.bin", "--json"], {...env, C203_SERIAL: path.join(dir, "no-such-binding.mjs")});
  assert.equal(missing.error.code, "serial_missing");
  assert.match(missing.error.hint, /npm install -g 203cli/);
  // A Cardenza running a firmware: restarted over its HID (node-hid), then written on the Launcher's port that appears.
  const hidRecord = path.join(dir, "hid-cli.json");
  const running = await cli(["flash", "--bin", "win.bin", "--json"], {C203_SERIAL: STAND_IN, C203_SERIAL_STATE: record, C203_HID: HID_STAND_IN, C203_HID_STATE: hidRecord});
  assert.equal(running.code, 0, running.stderr);
  assert.deepEqual([running.json.status, running.json.port, running.json.restarted], ["installed", "COM7", "203 Systems Cardenza"]);
  const heard = JSON.parse(fs.readFileSync(hidRecord, "utf8"));
  assert.deepEqual(heard.written.map(w => w.bytes.slice(0, 2)), [[0xcb, 0x40]], "the Launcher command, once");
  assert.equal(heard.running, false);
  const log = await cli(["log", "--json"]);
  assert.equal(log.error.code, "unsupported_platform");
  assert.match(log.error.hint, /cardenza_usb\.py console/);
});
