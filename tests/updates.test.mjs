// The update notices (scripts/updates.mjs): versions compared, npm's answer kept a day, failures and a network that never
// answers silent, the switches (CI, GITHUB_ACTIONS, NO_UPDATE_NOTIFIER, C203_NO_UPDATE_CHECK), a project whose CardenzaHAL
// submodule is behind its main, at it, or not a clean copy (the HAL's own check_submodule.py), against a stand-in
// fetch; then 203c itself against stand-in npm and GitHub servers: the notices on stderr only (before an error's JSON
// line), never in stdout or the exit code, nothing in CI, and `203c updates` (--json, --quiet).
// Run: node --test tests/updates.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {run} from "./fixtures.mjs";
import {CLI_VERSION} from "../scripts/lib.mjs";
import {automaticOff, checkUpdates, compareVersions, findHalSubmodule, githubRepo, startNotices, DAY_MS, UPDATE_CLI} from "../scripts/updates.mjs";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(PYTHON, ["--version"], {encoding: "utf8"}).status === 0;
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "203c-updates-")); });
after(() => fs.rmSync(dir, {recursive: true, force: true}));
const scratch = name => { const d = path.join(dir, name); fs.mkdirSync(d, {recursive: true}); return d; };
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=test", "-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], {cwd, encoding: "utf8"});
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A stand-in fetch: answer(url) gives {status, body} (or throws, or never answers); every URL asked is kept.
function fakeFetch(answer) {
  const asked = [];
  const fetch = async (url, {signal} = {}) => {
    asked.push(String(url));
    const got = await answer(String(url), signal);
    return {ok: got.status >= 200 && got.status < 300, status: got.status, json: async () => got.body};
  };
  return {fetch, asked};
}
const npm = version => url => url.endsWith("/203c/latest") ? {status: 200, body: {name: "203c", version}} : {status: 404, body: {}};
const NOW = Date.UTC(2026, 10, 20, 12);

test("versions: major.minor.patch, a pre-release below its release", () => {
  assert.equal(compareVersions("3.5.0", "3.5.1"), -1);
  assert.equal(compareVersions("3.10.0", "3.9.9"), 1);
  assert.equal(compareVersions("v3.5.0", "3.5.0"), 0);
  assert.equal(compareVersions("3.6.0-beta.1", "3.6.0"), -1);
  assert.equal(compareVersions("3.6.0-beta.2", "3.6.0-beta.10"), -1);
  assert.equal(compareVersions("3.6.0", "3.6.0-rc.1"), 1);
  assert.equal(compareVersions("4.0.0", "3.99.99"), 1);
  assert.equal(compareVersions("latest", "3.5.0"), null);
});

test("switches: CI, GITHUB_ACTIONS, NO_UPDATE_NOTIFIER and C203_NO_UPDATE_CHECK turn the notices off", () => {
  assert.equal(automaticOff({}), null);
  assert.equal(automaticOff({CI: "true"}), "CI");
  assert.equal(automaticOff({CI: "1"}), "CI");
  assert.equal(automaticOff({CI: "", GITHUB_ACTIONS: ""}), null);
  assert.equal(automaticOff({CI: "false"}), null);
  assert.equal(automaticOff({GITHUB_ACTIONS: "true"}), "GITHUB_ACTIONS");
  assert.equal(automaticOff({NO_UPDATE_NOTIFIER: "1"}), "NO_UPDATE_NOTIFIER");
  assert.equal(automaticOff({C203_NO_UPDATE_CHECK: "1"}), "C203_NO_UPDATE_CHECK");
  assert.equal(automaticOff({C203_NO_UPDATE_CHECK: "0"}), null);
});

test("GitHub repositories from submodule URLs", () => {
  assert.equal(githubRepo("https://github.com/203-Systems/CardenzaHAL"), "203-Systems/CardenzaHAL");
  assert.equal(githubRepo("https://github.com/203-Systems/CardenzaHAL.git"), "203-Systems/CardenzaHAL");
  assert.equal(githubRepo("git@github.com:me/CardenzaHAL.git"), "me/CardenzaHAL");
  assert.equal(githubRepo("ssh://git@github.com/me/CardenzaHAL"), "me/CardenzaHAL");
  assert.equal(githubRepo("https://git.example.test/me/CardenzaHAL.git"), null);
  assert.equal(githubRepo("../CardenzaHAL"), null);
});

test("203c: a newer version on npm is a notice; npm is asked once a day, the answer kept for the day", async () => {
  const file = path.join(scratch("state-cli"), "updates.json");
  const f = fakeFetch(npm("9.0.0"));
  const first = await checkUpdates({fetch: f.fetch, file, now: NOW, env: {}, current: "3.5.0", hal: false});
  assert.deepEqual(first.notices, [`203c 9.0.0 is out (you have 3.5.0): ${UPDATE_CLI}`]);
  assert.equal(first.cli.checked, "now");
  assert.deepEqual(f.asked, ["https://registry.npmjs.org/203c/latest"]);
  assert.equal(fs.statSync(file).isFile(), true);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /token|cct_/);
  // Within the day: from the file, nothing asked, the notice still there.
  const again = await checkUpdates({fetch: f.fetch, file, now: NOW + DAY_MS - 1000, env: {}, current: "3.5.0", hal: false});
  assert.equal(again.cli.checked, "cached");
  assert.equal(again.notices.length, 1);
  assert.equal(f.asked.length, 1);
  // Updated since: no notice (the running version decides).
  assert.deepEqual((await checkUpdates({fetch: f.fetch, file, now: NOW + 5000, env: {}, current: "9.0.0", hal: false})).notices, []);
  // A day later: asked again. fresh (doctor, 203c updates): asked whatever the file says.
  await checkUpdates({fetch: f.fetch, file, now: NOW + DAY_MS + 1, env: {}, current: "3.5.0", hal: false});
  assert.equal(f.asked.length, 2);
  await checkUpdates({fetch: f.fetch, file, now: NOW + DAY_MS + 2, env: {}, current: "3.5.0", hal: false, fresh: true});
  assert.equal(f.asked.length, 3);
  // The same version, or an older one on npm: nothing to say.
  const same = await checkUpdates({fetch: fakeFetch(npm(CLI_VERSION)).fetch, file: path.join(dir, "state-same.json"), now: NOW, env: {}, hal: false});
  assert.deepEqual(same.notices, []);
  assert.equal(same.cli.outdated, false);
  // A mirror: C203_NPM_REGISTRY.
  const m = fakeFetch(npm("9.0.0"));
  await checkUpdates({fetch: m.fetch, file: path.join(dir, "state-mirror.json"), now: NOW, env: {C203_NPM_REGISTRY: "https://registry.npmmirror.com/"}, hal: false});
  assert.deepEqual(m.asked, ["https://registry.npmmirror.com/203c/latest"]);
});

test("failures are silent and kept for the day: offline, an error page, no version, a network that never answers", async () => {
  const file = path.join(scratch("state-fail"), "updates.json");
  const offline = fakeFetch(() => { throw new TypeError("fetch failed"); });
  const r = await checkUpdates({fetch: offline.fetch, file, now: NOW, env: {}, current: "3.5.0", hal: false});
  assert.deepEqual(r.notices, []);
  assert.equal(r.cli.checked, "failed");
  // Not asked again by the next commands of the day.
  await checkUpdates({fetch: offline.fetch, file, now: NOW + 60000, env: {}, current: "3.5.0", hal: false});
  assert.equal(offline.asked.length, 1);
  for (const answer of [() => ({status: 503, body: {}}), () => ({status: 200, body: {version: "latest"}}), () => ({status: 200, body: null})]) {
    const x = await checkUpdates({fetch: fakeFetch(answer).fetch, file: path.join(dir, `state-${Math.random()}.json`), now: NOW, env: {}, current: "3.5.0", hal: false});
    assert.deepEqual(x.notices, []);
  }
  // Never answers: given up after the timeout (the request is aborted), nothing said.
  const hang = fakeFetch((url, signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  const started = Date.now();
  const h = await checkUpdates({fetch: hang.fetch, file: path.join(dir, "state-hang.json"), now: NOW, env: {}, current: "3.5.0", hal: false, timeout: 150});
  assert.ok(Date.now() - started < 2000, "gave up in time");
  assert.deepEqual(h.notices, []);
  // A home that cannot be written: still an answer.
  const ro = await checkUpdates({fetch: fakeFetch(npm("9.0.0")).fetch, file: path.join(dir, "missing", "\0bad", "updates.json"), now: NOW, env: {}, current: "3.5.0", hal: false});
  assert.equal(ro.notices.length, 1);
});

test("startNotices: on stderr's writer when the command ends; nothing at all where the switches say so", async () => {
  const lines = [];
  const notices = startNotices({fetch: fakeFetch(npm("9.0.0")).fetch, file: path.join(dir, "state-start.json"), env: {}, current: "3.5.0", hal: false,
    write: text => lines.push(text)});
  assert.equal((await notices.show()).length, 1);
  assert.deepEqual(lines, [`203c: 203c 9.0.0 is out (you have 3.5.0): ${UPDATE_CLI}\n`]);
  for (const env of [{CI: "true"}, {GITHUB_ACTIONS: "true"}, {NO_UPDATE_NOTIFIER: "1"}, {C203_NO_UPDATE_CHECK: "1"}]) {
    const f = fakeFetch(npm("9.0.0"));
    const off = startNotices({fetch: f.fetch, file: path.join(dir, "state-off.json"), env, current: "3.5.0", hal: false, write: () => assert.fail("written")});
    assert.deepEqual(await off.show(), []);
    assert.equal(f.asked.length, 0, JSON.stringify(env));
  }
  // A network that never answers: show() returns about when the timeout ends, with nothing.
  const hang = fakeFetch((url, signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  const started = Date.now();
  const slow = startNotices({fetch: hang.fetch, file: path.join(dir, "state-slow.json"), env: {}, current: "3.5.0", hal: false, timeout: 200, write: () => assert.fail("written")});
  assert.deepEqual(await slow.show(), []);
  assert.ok(Date.now() - started < 1500);
});

// A firmware project as 203c new makes one: CardenzaHAL as the submodule components/CardenzaHAL (from a local "upstream"
// whose URL in .gitmodules is then GitHub's), optionally with a tools/check_submodule.py.
function project(name, {checkScript = null} = {}) {
  const upstream = scratch(name + "-hal");
  git(upstream, "init", "-q");
  fs.writeFileSync(path.join(upstream, "cardenzaHAL.h"), "#pragma once\n");
  if (checkScript) { fs.mkdirSync(path.join(upstream, "tools")); fs.writeFileSync(path.join(upstream, "tools", "check_submodule.py"), checkScript); }
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "hal");
  const fw = scratch(name);
  git(fw, "init", "-q");
  fs.writeFileSync(path.join(fw, "CMakeLists.txt"), "include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(fw)\n");
  fs.writeFileSync(path.join(fw, "203.json"), "{\"format\": 1}\n");
  git(fw, "submodule", "add", "-q", upstream, "components/CardenzaHAL");
  git(fw, "config", "-f", ".gitmodules", "submodule.components/CardenzaHAL.url", "https://github.com/203-Systems/CardenzaHAL.git");
  const commit = git(path.join(fw, "components", "CardenzaHAL"), "rev-parse", "HEAD");
  fs.mkdirSync(path.join(fw, "main"));
  return {fw, commit, hal: path.join(fw, "components", "CardenzaHAL")};
}
const github = compare => url => {
  if (url.endsWith("/203c/latest")) return {status: 200, body: {version: CLI_VERSION}};
  const m = /\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.main\?per_page=1&page=2$/.exec(url);
  return m ? compare(m[2], m[1]) : {status: 404, body: {message: "Not Found"}};
};

test("CardenzaHAL: the submodule found from the project or a folder in it; behind its main is a notice with the command", async () => {
  const p = project("fw-behind");
  const found = findHalSubmodule(path.join(p.fw, "main"));
  assert.equal(found.path, "components/CardenzaHAL");
  assert.equal(found.commit, p.commit);
  assert.equal(found.repo, "203-Systems/CardenzaHAL");
  const file = path.join(scratch("state-hal"), "updates.json");
  const f = fakeFetch(github(() => ({status: 200, body: {status: "ahead", ahead_by: 3, behind_by: 0}})));
  const r = await checkUpdates({from: p.fw, cwd: p.fw, fetch: f.fetch, file, now: NOW, env: {}});
  assert.equal(r.hal.behind, 3);
  assert.equal(r.hal.status, "ahead");
  assert.deepEqual(r.notices, ["CardenzaHAL in this project (components/CardenzaHAL) is 3 commits behind its main: git submodule update --remote components/CardenzaHAL, " +
    "build and test, then commit the new pointer (git add components/CardenzaHAL)"]);
  assert.ok(f.asked.includes(`https://api.github.com/repos/203-Systems/CardenzaHAL/compare/${p.commit}...main?per_page=1&page=2`), f.asked.join("\n"));
  // Within the day, the same commit: GitHub is not asked again (60 requests an hour without a token).
  const again = await checkUpdates({from: p.fw, cwd: p.fw, fetch: f.fetch, file, now: NOW + 3600000, env: {}});
  assert.equal(again.hal.checked, "cached");
  assert.equal(again.notices.length, 1);
  assert.equal(f.asked.filter(u => u.includes("/compare/")).length, 1);
  // Run from elsewhere: the path is the one to type from there.
  const sub = await checkUpdates({from: path.join(p.fw, "main"), cwd: path.join(p.fw, "main"), fetch: f.fetch, file, now: NOW, env: {}});
  assert.match(sub.notices[0], / git submodule update --remote \.\.\/components\/CardenzaHAL,/);
  // From outside the repository: git -C to it. For a build's folder (cwd null): from the repository's top.
  const outside = await checkUpdates({from: p.fw, cwd: dir, fetch: f.fetch, file, now: NOW, env: {}});
  assert.match(outside.notices[0], / git -C fw-behind submodule update --remote components\/CardenzaHAL, .*\(git -C fw-behind add components\/CardenzaHAL\)$/);
  const build = await checkUpdates({from: p.fw, cwd: null, fetch: f.fetch, file, now: NOW, env: {}});
  assert.match(build.notices[0], / git submodule update --remote components\/CardenzaHAL,/);
});

test("CardenzaHAL: at its main, a commit GitHub does not have, GitHub away: nothing; a commit off main: said", async () => {
  const p = project("fw-at");
  const ask = (compare, name) => checkUpdates({from: p.fw, cwd: p.fw, fetch: fakeFetch(github(compare)).fetch, file: path.join(dir, `state-${name}.json`), now: NOW, env: {}});
  assert.deepEqual((await ask(() => ({status: 200, body: {status: "identical", ahead_by: 0, behind_by: 0}}), "identical")).notices, []);
  assert.deepEqual((await ask(() => ({status: 404, body: {message: "Not Found"}}), "unknown")).notices, []);
  assert.deepEqual((await ask(() => ({status: 403, body: {message: "API rate limit exceeded"}}), "limited")).notices, []);
  assert.deepEqual((await ask(() => { throw new TypeError("fetch failed"); }, "offline")).notices, []);
  const off = await ask(() => ({status: 200, body: {status: "diverged", ahead_by: 2, behind_by: 1}}), "diverged");
  assert.equal(off.notices.length, 1);
  assert.match(off.notices[0], new RegExp(`^CardenzaHAL in this project \\(components/CardenzaHAL\\) is on ${p.commit.slice(0, 7)}, a commit its main does not have`));
  // No submodule, a folder outside any repository, a submodule not checked out: no HAL check at all.
  const plain = scratch("plain");
  git(plain, "init", "-q");
  assert.equal(findHalSubmodule(plain), null);
  assert.equal(findHalSubmodule(os.tmpdir() === "/" ? dir : path.parse(dir).root), null);
  fs.rmSync(p.hal, {recursive: true, force: true});
  fs.mkdirSync(p.hal);
  assert.equal(findHalSubmodule(p.fw), null);
});

test("CardenzaHAL: the HAL's own check_submodule.py says it is not a clean copy (its explanation, not the files it lists)", {skip: !hasPython && "no Python"}, async () => {
  // A stand-in for the HAL's script: fails as it does on local changes when dirty.txt is there.
  const script = [
    "import os, sys",
    "hal = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))",
    "if os.path.exists(os.path.join(hal, 'dirty.txt')):",
    "    sys.stderr.write('check_submodule: the HAL (%s) has local changes, but it is a clean copy. Change the HAL in\\n' % hal)",
    "    sys.stderr.write(\"its own clone, push it to CardenzaHAL's main, then move the submodule pointer. Restore this one:\\n\")",
    "    sys.stderr.write('  git -C %s checkout -- . && git -C %s clean -fd\\n?? dirty.txt\\n' % (hal, hal))",
    "    sys.exit(1)",
    "if os.path.exists(os.path.join(hal, 'stale.txt')):",
    "    sys.stderr.write('check_submodule: the HAL (%s) is on abc1234 x, which is not on upstream main.\\nPush the change first.\\n' % hal)",
    "    sys.exit(1)",
    ""].join("\n");
  const p = project("fw-dirty", {checkScript: script});
  const ask = name => checkUpdates({from: p.fw, cwd: p.fw, fetch: fakeFetch(github(() => ({status: 200, body: {status: "identical", ahead_by: 0}}))).fetch,
    file: path.join(dir, `state-${name}.json`), now: NOW, env: process.env});
  assert.deepEqual((await ask("clean")).notices, []);
  fs.writeFileSync(path.join(p.hal, "dirty.txt"), "x");
  const dirty = await ask("dirty");
  assert.equal(dirty.notices.length, 1);
  assert.match(dirty.notices[0], /^CardenzaHAL in this project \(components\/CardenzaHAL\) is not a clean copy of upstream main: the HAL \(.+\) has local changes, but it is a clean copy\. .* Restore this one: git -C .+ checkout -- \. && git -C .+ clean -fd$/);
  assert.doesNotMatch(dirty.notices[0], /\?\? dirty\.txt/);
  assert.equal(dirty.hal.local !== null, true);
  // "not on upstream main" from a submodule whose origin/main is behind, while GitHub says the commit is on main: not said.
  fs.rmSync(path.join(p.hal, "dirty.txt"));
  fs.writeFileSync(path.join(p.hal, "stale.txt"), "x");
  assert.deepEqual((await ask("stale")).notices, []);
});

// ---------------------------------------------------------------------------------------------
// 203c itself, against stand-in npm and GitHub servers

let server, base, requests = [], latest = "99.0.0", hang = false;
before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    if (hang) return;   // never answers
    if (req.url === "/api/") { res.writeHead(200, {"content-type": "application/json"}); return res.end(JSON.stringify({version: 2, limits: {}})); }
    if (req.url === "/npm/203c/latest") { res.writeHead(200, {"content-type": "application/json"}); return res.end(JSON.stringify({name: "203c", version: latest})); }
    if (/^\/gh\/repos\/203-Systems\/CardenzaHAL\/compare\//.test(req.url)) { res.writeHead(200, {"content-type": "application/json"}); return res.end(JSON.stringify({status: "ahead", ahead_by: 7})); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const cli = (args, {env = {}, cwd = dir} = {}) => run(args, {cwd, env: {XDG_CONFIG_HOME: fs.mkdtempSync(path.join(dir, "home-")), CI: "", GITHUB_ACTIONS: "",
  C203_NO_UPDATE_CHECK: "", NO_UPDATE_NOTIFIER: "", C203_NPM_REGISTRY: base + "/npm", C203_GITHUB_API: base + "/gh", ...env}});
const NOTICE = `203c: 203c 99.0.0 is out (you have ${CLI_VERSION}): ${UPDATE_CLI}`;

test("203c: a command of the work ends with the notices on stderr; stdout and the exit code are the command's", async () => {
  const p = project("fw-cli");
  const r = await cli(["rules"], {cwd: p.fw});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /CardenzaHAL/);
  assert.doesNotMatch(r.stdout, /99\.0\.0 is out|7 commits behind/, "the notices are not in stdout");
  assert.ok(r.stderr.includes(NOTICE + "\n"), r.stderr);
  assert.match(r.stderr, /203c: CardenzaHAL in this project \(components\/CardenzaHAL\) is 7 commits behind its main: git submodule update --remote components\/CardenzaHAL/);
  // --json: stdout is the answer alone.
  const j = await cli(["rules", "--json"], {cwd: p.fw});
  assert.equal(j.code, 0);
  assert.ok(j.json, "stdout is JSON");
  assert.ok(j.stderr.includes(NOTICE));
  // An error: the notice first, the error's JSON line last, the exit code the error's.
  const e = await cli(["source", "check", "--json"], {cwd: p.fw});
  assert.equal(e.code, 4);
  assert.equal(e.error?.code, "signin_required", e.stderr);
  assert.ok(e.stderr.indexOf(NOTICE) >= 0 && e.stderr.indexOf(NOTICE) < e.stderr.lastIndexOf("{\"error\""), e.stderr);
});

test("203c: nothing in CI, with the opt-outs, on --version and help, or on commands outside the work", async () => {
  for (const env of [{CI: "true"}, {GITHUB_ACTIONS: "true"}, {NO_UPDATE_NOTIFIER: "1"}, {C203_NO_UPDATE_CHECK: "1"}]) {
    const before = requests.length;
    const r = await cli(["rules"], {env});
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /is out/, JSON.stringify(env));
    assert.equal(requests.length, before, `nothing asked with ${JSON.stringify(env)}`);
  }
  const before = requests.length;
  for (const args of [["--version"], ["help"], ["help", "start"], ["rules", "--help"], ["ops"]]) {
    const r = await cli(args);
    assert.doesNotMatch(r.stderr, /is out/, args.join(" "));
  }
  assert.equal(requests.length, before);
});

test("203c: a network that never answers costs the command at most the timeout and says nothing", async () => {
  hang = true;
  try {
    const started = Date.now();
    const r = await cli(["rules"]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /is out/);
    assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  } finally { hang = false; }
});

test("203c updates: both answers (--json), --quiet: only the notices or nothing, exit 0", async () => {
  const p = project("fw-updates");
  const r = await cli(["updates", "--json"], {cwd: p.fw});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.cli.latest, "99.0.0");
  assert.equal(r.json.cli.outdated, true);
  assert.equal(r.json.hal.behind, 7);
  assert.equal(r.json.notices.length, 2);
  assert.doesNotMatch(r.stderr, /is out/, "no second copy on stderr");
  const text = await cli(["updates", "--project", p.fw]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^! 203c 99\.0\.0 is out/m);
  assert.match(text.stdout, /^! CardenzaHAL in this project .* 7 commits behind its main/m);
  const quiet = await cli(["updates", "--quiet", "--project", p.fw]);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stdout.trim().split("\n").length, 2);
  assert.match(quiet.stdout, /^203c 99\.0\.0 is out/);
  // --project (CardenzaHAL's build, run in its build folder): the commands from the project's top.
  assert.match(quiet.stdout, / git submodule update --remote components\/CardenzaHAL,/);
  // All current: --quiet prints nothing; plain says so.
  latest = CLI_VERSION;
  try {
    const none = await cli(["updates", "--quiet"]);
    assert.equal(none.code, 0);
    assert.equal(none.stdout, "");
    const plain = await cli(["updates"]);
    assert.match(plain.stdout, new RegExp(`✓ 203c ${CLI_VERSION.replace(/\./g, "\\.")} is the newest`));
    assert.match(plain.stdout, /no CardenzaHAL submodule/);
  } finally { latest = "99.0.0"; }
  // --quiet where nothing is asked by itself (the HAL's build in CI): nothing, nothing asked.
  const before = requests.length;
  const ci = await cli(["updates", "--quiet"], {env: {CI: "true"}});
  assert.equal(ci.code, 0);
  assert.equal(ci.stdout, "");
  assert.equal(requests.length, before);
  // Offline: exit 0, nothing to do.
  const away = await cli(["updates", "--quiet"], {env: {C203_NPM_REGISTRY: "http://127.0.0.1:9"}});
  assert.equal(away.code, 0);
  assert.equal(away.stdout, "");
});

test("doctor: asks now, in CI too, and lists both (cli, hal, the warnings with their commands); not with the user's own switch", async () => {
  const p = project("fw-doctor");
  const doctor = env => cli(["--api", base + "/api", "doctor", "--json"], {cwd: p.fw, env});
  const before = requests.length;
  const d = await doctor({CI: "true"});
  assert.ok(d.json, d.stdout + d.stderr);
  assert.ok(requests.length > before, "asked in CI: doctor is asked for");
  assert.equal(d.json.updates.cli.latest, "99.0.0");
  assert.equal(d.json.updates.hal.behind, 7);
  const byName = Object.fromEntries(d.json.checks.map(c => [c.name, c]));
  assert.equal(byName.cli.ok, false);
  assert.match(byName.cli.detail, /99\.0\.0 is out/);
  assert.equal(byName.hal.ok, false);
  assert.match(byName.hal.detail, /^components\/CardenzaHAL [0-9a-f]{7}: 7 commits behind its main$/);
  const warned = Object.fromEntries(d.json.warnings.map(w => [w.code, w]));
  assert.deepEqual(warned.cli_outdated.next, ["npm install -g 203c", "203c skill install"]);
  assert.deepEqual(warned.hal_behind.next, ["git submodule update --remote components/CardenzaHAL", "git add components/CardenzaHAL"]);
  assert.doesNotMatch(d.stderr, /is out/, "not said a second time");
  // Text: the lines and the commands.
  const t = await cli(["--api", base + "/api", "doctor"], {cwd: p.fw});
  assert.match(t.stdout, /^- cli +203c \S+ \(99\.0\.0 is out\)$/m);
  assert.match(t.stdout, /^! CardenzaHAL in this project \(components\/CardenzaHAL\) is 7 commits behind its main\n {4}Update it, build and test, then commit the new pointer\n {4}→ git submodule update --remote components\/CardenzaHAL$/m);
  // The user's own switch: not asked, said so.
  const quiet = requests.length;
  const off = await doctor({C203_NO_UPDATE_CHECK: "1"});
  assert.deepEqual(off.json.updates, {off: "C203_NO_UPDATE_CHECK"});
  assert.equal(off.json.checks.find(c => c.name === "updates").detail, "not checked: C203_NO_UPDATE_CHECK is set");
  assert.equal(requests.filter(u => !u.startsWith("/api")).length, requests.slice(0, quiet).filter(u => !u.startsWith("/api")).length, "npm and GitHub not asked");
});
