// A model's cover and pictures (the community's "Models": covers and pictures): models cover, models images add / list / edit /
// order / remove, and models upload --cover --image, against a stand-in API that keeps them as the community does; and the
// card's 3D picture 203cli draws from an STL (1280x720, transparent around the part, renderer 1; --thumbnail: one's own, 0).
// The community runs these against its whole API in its own tests.
// Run: node --test tests/model-media.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {run, standInApi} from "./fixtures.mjs";
import {binaryStl, deviceCase, renderThumbnail} from "../scripts/stl.mjs";

const TOKEN = "cct_" + "c".repeat(64);
const ID = "ab2cd3ef";
let stand, home, work, model, made = null, seq = 0;
const letters = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => { seq++; return Array.from({length: 8}, (_, i) => letters[(seq * 7 + i * 3) % letters.length]).join(""); };
const pending = new Map();   // id -> {caption, sha}
let coverPending = null;

function png(width, height, salt) {
  const out = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0);
  out.writeUInt32BE(width, 16); out.writeUInt32BE(height, 20);
  out.write(String(salt), 40);
  return out;
}

before(async () => {
  model = {id: ID, title: "Desk stand", author: {id: "u1", name: "Tester"}, can: {edit: true}, cover: null, images: []};
  stand = await standInApi(async (req, send, body, raw) => {
    const url = req.url.split("?")[0];
    const json = body ? JSON.parse(body.startsWith("{") ? body : "{}") : {};
    if (url === "/api/") return send(200, {version: 2, limits: {}});
    if (url === "/api/me") return send(200, {id: "u1", name: "Tester", role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203cli"}});
    const target = () => (made && url.startsWith(`/api/models/${made.id}`) ? made : model);
    if (url === `/api/models/${ID}` && req.method === "GET") return send(200, model);
    if (url === "/api/models/zz2zz2zz" && req.method === "GET") return send(200, {...model, id: "zz2zz2zz", can: {edit: false}, author: {id: "u9", name: "Someone"}});
    if (url === "/api/models" && req.method === "POST") {
      made = {id: "nw2nw2nw", title: json.title, author: {id: "u1", name: "Tester"}, can: {edit: true}, cover: null, images: [], thumbnail: json.thumbnail};
      return send(201, {model: made, uploads: [...json.files.map(f => ({slot: f.name})), {slot: "preview"}, {slot: "thumbnail"}]
        .map(u => ({...u, url: `${stand.api}/slot/${u.slot}`, method: "PUT", headers: {}}))});
    }
    if (/^\/api\/slot\//.test(url)) { if (url.endsWith("/thumbnail")) made.thumbBytes = raw; return send(200, {}); }
    if (made && url === `/api/models/${made.id}/done`) return send(200, made);
    let m = /^\/api\/models\/(\w+)\/cover$/.exec(url);
    if (m) { coverPending = {mime: json.mime}; return send(200, {upload: {url: `${stand.api}/upload/cover`, method: "PUT", headers: {"Content-Type": json.mime}}}); }
    if (url === "/api/upload/cover") { coverPending.sha = crypto.createHash("sha256").update(raw).digest("hex"); return send(200, {}); }
    m = /^\/api\/models\/(\w+)\/cover\/(done|delete)$/.exec(url);
    if (m) { target().cover = m[2] === "done" ? {url: "/files/cover.png", size: 64, sha256: coverPending.sha} : null; return send(200, target()); }
    m = /^\/api\/models\/(\w+)\/images$/.exec(url);
    if (m && req.method === "POST") {
      if (target().images.length >= 9) return send(409, {error: "full", code: "conflict", field: "images"});
      const id = newId();
      pending.set(id, {caption: json.caption ?? ""});
      return send(200, {image: {id}, upload: {url: `${stand.api}/upload/${id}`, method: "PUT", headers: {"Content-Type": json.mime}}});
    }
    m = /^\/api\/upload\/(\w+)$/.exec(url);
    if (m) { pending.get(m[1]).sha = crypto.createHash("sha256").update(raw).digest("hex"); return send(200, {}); }
    if (/^\/api\/models\/\w+\/images\/order$/.test(url)) { model.images = json.ids.map(id => model.images.find(x => x.id === id)); return send(200, model); }
    m = /^\/api\/models\/\w+\/images\/(\w+)\/(done|edit|delete)$/.exec(url);
    if (m && m[2] === "done") {
      const p = pending.get(m[1]);
      target().images.push({id: m[1], url: `/files/${m[1]}.png`, caption: p.caption, width: 16, height: 9, sha256: p.sha});
      return send(200, target());
    }
    if (m) {
      const x = model.images.find(y => y.id === m[1]);
      if (!x) return send(404, {error: "This model has no picture with this id", code: "not_found"});
      if (m[2] === "delete") model.images = model.images.filter(y => y !== x);
      else x.caption = json.caption;
      return send(200, model);
    }
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-models-"));
  fs.writeFileSync(path.join(work, "cover.png"), png(1280, 720, "cover"));
  fs.writeFileSync(path.join(work, "printed.png"), png(1600, 900, "printed"));
  fs.writeFileSync(path.join(work, "desk.png"), png(1600, 900, "desk"));
  fs.writeFileSync(path.join(work, "stand.stl"), binaryStl(deviceCase()));
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = args => run(["--api", stand.api, ...args, "--json"], {cwd: work, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: TOKEN, CI: "1"}});
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result.json; };

test("models cover: set (a dry run first, the same picture again changes nothing), then removed with --yes", async () => {
  const dry = ok(await cli(["models", "cover", ID, "cover.png", "--dry-run"]));
  assert.equal(dry.status, "dry_run");
  assert.match(dry.plan[0], /set the cover of Desk stand to cover\.png \(1280x720 PNG/);
  assert.equal(model.cover, null, "a dry run changes nothing");
  const set = ok(await cli(["models", "cover", ID, "cover.png"]));
  assert.equal(set.cover.url, "/files/cover.png");
  const again = ok(await cli(["models", "cover", ID, "cover.png"]));
  assert.equal(again.cover.url, "/files/cover.png", "the same picture: nothing uploaded");
  const asked = await cli(["models", "cover", ID, "--remove"]);
  assert.equal(asked.error.code, "needs_confirmation");
  assert.equal(ok(await cli(["models", "cover", ID, "--remove", "--yes"])).cover, null);
  const theirs = await cli(["models", "cover", "zz2zz2zz", "cover.png"]);
  assert.equal(theirs.error.code, "not_yours");
  assert.equal((await cli(["models", "cover", "nope", "cover.png"])).error.code, "usage");
});

test("models images: add (a picture it has is skipped), list, edit, order, remove", async () => {
  const added = ok(await cli(["models", "images", "add", ID, "printed.png", "--caption", "Printed in PETG"]));
  assert.equal(added.status, "added");
  assert.equal(model.images[0].caption, "Printed in PETG");
  assert.equal(ok(await cli(["models", "images", "add", ID, "printed.png"])).status, "already_there");
  ok(await cli(["models", "images", "add", ID, "desk.png"]));
  const listed = ok(await cli(["models", "images", "list", ID]));
  assert.deepEqual(listed.pictures.map(x => x.caption), ["Printed in PETG", ""]);
  assert.equal(listed.room, 7);
  const [printed, desk] = model.images.map(x => x.id);
  assert.equal(ok(await cli(["models", "images", "edit", ID, desk, "--caption", "On the desk"])).picture.caption, "On the desk");
  assert.deepEqual(ok(await cli(["models", "images", "order", ID, desk])).pictures, [desk, printed]);
  assert.equal(ok(await cli(["models", "images", "order", ID, desk])).status, "unchanged");
  assert.equal((await cli(["models", "images", "edit", ID, "zzzzzzzz", "--caption", "x"])).error.code, "not_found");
  assert.equal((await cli(["models", "images", "add", ID, "desk.png", "printed.png", "--caption", "x"])).code, 2, "one caption, one picture");
  assert.equal(ok(await cli(["models", "images", "remove", ID, desk, "--yes"])).status, "removed");
  assert.deepEqual(model.images.map(x => x.id), [printed]);
  assert.equal(ok(await cli(["models", "images", "remove", ID, desk, "--yes"])).status, "already_deleted");
});

test("models upload --cover --image: the model, then its cover and pictures; the card's picture drawn by 203cli (renderer 1)", async () => {
  const dry = ok(await cli(["models", "upload", "stand.stl", "--title", "Stand", "--license", "CC0-1.0", "--cover", "cover.png", "--image", "printed.png", "--image", "desk.png", "--dry-run"]));
  assert.ok(dry.plan.some(x => /its cover: cover\.png/.test(x)));
  assert.equal(dry.plan.filter(x => /a picture:/.test(x)).length, 2);
  const up = ok(await cli(["models", "upload", "stand.stl", "--title", "Stand", "--license", "CC0-1.0", "--cover", "cover.png", "--image", "printed.png", "--image", "desk.png"]));
  assert.equal(up.cover.url, "/files/cover.png");
  assert.equal(up.images.length, 2);
  assert.equal(made.thumbnail.renderer, 1, "203cli's own render");
  const head = new DataView(made.thumbBytes.buffer, made.thumbBytes.byteOffset);
  assert.deepEqual([head.getUint32(16), head.getUint32(20), made.thumbBytes[25]], [1280, 720, 6], "1280x720 RGBA");
  const own = ok(await cli(["models", "upload", "stand.stl", "--title", "Own", "--license", "CC0-1.0", "--thumbnail", "cover.png"]));
  assert.equal(own.id, made.id);
  assert.equal(made.thumbnail.renderer, 0, "a picture of one's own");
});

test("the card's picture: transparent around the part, the part opaque in the middle, a soft shadow under it", () => {
  const bytes = renderThumbnail(deviceCase(), {width: 320, height: 180});
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.deepEqual([view.getUint32(16), view.getUint32(20), bytes[24], bytes[25]], [320, 180, 8, 6]);
  // Inflate the IDAT and read the pixels (filter 0 on every row).
  let at = 8, idat = [];
  while (at < bytes.length) {
    const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const alpha = (x, y) => raw[y * (320 * 4 + 1) + 1 + x * 4 + 3];
  assert.equal(alpha(0, 0), 0, "a corner is clear");
  assert.equal(alpha(160, 90), 255, "the middle is the part");
  const soft = [];
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) if (alpha(x, y) > 0 && alpha(x, y) < 160) soft.push(alpha(x, y));
  assert.ok(soft.length > 200, "the contact shadow fades out");
});
