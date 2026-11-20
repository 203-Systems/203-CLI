// Update notices (the user, 2026-11-20: "调用模拟器、编译以及别的指令的时候会提示更新"): whether a newer 203c is out (npm's
// latest) and whether the project's CardenzaHAL submodule is behind the HAL's main (GitHub's compare), or not a clean copy
// of it (the HAL's own tools/check_submodule.py says so). One line each, on stderr, after the commands developers run
// while working (commands.mjs `notices`); doctor lists both; `203c updates` asks for them; CardenzaHAL's build prints
// them too (cmake/require_203c.cmake runs `203c updates --quiet`).
// Never in the way: each asks the network at most once a day (updates.json beside the sign-in, ~/.config/203c: versions
// and commit counts only), the request starts with the command and is waited for at most TIMEOUT_MS from then, any
// failure is silent, nothing goes to stdout or into an exit code, and nothing is asked in CI (CI, GITHUB_ACTIONS) or
// with NO_UPDATE_NOTIFIER or C203_NO_UPDATE_CHECK=1 set. C203_NPM_REGISTRY (an npm mirror) and C203_GITHUB_API change
// where it asks (the tests' stand-ins).
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {CLI_VERSION} from "./lib.mjs";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const GITHUB_API = "https://api.github.com";
export const UPDATE_CLI = "npm install -g 203c && 203c skill install";
export const DAY_MS = 24 * 3600 * 1000;
export const TIMEOUT_MS = 1500;
// Waited for a little longer than a request may take, so a failed request is still written down (and not asked again
// by every command of the day).
const GRACE_MS = 300;

// ---------------------------------------------------------------------------------------------
// Versions, the switch, the state file

/** a < b: -1, equal: 0, a > b: 1 (major.minor.patch, a pre-release below its release); null when one is not a version. */
export function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
    return m ? {core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : []} : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    return numeric ? (Number(p) < Number(q) ? -1 : 1) : (p < q ? -1 : 1);
  }
  return 0;
}

const set = value => value !== undefined && value !== "" && !/^(0|false|no|off)$/i.test(String(value));

/** The user's own switch, or null: C203_NO_UPDATE_CHECK=1, NO_UPDATE_NOTIFIER (doctor honours these, not CI). */
export function optedOut(env = process.env) {
  if (set(env.C203_NO_UPDATE_CHECK)) return "C203_NO_UPDATE_CHECK";
  if (set(env.NO_UPDATE_NOTIFIER)) return "NO_UPDATE_NOTIFIER";
  return null;
}

/** Why nothing is asked by itself here ("CI", …), or null: the opt-outs, GITHUB_ACTIONS, CI. */
export function automaticOff(env = process.env) {
  const own = optedOut(env);
  if (own) return own;
  if (set(env.GITHUB_ACTIONS)) return "GITHUB_ACTIONS";
  if (set(env.CI)) return "CI";
  return null;
}

/** ~/.config/203c/updates.json (XDG_CONFIG_HOME respected), beside the sign-in: only versions, commits and times. */
export function stateFile(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "203c", "updates.json");
}

export function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeState(file, state, now) {
  try {
    // Answers about commits older than a week are dropped (a project moved on, or was deleted).
    const hal = Object.fromEntries(Object.entries(state.hal ?? {}).filter(([, v]) => v && now - (v.checked_at ?? 0) < 7 * DAY_MS));
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const fresh = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(fresh, JSON.stringify({...state, hal}, null, 1) + "\n", {mode: 0o600});
    fs.renameSync(fresh, file);
  } catch { /* a read-only home: asked again next time */ }
}

// ---------------------------------------------------------------------------------------------
// The project's CardenzaHAL submodule

function git(args, cwd) {
  const run = spawnSync("git", args, {cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  return run.status === 0 ? (run.stdout ?? "").trim() : null;
}
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (dir, p) => { const r = path.relative(dir, p); return !r.startsWith("..") && !path.isAbsolute(r); };
const quoted = p => /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `"${p}"`;

/** owner/name of a GitHub repository's URL (https, ssh, scp-like), or null. */
export function githubRepo(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The CardenzaHAL a project has as a git submodule (the template's components/CardenzaHAL, CardenzaSynth's
 * Devices/Cardenza/CardenzaHAL: whichever submodule of the repository holds cardenzaHAL.h), checked out:
 * {top, path, dir, url, repo, commit}, or null (not in a git repository, no such submodule, not checked out).
 */
export function findHalSubmodule(from) {
  const top = git(["rev-parse", "--show-toplevel"], from);
  if (!top || !fs.existsSync(path.join(top, ".gitmodules"))) return null;
  const listed = git(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"], top);
  if (!listed) return null;
  const modules = {};
  for (const line of listed.split("\n")) {
    const m = /^submodule\.(.+)\.(path|url)\s+(.+)$/.exec(line.trim());
    if (m) (modules[m[1]] ??= {})[m[2]] = m[3];
  }
  const here = real(from);
  const found = Object.values(modules).filter(m => m.path && fs.existsSync(path.join(top, m.path, "cardenzaHAL.h")));
  // Several (rare): the one inside the folder asked about first.
  const outside = m => Number(!inside(here, real(path.join(top, m.path))));
  found.sort((a, b) => outside(a) - outside(b));
  for (const module of found) {
    const dir = path.join(top, module.path);
    // Its own checkout (an empty folder would answer for the project's repository).
    const own = git(["rev-parse", "--show-toplevel"], dir);
    if (!own || real(own) !== real(dir)) continue;
    const commit = git(["rev-parse", "HEAD"], dir);
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) continue;
    return {top, path: module.path, dir, url: module.url ?? null, repo: githubRepo(module.url), commit};
  }
  return null;
}

// The HAL's own check of a consumer copy (tools/check_submodule.py: local changes, a commit upstream main does not have),
// run as it is: its first lines, or null when it passes, is not there or does not run.
function localCheck(hal, {timeout, env}) {
  const script = path.join(hal.dir, "tools", "check_submodule.py");
  if (!fs.existsSync(script)) return Promise.resolve(null);
  const python = env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  return new Promise(resolve => {
    let child, err = "";
    try { child = spawn(python, [script], {stdio: ["ignore", "ignore", "pipe"], timeout, windowsHide: true, env: {...env, GIT_TERMINAL_PROMPT: "0"}}); }
    catch { resolve(null); return; }
    child.stderr.on("data", chunk => { if (err.length < 4000) err += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", code => {
      if (code === 0 || code === null || !err.trim()) return resolve(null);
      // Its explanation and what to run (its first three lines; the files it lists after them are left out).
      const lines = err.trim().split(/\r?\n/).slice(0, 3).map(l => l.trim());
      const text = lines.join(" ").replace(/^check_submodule:\s*/, "").replace(/\s+/g, " ");
      resolve({text, not_on_main: /not on upstream main/.test(text), fix: lines.find(l => /^git -C /.test(l)) ?? null});
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The checks

async function getJson(url, {fetch, signal, headers = {}}) {
  const response = await fetch(url, {signal, headers: {Accept: "application/json", "User-Agent": "203c/" + CLI_VERSION, ...headers}});
  if (!response.ok) { const error = new Error("HTTP " + response.status); error.status = response.status; throw error; }
  return await response.json();
}

/**
 * Both checks: {cli, hal, notices}. cli {current, latest, outdated, checked: "now" | "cached" | "failed"}; hal (null without a
 * CardenzaHAL submodule) {path, commit, repo, status, behind, checked, local}; notices: the lines to show.
 * fresh: ask the network now (doctor, `updates`), else at most once a day. Never throws.
 */
export async function checkUpdates({from = process.cwd(), fresh = false, env = process.env, fetch = globalThis.fetch, now = Date.now(),
  file = stateFile(env), timeout = TIMEOUT_MS, current = CLI_VERSION, cwd = process.cwd(), hal: wantHal = true} = {}) {
  // cwd: where the commands in the notices are typed (null: from the repository's top, as for a build's folder).
  const state = readState(file);
  const signal = AbortSignal.timeout(timeout);
  const registry = String(env.C203_NPM_REGISTRY || NPM_REGISTRY).replace(/\/+$/, "");
  const github = String(env.C203_GITHUB_API || GITHUB_API).replace(/\/+$/, "");
  let changed = false;
  const due = entry => fresh || !entry || typeof entry.checked_at !== "number" || now - entry.checked_at >= DAY_MS || entry.checked_at > now;

  const cliCheck = (async () => {
    const saved = state.cli;
    if (!due(saved)) return {latest: saved.latest ?? null, checked: "cached"};
    try {
      const latest = (await getJson(`${registry}/203c/latest`, {fetch, signal})).version;
      if (typeof latest !== "string" || compareVersions(latest, "0.0.0") === null) throw new Error("no version");
      state.cli = {latest, checked_at: now}; changed = true;
      return {latest, checked: "now"};
    } catch {
      // Written down too: offline, the next commands do not each wait for the network again today.
      state.cli = {latest: saved?.latest ?? null, checked_at: now, failed: true}; changed = true;
      return {latest: saved?.latest ?? null, checked: "failed"};
    }
  })();

  let hal = null;
  try { hal = wantHal ? findHalSubmodule(from) : null; } catch { hal = null; }
  const halCheck = (async () => {
    if (!hal || !hal.repo) return null;
    const key = `${hal.repo}@${hal.commit}`;
    const saved = state.hal?.[key];
    if (!due(saved)) return {status: saved.status ?? null, behind: saved.behind ?? null, checked: "cached"};
    try {
      // Page 2 of one commit a page: the counts without the commits' files (page 1 carries them, megabytes).
      const answer = await getJson(`${github}/repos/${hal.repo}/compare/${hal.commit}...main?per_page=1&page=2`,
        {fetch, signal, headers: {Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}});
      // base...head: ahead_by is what main has that this commit has not (how far behind it is).
      const status = typeof answer.status === "string" ? answer.status : null;
      const behind = Number.isInteger(answer.ahead_by) ? answer.ahead_by : null;
      (state.hal ??= {})[key] = {status, behind, checked_at: now}; changed = true;
      return {status, behind, checked: "now"};
    } catch (error) {
      // 404: GitHub does not have the commit (a local one: check_submodule.py says so). 403 / 429: rate limited.
      const status = error.status === 404 ? "unknown" : saved?.status ?? null;
      (state.hal ??= {})[key] = {status, behind: error.status === 404 ? null : saved?.behind ?? null, checked_at: now, failed: true}; changed = true;
      return {status, behind: null, checked: "failed"};
    }
  })();
  const local = hal ? localCheck(hal, {timeout, env}) : Promise.resolve(null);

  const [c, h, l] = await Promise.all([cliCheck, halCheck, local]);
  if (changed) writeState(file, state, now);

  // Each notice: {code, notice (the line shown), message and hint (doctor's words), next (the commands)}.
  const items = [];
  const say = (code, notice, {message = notice, hint = null, next = []} = {}) => items.push({code, notice, message, ...(hint ? {hint} : {}), next});
  const outdated = !!c.latest && compareVersions(current, c.latest) === -1;
  const cli = {current, latest: c.latest, outdated, checked: c.checked};
  if (outdated) {
    say("cli_outdated", `203c ${c.latest} is out (you have ${current}): ${UPDATE_CLI}`, {message: `203c ${c.latest} is out (you have ${current})`,
      hint: "Update the command, then its Agent Skill", next: ["npm install -g 203c", "203c skill install"]});
  }
  let halOut = null;
  if (hal) {
    // The path to type: from here when here is in the repository, else (a build's folder too: cwd null) from its top,
    // the .gitmodules path, with git -C to it when here is elsewhere.
    const slash = p => p.split(path.sep).join("/");
    const fromTop = !cwd || !inside(real(hal.top), real(cwd));
    const shown = fromTop ? hal.path : slash(path.relative(cwd, hal.dir)) || ".";
    const q = quoted(shown);
    const gitC = !cwd || !fromTop ? "git" : `git -C ${quoted(slash(path.relative(cwd, hal.top)) || ".")}`;
    const onMain = h && ["identical", "ahead"].includes(h.status);
    // check_submodule.py looks at the submodule's own origin/main, which a shallow clone may lack: GitHub knows better.
    const localText = l && !(l.not_on_main && onMain) ? l.text : null;
    halOut = {path: shown, dir: hal.dir, commit: hal.commit, repo: hal.repo, status: h?.status ?? null, behind: h?.behind ?? null,
      checked: h?.checked ?? (hal.repo ? "failed" : "skipped"), local: localText};
    if (h?.status === "ahead" && h.behind > 0) {
      const behind = `CardenzaHAL in this project (${q}) is ${h.behind} commit${h.behind === 1 ? "" : "s"} behind its main`;
      say("hal_behind", `${behind}: ${gitC} submodule update --remote ${q}, build and test, then commit the new pointer (${gitC} add ${q})`,
        {message: behind, hint: "Update it, build and test, then commit the new pointer", next: [`${gitC} submodule update --remote ${q}`, `${gitC} add ${q}`]});
    }
    if (localText) say("hal_not_clean", `CardenzaHAL in this project (${q}) is not a clean copy of upstream main: ${localText}`, {next: l.fix ? [l.fix] : []});
    else if (["behind", "diverged"].includes(h?.status) && !l?.not_on_main) {
      // GitHub says so where check_submodule.py did not run (no Python) or did not see it.
      say("hal_off_main", `CardenzaHAL in this project (${q}) is on ${hal.commit.slice(0, 7)}, a commit its main does not have: ` +
        "change the HAL in its own clone, push it to its main, then point the submodule at main");
    }
  }
  return {cli, hal: halOut, notices: items.map(i => i.notice), items};
}

/**
 * The notices of a command, asked in the background: start() when the command starts, then show() when it ends (waits
 * at most until TIMEOUT_MS + a little after the start, then writes each notice on stderr). Nothing when automaticOff.
 */
export function startNotices({from, env = process.env, write = text => process.stderr.write(text), ...rest} = {}) {
  if (automaticOff(env)) return {show: async () => []};
  const started = Date.now();
  const pending = checkUpdates({from, env, ...rest}).catch(() => null);
  return {
    async show() {
      let timer;
      const wait = new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, started + (rest.timeout ?? TIMEOUT_MS) + GRACE_MS - Date.now())); });
      const result = await Promise.race([pending, wait]);
      clearTimeout(timer);
      const lines = result?.notices ?? [];
      for (const line of lines) write("203c: " + line + "\n");
      return lines;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 203c updates [--project DIR] [--quiet]

export async function updatesCommand(ctx) {
  const o = ctx.flags;
  const from = typeof o.project === "string" ? path.resolve(ctx.cwd, o.project) : ctx.cwd;
  // --quiet is for scripts and builds (CardenzaHAL's CMake): the notices only (nothing when there are none), from the
  // day's answers, and none where nothing is asked by itself (CI, the opt-outs).
  const off = o.quiet ? automaticOff() : null;
  // With --project (a build in its own folder) the commands are written from the project's repository top.
  const result = off ? {cli: null, hal: null, notices: [], off} : await checkUpdates({from, fresh: !o.quiet, cwd: typeof o.project === "string" ? null : ctx.cwd});
  if (o.quiet) return o.json ? {json: result} : result.notices.length ? {json: result, text: result.notices.join("\n")} : undefined;
  const lines = [];
  const {cli, hal, notices} = result;
  const said = notice => lines.push("! " + notice);
  if (cli.outdated) said(notices[0]);
  else if (cli.latest) lines.push(`✓ 203c ${cli.current}${compareVersions(cli.current, cli.latest) === 0 ? " is the newest" : ` (npm's newest is ${cli.latest})`}`);
  else lines.push(`- 203c ${cli.current}: npm did not answer (offline, or blocked here): not checked`);
  if (!hal) lines.push("- CardenzaHAL: no CardenzaHAL submodule in this repository");
  else {
    const halNotices = notices.filter(n => n.startsWith("CardenzaHAL"));
    halNotices.forEach(said);
    const at = `CardenzaHAL (${hal.path}, ${hal.commit.slice(0, 7)})`;
    if (hal.status === "identical" || (hal.status === "ahead" && !hal.behind)) lines.push(`✓ ${at} is at its main`);
    else if (!halNotices.length) {
      lines.push(`- ${at}: ${!hal.repo ? "not on GitHub: not compared" : hal.status === "unknown" ? "GitHub does not have this commit" : "GitHub did not answer (offline, rate limited or blocked here): not checked"}`);
    }
  }
  return {json: result, text: lines.join("\n")};
}
