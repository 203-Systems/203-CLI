// A firmware's pictures (the community's "Pictures"): the gallery shown large above the description and the
// description's own, against a stand-in API that keeps them as the community does: firmware images add / list / edit /
// order / remove / prune, and a page text's local pictures uploaded by firmware edit --description-file (once: a
// picture the firmware has is found by its SHA-256). The community runs these against its whole API in its own tests.
// Run: node --test tests/images.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {run, standInApi} from "./fixtures.mjs";

const TOKEN = "cct_" + "b".repeat(64);
const CODE = "K7M2QX";
let stand, home, work, fw, seq = 0;
const ids = () => "abcdefghjkmnpqrstuvwxyz23456789".split("");
const newId = () => { seq++; const a = ids(); return Array.from({length: 8}, (_, i) => a[(seq * 7 + i * 3) % a.length]).join(""); };
const pending = new Map();   // id -> {place, caption, mime, size}

// A PNG header (signature, IHDR with its size) and some bytes that make each picture its own.
function png(width, height, salt) {
  const out = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0);
  out.writeUInt32BE(width, 16); out.writeUInt32BE(height, 20);
  out.write(String(salt), 40);
  return out;
}

before(async () => {
  fw = {code: CODE, name: "Pocket Tracker", owner: {id: "u1", name: "Tester"}, can: {edit: true, release: true}, description: "", images: [], description_images: []};
  stand = await standInApi(async (req, send, body, raw) => {
    const url = {pathname: req.url.split("?")[0]};
    const json = body ? JSON.parse(body.startsWith("{") ? body : "{}") : {};
    if (url.pathname === "/api/") return send(200, {version: 2, limits: {}});
    if (url.pathname === "/api/me") return send(200, {id: "u1", name: "Tester", role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203cli"}});
    if (url.pathname === `/api/firmware/${CODE}` && req.method === "GET") return send(200, fw);
    if (url.pathname === `/api/firmware/${CODE}/edit`) { Object.assign(fw, json); return send(200, fw); }
    if (url.pathname === `/api/firmware/${CODE}/images` && req.method === "POST") {
      const place = json.place ?? "gallery";
      const list = place === "gallery" ? fw.images : fw.description_images;
      if (list.length >= (place === "gallery" ? 9 : 20)) return send(409, {error: "full", code: "conflict", field: place === "gallery" ? "images" : "description_images"});
      const id = newId();
      pending.set(id, {place, caption: json.caption ?? "", size: json.size});
      return send(200, {image: {id}, upload: {url: `${stand.api}/upload/${id}`, method: "PUT", headers: {"Content-Type": json.mime}}});
    }
    let m = /^\/api\/upload\/(\w+)$/.exec(url.pathname);
    if (m) { pending.get(m[1]).sha = crypto.createHash("sha256").update(raw).digest("hex"); return send(200, {}); }
    m = /^\/api\/firmware\/\w+\/images\/(\w+)\/(done|edit|delete)$/.exec(url.pathname);
    const all = () => [...fw.images, ...fw.description_images];
    if (m && m[2] === "done") {
      const p = pending.get(m[1]);
      pending.delete(m[1]);
      (p.place === "gallery" ? fw.images : fw.description_images).push({id: m[1], url: `/files/${m[1]}.png`, caption: p.caption, width: 16, height: 9, sha256: p.sha});
      return send(200, fw);
    }
    if (m) {
      const x = all().find(y => y.id === m[1]);
      if (!x) return send(404, {error: "This firmware has no picture with this id", code: "not_found"});
      const out = () => { fw.images = fw.images.filter(y => y !== x); fw.description_images = fw.description_images.filter(y => y !== x); };
      if (m[2] === "delete") { out(); return send(200, fw); }
      if (json.caption !== undefined) x.caption = json.caption;
      if (json.place) { out(); (json.place === "gallery" ? fw.images : fw.description_images).push(x); }
      return send(200, fw);
    }
    if (url.pathname === `/api/firmware/${CODE}/images/order`) {
      fw.images = json.ids.map(id => fw.images.find(x => x.id === id));
      return send(200, fw);
    }
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-images-"));
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "docs/home.png"), png(240, 135, "home"));
  fs.writeFileSync(path.join(work, "docs/seq.png"), png(480, 270, "seq"));
  fs.writeFileSync(path.join(work, "docs/flow.png"), png(1600, 900, "flow"));
  fs.writeFileSync(path.join(work, "docs/anim.gif"), Buffer.from("GIF89a" + "x".repeat(40)));
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = args => run(["--api", stand.api, ...args, "--json"], {cwd: work, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: TOKEN, CI: "1"}});
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result.json; };

test("firmware images add: the gallery, then the description (with its reference); a picture it has is skipped; checks first", async () => {
  const dry = ok(await cli(["firmware", "images", "add", CODE, "docs/home.png", "--caption", "The home screen", "--dry-run"]));
  assert.equal(dry.status, "dry_run");
  assert.match(dry.plan[0], /add docs[\\/]home\.png \(240x135 PNG.*to the gallery.*"The home screen"/);
  const added = ok(await cli(["firmware", "images", "add", CODE, "docs/home.png", "--caption", "The home screen"]));
  assert.equal(added.status, "added");
  assert.equal(fw.images.length, 1);
  assert.equal(fw.images[0].caption, "The home screen");
  const again = ok(await cli(["firmware", "images", "add", CODE, "docs/home.png"]));
  assert.equal(again.status, "already_there", "a re-run changes nothing");
  assert.equal(fw.images.length, 1);
  const text = ok(await cli(["firmware", "images", "add", CODE, "docs/flow.png", "--description"]));
  assert.equal(text.added[0].place, "description");
  assert.equal(text.added[0].reference, `![](image:${fw.description_images[0].id})`);
  const gif = await cli(["firmware", "images", "add", CODE, "docs/anim.gif"]);
  assert.equal(gif.code, 1);
  assert.equal(gif.error.code, "wrong_file");
  assert.match(gif.error.error, /a GIF/);
  const two = await cli(["firmware", "images", "add", CODE, "docs/home.png", "docs/seq.png", "--caption", "x"]);
  assert.equal(two.code, 2, "one caption is for one picture");
  const long = await cli(["firmware", "images", "add", CODE, "docs/seq.png", "--caption", "y".repeat(61)]);
  assert.equal(long.error.field, "caption");
});

test("firmware images list, edit, order, remove and prune", async () => {
  ok(await cli(["firmware", "images", "add", CODE, "docs/seq.png"]));
  const listed = ok(await cli(["firmware", "images", "list", CODE]));
  assert.deepEqual(listed.gallery.map(x => x.caption), ["The home screen", ""]);
  assert.equal(listed.description.length, 1);
  assert.equal(listed.description[0].in_description, false);
  assert.deepEqual(listed.room, {gallery: 7, description: 19});
  const [home, seq] = fw.images.map(x => x.id);
  // The order: the ids given first.
  assert.deepEqual(ok(await cli(["firmware", "images", "order", CODE, seq])).gallery, [seq, home]);
  assert.equal(ok(await cli(["firmware", "images", "order", CODE, seq])).status, "unchanged");
  const notThere = await cli(["firmware", "images", "order", CODE, fw.description_images[0].id]);
  assert.equal(notThere.error.code, "not_found");
  assert.match(notThere.error.hint, /--place gallery/);
  // A caption, a place.
  assert.equal(ok(await cli(["firmware", "images", "edit", CODE, seq, "--caption", "Sixteen steps a page"])).picture.caption, "Sixteen steps a page");
  assert.equal(ok(await cli(["firmware", "images", "edit", CODE, seq.toUpperCase(), "--caption", "Sixteen steps a page"])).status, "unchanged");
  const moved = ok(await cli(["firmware", "images", "edit", CODE, seq, "--place", "description"]));
  assert.equal(moved.picture.place, "description");
  assert.ok(fw.description_images.some(x => x.id === seq));
  assert.equal((await cli(["firmware", "images", "edit", CODE, "zzzzzzzz", "--caption", "x"])).error.code, "not_found");
  // Prune: the description's pictures its text does not use (the one it uses stays).
  fw.description = `Here:\n\n![](image:${seq})`;
  const plan = ok(await cli(["firmware", "images", "prune", CODE, "--dry-run"]));
  assert.equal(plan.plan.length, 1);
  assert.match(plan.plan[0], new RegExp(fw.description_images.find(x => x.id !== seq).id));
  const confirm = await cli(["firmware", "images", "prune", CODE]);
  assert.equal(confirm.code, 6, "needs --yes");
  assert.deepEqual(ok(await cli(["firmware", "images", "prune", CODE, "--yes"])).description_images, [seq]);
  // Remove: needs --yes; warns when the description names it; again: already deleted.
  assert.equal((await cli(["firmware", "images", "remove", CODE, seq])).code, 6);
  const removed = ok(await cli(["firmware", "images", "remove", CODE, seq, "--yes"]));
  assert.deepEqual(removed.removed, [seq]);
  assert.equal(removed.advice[0].code, "in_description");
  assert.equal(ok(await cli(["firmware", "images", "remove", CODE, seq, "--yes"])).status, "already_deleted");
});

test("firmware edit --description-file: its local pictures go up once and become image:<id>; other sites' stay links", async () => {
  fs.writeFileSync(path.join(work, "docs/page.md"), "# Pocket Tracker\n\nThe grid:\n\n![The grid](seq.png) ![](./flow.png)\n\nAnd ![a photo](https://github.com/a.png).\n");
  const before = fw.description_images.length;
  const dry = ok(await cli(["firmware", "edit", CODE, "--description-file", "docs/page.md", "--dry-run"]));
  assert.ok(dry.plan.some(step => /upload docs[\\/]seq\.png .*into the description/.test(step)), JSON.stringify(dry.plan));
  assert.ok(dry.warnings.some(w => w.code === "remote_pictures"));
  ok(await cli(["firmware", "edit", CODE, "--description-file", "docs/page.md"]));
  const seq = fw.description_images.find(x => x.sha256 === crypto.createHash("sha256").update(fs.readFileSync(path.join(work, "docs/seq.png"))).digest("hex"));
  assert.ok(seq, "seq.png went up");
  assert.match(fw.description, new RegExp(`!\\[The grid\\]\\(image:${seq.id}\\) !\\[\\]\\(image:\\w{8}\\)`));
  assert.match(fw.description, /!\[a photo\]\(https:\/\/github\.com\/a\.png\)/, "another site's stays as written");
  const count = fw.description_images.length;
  assert.ok(count > before);
  // Again: nothing goes up, nothing changes.
  const again = ok(await cli(["firmware", "edit", CODE, "--description-file", "docs/page.md", "--dry-run"]));
  assert.ok(again.plan.some(step => /nothing differs/.test(step)), JSON.stringify(again.plan));
  ok(await cli(["firmware", "edit", CODE, "--description-file", "docs/page.md"]));
  assert.equal(fw.description_images.length, count);
  // A picture that is not there, or a GIF: a warning, the text as written; pictures in code are not read.
  fs.writeFileSync(path.join(work, "docs/broken.md"), "![](missing.png)\n\n![](anim.gif)\n\n```\n![](nowhere.png)\n```\n\nInline: `![](nowhere.png)`\n");
  const missing = ok(await cli(["firmware", "edit", CODE, "--description-file", "docs/broken.md"]));
  assert.deepEqual(missing.advice.filter(w => w.code === "picture_skipped").map(w => /missing\.png|anim\.gif/.exec(w.message)[0]), ["missing.png", "anim.gif"]);
  assert.match(missing.advice.find(w => /anim\.gif/.test(w.message)).message, /a GIF/);
  assert.equal(fw.description.trim(), fs.readFileSync(path.join(work, "docs/broken.md"), "utf8").trim(), "as written");
});
