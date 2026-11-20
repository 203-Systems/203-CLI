// Tutorials (the community's "Tutorials"; the format: reference/tutorial-format.md). First the format's checker,
// scripts/tutorial-format.mjs, the one module the community's API and editor run too: a good file, every error code with
// its line and column, key names (combos, aliases, home), the steps' markup, widths, one-language texts and the picture
// modes. Then 203cli tutorial against a stand-in API that keeps tutorials and their pictures as the community does: new,
// check, publish (pictures once, by SHA-256; the file as written), link, list, show, rm, hide.
// Run: node --test tests/tutorial.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {run, standInApi} from "./fixtures.mjs";
import * as T from "../scripts/tutorial-format.mjs";

// ---------------------------------------------------------------------------------------------
// The format

const GOOD = `{
  "format": "203-tutorial/1",
  "firmware": "K7M2QX",
  "languages": ["zh", "en"],
  "title": {"zh": "上手", "en": "Getting started"},
  "summary": {"zh": "几分钟学会。", "en": "In a few minutes."},
  "lessons": [
    {
      "title": {"zh": "换模式", "en": "Modes"},
      "lead": {"zh": "一个键，下一个模式。", "en": "One key, the next **mode**."},
      "steps": [
        {"say": {"zh": "按 {{key:tab}}：下一个模式。", "en": "Press {{key:Tab}}: the next mode, see [the manual](https://example.test/m)."},
         "keys": ["tab", "Enter", "FN + Up", "home", "\\\\", "shift+tab"], "image": "shots/mode.png"},
        {"say": {"zh": "按住 {{key:fn+s}}：\`存\`。", "en": "*Hold* {{key:fn+s}}: saved. https://example.test/a."}, "image": "image:abcdefgh"}
      ]
    }
  ]
}
`;

/** The line and column (1-based) where `needle` first stands in `text` (after `after` when given). */
function at(text, needle, after = "") {
  const index = text.indexOf(needle, after ? text.indexOf(after) : 0);
  assert.ok(index >= 0, needle);
  const before = text.slice(0, index).split("\n");
  return [before.length, before.at(-1).length + 1];
}
/** The errors of a text, as [code, line, column, path]. */
const errorsOf = (text, options) => T.checkTutorial(text, options).errors.map(e => [e.code, e.line, e.column, e.path]);
const one = (text, options) => {
  const errors = T.checkTutorial(text, options).errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  return errors[0];
};
// A tutorial in English with one step: its say and other step fields.
const step = (fields, top = {}) => JSON.stringify({format: T.FORMAT, languages: ["en"], title: "A title", ...top, lessons: [{title: "One", steps: [{say: "Press ok.", ...fields}]}]}, null, 2);

test("format: a good file passes, normalized (texts by language, keys by their caps' names, pictures as written)", () => {
  const r = T.checkTutorial(GOOD);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.tutorial.firmware, "K7M2QX");
  assert.deepEqual(r.tutorial.title, {zh: "上手", en: "Getting started"});
  const [s1, s2] = r.tutorial.lessons[0].steps;
  assert.deepEqual(s1.keys, ["tab", "ok", "fn+;", "home", "\\", "shift+tab"]);
  assert.equal(s1.image, "shots/mode.png");
  assert.equal(s2.image, "image:abcdefgh");
  assert.deepEqual(s2.keys, []);
  assert.deepEqual(r.pictures.map(p => [p.ref, p.id, p.path, p.line, p.column, p.step]),
    [["shots/mode.png", null, "shots/mode.png", ...at(GOOD, '"shots/mode.png"'), [0, 0]], ["image:abcdefgh", "abcdefgh", null, ...at(GOOD, '"image:abcdefgh"'), [0, 1]]]);
  // The normalized tutorial passes again as an object (what a client may send).
  assert.equal(T.checkTutorial(r.tutorial).ok, true);
  // The starters pass, both languages and one.
  assert.equal(T.checkTutorial(T.starter()).ok, true);
  const en = T.checkTutorial(T.starter({languages: ["en"], title: "Pocket tracker", firmware: "K7M2QX"}));
  assert.equal(en.ok, true);
  assert.deepEqual(en.tutorial.title, {en: "Pocket tracker"});
  assert.deepEqual(en.tutorial.languages, ["en"]);
});

test("format: one language takes plain strings; two need {zh, en} with both", () => {
  assert.equal(T.checkTutorial(step({})).ok, true);
  const zh = T.checkTutorial(JSON.stringify({format: T.FORMAT, languages: ["zh"], title: "上手吧", lessons: [{title: "一", steps: [{say: "按 {{key:ok}}。"}]}]}));
  assert.deepEqual(zh.tutorial.lessons[0].steps[0].say, {zh: "按 {{key:ok}}。"});
  const both = `{"format": "203-tutorial/1", "languages": ["zh", "en"], "title": "Plain",\n "lessons": [{"title": {"zh": "一"}, "steps": [{"say": {"zh": "好", "en": "Good", "fr": "Bon"}}]}]}`;
  assert.deepEqual(errorsOf(both), [
    ["type", ...at(both, '"Plain"'), "title"],
    ["language_missing", ...at(both, '{"zh": "一"}'), "lessons.0.title"],
    ["language_extra", ...at(both, '"fr"'), "lessons.0.steps.0.say.fr"],
  ]);
});

test("format: every error code, at its line and column", () => {
  // [code, text, where the error is said: a [line, column], or the text it stands at]
  const cases = [
    ["syntax", '{\n  "format": "203-tutorial/1",\n  "title": "x",\n}', [4, 1]],
    ["syntax_comment", '{\n  // a note\n}', [2, 3]],
    ["duplicate_field", '{"format": "203-tutorial/1",\n "format": "x"}', [2, 2]],
    ["not_object", "[1, 2]", [1, 1]],
    ["format", step({}, {format: "203-tutorial/2"}), '"203-tutorial/2"'],
    ["unknown_field", step({sya: "x"}), '"sya"'],
    ["required", '{"languages": ["en"], "title": "A title", "lessons": [{"title": "x", "steps": [{"say": "ok"}]}]}', [1, 1]],
    ["type", step({keys: "fn"}), '"fn"'],
    ["languages", step({}, {languages: ["de"]}), '[\n    "de"'],
    ["empty", step({say: "   "}), '"   "'],
    ["too_long", step({say: "长".repeat(141)}), '"长'],
    ["too_short", step({}, {title: "x"}), '"x"'],
    ["count", JSON.stringify({format: T.FORMAT, languages: ["en"], title: "A title", lessons: []}), "[]"],
    ["control", step({say: "a\u0007b"}), '"a\\u0007b"'],
    ["newline", step({say: "one\ntwo"}), '"one'],
    ["html", step({say: "Press <b>ok</b>"}), '"Press <b>'],
    ["picture_in_text", step({say: "See ![x](a.png)"}), '"See !['],
    ["block", step({say: "# Heading"}), '"# Heading"'],
    ["markup", step({say: "Press {{ok}}"}), '"Press {{ok}}"'],
    ["key_unknown", step({keys: ["fnn"]}), '"fnn"'],
    ["key_twice", step({keys: ["fn+s", "FN+S"]}), '"FN+S"'],
    ["combo", step({keys: ["q+w+e+r+t"]}), '"q+w+e+r+t"'],
    ["link", step({say: "See [it](http://example.test)"}), '"See [it]'],
    ["picture_path", step({image: "../shot.png"}), '"../shot.png"'],
    ["picture_remote", step({image: "https://example.test/a.png"}), '"https://example.test/a.png"'],
    ["firmware", step({}, {firmware: "ABC234"}), '"ABC234"'],
    ["firmware_code", step({}, {firmware: "nope"}), '"nope"'],
  ];
  for (const [code, text, where] of cases) {
    const [line, column] = Array.isArray(where) ? where : at(text, where);
    const options = code === "firmware" ? {firmware: "K7M2QX"} : {};
    const errors = T.checkTutorial(text, options).errors;
    const found = errors.find(e => e.code === code);
    assert.ok(found, `${code}: ${JSON.stringify(errors)}`);
    assert.deepEqual([found.line, found.column], [line, column], `${code} at ${found.line}:${found.column}: ${T.formatError(found)}`);
    assert.notEqual(T.errorMessage(found, "en"), code, code + " has an English sentence");
    assert.notEqual(T.errorMessage(found, "zh"), code, code + " has a Chinese sentence");
  }
  // language_missing, language_extra, all_steps, too_big, too_many_pictures, picture_not_uploaded, picture_unknown.
  const big = JSON.stringify({format: T.FORMAT, languages: ["en"], title: "A title", lessons: Array.from({length: 11}, (_, l) => ({title: "L" + l,
    steps: Array.from({length: 30}, (_, s) => ({say: "Step " + s, image: `shots/${l}-${s}.png`}))}))});
  const codes = T.checkTutorial(big).errors.map(e => e.code);
  assert.ok(codes.includes("all_steps") && codes.includes("too_many_pictures"), codes.join(" "));
  assert.equal(one("x".repeat(T.LIMITS.bytes + 1)).code, "too_big");
  assert.equal(one(step({image: "shots/a.png"}), {pictures: "uploaded"}).code, "picture_not_uploaded");
  const editor = one(step({image: "./shots/a.png"}), {pictures: "any"});
  assert.equal(editor.code, "picture_not_uploaded");
  assert.equal(editor.params.name, "a.png");
  assert.equal(one(step({image: "image:abcdefgh"}), {pictures: "uploaded", uploaded: ["zzzzzzzz"]}).code, "picture_unknown");
  assert.equal(T.checkTutorial(step({image: "image:ABCDEFGH"}), {pictures: "uploaded", uploaded: new Set(["abcdefgh"])}).ok, true, "an id in any case");
  // Every code the specification lists has its sentences.
  const listed = /The codes: ([^.]+)\./.exec(fs.readFileSync(new URL("../reference/tutorial-format.md", import.meta.url), "utf8").replace(/\n/g, " "))[1].match(/`([a-z_]+)`/g).map(c => c.slice(1, -1));
  for (const code of listed) assert.notEqual(T.errorMessage({code, params: {}}, "en"), code, code);
});

test("format: one line per error for a terminal; paths in JSON terms; where for people", () => {
  const text = step({say: "长".repeat(141)});
  const e = T.checkTutorial(text).errors[0];
  const [line, column] = at(text, '"长');
  assert.equal(T.formatError(e, "en", "t.json"), `t.json:${line}:${column} lessons[0].steps[0].say.en: Too long: 282 of at most 280 (a Chinese character counts 2) (lesson 1, step 1)`);
  assert.equal(T.formatError(e, "zh"), `${line}:${column} lessons[0].steps[0].say.en: 太长：282，最多 280（一个汉字算 2）（第 1 课第 1 步）`);
  assert.equal(T.jsonPath("lessons.1.steps.2.keys.0"), "lessons[1].steps[2].keys[0]");
});

test("format: keys, widths and the words' tokens", () => {
  assert.deepEqual(T.keyGroup("Fn + S"), ["fn", "s"]);
  assert.deepEqual(T.keyGroup("enter"), ["ok"]);
  assert.deepEqual(T.keyGroup("down"), ["."]);
  assert.deepEqual(T.keyGroup("home"), ["home"]);
  assert.equal(T.keyGroup("fn+fn"), null);
  assert.equal(T.keyGroup("+"), null);
  assert.equal(T.keyGroup("k12"), null, "numbers are not names");
  assert.deepEqual(T.keyPosition("ok"), [2, 13]);
  assert.equal(T.keyPosition("home"), null);
  assert.equal(T.textWidth("汉字ab"), 6);
  assert.equal(T.textWidth("（，）"), 6, "full-width signs count 2");
  assert.equal(T.plainText("**按** {{key:fn+s}} [链接](https://a.example.test) `x`"), "按 fn+s 链接 x");
  const tokens = T.inline("Press {{key:enter}} and **{{key:fn+up}}**, see https://x.example.test/a.");
  assert.deepEqual(tokens.map(t => Object.keys(t)[0]), ["text", "key", "text", "bold", "text", "link", "text"]);
  assert.deepEqual(tokens[1].key, ["ok"]);
  assert.equal(tokens[5].link, "https://x.example.test/a");
  assert.equal(tokens[6].text, ".");
  assert.equal(T.inline("[x](http://a.example.test)")[0].link, null, "not https");
  // A < that opens no tag is a sign (the , key types it), not HTML.
  assert.equal(T.checkTutorial(step({say: "Shift and {{key:,}} type the < sign; > is next to it."})).ok, true);
  assert.equal(T.checkTutorial(step({say: "Press </b>"})).errors[0].code, "html");
  // The width counts the words as shown: a link's address is not counted.
  assert.equal(T.checkTutorial(step({say: `${"a".repeat(270)} [x](https://example.test/${"x".repeat(300)})`})).ok, true);
  assert.equal(T.checkTutorial(step({say: `${"a".repeat(280)} [x](https://example.test/)`})).errors[0].code, "too_long", "its words are");
});

test("format: link tutorials (title, https address)", () => {
  assert.deepEqual(T.checkLink({title: " Video ", url: "https://www.bilibili.com/video/BV1"}), {ok: true, errors: [], title: "Video", url: "https://www.bilibili.com/video/BV1"});
  assert.deepEqual(T.checkLink({title: "x", url: "http://a.example.test"}).errors.map(e => [e.code, e.field]), [["too_short", "title"], ["link", "url"]]);
  assert.equal(T.checkLink({title: "Video", url: "https://" + "user:" + "pw" + "@a.example.test/"}).ok, false, "no user name or password");
  assert.equal(T.checkLink({title: "<b>Video</b>", url: "https://a.example.test/"}).errors[0].code, "html");
  assert.deepEqual(T.checkLink({}).errors.map(e => e.code), ["required", "required"]);
});

// ---------------------------------------------------------------------------------------------
// 203cli tutorial against a stand-in API

const TOKEN = "cct_" + "c".repeat(64);
const CODE = "K7M2QX";
const ME = {id: "u1", name: "Tester"};
let stand, home, work, seq = 0;
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => { seq++; return Array.from({length: 8}, (_, i) => alphabet[(seq * 11 + i * 5) % alphabet.length]).join(""); };
const pool = [];                // the author's pictures: {id, sha256, status, url}
const tutorials = new Map();    // id -> Tutorial (with source)
const deleted = new Set();
const uploads = new Map();      // picture id -> sha of what was PUT
let refuseNext = null;          // an answer the next tutorial create / edit gets

function png(width, height, salt) {
  const out = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0);
  out.writeUInt32BE(width, 16); out.writeUInt32BE(height, 20);
  out.write(String(salt), 40);
  return out;
}

// The community's checks, as its API makes them: the document (text or object) with the author's pictures.
function asServer(document, existing = null) {
  const r = T.checkTutorial(document, {pictures: "uploaded", uploaded: pool.filter(p => p.status === "ready").map(p => p.id), firmware: CODE});
  if (!r.ok) return {status: 400, body: {error: "The tutorial does not follow the format", code: "invalid", field: "document",
    errors: r.errors.map(e => ({line: e.line, column: e.column, path: e.path, code: e.code, params: e.params, message: T.errorMessage(e, "en")}))}};
  const t = r.tutorial;
  const id = existing?.id ?? newId();
  return {status: 200, body: {id, kind: "guide", firmware: {code: CODE, name: "Pocket Tracker"}, title: T.pick(t.title, "en", t.languages), summary: t.summary ? T.pick(t.summary, "en") : null,
    languages: t.languages, lessons: t.lessons.length, steps: T.allSteps(t).length, url: null, host: null, cover: null, author: ME, official: true, hidden: false,
    created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z", can: {edit: true, delete: true, hide: true}, document: t,
    source: typeof document === "string" ? document : null, images: []}};
}
const summary = t => Object.fromEntries(Object.entries(t).filter(([k]) => !["document", "source", "images"].includes(k)));

before(async () => {
  stand = await standInApi(async (req, send, body, raw) => {
    const [pathname, query = ""] = req.url.split("?");
    const dry = /(^|&)dry_run=1(&|$)/.test(query);
    const json = body && body.startsWith("{") ? JSON.parse(body) : {};
    if (pathname === "/api/") return send(200, {version: 2, limits: {}});
    if (pathname === "/api/me") return send(200, {...ME, role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203cli"}});
    if (pathname === `/api/firmware/${CODE}` && req.method === "GET") return send(200, {code: CODE, name: "Pocket Tracker", owner: ME, can: {edit: true}});
    if (pathname === "/api/firmware/ZZZZZZ") return send(404, {error: "No firmware has this code", code: "not_found"});
    const base = `/api/firmware/${CODE}`;
    if (pathname === base + "/tutorial-images" && req.method === "GET") return send(200, {items: pool});
    if (pathname === base + "/tutorial-images" && req.method === "POST") {
      if (pool.length >= 60) return send(409, {error: "At most 60", code: "conflict", field: "images"});
      const id = newId();
      pool.push({id, url: `/files/${id}.png`, size: json.size, sha256: null, width: null, height: null, status: "pending", used: false, created: "now"});
      return send(200, {image: {id}, upload: {url: `${stand.api}/upload/${id}`, method: "PUT", headers: {"Content-Type": json.mime}}});
    }
    let m = /^\/api\/upload\/(\w+)$/.exec(pathname);
    if (m) { uploads.set(m[1], crypto.createHash("sha256").update(raw).digest("hex")); return send(200, {}); }
    m = new RegExp(`^${base}/tutorial-images/(\\w+)/(done|delete)$`).exec(pathname);
    if (m) {
      const p = pool.find(x => x.id === m[1]);
      if (!p) return send(404, {error: "No picture", code: "not_found"});
      if (m[2] === "delete") { pool.splice(pool.indexOf(p), 1); return send(200, {status: "deleted"}); }
      Object.assign(p, {status: "ready", sha256: uploads.get(p.id), width: 16, height: 9});
      return send(200, p);
    }
    if (pathname === base + "/tutorials" && req.method === "GET") {
      const items = [...tutorials.values()].map(summary);
      return send(200, {total: items.length, page: 1, page_size: 24, items});
    }
    if (pathname === base + "/tutorials" && req.method === "POST") {
      if (refuseNext) { const r = refuseNext; refuseNext = null; return send(r.status, r.body); }
      if (json.document !== undefined) {
        const mine = [...tutorials.values()].find(t => t.kind === "guide" && t.author.id === ME.id);
        if (mine) return send(409, {error: "You have a tutorial here: change it", code: "conflict", field: "document", id: mine.id});
        const answer = asServer(json.document);
        if (answer.status !== 200 || dry) return send(answer.status, dry && answer.status === 200 ? {dry_run: true, answer: answer.body} : answer.body);
        tutorials.set(answer.body.id, answer.body);
        return send(201, answer.body);
      }
      const check = T.checkLink(json);
      if (!check.ok) return send(400, {error: "Bad link", code: "invalid", field: check.errors[0].field});
      const id = newId();
      const t = {id, kind: "link", firmware: {code: CODE, name: "Pocket Tracker"}, title: check.title, summary: null, languages: [], lessons: 0, steps: 0, url: check.url,
        host: new URL(check.url).host, cover: null, author: ME, official: true, hidden: false, created: "now", updated: "now", can: {edit: true, delete: true, hide: true}, document: null, source: null, images: []};
      if (dry) return send(200, {dry_run: true, answer: t});
      tutorials.set(id, t);
      return send(201, t);
    }
    m = new RegExp(`^${base}/tutorials/(\\w+)(?:/(edit|delete|hide))?$`).exec(pathname);
    if (m) {
      if (deleted.has(m[1])) return send(410, {error: "This tutorial was deleted", code: "deleted"});
      const t = tutorials.get(m[1]);
      if (!t) return send(404, {error: "This firmware has no tutorial with this id", code: "not_found"});
      if (!m[2]) return send(200, t);
      if (m[2] === "delete") { tutorials.delete(m[1]); deleted.add(m[1]); return send(200, {status: "deleted"}); }
      if (m[2] === "hide") { t.hidden = !!json.on; return send(200, t); }
      if (refuseNext) { const r = refuseNext; refuseNext = null; return send(r.status, r.body); }
      if (t.kind === "link") { if (!dry) t.title = json.title ?? t.title; return send(200, dry ? {dry_run: true, answer: t} : t); }
      const answer = asServer(json.document, t);
      if (answer.status !== 200 || dry) return send(answer.status, dry && answer.status === 200 ? {dry_run: true, answer: answer.body} : answer.body);
      tutorials.set(t.id, answer.body);
      return send(200, answer.body);
    }
    if (pathname === "/api/tutorials") return send(200, {total: 1, page: 1, page_size: 24, items: [{firmware: {code: CODE, name: "Pocket Tracker"}, total: tutorials.size, tutorials: []}]});
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-tutorial-"));
  fs.writeFileSync(path.join(work, "203.json"), JSON.stringify({format: 1, name: "Pocket Tracker", code: CODE}, null, 2) + "\n");
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = (args, {cwd = work} = {}) => run(["--api", stand.api, ...args, "--json"], {cwd, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: TOKEN, CI: "1"}});
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result.json; };
const file = rel => path.join(work, rel);

test("tutorial new writes docs/tutorial.json for 203.json's firmware; never over a file without --force", async () => {
  const made = ok(await cli(["tutorial", "new"]));
  assert.equal(made.status, "written");
  assert.equal(made.firmware, CODE);
  assert.equal(path.normalize(made.file), path.normalize("docs/tutorial.json"));
  const text = fs.readFileSync(file("docs/tutorial.json"), "utf8");
  assert.equal(T.checkTutorial(text).ok, true);
  assert.equal(JSON.parse(text).firmware, CODE);
  const again = await cli(["tutorial", "new"]);
  assert.equal(again.code, 6);
  assert.equal(again.error.code, "needs_force");
  assert.match(again.error.next[0], /tutorial new .*--force/);
  const en = ok(await cli(["tutorial", "new", "docs/en.json", "--languages", "en", "--title", "Pocket basics"]));
  assert.deepEqual(en.languages, ["en"]);
  assert.equal(JSON.parse(fs.readFileSync(file("docs/en.json"), "utf8")).title, "Pocket basics");
  assert.equal((await cli(["tutorial", "new", "docs/x.json", "--languages", "fr"])).code, 2);
  assert.equal((await cli(["tutorial", "new", "docs/x.json", "--title", "x"])).error.field, "title");
  ok(await cli(["tutorial", "new", "--force"]));
});

test("tutorial check: every error with its line and column, the local pictures too; offline", async () => {
  fs.mkdirSync(file("docs/shots"), {recursive: true});
  fs.writeFileSync(file("docs/shots/fake.png"), Buffer.from("GIF89a" + "x".repeat(40)));
  fs.writeFileSync(file("docs/bad.json"), [
    "{",
    '  "format": "203-tutorial/1",',
    '  "languages": ["en"],',
    '  "title": "Basics",',
    '  "lessons": [{"title": "One", "steps": [',
    '    {"say": "Press {{key:fnn}}", "image": "shots/missing.png"},',
    '    {"say": "Then <b>ok</b>", "image": "shots/fake.png", "keys": ["fn+s", "up"]}',
    "  ]}]",
    "}", ""].join("\n"));
  const bad = await run(["tutorial", "check", "docs/bad.json", "--json"], {cwd: work, env: {XDG_CONFIG_HOME: home, COMMUNITY_API: "https://unreachable.test/api", CI: "1"}});
  assert.equal(bad.code, 1, bad.stderr);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.code, "invalid");
  const badText = fs.readFileSync(file("docs/bad.json"), "utf8");
  assert.deepEqual(bad.json.errors.map(e => [e.code, e.line, e.column, e.path]), [
    ["key_unknown", ...at(badText, '"Press {{key:fnn}}"'), "lessons.0.steps.0.say.en"],
    ["picture_missing", ...at(badText, '"shots/missing.png"'), "lessons.0.steps.0.image"],
    ["html", ...at(badText, '"Then <b>'), "lessons.0.steps.1.say.en"],
    ["picture_type", ...at(badText, '"shots/fake.png"'), "lessons.0.steps.1.image"],
  ]);
  assert.ok(bad.json.errors.every(e => e.message));
  const text = await run(["tutorial", "check", "docs/bad.json"], {cwd: work, env: {XDG_CONFIG_HOME: home, CI: "1"}});
  assert.equal(text.code, 1);
  assert.match(text.stdout, /^docs[\\/]bad\.json:6:13 lessons\[0\]\.steps\[0\]\.say\.en: Unknown key "fnn"/m);
  assert.match(text.stdout, /^docs[\\/]bad\.json:7:\d+ lessons\[0\]\.steps\[1\]\.image: shots\/fake\.png is a GIF.*\(lesson 1, step 2\)$/m);
  assert.match(text.stdout, /4 errors in docs[\\/]bad\.json/);
  const zh = await run(["tutorial", "check", "docs/bad.json", "--lang", "zh", "--json"], {cwd: work, env: {XDG_CONFIG_HOME: home, CI: "1"}});
  assert.match(zh.json.errors[0].message, /不认识的按键/);
  const good = ok(await run(["tutorial", "check", "--json"], {cwd: work, env: {XDG_CONFIG_HOME: home, CI: "1"}}));
  assert.deepEqual([good.ok, good.lessons, good.steps, good.errors.length], [true, 1, 2, 0]);
  const missing = await cli(["tutorial", "check", "docs/none.json"]);
  assert.equal(missing.error.code, "file_not_found");
  const other = await cli(["tutorial", "check", "--firmware", "ABC234"]);
  assert.equal(other.code, 1);
  assert.equal(other.json.errors[0].code, "firmware");
});

test("tutorial publish: pictures once by SHA-256, the file sent with image:<id> and left as written; again: nothing; changed: updated", async () => {
  fs.writeFileSync(file("docs/shots/menu.png"), png(240, 135, "menu"));
  fs.writeFileSync(file("docs/shots/seq.png"), png(240, 135, "seq"));
  const text = [
    "{",
    '  "format": "203-tutorial/1",',
    `  "firmware": "${CODE}",`,
    '  "languages": ["en"],',
    '  "title": "Pocket basics",',
    '  "lessons": [{"title": "One", "steps": [',
    '    {"say": "Press {{key:ok}}: the menu.", "keys": ["ok"], "image": "shots/menu.png"},',
    '    {"say": "Then the sequencer.", "image": "./shots/seq.png"},',
    '    {"say": "The menu again.", "image": "shots/menu.png"}',
    "  ]}]",
    "}", ""].join("\n");
  fs.writeFileSync(file("docs/basics.json"), text);
  const dry = ok(await cli(["tutorial", "publish", "docs/basics.json", "--dry-run"]));
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.ready, true, JSON.stringify(dry.problems));
  assert.equal(dry.plan.filter(s => /^upload /.test(s)).length, 2, dry.plan.join("\n"));
  assert.ok(dry.plan.some(s => /add your tutorial to Pocket Tracker/.test(s)));
  assert.equal(pool.length, 0, "a dry run uploads nothing");
  const published = ok(await cli(["tutorial", "publish", "docs/basics.json"]));
  assert.equal(published.status, "published");
  assert.equal(published.uploaded.length, 2);
  assert.match(published.tutorial.url, new RegExp(`/${CODE}/t/\\w{8}$`));
  assert.equal(fs.readFileSync(file("docs/basics.json"), "utf8"), text, "the author's file stays as written");
  const kept = tutorials.get(published.tutorial.id);
  const ids = pool.map(p => p.id);
  assert.deepEqual(kept.document.lessons[0].steps.map(s => s.image), [`image:${ids[0]}`, `image:${ids[1]}`, `image:${ids[0]}`]);
  assert.equal(kept.source, text.replace(/"shots\/menu\.png"/g, `"image:${ids[0]}"`).replace('"./shots/seq.png"', `"image:${ids[1]}"`), "the text as written, the pictures' ids in place");
  // Again: nothing goes up, nothing changes.
  const again = ok(await cli(["tutorial", "publish", "docs/basics.json"]));
  assert.equal(again.status, "already_published");
  assert.equal(again.uploaded.length, 0);
  assert.equal(pool.length, 2);
  // A change: the same tutorial changed (one guide each), the pictures it has not sent again.
  fs.writeFileSync(file("docs/basics.json"), text.replace("Then the sequencer.", "Then the sequencer, sixteen steps."));
  const changed = ok(await cli(["tutorial", "publish", "docs/basics.json"]));
  assert.equal(changed.status, "updated");
  assert.equal(changed.tutorial.id, published.tutorial.id);
  assert.equal(pool.length, 2);
  // Another file of the same author: it changes that guide (409 from a create is followed too).
  const other = ok(await cli(["tutorial", "publish", "--firmware", CODE]));
  assert.equal(other.status, "updated");
  assert.equal(tutorials.size, 1);
});

test("tutorial publish: a file that fails locally, a picture that is not the author's, the server's refusal", async () => {
  const bad = await cli(["tutorial", "publish", "docs/bad.json", "--firmware", CODE]);
  assert.equal(bad.code, 1);
  assert.equal(bad.error.code, "invalid");
  assert.equal(bad.error.field, "document");
  assert.equal(bad.error.errors.length, 4);
  assert.equal(bad.error.errors[0].line, 6);
  fs.writeFileSync(file("docs/foreign.json"), JSON.stringify({format: T.FORMAT, languages: ["en"], title: "Foreign", lessons: [{title: "One", steps: [{say: "Look.", image: "image:zzzzzzzz"}]}]}, null, 2));
  const foreign = await cli(["tutorial", "publish", "docs/foreign.json", "--firmware", CODE]);
  assert.equal(foreign.error.code, "invalid");
  assert.equal(foreign.error.errors[0].code, "picture_unknown");
  const none = await cli(["tutorial", "publish", "docs/foreign.json"], {cwd: os.tmpdir()});
  assert.equal(none.code, 1, "no such file there");
  fs.writeFileSync(path.join(home, "loose.json"), T.starter({languages: ["en"]}));
  const which = await cli(["tutorial", "publish", "loose.json"], {cwd: home});
  assert.equal(which.code, 2);
  assert.equal(which.error.field, "firmware");
  refuseNext = {status: 400, body: {error: "The tutorial does not follow the format", code: "invalid", field: "document",
    errors: [{line: 7, column: 13, path: "lessons.0.steps.0.say.en", code: "too_long", params: {}, message: "Too long"}]}};
  fs.writeFileSync(file("docs/basics.json"), fs.readFileSync(file("docs/basics.json"), "utf8").replace("sixteen steps", "16 steps"));
  const refused = await cli(["tutorial", "publish", "docs/basics.json"]);
  assert.equal(refused.code, 1);
  assert.equal(refused.error.code, "invalid");
  assert.match(refused.error.lines[0], /^docs[\\/]basics\.json:7:13 lessons\[0\]\.steps\[0\]\.say\.en: Too long$/);
  assert.equal((await cli(["tutorial", "publish", "docs/basics.json", "--firmware", "ZZZZZZ"])).error.code, "not_found");
});

test("tutorial link: added, the same again changes nothing, a new title changes it; https only", async () => {
  const url = "https://www.bilibili.com/video/BV1xx411c7mD";
  const added = ok(await cli(["tutorial", "link", CODE, url, "--title", "Video: the first ten minutes"]));
  assert.equal(added.status, "published");
  assert.equal(added.tutorial.url, url);
  assert.equal(ok(await cli(["tutorial", "link", CODE, url, "--title", "Video: the first ten minutes"])).status, "already_published");
  const retitled = ok(await cli(["tutorial", "link", CODE, url, "--title", "Video: ten minutes"]));
  assert.equal(retitled.status, "updated");
  assert.equal(tutorials.get(added.tutorial.id).title, "Video: ten minutes");
  const dry = ok(await cli(["tutorial", "link", CODE, "https://example.test/blog", "--title", "A blog post", "--dry-run"]));
  assert.equal(dry.ready, true);
  const http = await cli(["tutorial", "link", CODE, "http://example.test/blog", "--title", "A blog post"]);
  assert.equal(http.code, 2);
  assert.equal(http.error.field, "URL");
  assert.equal((await cli(["tutorial", "link", CODE, url])).error.field, "title");
});

test("tutorial list, show (--out), hide, rm (--yes; again: already deleted)", async () => {
  const listed = ok(await cli(["tutorial", "list", CODE]));
  assert.equal(listed.total, 2);
  const guide = listed.items.find(t => t.kind === "guide");
  assert.match(guide.page, new RegExp(`/${CODE}/t/${guide.id}$`));
  assert.equal(ok(await cli(["tutorial", "list"])).total, 2, "203.json's firmware");
  assert.equal(ok(await cli(["tutorial", "list", "--all"])).items[0].firmware.code, CODE);
  const shown = ok(await cli(["tutorial", "show", CODE, guide.id, "--out", "docs/back.json"]));
  assert.equal(shown.kind, "guide");
  assert.equal(fs.readFileSync(file("docs/back.json"), "utf8"), tutorials.get(guide.id).source);
  assert.equal((await cli(["tutorial", "show", CODE, guide.id, "--out", "docs/back.json"])).code, 6, "never over a file without --force");
  assert.equal(ok(await cli(["tutorial", "hide", CODE, guide.id, "--reason", "Wrong keys"])).status, "hidden");
  assert.equal(tutorials.get(guide.id).hidden, true);
  assert.equal(ok(await cli(["tutorial", "hide", CODE, guide.id, "--off"])).status, "shown");
  const ask = await cli(["tutorial", "rm", CODE, guide.id]);
  assert.equal(ask.code, 6, "needs --yes");
  assert.equal(ok(await cli(["tutorial", "rm", CODE, guide.id, "--yes"])).status, "deleted");
  assert.equal(ok(await cli(["tutorial", "rm", CODE, guide.id, "--yes"])).status, "already_deleted");
  assert.equal((await cli(["tutorial", "rm", "ZZZZZZ", guide.id, "--yes"])).error.code, "not_found", "a firmware that is not there");
});

test("help tutorials explains the format, the commands, and description vs tutorial", async () => {
  const help = await run(["help", "tutorials"]);
  assert.equal(help.code, 0);
  for (const words of ["203-tutorial/1", "tutorial publish", "tutorial link", "how to use it", "{{key:fn}}"]) assert.ok(help.stdout.includes(words), words);
});
