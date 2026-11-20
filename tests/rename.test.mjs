// 203c is renamed 203cli (scripts/rename.mjs): every old way in ends at 203cli and says so. The old script path
// (scripts/203c.mjs), the last 203c package (legacy/203c: its dependency found below it, beside it, on PATH or in the
// skill; none: exit 1), 203c's sign-in carried over once, doctor and updates under the old name, and a community that
// moved (code "moved": followed once, remembered, only to the community's own hosts; trusted publishing asks GitHub
// again for the new audience).
// Run: node --test tests/rename.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT, NO_UPDATES, standInApi} from "./fixtures.mjs";
import {CLI_VERSION, Client, ApiError, movedApi, oidcExchange, rememberedApi} from "../scripts/lib.mjs";
import * as rename from "../scripts/rename.mjs";
import * as legacy from "../legacy/203c/lib.mjs";
import {checkUpdates} from "../scripts/updates.mjs";

const TOKEN = "cct_" + "b".repeat(64);
const OLD_SCRIPT = path.join(ROOT, "scripts", "203c.mjs");
const LEGACY = path.join(ROOT, "legacy", "203c");
let stand, temp;

before(async () => {
  stand = await standInApi((req, send) => {
    if (req.url === "/api/") return send(200, {version: 2, limits: {}});
    if (req.url === "/api/me") {
      return req.headers.authorization === "Bearer " + TOKEN
        ? send(200, {id: "u1", name: "Tester", role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203cli on test"}})
        : send(401, {error: "Sign in first", code: "signin_required"});
    }
    if (req.url === "/api/auth/logout") return send(200, {status: "revoked"});
    if (req.url === "/api/me/quotas") return send(200, {items: []});
    return false;
  });
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-rename-"));
});
after(async () => { await stand.close(); fs.rmSync(temp, {recursive: true, force: true}); });

const fresh = name => { const dir = path.join(temp, name); fs.mkdirSync(dir, {recursive: true}); return dir; };

/** node SCRIPT args, as the tests' run() does it (no sandbox, no update checks, no CI annotations unless asked). */
function node(script, args, {env = {}, cwd = temp} = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {cwd, env: {...process.env, COMMUNITY_TOKEN: "", COMMUNITY_API: "", COMMUNITY_LANG: "",
      LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8", CLAUDE_CODE_REMOTE: "", CODEX_SANDBOX_NETWORK_DISABLED: "", GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "", C203_RUN_AS: "", CI: "1", ...NO_UPDATES, ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => {
      let json = null, error = null;
      try { json = JSON.parse(stdout); } catch { /* text */ }
      try { error = JSON.parse(stderr.trim().split("\n").pop()); } catch { /* text */ }
      resolve({code, stdout, stderr, json, error});
    });
  });
}
const notice = stderr => stderr.includes(rename.RENAME_ZH) && stderr.includes(rename.RENAME_EN);

test("the last 203c says the same words as 203cli, and its package depends on 203cli at this version", () => {
  for (const key of ["RENAME_ZH", "RENAME_EN", "RENAME_CI"]) assert.equal(legacy[key], rename[key], key);
  const pkg = JSON.parse(fs.readFileSync(path.join(LEGACY, "package.json"), "utf8"));
  const own = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "203c");
  assert.deepEqual(pkg.bin, {"203c": "203c.mjs"});
  assert.equal(pkg.dependencies["203cli"], "^" + own.version);
  assert.equal(own.name, "203cli");
  assert.deepEqual(own.bin, {"203cli": "scripts/203cli.mjs"});
  assert.equal(own.version, CLI_VERSION);
  for (const file of pkg.files) assert.ok(fs.existsSync(path.join(LEGACY, file)), file);
  // npm's own package has no 203c command (it would clash with the 203c package's).
  assert.ok(!Object.keys(own.bin).includes("203c"));
});

test("the old script path: the notice on stderr, then 203cli with the same arguments, output and exit code", async () => {
  const version = await node(OLD_SCRIPT, ["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout, CLI_VERSION + "\n");
  assert.ok(notice(version.stderr), version.stderr);
  // --json: stdout is the answer alone; an error is still stderr's last line, with its exit code.
  const help = await node(OLD_SCRIPT, ["--help", "--json"]);
  assert.equal(help.code, 0);
  assert.match(help.json.run_as, /^node \S*scripts\/203cli\.mjs$/, "the commands it prints name 203cli.mjs, not the old script");
  const wrong = await node(OLD_SCRIPT, ["nonsense", "--json"]);
  assert.equal(wrong.code, 2);
  assert.equal(wrong.error.code, "usage");
  assert.ok(notice(wrong.stderr));
  // In GitHub Actions: a warning annotation, and once a step a line in the job's summary.
  const summary = path.join(fresh("summary"), "step.md");
  for (let i = 0; i < 2; i++) {
    const ci = await node(OLD_SCRIPT, ["--version"], {env: {GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary}});
    assert.equal(ci.stdout, CLI_VERSION + "\n");
    assert.match(ci.stderr, /^::warning title=203c is renamed 203cli::This workflow still runs 203c/m);
  }
  const text = fs.readFileSync(summary, "utf8");
  assert.equal(text.split("203c is renamed 203cli.").length, 2, "said once: " + text);
});

/** A package folder like npm's: 203c (the legacy package's files), its 203cli `at` a folder that links to this checkout. */
function layout(name, {dependency}) {
  const root = fresh(name);
  const pkg = path.join(root, "node_modules", "203c");
  fs.mkdirSync(pkg, {recursive: true});
  for (const file of fs.readdirSync(LEGACY)) fs.copyFileSync(path.join(LEGACY, file), path.join(pkg, file));
  const link = dependency === "nested" ? path.join(pkg, "node_modules", "203cli") : dependency === "hoisted" ? path.join(root, "node_modules", "203cli") : null;
  if (link) {
    fs.mkdirSync(path.dirname(link), {recursive: true});
    // A junction on Windows (no privilege needed), a symlink elsewhere: npm's own links are the same kinds.
    fs.symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
  }
  return path.join(pkg, "203c.mjs");
}

test("the last 203c finds its 203cli below it or beside it and runs it as 203c (same output, exit code, commands named 203c)", async () => {
  for (const dependency of ["nested", "hoisted"]) {
    const script = layout(dependency, {dependency});
    assert.equal(legacy.findCli({from: pathToFileURL(script).href, env: {PATH: ""}})?.via, "dependency");
    const version = await node(script, ["--version"], {env: {PATH: ""}});
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout, CLI_VERSION + "\n", dependency);
    assert.ok(notice(version.stderr));
    const help = await node(script, ["--help", "--json"]);
    assert.equal(help.json.run_as, "203c", "next: lines say 203c, the command installed there");
    const wrong = await node(script, ["publish", "--nonsense-flag", "--json"]);
    assert.equal(wrong.code, 2);
    assert.match(wrong.error.next[0], /^203c /);
    // A command that goes to the API, under the old name: the API sees 203cli.
    const doctor = await node(script, ["--api", stand.api, "whoami", "--json"], {env: {COMMUNITY_TOKEN: TOKEN, XDG_CONFIG_HOME: fresh(dependency + "-config")}});
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(doctor.json.id ?? doctor.json.user?.id ?? doctor.json.me?.id, "u1");
  }
});

test("the last 203c without its dependency: a 203cli on PATH, else the skill's copy, else the notice and exit 1", async () => {
  const script = layout("alone", {dependency: null});
  // npm's global layout on Windows: <prefix>\203cli.cmd beside <prefix>\node_modules\203cli.
  const windows = fresh("prefix-win");
  fs.mkdirSync(path.join(windows, "node_modules"), {recursive: true});
  fs.symlinkSync(ROOT, path.join(windows, "node_modules", "203cli"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(windows, "203cli.cmd"), "@ECHO off\r\nnode \"%dp0%\\node_modules\\203cli\\scripts\\203cli.mjs\" %*\r\n");
  assert.equal(legacy.findCli({env: {PATH: windows}, from: "file:///nowhere/x.mjs", home: fresh("nohome")})?.via, "path");
  let run = await node(script, ["--version"], {env: {PATH: windows}});
  assert.equal(run.stdout, CLI_VERSION + "\n", run.stderr);
  // install.sh's two-line script.
  const bin = fresh("bin-sh");
  fs.writeFileSync(path.join(bin, "203cli"), `#!/bin/sh\nexec node "${path.join(ROOT, "scripts", "203cli.mjs")}" "$@"\n`);
  assert.equal(legacy.findCli({env: {PATH: bin}, from: "file:///nowhere/x.mjs", home: fresh("nohome2")})?.file, path.join(ROOT, "scripts", "203cli.mjs"));
  // npm's link on macOS and Linux.
  if (process.platform !== "win32") {
    const link = fresh("bin-link");
    fs.symlinkSync(path.join(ROOT, "scripts", "203cli.mjs"), path.join(link, "203cli"));
    assert.equal(legacy.findCli({env: {PATH: link}, from: "file:///nowhere/x.mjs", home: fresh("nohome3")})?.via, "path");
  }
  // The Agent Skill's copy.
  const skills = fresh("skills");
  fs.mkdirSync(path.join(skills, "203-community"));
  fs.symlinkSync(path.join(ROOT, "scripts"), path.join(skills, "203-community", "scripts"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(legacy.findCli({env: {PATH: "", CLAUDE_SKILLS_DIR: skills}, from: "file:///nowhere/x.mjs"})?.via, "skill");
  run = await node(script, ["--version"], {env: {PATH: "", CLAUDE_SKILLS_DIR: skills}});
  assert.equal(run.stdout, CLI_VERSION + "\n");
  // None: the notice, where to get it, exit 1, nothing on stdout.
  run = await node(script, ["publish", "--json"], {env: {PATH: "", CLAUDE_SKILLS_DIR: fresh("empty-skills")}});
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.ok(notice(run.stderr));
  assert.match(run.stderr, /203cli was not found/);
});

test("203c's sign-in carries over once (mode 600, nothing printed), 203c's folder stays, logout removes both copies", async () => {
  const config = fresh("migrate");
  fs.mkdirSync(path.join(config, "203c", "inbox"), {recursive: true});
  fs.writeFileSync(path.join(config, "203c", "token"), TOKEN + "\n", {mode: 0o600});
  fs.writeFileSync(path.join(config, "203c", "inbox", "ABC123.json"), "{\"seen\":1}\n");
  const cli = path.join(ROOT, "scripts", "203cli.mjs");
  const who = await node(cli, ["--api", stand.api, "whoami", "--json"], {env: {XDG_CONFIG_HOME: config}});
  assert.equal(who.code, 0, who.stderr);
  assert.ok(!who.stdout.includes(TOKEN) && !who.stderr.includes(TOKEN), "the token is never printed");
  const saved = path.join(config, "203cli", "token");
  assert.equal(fs.readFileSync(saved, "utf8").trim(), TOKEN);
  if (process.platform !== "win32") assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(config, "203cli", "inbox", "ABC123.json")));
  assert.equal(fs.readFileSync(path.join(config, "203c", "token"), "utf8").trim(), TOKEN, "203c's folder is left as it is");
  // Once: a later 203c sign-in is not copied over 203cli's (nor after a logout).
  fs.writeFileSync(path.join(config, "203c", "token"), "cct_" + "c".repeat(64) + "\n");
  fs.unlinkSync(saved);
  await node(cli, ["--api", stand.api, "doctor", "--json"], {env: {XDG_CONFIG_HOME: config}});
  assert.ok(!fs.existsSync(saved));
  // logout: the same token in 203c's folder goes too, another one stays.
  fs.writeFileSync(saved, TOKEN + "\n", {mode: 0o600});
  fs.writeFileSync(path.join(config, "203c", "token"), TOKEN + "\n");
  const out = await node(cli, ["--api", stand.api, "logout", "--json"], {env: {XDG_CONFIG_HOME: config}});
  assert.equal(out.json.status, "revoked", out.stderr);
  assert.ok(!fs.existsSync(saved) && !fs.existsSync(path.join(config, "203c", "token")));
});

test("doctor and updates under the old name say it is renamed; doctor names a 203c still on PATH", async () => {
  const items = (await checkUpdates({fresh: true, env: {C203_NPM_REGISTRY: "http://127.0.0.1:9"}, file: path.join(fresh("u"), "u.json"), hal: false,
    fetch: async () => { throw new Error("offline"); }, timeout: 200, oldName: true})).items;
  assert.equal(items[0].code, "cli_renamed");
  assert.equal(items[0].notice, rename.RENAME_EN);
  assert.ok(items[0].next.includes("npm install -g 203cli"));
  const plain = (await checkUpdates({fresh: true, env: {}, file: path.join(fresh("u2"), "u.json"), hal: false,
    fetch: async () => { throw new Error("offline"); }, timeout: 200, oldName: false})).items;
  assert.ok(!plain.some(i => i.code === "cli_renamed"));
  // A 203c on PATH (npm's, here a stand-in): doctor warns, with how to remove it.
  const bin = fresh("old-bin");
  fs.mkdirSync(path.join(bin, "node_modules", "203c"), {recursive: true});
  fs.writeFileSync(path.join(bin, "203c.cmd"), "@ECHO off\r\nnode \"%dp0%\\node_modules\\203c\\203c.mjs\" %*\r\n");
  const doctor = await node(path.join(ROOT, "scripts", "203cli.mjs"), ["--api", stand.api, "doctor", "--json"],
    {env: {XDG_CONFIG_HOME: fresh("doc"), PATH: bin + path.delimiter + process.env.PATH, COMMUNITY_TOKEN: TOKEN}});
  const warning = doctor.json.warnings.find(w => w.code === "old_name_installed");
  assert.ok(warning, JSON.stringify(doctor.json.warnings));
  assert.ok(warning.next.includes("npm uninstall -g 203c"));
  assert.ok(doctor.json.checks.some(c => c.name === "old_name" && !c.ok));
});

test("a moved community: followed once and remembered (one line), only to the community's own hosts; the API sees 203cli", async () => {
  const agents = [];
  const moved = await standInApi((req, send) => { agents.push(req.headers["user-agent"]); return send(410, {error: "The community moved", code: "moved", api: stand.api}); });
  try {
    const config = fresh("moved");
    const cli = path.join(ROOT, "scripts", "203cli.mjs");
    const first = await node(cli, ["--api", moved.api, "whoami", "--json"], {env: {XDG_CONFIG_HOME: config, COMMUNITY_TOKEN: TOKEN}});
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.id ?? first.json.user?.id, "u1");
    assert.equal(first.stderr.trim().split("\n").filter(l => /moved from/.test(l)).length, 1, first.stderr);
    assert.match(first.stderr, new RegExp(`moved from ${moved.api} to ${stand.api}`));
    assert.deepEqual(agents, ["203cli/" + CLI_VERSION]);
    const kept = JSON.parse(fs.readFileSync(path.join(config, "203cli", "api.json"), "utf8"));
    assert.equal(kept.moves[moved.api].api, stand.api);
    assert.ok(Date.parse(kept.moves[moved.api].at));
    // The next run goes straight there, quietly.
    const second = await node(cli, ["--api", moved.api, "whoami", "--json"], {env: {XDG_CONFIG_HOME: config, COMMUNITY_TOKEN: TOKEN}});
    assert.equal(second.code, 0);
    assert.equal(agents.length, 1);
    assert.ok(!/moved from/.test(second.stderr));
    assert.equal(rememberedApi(moved.api, {XDG_CONFIG_HOME: config}), stand.api);
  } finally { await moved.close(); }
  // Never to a host that is not the community's: the token stays home, and the error says what happened.
  const away = await standInApi((req, send) => send(410, {error: "The community moved", code: "moved", api: "https://elsewhere.test/api"}));
  try {
    const run = await node(path.join(ROOT, "scripts", "203cli.mjs"), ["--api", away.api, "whoami", "--json"], {env: {XDG_CONFIG_HOME: fresh("away"), COMMUNITY_TOKEN: TOKEN}});
    assert.equal(run.code, 1);
    assert.equal(run.error.code, "moved");
    assert.match(run.error.hint, /did not follow/);
    assert.equal(away.requests.length, 1);
  } finally { await away.close(); }
  assert.equal(movedApi("https://cardenza.203.io/community/api", "https://stage.203.io/api/"), "https://stage.203.io/api");
  assert.equal(movedApi("https://cardenza.203.io/community/api", "http://stage.203.io/api"), null, "https only");
  assert.equal(movedApi("https://cardenza.203.io/community/api", "https://stage.203.io.elsewhere.test/api"), null);
  assert.equal(movedApi("https://cardenza.203.io/community/api", "http://127.0.0.1:1/api"), null, "not from the live community to a local one");
});

test("trusted publishing across a move: a new GitHub token for the new address's audience", async () => {
  const audiences = [];
  const github = http.createServer((req, res) => {
    const audience = new URL(req.url, "http://localhost").searchParams.get("audience");
    audiences.push(audience);
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify({value: "jwt:" + audience}));
  });
  await new Promise(resolve => github.listen(0, "127.0.0.1", resolve));
  const now = await standInApi((req, send, body) => {
    if (req.url !== "/api/auth/oidc/github") return false;
    const got = JSON.parse(body);
    return got.token === "jwt:" + now.api ? send(200, {token: "cct_" + "d".repeat(64), firmware: got.firmware, expires_at: new Date(Date.now() + 900e3).toISOString(),
      channel_allowed: ["dev"]}) : send(401, {error: "audience", code: "oidc_invalid", reason: "audience"});
  });
  const old = await standInApi((req, send) => send(410, {error: "moved", code: "moved", api: now.api}));
  try {
    const env = {ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${github.address().port}/token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      XDG_CONFIG_HOME: fresh("oidc")};
    const lines = [];
    const client = new Client({api: old.api, token: null, env, onMove: move => lines.push(move)});
    const got = await oidcExchange(client, "ABC123", {env});
    assert.equal(got.firmware, "ABC123");
    assert.deepEqual(audiences, [old.api, now.api]);
    assert.equal(client.api, now.api);
    assert.equal(lines.length, 1);
  } finally { await old.close(); await now.close(); await new Promise(resolve => github.close(resolve)); }
  assert.ok(ApiError);
});
