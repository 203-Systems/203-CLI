// The community API for agents and scripts, without dependencies (Node 18+): a client, the saved
// token, and every operation (OPS: what 203cli's commands run; `203cli ops` lists them as JSON).
// Part of the Agent Skill skill/203-community (this folder is the only copy of the CLI).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {parseStl, renderThumbnail} from "./stl.mjs";

// Where the community is (COMMUNITY.md "203cli (the CLI) and the developer guide"). It is moving from cardenza.203.io/community
// to stage.203.io (the user, 2026-11-20). Once it has, the old address answers `code: "moved"` with the new API, and
// 203cli follows that by itself and remembers it (Client, followMove); NEW_ADDRESS_IS_DEFAULT makes the new one the default.
export const OLD_API = "https://cardenza.203.io/community/api";
export const NEW_API = "https://stage.203.io/api";
export const NEW_ADDRESS_IS_DEFAULT = false;
export const DEFAULT_API = NEW_ADDRESS_IS_DEFAULT ? NEW_API : OLD_API;
// 203cli's own version (doctor prints it; the API sees it in User-Agent: 203cli/<version>).
export const CLI_VERSION = "3.5.1";
export const USER_AGENT = "203cli/" + CLI_VERSION;

export class ApiError extends Error {
  constructor(status, code, message, data = {}, {hint} = {}) {
    super(message);
    this.status = status; this.code = code; this.data = data;
    // What to do, when the error knows it better than the API's code says (a blocked network).
    if (hint) this.hint = hint;
  }
}

// ---------------------------------------------------------------------------------------------
// The token: COMMUNITY_TOKEN, else in GitHub Actions this run's trusted-publishing credential (login
// --github-oidc), else ~/.config/203cli/token (XDG_CONFIG_HOME respected), mode 600.

/** 203cli's folder: ~/.config/203cli (XDG_CONFIG_HOME respected): the sign-in, the update checks, where the community moved. */
export function configDir(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "203cli");
}
/** 203c's folder, before the rename: ~/.config/203c. */
export function oldConfigDir(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "203c");
}

export function tokenFile() {
  return path.join(configDir(), "token");
}

/**
 * Once, at 203cli's first run on a computer where 203c was signed in: 203c's token copied into 203cli's folder (mode 600),
 * so the sign-in carries over (nothing is printed: no secret, no noise), and sync's last looks (inbox/). 203c's folder is
 * left as it is, so a 203c still installed keeps working until the community moves; `203cli logout` revokes the token and
 * removes both copies. The update checks are not copied (asked again), the waiting browser sign-in neither. migrated.json says it was done
 * (its time and whether a token came), so a later 203c sign-in is never copied over a 203cli one or after a logout.
 * Returns what it did: {token: true|false} or null (nothing to do).
 */
export function migrateFromOldName({env = process.env, home = os.homedir()} = {}) {
  const from = oldConfigDir(env, home), to = configDir(env, home);
  const marker = path.join(to, "migrated.json");
  try {
    if (!fs.existsSync(from) || fs.existsSync(marker)) return null;
    let token = null;
    try { token = fs.readFileSync(path.join(from, "token"), "utf8").trim() || null; } catch { token = null; }
    fs.mkdirSync(to, {recursive: true, mode: 0o700});
    const target = path.join(to, "token");
    let copied = false;
    if (token && !fs.existsSync(target)) {
      fs.writeFileSync(target, token + "\n", {mode: 0o600});
      fs.chmodSync(target, 0o600);
      copied = true;
    }
    // The last look at each firmware (sync's "new since"), kept per firmware in inbox/: no secret, copied as it is.
    try {
      for (const name of fs.readdirSync(path.join(from, "inbox"))) {
        const there = path.join(to, "inbox", name);
        if (!/\.json$/.test(name) || fs.existsSync(there)) continue;
        fs.mkdirSync(path.dirname(there), {recursive: true, mode: 0o700});
        fs.copyFileSync(path.join(from, "inbox", name), there);
      }
    } catch { /* none */ }
    fs.writeFileSync(marker, JSON.stringify({from, at: new Date().toISOString(), token: copied}) + "\n", {mode: 0o600});
    return {token: copied};
  } catch { return null; }
}

/** 203c's own copy of `token`, removed (logout: the same token, revoked): true when there was one. */
export function forgetOldToken(token, {env = process.env, home = os.homedir()} = {}) {
  const file = path.join(oldConfigDir(env, home), "token");
  try {
    if (!token || fs.readFileSync(file, "utf8").trim() !== token) return false;
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
}

export function loadToken(api) {
  if (process.env.COMMUNITY_TOKEN) return process.env.COMMUNITY_TOKEN.trim();
  const run = loadRunCredential(api);
  if (run) return run.token;
  try { return fs.readFileSync(tokenFile(), "utf8").trim() || null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Trusted publishing (COMMUNITY.md "Trusted publishing", the user 2026-11-17: no stored CI secret). In a GitHub
// Actions job with permissions: id-token: write, login --github-oidc asks the Actions runtime for an OIDC token
// whose audience is the API's base (ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN), exchanges it
// (POST /auth/oidc/github) for a ci credential that publishes one firmware's versions for 15 minutes, and keeps
// it for this run only: in the runner's temporary folder ($RUNNER_TEMP, emptied after every job), never in
// ~/.config. The client renews it by itself (a new GitHub token, a new exchange) before it ends, so a publish
// that waits for the checks longer than 15 minutes goes on.

export const inGithubActions = (env = process.env) => env.GITHUB_ACTIONS === "true";
export const oidcAvailable = (env = process.env) => !!(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

export function runCredentialFile(env = process.env) {
  return inGithubActions(env) && env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, "203cli", "oidc.json") : null;
}

/** This run's credential ({api, token, expires_at, firmware, channel_allowed, run_id}) for this API, or null. */
export function loadRunCredential(api = process.env.COMMUNITY_API || DEFAULT_API, env = process.env) {
  const file = runCredentialFile(env);
  if (!file) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.api !== String(api).replace(/\/+$/, "") || (env.GITHUB_RUN_ID && saved.run_id !== env.GITHUB_RUN_ID)) return null;
    return /^cct_[a-f0-9]{64}$/.test(saved.token ?? "") ? saved : null;
  } catch { return null; }
}

export function saveRunCredential(value, env = process.env) {
  const file = runCredentialFile(env);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, JSON.stringify(value), {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return file;
}

export function forgetRunCredential(env = process.env) {
  const file = runCredentialFile(env);
  try { if (file) { fs.unlinkSync(file); return true; } } catch { /* none */ }
  return false;
}

/** A GitHub Actions OIDC token with this audience, from the Actions runtime (the job needs permissions: id-token: write). */
export async function githubOidcToken(audience, {env = process.env, fetch: fetcher = globalThis.fetch} = {}) {
  if (!oidcAvailable(env)) {
    throw new ApiError(0, "oidc_unavailable", inGithubActions(env)
      ? "This job cannot ask GitHub for an OIDC token: give it permissions: id-token: write"
      : "--github-oidc works in GitHub Actions only (ACTIONS_ID_TOKEN_REQUEST_URL is not set)");
  }
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  let response;
  try { response = await fetcher(url, {headers: {Authorization: "Bearer " + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, Accept: "application/json"}}); }
  catch (error) { throw new ApiError(0, "unreachable", "Cannot reach GitHub Actions' token service (" + (error.cause?.code || error.message) + ")"); }
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.value !== "string") {
    throw new ApiError(response.status, "oidc_unavailable", `GitHub Actions gave no OIDC token (HTTP ${response.status}): does the job have permissions: id-token: write?`);
  }
  return data.value;
}

/** The exchange: a GitHub OIDC token for a trusted-publishing credential of FIRMWARE (OidcToken). */
export async function oidcExchange(client, firmware, {env = process.env} = {}) {
  const exchange = async () => client.request("POST", "/auth/oidc/github",
    {auth: false, body: {token: await githubOidcToken(client.api, {env, fetch: client.fetch}), firmware}, moved: "throw"});
  try { return await exchange(); }
  catch (error) {
    // The community moved (the client went there): a new token, for the new address's audience.
    if (error instanceof ApiError && error.followed) return await exchange();
    throw error;
  }
}

/** A run credential to save from an exchange's answer. */
export function runCredentialOf(client, got, env = process.env) {
  return {api: client.api, token: got.token, expires_at: got.expires_at, firmware: got.firmware, channel_allowed: got.channel_allowed,
    user: got.user ? {id: got.user.id, name: got.user.name} : null, run_id: env.GITHUB_RUN_ID ?? null, repository: env.GITHUB_REPOSITORY ?? null};
}

export function saveToken(token) {
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, token + "\n", {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return file;
}

export function forgetToken() {
  try { fs.unlinkSync(tokenFile()); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// The client

// The language the server answers in (badge names, notifications, error sentences …): zh or en, from
// --lang, else COMMUNITY_LANG, else the locale (LC_ALL, LC_MESSAGES, LANG: zh_CN.UTF-8 is zh).
export function defaultLang(env = process.env) {
  const value = env.COMMUNITY_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^zh/i.test(value) ? "zh" : "en";
}

// ---------------------------------------------------------------------------------------------
// A network that keeps 203cli from the community (the user, 2026-11-20: an agent in Claude Code's cloud got "HTTP 403",
// which told nobody what to do). Every request 203cli makes goes through Client.fetch, which tells these apart from the
// API's own answers (always JSON) and says what to do:
// - an agent sandbox's network allowlist (network_blocked_sandbox): a 403 with x-deny-reason: host_not_allowed
//   (Claude Code's cloud, code.claude.com/docs/en/errors.md#host-not-allowed-in-a-cloud-session); a 403 from one of
//   the community's hosts that is not the community's answer; and in a sandbox that says it is one, the host not
//   resolving (ENOTFOUND, EAI_AGAIN) or a certificate that is not the host's (its proxy answered);
// - the CDN's block page in front of the site (network_blocked_cdn): Cloudflare's 403 (cf-ray, cf-mitigated, "Your
//   request was blocked.", its "Access denied" page), which only the site's owner changes.
// Only the user can allow a host in a sandbox, per environment (a file in the repository cannot).

/** The community's hosts: the live copy and its twin (after the move, its own host). A sandbox's allowlist needs them all. */
export const COMMUNITY_HOSTS = NEW_ADDRESS_IS_DEFAULT ? [new URL(NEW_API).hostname] : ["cardenza.203.io", "apps.203.io"];
export const BLOCKED_CODES = new Set(["network_blocked_sandbox", "network_blocked_cdn"]);
/** The API could not be reached (no answer, or a network between that blocks it): nothing the API said. */
export const offline = error => error instanceof ApiError && (error.code === "unreachable" || BLOCKED_CODES.has(error.code));
/** A fetch that threw, as 203cli says it: a blocked network's own error as it is, else `make(the system's reason)`. */
export const failed = (error, make) => error instanceof ApiError && BLOCKED_CODES.has(error.code) ? error : make(error?.cause?.code || error?.message);

/** The agent sandbox this runs in, from what the sandboxes document: Claude Code's cloud sessions set
 * CLAUDE_CODE_REMOTE=true (code.claude.com/docs/en/cloud-environments.md), Codex sets CODEX_SANDBOX_NETWORK_DISABLED=1
 * for a command its sandbox keeps off the network (openai/codex, codex-rs/core/src/spawn.rs). Others say nothing known. */
export function agentSandbox(env = process.env) {
  if (env.CLAUDE_CODE_REMOTE === "true") return "claude_code";
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") return "codex";
  return null;
}

const DNS_FAILURES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const CERT_FAILURES = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_UNTRUSTED", "ERR_TLS_CERT_ALTNAME_INVALID"]);
/** The system's word for a failed fetch (undici puts it on the cause, or on the first of several addresses tried). */
export const failureCode = error => error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code ?? null;
export const isDnsFailure = code => DNS_FAILURES.has(code);
const hostOf = url => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; } };
const looksJson = text => { try { JSON.parse(text); return true; } catch { return false; } };

/**
 * Whether a 403 is a network on the way rather than the API: {by: "sandbox" | "cdn", reason, ray?} or null.
 * `ours`: the host is the community's (its answers are JSON; another host's 403 counts only with the sandbox's header).
 */
export function blockedAnswer({status, headers, body = "", ours = false}) {
  if (status !== 403) return null;
  const header = name => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? "";
  if (/host_not_allowed/i.test(header("x-deny-reason"))) return {by: "sandbox", reason: "host_not_allowed"};
  if (looksJson(body)) return null;
  const ray = header("cf-ray") || null;
  const page = /Your request was blocked|you have been blocked|Access denied[^<]*Cloudflare|Attention Required|cf-error-details/i.test(body);
  if (page || header("cf-mitigated") || (/html/i.test(header("content-type")) && (ray || /cloudflare/i.test(header("server"))))) {
    return {by: "cdn", reason: header("cf-mitigated") ? "challenge" : "blocked", ray};
  }
  return ours ? {by: "sandbox", reason: "http_403"} : null;
}

/** Whether a request that got no answer was kept off the network by the sandbox this runs in: {by, reason, cause} or null. */
export function blockedFailure(error, {ours = false, sandbox = null} = {}) {
  if (!sandbox || !ours) return null;
  const cause = failureCode(error) ?? "fetch failed";
  if (DNS_FAILURES.has(cause)) return {by: "sandbox", reason: "dns", cause};
  if (CERT_FAILURES.has(cause)) return {by: "sandbox", reason: "certificate", cause};
  // Codex runs the command with the network off: whatever failed, that is why.
  if (sandbox === "codex") return {by: "sandbox", reason: "no_network", cause};
  return null;
}

/** What 203cli says to do in a sandbox that blocks the community (help sandbox, the errors' hints, doctor). */
export function sandboxSteps(lang = "en", {sandbox = null, more = []} = {}) {
  const domains = [...COMMUNITY_HOSTS, ...more.filter(host => host && !COMMUNITY_HOSTS.includes(host))];
  if (lang === "zh") {
    const list = domains.join("、");
    const claude = `- Claude Code 网页版（云端会话）：打开 claude.ai/code，点输入框下面的环境选择器 → Cloud → 这个环境右边的设置（齿轮）图标 → Network access 选 Limited，` +
      `保持勾选「Allow package managers」，在 Allowed domains 里每行一个加上 ${list} → Save changes（或者选 Full）。已经开着的会话大约一分钟内跟上新设置` +
      `（会话标题后面的小箭头 → Edit cloud environment 也能改）。Team / Enterprise 的共享环境由 Owner 在 claude.ai 的管理设置 › Cloud environments 里改。`;
    const others = `- 别的沙箱各有自己的白名单，按环境设置：Codex 云端在环境的联网（internet access）设置里打开并加上这些域名；电脑上的 Codex 默认不让命令联网` +
      `（批准这条命令联网，或在 ~/.codex/config.toml 设 [sandbox_workspace_write] network_access = true）。`;
    return [`只有用户自己能放行 ${list}，在环境的设置里改（仓库里的文件做不到）：`,
      ...(sandbox === "codex" ? [others, claude] : [claude, others]), OFFLINE_ZH].join("\n");
  }
  const list = domains.length > 2 ? domains.slice(0, -1).join(", ") + " and " + domains.at(-1) : domains.join(" and ");
  const claude = `- Claude Code on the web (a cloud session): claude.ai/code → the environment selector under the message box → Cloud → the ` +
    `environment's settings (gear) icon → Network access: Limited, keep "Allow package managers" on, add ${list} to Allowed domains (one ` +
    `per line) → Save changes (or choose Full). A session already open follows within about a minute (the caret after its title → Edit cloud ` +
    `environment does the same). A shared Team or Enterprise environment: an Owner changes it in claude.ai admin settings › Cloud environments.`;
  const others = `- Other sandboxes have their own allowlist, per environment: Codex cloud, the environment's internet access (turn it on, add the ` +
    `domains); Codex on a computer runs commands without network unless allowed (approve the command with network, or ` +
    `[sandbox_workspace_write] network_access = true in ~/.codex/config.toml).`;
  return [`Only the user can allow ${list}, in the environment's settings (a file in the repository cannot):`,
    ...(sandbox === "codex" ? [others, claude] : [claude, others]), OFFLINE_EN].join("\n");
}

export const OFFLINE_EN = "Meanwhile, what needs no network still works: building (tools/cardenza.py build), 203cli rules, 203cli skill install, " +
  "and with the device on this computer's USB cable 203cli flash --bin build/<project>.bin, log and board.";
export const OFFLINE_ZH = "在那之前，不用联网的照样能做：编译（tools/cardenza.py build）、203cli rules、203cli skill install，设备用 USB 线接在这台电脑上时还有 " +
  "203cli flash --bin build/<project>.bin、log 和 board。";

/** The ApiError for a request a network on the way blocked (`url`: the request's, `found`: blockedAnswer / blockedFailure). */
export function blockedError(found, url, {lang = "en", status = 0, sandbox = null} = {}) {
  const host = hostOf(url);
  const zh = lang === "zh";
  if (found.by === "cdn") {
    const ray = found.ray ? (zh ? `，Ray ID ${found.ray}` : `, Ray ID ${found.ray}`) : "";
    const message = zh ? `网站的防火墙（${host} 前面的 Cloudflare）拦下了这个请求（HTTP ${status}${ray}）：拒绝它的不是社区`
      : `The site's firewall (Cloudflare, in front of ${host}) blocked this request (HTTP ${status}${ray}): it was not the community that refused it`;
    const hint = zh
      ? "这个项目和这台电脑上都改不了它：防火墙把这个请求（它来的地址，或发它的程序）当成了机器人，只有网站的主人能在 Cloudflare 里放行。203cli 自己的请求" +
        `（User-Agent 203cli/${CLI_VERSION}）平时会放行；它常拦的是别的程序直接发的请求（curl、Python 的 urllib、AI 的网页抓取），这些请用 203cli 去做。` +
        `203cli 自己也被拦时：把 Ray ID 告诉 203 Systems（https://github.com/203-Systems/203-CLI/issues，GitHub 连得上），或换个网络再试。\n${OFFLINE_ZH}`
      : "Nothing in this project or on this computer changes it: the firewall took the request (where it came from, or the program that sent it) " +
        `for a bot, and only the site's owner lets it through, in Cloudflare. 203cli's own requests (User-Agent 203cli/${CLI_VERSION}) normally pass; ` +
        "what it blocks is other programs fetching directly (curl, Python's urllib, an agent's web fetch): do that with 203cli. When 203cli itself " +
        `is blocked: tell 203 Systems with the Ray ID (https://github.com/203-Systems/203-CLI/issues; GitHub is reachable), or try from another network.\n${OFFLINE_EN}`;
    return new ApiError(0, "network_blocked_cdn", message, {host, http_status: status, reason: found.reason, ...(found.ray ? {ray: found.ray} : {})}, {hint});
  }
  const why = {
    host_not_allowed: zh ? `HTTP 403，x-deny-reason: host_not_allowed` : `HTTP 403, x-deny-reason: host_not_allowed`,
    http_403: zh ? "HTTP 403，但不是社区的回答，社区回答的都是 JSON" : "HTTP 403 that is not the community's answer, which is always JSON",
    dns: zh ? `这里解析不了这个域名：${found.cause}` : `its name does not resolve here: ${found.cause}`,
    certificate: zh ? `替它应答的是代理，证书不是网站的：${found.cause}` : `a proxy answered for it, not with the site's certificate: ${found.cause}`,
    no_network: zh ? `Codex 运行这条命令时没开网络：${found.cause}` : `Codex runs this command without network access: ${found.cause}`,
  }[found.reason];
  // Sure when the sandbox says so (its header, or it says it is one); a 403 that is not the API's elsewhere is a
  // network allowlist all the same: an agent's sandbox, a proxy or a firewall.
  const sure = found.reason === "host_not_allowed" || !!sandbox;
  const message = zh
    ? `${sure ? "这个环境的网络白名单" : "路上的网络白名单（AI 的沙箱、代理或防火墙）"}拦下了 ${host}（${why}）：在这里 203cli 连不上 203 社区`
    : `${sure ? "This environment's network allowlist" : "A network allowlist on the way (an agent's sandbox, a proxy or a firewall)"} blocked ${host} (${why}): 203cli cannot reach the 203 community from here`;
  return new ApiError(0, "network_blocked_sandbox", message,
    {host, allow: [...new Set([...COMMUNITY_HOSTS, host])], reason: found.reason, ...(status ? {http_status: status} : {}), ...(found.cause ? {cause: found.cause} : {}),
      ...(sandbox ? {sandbox} : {})},
    {hint: sandboxSteps(lang, {sandbox, more: [host]})});
}

/**
 * fetch as 203cli uses it: the same, except that a network on the way that blocks the request (above) throws its
 * ApiError instead of answering. `ours(host)`: the community's hosts and the API's; `lang()`: the client's.
 */
export function guardFetch(fetcher, {ours, lang = () => "en", env = process.env}) {
  return async (url, init) => {
    const host = hostOf(url);
    const sandbox = agentSandbox(env);
    let response;
    try { response = await fetcher(url, init); }
    catch (error) {
      const found = blockedFailure(error, {ours: ours(host), sandbox});
      throw found ? blockedError(found, url, {lang: lang(), sandbox}) : error;
    }
    if (response?.status !== 403) return response;
    // The body of a 403 is read from a copy: the caller reads the original as before.
    let body = "";
    try { body = typeof response.clone === "function" ? await response.clone().text() : ""; } catch { body = ""; }
    const found = blockedAnswer({status: response.status, headers: response.headers, body, ours: ours(host)});
    if (found) throw blockedError(found, url, {lang: lang(), status: response.status, sandbox});
    return response;
  };
}

/**
 * One of the community's hosts as this computer reaches it (doctor): {host, ok, url, status?, error?}, `error` being
 * the ApiError 203cli would report (network_blocked_sandbox, network_blocked_cdn, unreachable). The API's root, at the
 * same path as the client's API, without a token.
 */
export async function probeHost(client, host, {timeout_ms = 10_000} = {}) {
  const url = new URL(client.api + "/");
  url.hostname = host;
  try {
    const response = await client.fetch(url.href, {headers: client.langHeaders(), signal: AbortSignal.timeout(timeout_ms)});
    const text = await response.text().catch(() => "");
    if (response.ok && looksJson(text)) return {host, ok: true, url: url.href, status: response.status};
    return {host, ok: false, url: url.href, status: response.status,
      error: new ApiError(response.status, "unavailable", `${host} answered HTTP ${response.status}, not the community's API`)};
  } catch (error) {
    return {host, ok: false, url: url.href, error: error instanceof ApiError ? error
      : new ApiError(0, "unreachable", `Cannot reach ${url.origin} (${failureCode(error) ?? error?.message})`)};
  }
}

// ---------------------------------------------------------------------------------------------
// The community moved (the user, 2026-11-20: from cardenza.203.io/community to stage.203.io). The address it left answers
// 203cli with `{"code": "moved", "api": "<the API where it is now>"}` (HTTP 410; any status counts): the client goes
// there, says so in one line, keeps it in ~/.config/203cli/api.json (the move and its time) and asks again, once. Later
// runs go straight there, whatever named the old address (the default, COMMUNITY_API or --api). The token only ever goes
// to the community's own hosts: a move is followed to https on 203.io (or from a local stack to another local one).

/** ~/.config/203cli/api.json: {moves: {<old API>: {api: <new API>, at: <ISO time>}}}. */
export const movesFile = (env = process.env) => path.join(configDir(env), "api.json");

function readMoves(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(movesFile(env), "utf8"));
    return value && typeof value.moves === "object" && value.moves ? value.moves : {};
  } catch { return {}; }
}

/** Where a move from `from` to `next` (the answer's `api`) goes: the new API's base, or null (not one of ours, or no move). */
export function movedApi(from, next) {
  let a, b;
  try { a = new URL(from); b = new URL(String(next)); } catch { return null; }
  const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const ours = host => host === "203.io" || host.endsWith(".203.io");
  const ok = (b.protocol === "https:" && ours(b.hostname)) || (loopback(a.hostname) && loopback(b.hostname) && /^https?:$/.test(b.protocol));
  if (!ok || b.username || b.password || b.search || b.hash) return null;
  const to = (b.origin + b.pathname).replace(/\/+$/, "");
  return to === String(from).replace(/\/+$/, "") ? null : to;
}

/** The API to use for `api`: where the community moved, when a move from it was remembered (a chain, at most 3). */
export function rememberedApi(api, env = process.env) {
  let current = String(api).replace(/\/+$/, "");
  const moves = readMoves(env);
  for (let i = 0; i < 3; i++) {
    const to = moves[current]?.api ? movedApi(current, moves[current].api) : null;
    if (!to) break;
    current = to;
  }
  return current;
}

/** The move kept for later runs (best effort: a read-only home asks the old address again next time). */
export function rememberMove(from, to, {env = process.env, now = new Date()} = {}) {
  const file = movesFile(env);
  try {
    const moves = readMoves(env);
    moves[from] = {api: to, at: now.toISOString()};
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const fresh = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(fresh, JSON.stringify({moves}, null, 1) + "\n", {mode: 0o600});
    fs.renameSync(fresh, file);
    return file;
  } catch { return null; }
}

/** The one line a move is told with (stderr). */
export function moveLine({from, to, file}, lang = "en") {
  return lang === "zh"
    ? `203cli：203 社区搬家了，从 ${from} 到 ${to}；203cli 以后都用新地址${file ? `（记在 ${file}）` : ""}。`
    : `203cli: the 203 community moved from ${from} to ${to}; 203cli uses the new address from now on${file ? ` (kept in ${file})` : ""}.`;
}

export class Client {
  constructor({api = process.env.COMMUNITY_API || DEFAULT_API, token, fetch: fetcher = globalThis.fetch, lang = defaultLang(), env = process.env,
    onMove = move => process.stderr.write(moveLine(move, this.lang) + "\n")} = {}) {
    this.api = rememberedApi(api, env);
    this.token = token === undefined ? loadToken(this.api) : token;
    this.env = env;
    this.onMove = onMove;
    this.fetch = guardFetch(fetcher, {ours: host => host === hostOf(this.api) || COMMUNITY_HOSTS.includes(host), lang: () => this.lang, env});
    this.lang = /^zh/i.test(lang || "") ? "zh" : "en";
    // This run's trusted-publishing credential (login --github-oidc), renewed before it ends.
    const run = token === undefined && !process.env.COMMUNITY_TOKEN ? loadRunCredential(this.api) : null;
    this.run = run && run.token === this.token ? run : null;
  }

  /** A run credential near its end (a minute) or refused: a new GitHub token, a new exchange, saved for the run. */
  async renewRun() {
    const got = await oidcExchange(this, this.run.firmware);
    this.run = runCredentialOf(this, got);
    this.token = got.token;
    saveRunCredential(this.run);
    if (inGithubActions()) process.stderr.write("::add-mask::" + got.token + "\n");
    return this.run;
  }

  /** Accept-Language for every request, uploads too. */
  langHeaders() { return {"Accept-Language": this.lang === "zh" ? "zh-CN,zh;q=0.9" : "en", "User-Agent": USER_AGENT}; }

  async request(method, apiPath, options = {}) {
    if (this.run && options.auth !== false && Date.parse(this.run.expires_at) - Date.now() < 60_000 && oidcAvailable()) await this.renewRun();
    try { return await this.sendFollowing(method, apiPath, options); }
    catch (error) {
      // Ended early (revoked with its publisher, or the clock): once more with a new one.
      if (!(this.run && options.auth !== false && error instanceof ApiError && error.status === 401 && oidcAvailable())) throw error;
      await this.renewRun();
      return await this.sendFollowing(method, apiPath, options);
    }
  }

  /** send, and when the community answers that it moved: there, once (moved: "throw" leaves asking again to the caller). */
  async sendFollowing(method, apiPath, options) {
    try { return await this.send(method, apiPath, options); }
    catch (error) {
      if (!(error instanceof ApiError && error.code === "moved" && this.follow(error.data?.api))) throw error;
      if (options.moved === "throw") { error.followed = true; throw error; }
      return await this.send(method, apiPath, options);
    }
  }

  /** Goes where the community moved (`next`, the answer's api): true when it did. */
  follow(next) {
    const from = this.api, to = movedApi(from, next);
    if (!to) return false;
    this.api = to;
    const file = rememberMove(from, to, {env: this.env});
    try { this.onMove?.({from, to, file}); } catch { /* the line is a courtesy */ }
    return true;
  }

  async send(method, apiPath, {body, query, headers = {}, auth = true, raw} = {}) {
    const url = new URL(this.api + apiPath);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const sent = {...this.langHeaders(), ...headers};
    if (auth && this.token) sent.Authorization = "Bearer " + this.token;
    let payload = raw;
    if (raw === undefined && (body !== undefined || method === "POST")) {
      sent["Content-Type"] = "application/json";
      payload = JSON.stringify(body ?? {});
    }
    let response;
    try { response = await this.fetch(url, {method, headers: sent, body: payload}); }
    catch (error) { throw failed(error, reason => new ApiError(0, "unreachable", "Cannot reach " + this.api + " (" + reason + ")")); }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // The community moved (any status): Client.sendFollowing goes there.
    if (!response.ok || (data && typeof data === "object" && data.code === "moved")) {
      const message = data && typeof data === "object" && data.error ? data.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, data?.code || "http_" + response.status, message, typeof data === "object" ? data : {});
    }
    return data;
  }

  get(apiPath, query) { return this.request("GET", apiPath, {query}); }
  post(apiPath, body) { return this.request("POST", apiPath, {body: body ?? {}}); }
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// Files

const MEDIA = {".wav": ["audio", "audio/wav"], ".mp3": ["audio", "audio/mpeg"], ".ogg": ["audio", "audio/ogg"], ".flac": ["audio", "audio/flac"],
  ".m4a": ["audio", "audio/mp4"], ".mp4": ["video", "video/mp4"], ".webm": ["video", "video/webm"]};
const MODEL = {".stl": "stl", ".step": "step", ".stp": "step", ".3mf": "3mf", ".obj": "obj"};
// Sound packs and projects: CardenzaSynth's files by extension.
const PACK = {".ccpreset": "preset", ".ccproj": "project", ".wav": "sample"};
const PREVIEW = [".wav", ".mp3", ".ogg"];

function readFile(file) {
  try { return new Uint8Array(fs.readFileSync(file)); }
  catch (error) { throw new ApiError(0, "usage", `Cannot read ${file}: ${error.code || error.message}`); }
}

async function put(client, upload, bytes) {
  let response;
  try { response = await client.fetch(upload.url, {method: upload.method || "PUT", headers: upload.headers, body: bytes}); }
  catch (error) { throw failed(error, reason => new ApiError(0, "unreachable", "The upload failed: " + reason)); }
  if (!response.ok) throw new ApiError(response.status, "upload_failed", `The storage refused the upload (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  await response.arrayBuffer().catch(() => {});
}

// A work: the API makes it, the file goes to its signed URL, done checks it.
export async function uploadWork(client, {file, title, description, tags, firmware, version, version_label, duration_ms, device = false, firmware_match}) {
  const ext = path.extname(file).toLowerCase();
  const kind = MEDIA[ext];
  if (!kind) throw new ApiError(0, "usage", "A work is .wav, .mp3, .ogg, .flac, .m4a (audio) or .mp4, .webm (video)");
  const bytes = readFile(file);
  const body = {title: title || path.basename(file, ext), kind: kind[0], mime: kind[1], size: bytes.length};
  if (description) body.description = description;
  if (tags) body.tags = tags;
  if (duration_ms !== undefined) body.duration_ms = Number(duration_ms);
  if (device) body.firmware_match = firmware_match ?? {};
  else {
    if (firmware) body.firmware = firmware;
    if (version) body.version = version;
    if (version_label) body.version_label = version_label;
  }
  const made = await client.post(device ? "/device/works" : "/works", body);
  await put(client, made.upload, bytes);
  const done = await client.post(`${device ? "/device/works" : "/works"}/${made.work.id}/done`);
  return device ? done : done;
}

// A model: each file, the preview (an STL file itself when there is one, else --preview) and a
// thumbnail (rendered here from an STL preview, else --thumbnail).
export async function uploadModel(client, args) {
  const files = (Array.isArray(args.files) ? args.files : [args.files]).filter(Boolean);
  if (!files.length) throw new ApiError(0, "usage", "Give the model's files (.stl, .step/.stp, .3mf, .obj)");
  const entries = files.map(file => {
    const format = MODEL[path.extname(file).toLowerCase()];
    if (!format) throw new ApiError(0, "usage", `${file}: a model file is .stl, .step/.stp, .3mf or .obj`);
    return {file, name: path.basename(file), format, bytes: readFile(file)};
  });
  let preview;
  if (args.preview) {
    const ext = path.extname(args.preview).toLowerCase();
    if (![".stl", ".glb"].includes(ext)) throw new ApiError(0, "usage", "--preview is an .stl or .glb mesh");
    preview = {format: ext.slice(1), bytes: readFile(args.preview)};
  } else {
    const stl = entries.find(e => e.format === "stl");
    if (!stl) {
      throw new ApiError(0, "usage", "Only STL files serve as their own preview: give --preview <mesh.stl|mesh.glb> and --thumbnail <image.png> " +
        "(the site converts STEP in the browser; the CLI cannot)");
    }
    preview = {format: "stl", bytes: stl.bytes};
  }
  let thumbnail;
  if (args.thumbnail) {
    thumbnail = readFile(args.thumbnail);
    if (!(thumbnail[0] === 0x89 && thumbnail[1] === 0x50 && thumbnail[2] === 0x4e && thumbnail[3] === 0x47)) {
      throw new ApiError(0, "usage", "--thumbnail is a PNG image");
    }
  } else if (preview.format === "stl") {
    thumbnail = renderThumbnail(parseStl(preview.bytes));
  } else {
    throw new ApiError(0, "usage", "The CLI draws thumbnails only from an STL preview: give --thumbnail <image.png> (640x480)");
  }
  const body = {title: args.title, license: args.license, files: entries.map(e => ({name: e.name, format: e.format, size: e.bytes.length})),
    preview: {format: preview.format, size: preview.bytes.length}, thumbnail: {size: thumbnail.length}};
  for (const key of ["description", "tags", "target", "firmware", "remix_of", "print"]) if (args[key] !== undefined) body[key] = args[key];
  const made = await client.post("/models", body);
  for (const upload of made.uploads) {
    const bytes = upload.slot === "preview" ? preview.bytes : upload.slot === "thumbnail" ? thumbnail : entries.find(e => e.name === upload.slot).bytes;
    await put(client, upload, bytes);
  }
  return await client.post(`/models/${made.model.id}/done`);
}

// A sound pack or a project (official firmware only): each file to its signed upload, then done (the
// server reads the files back: a bank's engine and presets, a project's format and tempo). A sound's
// engine, when not given, is read from its banks' first lines (several engines: mixed).
export async function uploadPack(client, kind, args) {
  const paths = (Array.isArray(args.files) ? args.files : [args.files]).filter(Boolean);
  if (!paths.length) {
    throw new ApiError(0, "usage", kind === "sound" ? "Give the sound's files (.ccpreset banks, .wav samples)" : "Give the project's .ccproj (and its .wav samples)");
  }
  const entries = paths.map(file => {
    const fileKind = PACK[path.extname(file).toLowerCase()];
    if (!fileKind || (kind === "sound" && fileKind === "project") || (kind === "project" && fileKind === "preset")) {
      throw new ApiError(0, "usage", `${file}: ${kind === "sound" ? "a sound's files are .ccpreset banks and .wav samples" : "a project's files are one .ccproj and .wav samples"}`);
    }
    return {name: path.basename(file), kind: fileKind, bytes: readFile(file)};
  });
  if (args.preview) {
    if (!PREVIEW.includes(path.extname(args.preview).toLowerCase())) throw new ApiError(0, "usage", "--preview is a .wav, .mp3 or .ogg file");
    entries.push({name: path.basename(args.preview), kind: "preview", bytes: readFile(args.preview),
      ...(args.preview_ms !== undefined ? {duration_ms: Number(args.preview_ms)} : {})});
  }
  const body = {title: args.title, firmware: args.firmware, files: entries.map(({name, kind: k, bytes, duration_ms}) =>
    ({name, kind: k, size: bytes.length, ...(duration_ms !== undefined ? {duration_ms} : {})}))};
  if (kind === "sound") {
    let engine = args.engine;
    if (!engine) {
      const engines = new Set(entries.filter(e => e.kind === "preset")
        .map(e => /^CARDENZA_PRESETS 1 "([a-z0-9_]+)"/.exec(new TextDecoder().decode(e.bytes.subarray(0, 64)))?.[1]).filter(Boolean));
      if (!engines.size) throw new ApiError(0, "usage", "Give --engine dx7|juno|sampler|drums|mixed (no bank says it)");
      engine = engines.size > 1 ? "mixed" : [...engines][0];
    }
    body.engine = engine;
  } else if (args.bpm !== undefined) body.bpm = Number(args.bpm);
  for (const key of ["description", "tags", "version"]) if (args[key] !== undefined) body[key] = args[key];
  const made = await client.post(kind === "sound" ? "/sounds" : "/projects", body);
  // A slot is the file's name, "preview" for the preview.
  for (const upload of made.uploads) {
    await put(client, upload, entries.find(e => upload.slot === "preview" ? e.kind === "preview" : e.name === upload.slot).bytes);
  }
  return await client.post(`/${kind}s/${made[kind].id}/done`);
}

// A cover: a signed upload of the picture, then done (the server reads its size and first bytes).
export async function uploadCover(client, code, bytes, mime) {
  const made = await client.post(`/firmware/${enc(code)}/cover`, {mime, size: bytes.length});
  await put(client, made.upload, bytes);
  return await client.post(`/firmware/${enc(code)}/cover/done`);
}

// A picture (COMMUNITY.md "Pictures"): a signed upload into the gallery (above the description, at most 9) or the
// description (place "description", at most 20: its text places it, ![words](image:<id>)), then done. Answers
// {id, firmware}: the picture's id and the Firmware after it.
export async function uploadPicture(client, code, bytes, mime, {caption = "", place = "gallery"} = {}) {
  const made = await client.post(`/firmware/${enc(code)}/images`, {mime, size: bytes.length, ...(caption ? {caption} : {}), ...(place !== "gallery" ? {place} : {})});
  try {
    await put(client, made.upload, bytes);
    return {id: made.image.id, firmware: await client.post(`/firmware/${enc(code)}/images/${enc(made.image.id)}/done`)};
  } catch (error) {
    // A picture that did not go up gives its place back.
    await client.post(`/firmware/${enc(code)}/images/${enc(made.image.id)}/delete`).catch(() => {});
    throw error;
  }
}

// A tutorial's picture (COMMUNITY.md "Tutorials"): the author's own for a firmware, a signed upload checked on done; one that
// did not go up is removed again. → the TutorialImage.
export async function uploadTutorialPicture(client, code, bytes, mime) {
  const made = await client.post(`/firmware/${enc(code)}/tutorial-images`, {mime, size: bytes.length});
  try {
    await put(client, made.upload, bytes);
    return await client.post(`/firmware/${enc(code)}/tutorial-images/${enc(made.image.id)}/done`);
  } catch (error) {
    await client.post(`/firmware/${enc(code)}/tutorial-images/${enc(made.image.id)}/delete`).catch(() => {});
    throw error;
  }
}

// A version: a draft, each device's BIN to its upload ticket, then publish.
export async function publishVersion(client, {code, channel = "stable", version, bins, notices, notes, source_commit, source_url,
  wait = true, poll_seconds = 5, timeout_seconds = 1200, sleep = ms => new Promise(r => setTimeout(r, ms))}) {
  const targets = Object.keys(bins ?? {});
  if (!targets.length) throw new ApiError(0, "usage", "Give each device's BIN: --bin cardenza=build/app.bin");
  const images = Object.fromEntries(targets.map(target => [target, readFile(bins[target])]));
  const noticeBytes = notices ? readFile(notices) : null;
  const body = {channel, version, targets};
  if (notes) body.notes = notes;
  if (source_commit) body.source_commit = source_commit;
  if (source_url) body.source_url = source_url;
  const draft = await client.post(`/firmware/${enc(code)}/versions`, body);
  const uploaded = [];
  for (const upload of draft.uploads) {
    const form = new FormData();
    const isUf2 = images[upload.target].length >= 4 && Buffer.from(images[upload.target].subarray(0, 4)).toString("latin1") === "UF2\n";
    form.set("image", new Blob([images[upload.target]]), isUf2 ? "app.uf2" : "app.bin");
    if (noticeBytes) form.set("notices", new Blob([noticeBytes]), "NOTICES.txt");
    let response;
    try { response = await client.fetch(upload.upload_url, {method: "POST", headers: {...client.langHeaders(), Authorization: "Bearer " + upload.ticket}, body: form}); }
    catch (error) { throw failed(error, reason => new ApiError(0, "unreachable", "The upload failed: " + reason)); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.code || "upload_failed", `${upload.target}: ${data.error || "upload refused"}`, data);
    uploaded.push(data);
  }
  let published = await client.post(`/firmware/${enc(code)}/versions/${enc(draft.version.code)}/publish`);
  // Every version goes through the checks before it is published (or sent back with a report).
  const until = Date.now() + timeout_seconds * 1000;
  while (wait && published.status === "checking" && Date.now() < until) {
    await sleep(poll_seconds * 1000);
    published = (await client.get(`/versions/${enc(draft.version.code)}`)).version;
  }
  if (published.status === "rejected") {
    const failed = (published.check?.steps ?? []).filter(step => step.status === "fail").map(step => `${step.name} (${step.target}): ${step.detail}`);
    throw new ApiError(409, "rejected", `The checks sent ${published.version} (${published.code}) back: ${failed.join("; ") || "see its check"}` +
      ` — appeal with: 203cli versions appeal ${published.code} --message "…"`, {version: published, uploaded});
  }
  return {version: published, uploaded};
}

// ---------------------------------------------------------------------------------------------
// Operations: name, description, JSON schema of the arguments, and what they do.

const s = (description, extra = {}) => ({type: "string", description, ...extra});
const n = (description, extra = {}) => ({type: "integer", description, ...extra});
const b = description => ({type: "boolean", description});
const a = (description, items = {type: "string"}) => ({type: "array", items, description});
const page = n("Page, from 1 (24 a page)", {minimum: 1});
// The section lists are endless: cursor (the previous answer's next_cursor) and limit (1-60).
const cursor = s("The previous answer's next_cursor (the page after it)");
const limit = n("Items a page, 1-60 (24 by default)", {minimum: 1, maximum: 60});
const SECTION = ["page", "cursor", "limit"];
const code = s("A six-character code (any case)");

export const OPS = [];
function op(name, description, properties, required, run, {write = false} = {}) {
  OPS.push({name, description, inputSchema: {type: "object", properties, required, additionalProperties: false}, run, write});
}
const pick = (args, keys) => Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));

// The account
op("whoami", "The signed-in account (name, level, title, badges, XP) and this credential (kind, name, scopes)", {}, [], c => c.get("/me"));
op("quotas", "What is left of every limit today (firmware, versions, works, models, sounds, projects, posts, comments …)", {}, [], c => c.get("/me/quotas"));
op("me_update", "Change the account's name (2-24 characters), avatar (a01-a24) or bio", {name: s("New name"), avatar: s("a01..a24"), bio: s("Bio")}, [],
  (c, x) => c.post("/me", pick(x, ["name", "avatar", "bio"])), {write: true});
op("notifications", "Notifications, newest first, with the unread count", {page}, [], (c, x) => c.get("/me/notifications", {page: x.page}));
op("notifications_read", "Mark notifications read (all when ids is absent)", {ids: a("Notification ids", {type: "integer"})}, [],
  (c, x) => c.post("/me/notifications/read", pick(x, ["ids"])), {write: true});
op("favorites", "Your favourites of one kind", {kind: s("firmware, post, work, model, sound or project",
  {enum: ["firmware", "post", "work", "model", "sound", "project"]}), page}, [],
  (c, x) => c.get("/me/favorites", {kind: x.kind, page: x.page}));
op("my_things", "Your own firmware (private too), works, posts, models, sounds or projects", {what: s("firmware, works, posts, models, sounds or projects",
  {enum: ["firmware", "works", "posts", "models", "sounds", "projects"]}), page},
  ["what"], (c, x) => c.get("/me/" + x.what, {page: x.page}));
op("xp_history", "Your XP history, level and the XP for the next level", {page}, [], (c, x) => c.get("/me/xp", {page: x.page}));
op("levels", "Levels and the XP rules", {}, [], c => c.get("/levels"));
op("badges_all", "Every badge and how it is earned", {}, [], c => c.get("/badges"));
op("my_badges", "Your badges and the worn ones", {}, [], c => c.get("/me/badges"));
op("badges_wear", "Wear 0-3 of your badges, in display order", {worn: a("Badge ids")}, ["worn"], (c, x) => c.post("/me/badges", {worn: x.worn}), {write: true});
op("my_titles", "Your titles and the worn one", {}, [], c => c.get("/me/titles"));
op("title_wear", "Wear a title (null: none)", {title: {type: ["string", "null"], description: "A title id or null"}}, ["title"],
  (c, x) => c.post("/me/title", {title: x.title ?? null}), {write: true});
op("devices", "Bound devices: online (and where: its Launcher or a firmware running), what it runs (running: name, code, version, whether that firmware can be online), last seen", {}, [], c => c.get("/me/devices"));
op("recovery", "A recovery flash: per device, the official Launcher's newest stable build and the official firmware's (download each with version_download)", {}, [], c => c.get("/recovery"));
op("user", "A person's profile", {id: s("User id (8 characters)")}, ["id"], (c, x) => c.get("/users/" + enc(x.id)));
op("user_things", "A person's public firmware, works, posts, models, sounds, projects or badges",
  {id: s("User id"), what: s("firmware, works, posts, models, sounds, projects or badges",
    {enum: ["firmware", "works", "posts", "models", "sounds", "projects", "badges"]}), page}, ["id", "what"],
  (c, x) => c.get(`/users/${enc(x.id)}/${x.what}`, {page: x.page}));

// Finding things
op("search", "Search firmware, posts, works, models, sounds, projects and people (6 of each); a code is looked up as one", {q: s("1-64 characters")}, ["q"],
  (c, x) => c.get("/search", {q: x.q}));
op("code", "What a firmware or version code names", {code}, ["code"], (c, x) => c.get("/codes/" + enc(x.code)));
op("targets", "Devices the hub knows", {}, [], c => c.get("/targets"));
op("tags", "The most used tags", {kind: s("firmware (default), post, work, model, sound or project"), section: s("Firmware: official or community")}, [],
  (c, x) => c.get("/tags", pick(x, ["kind", "section"])));
op("sections", "The six sections (firmware, sounds, projects, works, models, posts) with their counts", {}, [], c => c.get("/sections"));
op("section_show", "A section's categories (labels, counts: use them as tag=) and its most used tags", {id: s("firmware, sounds, projects, works, models or posts")},
  ["id"], (c, x) => c.get("/sections/" + enc(x.id)));

// Firmware
const firmwareFields = {kind: s("app (default) or launcher; fixed at creation", {enum: ["app", "launcher"]}), name: s("1-64 characters"), summary: s("1-100 characters"), description: s("Markdown subset"), tags: a("Up to 8 tags"),
  source_url: s("https link to the source"), clone_url: s("https://….git"), license: s("SPDX identifier (MIT, GPL-3.0-only, …) or proprietary"),
  visibility: s("public or private", {enum: ["public", "private"]}),
  password: s("8-64 characters (private firmware)"), channels: {type: "object", properties: {beta: b("Beta channel on"), dev: b("Dev channel on")},
    additionalProperties: false}};
op("firmware_list", "Public firmware (official ones first); the answer's next_cursor gives the next page",
  {kind: s("app (default) or launcher"), section: s("official, community or all"), official: b("Official firmware only"), q: s("Words"),
  tag: s("A category or tag (official, launcher, groovebox, …)"), target: s("A device"), forks: b("Forks too (hidden by default)"), sort: s("new, hot, downloads or likes"), page, cursor, limit}, [],
  (c, x) => c.get("/firmware", {...pick(x, ["kind", "section", "q", "tag", "target", "sort", ...SECTION]), ...(x.official ? {official: 1} : {}), ...(x.forks ? {forks: 1} : {})}));
op("firmware_show", "A firmware (private ones need their unlock token)", {code, unlock: s("cfu_… from firmware_unlock")}, ["code"],
  (c, x) => c.request("GET", "/firmware/" + enc(x.code), {headers: x.unlock ? {"X-Firmware-Unlock": x.unlock} : {}}));
op("firmware_create", "Make a firmware (forked_from: a firmware or version code to fork)", {...firmwareFields, forked_from: code},
  ["name", "summary", "visibility"], (c, x) => c.post("/firmware", x), {write: true});
op("firmware_fork", "Fork a firmware (or a version) into a new firmware of yours",
  {from: s("The firmware or version code to fork"), name: s("1-64 characters"), summary: s("1-160 characters"), visibility: s("public or private"),
    password: s("For a private fork"), description: s("Markdown")}, ["from", "name", "summary"],
  (c, x) => c.post("/firmware", {...pick(x, ["name", "summary", "password", "description"]), visibility: x.visibility || "public", forked_from: x.from}), {write: true});
op("firmware_edit", "Change a firmware (owner or admin): any of its fields", {code, ...firmwareFields}, ["code"],
  (c, x) => { const {code: which, kind: _kind, ...rest} = x; return c.post(`/firmware/${enc(which)}/edit`, rest); }, {write: true});
op("firmware_delete", "Delete a firmware (its forks stay)", {code}, ["code"], (c, x) => c.post(`/firmware/${enc(x.code)}/delete`, {confirm: x.code}), {write: true});
op("firmware_unlock", "Open a private firmware with its password; answers an unlock token", {code, password: s("The password")}, ["code", "password"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/unlock`, {password: x.password}));
op("firmware_cover", "Set a firmware's cover from a local picture (PNG, JPEG or WebP, up to 2 MB; shown 16:9)", {code, file: s("Local path of the picture")},
  ["code", "file"], (c, x) => {
    const bytes = readFile(x.file);
    const mime = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : "image/webp";
    return uploadCover(c, x.code, bytes, mime);
  }, {write: true});
op("firmware_cover_delete", "Remove a firmware's cover (the screen after boot shows, else a plain box)", {code}, ["code"], (c, x) => c.post(`/firmware/${enc(x.code)}/cover/delete`), {write: true});
// Pictures (COMMUNITY.md "Pictures"): the gallery above the description (Firmware.images, at most 9) and the description's
// (Firmware.description_images, at most 20; ![words](image:<id>) in the description places one).
const pictureId = s("A picture's id (8 characters; firmware_show lists images and description_images)");
op("firmware_image_add", "Add a picture from a local file (PNG, JPEG or WebP, up to 2 MB) to a firmware's gallery or, place description, to its description (owner, admin)",
  {code, file: s("Local path of the picture"), caption: s("Up to 60 characters"), place: s("gallery (default) or description", {enum: ["gallery", "description"]})},
  ["code", "file"], async (c, x) => {
    const bytes = readFile(x.file);
    const mime = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : "image/webp";
    return (await uploadPicture(c, x.code, bytes, mime, {caption: x.caption ?? "", place: x.place ?? "gallery"})).firmware;
  }, {write: true});
op("firmware_image_edit", "A picture's caption (\"\": none) or place (gallery or description) (owner, admin)",
  {code, id: pictureId, caption: s("Up to 60 characters; empty: none"), place: s("gallery or description", {enum: ["gallery", "description"]})}, ["code", "id"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/images/${enc(x.id)}/edit`, pick(x, ["caption", "place"])), {write: true});
op("firmware_image_delete", "Remove a picture (owner, admin)", {code, id: pictureId}, ["code", "id"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/images/${enc(x.id)}/delete`), {write: true});
op("firmware_images_order", "The gallery in a new order: every gallery picture's id once (owner, admin)", {code, ids: a("Picture ids")}, ["code", "ids"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/images/order`, {ids: x.ids}), {write: true});
op("firmware_tree", "The fork tree around a firmware", {code}, ["code"], (c, x) => c.get(`/firmware/${enc(x.code)}/tree`));
// Trusted publishing (COMMUNITY.md "Trusted publishing"): the GitHub repositories whose Actions runs may publish a firmware's versions.
op("publishers_list", "A firmware's trusted publishers: the GitHub repositories (workflow, environment, channels, last use) whose Actions runs publish its versions without a secret (owner, admin)",
  {code}, ["code"], (c, x) => c.get(`/firmware/${enc(x.code)}/publishers`));
op("publisher_add", "Link a trusted publisher: a GitHub repository (owner/name), its workflow file and environment, the channels (owner, admin; at most 5)",
  {code, repository: s("owner/name"), workflow: s("The workflow's file name, e.g. firmware.yml (recommended)"), environment: s("A GitHub environment the job must run in"),
    channels: a("stable, beta, dev (default all three; the run's ref limits them too)")}, ["code", "repository"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/publishers`, pick(x, ["repository", "workflow", "environment", "channels"])), {write: true});
op("publisher_remove", "Remove a trusted publisher (its credentials stop working at once)", {code, id: {type: "integer", description: "The publisher's id"}}, ["code", "id"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/publishers/${enc(x.id)}/delete`), {write: true});
op("firmware_lookup", "Firmware with exactly this name (ignoring case): yours first, any device, forks too", {name: s("The exact name")}, ["name"],
  (c, x) => c.get("/firmware/lookup", {name: x.name}));
op("firmware_based_on", "Set what a firmware of yours was made from (forked_from): a firmware or version code, or null for an original",
  {code, from: {type: ["string", "null"], description: "A firmware or version code, or null"}, unlock: s("cfu_… when the original is private")}, ["code", "from"],
  (c, x) => c.request("POST", `/firmware/${enc(x.code)}/edit`, {body: {forked_from: x.from ?? null}, headers: x.unlock ? {"X-Firmware-Unlock": x.unlock} : {}}),
  {write: true});
for (const [what, kind] of [["like", "like"], ["favorite", "favourite"]]) {
  op(`firmware_${what}`, `${kind[0].toUpperCase() + kind.slice(1)} a firmware (on: false to undo)`, {code, on: b("Default true")}, ["code"],
    (c, x) => c.post(`/firmware/${enc(x.code)}/${what}`, {on: x.on ?? true}), {write: true});
}
op("firmware_works", "Works made with a firmware", {code, version: s("A version code"), page}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/works`, pick(x, ["version", "page"])));

// Versions
op("versions_list", "A firmware's versions, newest first", {code, channel: s("stable, beta or dev"), target: s("Only versions with a BIN for this device (e.g. cardenza)"), page}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/versions`, pick(x, ["channel", "target", "page"])));
op("version_show", "A version and its firmware", {version_code: code}, ["version_code"], (c, x) => c.get("/versions/" + enc(x.version_code)));
op("version_by_label", "A firmware's version by its label (1.4.0)", {code, label: s("The version label")}, ["code", "label"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/versions/${enc(x.label)}`));
op("version_source_delete", "Remove a version's source archive", {code, version_code: code}, ["code", "version_code"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/versions/${enc(x.version_code)}/source/delete`), {write: true});
op("version_publish", "Publish a version: uploads each device's BIN (local files) and publishes it",
  {code, version: s("1-32 of [0-9A-Za-z._+-]"), channel: s("stable, beta or dev", {enum: ["stable", "beta", "dev"]}),
    bins: {type: "object", description: "target → local path of its application BIN, e.g. {\"cardenza\": \"build/app.bin\"}", additionalProperties: {type: "string"}},
    notices: s("Local path of NOTICES.txt"), notes: s("Release notes (Markdown)"), source_commit: s("7-40 hex"), source_url: s("https link")},
  ["code", "version", "bins"], (c, x) => publishVersion(c, x), {write: true});
// (version_publish waits for the checks unless wait is false; poll_seconds sets how often it asks.)
OPS[OPS.length - 1].inputSchema.properties.wait = b("Wait for the checks (default true)");
OPS[OPS.length - 1].inputSchema.properties.poll_seconds = n("How often to ask while it is checked (default 5)");
op("version_edit", "Change a version's notes", {version_code: code, notes: s("Notes")}, ["version_code", "notes"],
  (c, x) => c.post(`/versions/${enc(x.version_code)}/edit`, {notes: x.notes}), {write: true});
op("version_delete", "Delete a version (its code then answers 410)", {version_code: code}, ["version_code"],
  (c, x) => c.post(`/versions/${enc(x.version_code)}/delete`, {confirm: x.version_code}), {write: true});

// Merge requests
op("merges_list", "Merge requests aimed at a firmware", {code, status: s("open, merged, closed or all"), page}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/merges`, pick(x, ["status", "page"])));
op("merge_show", "A merge request", {code, number: n("Its number")}, ["code", "number"], (c, x) => c.get(`/firmware/${enc(x.code)}/merges/${x.number}`));
op("merge_open", "Open a merge request from your fork to its parent", {code: s("The parent firmware's code"), from: s("Your fork's code"),
  from_version: s("A version code of the fork"), title: s("1-120 characters"), body: s("Markdown"), github_url: s("https://github.com/… pull request")},
  ["code", "from", "title"], (c, x) => { const {code: target, ...rest} = x; return c.post(`/firmware/${enc(target)}/merges`, rest); }, {write: true});
op("merge_status", "Merge, close or reopen a merge request", {code, number: n("Its number"), status: s("merged, closed or open", {enum: ["merged", "closed", "open"]}),
  merged_version: s("For merged: the version that has it")}, ["code", "number", "status"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/merges/${x.number}/status`, pick(x, ["status", "merged_version"])), {write: true});

// Works
op("works_list", "Works (made with official firmware); the answer's next_cursor gives the next page", {q: s("Words"), tag: s("A category or tag (lofi, …)"),
  firmware: s("A firmware code"), sort: s("new or hot"), page, cursor, limit}, [], (c, x) => c.get("/works", pick(x, ["q", "tag", "firmware", "sort", ...SECTION])));
op("work_show", "A work", {id: s("Work id")}, ["id"], (c, x) => c.get("/works/" + enc(x.id)));
op("work_upload", "Upload a work (a local audio or video file) made with an official firmware", {file: s("Local path (.wav .mp3 .ogg .flac .m4a .mp4 .webm)"),
  title: s("1-80 characters"), description: s("Text"), tags: a("Up to 5"), firmware: s("An official firmware's code"),
  version: s("A version code of an official firmware"), version_label: s("A version name when there is no code"),
  duration_ms: n("Length")}, ["file", "firmware"], (c, x) => uploadWork(c, x), {write: true});
op("work_edit", "Change a work", {id: s("Work id"), title: s("Title"), description: s("Text"), tags: a("Up to 5"), version: s("A version code (empty: none)")}, ["id"],
  (c, x) => c.post(`/works/${enc(x.id)}/edit`, pick(x, ["title", "description", "tags", "version"])), {write: true});
op("work_delete", "Delete a work", {id: s("Work id")}, ["id"], (c, x) => c.post(`/works/${enc(x.id)}/delete`), {write: true});
op("work_approve", "Publish a work your device sent (held until you approve it)", {id: s("Work id")}, ["id"], (c, x) => c.post(`/works/${enc(x.id)}/approve`), {write: true});
op("admin_feature", "Admin: feature (加精) firmware, a sound, project, work, model or post, or not", {kind: s("firmware, sound, project, work, model or post"),
  ref: s("Its code or id"), on: b("Default true")}, ["kind", "ref"], (c, x) => c.post(`/admin/content/${enc(x.kind)}/${enc(x.ref)}/feature`, {on: x.on ?? true}), {write: true});

// Models
op("models_list", "Models (3D files); the answer's next_cursor gives the next page", {q: s("Words"), tag: s("A category or tag"), target: s("A device"),
  firmware: s("A firmware code"), sort: s("new, hot or downloads"), page, cursor, limit}, [],
  (c, x) => c.get("/models", pick(x, ["q", "tag", "target", "firmware", "sort", ...SECTION])));
op("model_show", "A model", {id: s("Model id")}, ["id"], (c, x) => c.get("/models/" + enc(x.id)));
op("model_upload", "Upload a model: local files (.stl .step .stp .3mf .obj); an STL is its own preview and the CLI draws the thumbnail; other formats need preview (.stl/.glb) and thumbnail (.png)",
  {files: a("Local paths"), title: s("1-80 characters"), license: s("CC-BY-4.0, CC-BY-SA-4.0, CC-BY-NC-4.0, CC-BY-NC-SA-4.0, CC0-1.0 or all-rights-reserved"),
    description: s("Markdown"), tags: a("Tags"), target: s("A device it is for"), firmware: s("Firmware code"), remix_of: s("The remixed model's id"),
    preview: s("Local .stl or .glb"), thumbnail: s("Local .png"), print: {type: "object", description: "material, layer_height_mm, infill_percent, supports, notes"}},
  ["files", "title", "license"], (c, x) => uploadModel(c, x), {write: true});
op("model_edit", "Change a model", {id: s("Model id"), title: s("Title"), description: s("Text"), tags: a("Tags"), target: s("Device"), firmware: s("Code"),
  license: s("Licence"), print: {type: "object"}}, ["id"],
  (c, x) => { const {id, ...rest} = x; return c.post(`/models/${enc(id)}/edit`, rest); }, {write: true});
op("model_delete", "Delete a model", {id: s("Model id")}, ["id"], (c, x) => c.post(`/models/${enc(x.id)}/delete`), {write: true});
op("model_download", "A model file's download link (with out: saves it)", {id: s("Model id"), file: s("A file name (the first when absent)"),
  out: s("Local path to save to")}, ["id"], async (c, x) => {
  const link = await c.post(`/models/${enc(x.id)}/download`, pick(x, ["file"]));
  if (x.out) {
    const response = await c.fetch(link.url);
    if (!response.ok) throw new ApiError(response.status, "download_failed", "The download failed (HTTP " + response.status + ")");
    fs.writeFileSync(x.out, new Uint8Array(await response.arrayBuffer()));
    return {...link, saved: x.out};
  }
  return link;
});
op("model_remixes", "Remixes of a model", {id: s("Model id"), page}, ["id"], (c, x) => c.get(`/models/${enc(x.id)}/remixes`, {page: x.page}));

// Sound packs and projects (official firmware only)
for (const [kind, plural, what] of [["sound", "sounds", "sound pack"], ["project", "projects", "project"]]) {
  const sound = kind === "sound";
  op(plural + "_list", `${sound ? "Sound packs" : "Projects"} for official firmware; the answer's next_cursor gives the next page`, {q: s("Words"),
    tag: s(sound ? "A category or tag (an engine counts: dx7, juno, sampler, drums)" : "A category or tag (lofi, techno, …)"),
    ...(sound ? {engine: s("dx7, juno, sampler, drums or mixed")} : {}), firmware: s("A firmware code"), sort: s("new, hot or downloads"), page, cursor, limit}, [],
    (c, x) => c.get("/" + plural, pick(x, ["q", "tag", "engine", "firmware", "sort", ...SECTION])));
  op(kind + "_show", `A ${what} (its files and preview)`, {id: s("Its id")}, ["id"], (c, x) => c.get(`/${plural}/${enc(x.id)}`));
  op(kind + "_upload", sound
    ? "Share a sound pack for an official firmware: local .ccpreset banks and .wav samples (the engine is read from the banks when not given), an optional preview"
    : "Share a project for an official firmware: its local .ccproj and .wav samples, an optional preview (format and tempo are read from the .ccproj)",
    {files: a("Local paths"), title: s("1-80 characters"), firmware: s("An official firmware's code"), version: s("A version code of it"),
      ...(sound ? {engine: s("dx7, juno, sampler, drums or mixed")} : {bpm: n("30-300 (the file's tempo wins)")}), description: s("Markdown"),
      tags: a("Up to 8"), preview: s("Local .wav, .mp3 or .ogg"), preview_ms: n("The preview's length")},
    ["files", "title", "firmware"], (c, x) => uploadPack(c, kind, x), {write: true});
  op(kind + "_edit", `Change a ${what}`, {id: s("Its id"), title: s("Title"), description: s("Text"), tags: a("Tags"),
    ...(sound ? {engine: s("Once done: mixed or its banks' engine")} : {bpm: n("30-300")})}, ["id"],
    (c, x) => { const {id, ...rest} = x; return c.post(`/${plural}/${enc(id)}/edit`, rest); }, {write: true});
  op(kind + "_delete", `Delete a ${what}`, {id: s("Its id")}, ["id"], (c, x) => c.post(`/${plural}/${enc(x.id)}/delete`), {write: true});
  op(kind + "_download", `A ${what}'s files to download: one by name, else every file's link (with out: saves it, or them into that folder)`,
    {id: s("Its id"), file: s("A file name (absent: every file)"), out: s("Local path (a file), or a folder for every file")},
    ["id"], async (c, x) => {
      const link = await c.post(`/${plural}/${enc(x.id)}/download`, pick(x, ["file"]));
      if (!x.out) return link;
      const save = async (url, to) => {
        const response = await c.fetch(url);
        if (!response.ok) throw new ApiError(response.status, "download_failed", "The download failed (HTTP " + response.status + ")");
        fs.writeFileSync(to, new Uint8Array(await response.arrayBuffer()));
        return to;
      };
      if (link.url) return {...link, saved: await save(link.url, x.out)};
      fs.mkdirSync(x.out, {recursive: true});
      const saved = [];
      for (const file of link.files) saved.push(await save(file.url, path.join(x.out, path.basename(file.name))));
      return {...link, saved};
    });
}

// Posts, comments, reactions, reports
op("posts_list", "Forum posts (pinned first); the answer's next_cursor gives the next page", {q: s("Words"), tag: s("A category or tag"),
  firmware: s("A firmware code"), sort: s("new or hot"), page, cursor, limit}, [], (c, x) => c.get("/posts", pick(x, ["q", "tag", "firmware", "sort", ...SECTION])));
op("post_show", "A post", {id: s("Post id")}, ["id"], (c, x) => c.get("/posts/" + enc(x.id)));
op("post_create", "Write a post", {title: s("1-120 characters"), body: s("Markdown, 1-20000 characters"), tags: a("Up to 5"), firmware: s("A firmware code")},
  ["title", "body"], (c, x) => c.post("/posts", x), {write: true});
op("post_edit", "Change a post", {id: s("Post id"), title: s("Title"), body: s("Markdown"), tags: a("Tags"), firmware: s("Code")}, ["id"],
  (c, x) => { const {id, ...rest} = x; return c.post(`/posts/${enc(id)}/edit`, rest); }, {write: true});
op("post_delete", "Delete a post", {id: s("Post id")}, ["id"], (c, x) => c.post(`/posts/${enc(x.id)}/delete`), {write: true});
const thingPath = (kind, ref) => kind === "firmware" ? `/firmware/${enc(ref)}`
  : kind === "merge" || kind === "request" ? (() => { const [c_, n_] = String(ref).split("/");
      return `/firmware/${enc(c_)}/${kind === "merge" ? "merges" : "requests"}/${enc(n_)}`; })()
  : `/${kind}s/${enc(ref)}`;
const thingKind = s("firmware, post, work, model, sound, project, merge or request",
  {enum: ["firmware", "post", "work", "model", "sound", "project", "merge", "request"]});
op("react", "Like or favourite something (on: false to undo); comments can be liked", {kind: s("firmware, post, work, model, sound, project or comment"),
  ref: s("Code or id"), what: s("like or favorite", {enum: ["like", "favorite"]}), on: b("Default true")}, ["kind", "ref"],
  (c, x) => c.post(x.kind === "comment" ? `/comments/${enc(x.ref)}/like` : `${thingPath(x.kind, x.ref)}/${x.what || "like"}`, {on: x.on ?? true}), {write: true});
op("comments_list", "Comments on something (newest first, with their newest replies)", {kind: thingKind, ref: s("Code, id or CODE/n"), page}, ["kind", "ref"],
  (c, x) => c.get(`${thingPath(x.kind, x.ref)}/comments`, {page: x.page}));
op("comment_replies", "Replies to a comment", {id: n("Comment id"), page}, ["id"], (c, x) => c.get(`/comments/${x.id}/replies`, {page: x.page}));
op("comment_add", "Comment on something (parent: reply to a comment)", {kind: thingKind, ref: s("Code, id or CODE/n"), body: s("1-4000 characters"),
  parent: n("Comment id")}, ["kind", "ref", "body"], (c, x) => c.post(`${thingPath(x.kind, x.ref)}/comments`, pick(x, ["body", "parent"])), {write: true});
op("comment_edit", "Change your comment", {id: n("Comment id"), body: s("Text")}, ["id", "body"], (c, x) => c.post(`/comments/${x.id}/edit`, {body: x.body}), {write: true});
op("comment_delete", "Delete a comment", {id: n("Comment id")}, ["id"], (c, x) => c.post(`/comments/${x.id}/delete`), {write: true});
op("report", "Report something", {kind: s("firmware, version, post, work, model, sound, project, comment, request or user"), ref: s("Code or id"),
  reason: s("spam, abuse, illegal, malware, copyright or other"), detail: s("Up to 1000 characters")}, ["kind", "ref", "reason"],
  (c, x) => c.post("/reports", x), {write: true});

// The Launcher's view (handy to check what a device would get)
op("launcher_code", "What a Launcher gets for a code and device", {code, target: s("A device, e.g. cardenza"), password: s("A private firmware's password"),
  unlock: s("cfu_…")}, ["code", "target"], (c, x) => c.request("GET", `/launcher/code/${enc(x.code)}`, {query: {target: x.target},
  headers: {...(x.password ? {"X-Firmware-Password": x.password} : {}), ...(x.unlock ? {"X-Firmware-Unlock": x.unlock} : {})}}));

// Admin
op("admin_overview", "Admin: counts", {}, [], c => c.get("/admin/overview"));
op("admin_users", "Admin: people", {q: s("Name or id"), status: s("active, banned or deleted"), page}, [], (c, x) => c.get("/admin/users", pick(x, ["q", "status", "page"])));
op("admin_ban", "Admin: ban (days 1, 7, 30; absent: until lifted)", {id: s("User id"), days: n("1, 7 or 30"), reason: s("Reason")}, ["id", "reason"],
  (c, x) => c.post(`/admin/users/${enc(x.id)}/ban`, {days: x.days ?? null, reason: x.reason}), {write: true});
op("admin_unban", "Admin: lift a ban", {id: s("User id")}, ["id"], (c, x) => c.post(`/admin/users/${enc(x.id)}/unban`), {write: true});
op("admin_delete_user", "Admin: close an account (注销)", {id: s("User id"), reason: s("Reason")}, ["id", "reason"],
  (c, x) => c.post(`/admin/users/${enc(x.id)}/delete`, {confirm: x.id, reason: x.reason}), {write: true});
op("admin_content", "Admin: hide, unhide or delete firmware, a version, post, work, model, sound, project or comment",
  {kind: s("firmware, version, post, work, model, sound, project or comment"),
  ref: s("Code or id"), action: s("hide, unhide or delete", {enum: ["hide", "unhide", "delete"]}), reason: s("Reason")}, ["kind", "ref", "action"],
  (c, x) => c.post(`/admin/content/${enc(x.kind)}/${enc(x.ref)}/${x.action}`, pick(x, ["reason"])), {write: true});
op("admin_official", "Admin: the official tag on a firmware", {code, on: b("Default true")}, ["code"],
  (c, x) => c.post(`/admin/firmware/${enc(x.code)}/official`, {on: x.on ?? true}), {write: true});
op("admin_post_flag", "Admin: pin or lock a post", {id: s("Post id"), flag: s("pin or lock", {enum: ["pin", "lock"]}), on: b("Default true")}, ["id", "flag"],
  (c, x) => c.post(`/admin/posts/${enc(x.id)}/${x.flag}`, {on: x.on ?? true}), {write: true});
op("admin_official_create", "Admin: show a hub App as an official firmware", {hub_app_id: s("The hub App's UUID"), tags: a("Tags")}, ["hub_app_id"],
  (c, x) => c.post("/admin/official", pick(x, ["hub_app_id", "tags"])), {write: true});
op("admin_reports", "Admin: reports", {status: s("open or resolved"), page}, [], (c, x) => c.get("/admin/reports", pick(x, ["status", "page"])));
op("admin_resolve", "Admin: resolve a report", {id: n("Report id"), action: s("dismiss, hide, delete or ban"), note: s("Note"), days: n("Ban days")},
  ["id", "action"], (c, x) => c.post(`/admin/reports/${x.id}/resolve`, pick(x, ["action", "note", "days"])), {write: true});
op("admin_audit", "Admin: the audit log", {actor: s("A user id"), page}, [], (c, x) => c.get("/admin/audit", pick(x, ["actor", "page"])));
op("admin_section_set", "Admin: replace a section's categories (up to 30: tag, label_zh, label_en, highlight) and / or open or close it", {id: s("A section"),
  categories: a("Categories", {type: "object"}), open: b("Open (true) or close (false) the section")}, ["id"],
  (c, x) => c.post(`/admin/sections/${enc(x.id)}`, pick(x, ["categories", "open"])), {write: true});
op("admin_titles", "Admin: titles", {}, [], c => c.get("/admin/titles"));
op("admin_title_create", "Admin: make a title in both languages (Chinese up to 8 characters, English up to 16; one may be left out; admin titles are orange-red)",
  {text_zh: s("Chinese text"), text_en: s("English text"), text: s("The text in the request's language (--lang), when text_zh / text_en are not given"),
    color: s("cyan, yellow, violet, green, pink, blue, lime, amber"), admin: b("An admin title")}, [],
  (c, x) => c.post("/admin/titles", x), {write: true});
op("admin_title_edit", "Admin: change a title", {id: s("Title id"), text_zh: s("Chinese text"), text_en: s("English text"), text: s("Text in the request's language"),
  color: s("Colour")}, ["id"],
  (c, x) => c.post(`/admin/titles/${enc(x.id)}/edit`, pick(x, ["text_zh", "text_en", "text", "color"])), {write: true});
op("admin_title_delete", "Admin: delete a title", {id: s("Title id")}, ["id"], (c, x) => c.post(`/admin/titles/${enc(x.id)}/delete`), {write: true});
op("admin_grant_title", "Admin: grant or take back a title", {user: s("User id"), title: s("Title id"), on: b("Default true")}, ["user", "title"],
  (c, x) => c.post(`/admin/users/${enc(x.user)}/titles`, {title: x.title, on: x.on ?? true}), {write: true});
const BADGE_TEXT = {name_zh: s("Chinese name"), name_en: s("English name"), name: s("The name in the request's language (--lang)"),
  description_zh: s("Chinese description"), description_en: s("English description"), description: s("Description in the request's language")};
op("admin_badge_create", "Admin: make a badge to grant, in both languages (one may be left out)", {...BADGE_TEXT, icon: s("b01..b32")}, ["icon"],
  (c, x) => c.post("/admin/badges", x), {write: true});
op("admin_badge_edit", "Admin: change a granted badge", {id: s("Badge id"), ...BADGE_TEXT, icon: s("b01..b32")}, ["id"],
  (c, x) => c.post(`/admin/badges/${enc(x.id)}/edit`, pick(x, [...Object.keys(BADGE_TEXT), "icon"])), {write: true});
op("admin_badge_delete", "Admin: delete a granted badge", {id: s("Badge id")}, ["id"], (c, x) => c.post(`/admin/badges/${enc(x.id)}/delete`), {write: true});
op("admin_grant_badge", "Admin: grant or take back a badge", {user: s("User id"), badge: s("Badge id"), on: b("Default true")}, ["user", "badge"],
  (c, x) => c.post(`/admin/users/${enc(x.user)}/badges`, {badge: x.badge, on: x.on ?? true}), {write: true});
op("admin_xp", "Admin: adjust a person's XP (-10000…10000; audited)", {user: s("User id"), delta: n("XP"), reason: s("Reason")}, ["user", "delta", "reason"],
  (c, x) => c.post(`/admin/users/${enc(x.user)}/xp`, {delta: x.delta, reason: x.reason}), {write: true});

// Downloads and web builds
op("version_download", "A version's BIN for a device (a third-party launcher needs accept_risk: it may leave the device unable to start); out: save it (an app BIN with its signature after the image: COMMUNITY.md Signed builds)",
  {version_code: code, target: s("A device"), accept_risk: b("Accept the risk of a third-party launcher"), out: s("Local path")}, ["version_code", "target"],
  async (c, x) => {
    const link = await c.post(`/versions/${enc(x.version_code)}/download`, pick(x, ["target", "accept_risk"]));
    if (!x.out) return link;
    const response = await c.fetch(link.url);
    if (!response.ok) throw new ApiError(response.status, "download_failed", "The download failed (HTTP " + response.status + ")");
    const image = new Uint8Array(await response.arrayBuffer());
    if (link.sha256 && crypto.createHash("sha256").update(image).digest("hex") !== link.sha256) {
      throw new ApiError(0, "sha_mismatch", "The download is not the file the API describes (its SHA-256)");
    }
    // The image, then its trailer: the file says what it is wherever it goes (installed over USB or SD).
    const trailer = link.trailer ? Buffer.from(link.trailer, "base64") : null;
    fs.writeFileSync(x.out, trailer ? Buffer.concat([image, trailer]) : image);
    return {...link, saved: x.out, signed: !!trailer};
  });
// What a BIN (or a build) is (POST /builds/identify): a file's signature trailer, else its SHA-256.
const TRAILER_MAGIC = Buffer.from("203SIGN1");
export function binTrailer(bytes) {
  if (bytes.length < 112 || !bytes.subarray(bytes.length - 8).equals(TRAILER_MAGIC)) return null;
  const total = bytes.readUInt32LE(bytes.length - 16);
  if (total % 16 || total < 112 || total > bytes.length || !bytes.subarray(bytes.length - total, bytes.length - total + 8).equals(TRAILER_MAGIC)) return null;
  return {image: bytes.subarray(0, bytes.length - total), trailer: bytes.subarray(bytes.length - total)};
}
op("build_identify", "What a BIN is: its signature (the trailer a community's download ends with), checked by the community, else its SHA-256 matched by the community's record; the firmware, version, what it was made from (lineage) and whether a newer build is out",
  {file: s("A .bin file"), sha256: s("A file's SHA-256 instead of a file"), target: s("A device (narrows a SHA-256 match)")}, [],
  async (c, x) => {
    if (!x.file === !x.sha256) throw new ApiError(0, "usage", "Give a .bin file or --sha256");
    let claim;
    if (x.file) {
      const bytes = fs.readFileSync(x.file);
      const found = binTrailer(bytes);
      claim = found ? {trailer: found.trailer.toString("base64")} : {sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
    } else claim = {sha256: String(x.sha256).toLowerCase()};
    const answer = await c.post("/builds/identify", {builds: [{...claim, ...(x.target ? {target: x.target} : {})}]});
    return answer.items[0];
  });
op("version_simulator_upload", "Upload a version's web build (a folder with index.html and what it loads, up to 20 files, 64 MB)",
  {code, version_code: code, dir: s("Local folder")}, ["code", "version_code", "dir"], async (c, x) => {
    const files = [];
    const walk = (folder, prefix) => {
      for (const entry of fs.readdirSync(folder, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
        else if (entry.isFile()) files.push({path: relative, full: path.join(folder, entry.name)});
      }
    };
    walk(x.dir, "");
    const made = await c.post(`/firmware/${enc(x.code)}/versions/${enc(x.version_code)}/simulator`,
      {files: files.map(f => ({path: f.path, size: fs.statSync(f.full).size}))});
    const uploaded = [];
    for (const upload of made.uploads) {
      const form = new FormData();
      form.set("file", new Blob([readFile(files.find(f => f.path === upload.path).full)]), path.basename(upload.path));
      const response = await c.fetch(upload.upload_url, {method: "POST", headers: {...c.langHeaders(), Authorization: "Bearer " + upload.ticket}, body: form});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(response.status, data.code || "upload_failed", `${upload.path}: ${data.error || "upload refused"}`, data);
      uploaded.push(data);
    }
    return {uploaded};
  }, {write: true});

// Checks, appeals and feedback
op("version_check", "A version's status and check report (its owner and admins): steps, log, appeal", {version_code: code}, ["version_code"],
  async (c, x) => { const v = (await c.get("/versions/" + enc(x.version_code))).version; return {code: v.code, version: v.version, status: v.status, check: v.check}; });
op("version_appeal", "Appeal a version the checks sent back (a false positive): say why the check is wrong (10-2000 characters)",
  {version_code: code, message: s("Why the check is wrong")}, ["version_code", "message"],
  (c, x) => c.post(`/versions/${enc(x.version_code)}/appeal`, {message: x.message}), {write: true});
op("feedback", "Send feedback about the community itself (a bug or an idea)", {kind: s("bug or idea", {enum: ["bug", "idea"]}), title: s("1-120 characters"),
  message: s("1-2000 characters"), page: s("Where on the site")}, ["kind", "title", "message"], (c, x) => c.post("/feedback", x), {write: true});
op("my_feedback", "Your appeals and feedback, with their status and our reply", {page}, [], (c, x) => c.get("/me/feedback", {page: x.page}));

// Tutorials (COMMUNITY.md "Tutorials"): a guide (the tutorial format, reference/tutorial-format.md) or a link, the firmware's
// owner's first; the author's own pictures for a firmware.
const tutorialId = s("A tutorial's id (8 characters; tutorials_list lists them)");
op("tutorials_list", "A firmware's tutorials (the owner's, official, first; hidden ones only for their author, the owner and admins)", {code, page}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/tutorials`, pick(x, ["page"])));
op("tutorial_show", "A tutorial: a guide's whole document (its source for its author), or a link", {code, id: tutorialId}, ["code", "id"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/tutorials/${enc(x.id)}`));
op("tutorial_create", "Add a tutorial: a guide (document: the file's text, checked as reference/tutorial-format.md says; one per author and firmware) or a link (title, url; up to 5)",
  {code, document: s("A guide: the tutorial file's text (JSON)"), title: s("A link: 2-60 wide"), url: s("A link: https://…")}, ["code"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/tutorials`, pick(x, ["document", "title", "url"])), {write: true});
op("tutorial_edit", "Change your tutorial: a guide's document, or a link's title or url", {code, id: tutorialId, document: s("The tutorial file's text"),
  title: s("A link's title"), url: s("A link's address")}, ["code", "id"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/tutorials/${enc(x.id)}/edit`, pick(x, ["document", "title", "url"])), {write: true});
op("tutorial_delete", "Delete a tutorial (its author, an admin)", {code, id: tutorialId}, ["code", "id"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/tutorials/${enc(x.id)}/delete`), {write: true});
op("tutorial_hide", "Hide a tutorial or show it again (the firmware's owner, an admin; the author is told)", {code, id: tutorialId, on: b("true: hide it; false: show it"),
  reason: s("Why (shown to its author)")}, ["code", "id", "on"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/tutorials/${enc(x.id)}/hide`, pick(x, ["on", "reason"])), {write: true});
op("tutorial_images", "Your pictures for a firmware's tutorials (id, sha256, whether a tutorial uses it)", {code}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/tutorial-images`));
op("tutorials_all", "Firmware that have tutorials, the most downloaded first, each with its first 3", {target: s("A device: firmware with a build for it"),
  q: s("Words in a firmware's name or a tutorial's title"), page}, [], (c, x) => c.get("/tutorials", pick(x, ["target", "q", "page"])));

// Requests (public) and the developer tracker (the firmware's owner, or an admin)
op("requests_list", "Requests under a firmware", {code, sort: s("top or new"), page}, ["code"],
  (c, x) => c.get(`/firmware/${enc(x.code)}/requests`, pick(x, ["sort", "page"])));
op("request_show", "A request", {code, number: n("Its number")}, ["code", "number"], (c, x) => c.get(`/firmware/${enc(x.code)}/requests/${x.number}`));
op("request_create", "Ask for something in a firmware", {code, title: s("4-80 characters"), body: s("Markdown")}, ["code", "title"],
  (c, x) => c.post(`/firmware/${enc(x.code)}/requests`, pick(x, ["title", "body"])), {write: true});
op("request_vote", "Vote a request up (1), down (-1) or take the vote back (0)", {code, number: n("Its number"), vote: n("1, -1 or 0")},
  ["code", "number", "vote"], (c, x) => c.post(`/firmware/${enc(x.code)}/requests/${x.number}/vote`, {vote: x.vote}), {write: true});
op("dev_requests", "Tracker: requests of your firmware with their internal status (admins: all)", {firmware: s("A firmware code"),
  status: s("new, accepted, planned, in_progress, done or rejected"), sort: s("top, new or updated"), page}, [],
  (c, x) => c.get("/dev/requests", pick(x, ["firmware", "status", "sort", "page"])));
op("dev_request_read", "Tracker: a request as a specification (body, votes, internal notes and the whole discussion)", {code, number: n("Its number")},
  ["code", "number"], (c, x) => c.get(`/dev/requests/${enc(x.code)}/${x.number}`));
op("dev_request_update", "Tracker: set status, progress, labels; add a note or a link (never notifies anyone)",
  {code, number: n("Its number"), status: s("new, accepted, planned, in_progress, done or rejected"), progress: n("0-100"), labels: a("Replaces the labels"),
    note: s("Appended"), link: s("An https link, appended")}, ["code", "number"],
  (c, x) => c.post(`/dev/requests/${enc(x.code)}/${x.number}`, pick(x, ["status", "progress", "labels", "note", "link"])), {write: true});

// The community tracker (admins)
op("community_issues", "Admin: the community's issues (appeals, bugs, ideas)", {kind: s("false_positive, bug or idea"),
  status: s("new, investigating, false_positive, confirmed, fixed or wont_fix"), page}, [],
  (c, x) => c.get("/dev/community/issues", pick(x, ["kind", "status", "page"])));
op("community_issue_read", "Admin: an issue with its full check report, log and the version's BINs", {number: n("Issue number")}, ["number"],
  (c, x) => c.get(`/dev/community/issues/${x.number}`));
op("community_issue_update", "Admin: status, a note, a link, or a reply (the author sees the reply and is notified)",
  {number: n("Issue number"), status: s("new, investigating, false_positive, confirmed, fixed or wont_fix"), note: s("Internal"), link: s("https"),
    reply: s("Shown to the author")}, ["number"],
  (c, x) => c.post(`/dev/community/issues/${x.number}`, pick(x, ["status", "note", "link", "reply"])), {write: true});
op("admin_version_override", "Admin: publish a version the checks sent back (a false positive)", {version_code: code, note: s("Why")},
  ["version_code", "note"], (c, x) => c.post(`/admin/versions/${enc(x.version_code)}/override`, {note: x.note}), {write: true});
op("admin_version_recheck", "Admin: run a version's checks again (after the checker was fixed)", {version_code: code}, ["version_code"],
  (c, x) => c.post(`/admin/versions/${enc(x.version_code)}/recheck`), {write: true});

// Send to a device
op("device_send", "Send a firmware (newest on a channel) or a version to one of your bound devices; waits and reports each step",
  {device: n("Device id (see devices)"), code: s("A firmware or version code"), start: b("Start it after installing"), channel: s("stable (default), beta or dev"),
    wait: b("Follow it until it ends (default true)"), unlock: s("cfu_… for a private firmware not yours")}, ["device", "code"],
  async (c, x, {sleep = ms => new Promise(r => setTimeout(r, ms)), onStep} = {}) => {
    const command = await c.request("POST", `/me/devices/${x.device}/commands`, {body: {action: x.start ? "install_start" : "install", code: x.code,
      ...(x.channel ? {channel: x.channel} : {})}, headers: x.unlock ? {"X-Firmware-Unlock": x.unlock} : {}});
    return followCommand(c, x.device, command, {wait: x.wait !== false, sleep, onStep});
  }, {write: true});
op("device_command", "A command sent to one of your devices (devices send): its step and progress; wait: follow it until it ends",
  {device: n("Device id (see devices)"), command: s("The command's id (devices send answers it)"), wait: b("Follow it until it ends")}, ["device", "command"],
  async (c, x, {sleep = ms => new Promise(r => setTimeout(r, ms)), onStep} = {}) =>
    followCommand(c, x.device, await c.get(`/me/devices/${x.device}/commands/${enc(String(x.command))}`), {wait: !!x.wait, sleep, onStep}));

// A command until it ends (installed, started, failed, expired) when wait; failed and expired are errors.
async function followCommand(c, device, command, {wait, sleep, onStep}) {
  const final = cmd => ["failed", "expired", "started"].includes(cmd.status) || (cmd.status === "installed" && cmd.action === "install");
  let last = "";
  while (wait && !final(command)) {
    await sleep(2000);
    command = await c.get(`/me/devices/${device}/commands/${command.id}`);
    const now = command.status + " " + command.progress;
    if (now !== last) { onStep?.(command); last = now; }
  }
  if (["failed", "expired"].includes(command.status)) throw new ApiError(409, "command_" + command.status, command.error || command.status, {command});
  return command;
}

// 升级启动器 (我的设备; COMMUNITY.md "The 203 Launcher's own update"): the newest 203 Launcher for the device, followed
// to started (the new Launcher running); 409 up_to_date when it runs it already.
op("device_update_launcher", "Upgrade a bound, online device's 203 Launcher to the newest for it; waits and reports each step (started: the new Launcher runs)",
  {device: n("Device id (see devices)"), channel: s("stable (default), beta or dev"), wait: b("Follow it until it ends (default true)")}, ["device"],
  async (c, x, {sleep = ms => new Promise(r => setTimeout(r, ms)), onStep} = {}) => {
    const command = await c.request("POST", `/me/devices/${x.device}/commands`, {body: {action: "update_launcher", ...(x.channel ? {channel: x.channel} : {})}});
    return followCommand(c, x.device, command, {wait: x.wait !== false, sleep, onStep});
  }, {write: true});

// Anything else
op("api_request", "Any API call (see /openapi.json): method, path below the API base, JSON body", {method: s("GET or POST", {enum: ["GET", "POST"]}),
  path: s("e.g. /firmware/ABC234/versions"), body: {type: "object"}, query: {type: "object", additionalProperties: {type: "string"}}}, ["method", "path"],
  (c, x) => c.request(x.method, x.path.startsWith("/") ? x.path : "/" + x.path, {body: x.method === "POST" ? x.body ?? {} : undefined, query: x.query}));

export const opsByName = Object.fromEntries(OPS.map(entry => [entry.name, entry]));

// A version's source archive (a .tar.gz; scripts/source.mjs makes and checks it): a ticket, then the upload.
export async function uploadSource(client, code, versionCode, bytes, sha256) {
  const started = await client.post(`/firmware/${enc(code)}/versions/${enc(versionCode)}/source`, {size: bytes.length, sha256});
  const form = new FormData();
  form.set("source", new Blob([bytes]), "source.tar.gz");
  let response;
  try { response = await client.fetch(started.upload.upload_url, {method: "POST", headers: {...client.langHeaders(), Authorization: "Bearer " + started.upload.ticket}, body: form}); }
  catch (error) { throw failed(error, reason => new ApiError(0, "upload_failed", `The source upload failed (${reason})`)); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.code || "upload_failed", data.error || "The source upload was refused", data);
  return data;
}

// ---------------------------------------------------------------------------------------------
// The browser sign-in (COMMUNITY.md "Signing in"): OAuth 2.0's authorization code with PKCE (S256) and a
// loopback redirect, as `gh auth login --web` does. A one-shot listener on 127.0.0.1, the site's
// /authorize page in the browser (signed in with the site's own sign-in), back to the listener with the
// code and the state, the code and the verifier exchanged for a cli credential.

const b64url = bytes => Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Why no browser can be opened here (then 203cli uses the device code), or null. BROWSER names one. */
export function browserProblem(env = process.env, platform = process.platform) {
  if (env.BROWSER === "none") return "BROWSER=none";
  if (env.BROWSER) return null;
  if (env.CI) return "CI";
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "SSH";
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "no display";
  return null;
}

/** Opens a URL in the user's browser (BROWSER: a program taking the URL). Resolves whether it started. */
export function openBrowser(url, env = process.env) {
  const [command, args] = env.BROWSER ? [env.BROWSER, [url]]
    : process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, {stdio: "ignore", detached: true, windowsHide: true}); }
    catch { resolve(false); return; }
    child.on("error", () => resolve(false));
    child.on("spawn", () => { child.unref(); resolve(true); });
  });
}

const callbackPage = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>203cli</title>
<style>body{font:16px system-ui,sans-serif;background:#0b0b0b;color:#eee;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:30em;padding:1em}h1{font-size:1.4em}</style>
<main><h1>${title}</h1><p>${text}</p></main>`;
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);

/**
 * The browser sign-in. say(url) is told the page to open (to print it); open(url) opens it.
 * Resolves the token answer ({kind, token, scopes, user, credential}); rejects with an ApiError
 * (access_denied, expired, or the server's refusal).
 */
export async function browserLogin(client, {name, admin = false, timeout = 300, say = () => {}, open = openBrowser} = {}) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    // The OAuth client id stays "203c" (the name before the rename): the community's database knows that one.
    const checked = await client.request("GET", "/auth/authorize", {auth: false, query: {response_type: "code", client_id: "203c", redirect_uri: redirect,
      code_challenge: challenge, code_challenge_method: "S256", state, scope: admin ? "read write admin" : "read write",
      name: (name || "203cli on " + os.hostname()).slice(0, 40)}});
    say(checked.authorize_url);
    const opened = await open(checked.authorize_url);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ApiError(0, "expired", "Nobody approved the sign-in in the browser in time")), timeout * 1000);
      if (!opened) say(checked.authorize_url, {opened: false});
      let handled = false;
      server.on("request", async (req, res) => {
        // The page goes out whole before 203cli moves on (and closes the listener).
        const reply = (status, title, text) => new Promise(done => {
          res.writeHead(status, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", connection: "close"});
          res.end(callbackPage(title, text), done);
        });
        const url = new URL(req.url, redirect);
        if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        // Anything without this sign-in's state is not its answer: refused, and 203cli goes on waiting.
        if (url.searchParams.get("state") !== state) { await reply(400, "Not this sign-in", "This page does not belong to the sign-in 203cli is waiting for."); return; }
        // Only the first answer counts: a reload must never present the code again (that revokes it).
        if (handled) { await reply(200, "Done", "203cli already has its answer. You can close this tab."); return; }
        handled = true;
        clearTimeout(timer);
        if (url.searchParams.get("error")) {
          await reply(200, "Sign-in refused", "203cli was not signed in. You can close this tab.");
          reject(new ApiError(403, "access_denied", "The sign-in was refused in the browser"));
          return;
        }
        try {
          const got = await client.request("POST", "/auth/token", {auth: false, body: {grant_type: "authorization_code", code: url.searchParams.get("code") ?? "",
            code_verifier: verifier, redirect_uri: redirect, client_id: "203c"}});
          await reply(200, "203cli is signed in", `Signed in as ${escapeHtml(got.user?.name ?? "")}. You can close this tab and go back to the terminal.`);
          resolve(got);
        } catch (error) {
          await reply(400, "Sign-in failed", escapeHtml(error.message) + ". Run 203cli login again.");
          reject(error);
        }
      });
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// ---------------------------------------------------------------------------------------------
// The sign-in (device authorization, as the Launcher signs in too): a code the user approves on the
// site's /activate, polled until approved.

export async function loginStart(client, name) {
  return await client.request("POST", "/auth/device/start", {body: {client: "cli", name: (name || "203cli on " + os.hostname()).slice(0, 40)}, auth: false});
}

export async function loginPoll(client, requestId, {wait = true, interval = 3, timeout = 600, sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  const until = Date.now() + timeout * 1000;
  while (true) {
    try { return await client.request("POST", "/auth/device/poll", {body: {request_id: requestId}, auth: false}); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "authorization_pending" || !wait || Date.now() > until) throw error;
    }
    await sleep(interval * 1000);
  }
}
