// A publish with 203c and the page the community wants (the user, 2026-11-20): the gallery must end with 3-5 different
// screenshots (signed in yourself; a trusted-publishing run only warns, with a GitHub annotation; a launcher is not held to
// it), the description is short (over 1500 characters a warning, over 3000 refused, pictures not counted, an unchanged
// one passes, the template's placeholders refused), init writes docs/description.md, help description prints the guide.
// Against a stand-in API that keeps a firmware as the community does. Run: node --test tests/gallery.test.mjs
import {test, before, after, beforeEach} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {appImage, run, standInApi} from "./fixtures.mjs";
import {descriptionLength, descriptionTemplate, galleryRule, guidePart, placeholderIn} from "../scripts/description.mjs";

const TOKEN = "cct_" + "c".repeat(64);
const CODE = "K7M2QX";
let stand, home, work, fw, account, versions, seq = 0;
const pending = new Map();
const newId = () => { seq++; const a = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from({length: 8}, (_, i) => a[(seq * 7 + i * 5) % a.length]).join(""); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function png(salt) {
  const out = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0);
  out.writeUInt32BE(240, 16); out.writeUInt32BE(135, 20);
  out.write(String(salt), 40);
  return out;
}
const picture = name => ({id: newId(), url: `/files/${name}.png`, caption: "", width: 240, height: 135, sha256: sha(png(name))});
const person = {id: "u1", name: "Tester", role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203c"}};
const trusted = {id: "u1", name: "Tester", role: "user", scopes: ["publish"], credential: {kind: "oidc", firmware: CODE, channel_allowed: ["dev"]}};

beforeEach(() => {
  fw = {code: CODE, name: "Pocket Tracker", kind: "app", summary: "A tracker for the Cardenza", owner: {id: "u1", name: "Tester"}, can: {edit: true, release: true},
    channels: {stable: true, beta: false, dev: true}, description: "", images: [], description_images: [], tags: ["tool"], targets: ["cardenza"], latest: {}};
  account = person;
  versions = [];
  stand.requests.length = 0;
});

before(async () => {
  stand = await standInApi(async (req, send, body, raw) => {
    const url = new URL(req.url, "http://stand-in.test");
    const json = body && body.startsWith("{") ? JSON.parse(body) : {};
    const p = url.pathname;
    if (p === "/api/") return send(200, {version: 2, limits: {}});
    if (p === "/api/me") return send(200, account);
    if (p === "/api/targets") return send(200, {items: [{target: "cardenza", format: "esp"}]});
    if (p === "/api/me/firmware") return send(200, {items: [], total: 0, page: 1});
    if (p === "/api/firmware/lookup") return send(200, {items: []});
    if (p === "/api/firmware" && req.method === "POST") return send(200, url.searchParams.get("dry_run") ? {} : {...fw, code: "N3WC0D"});
    if (p === `/api/firmware/${CODE}` && req.method === "GET") return send(200, fw);
    if (p === `/api/firmware/${CODE}/edit`) { Object.assign(fw, json); return send(200, fw); }
    if (p === `/api/firmware/${CODE}/versions` && req.method === "GET") return send(200, {items: versions, total: versions.length, page: 1});
    if (p === `/api/firmware/${CODE}/versions` && req.method === "POST") {
      if (url.searchParams.get("dry_run")) return send(200, {});
      const version = {code: "V2345A", version: json.version, channel: json.channel, status: "draft", targets: [{target: "cardenza"}]};
      versions.push(version);
      return send(200, {version, uploads: [{target: "cardenza", upload_url: `${stand.api}/bin`, ticket: "t"}]});
    }
    if (p === "/api/bin") return send(200, {sha256: sha(raw)});
    if (p === `/api/firmware/${CODE}/versions/V2345A/publish`) {
      Object.assign(versions[0], {status: "published", targets: [{target: "cardenza", sha256: null, size: 1}]});
      return send(200, versions[0]);
    }
    if (p === "/api/versions/V2345A") return send(200, {version: versions[0]});
    if (p === `/api/firmware/${CODE}/images` && req.method === "POST") {
      const id = newId();
      pending.set(id, {place: json.place ?? "gallery", caption: json.caption ?? ""});
      return send(200, {image: {id}, upload: {url: `${stand.api}/upload/${id}`, method: "PUT", headers: {"Content-Type": json.mime}}});
    }
    let m = /^\/api\/upload\/(\w+)$/.exec(p);
    if (m) { pending.get(m[1]).sha = sha(raw); return send(200, {}); }
    m = /^\/api\/firmware\/\w+\/images\/(\w+)\/(done|edit|delete)$/.exec(p);
    if (m && m[2] === "done") {
      const x = pending.get(m[1]);
      (x.place === "gallery" ? fw.images : fw.description_images).push({id: m[1], url: `/files/${m[1]}.png`, caption: x.caption, width: 240, height: 135, sha256: x.sha});
      return send(200, fw);
    }
    if (m) {
      const x = [...fw.images, ...fw.description_images].find(y => y.id === m[1]);
      if (!x) return send(404, {error: "No such picture", code: "not_found"});
      const out = () => { fw.images = fw.images.filter(y => y !== x); fw.description_images = fw.description_images.filter(y => y !== x); };
      if (m[2] === "delete") { out(); return send(200, fw); }
      if (json.caption !== undefined) x.caption = json.caption;
      if (json.place) { out(); (json.place === "gallery" ? fw.images : fw.description_images).push(x); }
      return send(200, fw);
    }
    if (p === `/api/firmware/${CODE}/images/order`) { fw.images = json.ids.map(id => fw.images.find(x => x.id === id)); return send(200, fw); }
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203c-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203c-gallery-"));
  fs.mkdirSync(path.join(work, "build"));
  fs.writeFileSync(path.join(work, "build/app.bin"), await appImage({name: "pocket_tracker"}));
  fs.mkdirSync(path.join(work, "docs/screens"), {recursive: true});
  for (const n of [1, 2, 3, 4, 5, 6]) fs.writeFileSync(path.join(work, `docs/screens/${n}.png`), png(n));
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = (args, {env = {}, cwd = work} = {}) => run(["--api", stand.api, ...args, "--json"],
  {cwd, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: TOKEN, CI: "1", GITHUB_ACTIONS: "", ...env}});
const PUBLISH = ["publish", "--firmware", CODE, "--bin", "build/app.bin", "--channel", "dev", "--version", "1.2.3", "--no-sim", "--no-source"];
const writes = () => stand.requests.filter(q => q.method !== "GET" && !/dry_run=1/.test(q.url));
const project = (dir, publish) => fs.writeFileSync(path.join(dir, "203.json"), JSON.stringify({format: 1, name: "Pocket Tracker", code: CODE,
  summary: "A tracker for the Cardenza", tags: ["tool"], devices: ["cardenza"], publish: {channel: "dev", bins: {cardenza: "build/app.bin"}, ...publish}}, null, 2));
const inProject = (publish, fn) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "203c-project-"));
  fs.cpSync(work, dir, {recursive: true});
  project(dir, publish);
  try { await fn(dir); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
};

test("the rules: the description's length without pictures, the template's placeholders, the gallery's 3-5", () => {
  assert.equal(descriptionLength("  ab\r\n![x](image:abcdefgh)c  "), 4);
  assert.equal(descriptionLength("![shot](IMAGE:new-1)"), 0);
  assert.equal(descriptionLength("![shot](https://example.test/a.png)"), "![shot](https://example.test/a.png)".length, "another site's picture is a link: counted");
  assert.match(descriptionTemplate("en"), /^<What it is and who it is for/);
  assert.match(descriptionTemplate("zh"), /## 功能/);
  assert.equal(placeholderIn("A synth.\n\n## Features\n- <A second feature>\n"), "<A second feature>");
  assert.equal(placeholderIn("Press <Fn> for the menu"), null, "only the template's own placeholders");
  assert.match(guidePart("zh"), /^# 怎样写固件简介/);
  assert.deepEqual(galleryRule([{sha: "a"}, {sha: "b"}]).problem, "few");
  assert.deepEqual(galleryRule([{sha: "a"}, {sha: "b"}, {sha: "c"}]).ok, true);
  assert.deepEqual(galleryRule([1, 2, 3, 4, 5, 6].map(n => ({sha: String(n)}))).problem, "many");
  assert.deepEqual(galleryRule([{sha: "a", name: "x"}, {sha: "a", name: "y"}, {sha: "b"}]).duplicates, ["y"]);
  assert.equal(galleryRule([{sha: null}, {sha: null}, {sha: null}]).ok, true, "a picture whose SHA-256 is unknown counts as its own");
});

test("publish signed in yourself: refused before anything is uploaded unless the gallery holds 3-5 different pictures", async () => {
  const none = await cli(PUBLISH);
  assert.equal(none.code, 1, none.stderr);
  assert.equal(none.error.code, "gallery_pictures");
  assert.equal(none.error.field, "images");
  assert.equal(none.error.count, 0);
  assert.match(none.error.error, /0 pictures: 203c publishes a firmware with 3–5 different screenshots/);
  assert.match(none.error.hint, /board screen --out docs\/screens\/1\.png/);
  assert.match(none.error.next[0], /board screen --out docs\/screens\/1\.png/);
  assert.deepEqual(writes(), [], "nothing was sent");
  // The dry run says the same.
  const dry = await cli([...PUBLISH, "--dry-run"]);
  assert.equal(dry.code, 1);
  assert.equal(dry.json.status, "dry_run");
  assert.equal(dry.json.problems[0].code, "gallery_pictures");
  // In Chinese.
  const zh = await cli([...PUBLISH, "--lang", "zh"]);
  assert.match(zh.error.error, /图片只有 0 张：用 203c 发布，固件要有 3–5 张不同的截图/);
  assert.match(zh.error.hint, /203c board screen --out docs\/screens\/1\.png/);
  // Two the same.
  fw.images = [picture(1), picture(1), picture(2)];
  const same = await cli(PUBLISH);
  assert.equal(same.error.code, "gallery_pictures");
  assert.match(same.error.error, /the same picture twice/);
  assert.equal(same.error.duplicates.length, 1);
  // Six.
  fw.images = [1, 2, 3, 4, 5, 6].map(picture);
  assert.match((await cli(PUBLISH)).error.error, /6 pictures: 203c publishes with 3–5/);
  assert.deepEqual(writes(), []);
  // --image is publish.images on the command line.
  fw.images = [];
  const flagged = await cli([...PUBLISH, "--image", "docs/screens/1.png", "--image", "docs/screens/2.png", "--dry-run"]);
  assert.equal(flagged.json.problems[0].code, "gallery_pictures");
  assert.equal(flagged.json.problems[0].data.count, 2);
  // Three different ones: published.
  fw.images = [1, 2, 3].map(picture);
  const done = await cli(PUBLISH);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.json.status, "published");
  // Again: already published; a gallery that shrank meanwhile only warns (nothing is published).
  versions[0].targets = [{target: "cardenza", sha256: sha(fs.readFileSync(path.join(work, "build/app.bin")))}];
  fw.images = [picture(1)];
  const again = await cli(PUBLISH);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.status, "already_published");
  assert.ok(again.json.warnings.some(w => w.code === "gallery_short"), JSON.stringify(again.json.warnings));
});

test("publish.images is the gallery it leaves: 3-5 files, all different; it uploads them", inProject({images: ["docs/screens/1.png", "docs/screens/2.png"]}, async dir => {
  const few = await cli(["publish", "--version", "1.2.3", "--no-sim", "--no-source"], {cwd: dir});
  assert.equal(few.error.code, "gallery_pictures");
  assert.equal(few.error.count, 2);
  assert.deepEqual(writes(), []);
  project(dir, {images: ["docs/screens/1.png", "docs/screens/2.png", "docs/screens/2.png"]});
  const twice = await cli(["publish", "--version", "1.2.3", "--no-sim", "--no-source"], {cwd: dir});
  assert.equal(twice.error.code, "gallery_pictures");
  assert.match(twice.error.hint, /each file once \(publish\.images, --image\)/i);
  project(dir, {images: [1, 2, 3, 4, 5, 6].map(n => `docs/screens/${n}.png`)});
  const many = await cli(["publish", "--version", "1.2.3", "--no-sim", "--no-source"], {cwd: dir});
  assert.equal(many.error.code, "gallery_pictures");
  assert.match(many.error.hint, /Keep 3–5 in 203\.json's publish\.images/);
  assert.deepEqual(writes(), []);
  // The firmware has none; publish.images names three: they go up, then the version.
  project(dir, {images: ["docs/screens/1.png", {file: "docs/screens/2.png", caption: "The grid"}, "docs/screens/3.png"]});
  const done = await cli(["publish", "--version", "1.2.3", "--no-sim", "--no-source"], {cwd: dir});
  assert.equal(done.code, 0, done.stderr);
  assert.equal(fw.images.length, 3);
  assert.equal(fw.images[1].caption, "The grid");
  assert.equal(done.json.pictures.gallery.added, 3);
}));

test("a trusted-publishing run only warns about the gallery, with a GitHub annotation; JSON stays JSON", async () => {
  account = trusted;
  const done = await cli(PUBLISH, {env: {GITHUB_ACTIONS: "true"}});
  assert.equal(done.code, 0, done.stderr + done.stdout);
  assert.equal(done.json.status, "published");
  const w = done.json.warnings.find(x => x.code === "gallery_short");
  assert.ok(w, JSON.stringify(done.json.warnings));
  assert.match(w.message, /Pocket Tracker's gallery has 0 pictures: a firmware's page shows 3–5 different screenshots/);
  assert.match(w.hint, /Its owner fixes it once \(this release goes on\)/);
  assert.match(done.stderr, /^::warning title=203c%3A the gallery::Pocket Tracker's gallery has 0 pictures/m);
  // Outside GitHub Actions: no annotation; in a dry run too.
  versions.length = 0;
  const dry = await cli([...PUBLISH, "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout);
  assert.ok(dry.json.warnings.some(x => x.code === "gallery_short"));
  assert.doesNotMatch(dry.stderr, /::warning/);
  // Three pictures: nothing to say.
  fw.images = [1, 2, 3].map(picture);
  versions.length = 0;
  const fine = await cli([...PUBLISH, "--dry-run"]);
  assert.ok(!fine.json.warnings.some(x => x.code === "gallery_short"));
});

test("firmware images: add stops past 5, edit --place gallery stops at 5, taking pictures out below 3 warns; a launcher keeps 9", async () => {
  fw.images = [1, 2, 3, 4].map(picture);
  const many = await cli(["firmware", "images", "add", CODE, "docs/screens/5.png", "docs/screens/6.png"]);
  assert.equal(many.code, 1);
  assert.equal(many.error.code, "gallery_pictures");
  assert.match(many.error.error, /has 4 pictures: 2 more would be 6, and 203c publishes with 3–5/);
  assert.deepEqual(writes(), []);
  assert.equal((await cli(["firmware", "images", "add", CODE, "docs/screens/5.png"])).code, 0);
  fw.description_images = [picture(6)];
  const edit = await cli(["firmware", "images", "edit", CODE, fw.description_images[0].id, "--place", "gallery"]);
  assert.equal(edit.error.code, "gallery_pictures");
  // Out of the gallery below 3: allowed, with a word.
  fw.images = fw.images.slice(0, 3);
  const removed = await cli(["firmware", "images", "remove", CODE, fw.images[0].id, "--yes"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.json.advice.find(w => w.code === "gallery_short").message, "The gallery will have 2 pictures: the next 203c publish needs 3–5 different ones");
  const moved = await cli(["firmware", "images", "edit", CODE, fw.images[0].id, "--place", "description"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.ok(moved.json.advice.some(w => w.code === "gallery_short"));
  // A launcher's gallery is not held to 3-5.
  fw.kind = "launcher";
  fw.images = [1, 2, 3, 4, 5].map(picture);
  assert.equal((await cli(["firmware", "images", "add", CODE, "docs/screens/6.png"])).code, 0);
});

test("the description: over 1500 a warning, over 3000 refused, pictures not counted, an unchanged one passes", async () => {
  fw.images = [1, 2, 3].map(picture);
  const long = "A synth.\n\n" + "x".repeat(1600);
  fs.writeFileSync(path.join(work, "docs/long.md"), long);
  const warned = await cli(["firmware", "edit", CODE, "--description-file", "docs/long.md"]);
  assert.equal(warned.code, 0, warned.stderr);
  const w = warned.json.advice.find(x => x.code === "long_description");
  assert.match(w.message, /The description is 1610 characters \(pictures not counted\): over 1500/);
  assert.match(w.hint, /guide\/description/);
  // Too long: refused before anything is sent, in both languages.
  fs.writeFileSync(path.join(work, "docs/manual.md"), "A synth.\n\n" + "| key | does |\n|---|---|\n" + "| a | b |\n".repeat(400));
  stand.requests.length = 0;
  const refused = await cli(["firmware", "edit", CODE, "--description-file", "docs/manual.md"]);
  assert.equal(refused.code, 1);
  assert.equal(refused.error.code, "description_too_long");
  assert.equal(refused.error.max, 3000);
  assert.ok(refused.error.length > 3000);
  assert.match(refused.error.hint, /Key tables and every mode's keys go in its tutorial/);
  assert.match(refused.error.hint, /https:\/\/cardenza\.203\.io\/community\/guide\/description/);
  assert.deepEqual(writes(), []);
  const zh = await cli(["firmware", "edit", CODE, "--description-file", "docs/manual.md", "--lang", "zh"]);
  assert.match(zh.error.error, /^简介有 \d+ 个字符（插图不算），最多 3000。简介是给想安装的人看的产品介绍，不是说明书$/);
  // Pictures are not counted: 2960 characters and twenty pictures pass.
  fs.writeFileSync(path.join(work, "docs/pictures.md"), "y".repeat(2960) + "\n\n" + Array.from({length: 20}, (_, i) => `![a screen](image:abcdefg${"hjkmnpqrst"[i % 10]})`).join(" "));
  assert.equal((await cli(["firmware", "edit", CODE, "--description-file", "docs/pictures.md"])).code, 0);
  // The firmware's own long description, sent again unchanged (publish's page fields): passes.
  fw.description = "z".repeat(5000);
  fs.writeFileSync(path.join(work, "docs/same.md"), fw.description + "\n");
  const same = await cli(["firmware", "edit", CODE, "--description-file", "docs/same.md", "--summary", "A tracker for the Cardenza, faster"]);
  assert.equal(same.code, 0, same.stderr + same.stdout);
  // publish: refused too, before the version.
  stand.requests.length = 0;
  const pub = await cli([...PUBLISH, "--description-file", "docs/manual.md"]);
  assert.equal(pub.error.code, "description_too_long");
  assert.deepEqual(writes(), []);
});

test("the template's placeholders are refused; init writes docs/description.md; help description is the guide", async () => {
  fs.writeFileSync(path.join(work, "docs/template.md"), descriptionTemplate("en"));
  const filled = await cli(["firmware", "edit", CODE, "--description-file", "docs/template.md"]);
  assert.equal(filled.code, 2);
  assert.equal(filled.error.code, "placeholder");
  assert.equal(filled.error.field, "description");
  assert.match(filled.error.error, /still holds the template's <What it is and who it is for/);
  // init in a project without a description: the template in the client's language, named in 203.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "203c-init-"));
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## 0.1.0\n");
  const made = await cli(["init", "--summary", "A tracker for the Cardenza", "--lang", "zh"], {cwd: dir});
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.json.project.publish.description_file, "docs/description.md");
  assert.equal(fs.readFileSync(path.join(dir, "docs/description.md"), "utf8"), descriptionTemplate("zh"));
  assert.ok(made.json.todo.some(t => /docs\/description\.md: the page's description, from the template/.test(t)), JSON.stringify(made.json.todo));
  assert.ok(made.json.todo.some(t => /publish\.images/.test(t)));
  fs.rmSync(dir, {recursive: true, force: true});
  // help description: the guide, in the language asked for.
  const en = await run(["help", "description"]);
  assert.match(en.stdout, /# Writing a firmware's description/);
  assert.match(en.stdout, /## The template\n/);
  assert.match(en.stdout, /On the website: https:\/\/cardenza\.203\.io\/community\/guide\/description/);
  assert.match((await run(["help", "description", "--lang", "zh"])).stdout, /# 怎样写固件简介/);
});
