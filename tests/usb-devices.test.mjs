// Every 203 device on a USB cable (scripts/usb-devices.mjs, the website's usb-devices.js): a port told apart by what it
// answers (never by its ids alone), the resets esptool does, the HAL's system channel over SysEx, HID and serial lines, and
// one entry per chip whatever channels see it. Against the demo chip in every state it can be in.
// Run: node --test tests/usb-devices.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {macKey, macText, portKind, PORT_FILTERS, probePort, romReset, hardReset, classicReset, demoChip, Cable, summary, HAL, DEV_OP,
  sysexRequest, sysexAnswer, hidRequest, hidAnswer, sysLine, sysReport, identifyAnswer, commandAnswer, DevAnswer, SysexSplitter,
  infoFacts, s3Mac, romRequest, romAnswers, pack7, unpack7} from "../scripts/usb-devices.mjs";
import {demoPort} from "../scripts/launcher-usb.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAC = "70af09bceb30";
const chipOf = (opts = {}) => demoChip({mac: MAC, launcherPort: demoPort, speed: 0.2, ...opts});
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(10); }
  return null;
}

test("a MAC is one key whatever form it comes in; a port's ids say only what it might be", () => {
  for (const form of ["70:AF:09:BC:EB:30", "70AF09BCEB30", "70-af-09-bc-eb-30", "70af09bceb30", [0x70, 0xaf, 0x09, 0xbc, 0xeb, 0x30]]) assert.equal(macKey(form), MAC);
  for (const bad of ["", "70:AF", "zz:zz:zz:zz:zz:zz", "000000000000", null, undefined]) assert.equal(macKey(bad), null);
  assert.equal(macText(MAC), "70:AF:09:BC:EB:30");
  assert.equal(portKind({usbVendorId: 0x303a, usbProductId: 0x1001}), "usj");
  assert.equal(portKind({usbVendorId: 0x0203, usbProductId: 0x10c0}), "hal");
  assert.equal(portKind({usbVendorId: 0x0203, usbProductId: 0x2040}), "hal");
  assert.equal(portKind({usbVendorId: 0x0203, usbProductId: 0x10cf}), "drive");
  assert.equal(portKind({usbVendorId: 0x303a, usbProductId: 0x4002}), "drive-old");
  assert.equal(portKind({usbVendorId: 0x2341, usbProductId: 0x0043}), null);
  assert.deepEqual(PORT_FILTERS, [{usbVendorId: 0x0203}, {usbVendorId: 0x303a, usbProductId: 0x1001}, {usbVendorId: 0x303a, usbProductId: 0x4002}]);
});

test("the ROM's frames: SLIP both ways, the MAC as esptool reads it from the eFuses", () => {
  const frame = romRequest(0x0a, Uint8Array.of(0x44, 0x70, 0x00, 0x60));
  assert.deepEqual([...frame], [0xc0, 0x00, 0x0a, 0x04, 0x00, 0, 0, 0, 0, 0x44, 0x70, 0x00, 0x60, 0xc0]);
  const escaped = romRequest(0x0a, Uint8Array.of(0xc0, 0xdb, 0, 0));
  assert.deepEqual([...escaped.subarray(9, 13)], [0xdb, 0xdc, 0xdb, 0xdd]);
  const answer = romAnswers(Uint8Array.of(0xc0, 0x01, 0x0a, 0x02, 0x00, 0x30, 0xeb, 0xdb, 0xdc, 0x09, 0, 0, 0xc0));
  assert.deepEqual(answer.map(a => [a.op, a.value.toString(16)]), [[0x0a, "9c0eb30"]]);
  assert.equal(s3Mac(0x09bceb30, 0x000070af), MAC);
});

test("probePort: a HAL firmware's serial port, the Launcher (with info, with account only, too old for either), the ROM, a firmware without USB", async () => {
  // A HAL firmware with a serial port: `version`, then INFO (the MAC).
  const fw = chipOf({hal: {protocol: 4, classes: ["serial", "midi"]}});
  let p = await probePort(fw.serialPort(), {ms: 800});
  assert.deepEqual([p.kind, p.usb, p.name, p.version, p.mac, p.protocol], ["firmware", "hal", "CardenzaSynth", "0.3.0", MAC, 4]);
  fw.stop();

  // The Launcher that answers `info`.
  const l1 = chipOf({state: "launcher", launcher: {version: "0.3.4-cardenza", info: true}});
  p = await probePort(l1.serialPort(), {ms: 800});
  assert.deepEqual([p.kind, p.usb, p.version, p.mac], ["launcher", "usj", "0.3.4-cardenza", MAC]);
  l1.stop();
  // One without `info`: its `account`'s device_id is the chip's MAC.
  const l2 = chipOf({state: "launcher", launcher: {version: "0.3.3-cardenza"}});
  p = await probePort(l2.serialPort(), {ms: 800});
  assert.deepEqual([p.kind, p.version, p.mac, p.account.device_id], ["launcher", "0.3.3-cardenza", MAC, MAC]);
  l2.stop();
  // Older still (no `account`): a Launcher, its MAC unknown.
  const old = demoPort({mode: "old", id: MAC, pace: 40});
  old.getInfo = () => ({usbVendorId: 0x303a, usbProductId: 0x1001});
  p = await probePort(old, {ms: 800});
  assert.deepEqual([p.kind, p.mac ?? null], ["launcher", null]);

  // The ROM's download mode: SYNC answered, the MAC read from its eFuses.
  const rom = chipOf({state: "rom"});
  p = await probePort(rom.serialPort(), {ms: 300, syncMs: 200});
  assert.deepEqual([p.kind, p.usb, p.mac], ["rom", "usj", MAC]);
  rom.stop();

  // A firmware without USB on the chip's USB-Serial-JTAG: its log, nothing answered. Never taken for the Launcher.
  const bare = chipOf({state: "bare"});
  p = await probePort(bare.serialPort(), {ms: 300, syncMs: 100, tries: 2});
  assert.deepEqual([p.kind, p.usb], ["silent", "usj"]);
  bare.stop();
});

test("resets on the chip's USB-Serial-JTAG: esptool's usb_reset is the ROM, a hard reset the Launcher (whose countdown Esc holds)", async () => {
  const bare = chipOf({state: "bare"});
  await romReset(bare.serialPort(), {sleep: () => sleep(5)});
  assert.equal(await until(() => bare.state === "rom" && bare.serialPort()), bare.port);
  assert.equal((await probePort(bare.serialPort(), {ms: 200, syncMs: 200})).kind, "rom");
  // From the ROM, a hard reset starts the chip as from power-on: the Launcher counting down to its last app.
  await hardReset(bare.serialPort(), {sleep: () => sleep(5)});
  assert.ok(await until(() => bare.state === "launcher"));
  assert.deepEqual(bare.resets, ["rom", "run"]);
  bare.stop();
  // A HAL firmware's serial port takes esptool's ClassicReset (as a bridge sees it) for the ROM too.
  const fw = chipOf({hal: {protocol: 4, classes: ["serial"]}});
  await classicReset(fw.serialPort(), {sleep: () => sleep(5)});
  assert.ok(await until(() => fw.state === "rom"));
  assert.deepEqual(fw.sent, [HAL.download]);
  fw.stop();
});

test("the HAL's system channel: SysEx, HID and serial `sys` lines carry the same requests and answers", async () => {
  assert.deepEqual([...unpack7(pack7(Uint8Array.of(1, 200, 3, 255, 5, 6, 7, 128)))], [1, 200, 3, 255, 5, 6, 7, 128]);
  const report = hidRequest(9, DEV_OP.INFO);
  assert.equal(report.length, 64);
  assert.equal(sysLine(report), "sys 450901", "trailing zeros left out: the HAL pads a report with them");
  assert.deepEqual([...sysReport("sys 45 09 01 00")], [...report]);
  assert.equal(sysReport("sys zz"), null);

  // Over MIDI (old HAL, protocol 2: INFO over the development channel), HID and serial (protocol 4): the same INFO.
  for (const [hal, via] of [[{protocol: 2, classes: ["midi"]}, "midi"], [{protocol: 4, classes: ["hid"]}, "hid"], [{protocol: 4, classes: ["serial"]}, "serial"]]) {
    const chip = chipOf({hal});
    const id = 17;
    const collect = new DevAnswer(id);
    let done = null, identity = null;
    if (via === "midi") {
      const split = new SysexSplitter();
      chip.midiAccess().inputs.values().next().value.onmidimessage = e => {
        for (const m of split.push(e.data)) { identity = identity || identifyAnswer(m); done = done || collect.push(sysexAnswer(m)); }
      };
      const out = chip.midiAccess().outputs.values().next().value;
      out.send([0xf0, 0x23, HAL.identify, 0xf7]);
      out.send(sysexRequest(id, DEV_OP.INFO));
    } else if (via === "hid") {
      const dev = chip.hidDevices()[0];
      dev.addEventListener("inputreport", e => {
        const r = Uint8Array.of(e.reportId, ...new Uint8Array(e.data.buffer));
        identity = identity || identifyAnswer(r);
        done = done || collect.push(hidAnswer(r));
      });
      await dev.sendReport(HAL.report, Uint8Array.of(HAL.identify));
      await dev.sendReport(HAL.report, hidRequest(id, DEV_OP.INFO).subarray(1));
    } else {
      const port = chip.serialPort();
      await port.open({baudRate: 115200});
      const reader = port.readable.getReader();
      (async () => {
        let text = "";
        for (;;) {
          const {value, done: end} = await reader.read().catch(() => ({done: true}));
          if (end) break;
          text += new TextDecoder().decode(value);
          let at;
          while ((at = text.indexOf("\n")) >= 0) {
            const r = sysReport(text.slice(0, at).trim());
            text = text.slice(at + 1);
            if (r) { identity = identity || identifyAnswer(r); done = done || collect.push(hidAnswer(r)); }
          }
        }
      })();
      const w = port.writable.getWriter();
      await w.write(new TextEncoder().encode(sysLine(Uint8Array.of(HAL.identify)) + "\n" + sysLine(hidRequest(id, DEV_OP.INFO)) + "\n"));
    }
    assert.ok(await until(() => done && identity), via);
    assert.equal(identity.protocol, hal.protocol, via);
    assert.equal(done.ok, true, via);
    assert.equal(infoFacts(done.json()).mac, MAC, via);
    chip.stop();
  }
  // The restart commands answer command | 0x80 on every channel.
  assert.deepEqual([...commandAnswer(Uint8Array.of(0xf0, 0x24, 0x40, 0xf7), HAL.launcher)], []);
  assert.deepEqual([...commandAnswer(Uint8Array.of(0xcb, 0xc0, 0, 0), HAL.launcher)], [0, 0]);
  assert.equal(commandAnswer(Uint8Array.of(0xcb, 0xc2), HAL.launcher), null);
});

test("Cable: one entry a chip, whatever channels see it, merged by its MAC; the Launcher it was sent to is the same device; one action at a time", async () => {
  let now = 1000;
  const cable = new Cable({now: () => now});
  const midi = {}, hid = {}, serial = {}, usj = {}, other = {};
  // An old HAL on MIDI (protocol 1: no MAC) and its HID with INFO: two channels, then one device once the MAC is known.
  const a = cable.see({via: "midi", ref: midi, kind: "firmware", name: "CardenzaSynth"});
  const b = cable.see({via: "hid", ref: hid, kind: "firmware", mac: "70:AF:09:BC:EB:30", version: "0.3.0"});
  assert.notEqual(a, b);
  const c = cable.see({via: "midi", ref: midi, kind: "firmware", mac: "70AF09BCEB30"});
  assert.equal(c, b, "the MIDI port's entry joined the one with the same MAC");
  assert.equal(cable.list().length, 1);
  assert.deepEqual(c.channels.map(x => x.via).sort(), ["hid", "midi"]);
  assert.deepEqual([c.facts.name, c.facts.version], ["CardenzaSynth", "0.3.0"]);
  // Its serial port (MAC in its INFO): the same device.
  assert.equal(cable.see({via: "serial", ref: serial, kind: "firmware", mac: MAC}), c);
  // Sent to its Launcher: the channels go, and a Launcher without a MAC (older than `account`) that comes is this device.
  cable.expect(c, ["launcher", "rom"], 15000);
  for (const ref of [midi, hid, serial]) cable.drop(ref);
  now += 2000;
  const launcher = cable.see({via: "serial", ref: usj, kind: "launcher", launcher: "0.2.0-cardenza"});
  assert.equal(launcher, c);
  assert.equal(c.kind, "launcher");
  assert.equal(cable.list().length, 1);
  // Another chip is another device.
  const d = cable.see({via: "serial", ref: other, kind: "rom", mac: "f4:12:fa:00:11:22"});
  assert.notEqual(d, c);
  assert.equal(cable.list().length, 2);
  assert.deepEqual(summary(c).mac, "70:AF:09:BC:EB:30");
  // One action a device: asked twice meanwhile, the first one's promise.
  let runs = 0;
  const first = cable.act(c, async () => { runs++; await sleep(20); return "flashed"; });
  const second = cable.act(c, async () => { runs++; return "again"; });
  assert.equal(first, second);
  assert.equal(await second, "flashed");
  assert.equal(runs, 1);
  // A port name taken by another chip leaves the first entry.
  const moved = cable.see({via: "serial", ref: usj, kind: "rom", mac: "f4:12:fa:00:11:22"});
  assert.equal(moved, d);
  assert.equal(c.channels.length, 0);
});

test("the demo chip: a HAL that restarts plainly lets the Launcher count down to the firmware unless Esc comes", async () => {
  const chip = chipOf({hal: {protocol: 3, classes: ["midi"], restart: "plain"}});
  chip.midiAccess().outputs.values().next().value.send([0xf0, 0x23, HAL.launcher, 0xf7]);
  assert.ok(await until(() => chip.state === "launcher"));
  assert.equal(chip.home, false, "counting down");
  assert.ok(await until(() => chip.state === "firmware"), "the firmware again");
  assert.equal(chip.lostToCountdown, 1);
  chip.midiAccess().outputs.values().next().value.send([0xf0, 0x23, HAL.launcher, 0xf7]);
  assert.ok(await until(() => chip.state === "launcher"));
  await sleep(40);
  const port = chip.serialPort();
  await port.open({baudRate: 115200});
  const w = port.writable.getWriter();
  await w.write(new TextEncoder().encode("nav EscPress\n"));
  await sleep(300);
  assert.equal(chip.state, "launcher");
  assert.equal(chip.home, true, "held on its home screen");
  chip.stop();
});
