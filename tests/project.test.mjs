// A project's life with 203c, against a stand-in API and a stand-in CardenzaHAL (a local git repository with the template):
// new (the project made from the template, named, the HAL as a submodule), inbox (what the community said since the last
// look, as JSON and Markdown, then nothing new), link (203.json, the page's source link, the trusted publisher, --move).
// Run: node --test tests/project.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {run, standInApi} from "./fixtures.mjs";

const TOKEN = "cct_" + "b".repeat(64);
const GIT = spawnSync("git", ["--version"]).status === 0;
let stand, root, hal, home;
const state = {publishers: [{id: 7, repository: "olduser/pocket-metronome", workflow: "firmware.yml", channels: ["stable", "beta", "dev"]}], edits: [], removed: []};

const git = (args, cwd) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=tester", "-c", "init.defaultBranch=main", ...args], {cwd, encoding: "utf8"});

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "203c-project-"));
  home = path.join(root, "config");
  // A stand-in CardenzaHAL: the template's files that new renames, and the build tool.
  hal = path.join(root, "CardenzaHAL");
  const t = path.join(hal, "examples", "template");
  fs.mkdirSync(path.join(t, "main"), {recursive: true});
  fs.mkdirSync(path.join(t, ".github", "workflows"), {recursive: true});
  fs.mkdirSync(path.join(hal, "tools"), {recursive: true});
  fs.writeFileSync(path.join(t, "CMakeLists.txt"), "# build/my_firmware.bin\ncmake_minimum_required(VERSION 3.16)\nproject(my_firmware)\n");
  fs.writeFileSync(path.join(t, "203.json"), JSON.stringify({format: 1, name: "My Firmware", code: null, summary: "The template", tags: ["tool"], devices: ["cardenza"],
    publish_source: false, publish: {channel: "stable", bins: {cardenza: "build/my_firmware.bin"}, notes_file: "CHANGELOG.md"}}, null, 2));
  fs.writeFileSync(path.join(t, "main", "main.cpp"), "// my_firmware\nextern \"C\" void app_main() {}\n");
  fs.writeFileSync(path.join(t, ".github", "workflows", "firmware.yml"), "jobs:\n  firmware:\n    steps:\n      - with:\n          elf: build/my_firmware.elf\n");
  fs.writeFileSync(path.join(t, "version.txt"), "0.1.0\n");
  fs.writeFileSync(path.join(hal, "tools", "cardenza.py"), "print('build')\n");
  fs.writeFileSync(path.join(hal, "cardenzaHAL.h"), "#pragma once\n");
  if (GIT) { git(["init", "-q", hal]); git(["add", "-A"], hal); git(["commit", "-q", "-m", "hal"], hal); }

  const later = new Date(Date.now() - 3600e3).toISOString(), earlier = new Date(Date.now() - 30 * 86400e3).toISOString();
  stand = await standInApi((req, send, body) => {
    const authed = req.headers.authorization === "Bearer " + TOKEN;
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/") return send(200, {version: 2, limits: {}});
    if (!authed && req.method === "POST") return send(401, {error: "Sign in first", code: "signin_required"});
    if (url.pathname === "/api/me") return authed ? send(200, {id: "u1", name: "Ada", role: "user", scopes: ["read", "write"]}) : send(401, {error: "Sign in first", code: "signin_required"});
    if (url.pathname === "/api/firmware/K7M2QX") return send(200, {code: "K7M2QX", name: "Pocket Metronome", owner: {id: "u1", name: "Ada"}, source_url: "https://github.com/olduser/pocket-metronome",
      counts: {downloads: 12, likes: 3, family: 0}});
    if (url.pathname === "/api/firmware/V6QK28") return send(200, {code: "V6QK28", name: "Cardenza Synth", owner: {id: "u9", name: "203 Systems"}});
    if (url.pathname === "/api/dev/requests") {
      assert.equal(url.searchParams.get("firmware"), "K7M2QX");
      return send(200, {total: 3, page: 1, page_size: 24, items: [
        {number: 4, title: "Tap tempo", body: "Tap ENTER four times", author: {name: "bo"}, created: later, votes: 5, comments: 2, internal: {status: "new", progress: 0, updated: later}},
        {number: 2, title: "Accent on the first beat", author: {name: "cy"}, created: earlier, votes: 2, comments: 1, internal: {status: "planned", progress: 10, updated: earlier}},
        {number: 1, title: "Louder click", author: {name: "di"}, created: earlier, votes: 1, comments: 0, internal: {status: "done", progress: 100, updated: earlier}}]});
    }
    if (url.pathname === "/api/firmware/K7M2QX/comments") return send(200, {items: [
      {id: 31, author: {name: "bo"}, created: later, body: "The click is too quiet on the speaker", replies: [{id: 32, author: {name: "Ada"}, created: later, body: "Next version"}]},
      {id: 20, author: {name: "cy"}, created: earlier, body: "Nice"}]});
    if (url.pathname === "/api/firmware/K7M2QX/merges") return send(200, {items: []});
    if (url.pathname === "/api/firmware/K7M2QX/versions") return send(200, {items: [{code: "V2B3C4", version: "0.2.0", channel: "stable", status: "rejected", created: later},
      {code: "V2B3C5", version: "0.1.0", channel: "stable", status: "published", created: earlier}]});
    if (url.pathname === "/api/me/notifications") return send(200, {items: [{id: 1, kind: "request", read: false, created: later, subject: {kind: "request", ref: "K7M2QX/4", title: "Tap tempo"}, text: "bo asked: Tap tempo"},
      {id: 2, kind: "like", read: false, created: later, subject: {kind: "firmware", ref: "ZZZZZZ", title: "Other"}}], unread: 2});
    if (url.pathname === "/api/firmware/K7M2QX/publishers" && req.method === "GET") return send(200, {items: state.publishers});
    if (url.pathname === "/api/firmware/K7M2QX/publishers" && req.method === "POST") {
      const p = {id: 8, ...JSON.parse(body)};
      state.publishers.push(p);
      return send(201, p);
    }
    const removed = /^\/api\/firmware\/K7M2QX\/publishers\/(\d+)\/delete$/.exec(url.pathname);
    if (removed) { state.removed.push(Number(removed[1])); state.publishers = state.publishers.filter(p => p.id !== Number(removed[1])); return send(200, {status: "removed"}); }
    if (url.pathname === "/api/firmware/K7M2QX/edit") { state.edits.push(JSON.parse(body)); return send(200, {code: "K7M2QX"}); }
    return false;
  });
});
after(async () => { await stand.close(); fs.rmSync(root, {recursive: true, force: true}); });

const cli = (args, {cwd = root, token = TOKEN, env = {}} = {}) =>
  run(["--api", stand.api, ...args], {cwd, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: token, CI: "1", COMMUNITY_HAL_REPO: hal, ...env}});

test("new: the template named, CardenzaHAL as the submodule, 203.json and a README; nothing signed in needed", {skip: !GIT && "git"}, async () => {
  const r = await cli(["new", "Pocket Metronome", "--summary", "A metronome with tap tempo", "--json"], {token: ""});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.project, "pocket_metronome");
  const dir = path.join(root, "pocket-metronome");
  assert.equal(r.json.dir, dir);
  assert.ok(fs.existsSync(path.join(dir, "components", "CardenzaHAL", "cardenzaHAL.h")), "the HAL as a submodule");
  assert.match(fs.readFileSync(path.join(dir, ".gitmodules"), "utf8"), /components\/CardenzaHAL/);
  assert.match(fs.readFileSync(path.join(dir, "CMakeLists.txt"), "utf8"), /^project\(pocket_metronome\)$/m);
  assert.match(fs.readFileSync(path.join(dir, ".github/workflows/firmware.yml"), "utf8"), /elf: build\/pocket_metronome\.elf/);
  const project = JSON.parse(fs.readFileSync(path.join(dir, "203.json"), "utf8"));
  assert.equal(project.name, "Pocket Metronome");
  assert.equal(project.summary, "A metronome with tap tempo");
  assert.deepEqual(project.publish.bins, {cardenza: "build/pocket_metronome.bin"});
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /tools\/cardenza\.py build/, "the HAL's build tool");
  assert.ok(r.json.next.includes("203c flash --bin build/pocket_metronome.bin") || r.json.next.some(n => /flash --bin build\/pocket_metronome\.bin/.test(n)));
  assert.match(git(["status", "--porcelain"], dir).stdout, /^A  203\.json$/m, "staged, not committed");

  const again = await cli(["new", "Pocket Metronome", "--json"], {token: ""});
  assert.equal(again.code, 1);
  assert.equal(again.error.code, "dir_not_empty");
  const bad = await cli(["new", "x", "--json"], {token: ""});
  assert.equal(bad.code, 2, "a one-letter name is refused before anything is made");
  const dry = await cli(["new", "Drum Toy", "--dry-run", "--json"], {token: ""});
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.project, "drum_toy");
  assert.ok(!fs.existsSync(path.join(root, "drum-toy")));
});

test("inbox: what is new since the last look, as JSON and as Markdown for an agent; then nothing new", async () => {
  const dir = path.join(root, "inbox-project");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "203.json"), JSON.stringify({format: 1, name: "Pocket Metronome", code: "K7M2QX"}));
  fs.mkdirSync(path.join(home, "203c", "inbox"), {recursive: true});
  fs.writeFileSync(path.join(home, "203c", "inbox", "K7M2QX.json"), JSON.stringify({seen: new Date(Date.now() - 86400e3).toISOString(), requests: {4: 0, 2: 0}}));
  const r = await cli(["inbox", "--out", ".203/inbox.md", "--json"], {cwd: dir});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.firmware.code, "K7M2QX");
  assert.deepEqual(r.json.requests.map(q => q.number), [4, 2], "open requests; a done one only when it changed");
  assert.equal(r.json.new.requests, 1);
  assert.equal(r.json.requests.find(q => q.number === 2).new_comments, 1);
  assert.deepEqual(r.json.comments.map(c => c.id), [31, 32], "new comments and replies only");
  assert.deepEqual(r.json.sent_back.map(v => v.code), ["V2B3C4"]);
  assert.equal(r.json.notifications.length, 1, "unread and about this firmware");
  const md = fs.readFileSync(path.join(dir, ".203", "inbox.md"), "utf8");
  assert.match(md, /#4 \[new, 2 new comments\] Tap tempo: 5 votes/);
  assert.match(md, /dev read K7M2QX 4/);
  assert.match(md, /versions check V2B3C4/);
  const again = await cli(["inbox", "--json"], {cwd: dir});
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.new.requests, 0);
  assert.equal(again.json.comments.length, 0, "seen now");
  const none = await cli(["inbox", "--json"], {cwd: root});
  assert.equal(none.code, 2);
  assert.equal(none.error.code, "no_firmware");
});

test("link: 203.json, the page's source link and the trusted publisher follow the repository; --move unlinks the old one", {skip: !GIT && "git"}, async () => {
  const dir = path.join(root, "moved");
  fs.mkdirSync(dir, {recursive: true});
  git(["init", "-q", dir]);
  git(["remote", "add", "origin", "git@github.com:ada/pocket-metronome.git"], dir);
  fs.mkdirSync(path.join(dir, ".github", "workflows"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".github", "workflows", "firmware.yml"), "on: push\n");
  fs.writeFileSync(path.join(dir, "203.json"), JSON.stringify({format: 1, name: "Pocket Metronome", code: null}));
  const dry = await cli(["link", "K7M2QX", "--move", "--dry-run", "--json"], {cwd: dir});
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.json.steps.some(s => /add ada\/pocket-metronome \(firmware\.yml\)/.test(s)), dry.json.steps.join("\n"));
  assert.ok(dry.json.steps.some(s => /remove olduser\/pocket-metronome/.test(s)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "203.json"), "utf8")).code, null, "a dry run changes nothing");
  const r = await cli(["link", "K7M2QX", "--move", "--json"], {cwd: dir});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.status, "linked");
  const project = JSON.parse(fs.readFileSync(path.join(dir, "203.json"), "utf8"));
  assert.deepEqual([project.code, project.source], ["K7M2QX", "https://github.com/ada/pocket-metronome"]);
  assert.deepEqual(state.edits.at(-1), {source_url: "https://github.com/ada/pocket-metronome", clone_url: "https://github.com/ada/pocket-metronome.git"});
  assert.deepEqual(state.publishers.map(p => p.repository), ["ada/pocket-metronome"]);
  assert.deepEqual(state.removed, [7]);
  const theirs = await cli(["link", "V6QK28", "--json"], {cwd: dir});
  assert.equal(theirs.code, 1);
  assert.equal(theirs.error.code, "not_yours");
  assert.match(theirs.error.next[0], /fork V6QK28/);
});
