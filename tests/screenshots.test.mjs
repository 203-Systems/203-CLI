// Screenshots on the community (the contract of 2026-11-24, COMMUNITY.md "Screenshots"): 203cli screenshots list, show, download
// (--scale: larger pixel for pixel, a PNG made here), public / private, rename, delete (asks), upload (the PNG as the body, its
// name and what is known in headers; checked here first), against a stand-in API, and an older community that answers 404 to
// them. And scripts/png.mjs, which reads PNGs back: every colour type and filter, against PNGs written here by hand.
// Run: node --test tests/screenshots.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {run, standInApi} from "./fixtures.mjs";
import {fakePixel, fakePng, widen} from "./board-fake.mjs";
import {decodePng, scalePixels, rgb565Of, pngSize, isPng} from "../scripts/png.mjs";
import {crc32} from "../scripts/board.mjs";
import {screenshotName, screenshotTakenAt} from "../scripts/lib.mjs";

const TOKEN = "cct_" + "c".repeat(64);

// ---------------------------------------------------------------------------------------------
// PNGs written here, apart from 203cli's encoder: any colour type and depth, each row with the filter asked for.

const be = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type, data) {
  const body = Buffer.from([...Buffer.from(type, "latin1"), ...data]);
  return [...be(data.length), ...body, ...be(crc32(body))];
}
/** rows: each row's bytes before filtering; filters: each row's filter (0-4). */
function pngOf({width, height, type, depth = 8, rows, filters, plte = null, trns = null, interlace = 0}) {
  const bpp = Math.max(1, Math.ceil(({0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[type] * depth) / 8));
  const out = [];
  rows.forEach((row, y) => {
    const f = filters?.[y] ?? 0, up = y ? rows[y - 1] : null;
    out.push(f);
    row.forEach((x, i) => {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out.push((x - pred) & 255);
    });
  });
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be(width), ...be(height), depth, type, 0, 0, interlace]),
    ...(plte ? chunk("PLTE", plte) : []), ...(trns ? chunk("tRNS", trns) : []), ...chunk("IDAT", [...zlib.deflateSync(Buffer.from(out))]), ...chunk("IEND", [])]);
}
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x + 1) * img.channels)];

test("png: the device's PNG (a palette), RGB, RGBA and grey with every filter, low bit depths, transparency; refused plainly", () => {
  // The HAL's screenshot as the stand-in firmware writes it: colour type 3, 8 bits, its palette the widened RGB565 colours.
  const pixels = [];
  for (let y = 0; y < 135; y++) for (let x = 0; x < 240; x++) pixels.push(fakePixel(x, y));
  const shot = decodePng(Uint8Array.from(fakePng(pixels, 240, 135)));
  assert.deepEqual([shot.width, shot.height, shot.channels], [240, 135, 3]);
  for (const [x, y] of [[0, 0], [239, 134], [70, 50], [130, 100]]) assert.deepEqual(px(shot, x, y), widen(fakePixel(x, y)));
  // More than 256 colours: colour type 2.
  const many = Array.from({length: 600}, (_, i) => (i * 97) & 0xffff);
  const rgb = decodePng(Uint8Array.from(fakePng(many, 30, 20)));
  assert.deepEqual(px(rgb, 7, 3), widen(many[3 * 30 + 7]));
  // RGB, every filter on its own row.
  const rows = Array.from({length: 5}, (_, y) => Array.from({length: 4 * 3}, (_, i) => (y * 53 + i * 29 + ((i * i) % 7)) & 255));
  const filtered = decodePng(pngOf({width: 4, height: 5, type: 2, rows, filters: [0, 1, 2, 3, 4]}));
  rows.forEach((row, y) => assert.deepEqual([...filtered.data.subarray(y * 12, y * 12 + 12)], row, `filter ${y}`));
  // RGBA (channels 4), grey + alpha, grey at 1 and 4 bits, a 4-bit palette with tRNS, 16 bits (their high byte).
  const rgba = decodePng(pngOf({width: 2, height: 2, type: 6, rows: [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16]], filters: [4, 3]}));
  assert.deepEqual([rgba.channels, ...px(rgba, 1, 1)], [4, 13, 14, 15, 16]);
  const greyAlpha = decodePng(pngOf({width: 2, height: 1, type: 4, rows: [[200, 100, 50, 25]]}));
  assert.deepEqual(px(greyAlpha, 0, 0), [200, 200, 200, 100]);
  const bits = decodePng(pngOf({width: 10, height: 1, type: 0, depth: 1, rows: [[0b10110000, 0b01000000]]}));
  assert.deepEqual(Array.from({length: 10}, (_, x) => px(bits, x, 0)[0]), [255, 0, 255, 255, 0, 0, 0, 0, 0, 255]);
  const nibble = decodePng(pngOf({width: 3, height: 1, type: 0, depth: 4, rows: [[0xf0, 0x80]]}));
  assert.deepEqual([0, 1, 2].map(x => px(nibble, x, 0)[0]), [255, 0, 136]);
  const pal = decodePng(pngOf({width: 3, height: 1, type: 3, depth: 4, rows: [[0x12, 0x00]], plte: [0, 0, 0, 10, 20, 30, 40, 50, 60], trns: [255, 128]}));
  assert.deepEqual([pal.channels, ...px(pal, 0, 0), ...px(pal, 1, 0), ...px(pal, 2, 0)], [4, 10, 20, 30, 128, 40, 50, 60, 255, 0, 0, 0, 255]);
  const wide = decodePng(pngOf({width: 1, height: 1, type: 2, depth: 16, rows: [[0xab, 0xcd, 0x12, 0x34, 0xff, 0x00]]}));
  assert.deepEqual(px(wide, 0, 0), [0xab, 0x12, 0xff]);
  // Its size from the IHDR; what it refuses.
  assert.deepEqual(pngSize(pngOf({width: 640, height: 2, type: 0, rows: [new Array(640).fill(0), new Array(640).fill(0)]})), {width: 640, height: 2});
  assert.equal(pngSize(Uint8Array.of(1, 2, 3)), null);
  assert.equal(isPng(Uint8Array.of(0x89, 0x50)), false);
  assert.throws(() => decodePng(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9)), /not a PNG/);
  assert.throws(() => decodePng(pngOf({width: 1, height: 1, type: 2, rows: [[1, 2, 3]], interlace: 1})), /interlaced/);
  assert.throws(() => decodePng(pngOf({width: 1, height: 1, type: 3, rows: [[0]]})), /palette/);
});

test("png: larger pixel for pixel (each a block), and RGB565 back from 8 bits", () => {
  const img = {width: 2, height: 1, channels: 3, data: Uint8Array.of(255, 0, 0, 0, 0, 255)};
  const big = scalePixels(img, 3);
  assert.deepEqual([big.width, big.height], [6, 3]);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) assert.deepEqual(px(big, x, y), x < 3 ? [255, 0, 0] : [0, 0, 255], `${x},${y}`);
  assert.deepEqual([...rgb565Of({width: 3, height: 1, channels: 3, data: Uint8Array.from([...widen(0xf800), ...widen(0x07e0), ...widen(0x8410)])})],
    [0x00, 0xf8, 0xe0, 0x07, 0x10, 0x84], "widened RGB565 comes back exactly");
});

test("names: a file's name as a screenshot's, and when a device's name says it was taken", () => {
  assert.equal(screenshotName("/x/Screen Shot 2026-11-24 at 10.15.PNG"), "Screen-Shot-2026-11-24-at-10.15.png");
  assert.equal(screenshotName("2026-11-24_101500_CardenzaSynth.png"), "2026-11-24_101500_CardenzaSynth.png");
  assert.equal(screenshotName("..png"), "screenshot.png");
  assert.equal(screenshotName("a".repeat(120) + ".png").length, 80);
  assert.equal(screenshotTakenAt("2026-11-24_101500_CardenzaSynth.png"), Date.UTC(2026, 10, 24, 10, 15, 0) / 1000);
  assert.equal(screenshotTakenAt("2026-11-24_101500-2_Launcher.png"), Date.UTC(2026, 10, 24, 10, 15, 0) / 1000);
  assert.equal(screenshotTakenAt("shot-0007_Launcher.png"), null, "the device's clock was not set");
  assert.equal(screenshotTakenAt("2026-13-24_101500_X.png"), null);
});

// ---------------------------------------------------------------------------------------------
// The commands against a stand-in community

const devicePng = (() => {
  const pixels = [];
  for (let y = 0; y < 135; y++) for (let x = 0; x < 240; x++) pixels.push(fakePixel(x, y));
  return Buffer.from(fakePng(pixels, 240, 135));
})();
let stand, old, home, work;
const shots = new Map();   // id -> Screenshot (+ png)
const tombstones = new Set();
const uploads = [];
let quotaFull = false, seq = 0;
const me = {id: "u1u1u1u1", name: "Lin", role: "user", badges: []};
function addShot({id, name, title = null, isPublic = false, device = {id: 3, name: "Studio Cardenza"}, taken_at = "2026-11-24T10:15:00Z", user = me, png = devicePng}) {
  const s = {id, name, title, width: 240, height: 135, bytes: png.length, public: isPublic, taken_at, uploaded_at: "2026-11-24T10:16:00Z",
    firmware: {name: "CardenzaSynth", version: "0.3.0", code: "V6QK28"}, device: user === me ? device : null, url: `${stand.api}/screenshots/${id}/png`, user};
  shots.set(id, {...s, png});
  return s;
}
const view = s => { const {png: _png, ...out} = s; return out; };

before(async () => {
  stand = await standInApi(async (req, send, body, raw) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    const signed = req.headers.authorization === "Bearer " + TOKEN;
    if (p === "/api/me") return signed ? send(200, {...me, scopes: ["read", "write"], credential: {kind: "cli"}}) : send(401, {error: "Sign in first", code: "signin_required"});
    if (p === "/api/me/screenshots" && req.method === "GET") {
      if (!signed) return send(401, {error: "Sign in first", code: "signin_required"});
      const mine = [...shots.values()].filter(s => s.user === me).map(view);
      const limit = Number(url.searchParams.get("limit") || 24), from = Number(url.searchParams.get("cursor") || 0);
      const page = mine.slice(from, from + limit);
      return send(200, {items: page, next: from + limit < mine.length ? String(from + limit) : null,
        quota: {count: mine.length, bytes: mine.reduce((n, s) => n + s.bytes, 0), max_count: 1000, max_bytes: 209715200}});
    }
    if (p === "/api/me/screenshots" && req.method === "POST") {
      uploads.push({headers: {...req.headers}, bytes: raw.length});
      if (quotaFull) return send(409, {error: "The account is full", code: "quota_full"});
      const name = req.headers["x-screenshot-name"];
      if (tombstones.has(name)) return send(200, {screenshot: null, deleted: true, now: 1795515400});
      const had = [...shots.values()].find(s => s.user === me && s.name === name && !s.device);
      if (had) return send(200, {screenshot: view(had), now: 1795515400});
      const taken = req.headers["x-taken-at"];
      const made = addShot({id: "up" + String(++seq).padStart(6, "0"), name, device: null, taken_at: taken ? new Date(Number(taken) * 1000).toISOString() : null, png: raw});
      return send(201, {screenshot: made, now: 1795515400});
    }
    let m = /^\/api\/users\/(\w+)\/screenshots$/.exec(p);
    if (m) return m[1] === "zz9zz9zz" ? send(404, {error: "No such person", code: "not_found"}) : send(200, {items: [...shots.values()].filter(s => s.user.id === m[1] && s.public).map(view), next: null});
    m = /^\/api\/screenshots\/(\w+)(\/png|\/edit|\/delete)?$/.exec(p);
    if (m) {
      const s = shots.get(m[1]);
      if (!s || !(s.user === me || s.public)) return send(404, {error: "Not found", code: "not_found"});
      if (!m[2]) return send(200, view(s));
      if (m[2] === "/png") return send(200, s.png, "image/png");
      if (s.user !== me) return send(403, {error: "Not yours", code: "forbidden"});
      if (m[2] === "/edit") {
        const x = JSON.parse(body || "{}");
        if ("public" in x) s.public = x.public;
        if ("title" in x) s.title = x.title === "" ? null : x.title;
        s.edits = (s.edits ?? 0) + 1;
        return send(200, view(s));
      }
      shots.delete(m[1]);
      tombstones.add(s.name);
      return send(200, {deleted: true});
    }
    return false;
  });
  // An older community: the same people, no screenshots at all.
  old = await standInApi(async (req, send) => (req.url === "/api/me" ? send(200, {...me, scopes: ["read", "write"]}) : false));
  addShot({id: "q4hzuufx", name: "2026-11-24_101500_CardenzaSynth.png", title: "Home"});
  addShot({id: "7ces8nvr", name: "2026-11-24_101600_CardenzaSynth.png", isPublic: true});
  addShot({id: "k2k2k2k2", name: "shot-0001_Launcher.png", taken_at: null});
  addShot({id: "k3k3k3k3", name: "shot-0001_Launcher.png", device: {id: 4, name: "Desk Cardenza"}, taken_at: null});
  addShot({id: "pub0pub0", name: "2026-11-20_090000_Other.png", isPublic: true, user: {id: "ab12cd34", name: "Mika"}});
  addShot({id: "hid0hid0", name: "2026-11-20_090100_Other.png", user: {id: "ab12cd34", name: "Mika"}});
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-shots-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-shots-work-"));
});
after(async () => { await stand.close(); await old.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = (args, {token = TOKEN, api = stand.api, env = {}} = {}) => run(["--api", api, ...args], {cwd: work, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: token, CI: "1", ...env}});
const ok = r => { assert.equal(r.code, 0, r.stderr || r.stdout); return r.json; };
const refused = (r, exit, code) => { assert.equal(r.code, exit, r.stderr || r.stdout); assert.equal(r.error?.code, code, r.stderr); return r.error; };

test("screenshots list: yours (private too) with the quota, a page and --all, --public-only, a person's public ones", async () => {
  const all = ok(await cli(["screenshots", "list", "--json"]));
  assert.deepEqual(all.items.map(s => s.id), ["q4hzuufx", "7ces8nvr", "k2k2k2k2", "k3k3k3k3"]);
  assert.equal(all.quota.max_count, 1000);
  const text = await cli(["screenshots", "list"]);
  assert.match(text.stdout, /q4hzuufx +2026-11-24_101500_CardenzaSynth\.png +"Home" +240×135 +\S+ B +private/);
  assert.match(text.stdout, /7ces8nvr .* public /);
  assert.match(text.stdout, /4 of 1000 screenshots/);
  const page = ok(await cli(["screenshots", "list", "--limit", "3", "--json"]));
  assert.deepEqual([page.items.length, page.next], [3, "3"]);
  assert.match((await cli(["screenshots", "list", "--limit", "3"])).stdout, /more: --cursor 3/);
  assert.equal(ok(await cli(["screenshots", "list", "--cursor", "3", "--json"])).items[0].id, "k3k3k3k3");
  const every = ok(await cli(["screenshots", "list", "--all", "--limit", "2", "--json"]));
  assert.equal(every.items.length, 4, "--all follows next");
  assert.deepEqual(ok(await cli(["screenshots", "list", "--public-only", "--json"])).items.map(s => s.id), ["7ces8nvr"]);
  const theirs = ok(await cli(["screenshots", "list", "--user", "ab12cd34", "--json"]));
  assert.deepEqual([theirs.user, theirs.items.map(s => s.id)], ["ab12cd34", ["pub0pub0"]], "only the public ones");
  refused(await cli(["screenshots", "list", "--user", "zz9zz9zz", "--json"]), 1, "not_found");
  refused(await cli(["screenshots", "list", "--limit", "0", "--json"]), 2, "usage");
  const zh = await cli(["screenshots", "list", "--lang", "zh"]);
  assert.match(zh.stdout, /私密/);
  assert.match(zh.stdout, /截图 4 \/ 1000 张/);
  refused(await cli(["screenshots", "list", "--json"], {token: ""}), 4, "signin_required");
});

test("screenshots show and download: by id or file name, a public one of someone else, --scale 4 (each pixel a block), --out a file", async () => {
  const byId = ok(await cli(["screenshots", "show", "q4hzuufx", "--json"]));
  assert.equal(byId.name, "2026-11-24_101500_CardenzaSynth.png");
  assert.equal(ok(await cli(["screenshots", "show", "2026-11-24_101500_CardenzaSynth", "--json"])).id, "q4hzuufx", ".png left out");
  assert.equal(ok(await cli(["screenshots", "show", "Home", "--json"])).id, "q4hzuufx", "by its title");
  assert.match((await cli(["screenshots", "show", "q4hzuufx"])).stdout, /seen by +its owner only \(private\)\n {2}taken +2026-11-24 10:15 UTC/);
  const twice = refused(await cli(["screenshots", "show", "shot-0001_Launcher.png", "--json"]), 2, "usage");
  assert.match(twice.error, /2 of your screenshots are called/);
  assert.match(twice.hint, /k2k2k2k2 .*Studio Cardenza.*k3k3k3k3 .*Desk Cardenza/);
  refused(await cli(["screenshots", "show", "nope0000", "--json"]), 1, "not_found");
  refused(await cli(["screenshots", "show", "hid0hid0", "--json"]), 1, "not_found");

  const saved = ok(await cli(["screenshots", "download", "q4hzuufx", "pub0pub0", "--out", "shots", "--json"])).saved;
  assert.deepEqual(saved.map(s => path.relative(work, s.path)), [path.join("shots", "2026-11-24_101500_CardenzaSynth.png"), path.join("shots", "2026-11-20_090000_Other.png")]);
  assert.deepEqual(fs.readFileSync(saved[0].path), devicePng, "the bytes as uploaded");
  const big = ok(await cli(["screenshots", "download", "2026-11-24_101500_CardenzaSynth.png", "--scale", "4", "--json"])).saved[0];
  assert.equal(path.basename(big.path), "2026-11-24_101500_CardenzaSynth-4x.png");
  assert.deepEqual([big.width, big.height, big.scale], [960, 540, 4]);
  const pixels = decodePng(fs.readFileSync(big.path));
  assert.deepEqual([pixels.width, pixels.height], [960, 540]);
  for (const [x, y] of [[0, 0], [3, 3], [4, 0], [281, 201], [959, 539]]) {
    const at = (y * 960 + x) * 3;
    assert.deepEqual([...pixels.data.subarray(at, at + 3)], widen(fakePixel(Math.floor(x / 4), Math.floor(y / 4))), `${x},${y}`);
  }
  const one = ok(await cli(["screenshots", "download", "7ces8nvr", "--out", "home.png", "--json"])).saved[0];
  assert.equal(one.path, path.join(work, "home.png"));
  refused(await cli(["screenshots", "download", "q4hzuufx", "--scale", "40", "--json"]), 2, "usage");
  refused(await cli(["screenshots", "download", "q4hzuufx", "7ces8nvr", "--out", "home.png", "--json"]), 2, "usage");
});

test("screenshots public, private, rename: changed once, a run again changes nothing; a title over 80 is refused here", async () => {
  const made = ok(await cli(["screenshots", "public", "q4hzuufx", "--json"]));
  assert.deepEqual([made.status, made.screenshot.public], ["changed", true]);
  assert.equal(ok(await cli(["screenshots", "public", "q4hzuufx", "--json"])).status, "unchanged");
  assert.equal(shots.get("q4hzuufx").edits, 1, "not asked again");
  assert.match((await cli(["screenshots", "private", "q4hzuufx"])).stdout, /private, only you see it now/);
  const renamed = ok(await cli(["screenshots", "rename", "q4hzuufx", "The", "step", "sequencer", "--json"]));
  assert.equal(renamed.screenshot.title, "The step sequencer");
  assert.equal(ok(await cli(["screenshots", "rename", "q4hzuufx", "", "--json"])).screenshot.title, null, '"" removes it');
  refused(await cli(["screenshots", "rename", "q4hzuufx", "x".repeat(81), "--json"]), 2, "usage");
  assert.equal(ok(await cli(["screenshots", "public", "pub0pub0", "--json"])).status, "unchanged", "someone's public one is public");
  refused(await cli(["screenshots", "private", "pub0pub0", "--json"]), 1, "forbidden");
  refused(await cli(["screenshots", "public", "q4hzuufx", "--json"], {token: ""}), 4, "signin_required");
});

test("screenshots upload: the PNG as the body and its headers; already there, deleted by its owner, a full account; checked here first", async () => {
  const file = path.join(work, "2026-11-24_103000_CardenzaSynth.png");
  fs.writeFileSync(file, devicePng);
  const dry = ok(await cli(["screenshots", "upload", file, "--device", "3", "--dry-run", "--json"]));
  assert.deepEqual([dry.status, dry.plan[0].name, dry.plan[0].taken_at, dry.plan[0].device], ["dry_run", "2026-11-24_103000_CardenzaSynth.png", "2026-11-24T10:30:00.000Z", 3]);
  assert.equal(uploads.length, 0, "--dry-run sends nothing");
  const up = ok(await cli(["screenshots", "upload", file, "--device", "3", "--json"])).uploaded[0];
  assert.equal(up.status, "uploaded");
  const sent = uploads.at(-1);
  assert.equal(sent.headers["content-type"], "image/png");
  assert.equal(sent.headers["x-screenshot-name"], "2026-11-24_103000_CardenzaSynth.png");
  assert.equal(sent.headers["x-taken-at"], String(Date.UTC(2026, 10, 24, 10, 30) / 1000));
  assert.equal(sent.headers["x-device-id"], "3");
  assert.equal(sent.headers.authorization, "Bearer " + TOKEN);
  assert.equal(sent.bytes, devicePng.length);
  assert.deepEqual(shots.get(up.screenshot.id).png, devicePng);
  const plain = path.join(work, "Screen Shot.png");
  fs.writeFileSync(plain, devicePng);
  const first = ok(await cli(["screenshots", "upload", plain, "--json"])).uploaded[0];
  assert.deepEqual([first.name, uploads.at(-1).headers["x-taken-at"], uploads.at(-1).headers["x-device-id"]], ["Screen-Shot.png", undefined, undefined]);
  assert.equal(ok(await cli(["screenshots", "upload", plain, "--json"])).uploaded[0].status, "already_there");
  assert.match((await cli(["screenshots", "upload", plain])).stdout, /has Screen-Shot\.png already/);
  tombstones.add("gone.png");
  const gone = path.join(work, "gone.png");
  fs.writeFileSync(gone, devicePng);
  assert.equal(ok(await cli(["screenshots", "upload", gone, "--json"])).uploaded[0].status, "deleted_by_owner");
  // Checked here before anything is sent: not a PNG, too large, too wide, missing.
  const count = uploads.length;
  fs.writeFileSync(path.join(work, "notes.png"), "hello");
  refused(await cli(["screenshots", "upload", plain, "notes.png", "--json"]), 1, "invalid");
  fs.writeFileSync(path.join(work, "huge.png"), Buffer.concat([devicePng, Buffer.alloc(262144)]));
  refused(await cli(["screenshots", "upload", "huge.png", "--json"]), 1, "too_large");
  fs.writeFileSync(path.join(work, "wide.png"), pngOf({width: 1025, height: 1, type: 0, rows: [new Array(1025).fill(0)]}));
  refused(await cli(["screenshots", "upload", "wide.png", "--json"]), 1, "invalid");
  refused(await cli(["screenshots", "upload", "missing.png", "--json"]), 1, "file_not_found");
  assert.equal(uploads.length, count, "nothing sent");
  quotaFull = true;
  const full = refused(await cli(["screenshots", "upload", file, "--json"]), 1, "quota_full");
  assert.match(full.hint, /1000, or 200 MB/);
  assert.match(full.next[0], /screenshots list --all/);
  quotaFull = false;
});

test("screenshots delete: asks (a program needs --yes), deletes, a run again is done; an older community says it has none", async () => {
  const asked = refused(await cli(["screenshots", "delete", "7ces8nvr", "--json"]), 6, "needs_confirmation");
  assert.match(asked.next[0], /screenshots delete 7ces8nvr .*--yes --json$/);
  assert.ok(shots.has("7ces8nvr"));
  const done = ok(await cli(["screenshots", "delete", "7ces8nvr", "--yes", "--json"]));
  assert.deepEqual(done.deleted, [{id: "7ces8nvr", name: "2026-11-24_101600_CardenzaSynth.png", status: "deleted"}]);
  assert.ok(!shots.has("7ces8nvr"));
  assert.deepEqual(ok(await cli(["screenshots", "delete", "7ces8nvr", "--yes", "--json"])).deleted, [{id: "7ces8nvr", name: null, status: "already_deleted"}]);
  refused(await cli(["screenshots", "delete", "no-such_name.png", "--yes", "--json"]), 1, "not_found");

  for (const args of [["screenshots", "list"], ["screenshots", "show", "q4hzuufx"], ["screenshots", "download", "q4hzuufx"], ["screenshots", "public", "q4hzuufx"]]) {
    const r = refused(await cli([...args, "--json"], {api: old.api}), 1, "screenshots_unavailable");
    assert.match(r.error, /has no screenshots yet/);
    assert.match(r.hint, /board screenshot --no-save/);
  }
  const file = path.join(work, "late.png");
  fs.writeFileSync(file, devicePng);
  refused(await cli(["screenshots", "upload", file, "--json"], {api: old.api}), 1, "screenshots_unavailable");
});
