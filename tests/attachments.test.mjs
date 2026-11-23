// Attachments, bot accounts and requests' public status (the community's "Attachments", "Bots" and "Requests (public)", the
// user 2026-11-23): --attach on requests create, posts create, feedback and comments add (each file started, PUT to its signed
// URL and checked, then the item made with their ids; at most 9, the limits and refused names checked before anything is sent),
// admin bots create / list / rotate (the token printed once, or written to --token-file with mode 600 and never printed),
// requests list --status in Chinese or English, --author on dev list and admin issues. Against a stand-in API; the community
// runs these against its whole API in its own tests.
// Run: node --test tests/attachments.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {run, standInApi} from "./fixtures.mjs";
import {attachmentType} from "../scripts/lib.mjs";

const TOKEN = "cct_" + "b".repeat(64);
// A bot's token as the stand-in makes it (at run time, never a literal: the repository's secret scan).
const botToken = n => "cct_" + String(n).repeat(64).slice(0, 64);
const CODE = "K7M2QX";
let stand, home, work, seq = 0, tokens = 0;
const attachments = new Map();   // id -> Attachment (+ bytes once uploaded)
const bots = [];
let lastCreate = null;
const newId = () => { seq++; const a = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from({length: 8}, (_, i) => a[(seq * 7 + i * 3) % a.length]).join(""); };
const bot = (id, name) => ({id, name, avatar: "a03", role: "bot", level: 1, title: null, badges: [], bio: "", joined: "2026-11-23T00:00:00Z", banned: false,
  status: "active", credential: {id: "t" + (++tokens), created: "2026-11-23T08:00:00Z", last_used: null}});

before(async () => {
  stand = await standInApi(async (req, send, body, raw) => {
    const [pathname, query = ""] = req.url.split("?");
    const json = body && body.startsWith("{") ? JSON.parse(body) : {};
    if (pathname === "/api/me") return send(200, {id: "u1", name: "Admin", role: "admin", scopes: ["read", "write", "admin"], credential: {kind: "cli", name: "203cli"}});
    if (pathname === "/api/attachments" && req.method === "POST") {
      const id = newId();
      const a = {id, kind: json.kind, name: json.name, mime: json.type, size: json.size, width: null, height: null, url: null, download_url: null, status: "pending", created: "x"};
      attachments.set(id, a);
      return send(200, {attachment: a, upload: {url: `${stand.api}/upload/${id}`, method: "PUT",
        headers: {"Content-Type": json.kind === "file" ? "application/octet-stream" : json.type}, expires_at: "x"}});
    }
    let m = /^\/api\/upload\/(\w+)$/.exec(pathname);
    if (m && req.method === "PUT") { attachments.get(m[1]).bytes = raw.length; attachments.get(m[1]).put_type = req.headers["content-type"]; return send(200, {}); }
    m = /^\/api\/attachments\/(\w+)\/(done|delete)$/.exec(pathname);
    if (m) {
      const a = attachments.get(m[1]);
      if (m[2] === "delete") { a.deleted = true; return send(200, {status: "deleted"}); }
      if (a.bytes !== a.size) return send(409, {error: "The file is not uploaded yet", code: "conflict"});
      Object.assign(a, {status: "ready", url: `https://media.test/attachments/${a.id}/f.bin`, download_url: `https://media.test/attachments/${a.id}/f.bin?download=${a.name}`});
      const {bytes: _b, put_type: _p, deleted: _d, ...out} = a;
      return send(200, out);
    }
    const shown = ids => (ids ?? []).map(id => { const {bytes: _b, put_type: _p, deleted: _d, ...out} = attachments.get(id); return out; });
    if (pathname === `/api/firmware/${CODE}/requests` && req.method === "POST") {
      lastCreate = {path: pathname, body: json};
      return send(201, {number: 4, title: json.title, body: json.body ?? "", status: "new", author: {id: "b1", name: "大肥鱼", role: "bot", badges: []},
        created: "2026-11-23T08:00:00Z", votes: {up: 0, down: 0}, comments: 0, attachments: shown(json.attachments)});
    }
    if (pathname === `/api/firmware/${CODE}/requests` && req.method === "GET") {
      lastCreate = {path: pathname, query};
      return send(200, {total: 1, page: 1, page_size: 24, items: [{number: 1, title: "Swing", body: "", status: "in_progress",
        author: {id: "b1", name: "大肥鱼", role: "bot", badges: []}, votes: {up: 2, down: 0}, comments: 1, attachments: []}]});
    }
    if (pathname === `/api/firmware/${CODE}/requests/1`) {
      return send(200, {number: 1, title: "Swing", body: "Please.", status: "done", author: {id: "b1", name: "大肥鱼", role: "bot", badges: []},
        created: "2026-11-23T08:00:00Z", votes: {up: 2, down: 0}, comments: 0,
        attachments: [{id: "q4hzuufx", kind: "image", name: "shot.png", mime: "image/png", size: 2048, width: 10, height: 10, url: "https://media.test/a.png",
          download_url: "https://media.test/a.png?download=shot.png", status: "ready", created: "x"}]});
    }
    if (pathname === "/api/posts" && req.method === "POST") { lastCreate = {path: pathname, body: json}; return send(201, {id: "p1p1p1p1", ...json, attachments: shown(json.attachments)}); }
    if (pathname === "/api/feedback") { lastCreate = {path: pathname, body: json}; return send(201, {number: 9, kind: json.kind, title: json.title, message: json.message, status: "new", attachments: shown(json.attachments)}); }
    if (/^\/api\/posts\/\w+\/comments$/.test(pathname) || /^\/api\/firmware\/\w+\/requests\/\d+\/comments$/.test(pathname)) {
      lastCreate = {path: pathname, body: json};
      return send(201, {id: 77, body: json.body, parent: json.parent ?? null, target: {kind: "post", ref: "x"}, author: {id: "b1", name: "大肥鱼", role: "bot"}, attachments: shown(json.attachments)});
    }
    if (pathname === "/api/dev/requests" || pathname === "/api/dev/community/issues") { lastCreate = {path: pathname, query}; return send(200, {total: 0, page: 1, page_size: 24, items: []}); }
    if (pathname === "/api/admin/bots" && req.method === "POST") {
      const made = bot("b" + (bots.length + 1) + "x".repeat(6), json.name);
      bots.push(made);
      return send(201, {bot: made, token: botToken(bots.length)});
    }
    if (pathname === "/api/admin/bots" && req.method === "GET") return send(200, {total: bots.length, page: 1, page_size: 24, items: bots});
    m = /^\/api\/admin\/bots\/(\w+)\/token$/.exec(pathname);
    if (m) {
      const b = bots.find(x => x.id === m[1]);
      if (!b) return send(404, {error: "No bot has this id", code: "not_found"});
      return send(200, {bot: b, token: botToken(9)});
    }
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-attach-"));
  const png = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  fs.writeFileSync(path.join(work, "shot.png"), png);
  const mov = Buffer.alloc(64); mov.write("ftypqt  ", 4);
  fs.writeFileSync(path.join(work, "clip.mov"), mov);
  fs.writeFileSync(path.join(work, "log.txt"), "boot\npanic\n");
  fs.writeFileSync(path.join(work, "page.html"), "<html></html>");
  fs.writeFileSync(path.join(work, "report.md"), "It crashes when saving.\n");
  // A picture over 10 MB (sparse: a PNG header, then nothing).
  const big = fs.openSync(path.join(work, "big.png"), "w");
  fs.writeSync(big, png, 0, 64, 0);
  fs.ftruncateSync(big, 10 * 1024 * 1024 + 1);
  fs.closeSync(big);
  // A video a byte over 95 MB, decimal (the community's upload host passes 100 MB a request).
  const long = fs.openSync(path.join(work, "long.mov"), "w");
  fs.writeSync(long, Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0qt  ", "latin1"));
  fs.ftruncateSync(long, 95000001);
  fs.closeSync(long);
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = (args, {json = true, env = {}} = {}) => run(["--api", stand.api, ...args, ...(json ? ["--json"] : [])],
  {cwd: work, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: TOKEN, CI: "1", ...env}});
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result; };
const uploads = () => stand.requests.filter(r => /\/attachments|\/upload\//.test(r.url)).map(r => r.method + " " + r.url.replace(/^\/api/, "").replace(/\/[a-z2-9]{8}\//, "/ID/").replace(/\/[a-z2-9]{8}$/, "/ID"));

test("attachmentType: pictures, videos (MOV by its brand, WebM by its doctype) and other files by name", () => {
  const b = text => new Uint8Array(Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(64)]));
  assert.deepEqual(attachmentType(b("GIF89a")), {kind: "image", type: "image/gif"});
  assert.deepEqual(attachmentType(b("RIFF\0\0\0\0WEBPVP8 ")), {kind: "image", type: "image/webp"});
  assert.deepEqual(attachmentType(b("\0\0\0\x18ftypisom")), {kind: "video", type: "video/mp4"});
  assert.deepEqual(attachmentType(b("\0\0\0\x14ftypqt  ")), {kind: "video", type: "video/quicktime"});
  assert.deepEqual(attachmentType(b("\x1a\x45\xdf\xa3\x9f\x42\x82\x84webm")), {kind: "video", type: "video/webm"});
  assert.deepEqual(attachmentType(b("\x1a\x45\xdf\xa3\x9f\x42\x82\x88matroska")), {kind: "file", type: "application/octet-stream"});
  assert.deepEqual(attachmentType(b("PK\x03\x04"), "logs.zip"), {kind: "file", type: "application/zip"});
  assert.deepEqual(attachmentType(b("CARDENZA_PROJECT 7"), "song.ccproj"), {kind: "file", type: "application/octet-stream"});
});

test("requests create --attach: each file started, PUT and done in order, then the request with their ids", async () => {
  stand.requests.length = 0;
  const out = ok(await cli(["requests", "create", CODE, "--title", "Crash when saving", "--body-file", "report.md", "--attach", "shot.png", "--attach", "clip.mov", "--attach", "log.txt"])).json;
  assert.deepEqual(uploads(), ["POST /attachments", "PUT /upload/ID", "POST /attachments/ID/done", "POST /attachments", "PUT /upload/ID", "POST /attachments/ID/done",
    "POST /attachments", "PUT /upload/ID", "POST /attachments/ID/done"]);
  const started = stand.requests.filter(r => r.url === "/api/attachments").map(r => JSON.parse(r.body));
  assert.deepEqual(started.map(x => [x.name, x.kind, x.type]), [["shot.png", "image", "image/png"], ["clip.mov", "video", "video/quicktime"], ["log.txt", "file", "text/plain"]]);
  assert.equal(lastCreate.body.body, "It crashes when saving.\n");
  assert.equal(lastCreate.body.attachments.length, 3);
  assert.deepEqual(out.attachments.map(a => [a.id, a.name, a.status]), lastCreate.body.attachments.map((id, i) => [id, ["shot.png", "clip.mov", "log.txt"][i], "ready"]));
  assert.ok(out.attachments.every(a => a.url && a.download_url));
  // The file went as octet-stream (never served inline), the picture as itself.
  assert.deepEqual(lastCreate.body.attachments.map(id => attachments.get(id).put_type), ["image/png", "video/quicktime", "application/octet-stream"]);
  // Human output: the status and the attachments.
  const text = ok(await cli(["requests", "create", CODE, "--title", "Another one", "--attach", "shot.png"], {json: false})).stdout;
  assert.match(text, /#4  \[New\]  Another one/);
  assert.match(text, /大肥鱼 \[bot\]/);
  assert.match(text, /Attachments \(1\):\n\s+image\s+shot\.png\s+64 B\s+https:\/\/media\.test\//);
});

test("posts create, feedback and comments add take --attach; a comment may be only an attachment", async () => {
  const post = ok(await cli(["posts", "create", "--title", "Desk", "--body", "My setup", "--attach", "shot.png"])).json;
  assert.equal(post.attachments.length, 1);
  assert.deepEqual(lastCreate.body.attachments, [post.attachments[0].id]);
  const issue = ok(await cli(["feedback", "--kind", "bug", "--title", "Upload stops", "--message-file", "report.md", "--attach", "log.txt"])).json;
  assert.equal(lastCreate.path, "/api/feedback");
  assert.equal(issue.attachments[0].name, "log.txt");
  const reply = ok(await cli(["comments", "add", "request", `${CODE}/1`, "--parent", "42", "--attach", "shot.png"])).json;
  assert.equal(lastCreate.path, `/api/firmware/${CODE}/requests/1/comments`);
  assert.deepEqual([lastCreate.body.body, lastCreate.body.parent, lastCreate.body.attachments.length], ["", 42, 1]);
  assert.equal(reply.attachments.length, 1);
  const none = await cli(["comments", "add", "post", "p1p1p1p1"]);
  assert.equal(none.code, 2, "no body and no attachment");
  assert.equal(none.error.field, "body");
});

test("--attach is checked before anything is sent: a 10th file, a page, a picture over 10 MB, a missing file", async () => {
  stand.requests.length = 0;
  const ten = await cli(["posts", "create", "--title", "t", "--body", "b", ...Array.from({length: 10}, () => ["--attach", "shot.png"]).flat()]);
  assert.equal(ten.code, 2);
  assert.equal(ten.error.field, "attach");
  assert.match(ten.error.error, /At most 9 attachments/);
  const page = await cli(["feedback", "--kind", "bug", "--title", "t", "--message", "m", "--attach", "page.html"]);
  assert.equal(page.code, 2);
  assert.match(page.error.error, /page\.html: \.html files are not taken/);
  const big = await cli(["requests", "create", CODE, "--title", "Big picture", "--attach", "big.png"]);
  assert.equal(big.code, 2);
  assert.match(big.error.error, /big\.png: 10485761 bytes, more than the 10 MB a picture may have/);
  assert.match(big.error.hint, /up to 10 MB/);
  const long = await cli(["feedback", "--kind", "bug", "--title", "t", "--message", "m", "--attach", "long.mov"]);
  assert.equal(long.code, 2);
  assert.match(long.error.error, /long\.mov: 95000001 bytes, more than the 95 MB a video may have/);
  const missing = await cli(["comments", "add", "post", "p1p1p1p1", "--body", "x", "--attach", "nowhere.png"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.error.code, "file_not_found");
  assert.equal(stand.requests.filter(r => r.url !== "/api/me").length, 0, "nothing was sent");
});

test("a failed upload names its file and removes what was already up", async () => {
  const before = stand.requests.length;
  // The stand-in answers 409 on done when the bytes did not arrive: make the second file's PUT go nowhere.
  const real = attachments.set.bind(attachments);
  let n = 0;
  attachments.set = (id, a) => { if (++n === 2) Object.defineProperty(a, "bytes", {get: () => -1, set: () => {}}); return real(id, a); };
  const failed = await cli(["posts", "create", "--title", "t", "--body", "b", "--attach", "shot.png", "--attach", "log.txt"]);
  attachments.set = real;
  assert.equal(failed.code, 1);
  assert.match(failed.error.error, /^log\.txt: The file is not uploaded yet/);
  const after = stand.requests.slice(before).map(r => r.method + " " + r.url.replace(/\/[a-z2-9]{8}\//, "/ID/"));
  assert.deepEqual(after.filter(x => /delete/.test(x)), ["POST /api/attachments/ID/delete", "POST /api/attachments/ID/delete"], "both removed again");
  assert.ok(!after.some(x => x === "POST /api/posts"), "no post made");
});

test("admin bots create: the token printed once, or into --token-file (mode 600) and never printed; list; rotate by name", async () => {
  const made = ok(await cli(["admin", "bots", "create", "大肥鱼", "--bio", "203 的客服机器人"]));
  assert.equal(made.json.bot.role, "bot");
  assert.equal(made.json.token, botToken(1));
  assert.deepEqual(JSON.parse(stand.requests.findLast(r => r.url === "/api/admin/bots" && r.method === "POST").body), {name: "大肥鱼", bio: "203 的客服机器人"});
  const text = ok(await cli(["admin", "bots", "create", "小助手"], {json: false}));
  assert.match(text.stdout, /shown only now/);
  assert.ok(text.stdout.includes(botToken(2)));
  assert.match(text.stderr, /--token-file PATH/);
  const file = path.join(work, "secrets", "bot.token");
  const filed = ok(await cli(["admin", "bots", "create", "第三个", "--token-file", "secrets/bot.token"]));
  assert.deepEqual(Object.keys(filed.json).sort(), ["bot", "token_file"]);
  assert.equal(fs.realpathSync(filed.json.token_file), fs.realpathSync(file));
  // In GitHub Actions the CLI asks the runner to mask the token (an ::add-mask:: line, which the runner swallows): not printing it.
  const shown = text => text.split(/\r?\n/).filter(line => !line.startsWith("::add-mask::")).join("\n");
  assert.ok(!shown(filed.stdout).includes("cct_") && !shown(filed.stderr).includes("cct_"), "the token is never printed");
  assert.equal(fs.readFileSync(file, "utf8"), botToken(3) + "\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A file that is there is not written over (and nothing is made or rotated) unless --overwrite.
  const asked = stand.requests.length;
  const there = await cli(["admin", "bots", "rotate", "第三个", "--token-file", "secrets/bot.token"]);
  assert.equal(there.code, 1);
  assert.equal(there.error.field, "token-file");
  assert.equal(stand.requests.length, asked, "the API was not asked");
  const listed = ok(await cli(["admin", "bots", "list"])).json;
  assert.deepEqual(listed.items.map(b => b.name), ["大肥鱼", "小助手", "第三个"]);
  assert.match(ok(await cli(["admin", "bots", "list"], {json: false})).stdout, /大肥鱼 \[bot\]  active  token made 2026-11-23 08:00, never used/);
  const rotated = ok(await cli(["admin", "bots", "rotate", "第三个", "--token-file", "secrets/bot.token", "--overwrite"]));
  assert.equal(rotated.json.bot.name, "第三个");
  assert.equal(stand.requests.findLast(r => /\/token$/.test(r.url)).url, `/api/admin/bots/${bots[2].id}/token`);
  assert.equal(fs.readFileSync(file, "utf8"), botToken(9) + "\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const byId = ok(await cli(["admin", "bots", "rotate", bots[0].id])).json;
  assert.equal(byId.bot.name, "大肥鱼");
  const nobody = await cli(["admin", "bots", "rotate", "无名氏"]);
  assert.equal(nobody.error.code, "not_found");
  assert.match(nobody.error.next[0], /admin bots list/);
});

test("requests list --status in Chinese or English; the status shown; --author on dev list and admin issues", async () => {
  for (const [given, sent] of [["未处理", "new"], ["正在完成", "in_progress"], ["进行中", "in_progress"], ["已完成", "done"], ["已拒绝", "rejected"], ["拒绝", "rejected"],
    ["in_progress", "in_progress"], ["DONE", "done"], ["new", "new"]]) {
    ok(await cli(["requests", "list", CODE, "--status", given]));
    assert.equal(new URLSearchParams(lastCreate.query).get("status"), sent, given);
  }
  const bad = await cli(["requests", "list", CODE, "--status", "accepted"]);
  assert.equal(bad.code, 2);
  assert.equal(bad.error.field, "status");
  assert.match(bad.error.error, /未处理 \(new\).*已拒绝 \(rejected\)/);
  assert.match(ok(await cli(["requests", "list", CODE, "--lang", "zh"], {json: false})).stdout, /#1  \[正在完成\]  Swing/);
  assert.match(ok(await cli(["requests", "list", CODE], {json: false})).stdout, /#1  \[In progress\]  Swing/);
  const shown = ok(await cli(["requests", "show", CODE, "1", "--lang", "zh"], {json: false})).stdout;
  assert.match(shown, /#1  \[已完成\]  Swing/);
  assert.match(shown, /附件 \(1\):\n\s+image\s+shot\.png\s+2 KB\s+https:\/\/media\.test\/a\.png/);
  ok(await cli(["dev", "list", "--author", "大肥鱼"]));
  assert.equal(lastCreate.path, "/api/dev/requests");
  assert.equal(new URLSearchParams(lastCreate.query).get("author"), "大肥鱼");
  ok(await cli(["admin", "issues", "--author", "b1xxxxxx", "--kind", "bug"]));
  assert.equal(lastCreate.path, "/api/dev/community/issues");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(lastCreate.query)), {kind: "bug", author: "b1xxxxxx"});
});
