// 203cli board: a running firmware's development channel over USB (CardenzaHAL docs/usb-dev.md). The bytes (7-bit packing,
// SysEx and HID framing, answers put back together, gaps, errors, ARG, CANCEL), the screen as a PNG, the keys' names, and
// every command end to end against a stand-in firmware (tests/board-fake.mjs): in-process through the link interface the
// real backends give, and on Linux behind pseudo-terminals as ALSA raw MIDI and hidraw in a stand-in sysfs, run as 203cli
// itself. Nothing here looks for a real device.
// Run: node --test tests/board.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import fs from "node:fs";
import {EventEmitter} from "node:events";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {ROOT, NO_UPDATES} from "./fixtures.mjs";
import {FakeBoard, INFO, SETTING_SPECS, fakePixel, packFake, unpackFake} from "./board-fake.mjs";
import {pack7, unpack7, sysexRequest, hidRequest, sysexAnswer, hidAnswer, SysexReader, HidReader, Board, BoardError, OP, FLAG, openBoard,
  bridgeLink, lostPart, nodeHidLink, withoutChannel, COREMIDI_BRIDGE} from "../scripts/board-usb.mjs";
import {keyNumber, keyName, parseCombo, pressSteps, parseSteps, keyRequests, decodeScreen, rgbOf, encodePng, crc32, cardPath, size,
  boardInfo, boardPartitions, boardMemory, boardStorage, boardStatus, boardI2c, boardScreen, boardPress, boardKeys, boardCoredump,
  filesLs, filesGet, filesPut, filesRm, filesMkdir, filesMv, partitionsText, memoryText,
  boardSettings, boardSettingsGet, boardSettingsSet, boardSettingsReset, settingKey, settingValue, textWidth, table, SETTING_KEYS} from "../scripts/board.mjs";
import {CliError, EXIT} from "../scripts/guide.mjs";

const CLI = path.join(ROOT, "scripts/203cli.mjs");
const PTY = process.platform === "linux" && spawnSync("python3", ["-I", "-c", "import pty, tty"]).status === 0;
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-board-")); });
after(() => fs.rmSync(dir, {recursive: true, force: true}));

const usage = (message, extra = {}) => new CliError("usage", message, {exit: EXIT.usage, ...extra});
/** A command's context as 203cli.mjs makes it, with the stand-in firmware as the only way to the device. */
function ctxFor(fake, {args = {}, flags = {}, json = false} = {}) {
  const said = [];
  return {args, flags, json, cwd: dir, said, usage, cmd: () => "203cli board", say: t => said.push(t), note: t => said.push(t), progress: () => {},
    boardLinks: [{via: "fake", where: "fake", name: "203 Systems Cardenza", open: () => fake.link()}]};
}

// ---------------------------------------------------------------------------------------------
// The bytes

test("7-bit packing: the spec's layout, both ways, every length", () => {
  assert.deepEqual([...pack7([0x80, 0x01, 0xff])], [0b101, 0x00, 0x01, 0x7f], "bit i of the first byte: byte i's top bit");
  assert.deepEqual([...pack7(new Array(7).fill(0xff))], [0x7f, ...new Array(7).fill(0x7f)]);
  assert.deepEqual([...pack7(new Array(8).fill(0xff))], [0x7f, ...new Array(7).fill(0x7f), 0x01, 0x7f], "8 bytes: a full group and a group of one");
  assert.deepEqual([...pack7([])], []);
  for (let n = 0; n <= 70; n++) {
    const data = Uint8Array.from({length: n}, (_, i) => (i * 97 + n * 13) & 255);
    const packed = pack7(data);
    assert.equal(packed.length, n + Math.ceil(n / 7), `length ${n}`);
    assert.ok(packed.every(b => b < 0x80), "7-bit");
    assert.deepEqual([...unpack7(packed)], [...data], `round trip ${n}`);
    assert.deepEqual([...packed], packFake(data), "the same as the stand-in firmware's packing");
    assert.deepEqual([...unpackFake(packed)], [...data]);
  }
  assert.equal(pack7(new Uint8Array(52)).length, 60, "52 bytes of args: 60 packed, in the 63 the HAL collects with 45 id op");
  assert.equal(pack7(new Uint8Array(48)).length, 55, "48 bytes of payload");
});

test("framing: requests and answers byte for byte, SysEx and HID", () => {
  // GET, id 5: u32 offset 16, path "a".
  assert.deepEqual([...sysexRequest(5, OP.GET, [0x10, 0, 0, 0, 0x61])], [0xf0, 0x23, 0x45, 5, 0x31, 0x00, 0x10, 0, 0, 0, 0x61, 0xf7]);
  assert.deepEqual([...sysexRequest(127, OP.HELLO)], [0xf0, 0x23, 0x45, 127, 0x00, 0xf7]);
  assert.deepEqual([...sysexRequest(1, OP.KEYS, [29, 1, 0x80])], [0xf0, 0x23, 0x45, 1, 0x11, 0b100, 29, 1, 0, 0xf7], "a wait of 128 units: its top bit packed");
  const hid = hidRequest(7, OP.LS, Buffer.from("ab"));
  assert.equal(hid.length, 64);
  assert.deepEqual([...hid.subarray(0, 8)], [0xcb, 0x45, 7, 0x30, 2, 0x61, 0x62, 0], "report 0xCB, 0x45, id, op, length, args");
  assert.ok(hid.subarray(7).every(b => b === 0));
  assert.throws(() => hidRequest(1, OP.LS, new Uint8Array(53)), RangeError);

  const answer = sysexAnswer(Uint8Array.from([0xf0, 0x24, 0x45, 9, 0x7f, 0x01, FLAG.LAST, ...pack7([0xc0, 0x01]), 0xf7]));
  assert.deepEqual({...answer, payload: [...answer.payload]}, {id: 9, seq: 255, flags: FLAG.LAST, payload: [0xc0, 0x01]}, "seq: low 7 bits, then the next 7");
  assert.equal(sysexAnswer(Uint8Array.from([0xf0, 0x24, 0x43, 0x41, 0xf7])), null, "console text is not an answer");
  const report = new Uint8Array(64);
  report.set([0xcb, 0xc5, 3, 0x7f, 0x7f, FLAG.LAST | FLAG.ERROR, 3, 0x61, 0x62, 0x63, 0x64]);
  const parsed = hidAnswer(report);
  assert.deepEqual({...parsed, payload: [...parsed.payload]}, {id: 3, seq: 16383, flags: 3, payload: [0x61, 0x62, 0x63]}, "length says how many");
  assert.equal(hidAnswer(Uint8Array.from([0xcb, 0xc3, 2, 0x68, 0x69, ...new Array(59).fill(0)])), null);
});

test("readers: SysEx out of a MIDI stream (notes, clocks inside, cut anywhere); HID reports (another report ID passed over)", () => {
  const r = new SysexReader();
  const stream = [0x90, 60, 100, 0xf0, 0x24, 0xf8, 0x45, 1, 0, 0, 1, 0xf7, 0xb0, 7, 100, 0xf0, 0x24, 0x45, 0x90, 0xf0, 0x24, 0x45, 2, 0, 0, 1, 0xf7];
  const got = [];
  for (let i = 0; i < stream.length; i += 2) got.push(...r.push(stream.slice(i, i + 2)));
  assert.deepEqual(got.map(m => [...m]), [[0xf0, 0x24, 0x45, 1, 0, 0, 1, 0xf7], [0xf0, 0x24, 0x45, 2, 0, 0, 1, 0xf7]], "a status byte inside cuts that one short");
  const h = new HidReader();
  const system = new Uint8Array(64);
  system.set([0xcb, 0xc5, 1, 0, 0, 1, 0]);
  assert.deepEqual(h.push(Uint8Array.of(0x01, 0, 0, 4, 0, 0, 0, 0, 0)), [], "a keyboard report (its own read) is passed over");
  assert.equal(h.push(system.subarray(0, 30)).length, 0);
  assert.equal(h.push(concat2(system.subarray(30), system)).length, 2, "a stream cut anywhere");
});
const concat2 = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** A Board on a link the test drives: what it sent, and answers given by hand. */
function stubBoard(kind = "sysex", options) {
  const sent = [];
  let feed = null;
  const board = new Board({kind, via: "stub", where: "stub", start(onBytes) { feed = onBytes; }, async send(bytes) { sent.push([...bytes]); }, async close() {}}, options);
  const msg = (id, seq, flags, payload = []) => feed(Uint8Array.from([0xf0, 0x24, 0x45, id, seq & 0x7f, (seq >> 7) & 0x7f, flags, ...packFake(payload), 0xf7]));
  return {board, sent, feed: bytes => feed(Uint8Array.from(bytes)), msg};
}

test("answers put back together: many messages, seq wrapping past 16383, other ids and traffic between", async () => {
  const {board, sent, msg, feed} = stubBoard();
  const {id, done} = await board.start(OP.COREDUMP_READ);
  assert.deepEqual(sent[0], [0xf0, 0x23, 0x45, id, 0x21, 0xf7]);
  const n = 16384 + 3;
  for (let seq = 0; seq < n; seq++) {
    if (seq === 100) { msg((id + 1) & 0x7f, 0, FLAG.LAST, [1]); feed([0x90, 1, 2, 0xf0, 0x24, 0x43, 0x41, 0xf7]); }
    msg(id, seq % 16384, seq === n - 1 ? FLAG.LAST : 0, [seq & 255, (seq >> 8) & 255]);
  }
  const bytes = await done;
  assert.equal(bytes.length, n * 2);
  assert.deepEqual([bytes[2 * 16384], bytes[2 * 16384 + 1]], [0, 64], "message 16384 came as seq 0, in its place");
});

test("a gap, an ERROR, a timeout, a busy firmware, ARG for long args, CANCEL", async () => {
  {
    const {board, msg} = stubBoard();
    const {id, done} = await board.start(OP.INFO);
    msg(id, 0, 0, [0x7b]);
    msg(id, 2, FLAG.LAST, [0x7d]);
    await assert.rejects(done, e => e instanceof BoardError && e.code === "gap");
  }
  {
    const {board, msg} = stubBoard();
    const {id, done} = await board.start(OP.SCREEN);
    msg(id, 0, FLAG.ERROR | FLAG.LAST, [...Buffer.from("no framebuffer")]);
    await assert.rejects(done, e => e.code === "device" && e.reason === "no framebuffer");
  }
  assert.ok(lostPart(new BoardError("timeout", "x", {got: 3})), "an answer that stopped before its end is asked again");
  assert.ok(!lostPart(new BoardError("timeout", "x", {got: 0})), "one that never started is not");
  {
    const {board} = stubBoard("sysex", {timeout: 60});
    const started = Date.now();
    await assert.rejects(board.request(OP.INFO), e => e.code === "timeout");
    assert.ok(Date.now() - started < 1000);
  }
  {
    // A gap or a full queue: asked again (a gap after CANCEL).
    const {board, sent, msg} = stubBoard();
    const asked = board.ask(OP.STATUS);
    await new Promise(r => setImmediate(r));
    const first = sent.at(-1)[3];
    msg(first, 0, FLAG.ERROR | FLAG.LAST, [...Buffer.from("busy")]);
    await new Promise(r => setTimeout(r, 300));
    const second = sent.at(-1)[3];
    assert.notEqual(second, first, "a new id");
    msg(second, 1, FLAG.LAST, [1]);
    await new Promise(r => setTimeout(r, 150));
    const cancel = sent.find(s => s[4] === OP.CANCEL);
    assert.ok(cancel, "CANCEL after a gap");
    const third = sent.at(-1)[3];
    msg(third, 0, FLAG.LAST, [0x7b, 0x7d]);
    assert.deepEqual([...await asked], [0x7b, 0x7d]);
  }
  {
    // 120 bytes of args: ARG 52, ARG 52, then the request with 16, all with the same id.
    const {board, sent, msg} = stubBoard();
    const args = Uint8Array.from({length: 120}, (_, i) => i + 100);
    const {id, done} = await board.start(OP.LS, args);
    assert.deepEqual(sent.map(s => [s[3], s[4]]), [[id, OP.ARG], [id, OP.ARG], [id, OP.LS]]);
    assert.deepEqual(sent.flatMap(s => [...unpackFake(s.slice(5, -1))]), [...args]);
    assert.equal(unpackFake(sent[0].slice(5, -1)).length, 52);
    msg(id, 0, FLAG.LAST, [0x7b, 0x7d]);
    await done;
    const hid = stubBoard("hid");
    const unanswered = await hid.board.start(OP.LS, args);
    unanswered.done.catch(() => {});
    assert.deepEqual(hid.sent.map(s => [s[3], s[4]]), [[OP.ARG, 52], [OP.ARG, 52], [OP.LS, 16]], "HID: the length byte");
    await hid.board.close();
  }
  {
    const {board, sent} = stubBoard();
    const {id, done} = await board.start(OP.GET, [0, 0, 0, 0, 0x61]);
    done.catch(() => {});
    await board.cancel({ms: 50});
    assert.deepEqual(sent.at(-1), [0xf0, 0x23, 0x45, id, 0x7f, 0xf7]);
    await assert.rejects(done, e => e.code === "cancelled");
  }
});

// ---------------------------------------------------------------------------------------------
// The screen, the keys, paths

function readPng(bytes) {
  const b = Buffer.from(bytes);
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at), type = b.toString("latin1", at + 4, at + 8), data = b.subarray(at + 8, at + 8 + length);
    const crc = b.readUInt32BE(at + 8 + length);
    assert.equal(crc32(b.subarray(at + 4, at + 8 + length)), crc, `${type}: its CRC`);
    if (zlib.crc32) assert.equal(zlib.crc32(b.subarray(at + 4, at + 8 + length)), crc, `${type}: zlib's CRC agrees`);
    chunks.push({type, data});
    at += 12 + length;
  }
  assert.deepEqual(chunks.map(c => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], "8-bit RGB, no interlace");
  const raw = zlib.inflateSync(chunks[1].data);
  assert.equal(raw.length, (width * 3 + 1) * height);
  const pixel = (x, y) => { const at = y * (width * 3 + 1) + 1 + x * 3; assert.equal(raw[y * (width * 3 + 1)], 0); return [raw[at], raw[at + 1], raw[at + 2]]; };
  return {width, height, pixel};
}

test("the screen: raw and run-length RGB565 decoded, and a PNG that decodes (CRCs, zlib)", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "CRC-32's check value");
  const header = (encoding, w = 3, h = 2) => [0x53, 1, w, 0, h, 0, encoding, 1];
  const px = [0xf800, 0x07e0, 0x001f, 0xffff, 0x0000, 0x8410];
  const raw = decodeScreen(Uint8Array.from([...header(0), ...px.flatMap(p => [p & 255, p >> 8])]));
  assert.deepEqual([...raw.pixels], px);
  assert.equal(raw.source, 1);
  const rle = decodeScreen(Uint8Array.from([...header(1), 2, 0x00, 0xf8, 3, 0xe0, 0x07, 1, 0x1f, 0x00]));
  assert.deepEqual([...rle.pixels], [0xf800, 0xf800, 0x07e0, 0x07e0, 0x07e0, 0x001f], "runs across a row's end");
  assert.throws(() => decodeScreen(Uint8Array.from([...header(1), 9, 0, 0])), e => e.code === "bad_answer", "too many pixels");
  assert.throws(() => decodeScreen(Uint8Array.from([...header(0), 1, 2])), e => e.code === "bad_answer", "too few");
  assert.throws(() => decodeScreen(Uint8Array.from([0x53, 2, 1, 0, 1, 0, 0, 0, 0, 0])), /newer/);
  assert.deepEqual([...rgbOf(Uint16Array.of(0xf800, 0x07e0, 0x001f, 0xffff, 0x8410))], [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 132, 130, 132]);
  const png = readPng(encodePng(3, 2, rgbOf(raw.pixels)));
  assert.deepEqual([png.width, png.height], [3, 2]);
  assert.deepEqual(png.pixel(0, 0), [255, 0, 0]);
  assert.deepEqual(png.pixel(2, 1), [132, 130, 132]);
});

test("keys: the caps' names to the HAL's numbers (y * 14 + x + 1), the arrows, combos, steps cut into requests", () => {
  const want = {esc: 1, del: 14, tab: 15, fn: 29, ok: 42, enter: 42, ctrl: 43, space: 56, home: 57, "1": 2, "0": 11, "-": 12, "=": 13, q: 16, "\\": 28, shift: 30,
    a: 31, ";": 40, "'": 41, opt: 44, alt: 45, z: 46, m: 52, ",": 53, ".": 54, "/": 55, up: 40, down: 54, left: 53, right: 55, ESC: 1, Fn: 29, "12": 12, "57": 57, k5: 5, K1: 1, "←": 14, "▲": 40};
  for (const [name, n] of Object.entries(want)) assert.equal(keyNumber(name), n, name);
  for (const bad of ["x1", "58", "k0", "k58", "", "plus", "F"]) assert.equal(keyNumber(bad), bad === "F" ? 34 : null, bad);
  for (let n = 1; n <= 57; n++) assert.equal(keyNumber(keyName(n)), n, `name of ${n}`);
  assert.deepEqual(parseCombo("fn+s"), [29, 32]);
  assert.throws(() => parseCombo("fn+"), e => e.code === "usage");
  assert.throws(() => parseCombo("fn+fn"), /twice/);
  assert.deepEqual(pressSteps([[29, 32], [42]], {hold: 120, gap: 80}), [
    {key: 29, down: true, wait: 30}, {key: 32, down: true, wait: 120}, {key: 32, down: false, wait: 30}, {key: 29, down: false, wait: 80},
    {key: 42, down: true, wait: 120}, {key: 42, down: false, wait: 0}]);
  assert.deepEqual(parseSteps(["fn:down", "s:d", "200", "s:up", "fn:u"], usage), [
    {key: 29, down: true, wait: 0}, {key: 32, down: true, wait: 200}, {key: 32, down: false, wait: 0}, {key: 29, down: false, wait: 0}]);
  assert.throws(() => parseSteps(["100"], usage), /comes after a step/);
  assert.throws(() => parseSteps(["fn"], usage), /not a step/);
  const many = pressSteps(Array.from({length: 20}, (_, i) => [i + 1]));
  const requests = keyRequests(many);
  assert.ok(requests.every(r => r.args.length <= 52 && r.args.length % 3 === 0), "at most 17 steps a request");
  assert.equal(requests.reduce((n, r) => n + r.args.length / 3, 0), 40);
  const long = keyRequests([{key: 1, down: true, wait: 4000}, {key: 1, down: false, wait: 0}]);
  assert.deepEqual(long.map(r => [[...r.args], r.after]), [[[1, 1, 255], 1450], [[1, 0, 0], 0]], "a hold longer than 2.55 s: the rest waited for here");
});

test("paths on the card", () => {
  assert.equal(cardPath("/sdcard/Apps/CardenzaSynth/Projects/", usage), "Apps/CardenzaSynth/Projects");
  assert.equal(cardPath("//a//b", usage), "a/b");
  assert.equal(cardPath("", usage), "");
  assert.equal(cardPath("sdcard/x", usage), "sdcard/x", "only a leading /sdcard/ is the mount point");
  assert.throws(() => cardPath("a/../b", usage), /no \. or \.\./);
  assert.throws(() => cardPath("/", usage, {root: false}), /root/);
  assert.throws(() => cardPath("x".repeat(256), usage), /255/);
  assert.equal(size(1834208), "1.75 MB");
  assert.equal(size(20480), "20 KB");
});

// ---------------------------------------------------------------------------------------------
// Every command against the stand-in firmware, in-process

test("info, partitions, memory, storage, status, i2c: the firmware's JSON, and words for people", async () => {
  const fake = new FakeBoard();
  const info = await boardInfo(ctxFor(fake));
  assert.deepEqual(info.json, INFO);
  assert.match(info.text, /^CardenzaSynth 0\.2\.0 \(V6QK28\) on Cardenza/);
  assert.match(info.text, /CardenzaHAL  acbc6bd/);
  assert.match(info.text, /did not start: ir/);
  const parts = await boardPartitions(ctxFor(fake));
  assert.equal(parts.json.running, "ota_0");
  assert.match(parts.text, /\* +ota_0 +app +ota_0 +0x170000 +0x400000 +4 MB +image 1\.75 MB \(44 %\), running/);
  assert.match(parts.text, /nvs .* NVS: 211 of 630 entries used \(33 %\), 5 pages/);
  assert.match(parts.text, /7 MB free after the last partition/);
  const memory = await boardMemory(ctxFor(fake, {flags: {window: 2000}}));
  assert.equal(fake.window, 200, "--window in 10 ms units");
  const order = memory.text.split("\n").filter(l => /^(IDLE0|audio|main|tusb) /.test(l)).map(l => l.split(/\s+/)[0]);
  assert.deepEqual(order, ["IDLE0", "audio", "main", "tusb"], "tasks by CPU");
  assert.match(memory.text, /tusb +both/);
  assert.match(memoryText({...memory.json, tasks: null}), /CONFIG_FREERTOS_USE_TRACE_FACILITY/);
  assert.match(memoryText({...memory.json, tasks: memory.json.tasks.map(t => ({...t, cpu: null}))}), /CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS/);
  await assert.rejects(boardMemory(ctxFor(fake, {flags: {window: 5}})), e => e.code === "usage");
  assert.match((await boardStorage(ctxFor(fake))).text, /SD card mounted at \/sdcard/);
  assert.match((await boardStatus(ctxFor(fake))).text, /presence +connected/);
  assert.match((await boardI2c(ctxFor(fake))).text, /0x08 +ES8156 \(codec\)/);
  assert.deepEqual(fake.violations, []);
  assert.equal(partitionsText({partitions: []}).split("\n").length, 1);
});

test("screen: the firmware's frame as a PNG, run-length and raw, over SysEx and HID; no framebuffer is said plainly", async () => {
  for (const [kind, rle] of [["sysex", true], ["hid", false]]) {
    const fake = new FakeBoard({kind, rle});
    const out = path.join(dir, `shot-${kind}.png`);
    const r = await boardScreen(ctxFor(fake, {flags: {out}}));
    assert.equal(r.text, out);
    assert.equal(r.json.encoding, rle ? "rle" : "raw");
    const png = readPng(fs.readFileSync(out));
    assert.deepEqual([png.width, png.height], [240, 135]);
    const expect = (x, y) => { const p = fakePixel(x, y); return [...rgbOf(Uint16Array.of(p))]; };
    for (const [x, y] of [[0, 0], [239, 134], [10, 10], [70, 50], [130, 100], [200, 3]]) assert.deepEqual(png.pixel(x, y), expect(x, y), `${kind} ${x},${y}`);
    assert.deepEqual(fake.violations, []);
  }
  const blind = new FakeBoard({framebuffer: false});
  await assert.rejects(boardScreen(ctxFor(blind, {flags: {out: path.join(dir, "none.png")}})), e => e.code === "board_refused" && /GetPanel/.test(e.hint));
});

test("press and keys: steps as the HAL takes them, combos, long sequences in several requests", async () => {
  const fake = new FakeBoard();
  const r = await boardPress(ctxFor(fake, {args: {KEY: ["down", "fn+s", "home"]}, flags: {hold: 50, gap: 20}, json: true}));
  assert.deepEqual(r.json.pressed, ["down", "fn+s", "home"]);
  assert.deepEqual(r.json.keys, [[54], [29, 32], [57]]);
  assert.deepEqual(fake.keyLog.map(s => [s.key, s.down, s.wait]), [[54, true, 50], [54, false, 20], [29, true, 30], [32, true, 50], [32, false, 30], [29, false, 20],
    [57, true, 50], [57, false, 0]]);
  assert.deepEqual(r.json.down, []);
  fake.keyLog = [];
  const keys = Array.from({length: 30}, (_, i) => String(i + 10));
  await boardPress(ctxFor(fake, {args: {KEY: keys}, flags: {hold: 0, gap: 0}}));
  assert.equal(fake.keyLog.length, 60);
  assert.ok(fake.requests.filter(q => q.op === OP.KEYS).length >= 5);
  const held = await boardKeys(ctxFor(fake, {args: {STEP: ["ctrl:down", "10"]}}));
  assert.match(held.text, /Down from the computer: ctrl/);
  assert.deepEqual((await boardKeys(ctxFor(fake, {args: {STEP: []}}))).json.down, [43], "none: what is held");
  await assert.rejects(boardPress(ctxFor(fake, {args: {KEY: ["nope"]}})), e => e.code === "usage" && /Unknown key "nope"/.test(e.message));
  assert.deepEqual(fake.violations, []);
});

test("files: ls, put and get (a size that is no multiple of 48, zeros at the end, a long path through ARG), rm, mkdir, mv", async () => {
  for (const kind of ["sysex", "hid"]) {
    const fake = new FakeBoard({kind, files: {"CardenzaSynth/Projects/DEMO.ccproj": Buffer.from("FORMAT 7\n")}});
    const listed = await filesLs(ctxFor(fake, {args: {PATH: "/sdcard/CardenzaSynth"}}));
    assert.deepEqual(listed.json.entries.map(e => e.name), ["Projects"]);
    assert.match(listed.text, /\/CardenzaSynth: 1 folder, 0 files\n {2}Projects\//);
    const data = Buffer.concat([Buffer.from(Array.from({length: 5000}, (_, i) => (i * 7 + 3) & 255)), Buffer.alloc(13)]);
    const local = path.join(dir, `take-${kind}.wav`);
    fs.writeFileSync(local, data);
    await filesMkdir(ctxFor(fake, {args: {PATH: "CardenzaSynth/Samples"}}));
    const deep = "CardenzaSynth/Samples/" + "a-really-long-folder-name-for-a-test/".repeat(4);
    for (let i = 1; i <= 4; i++) await filesMkdir(ctxFor(fake, {args: {PATH: deep.split("/").slice(0, 2 + i).join("/")}}));
    const put = await filesPut(ctxFor(fake, {args: {LOCAL: local, PATH: deep}, json: true}));
    const remote = deep + `take-${kind}.wav`;
    assert.equal(put.json.path, remote);
    assert.deepEqual(Buffer.from(fake.files.get(remote)), data, `${kind}: written whole`);
    assert.ok(fake.requests.some(q => q.op === OP.ARG), "a path longer than a request goes ahead in ARG");
    const back = path.join(dir, `back-${kind}.wav`);
    const got = await filesGet(ctxFor(fake, {args: {PATH: remote, LOCAL: back}}));
    assert.equal(got.json.bytes, data.length);
    assert.deepEqual(fs.readFileSync(back), data, `${kind}: read back whole`);
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes(".part-")), [], "no part file left");
    const into = await filesPut(ctxFor(fake, {args: {LOCAL: local, PATH: "/CardenzaSynth/Samples"}, json: true}));
    assert.equal(into.json.path, `CardenzaSynth/Samples/take-${kind}.wav`, "a folder without its / takes the file in");
    fake.files.delete(into.json.path);
    await filesMv(ctxFor(fake, {args: {FROM: remote, TO: "CardenzaSynth/Samples/kick.wav"}}));
    assert.ok(fake.files.has("CardenzaSynth/Samples/kick.wav"));
    await filesRm(ctxFor(fake, {args: {PATH: "CardenzaSynth/Samples/kick.wav"}}));
    assert.equal(fake.files.size, 1);
    await assert.rejects(filesRm(ctxFor(fake, {args: {PATH: "CardenzaSynth/Projects"}})), e => e.code === "board_refused" && e.data.reason === "not empty");
    await assert.rejects(filesGet(ctxFor(fake, {args: {PATH: "nothing.txt"}})), e => e.code === "board_refused" && /files ls/.test(e.hint));
    assert.deepEqual(fake.violations, [], kind);
  }
});

test("files get: part of an answer lost is asked for again from where it stopped; a failed upload is aborted", async () => {
  const data = Buffer.from(Array.from({length: 3000}, (_, i) => (i * 13) & 255));
  const fake = new FakeBoard({files: {"big.bin": data}});
  fake.dropOnce = {op: OP.GET, seq: 20};
  const out = path.join(dir, "big.bin");
  await filesGet(ctxFor(fake, {args: {PATH: "big.bin", LOCAL: out}}));
  assert.deepEqual(fs.readFileSync(out), data);
  const gets = fake.requests.filter(q => q.op === OP.GET);
  assert.equal(gets.length, 2, "asked again");
  assert.equal(Buffer.from(gets[1].args).readUInt32LE(0), 20 * 48 - 4, "from the byte it stopped at");
  assert.ok(fake.requests.some(q => q.op === OP.CANCEL), "the rest of the broken answer cancelled");

  const full = new FakeBoard();
  const local = path.join(dir, "up.bin");
  fs.writeFileSync(local, data);
  await assert.rejects(filesPut(ctxFor(full, {args: {LOCAL: local, PATH: "no-such-folder/up.bin"}})), e => e.code === "board_refused");
  const flaky = new FakeBoard();
  const real = flaky.answer.bind(flaky);
  let chunks = 0;
  flaky.answer = async job => (job.op === OP.PUT_DATA && ++chunks === 10 ? {error: "card full"} : real(job));
  await assert.rejects(filesPut(ctxFor(flaky, {args: {LOCAL: local}})), e => e.code === "board_refused" && /card full/.test(e.message));
  assert.equal(flaky.aborted, 1, "PUT_ABORT");
  assert.equal(flaky.files.size, 0);
});

test("coredump: the summary, saved, decoded with addr2line from PATH, erased", {skip: process.platform === "win32" && "a shell-script addr2line"}, async () => {
  const fake = new FakeBoard();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, "xtensa-esp32s3-elf-addr2line"), "#!/bin/sh\nshift 3\nfor a in \"$@\"; do echo \"$a: app_main at main.c:12\"; done\n", {mode: 0o755});
  const elf = path.join(dir, "app.elf");
  fs.writeFileSync(elf, "ELF");
  const dump = path.join(dir, "dump.bin");
  const PATH = process.env.PATH;
  process.env.PATH = bin + path.delimiter + PATH;
  try {
    const r = await boardCoredump(ctxFor(fake, {flags: {out: dump, elf, erase: true}, json: true}));
    assert.equal(r.json.saved, dump);
    assert.deepEqual(r.json.decoded, ["0x42012345: app_main at main.c:12", "0x42013456: app_main at main.c:12"]);
    assert.equal(r.json.erased, true);
    assert.equal(fs.readFileSync(dump).length, 3000);
    assert.equal(fake.coredump, null);
  } finally { process.env.PATH = PATH; }
  const none = await boardCoredump(ctxFor(fake, {flags: {out: path.join(dir, "none.bin")}}));
  assert.match(none.text, /No core dump in partition coredump/);
  assert.equal(none.json.saved, null);
});

test("a firmware too old for the channel, one built without it, one that does not answer, one that is busy", async () => {
  await assert.rejects(boardInfo(ctxFor(new FakeBoard({protocol: 1}))), e => e.code === "hal_too_old" && /protocol is 1/.test(e.message) && /CardenzaHAL/.test(e.hint));
  await assert.rejects(boardInfo(ctxFor(new FakeBoard({hello: false}))), e => e.code === "hal_too_old" && /HELLO/.test(e.message));
  await assert.rejects(boardInfo(ctxFor(new FakeBoard({off: true}))), e => e.code === "dev_channel_off");
  const silent = new FakeBoard();
  silent.receive = () => {};
  await assert.rejects(boardInfo(ctxFor(silent)), e => e.code === "hal_too_old" && /IDENTIFY/.test(e.message));
  const unopened = {via: "rawmidi", where: "/dev/snd/midiC9D0", open: () => { throw Object.assign(new Error("busy"), {code: "EBUSY"}); }};
  await assert.rejects(openBoard({links: [unopened]}), e => e.code === "firmware_unreachable" && /EBUSY/.test(e.message));
  // The second way answers when the first opens but stays silent (its MIDI held elsewhere: its HID).
  const fake = new FakeBoard({kind: "hid"});
  const mute = {via: "rawmidi", where: "x", open: () => ({kind: "sysex", start() {}, async send() {}, async close() {}})};
  const board = await openBoard({links: [mute, {via: "hidraw", where: "y", open: () => fake.link()}]});
  assert.equal(board.via, "fake");
  await board.close();
  const busy = new FakeBoard();
  const real = busy.answer.bind(busy);
  busy.answer = async job => (job.op === OP.INFO ? {error: "busy"} : real(job));
  await assert.rejects(boardInfo(ctxFor(busy)), e => e.code === "board_busy" && e.exit === EXIT.later);
});

// ---------------------------------------------------------------------------------------------
// The board's settings (CardenzaHAL docs/SETTINGS.md)

test("settings: keys and values as typed (aliases, units, languages by tag or name), checked before the device is asked", () => {
  assert.deepEqual(SETTING_KEYS, SETTING_SPECS.map(s => s.key), "the device's order");
  assert.equal(settingKey("Volume-Limit", usage), "volume_limit");
  assert.equal(settingKey("lang", usage), "language");
  assert.equal(settingKey("key_lights", usage), "key_brightness");
  assert.throws(() => settingKey("loudness", usage), e => e.code === "usage" && e.field === "KEY" && /volume, volume_limit, screen_brightness, key_brightness, mic_gain, language/.test(e.message));
  assert.throws(() => settingKey("volum", usage, {fix: guess => `203cli board settings get ${guess}`}), e => /Did you mean volume\?/.test(e.hint) && e.next[0] === "203cli board settings get volume");
  assert.equal(settingValue("volume", "50", usage), 50);
  assert.equal(settingValue("mic_gain", "-6", usage), -6);
  assert.equal(settingValue("mic_gain", "+6dB", usage), 6);
  assert.equal(settingValue("screen_brightness", "80 %", usage), 80);
  assert.equal(settingValue("volume", "150", usage), 150, "out of range: the device's to clamp");
  for (const bad of ["loud", "5.5", "6dB", "", "99999999999"]) assert.throws(() => settingValue("volume", bad, usage), e => e.code === "usage" && e.field === "VALUE", bad);
  for (const [typed, code] of [["en", 0], ["English", 0], ["zh", 1], ["ZH-HANS", 1], ["zh_Hans", 1], ["简体中文", 1], ["ja", 3], ["日本語", 3], ["id", 4], ["Bahasa Indonesia", 4],
    ["vi", 5], ["Tiếng Việt", 5], ["3", 3], ["7", 7]]) assert.equal(settingValue("language", typed, usage), code, typed);
  assert.throws(() => settingValue("language", "klingon", usage), e => e.code === "usage" && /en \(English\), zh-Hans \(简体中文\), ja \(日本語\), id \(Bahasa Indonesia\), vi \(Tiếng Việt\)/.test(e.message));
  assert.equal(textWidth("简体中文 (zh-Hans)"), 18);
  assert.equal(textWidth("Tiếng Việt"), 10);
  assert.deepEqual(table([["a", "简体中文", "x"], ["bb", "en", "y"]]).split("\n").map(line => textWidth(line.slice(0, line.lastIndexOf(" ") + 1))), [14, 14], "columns as wide as a terminal shows them");
});

test("settings: every one, one, set (the device's clamp said, the limit lowering the volume, a language by name), reset (asked first, the language stays), over SysEx and HID", async () => {
  for (const kind of ["sysex", "hid"]) {
    const fake = new FakeBoard({kind, protocol: 3, settings: {volume: 64, volume_limit: 90, screen_brightness: 80, mic_gain: 6, language: 1}});
    const all = await boardSettings(ctxFor(fake));
    assert.deepEqual(all.json, {settings: SETTING_SPECS.map(s => fake.setting(s)), saved: true}, "the device's JSON");
    const rows = all.text.split("\n");
    assert.match(rows[0], /^setting +value +range +default +stored$/);
    assert.match(all.text, /\nvolume +64 +0-90 \(at most volume_limit\) +70 +yes\n/);
    assert.match(all.text, /\nscreen_brightness +80 % +10-100 % +100 % +yes\n/);
    assert.match(all.text, /\nkey_brightness +15 +0-15 +15 +no\n/);
    assert.match(all.text, /\nmic_gain +\+6 dB +-12 to \+36 dB +0 dB +yes\n/);
    assert.match(all.text, /\nlanguage +简体中文 \(zh-Hans\) +en zh-Hans ja id vi +English \(en\) +yes\n/);
    const column = line => textWidth(line.slice(0, line.search(/ (0-90|en zh-Hans)/) + 1));
    assert.equal(column(rows.find(l => l.startsWith("volume "))), column(rows.find(l => l.startsWith("language "))), "the language's name does not shift its row");
    assert.match(all.text, /HOME menu \(Settings\)/);
    assert.doesNotMatch(all.text, /Not in the board's flash yet/, "saved");

    const language = await boardSettingsGet(ctxFor(fake, {args: {KEY: "lang"}}));
    assert.deepEqual(language.json, {setting: fake.setting(SETTING_SPECS[5]), saved: true});
    assert.match(language.text, /^language  简体中文 \(zh-Hans\)\n  choices  English \(en, 0\), 简体中文 \(zh-Hans, 1\), 日本語 \(ja, 3\), Bahasa Indonesia \(id, 4\), Tiếng Việt \(vi, 5\)\n  default  English \(en\)/);
    assert.match((await boardSettingsGet(ctxFor(fake, {args: {KEY: "volume"}}))).text, /^volume  64\n  range    0-90 \(at most volume_limit\); the HOME menu steps by 2\n  default  70\n  stored   yes/);
    assert.equal(fake.requests.at(-1).op, OP.SETTING_GET);
    assert.deepEqual(fake.requests.at(-1).args, [...Buffer.from("volume")], "the key, nothing else");

    // Clamped: the volume under its limit.
    const loud = await boardSettingsSet(ctxFor(fake, {args: {KEY: "volume", VALUE: "120"}}));
    assert.deepEqual(fake.requests.at(-1).args, [120, 0, 0, 0, ...Buffer.from("volume")], "i32 little-endian, then the key");
    assert.equal(loud.json.asked, 120);
    assert.equal(loud.json.setting.value, 90);
    assert.equal(loud.json.clamped, true);
    assert.deepEqual(loud.json.changed, ["volume"]);
    assert.deepEqual(loud.json.changes, [{key: "volume", from: 64, to: 90}]);
    assert.equal(loud.json.saved, false);
    assert.match(loud.text, /^volume 64 → 90\.\nThe device kept it in its range 0-90 \(the most is volume_limit, 90\): asked 120, set 90\.\nNot in the board's flash yet/);
    // The limit lowered: the volume with it.
    const limit = await boardSettingsSet(ctxFor(fake, {args: {KEY: "volume-limit", VALUE: "60"}}));
    assert.deepEqual(limit.json.changed, ["volume", "volume_limit"]);
    assert.deepEqual(limit.json.changes, [{key: "volume", from: 90, to: 60}, {key: "volume_limit", from: 90, to: 60}]);
    assert.equal(limit.json.clamped, false);
    assert.match(limit.text, /^volume_limit 90 → 60\.\nAlso changed: volume 90 → 60 \(the volume stays under its limit\)\./);
    assert.equal(fake.values.volume, 60);
    // Negative, signed; a language by name; one the board does not have; the same again.
    const gain = await boardSettingsSet(ctxFor(fake, {args: {KEY: "mic_gain", VALUE: "-6"}}));
    assert.deepEqual(fake.requests.at(-1).args.slice(0, 4), [0xfa, 0xff, 0xff, 0xff]);
    assert.match(gain.text, /^mic_gain \+6 dB → -6 dB\./);
    const ja = await boardSettingsSet(ctxFor(fake, {args: {KEY: "language", VALUE: "日本語"}}));
    assert.deepEqual(fake.requests.at(-1).args, [3, 0, 0, 0, ...Buffer.from("language")]);
    assert.equal(ja.json.setting.value, 3);
    assert.match(ja.text, /^language 简体中文 \(zh-Hans\) → 日本語 \(ja\)\./);
    const none = await boardSettingsSet(ctxFor(fake, {args: {KEY: "language", VALUE: "7"}}));
    assert.equal(none.json.clamped, true);
    assert.deepEqual(none.json.changes, []);
    assert.match(none.text, /^language is 日本語 \(ja\) already: nothing changed\.\nThe board has no language with the code 7 \(it has 0 en, 1 zh-Hans, 3 ja, 4 id, 5 vi\): it kept 日本語 \(ja\)\./);
    const same = await boardSettingsSet(ctxFor(fake, {args: {KEY: "key_brightness", VALUE: "15"}}));
    assert.match(same.text, /^key_brightness is 15 already: nothing changed\.$/m);
    assert.equal(same.json.clamped, false);
    fake.saved = true;
    const big = await boardSettingsSet(ctxFor(fake, {args: {KEY: "screen_brightness", VALUE: "5%"}}));
    assert.match(big.text, /^screen_brightness 80 % → 10 %\.\nThe device kept it in its range 10-100 %: asked 5 %, set 10 %\./);

    // Reset: asked first (here no terminal: needs_confirmation, nothing sent); the language stays.
    const resets = () => fake.requests.filter(q => q.op === OP.SETTINGS_RESET).length;
    await assert.rejects(boardSettingsReset(ctxFor(fake)), e => e.code === "needs_confirmation" && e.exit === EXIT.confirm && /volume 60 → 70/.test(e.message) &&
      /the language stays 日本語 \(ja\)/.test(e.message) && e.data.changes.some(c => c.key === "volume_limit" && c.from === 60 && c.to === 100) && /only if the user asked/.test(e.hint));
    assert.equal(resets(), 0);
    let asked = null;
    const no = {...ctxFor(fake), interactive: true, confirm: async question => { asked = question; return false; }};
    await assert.rejects(boardSettingsReset(no), e => e.code === "needs_confirmation");
    assert.match(asked, /^Put the board's settings back to their defaults: volume 60 → 70, volume_limit 60 → 100, screen_brightness 10 % → 100 %, mic_gain -6 dB → 0 dB \(the language stays 日本語 \(ja\)\)\?$/);
    assert.equal(resets(), 0);
    const reset = await boardSettingsReset({...ctxFor(fake), interactive: true, confirm: async () => true});
    assert.equal(resets(), 1);
    assert.equal(reset.json.reset, true);
    assert.deepEqual(reset.json.changes.map(c => c.key), ["volume", "volume_limit", "screen_brightness", "mic_gain"]);
    assert.deepEqual(reset.json.settings, SETTING_SPECS.map(s => fake.setting(s)));
    assert.equal(fake.values.language, 3, "the language stays");
    assert.match(reset.text, /^Back to their defaults \(the language stays 日本語 \(ja\)\):\n  volume +60 +→ +70\n  volume_limit +60 +→ +100\n/);
    const again = await boardSettingsReset(ctxFor(fake, {flags: {yes: true}}));
    assert.equal(resets(), 1, "nothing to reset: nothing sent");
    assert.deepEqual({reset: again.json.reset, changes: again.json.changes}, {reset: false, changes: []});
    assert.match(again.text, /at its default already: nothing to reset/);
    fake.values.volume = 30;
    const yes = await boardSettingsReset(ctxFor(fake, {flags: {yes: true}, json: true}));
    assert.deepEqual(yes.json.changes, [{key: "volume", from: 30, to: 70}]);
    assert.deepEqual(fake.violations, []);
  }
});

test("settings: answered by a firmware built without the development channel; a HAL from before them, a setting it lacks, said plainly", async () => {
  // Protocol 3, the development channel off: the settings answer, the rest is dev_channel_off (HELLO says dev: false).
  const off = new FakeBoard({protocol: 3, off: true});
  assert.equal((await boardSettings(ctxFor(off))).json.settings.length, 6);
  assert.equal((await boardSettingsSet(ctxFor(off, {args: {KEY: "volume", VALUE: "40"}}))).json.setting.value, 40);
  await assert.rejects(boardInfo(ctxFor(off)), e => e.code === "dev_channel_off" && /board settings works without it/.test(e.hint));
  assert.ok(!off.requests.some(q => q.op === OP.INFO), "HELLO said so: INFO not asked");
  // Protocol 2 (a HAL from before 2026-11-23): the other commands work, settings are hal_too_old.
  const old = new FakeBoard({protocol: 2});
  assert.deepEqual((await boardInfo(ctxFor(old))).json, INFO);
  for (const run of [boardSettings(ctxFor(old)), boardSettingsGet(ctxFor(old, {args: {KEY: "volume"}})), boardSettingsReset(ctxFor(old, {flags: {yes: true}}))]) {
    await assert.rejects(run, e => e.code === "hal_too_old" && e.exit === EXIT.refused && /older than the board's settings \(its USB protocol is 2; 203cli board settings needs 3\)/.test(e.message) &&
      /CardenzaHAL from 2026-11-23 on/.test(e.hint) && e.data.protocol === 2 && e.data.needs === 3);
  }
  assert.ok(!old.requests.some(q => q.op >= OP.SETTINGS && q.op <= OP.SETTINGS_RESET), "not asked: IDENTIFY said 2");
  // One that says 3 but answers "unknown request" all the same; "off" is never dev_channel_off here; a setting the HAL lacks.
  const odd = new FakeBoard({protocol: 3});
  const real = odd.answer.bind(odd);
  odd.answer = async job => (job.op === OP.SETTINGS ? {error: "unknown request"} : job.op === OP.SETTING_GET ? {error: "off"} : real(job));
  await assert.rejects(boardSettings(ctxFor(odd)), e => e.code === "hal_too_old" && /2026-11-23/.test(e.hint));
  await assert.rejects(boardSettingsGet(ctxFor(odd, {args: {KEY: "volume"}})), e => e.code === "board_refused" && e.data.reason === "off");
  const fewer = new FakeBoard({protocol: 3, keys: ["volume", "volume_limit", "language"]});
  await assert.rejects(boardSettingsGet(ctxFor(fewer, {args: {KEY: "mic_gain"}})), e => e.code === "board_refused" && e.data.reason === "unknown setting" && /does not have that setting/.test(e.hint));
  // A wrong key or value: before the device is opened.
  const untouched = new FakeBoard({protocol: 3});
  await assert.rejects(boardSettingsSet(ctxFor(untouched, {args: {KEY: "loudness", VALUE: "3"}})), e => e.code === "usage");
  await assert.rejects(boardSettingsSet(ctxFor(untouched, {args: {KEY: "volume", VALUE: "loud"}})), e => e.code === "usage");
  assert.deepEqual(untouched.requests, []);
});

test("the bridge's python compiles; a bridge process carries the bytes both ways (hex lines)", {skip: spawnSync("python3", ["-c", "1"]).status !== 0 && "no python3"}, async () => {
  for (const script of [COREMIDI_BRIDGE]) {
    const compiled = spawnSync("python3", ["-I", "-c", "import sys; compile(sys.stdin.read(), 'bridge', 'exec')"], {input: script, encoding: "utf8"});
    assert.equal(compiled.status, 0, compiled.stderr);
  }
  // A stand-in bridge that answers IDENTIFY and HELLO as a firmware would, through the same lines as the real ones.
  const ANSWERS = String.raw`
import json, sys
def pack(data):
    out = []
    for i in range(0, len(data), 7):
        group = data[i:i + 7]
        out.append(sum(((b >> 7) & 1) << j for j, b in enumerate(group)))
        out.extend(b & 0x7F for b in group)
    return bytes(out)
print(json.dumps({"ready": True, "name": "Stand-in Cardenza"})); sys.stdout.flush()
for line in sys.stdin:
    data = bytes.fromhex(line.strip())
    if data[:3] == b"\xf0\x23\x44":
        sys.stdout.write(bytes([0xF0, 0x24, 0x44, 2]).hex() + b"Cardenza".hex() + "f7\n")
    elif data[:3] == b"\xf0\x23\x45" and data[4] == 0:
        answer = bytes([0xF0, 0x24, 0x45, data[3], 0, 0, 1]) + pack(json.dumps({"protocol": 2, "max_args": 52}).encode()) + b"\xf7"
        sys.stdout.write(answer[:5].hex() + "\n" + answer[5:].hex() + "\n")
    sys.stdout.flush()
`;
  const board = await openBoard({links: [{via: "bridge", where: "bridge", open: () => bridgeLink(["python3"], ANSWERS, {kind: "sysex", via: "bridge"})}]});
  assert.deepEqual(board.helloed, {protocol: 2, max_args: 52});
  assert.equal(board.where, "Stand-in Cardenza");
  await board.close();
  await assert.rejects(bridgeLink(["python3"], 'import json; print(json.dumps({"error": "no MIDI source named Cardenza"}))', {kind: "sysex", via: "coremidi"}),
    e => e.code === "no MIDI source named Cardenza");
});

// Windows: node-hid (a stand-in here around the stand-in firmware): the system channel's collection, reports of 64 bytes.
function fakeNodeHid(fake, {cardenza = true} = {}) {
  const at = col => String.raw`\\?\HID#VID_0203&PID_2040&MI_05&Col0` + col + "#8&1&0&0000#{4d1e55b2}";
  const opened = [];
  const list = [
    ...(cardenza ? [{vendorId: 0x0203, path: at(3), product: "203 Systems Cardenza", usagePage: 0xff00}, {vendorId: 0x0203, path: at(1), product: "203 Systems Cardenza", usagePage: 0x0c},
      {vendorId: 0x0203, path: at(2), product: "203 Systems Cardenza", usagePage: 0xff00}] : []),
    {vendorId: 0x0203, path: String.raw`\\?\HID#VID_0203&PID_1080&MI_02#7&9#{4d1e55b2}`, product: "203 Systems Mystrix 2", usagePage: 0xff00}];
  return {opened, system: at(2), devices: () => list.map(d => ({...d})), HIDAsync: {async open(path) {
    opened.push(path);
    const device = new EventEmitter();
    device.on("newListener", event => { if (event === "data") fake.sink = bytes => device.emit("data", Buffer.from(bytes)); });
    device.write = async data => { assert.equal(data.length, 64, "a report of 64 bytes, its ID first"); fake.receive(Uint8Array.from(data)); return data.length; };
    device.close = async () => { fake.sink = null; fake.closed = true; };
    return device;
  }}};
}

test("Windows: board over node-hid, the system channel's collection; missing or no Cardenza says what to do", async () => {
  const fake = new FakeBoard({kind: "hid", protocol: 3});
  const hid = fakeNodeHid(fake);
  const board = await openBoard({links: [{via: "hidapi", where: "HID", open: () => nodeHidLink({hid})}], need: "settings"});
  assert.equal(board.via, "hidapi");
  assert.equal(board.where, "203 Systems Cardenza");
  assert.equal(board.identity.protocol, 3);
  assert.deepEqual(hid.opened, [hid.system], "only the system channel's collection: not the app's, never the Mystrix");
  await board.close();
  assert.equal(fake.closed, true);
  await assert.rejects(openBoard({links: [{via: "hidapi", open: () => nodeHidLink({hid: null})}]}),
    e => e.code === "hidapi_missing" && /npm install -g 203cli/.test(e.hint));
  const empty = fs.mkdtempSync(path.join(dir, "no-dev-"));
  const before = process.env.C203_DEV;
  process.env.C203_DEV = empty;
  try {
    await assert.rejects(openBoard({links: [{via: "hidapi", open: () => nodeHidLink({hid: fakeNodeHid(fake, {cardenza: false})})}], platform: "linux"}),
      e => e.code === "board_not_found");
  } finally {
    if (before === undefined) delete process.env.C203_DEV; else process.env.C203_DEV = before;
  }
});

test("Windows: no firmware on HID but the Launcher on its COM port says board_in_launcher (the serial binding's stand-in)", async () => {
  process.env.C203_SERIAL = path.join(ROOT, "tests/serial-standin.mjs");
  try {
    const said = await withoutChannel("win32");
    assert.equal(said.code, "board_in_launcher", said.message);
    assert.equal(said.data.port, "COM7", "the Launcher's port, not the Arduino's");
    assert.match(said.data.launcher, /0\.3\.0-cardenza/);
  } finally {
    delete process.env.C203_SERIAL;
  }
});

// ---------------------------------------------------------------------------------------------
// 203cli board itself, on Linux: the stand-in firmware behind pseudo-terminals as ALSA raw MIDI and hidraw in a stand-in sysfs.

// The other side of a pty: what is written to it goes to stdout, stdin is written to it (whole, however long).
const BRIDGE = `
import os, pty, select, sys, tty
m, s = pty.openpty()
tty.setraw(s)
sys.stdout.write(os.ttyname(s) + "\\n"); sys.stdout.flush()
def whole(fd, data):
    while data:
        data = data[os.write(fd, data):]
while True:
    r, _, _ = select.select([m, 0], [], [])
    if m in r:
        try: data = os.read(m, 65536)
        except OSError: data = b""
        if data: whole(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data: break
        whole(m, data)
`;
async function ptyFor(fake) {
  const py = spawn("python3", ["-I", "-c", BRIDGE], {stdio: ["pipe", "pipe", "inherit"]});
  const slave = await new Promise((resolve, reject) => {
    let head = "", found = false;
    py.on("error", reject);
    py.stdout.on("data", chunk => {
      if (found) { fake.receive([...chunk]); return; }
      head += chunk.toString("latin1");
      const at = head.indexOf("\n");
      if (at < 0) return;
      found = true;
      resolve(head.slice(0, at));
      const rest = Buffer.from(head.slice(at + 1), "latin1");
      if (rest.length) fake.receive([...rest]);
    });
  });
  fake.sink = bytes => py.stdin.write(Buffer.from(bytes));
  return {slave, close: () => py.kill()};
}
function standInSystem({midi = null, hid = null} = {}) {
  const root = fs.mkdtempSync(path.join(dir, "sys-"));
  const sys = path.join(root, "sys"), dev = path.join(root, "dev");
  const usb = path.join(sys, "devices/usb1/1-2");
  fs.mkdirSync(path.join(usb, "1-2:1.0"), {recursive: true});
  fs.mkdirSync(path.join(usb, "1-2:1.5/0003:0203:10C0.0001"), {recursive: true});
  fs.writeFileSync(path.join(usb, "idVendor"), "0203\n");
  fs.writeFileSync(path.join(usb, "product"), "203 Systems Cardenza\n");
  fs.mkdirSync(path.join(sys, "bus/usb/devices"), {recursive: true});
  fs.symlinkSync(usb, path.join(sys, "bus/usb/devices/1-2"));
  fs.mkdirSync(path.join(sys, "class/sound/card1"), {recursive: true});
  fs.symlinkSync(path.join(usb, "1-2:1.0"), path.join(sys, "class/sound/card1/device"));
  fs.mkdirSync(path.join(sys, "class/hidraw/hidraw3"), {recursive: true});
  fs.symlinkSync(path.join(usb, "1-2:1.5/0003:0203:10C0.0001"), path.join(sys, "class/hidraw/hidraw3/device"));
  fs.mkdirSync(path.join(dev, "snd"), {recursive: true});
  fs.symlinkSync(midi ?? path.join(root, "no-midi"), path.join(dev, "snd/midiC1D0"));
  fs.symlinkSync(hid ?? path.join(root, "no-hid"), path.join(dev, "hidraw3"));
  return {C203_SYS: sys, C203_DEV: dev};
}
function cli(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {cwd: dir, env: {...process.env, ...NO_UPDATES, XDG_CONFIG_HOME: path.join(dir, "config"), COMMUNITY_TOKEN: "", COMMUNITY_API: "",
      LANG: "en_US.UTF-8", ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => {
      let json = null, error = null;
      try { json = JSON.parse(stdout); } catch { /* text */ }
      try { error = JSON.parse(stderr.trim().split("\n").at(-1)); } catch { /* text */ }
      resolve({code, stdout, stderr, json, error});
    });
  });
}

test("203cli board over raw MIDI, signed out: info, screen, press, files put and get", {skip: !PTY && "Linux with python3 (pty)"}, async () => {
  const fake = new FakeBoard({files: {"CardenzaSynth/Logs/log.txt": Buffer.from("I (5) boot\n")}});
  const pty = await ptyFor(fake);
  try {
    const env = standInSystem({midi: pty.slave});
    const info = await cli(["board", "info", "--json"], env);
    assert.equal(info.code, 0, info.stderr);
    assert.deepEqual(info.json, INFO);
    const text = await cli(["board", "info"], env);
    assert.match(text.stdout, /CardenzaSynth 0\.2\.0 \(V6QK28\)/);
    assert.match(text.stdout, /USB +MIDI \(.*midiC1D0\)/);
    const shot = await cli(["board", "screen", "--json"], env);
    assert.equal(shot.code, 0, shot.stderr);
    assert.match(path.basename(shot.json.path), /^cardenza-\d{8}-\d{6}\.png$/);
    assert.equal(readPng(fs.readFileSync(shot.json.path)).width, 240);
    const press = await cli(["board", "press", "up", "ok", "--hold", "30", "--json"], env);
    assert.equal(press.code, 0, press.stderr);
    assert.deepEqual(press.json.keys, [[40], [42]], "up is the ; key");
    const local = path.join(dir, "kick.wav");
    const wav = Buffer.from(Array.from({length: 4000}, (_, i) => (i * 5) & 255));
    fs.writeFileSync(local, wav);
    const put = await cli(["board", "files", "put", "kick.wav", "CardenzaSynth/", "--json"], env);
    assert.equal(put.code, 0, put.stderr);
    assert.deepEqual(Buffer.from(fake.files.get("CardenzaSynth/kick.wav")), wav);
    const get = await cli(["board", "files", "get", "/sdcard/CardenzaSynth/Logs/log.txt", "--json"], env);
    assert.equal(get.code, 0, get.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "log.txt"), "utf8"), "I (5) boot\n");
    const ls = await cli(["board", "files", "ls", "CardenzaSynth"], env);
    assert.match(ls.stdout, /kick\.wav +3\.91 KB/);
    assert.deepEqual(fake.violations, []);
    const help = JSON.parse((await cli(["board", "info", "--help", "--json"])).stdout);
    assert.equal(help.signin, false, "no sign-in");
  } finally { pty.close(); }
});

test("203cli board over hidraw when raw MIDI cannot be opened; a HAL too old says so", {skip: !PTY && "Linux with python3 (pty)"}, async () => {
  const fake = new FakeBoard({kind: "hid", rle: false});
  const pty = await ptyFor(fake);
  try {
    const env = standInSystem({hid: pty.slave});
    const status = await cli(["board", "status", "--json"], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.json.presence, "connected");
    const shot = await cli(["board", "screen", "--out", "hid.png"], env);
    assert.equal(shot.code, 0, shot.stderr);
    assert.equal(shot.stdout.trim(), path.join(dir, "hid.png"));
    assert.deepEqual(fake.violations, []);
  } finally { pty.close(); }
  const old = new FakeBoard({protocol: 1});
  const pty2 = await ptyFor(old);
  try {
    const r = await cli(["board", "info", "--json"], standInSystem({midi: pty2.slave}));
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.error.code, "hal_too_old");
    assert.match(r.error.hint, /current CardenzaHAL/);
  } finally { pty2.close(); }
  const none = await cli(["board", "info", "--json"], {C203_SYS: path.join(dir, "no-sys"), C203_DEV: path.join(dir, "no-dev")});
  assert.equal(none.error.code, "board_not_found");
});

test("203cli board settings: text and JSON, set, reset asking for --yes, an older HAL", {skip: !PTY && "Linux with python3 (pty)"}, async () => {
  const fake = new FakeBoard({protocol: 3, off: true, settings: {volume: 64, volume_limit: 90, language: 1}});
  const pty = await ptyFor(fake);
  try {
    const env = standInSystem({midi: pty.slave});
    const all = await cli(["board", "settings", "--json"], env);
    assert.equal(all.code, 0, all.stderr);
    assert.deepEqual(all.json.settings.map(s => [s.key, s.value]), [["volume", 64], ["volume_limit", 90], ["screen_brightness", 100], ["key_brightness", 15], ["mic_gain", 0], ["language", 1]]);
    const text = await cli(["board", "settings"], env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /language +简体中文 \(zh-Hans\)/);
    const set = await cli(["board", "settings", "set", "volume_limit", "50", "--json"], env);
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(set.json.changed, ["volume", "volume_limit"]);
    const gain = await cli(["board", "settings", "set", "mic_gain", "-3"], env);
    assert.equal(gain.code, 0, gain.stderr);
    assert.match(gain.stdout, /^mic_gain 0 dB → -3 dB\./);
    const ja = await cli(["board", "settings", "set", "language", "ja", "--json"], env);
    assert.equal(ja.json.setting.value, 3);
    const unasked = await cli(["board", "settings", "reset", "--json"], env);
    assert.equal(unasked.code, 6, unasked.stderr);
    assert.equal(unasked.error.code, "needs_confirmation");
    assert.match(unasked.error.next[0], /board settings reset --yes --json$/);
    assert.equal(fake.values.volume_limit, 50, "not reset");
    const reset = await cli(["board", "settings", "reset", "--yes", "--json"], env);
    assert.equal(reset.code, 0, reset.stderr);
    assert.deepEqual(reset.json.settings.map(s => s.value), [70, 100, 100, 15, 0, 3]);
    const help = JSON.parse((await cli(["board", "settings", "reset", "--help", "--json"])).stdout);
    assert.equal(help.signin, false);
    assert.deepEqual(help.flags.map(f => f.name), ["--yes"]);
    assert.deepEqual(fake.violations, []);
  } finally { pty.close(); }
  const old = new FakeBoard({protocol: 2});
  const pty2 = await ptyFor(old);
  try {
    const r = await cli(["board", "settings", "--json"], standInSystem({midi: pty2.slave}));
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.error.code, "hal_too_old");
    assert.match(r.error.hint, /CardenzaHAL from 2026-11-23 on/);
  } finally { pty2.close(); }
});

test("203cli board settings: a wrong key or value, or a misspelt action, is a usage error before any device is looked for", async () => {
  // No device anywhere: no sysfs or /dev (Linux), no node-hid (Windows: the one there would reach a real Cardenza).
  const nowhere = {C203_SYS: path.join(dir, "no-sys"), C203_DEV: path.join(dir, "no-dev"), C203_HID: path.join(dir, "no-node-hid.cjs")};
  const key = await cli(["board", "settings", "set", "volum", "50", "--json"], nowhere);
  assert.equal(key.code, 2, key.stderr);
  assert.equal(key.error.code, "usage");
  assert.equal(key.error.field, "KEY");
  assert.match(key.error.next[0], /board settings set volume 50 --json$/);
  const value = await cli(["board", "settings", "set", "language", "klingon", "--json"], nowhere);
  assert.equal(value.code, 2);
  assert.match(value.error.error, /zh-Hans \(简体中文\)/);
  const action = await cli(["board", "settings", "sett", "volume", "50", "--json"], nowhere);
  assert.equal(action.code, 2);
  assert.match(action.error.hint, /Did you mean board settings set\?/);
  assert.match(action.error.next[0], /board settings set volume 50 --json$/);
  const none = await cli(["board", "settings", "--json"], nowhere);
  assert.notEqual(none.error.code, "usage", "a right one goes on to look for the device");
});

test("only a serial port: the 203 Launcher is told apart from a firmware that does not start CardenzaHAL's USB", {skip: !PTY && "Linux with python3 (pty)"}, async () => {
  for (const launcher of [true, false]) {
    let heard = "";
    const port = {receive(bytes) {
      heard += Buffer.from(bytes).toString("latin1");
      if (launcher && heard.includes("version\n")) { heard = ""; this.sink([...Buffer.from("I (900) boot\r\nLauncher 0.3.1-cardenza\r\n")]); }
    }};
    const pty = await ptyFor(port);
    try {
      const root = fs.mkdtempSync(path.join(dir, "serial-"));
      fs.mkdirSync(path.join(root, "dev"));
      fs.symlinkSync(pty.slave, path.join(root, "dev/ttyACM0"));
      const r = await cli(["board", "info", "--json"], {C203_SYS: path.join(root, "sys"), C203_DEV: path.join(root, "dev")});
      assert.equal(r.code, 1, r.stderr);
      if (launcher) {
        assert.equal(r.error.code, "board_in_launcher");
        assert.equal(r.error.launcher, "0.3.1-cardenza");
      } else {
        assert.equal(r.error.code, "board_no_usb");
        assert.match(r.error.error, /CardenzaHAL::USB::Init\(\);` after `CardenzaHAL::Init\(\)` in app_main/);
        assert.match(r.error.hint, /203cli log still reads its console/);
      }
    } finally { pty.close(); }
  }
});

test("Ctrl-C: the firmware is told to stop (CANCEL; an upload PUT_ABORT), nothing half-written is left here, exit 130", {skip: !PTY && "Linux with python3 (pty)"}, async () => {
  const big = Buffer.from(Array.from({length: 60000}, (_, i) => (i * 3) & 255));
  const fake = new FakeBoard({files: {"big.bin": big}, pace: 20});
  const pty = await ptyFor(fake);
  try {
    const env = standInSystem({midi: pty.slave});
    const interrupt = async args => {
      const child = spawn(process.execPath, [CLI, ...args], {cwd: dir, env: {...process.env, ...NO_UPDATES, ...env, XDG_CONFIG_HOME: path.join(dir, "config")}});
      let stderr = "";
      child.stderr.on("data", c => { stderr += c; });
      const closed = new Promise(resolve => child.on("close", code => resolve(code)));
      for (const end = Date.now() + 8000; Date.now() < end && !fake.requests.some(q => q.op === OP.GET || q.op === OP.PUT_DATA);) await new Promise(r => setTimeout(r, 20));
      await new Promise(r => setTimeout(r, 300));
      child.kill("SIGINT");
      return {code: await closed, stderr};
    };
    const got = await interrupt(["board", "files", "get", "big.bin", "cut.bin"]);
    assert.equal(got.code, 130, got.stderr);
    assert.ok(fake.requests.some(q => q.op === OP.CANCEL), "CANCEL sent");
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith("cut.bin")), [], "no part file, no half file");
    fake.requests = [];
    fs.writeFileSync(path.join(dir, "up.bin"), big);
    const put = await interrupt(["board", "files", "put", "up.bin"]);
    assert.equal(put.code, 130, put.stderr);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(fake.requests.some(q => q.op === OP.PUT_ABORT), "the upload aborted");
    assert.equal(fake.files.has("up.bin"), false);
  } finally { pty.close(); }
});
