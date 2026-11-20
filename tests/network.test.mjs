// A network between 203cli and the community that blocks it (the user, 2026-11-20: an agent in Claude Code's cloud got
// "HTTP 403"): an agent sandbox's allowlist (403 with x-deny-reason: host_not_allowed, a 403 from the community's host
// that is not its JSON, and in a sandbox that says it is one a name that does not resolve or a proxy's certificate),
// the CDN's block page (Cloudflare), and the API's own refusals, which stay what they are. Fake fetch answers only.
// Run: node --test tests/network.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import {ApiError, Client, agentSandbox, blockedAnswer, probeHost, uploadCover} from "../scripts/lib.mjs";
import {explainApiError, topicText} from "../scripts/guide.mjs";
import {doctor} from "../scripts/publish.mjs";
import {run} from "./fixtures.mjs";

const API = "https://cardenza.203.io/community/api";
// (Update checks off: doctor would ask npm and GitHub with the test process's own home.)
const NO_SANDBOX = {C203_NO_UPDATE_CHECK: "1"};
const CLAUDE = {CLAUDE_CODE_REMOTE: "true", C203_NO_UPDATE_CHECK: "1"};

// What Claude Code's cloud proxy answers for a host its allowlist lacks.
const denied = () => new Response("Host not in allowlist", {status: 403, headers: {"x-deny-reason": "host_not_allowed", "content-type": "text/plain"}});
// Cloudflare's block in front of the site, as it answers some user agents: the short one and the "Access denied" page.
const cfShort = () => new Response("Your request was blocked.\n", {status: 403, headers: {"content-type": "text/plain", "cf-ray": "a5d75026da776fe0-IAD", server: "Vercel"}});
const cfPage = () => new Response('<!doctype html><html><head><title>Access denied | site.example.test used Cloudflare to restrict access</title></head>' +
  '<body><div id="cf-error-details"><h1>Error 1010</h1><span>Ray ID: a5d74ffe3cd75c60</span></div></body></html>',
  {status: 403, headers: {"content-type": "text/html; charset=UTF-8", "cf-ray": "a5d74ffe3cd75c60-MIA"}});
// The API's own refusal (through the same CDN: it has a cf-ray too).
const forbidden = () => new Response(JSON.stringify({error: "Not yours", code: "forbidden"}), {status: 403, headers: {"content-type": "application/json", "cf-ray": "x"}});
// A fetch that fails the way undici does: TypeError("fetch failed") with the system's code on its cause.
const failing = code => async () => { throw Object.assign(new TypeError("fetch failed"), {cause: Object.assign(new Error(code), {code})}); };
const client = (fetcher, {env = NO_SANDBOX, lang = "en"} = {}) => new Client({api: API, token: null, fetch: fetcher, env, lang});
const ctx = (c, words = ["whoami"]) => ({client: c, api: c.api, words, run: w => ["203cli", ...w, "--json"].join(" "), cmd: () => ["203cli", ...words, "--json"].join(" ")});

test("agentSandbox: only what the sandboxes document", () => {
  assert.equal(agentSandbox({CLAUDE_CODE_REMOTE: "true"}), "claude_code");
  assert.equal(agentSandbox({CODEX_SANDBOX_NETWORK_DISABLED: "1"}), "codex");
  assert.equal(agentSandbox({CLAUDE_CODE_REMOTE: "false"}), null);
  assert.equal(agentSandbox({}), null);
});

test("a 403 with x-deny-reason: host_not_allowed is the sandbox's allowlist, with the steps to allow both hosts", async () => {
  const error = await client(async () => denied()).get("/me").catch(e => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "network_blocked_sandbox");
  assert.equal(error.status, 0, "the API was not reached");
  assert.deepEqual([error.data.host, error.data.reason, error.data.http_status], ["cardenza.203.io", "host_not_allowed", 403]);
  assert.deepEqual(error.data.allow, ["cardenza.203.io", "apps.203.io"]);
  assert.match(error.message, /network allowlist blocked cardenza\.203\.io \(HTTP 403, x-deny-reason: host_not_allowed\)/);
  for (const words of [/cardenza\.203\.io and apps\.203\.io/, /claude\.ai\/code/, /Network access: Limited/, /Allow package managers/, /Allowed domains/,
    /Save changes/, /Full/, /Owner/, /admin settings › Cloud environments/, /Codex cloud/, /a file in the repository cannot/, /203cli rules/,
    /203cli skill install/, /flash --bin/]) assert.match(error.hint, words);
  // 203cli's answer: exit 1 (a change the user makes, not "later"), the same command first, then doctor.
  const out = explainApiError(error, ctx(client(async () => denied())));
  assert.deepEqual([out.code, out.exit], ["network_blocked_sandbox", 1]);
  assert.deepEqual(out.next, ["203cli whoami --json", "203cli doctor --json"]);
  assert.equal(out.hint, error.hint);
  // Any host: an upload's storage host is named with the two.
  const upload = await client(async () => denied()).fetch("https://storage.example.test/up").catch(e => e);
  assert.equal(upload.code, "network_blocked_sandbox");
  assert.deepEqual(upload.data.allow, ["cardenza.203.io", "apps.203.io", "storage.example.test"]);
  assert.match(upload.hint, /cardenza\.203\.io, apps\.203\.io and storage\.example\.test/);
});

test("in Chinese with --lang zh / COMMUNITY_LANG=zh", async () => {
  const error = await client(async () => denied(), {lang: "zh"}).get("/me").catch(e => e);
  assert.match(error.message, /这个环境的网络白名单拦下了 cardenza\.203\.io（HTTP 403，x-deny-reason: host_not_allowed）：在这里 203cli 连不上 203 社区/);
  for (const words of [/只有用户自己能放行 cardenza\.203\.io、apps\.203\.io/, /Allowed domains/, /Owner/, /Codex 云端/, /不用联网的照样能做/]) assert.match(error.hint, words);
  const cdn = await client(async () => cfShort(), {lang: "zh"}).get("/").catch(e => e);
  assert.match(cdn.message, /网站的防火墙（cardenza\.203\.io 前面的 Cloudflare）拦下了这个请求（HTTP 403，Ray ID a5d75026da776fe0-IAD）/);
});

test("Cloudflare's block page is the CDN, not the sandbox; the API's own 403 stays the API's", async () => {
  for (const answer of [cfShort, cfPage]) {
    const error = await client(async () => answer()).get("/").catch(e => e);
    assert.equal(error.code, "network_blocked_cdn", answer.name);
    assert.match(error.data.ray, /^a5d7/);
    assert.match(error.message, /The site's firewall \(Cloudflare, in front of cardenza\.203\.io\) blocked this request \(HTTP 403, Ray ID a5d7/);
    assert.match(error.hint, /only the site's owner/);
    assert.match(error.hint, /203cli\/\d+\.\d+\.\d+/);
    assert.match(error.hint, /github\.com\/203-Systems\/203-CLI\/issues/);
    const out = explainApiError(error, ctx(client(async () => answer())));
    assert.deepEqual([out.code, out.exit], ["network_blocked_cdn", 1]);
  }
  const refused = await client(async () => forbidden()).get("/firmware/K7M2QX").catch(e => e);
  assert.deepEqual([refused.code, refused.status, refused.message], ["forbidden", 403, "Not yours"]);
  assert.equal(blockedAnswer({status: 403, headers: new Headers({"content-type": "application/json"}), body: "{\"code\":\"forbidden\"}", ours: true}), null);
  assert.equal(blockedAnswer({status: 404, headers: new Headers(), body: "", ours: true}), null);
});

test("a 403 from the community's host that is not its JSON: a network allowlist on the way; another host's stays the caller's", async () => {
  const plain = () => new Response("Forbidden by policy", {status: 403, headers: {"content-type": "text/plain"}});
  const error = await client(async () => plain()).get("/").catch(e => e);
  assert.equal(error.code, "network_blocked_sandbox");
  assert.equal(error.data.reason, "http_403");
  assert.match(error.message, /^A network allowlist on the way \(an agent's sandbox, a proxy or a firewall\) blocked cardenza\.203\.io/);
  const sure = await client(async () => plain(), {env: CLAUDE}).get("/").catch(e => e);
  assert.match(sure.message, /^This environment's network allowlist blocked/);
  assert.equal(sure.data.sandbox, "claude_code");
  // A storage host's own 403 (an expired signed URL) is the upload's to report, even in a sandbox.
  const storage = await client(async () => new Response("<Error>AccessDenied</Error>", {status: 403}), {env: CLAUDE}).fetch("https://storage.example.test/x");
  assert.equal(storage.status, 403);
  assert.equal(await storage.text(), "<Error>AccessDenied</Error>", "the body is still there for the caller");
});

test("ENOTFOUND for the community in a sandbox that says it is one: its allowlist; elsewhere unreachable, with the possibility", async () => {
  const blocked = await client(failing("ENOTFOUND"), {env: CLAUDE}).get("/").catch(e => e);
  assert.deepEqual([blocked.code, blocked.data.reason, blocked.data.cause, blocked.data.sandbox], ["network_blocked_sandbox", "dns", "ENOTFOUND", "claude_code"]);
  assert.match(blocked.message, /This environment's network allowlist blocked cardenza\.203\.io \(its name does not resolve here: ENOTFOUND\)/);
  const again = await client(failing("EAI_AGAIN"), {env: CLAUDE}).get("/").catch(e => e);
  assert.equal(again.code, "network_blocked_sandbox");
  // No sandbox known: the API cannot be reached (exit 3), and the hint says a sandbox could be why.
  const plain = await client(failing("ENOTFOUND")).get("/").catch(e => e);
  assert.deepEqual([plain.code, plain.message], ["unreachable", "Cannot reach https://cardenza.203.io/community/api (ENOTFOUND)"]);
  const out = explainApiError(plain, ctx(client(failing("ENOTFOUND"))));
  assert.deepEqual([out.code, out.exit], ["unreachable", 3]);
  assert.match(out.hint, /In a sandboxed agent \(Claude Code on the web, Codex cloud…\).*allow cardenza\.203\.io and apps\.203\.io \(203cli help sandbox/);
  // Not every failure is the sandbox: refused elsewhere is unreachable, with no such hint.
  const refused = explainApiError(await client(failing("ECONNREFUSED"), {env: CLAUDE}).get("/").catch(e => e), ctx(client(failing("ECONNREFUSED"))));
  assert.equal(refused.code, "unreachable");
  assert.doesNotMatch(refused.hint, /sandbox/);
  // Another host in a sandbox: what it is (the guard only speaks for the community's hosts).
  const other = await client(failing("ENOTFOUND"), {env: CLAUDE}).fetch("https://storage.example.test/x").catch(e => e);
  assert.ok(!(other instanceof ApiError));
});

test("a proxy's certificate in a sandbox, and Codex's sandbox without network (its steps first)", async () => {
  const cert = await client(failing("SELF_SIGNED_CERT_IN_CHAIN"), {env: CLAUDE}).get("/").catch(e => e);
  assert.deepEqual([cert.code, cert.data.reason], ["network_blocked_sandbox", "certificate"]);
  assert.match(cert.message, /a proxy answered for it, not with the site's certificate: SELF_SIGNED_CERT_IN_CHAIN/);
  const codex = await client(failing("ECONNREFUSED"), {env: {CODEX_SANDBOX_NETWORK_DISABLED: "1"}}).get("/").catch(e => e);
  assert.deepEqual([codex.code, codex.data.reason, codex.data.sandbox], ["network_blocked_sandbox", "no_network", "codex"]);
  assert.match(codex.message, /Codex runs this command without network access: ECONNREFUSED/);
  assert.ok(codex.hint.indexOf("Codex cloud") < codex.hint.indexOf("Claude Code on the web"), "Codex's steps first");
  assert.match(codex.hint, /network_access = true/);
});

test("uploads: a blocked upload says so (not \"upload refused\"), in every path's catch", async () => {
  // The cover: the API answers, the signed upload URL is blocked by the sandbox.
  const answers = async (url, init) => {
    if (String(url).startsWith(API)) return new Response(JSON.stringify({upload: {url: "https://cardenza.203.io/community/upload/x", method: "PUT", headers: {}}}), {status: 201});
    return denied();
  };
  const error = await uploadCover(client(answers), "K7M2QX", new Uint8Array([1, 2, 3]), "image/png").catch(e => e);
  assert.equal(error.code, "network_blocked_sandbox");
  // The same upload failing for no known reason stays what it was.
  const lost = async (url) => String(url).startsWith(API) ? answers(url) : failing("ECONNRESET")();
  const reset = await uploadCover(client(lost), "K7M2QX", new Uint8Array([1]), "image/png").catch(e => e);
  assert.deepEqual([reset.code, reset.message], ["unreachable", "The upload failed: ECONNRESET"]);
});

test("probeHost and doctor: both hosts checked, the sandbox reported with the same hint", async () => {
  const root = () => new Response(JSON.stringify({version: 2, name: "203 community"}), {status: 200, headers: {"content-type": "application/json"}});
  const ok = await probeHost(client(async () => root()), "apps.203.io");
  assert.deepEqual([ok.ok, ok.url], [true, "https://apps.203.io/community/api/"]);
  const no = await probeHost(client(async () => denied()), "apps.203.io");
  assert.deepEqual([no.ok, no.error.code], [false, "network_blocked_sandbox"]);

  const doctorCtx = c => ({client: c, api: c.api, notes: [], flags: {}, tokenSource: null, tokenFile: os.devNull, pendingLogin: null,
    run: (w, {json = true} = {}) => ["203cli", ...w, ...(json ? ["--json"] : [])].join(" "), cmd: () => "203cli doctor --json"});
  // Everything blocked, in a Claude Code cloud session.
  const blocked = await doctor(doctorCtx(client(async () => denied(), {env: CLAUDE})));
  assert.equal(blocked.exit, 1);
  assert.equal(blocked.json.sandbox, "claude_code");
  assert.equal(blocked.json.problems[0].code, "network_blocked_sandbox");
  assert.match(blocked.json.problems[0].hint, /Allowed domains/);
  assert.deepEqual(blocked.json.next, ["203cli doctor --json"]);
  const hosts = blocked.json.checks.filter(c => c.name === "host");
  assert.deepEqual(hosts.map(c => [c.host, c.ok, c.code]), [["cardenza.203.io", false, "network_blocked_sandbox"], ["apps.203.io", false, "network_blocked_sandbox"]]);
  assert.ok(blocked.json.checks.some(c => c.name === "sandbox" && /CLAUDE_CODE_REMOTE/.test(c.detail)));
  assert.match(blocked.text, /✗ host +cardenza\.203\.io: blocked \(network_blocked_sandbox, host_not_allowed\)/);
  assert.match(blocked.text, /\n {4}- Claude Code on the web/, "the hint's lines indented");
  // The API's host allowed, its twin not: a warning with the steps (203cli works through the API's host).
  const twin = await doctor(doctorCtx(client(async url => new URL(url).hostname === "apps.203.io" ? denied() : root())));
  assert.ok(!twin.json.problems.some(p => p.code === "network_blocked_sandbox"));
  const warning = twin.json.warnings.find(w => w.code === "network_blocked_sandbox");
  assert.equal(warning.host, "apps.203.io");
  assert.match(warning.hint, /apps\.203\.io/);
  assert.deepEqual(twin.json.checks.filter(c => c.name === "host").map(c => c.ok), [true, false]);
  // ENOTFOUND with no sandbox known: unreachable, and the possibility in the hint.
  const dns = await doctor(doctorCtx(client(failing("ENOTFOUND"))));
  assert.equal(dns.json.problems[0].code, "unreachable");
  assert.match(dns.json.problems[0].hint, /sandboxed agent/);
});

test("the CLI: exit 1, the code, the multi-line hint; help sandbox", async () => {
  // A stand-in for a sandbox's proxy on 127.0.0.1 (the API's host here).
  const server = http.createServer((req, res) => { res.writeHead(403, {"x-deny-reason": "host_not_allowed", "content-type": "text/plain"}); res.end("blocked"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const env = {COMMUNITY_TOKEN: "cct_" + "ab".repeat(32)};
    const json = await run(["--api", api, "whoami", "--json"], {env});
    assert.equal(json.code, 1, json.stderr);
    assert.equal(json.error.code, "network_blocked_sandbox");
    assert.equal(json.error.host, "127.0.0.1");
    assert.match(json.error.next[0], /203cli\.mjs whoami --api \S+ --json$/);
    assert.match(json.error.next[1], /203cli\.mjs doctor --api \S+ --json$/);
    const text = await run(["--api", api, "whoami"], {env});
    assert.match(text.stderr, /\(network_blocked_sandbox\)\n {2}Only the user can allow cardenza\.203\.io, apps\.203\.io and 127\.0\.0\.1/);
    assert.match(text.stderr, /\n {2}- Claude Code on the web/);
    const zh = await run(["--api", api, "--lang", "zh", "whoami", "--json"], {env});
    assert.match(zh.error.error, /这个环境的网络白名单|路上的网络白名单/);
    const doc = await run(["--api", api, "doctor", "--json"], {env});
    assert.equal(doc.code, 1);
    assert.equal(doc.json.problems[0].code, "network_blocked_sandbox");
  } finally { await new Promise(resolve => server.close(resolve)); }
  const help = await run(["help", "sandbox"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /network_blocked_sandbox/);
  assert.match(help.stdout, /network_blocked_cdn/);
  assert.match(topicText("sandbox", "203cli"), /Allowed domains/);
});
