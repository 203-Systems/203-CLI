// A project's life with 203cli, against a stand-in API and a stand-in CardenzaHAL (a local git repository with the template):
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-project-"));
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
  const middle = new Date(Date.now() - 10 * 86400e3).toISOString();
  // Source archives as publish_source makes them (git archive, one top folder): 0.1.0, 0.1.1 and a fork's.
  const archives = {};
  if (GIT) {
    const src = path.join(root, "src");
    git(["init", "-q", src]);
    const snap = (name, files) => {
      for (const [file, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(src, file), {force: true});
        else { fs.mkdirSync(path.dirname(path.join(src, file)), {recursive: true}); fs.writeFileSync(path.join(src, file), text); }
      }
      git(["add", "-A"], src); git(["commit", "-q", "-m", name], src);
      archives[name] = spawnSync("git", ["archive", "--format=tar.gz", "--prefix=pocket-metronome/", "HEAD"], {cwd: src}).stdout;
    };
    snap("0.1.0", {"main/main.cpp": "int bpm = 120;\nvoid tick() {}\n", "README.md": "# Pocket Metronome\n"});
    snap("0.1.1", {"main/main.cpp": "int bpm = 120;\nint accent = 1;\nvoid tick() {}\n"});
    snap("fork", {"main/main.cpp": "int bpm = 140;\nint accent = 1;\nvoid tick() {}\n", "main/tap.cpp": "void tap() {}\n", "README.md": null});
  }
  stand = await standInApi((req, send, body) => {
    const authed = req.headers.authorization === "Bearer " + TOKEN;
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/") return send(200, {version: 2, limits: {}});
    if (!authed && req.method === "POST") return send(401, {error: "Sign in first", code: "signin_required"});
    if (url.pathname === "/api/me") return authed ? send(200, {id: "u1", name: "Ada", role: "user", scopes: ["read", "write"]}) : send(401, {error: "Sign in first", code: "signin_required"});
    if (url.pathname === "/api/firmware/K7M2QX") return send(200, {code: "K7M2QX", name: "Pocket Metronome", owner: {id: "u1", name: "Ada"}, source_url: "https://github.com/olduser/pocket-metronome",
      summary: "A metronome with tap tempo", description: "Tap **ENTER** four times.", tags: ["tool"], license: "MIT",
      cover: {url: "/files/cover.png", size: 10, sha256: null}, latest: {stable: {code: "V2B3C6", version: "0.1.1", channel: "stable", published: middle}},
      counts: {downloads: 12, likes: 3, family: 0}});
    const archive = /^\/files\/src-(.+)\.tar\.gz$/.exec(url.pathname);
    if (archive && archives[archive[1]]) return send(200, archives[archive[1]], "application/gzip");
    const src = v => ({url: `/files/src-${v}.tar.gz`, size: archives[v]?.length ?? 0, sha256: "", files: 2, uploaded: earlier});
    const versions = {"0.1.0": {code: "V2B3C5", version: "0.1.0", channel: "stable", status: "published", published: earlier, created: earlier, notes: "First version.", source: src("0.1.0")},
      "0.1.1": {code: "V2B3C6", version: "0.1.1", channel: "stable", status: "published", published: middle, created: middle, notes: "- Accents.", source: src("0.1.1")}};
    const byLabel = /^\/api\/firmware\/K7M2QX\/versions\/([0-9.]+)$/.exec(url.pathname);
    if (byLabel) return versions[byLabel[1]] ? send(200, {...versions[byLabel[1]], firmware: {code: "K7M2QX", name: "Pocket Metronome"}}) : send(404, {error: "Not found", code: "not_found"});
    if (url.pathname === "/api/codes/FRK234") return send(200, {kind: "firmware", firmware: "FRK234", version: null});
    if (url.pathname === "/api/firmware/FRK234") return send(200, {code: "FRK234", name: "Pocket Metronome Pro", owner: {id: "u5", name: "eve"},
      source_archive: {version: {code: "FRV234", version: "0.2.0", channel: "stable", published: later}, url: "/files/src-fork.tar.gz", size: 1, sha256: "", files: 2}});
    if (url.pathname === "/api/firmware" && url.searchParams.get("family") === "K7M2QX") return send(200, {items: [
      {code: "FRK234", name: "Pocket Metronome Pro", owner: {id: "u5", name: "eve"}, summary: "Faster, with tap tempo", forked_from: {code: "K7M2QX", name: "Pocket Metronome", version: {code: "V2B3C5", version: "0.1.0"}},
        latest: {stable: {code: "FRV234", version: "0.2.0", channel: "stable", published: later}}, counts: {likes: 1, downloads: 3, forks: 0}}], next_cursor: null});
    if (url.pathname === "/api/comments/31/replies") return send(200, {total: 2, page: 1, page_size: 24, items: [
      {id: 32, author: {id: "u1", name: "Ada"}, created: later, body: "Next version", likes: 1}, {id: 33, author: {id: "u2", name: "bo"}, created: later, body: "Thanks!"}]});
    const read = /^\/api\/dev\/requests\/K7M2QX\/(\d+)$/.exec(url.pathname);
    if (read) return send(200, {number: Number(read[1]), discussion: read[1] === "4"
      ? [{id: 50, author: {id: "u2", name: "bo"}, created: later, body: "Please"}, {id: 51, author: {id: "u1", name: "Ada"}, created: later, body: "Planned for 0.2.0"}]
      : [{id: 52, author: {id: "u3", name: "cy"}, created: earlier, body: "+1"}]});
    if (url.pathname === "/api/firmware/V6QK28") return send(200, {code: "V6QK28", name: "Cardenza Synth", owner: {id: "u9", name: "203 Systems"}});
    if (url.pathname === "/api/dev/requests") {
      assert.equal(url.searchParams.get("firmware"), "K7M2QX");
      return send(200, {total: 3, page: 1, page_size: 24, items: [
        {number: 4, title: "Tap tempo", body: "Tap ENTER four times", author: {name: "bo"}, created: later, votes: 5, comments: 2, internal: {status: "new", progress: 0, updated: later}},
        {number: 2, title: "Accent on the first beat", author: {name: "cy"}, created: earlier, votes: 2, comments: 1, internal: {status: "planned", progress: 10, updated: earlier}},
        {number: 1, title: "Louder click", author: {name: "di"}, created: earlier, votes: 1, comments: 0, internal: {status: "done", progress: 100, updated: earlier}}]});
    }
    if (url.pathname === "/api/firmware/K7M2QX/comments") return send(200, {items: [
      {id: 31, author: {id: "u2", name: "bo"}, created: later, body: "The click is too quiet on the speaker", likes: 2, reply_count: 2, replies: [{id: 32, author: {id: "u1", name: "Ada"}, created: later, body: "Next version"}]},
      {id: 20, author: {name: "cy"}, created: earlier, body: "Nice"}]});
    if (url.pathname === "/api/firmware/K7M2QX/merges") return send(200, {items: []});
    if (url.pathname === "/api/firmware/K7M2QX/versions") return send(200, {total: 3, page: 1, page_size: 24, items: [{code: "V2B3C4", version: "0.2.0", channel: "stable", status: "rejected", created: later},
      versions["0.1.1"], versions["0.1.0"]]});
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
  assert.equal(fs.realpathSync(r.json.dir), fs.realpathSync(dir));
  assert.ok(fs.existsSync(path.join(dir, "components", "CardenzaHAL", "cardenzaHAL.h")), "the HAL as a submodule");
  assert.match(fs.readFileSync(path.join(dir, ".gitmodules"), "utf8"), /components\/CardenzaHAL/);
  assert.match(fs.readFileSync(path.join(dir, "CMakeLists.txt"), "utf8"), /^project\(pocket_metronome\)$/m);
  assert.match(fs.readFileSync(path.join(dir, ".github/workflows/firmware.yml"), "utf8"), /elf: build\/pocket_metronome\.elf/);
  const project = JSON.parse(fs.readFileSync(path.join(dir, "203.json"), "utf8"));
  assert.equal(project.name, "Pocket Metronome");
  assert.equal(project.summary, "A metronome with tap tempo");
  assert.deepEqual(project.publish.bins, {cardenza: "build/pocket_metronome.bin"});
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /tools\/cardenza\.py build/, "the HAL's build tool");
  // The page's description from the guide's template (a HAL without one: 203cli writes it), named in 203.json; the
  // screenshots to take before the first publish.
  assert.equal(project.publish.description_file, "docs/description.md");
  assert.match(fs.readFileSync(path.join(dir, "docs/description.md"), "utf8"), /^<What it is and who it is for/);
  assert.ok(r.json.todo.some(t => /docs\/description\.md: the page's description/.test(t)) && r.json.todo.some(t => /publish\.images/.test(t)), JSON.stringify(r.json.todo));
  assert.ok(r.json.next.includes("203cli flash --bin build/pocket_metronome.bin") || r.json.next.some(n => /flash --bin build\/pocket_metronome\.bin/.test(n)));
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
  fs.mkdirSync(path.join(dir, ".203"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".203", "state.json"), JSON.stringify({K7M2QX: {seen: new Date(Date.now() - 86400e3).toISOString(), requests: {4: 0, 2: 0}}}));
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

test("skill install: the Agent Skill from this 203cli into a skills folder, replaced whole on an update; doctor sees it", async () => {
  const skills = path.join(root, "skills");
  const dry = await cli(["skill", "install", "--dir", skills, "--dry-run", "--json"], {token: ""});
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(!fs.existsSync(skills), "a dry run writes nothing");
  const r = await cli(["skill", "install", "--dir", skills, "--json"], {token: ""});
  assert.equal(r.code, 0, r.stderr);
  const dir = path.join(skills, "203-community");
  for (const item of ["SKILL.md", "LICENSE", "scripts/203cli.mjs", "reference/cli.md", "products/cardenza/README.md"]) assert.ok(fs.existsSync(path.join(dir, item)), item);
  fs.writeFileSync(path.join(dir, "stale.txt"), "old");
  const again = await cli(["skill", "install", "--dir", skills, "--json"], {token: ""});
  assert.equal(again.json.skill[0].status, "updated");
  assert.ok(!fs.existsSync(path.join(dir, "stale.txt")), "replaced whole");
  const home = path.join(root, "home-skill");
  const doctor = await cli(["doctor", "--json"], {token: "", env: {HOME: home, USERPROFILE: home, CLAUDE_SKILLS_DIR: skills}});
  assert.equal(doctor.json.checks.find(c => c.name === "skill").ok, true, JSON.stringify(doctor.json.checks));
  const none = await cli(["doctor", "--json"], {token: "", env: {HOME: home, USERPROFILE: home, CLAUDE_SKILLS_DIR: path.join(root, "no-skills")}});
  assert.ok(none.json.warnings.some(w => w.code === "skill_missing"), JSON.stringify(none.json.warnings));
});

test("sync, project show / versions / feedback / forks: the page, versions, requests and comments with their threads, forks; one report for an agent", {skip: !GIT && "git"}, async () => {
  const dir = path.join(root, "sync-project");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "203.json"), JSON.stringify({format: 1, name: "Pocket Metronome", code: "K7M2QX"}));
  const show = await cli(["project", "show", "--json"], {cwd: dir});
  assert.equal(show.code, 0, show.stderr);
  assert.equal(show.json.firmware.description, "Tap **ENTER** four times.");
  assert.match(show.json.firmware.cover_url, /^http:\/\/127\.0\.0\.1:\d+\/files\/cover\.png$/);
  assert.deepEqual(show.json.versions.map(v => v.version), ["0.2.0", "0.1.1", "0.1.0"]);
  assert.equal(show.json.versions[1].notes, "- Accents.");
  const text = await cli(["project", "show"], {cwd: dir});
  assert.match(text.stdout, /^# Pocket Metronome \(K7M2QX\)/);

  const fb = await cli(["project", "feedback", "--since", "all", "--json"], {cwd: dir});
  assert.equal(fb.code, 0, fb.stderr);
  assert.equal(fb.json.owner, true);
  const tap = fb.json.requests.find(r => r.number === 4);
  assert.deepEqual([tap.answered, tap.discussion.length, tap.status], [true, 2, "new"]);
  assert.equal(fb.json.requests.find(r => r.number === 2).answered, false);
  const thread = fb.json.comments.find(c => c.id === 31);
  assert.deepEqual(thread.replies.map(r => r.id), [32, 33], "every reply, beyond the newest the list carries");
  assert.equal(thread.answered, true);
  assert.equal(thread.likes, 2);
  assert.equal(thread.version_at, "0.1.1", "the version newest when it was written");
  assert.equal(fb.json.comments.find(c => c.id === 20).version_at, "0.1.0");

  const forks = await cli(["project", "forks", "--json"], {cwd: dir});
  assert.equal(forks.code, 0, forks.stderr);
  assert.deepEqual(forks.json.items.map(f => [f.code, f.owner, f.base.version, f.latest.stable]), [["FRK234", "eve", "0.1.0", "0.2.0"]]);

  const sync = await cli(["sync", "--json"], {cwd: dir});
  assert.equal(sync.code, 0, sync.stderr);
  const md = fs.readFileSync(path.join(dir, ".203", "community.md"), "utf8");
  for (const part of ["# Pocket Metronome (K7M2QX)", "Tap **ENTER** four times.", "### 0.1.1 (V2B3C6)", "### #4 Tap tempo", "Planned for 0.2.0", "Thanks!", "Pocket Metronome Pro (FRK234)"]) {
    assert.ok(md.includes(part), part);
  }
  const report = JSON.parse(fs.readFileSync(path.join(dir, ".203", "community.json"), "utf8"));
  assert.equal(report.forks.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, ".203", "state.json"), "utf8")).K7M2QX.seen, "the look remembered in the project");
  const again = await cli(["project", "feedback", "--new", "--json"], {cwd: dir});
  assert.equal(again.json.requests.length + again.json.comments.length, 0, "nothing new right after a sync");
});

test("project diff: two versions' source archives, a fork against this folder; --patch the unified diff", {skip: !GIT && "git"}, async () => {
  const dir = path.join(root, "diff-project");
  fs.mkdirSync(path.join(dir, "main"), {recursive: true});
  git(["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, "203.json"), JSON.stringify({format: 1, name: "Pocket Metronome", code: "K7M2QX"}));
  fs.writeFileSync(path.join(dir, "main", "main.cpp"), "int bpm = 120;\nint accent = 1;\nvoid tick() {}\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Pocket Metronome\n");
  git(["add", "-A"], dir);
  const versions = await cli(["project", "diff", "0.1.0", "0.1.1", "--json"], {cwd: dir});
  assert.equal(versions.code, 0, versions.stderr);
  assert.deepEqual(versions.json.files.changed, [{path: "main/main.cpp", added: 1, deleted: 0, binary: false}]);
  assert.deepEqual([versions.json.a.version, versions.json.b.version], ["0.1.0", "0.1.1"]);
  const fork = await cli(["project", "diff", "FRK234", "--patch", "--json"], {cwd: dir});
  assert.equal(fork.code, 0, fork.stderr);
  assert.equal(fork.json.a.kind, "firmware");
  assert.equal(fork.json.b.kind, "local");
  assert.deepEqual(fork.json.files.added.map(f => f.path), ["203.json", "README.md"], "only in this folder");
  assert.deepEqual(fork.json.files.removed.map(f => f.path), ["main/tap.cpp"], "only in the fork");
  assert.match(fork.json.patch, /^--- a\/main\/main\.cpp\n\+\+\+ b\/main\/main\.cpp\n@@ .*\n-int bpm = 140;\n\+int bpm = 120;/m);
  const none = await cli(["project", "diff", "9.9.9", "--json"], {cwd: dir});
  assert.equal(none.code, 1);
  assert.equal(none.error.code, "not_found");
});
