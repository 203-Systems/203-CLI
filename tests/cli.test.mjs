// The command line itself, with no community behind it: help as text and as JSON, reference/cli.md current, the
// rules, usage errors that name the right command or flag, the sign-in rules, and doctor / whoami / init against a
// stand-in API (GET /, GET /me, GET /me/quotas). The community runs 203c against its whole API in its own tests.
// Run: node --test tests/cli.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ROOT, CLI, run, standInApi} from "./fixtures.mjs";
import {CLI_VERSION} from "../scripts/lib.mjs";
import {ERROR_CODES} from "../scripts/guide.mjs";

const TOKEN = "cct_" + "a".repeat(64);
let stand, home, work;

before(async () => {
  stand = await standInApi((req, send) => {
    if (req.url === "/api/") return send(200, {version: 2, limits: {}});
    if (req.url === "/api/me") {
      return req.headers.authorization === "Bearer " + TOKEN
        ? send(200, {id: "u1", name: "Tester", role: "user", scopes: ["read", "write"], credential: {kind: "cli", name: "203c on test"}})
        : send(401, {error: "Sign in first", code: "signin_required"});
    }
    if (req.url === "/api/me/quotas") return send(200, {items: [{what: "versions_dev", used: 1, limit: 300, left: 299, per: "day"}]});
    return false;
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "203c-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "203c-work-"));
});
after(async () => { await stand.close(); fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(work, {recursive: true, force: true}); });

const cli = (args, {token = "", env = {}, cwd = work} = {}) =>
  run(["--api", stand.api, ...args], {cwd, env: {XDG_CONFIG_HOME: home, COMMUNITY_TOKEN: token, CI: "1", ...env}});
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result.json; };
// An error as --json prints it: one line, the documented shape, the exit code it says.
function refused(result, exit, code) {
  assert.equal(result.code, exit, result.stderr || result.stdout);
  const error = result.error ?? result.json;
  assert.ok(error, "a JSON error on stderr: " + result.stderr);
  if (code) assert.equal(error.code, code, JSON.stringify(error));
  assert.equal(error.exit, exit);
  assert.equal(typeof error.error, "string");
  assert.ok(Array.isArray(error.next));
  return error;
}

test("the version is the package's", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(CLI_VERSION, pkg.version, "scripts/lib.mjs CLI_VERSION and package.json version");
  assert.equal((await run(["--version"])).stdout.trim(), CLI_VERSION);
});

test("help: topics, every command's --help with examples, JSON help, and reference/cli.md is current", async () => {
  for (const topic of ["start", "publish", "ci", "manifest", "fork", "checks", "page", "sounds", "devices", "rules"]) {
    const help = await cli(["help", topic]);
    assert.equal(help.code, 0, topic);
    assert.match(help.stdout, /node \S+203c\.mjs /, topic);
  }
  assert.match((await cli(["help", "errors"])).stdout, /section_closed +exit 1/);
  const commandHelp = await cli(["publish", "--help"]);
  assert.match(commandHelp.stdout, /--dry-run/);
  assert.match(commandHelp.stdout, /Examples\n  node /);
  const all = ok(await cli(["--help", "--json"]));
  assert.equal(all.cli, CLI_VERSION);
  assert.equal(all.api.default, "https://cardenza.203.io/community/api");
  const publish = ok(await cli(["publish", "--help", "--json"]));
  assert.equal(publish.command, "publish");
  assert.ok(publish.flags.some(flag => flag.name === "--dry-run"));
  const reference = spawnSync(process.execPath, [CLI, "help", "--reference"], {encoding: "utf8"}).stdout;
  assert.equal(fs.readFileSync(path.join(ROOT, "reference/cli.md"), "utf8"), reference,
    "reference/cli.md is stale: node scripts/203c.mjs help --reference > reference/cli.md");
  for (const [code] of ERROR_CODES) assert.ok(reference.includes("`" + code + "`"), code);
});

test("rules prints the firmware project rules (reference/firmware-project.md), signed out", async () => {
  const rules = await cli(["rules"]);
  assert.equal(rules.code, 0, rules.stderr);
  assert.equal(rules.stdout.trim(), fs.readFileSync(path.join(ROOT, "reference/firmware-project.md"), "utf8").trim());
});

test("unknown commands and flags suggest the right one; values are checked with the valid ones listed", async () => {
  const flag = refused(await cli(["versions", "publish", "K7M2QX", "--chanel", "dev", "--json"], {token: TOKEN}), 2, "usage");
  assert.match(flag.hint, /Did you mean --channel\?/);
  assert.match(flag.next[0], /--channel dev/);
  const command = refused(await cli(["relase", "--bin", "x.bin", "--json"]), 2, "usage");
  assert.match(command.next[0], /203c\.mjs publish --api \S+ --bin x\.bin --json$/);
  assert.match(refused(await cli(["firmware", "creat", "--json"]), 2).next[0], /firmware create --api \S+ --json$/);
  const channel = refused(await cli(["versions", "list", "K7M2QX", "--channel", "nightly", "--json"], {token: TOKEN}), 2, "usage");
  assert.equal(channel.field, "channel");
  assert.match(channel.next[0], /--channel dev/);
  const code = refused(await cli(["versions", "publish", "CardenzaSynth", "--json"], {token: TOKEN}), 2, "usage");
  assert.match(code.hint, /looks like a name/);
  assert.match(code.next[0], /firmware mine --json$/);
  assert.match(refused(await cli(["versions", "download", "K7M2QX", "--json"]), 2).error, /Missing --target/);
  assert.match(refused(await cli(["firmware", "list", "--limit", "many", "--json"]), 2).error, /whole number/);
  assert.match(refused(await cli(["versions", "edit", "K7M2QX", "--notes", "two", "words", "--json"]), 2).hint, /quotes/);
  assert.match(refused(await cli(["models", "upload", "a.stl", "--title", "x", "--license", "cc-by", "--json"]), 2).next[0], /--license CC-BY-4\.0/);
});

test("help is JSON with --json: every command, one command's flags and examples, a topic, a group", async () => {
  const all = ok(await cli(["--help", "--json"]));
  assert.equal(all.cli, ok(await cli(["--version", "--json"])).cli);
  assert.ok(all.commands.length > 100 && all.commands.every(c => c.command && c.usage && c.summary && c.help.endsWith("--help --json")));
  assert.ok(all.exit_codes.some(e => e.exit === 6) && all.error_codes.some(e => e.code === "admin_scope_required"));
  assert.match(all.output, /last line/);
  const publish = ok(await cli(["publish", "--help", "--json"]));
  assert.equal(publish.signin, "write");
  assert.ok(publish.flags.some(f => f.name === "--channel" && f.choices.includes("dev")));
  assert.ok(publish.flags.some(f => f.name === "--bin" && f.repeat));
  assert.ok(publish.examples.every(e => / publish /.test(e)));
  assert.deepEqual(ok(await cli(["help", "firmware", "show", "--json"])).arguments, [{name: "CODE", type: "code"}]);
  assert.equal(ok(await cli(["help", "ci", "--json"])).topic, "ci");
  assert.ok(ok(await cli(["admin", "--help", "--json"])).commands.some(c => c.command === "admin official"));
  assert.match((await cli(["publish", "--help"])).stdout, /^Options$/m);
});

test("a guessed flag never puts a decision (--force, --yes) into next", async () => {
  const forced = await cli(["publish", "--forse", "--dry-run", "--json"]);
  assert.equal(forced.code, 2);
  assert.match(forced.error.hint, /Did you mean --force\?.*a decision/);
  assert.ok(!forced.error.next.some(n => /--force/.test(n)), forced.error.next.join(" "));
  assert.match(forced.error.next[0], /publish --help --json$/);
  const typo = await cli(["publish", "--chanel", "beta", "--json"]);
  assert.match(typo.error.next[0], /publish --channel beta --json$/);
});

test("signed out, or with a token that does not work: exit 4 with the way to sign in", async () => {
  const signin = refused(await cli(["publish", "--firmware", "K7M2QX", "--bin", "x.bin", "--json"]), 4, "signin_required");
  assert.match(signin.next[0], /login --api \S+ --json$/);
  const env = refused(await cli(["whoami", "--json"], {token: "cct_" + "1".repeat(64)}), 4, "signin_required");
  assert.match(env.hint, /COMMUNITY_TOKEN/);
});

test("doctor: the API, who you are, today's limits; the token is never printed", async () => {
  const out = ok(await cli(["doctor", "--json"], {token: TOKEN}));
  assert.equal(out.signed_in, true);
  assert.equal(out.api_version, 2);
  assert.equal(out.me.name, "Tester");
  assert.equal(out.quotas.dev_versions.left, 299);
  assert.ok(!JSON.stringify(out).includes(TOKEN), "the token itself");
  // Signed out: a problem (exit 4) whose next command signs in.
  const signedOut = await cli(["doctor", "--json"]);
  assert.equal(signedOut.code, 4, signedOut.stdout);
  assert.equal(signedOut.json.signed_in, false);
  assert.ok(signedOut.json.checks.some(c => c.name === "token" && !c.ok));
  assert.match(signedOut.json.next[0], /login/);
  // No API: exit 3, unreachable, and doctor still answers.
  const away = await run(["--api", "http://127.0.0.1:9/api", "doctor", "--json"], {env: {XDG_CONFIG_HOME: home}});
  assert.equal(away.code, 3);
  assert.deepEqual(away.json.problems.map(p => p.code), ["unreachable"]);
  const whoami = ok(await cli(["whoami", "--json"], {token: TOKEN}));
  assert.equal(whoami.name, "Tester");
});

test("init writes 203.json from the project: CMake's project(), version.txt, LICENSE, the signed-in author", async () => {
  const dir = fs.mkdtempSync(path.join(work, "proj-"));
  spawnSync("git", ["init", "-q"], {cwd: dir});
  fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(my_synth)\n");
  fs.writeFileSync(path.join(dir, "version.txt"), "0.3.0\n");
  fs.writeFileSync(path.join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Someone\n");
  const out = ok(await cli(["init", "--json"], {token: TOKEN, cwd: dir}));
  const project = JSON.parse(fs.readFileSync(path.join(dir, "203.json"), "utf8"));
  assert.deepEqual([project.name, project.code, project.author, project.license, project.devices], ["my_synth", null, "Tester", "MIT", ["cardenza"]]);
  assert.equal(project.version, undefined, "the version stays in version.txt");
  assert.ok(out.todo.some(line => line.includes("summary")));
  assert.match(out.next[0], /publish --dry-run/);
});
