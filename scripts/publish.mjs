// 203c's guided workflows: doctor, the one-shot idempotent publish (firmware made if needed, cover,
// draft resumed, BINs uploaded, the checks awaited), firmware create / edit / cover with the page's
// quality checks, the page checklist, uploads with --dry-run, init (203.json), fork provenance, source
// archives and the project rules. Everything is
// checked locally first the way the server and its checker will, then the plan is printed (--dry-run
// stops there). Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {ApiError, CLI_VERSION, DEFAULT_API, uploadCover, uploadSource, tokenFile} from "./lib.mjs";
import {PROJECT_FILE, LEGACY_FILE, NAME_RULE, nameOk, checkProject, cloneUrlOf, cmakeProjectName, findProjectFile, gitTagVersion, licenseOf, manifestOf, remotePage,
  versionTxt, writeProject} from "./project.mjs";
import {MAX_ARCHIVE, makeArchive} from "./source.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {skillState} from "./skill.mjs";
import {EMSDK_HINT, describeSim, explainBuild, findHal, findProject, halScript, readSimDir, runBuild, sameBuild, simLine, simState, toolchain,
  uploadSim, waitSim, playUrl} from "./sim.mjs";
import {
  CHANNELS, DEFAULT_TARGET, DEVICES, UF2_DEVICES, FIRMWARE_CATEGORIES, LICENSES, LIMITS, changelogEntry, changelogTop, compareVersions, findAppImages, gitInfo,
  httpsUrl, inspectBin, inspectCover, inspectPack, inspectWork, modelType, nearest, nextVersion, normalizeChannel, normalizeCode, normalizeTags,
  isPlaceholder, resolveCommit, sha256, shorten, size, summaryRepeatsName, versionLabel, versionsDisagree,
} from "./checks.mjs";

const enc = encodeURIComponent;
const SEVERITY = [EXIT.signin, EXIT.later, EXIT.usage, EXIT.refused, EXIT.rejected, EXIT.confirm];

// ---------------------------------------------------------------------------------------------
// A report: problems (stop), warnings (go on), the plan; printed for --dry-run, thrown otherwise.

function newReport(ctx) {
  const r = {problems: [], warnings: [], plan: [], notes: ctx.notes, files: []};
  r.problem = (code, error, extra = {}) => { r.problems.push({code, error, exit: EXIT.refused, ...extra, next: (extra.next ?? []).filter(Boolean)}); };
  r.warn = (code, message, extra = {}) => { r.warnings.push({code, message, ...extra, next: (extra.next ?? []).filter(Boolean)}); };
  r.step = text => r.plan.push(text);
  r.exit = () => {
    const exits = r.problems.map(p => p.exit);
    return SEVERITY.find(e => exits.includes(e)) ?? (exits[0] ?? EXIT.ok);
  };
  // The ones to fix first come first (sign in, then the command, then values; decisions last).
  r.sorted = () => [...r.problems].sort((a, b) => SEVERITY.indexOf(a.exit) - SEVERITY.indexOf(b.exit));
  // A value copied from an example without filling it in.
  r.placeholder = (flag, value) => {
    if (value === undefined || !isPlaceholder(value)) return false;
    r.problem("placeholder", `--${flag} "${value}" is a placeholder from an example, not a real value`, {field: flag, exit: EXIT.usage,
      hint: `Replace it with the real ${flag} (write it from what you know about this firmware; ask the user if you do not know)`});
    return true;
  };
  return r;
}

// A problem that only needs a yes (--yes / --force, or a question on a terminal).
async function decide(ctx, r, {flag, code, error, hint, question}) {
  if (ctx.flags[flag]) return true;
  if (ctx.interactive && !ctx.flags.dry_run) {
    if (await ctx.confirm(`${error}\n${hint ? hint + "\n" : ""}${question ?? "Go on anyway?"}`)) return true;
  }
  r.problem(code, error, {exit: EXIT.confirm, hint: `${hint ? hint.replace(/[.!?]?$/, ". ") : ""}Only if the user wants it: add --${flag}.`, next: [ctx.cmd({add: {[flag]: true}})]});
  return false;
}

function failWith(ctx, r, extra = {}) {
  const problems = r.sorted();
  const first = problems[0];
  throw new CliError(first.code, first.error, {exit: r.exit(), field: first.field, hint: first.hint, next: first.next,
    data: {...(problems.length > 1 ? {problems: problems.map(clean)} : {}), ...extra}});
}
const clean = item => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));

function siteOf(api) {
  const base = String(api).replace(/\/+$/, "");
  return base.endsWith("/api") ? base.slice(0, -4) : new URL(base).origin;
}
const firmwareUrl = (ctx, code) => `${siteOf(ctx.api)}/${code}`;   // a firmware's page is its code
const versionUrl = (ctx, code) => `${siteOf(ctx.api)}/${code}`;     // a version's code: its firmware's page at that version

// A local file: {abs, bytes} or null with a problem (the path as resolved, files that may be meant).
function readLocal(ctx, r, file, {what, flag, base = ctx.cwd, candidates = null, max} = {}) {
  const abs = path.resolve(base, String(file).replace(/^~(?=$|\/)/, os.homedir()));
  let stat;
  try { stat = fs.statSync(abs); } catch {
    const found = candidates ? candidates() : [];
    r.problem("file_not_found", `${what ?? "The file"} ${file} does not exist (looked at ${abs}; the current folder is ${ctx.cwd})`, {field: flag, exit: EXIT.refused,
      hint: found.length ? `Did you mean ${found.map(f => path.relative(ctx.cwd, f.path) || f.path).join(" or ")}? Paths are relative to the current folder.`
        : "Paths are relative to the current folder; give the right path (build the firmware first if it is a BIN).",
      next: found.slice(0, 2).map(f => ctx.cmd({replace: {[flag]: [file, path.relative(ctx.cwd, f.path) || f.path]}}))});
    return null;
  }
  if (stat.isDirectory()) {
    r.problem("wrong_file", `${file} is a folder, not a file`, {field: flag, hint: `Give the file inside it`});
    return null;
  }
  if (max && stat.size > max) {
    r.problem("too_large", `${file} is ${size(stat.size)}: at most ${size(max)}`, {field: flag, hint: "Make it smaller"});
    return null;
  }
  return {abs, bytes: new Uint8Array(fs.readFileSync(abs)), rel: path.relative(ctx.cwd, abs) || abs};
}

async function allPages(ctx, apiPath, query = {}, max = 10) {
  const items = [];
  for (let page = 1; page <= max; page++) {
    const answer = await ctx.client.get(apiPath, {...query, page});
    items.push(...answer.items);
    if (items.length >= answer.total || !answer.items.length) break;
  }
  return items;
}

async function me(ctx, r) {
  if (!ctx.client.token) {
    r.problem("signin_required", "Not signed in", {exit: EXIT.signin, hint: "Sign in first (login opens the browser; no browser here: login --with-token, a personal token, or login --no-browser, a code); " +
      "in GitHub Actions: login --github-oidc --firmware CODE (trusted publishing, no secret: help ci). " +
      "Installing on a device over a USB cable needs none: flash CODE (help devices)",
      next: [ctx.run(["login"]), ctx.run(["login", "--no-browser"])]});
    return null;
  }
  try {
    const account = await ctx.client.get("/me");
    ctx.me = account;
    // A run's trusted-publishing credential (COMMUNITY.md "Trusted publishing"): it publishes one firmware's versions.
    ctx.trusted = trustedOf(account);
    if (account.scopes && !account.scopes.includes("write") && !ctx.trusted) {
      r.problem("forbidden", "This token can only read (it lacks the write scope)", {exit: EXIT.signin,
        hint: "Sign in again and let the user tick write on the approval page", next: [ctx.run(["login"])]});
    }
    return account;
  } catch (error) {
    if (error instanceof ApiError && error.code === "signin_required") {
      const why = ctx.tokenSource === "env" ? "COMMUNITY_TOKEN is not a valid token (deleted on the site, or mistyped)" : "The saved token does not work any more (deleted on the site?)";
      r.problem("signin_required", why, {exit: EXIT.signin, hint: "Sign in again", next: [ctx.run(["login"]), ctx.run(["login", "--no-browser"])]});
      return null;
    }
    throw error;
  }
}

// A trusted-publishing credential (login --github-oidc): {firmware, channel_allowed, expires_at, run}, else null.
export const trustedOf = account => (account?.scopes ?? []).includes("publish") && account.credential?.firmware ? account.credential : null;

// Only the official 203 Launcher is offered (the user, 2026-11-14: the account binding and sign-in live
// in it): a launcher is made or forked by admins only; the API refuses anyone else (403, field kind).
function launcherRefused(ctx, r, account, {fork = null} = {}) {
  if (!account || account.role === "admin") return false;
  r.problem("launcher_official_only", fork ? `${fork} is a launcher: only the official 203 Launcher is offered here, and launchers are forked by admins only`
    : "Only the official 203 Launcher is offered here: launchers are made by the community's admins only", {field: "kind", exit: EXIT.refused,
    hint: "The account binding and sign-in live in the 203 Launcher, so no other launcher is offered. Publish your firmware as an app (leave out --launcher); " +
      "people install it with the 203 Launcher.", next: [fork ? null : ctx.cmd({remove: ["launcher"]}), ctx.run(["help", "launchers"], {json: false})]});
  return true;
}

// The kind of the firmware a code names (a firmware or a version code), or null.
async function kindOf(ctx, code) {
  try { return (await ctx.client.get("/firmware/" + enc(code))).kind ?? null; } catch { /* a version code? */ }
  try { return (await ctx.client.get("/versions/" + enc(code))).firmware?.kind ?? null; } catch { return null; }
}

// Text from --KEY / --KEY-file / a manifest; literal \n become newlines; @FILE reads a file.
function textValue(ctx, r, value, {flag, base = ctx.cwd} = {}) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("@") && value.length > 1) {
    const file = readLocal(ctx, r, value.slice(1), {what: "The file", flag, base});
    return file ? Buffer.from(file.bytes).toString("utf8") : undefined;
  }
  if (!value.includes("\n") && value.includes("\\n")) { ctx.note(`--${flag}: \\n read as line breaks`); return value.replace(/\\n/g, "\n"); }
  return value;
}

// ---------------------------------------------------------------------------------------------
// doctor

export async function doctor(ctx) {
  const r = newReport(ctx);
  const checks = [];
  const check = (name, ok, detail, extra = {}) => checks.push({name, ok, detail, ...extra});
  const node = Number(process.versions.node.split(".")[0]);
  check("node", node >= 18, `Node ${process.versions.node}${node >= 18 ? "" : " (203c needs Node 18 or newer)"}`);
  check("cli", true, `203c ${CLI_VERSION}`);
  // The Agent Skill beside it (npm installs the command only: 203c skill install puts the skill where agents read it).
  const skill = skillState();
  check("skill", skill.ok, skill.detail, {optional: true});
  if (!skill.ok) r.warn("skill_missing", `The Agent Skill is ${/not installed/.test(skill.detail) ? "not installed" : "older than this 203c"}: coding agents read the rules from it`,
    {next: [ctx.run(["skill", "install"])]});
  let info = null;
  try { info = await ctx.client.request("GET", "/", {auth: false}); }
  catch (error) {
    r.problem("unreachable", `The API at ${ctx.api} does not answer (${error.message})`, {exit: EXIT.later,
      hint: `Check the network; --api URL or COMMUNITY_API sets the address (default ${DEFAULT_API})`, next: [ctx.cmd({})]});
  }
  if (info) check("api", info.version === 2, `${ctx.api}: API version ${info.version}${info.version === 2 ? "" : " (203c speaks version 2: update the skill)"}`);
  const limits = {...LIMITS, ...(info?.limits ?? {})};
  const masked = ctx.client.token ? ctx.client.token.slice(0, 4) + "…" + ctx.client.token.slice(-4) : null;
  check("token", !!ctx.client.token, ctx.client.token ? `${masked} from ${{flag: "--token", env: "COMMUNITY_TOKEN", file: ctx.tokenFile}[ctx.tokenSource]}` : "none (not signed in)");
  if (ctx.tokenSource === "file") {
    try {
      const mode = fs.statSync(ctx.tokenFile).mode & 0o777;
      if (mode & 0o077) r.warn("token_file_mode", `${ctx.tokenFile} can be read by others (mode ${mode.toString(8)})`, {hint: "Make it private", next: [`chmod 600 ${ctx.tokenFile}`]});
    } catch { /* gone */ }
  }
  let account = null, quotas = null;
  if (info) {
    try { account = await me(ctx, r); }
    catch (error) {
      if (!(error instanceof ApiError) || !(error.status === 0 || error.status >= 500)) throw error;
      r.problem("unavailable", `The API at ${ctx.api} answers, but not for the sign-in (${error.message})`, {exit: EXIT.later, hint: "The service failed for now: run doctor again in a minute",
        next: [ctx.cmd({})]});
    }
    if (account) {
      const c = account.credential;
      check("account", true, `${account.name} (${account.id})${account.role === "admin" ? ", admin" : ""}; signed in as ${c ? `${c.kind} "${c.name}"` : "a token"}; scopes: ${(account.scopes ?? []).join(", ")}`);
      if (ctx.trusted) {
        check("publish", true, `trusted publishing: ${ctx.trusted.firmware}'s versions on ${ctx.trusted.channel_allowed.join(", ")}, until ${ctx.trusted.expires_at} (renewed by 203c in this run)`);
      } else try {
        // GET /me/quotas (exact); the two version limits keep the names doctor answered before.
        const names = {versions_stable_beta: "stable_beta_versions", versions_dev: "dev_versions"};
        quotas = Object.fromEntries((await ctx.client.get("/me/quotas")).items.map(q => [names[q.what] ?? q.what, {used: q.used, limit: q.limit, left: q.left, per: q.per}]));
      } catch {
        try { quotas = await usedToday(ctx, limits); } catch (error) { r.warn("quota_unknown", "Could not count today's uploads: " + error.message); }
      }
    }
  }
  // What building a simulator version needs (publish builds one for a CardenzaHAL firmware).
  const tools = toolchain();
  for (const [name, tool] of Object.entries(tools)) check(name, tool.ok, `${tool.detail} (for simulator versions)`, {optional: true});
  if (!tools.emscripten.ok) r.warn("sim_toolchain", "Emscripten is not installed: publish cannot build simulator versions (Play) of CardenzaHAL firmware here", {hint: EMSDK_HINT});
  if (ctx.pendingLogin) r.warn("login_pending", "A sign-in waits for the user's approval", {hint: `Approve ${ctx.pendingLogin.user_code} at ${ctx.pendingLogin.verify_url}`, next: [ctx.run(["login", "--wait"])]});
  const signedIn = !!account;
  const json = {ok: !r.problems.length, signed_in: signedIn, cli: CLI_VERSION, node: process.versions.node, api: ctx.api, api_version: info?.version ?? null,
    lang: ctx.client.lang, token: {source: ctx.tokenSource, ...(masked ? {masked} : {})},
    me: account ? {id: account.id, name: account.name, role: account.role, scopes: account.scopes, credential: account.credential ?? null} : null,
    quotas, problems: r.problems.map(clean), warnings: r.warnings.map(clean), checks,
    next: r.problems.length ? r.problems[0].next : [ctx.run(["help", "start"])]};
  const lines = checks.map(c => `${c.ok ? "✓" : c.optional ? "-" : "✗"} ${c.name.padEnd(10)} ${c.detail}`);
  if (quotas) {
    lines.push("✓ left     " + Object.entries(quotas).map(([k, v]) => `${k} ${v.left ?? "?"}/${v.limit}${v.estimate ? "*" : ""}`).join(" · "));
    if (Object.values(quotas).some(v => v.estimate)) lines.push("           * estimated from your lists (the API has no quota endpoint yet)");
  }
  for (const p of r.problems) lines.push(`✗ ${p.error}\n    ${p.hint ?? ""}${p.next.length ? "\n    → " + p.next.join("\n    → ") : ""}`);
  for (const w of r.warnings) lines.push(`! ${w.message}${w.hint ? "\n    " + w.hint : ""}${w.next?.length ? "\n    → " + w.next.join("\n    → ") : ""}`);
  lines.push(r.problems.length ? "" : `Ready. What next: ${ctx.run(["help", "start"], {json: false})}`);
  return {json, text: lines.join("\n").trimEnd(), exit: r.exit()};
}

// What is left of today's limits: exact where the lists say when things were made, else estimated.
async function usedToday(ctx, limits) {
  const since = Date.now() - 24 * 3600 * 1000;
  const recent = items => items.filter(item => Date.parse(item.created ?? item.published ?? 0) > since).length;
  const mine = await allPages(ctx, "/me/firmware", {}, 3);
  let stableBeta = 0, dev = 0;
  for (const fw of mine.filter(f => !f.official)) {
    const versions = (await ctx.client.get(`/firmware/${enc(fw.code)}/versions`)).items;
    for (const v of versions) {
      // A version counts from when it was made; published ones say when they were published, drafts and
      // versions being checked or sent back are counted as made today (an estimate).
      const today = v.published ? Date.parse(v.published) > since : true;
      if (today) { if (v.channel === "dev") dev++; else stableBeta++; }
    }
  }
  const count = async what => recent((await ctx.client.get("/me/" + what)).items);
  const q = (used, limit, estimate = false) => ({used, limit, left: Math.max(0, limit - used), ...(estimate ? {estimate: true} : {})});
  return {
    firmware: q(mine.length, limits.firmware_per_account ?? 50),
    stable_beta_versions: q(stableBeta, limits.versions_per_day?.stable_beta ?? 30, true),
    dev_versions: q(dev, limits.versions_per_day?.dev ?? 300, true),
    works: q(await count("works"), limits.works_per_day ?? 20),
    sounds: q(await count("sounds"), limits.sounds_per_day ?? 20),
    projects: q(await count("projects"), limits.projects_per_day ?? 20),
  };
}

// ---------------------------------------------------------------------------------------------
// The project file: 203.json (COMMUNITY.md "The project file 203.json"; project.mjs), or the earlier
// 203c.json. {data (publish's keys), project (203.json as written), dir, file, legacy}.

const MANIFEST_KEYS = ["firmware", "name", "summary", "description", "description_file", "tags", "source_url", "clone_url", "cover", "channel", "version",
  "notes", "notes_file", "bins", "bin", "notices", "commit", "private", "launcher", "project", "sim", "license", "$schema", "comment"];

function loadManifest(ctx) {
  const given = typeof ctx.flags.manifest === "string";
  let found;
  if (given) {
    const file = path.resolve(ctx.cwd, ctx.flags.manifest);
    if (!fs.existsSync(file)) {
      throw new CliError("file_not_found", `The project file ${ctx.flags.manifest} does not exist (looked at ${file})`, {exit: EXIT.usage, field: "manifest",
        hint: "Leave --manifest out to use ./203.json, or write one: init", next: [ctx.run(["init"])]});
    }
    found = {file, dir: path.dirname(file), legacy: path.basename(file) === LEGACY_FILE};
  } else found = findProjectFile(ctx.cwd);
  if (!found) return {data: {}, project: null, dir: ctx.cwd, file: null, legacy: false};
  const name = path.relative(ctx.cwd, found.file) || found.file;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(found.file, "utf8")); } catch (error) {
    throw new CliError("invalid", `${name} is not valid JSON: ${error.message}`, {exit: EXIT.usage, field: "manifest",
      hint: "Fix the JSON (no comments, no trailing commas): help manifest", next: [ctx.run(["help", "manifest"], {json: false})]});
  }
  if (found.legacy) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliError("invalid", "203c.json is a JSON object", {exit: EXIT.usage, field: "manifest"});
    if ("password" in raw || "token" in raw) {
      throw new CliError("invalid", `${name} holds a ${"password" in raw ? "password" : "token"}: never keep secrets in it`, {exit: EXIT.usage, field: "manifest",
        hint: "Remove it from the file; give --password on the command line (or COMMUNITY_TOKEN for the token)"});
    }
    for (const key of Object.keys(raw)) {
      if (!MANIFEST_KEYS.includes(key)) {
        const guess = nearest(key, MANIFEST_KEYS) ?? nearest(key.replace(/-/g, "_"), MANIFEST_KEYS);
        throw new CliError("usage", `${path.basename(found.file)}: unknown key "${key}"${guess ? ` (did you mean "${guess}"?)` : ""}`, {exit: EXIT.usage, field: "manifest",
          hint: "Keys: " + MANIFEST_KEYS.filter(k => !k.startsWith("$") && k !== "comment").join(", "), next: [ctx.run(["help", "manifest"], {json: false})]});
      }
    }
    ctx.note(`read ${name} (the earlier project file; ${ctx.run(["init"], {json: false})} writes 203.json from it)`);
    return {data: raw, project: null, dir: found.dir, file: found.file, legacy: true};
  }
  const problems = checkProject(raw);
  if (problems.length) {
    const first = problems[0];
    throw new CliError(/secret/.test(first.error) ? "invalid" : "usage", first.error, {exit: EXIT.usage, field: "manifest", hint: first.hint ?? "help manifest",
      next: [ctx.run(["help", "manifest"], {json: false})], data: problems.length > 1 ? {problems} : {}});
  }
  ctx.note(`read ${name}`);
  return {data: manifestOf(raw), project: raw, dir: found.dir, file: found.file, legacy: false};
}

// Writes what publish learnt back into the project file: the firmware's code (after the first publish,
// or a fork made for it), what it was made from, its name when a fork had to be renamed.
function saveManifest(ctx, manifest, changes) {
  if (!manifest.file) return;
  try {
    if (manifest.legacy) {
      if (!changes.code || manifest.data.firmware) return;
      const data = {firmware: changes.code, ...JSON.parse(fs.readFileSync(manifest.file, "utf8"))};
      fs.writeFileSync(manifest.file, JSON.stringify(data, null, 2) + "\n");
      ctx.note(`saved "firmware": "${changes.code}" in ${path.basename(manifest.file)} (the next publish goes to it)`);
      return;
    }
    const data = JSON.parse(fs.readFileSync(manifest.file, "utf8"));
    const said = [];
    if (changes.code && data.code !== changes.code) { data.code = changes.code; said.push(`"code": "${changes.code}"`); }
    if (changes.forked_from !== undefined && JSON.stringify(data.forked_from ?? null) !== JSON.stringify(changes.forked_from)) {
      data.forked_from = changes.forked_from; said.push(`"forked_from": ${JSON.stringify(changes.forked_from)}`);
    }
    if (changes.name && data.name !== changes.name) { data.name = changes.name; said.push(`"name": "${changes.name}"`); }
    if (changes.author && (!data.author || (changes.fork && data.author !== changes.author))) { data.author = changes.author; said.push(`"author": "${changes.author}"`); }
    if (!said.length) return;
    writeProject(manifest.file, data);
    ctx.note(`saved ${said.join(", ")} in ${path.basename(manifest.file)}: commit it with the source`);
  } catch (error) { ctx.note(`could not write ${manifest.file}: ${error.message}`); }
}

// ---------------------------------------------------------------------------------------------
// The firmware's page fields (create, edit, publish): checked locally.

function pageFields(ctx, r, src, {creating, name, base}) {
  const body = {};
  const value = key => src[key];
  for (const key of ["name", "summary", "description"]) r.placeholder(key, value(key));
  if (value("name") !== undefined) {
    const text = String(value("name")).trim();
    if (!text || text.length > 64) r.problem("invalid", `The name is ${text.length} characters: 1-64`, {field: "name", exit: EXIT.usage, hint: "A short name, e.g. CardenzaSynth"});
    // The community's firmware names (COMMUNITY.md "Firmware names"; the API: 400 invalid_name); a name the
    // firmware has already passes unchanged.
    else if (!nameOk(text) && (creating || text !== name)) {
      r.problem("invalid_name", `"${text.slice(0, 60)}" is not a firmware name the community takes`, {field: "name", exit: EXIT.refused, hint: "A firmware's name is " + NAME_RULE});
    }
    body.name = text;
  }
  const summary = value("summary");
  if (summary !== undefined) {
    const text = String(summary).replace(/\s+/g, " ").trim();
    if (!text) r.problem("invalid", "The summary is empty", {field: "summary", exit: EXIT.usage, hint: "One line (≤ 100 characters) saying what it does"});
    else if (text.length > LIMITS.text.summary) {
      const short = shorten(text, LIMITS.text.summary);
      r.problem("invalid", `The summary is ${text.length} characters: at most ${LIMITS.text.summary} (it is the cover blurb on the firmware's card)`, {field: "summary",
        hint: `Shorten it; this fits (${short.length}): "${short}". The long text belongs in --description.`, next: [ctx.cmd({set: {summary: short}})]});
    }
    body.summary = text;
  } else if (creating) {
    r.problem("usage", "A new firmware needs --summary: one line (≤ 100 characters) saying what it does", {field: "summary", exit: EXIT.usage,
      hint: `e.g. --summary "Four-track groovebox: drums, Juno, DX7 and a sampler" (or "summary" in 203.json); write it from what the firmware does, or ask the user`,
      next: [ctx.cmd({add: {summary: "<one line: what it does>"}})]});
  }
  const finalName = body.name ?? name;
  if (body.summary && finalName && summaryRepeatsName(body.summary, finalName) && !ctx.flags.force) {
    r.problem("needs_force", `The summary "${body.summary}" only repeats the name: people see it under the name on every card`, {exit: EXIT.confirm, field: "summary",
      hint: `Say what it does, e.g. --summary "Four-track groovebox: drums, Juno, DX7 and a sampler" (or add --force to keep it)`, next: [ctx.cmd({add: {force: true}})]});
  }
  let description = value("description");
  const descriptionFile = value("description_file");
  if (descriptionFile !== undefined) {
    const file = readLocal(ctx, r, descriptionFile, {what: "The description file", flag: ctx.flags.description_file !== undefined ? "description-file" : "description_file", base});
    if (file) description = Buffer.from(file.bytes).toString("utf8");
  } else description = textValue(ctx, r, description, {flag: "description", base});
  if (description !== undefined) {
    if (description.length > LIMITS.text.description) r.problem("invalid", `The description is ${description.length} characters: at most 20000`, {field: "description"});
    body.description = description;
  }
  if (value("tags") !== undefined) {
    const tags = normalizeTags(value("tags"), LIMITS.tags.firmware);
    if (tags.error) r.problem("invalid", tags.error, {field: "tags", exit: EXIT.usage, hint: tags.hint, next: tags.fixed ? [ctx.cmd({set: {tags: tags.fixed.join(",")}})] : []});
    else body.tags = tags.tags;
  }
  for (const [key, flag] of [["source_url", "source-url"], ["clone_url", "clone-url"]]) {
    const url = value(key);
    if (url === undefined) continue;
    if (url === "" || url === null) { body[key] = ""; continue; }
    if (r.placeholder(flag, url)) continue;
    const fixed = /^http:\/\//.test(url) ? url.replace(/^http:/, "https:") : !/^\w+:\/\//.test(url) && /^[\w.-]+\.\w+\//.test(url) ? "https://" + url : null;
    if (!httpsUrl(url) || (key === "clone_url" && !/\.git$/.test(url))) {
      const better = key === "clone_url" && httpsUrl(fixed ?? url) && !/\.git$/.test(fixed ?? url) ? (fixed ?? url).replace(/\/$/, "") + ".git" : fixed;
      r.problem("invalid", `--${flag} ${url} is not ${key === "clone_url" ? "an https link ending in .git" : "an https link"}`, {field: key, exit: EXIT.usage,
        hint: key === "clone_url" ? "e.g. https://github.com/you/repo.git" : "e.g. https://github.com/you/repo", next: better ? [ctx.cmd({set: {[flag]: better}})] : []});
    }
    body[key] = url;
  }
  const license = value("license");
  if (license !== undefined && license !== null) {
    const text = String(license).trim();
    if (text && (text.length > 64 || !/^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$/.test(text))) {
      r.problem("invalid", `"${text}" is not a licence identifier`, {field: "license", exit: EXIT.usage,
        hint: "An SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, BSD-3-Clause, …) or proprietary"});
    } else body.license = text || null;
  }
  return body;
}

function privacy(ctx, r, src, {creating, firmware}) {
  const body = {};
  if (src.private && src.public) r.problem("usage", "--private and --public together", {exit: EXIT.usage, hint: "Choose one"});
  if (src.private) {
    body.visibility = "private";
    if (typeof src.password === "string") {
      if (/^<.*>$/.test(src.password)) r.problem("placeholder", "--password is a placeholder: give the real password", {field: "password", exit: EXIT.usage});
      else if (src.password.length < 8 || src.password.length > 64) r.problem("invalid", "The password is 8-64 characters", {field: "password", exit: EXIT.usage});
      body.password = src.password;
    } else if (!firmware?.password) {
      r.problem("usage", "A private firmware needs a password (8-64 characters): people need it to download", {field: "password", exit: EXIT.usage,
        hint: "Add --password and tell it only to those who may download it (or leave --private out to publish it publicly)",
        next: [ctx.cmd({add: {password: "<password>"}}), ctx.cmd({remove: ["private"]})]});
    }
  } else if (typeof src.password === "string" && !creating) body.password = src.password;
  else if (typeof src.password === "string") r.problem("usage", "--password is only for a private firmware", {exit: EXIT.usage, hint: "Add --private, or leave --password out",
    next: [ctx.cmd({add: {private: true}})]});
  if (src.public) body.visibility = "public";
  if (creating && !body.visibility) body.visibility = "public";
  return body;
}

function pageWarnings(ctx, r, fw, planned, code, {brief = false, original = null} = {}) {
  const git = gitInfo(ctx.cwd);
  if (brief) {
    // A firmware that exists: one line, the checklist has the commands.
    const has = key => (planned[key] !== undefined && planned[key] !== "") || (fw[key] && (!Array.isArray(fw[key]) || fw[key].length));
    const lacks = [[fw.inherited_cover ? "a cover of its own" : "a cover", !planned.cover && !fw.cover], ["a source link", !has("source_url")], ["a description", !has("description")],
      ["a category tag", !(planned.tags ?? fw.tags ?? []).some(t => FIRMWARE_CATEGORIES.includes(t))]].filter(([, missing]) => missing).map(([what]) => what);
    if (lacks.length) r.warn("page_incomplete", `${fw.name}'s page lacks ${lacks.join(", ")}`, {hint: "The checklist gives the command for each", next: [ctx.run(["firmware", "checklist", code])]});
    return;
  }
  const has = key => (planned[key] !== undefined && planned[key] !== "") || (fw && fw[key] && (!Array.isArray(fw[key]) || fw[key].length));
  const ref = code ?? "CODE";
  if (!has("source_url")) {
    r.warn("no_source", "No source link: people cannot see or build the code", {hint: "Add the repository's https link",
      next: [code ? ctx.run(["firmware", "edit", ref, "--source-url", git?.source_url ?? "<https link to the source>"]) : ctx.cmd({add: {source_url: git?.source_url ?? "<https link to the source>"}})]});
  }
  if (!has("description")) r.warn("no_description", "No description: the page only shows the summary", {hint: "What it is, how to use it, the keys (Markdown): --description-file docs/page.md"});
  if (!has("tags") || !(planned.tags ?? fw?.tags ?? []).some(t => FIRMWARE_CATEGORIES.includes(t))) {
    r.warn("no_category", "No category tag: it is not listed under a category", {hint: "Add one of " + FIRMWARE_CATEGORIES.join(", ") + " (e.g. --tags groovebox,synth)"});
  }
  // The cover (COMMUNITY.md "Covers"): none of its own: a fork shows its original's (with the Fork badge), else the
  // screen after boot, else the grey default; a stable version needs one of them.
  const inherits = fw?.inherited_cover ?? (!fw && (original?.cover || original?.inherited_cover) ? {from: {name: original.name}} : null);
  if (!planned.cover && !fw?.cover) {
    r.warn("no_cover", inherits ? `No cover of its own: it shows ${inherits.from?.name ?? "its original"}'s, marked Fork` : fw?.screen
      ? "No cover picture: the card shows the screen after boot" : "No cover: the card and the Launcher's store show the grey default, and a stable version needs one",
    {hint: "A 16:9 PNG/JPEG/WebP (1280x720, ≤ 2 MB): --cover cover.png", next: [code ? ctx.run(["firmware", "cover", ref, "cover.png"]) : ctx.cmd({add: {cover: "cover.png"}})]});
  }
}

// ---------------------------------------------------------------------------------------------
// The cover

async function planCover(ctx, r, file, fw, {base, flag = "cover"} = {}) {
  const local = readLocal(ctx, r, file, {what: "The cover", flag, base});
  if (!local) return null;
  const report = inspectCover(local.bytes, local.rel);
  for (const p of report.problems) r.problem(p.code === "cover.too_large" ? "too_large" : "wrong_file", p.message, {field: flag, hint: p.hint});
  for (const w of report.warnings) r.warn(w.code, w.message, {hint: w.hint});
  if (!report.ok) return null;
  const digest = sha256(local.bytes);
  if (fw?.cover?.sha256) {
    if (fw.cover.sha256 === digest) { ctx.note("the cover is already this picture"); return null; }
  } else if (fw?.cover?.url) {
    try {
      const response = await ctx.client.fetch(fw.cover.url);
      if (response.ok && sha256(new Uint8Array(await response.arrayBuffer())) === digest) { ctx.note("the cover is already this picture"); return null; }
    } catch { /* compare failed: upload it */ }
  }
  return {bytes: local.bytes, mime: report.mime, rel: local.rel, describe: `${local.rel} (${report.width ?? "?"}x${report.height ?? "?"} ${report.mime.split("/")[1].toUpperCase()}, ${size(local.bytes.length)})`};
}

export async function setCover(ctx) {
  const r = newReport(ctx);
  const code = ctx.args.CODE;
  const fw = await firmwareFor(ctx, r, code, {need: "edit"});
  if (ctx.flags.remove) {
    if (!fw && !r.problems.length) return;
    if (r.problems.length) failWith(ctx, r);
    if (ctx.flags.dry_run) return dryOut(ctx, r, {plan: [`remove the cover of ${fw.name} (${code})`]});
    if (!ctx.flags.yes && !(ctx.interactive && await ctx.confirm(`Remove the cover of ${fw.name}?`))) {
      throw new CliError("needs_confirmation", `This removes the cover of ${fw.name} (${code})`, {exit: EXIT.confirm, hint: "Add --yes if the user wants it removed",
        next: [ctx.cmd({add: {yes: true}})]});
    }
    return ctx.op("firmware_cover_delete", {code});
  }
  const image = ctx.args.IMAGE ?? ctx.flags.file;
  if (ctx.args.IMAGE && ctx.flags.file && ctx.args.IMAGE !== ctx.flags.file) throw ctx.usage("Two pictures: give IMAGE or --file, not both");
  if (!image) throw ctx.usage("Give the picture: firmware cover CODE IMAGE (or --file IMAGE; --remove takes the cover away)", {hint: "A 16:9 PNG, JPEG or WebP up to 2 MB, e.g. 1280x720"});
  const cover = await planCover(ctx, r, image, fw, {flag: ctx.args.IMAGE ? "IMAGE" : "file"});
  if (cover) r.step(`set the cover of ${fw?.name ?? code} to ${cover.describe}`);
  if (r.problems.length) return ctx.flags.dry_run ? dryOut(ctx, r) : failWith(ctx, r);
  if (ctx.flags.dry_run) return dryOut(ctx, r);
  if (!cover) return {json: fw, text: `${fw.name} (${code}) already has this cover: ${fw.cover.url}`};
  ctx.say(`Uploading the cover (${size(cover.bytes.length)})…`);
  const updated = await uploadCover(ctx.client, code, cover.bytes, cover.mime);
  return {json: updated, text: `The cover of ${updated.name} (${code}) is set: ${updated.cover?.url}\nPage: ${firmwareUrl(ctx, code)}`};
}

// A fork's default name: "<original> (<you>)", within the 48 characters of a firmware's name (the original's
// name shortened, never the account's).
function forkNameOf(original, account) {
  const tail = ` (${account})`;
  const chars = [...String(original).trim()];
  const room = Math.max(2, 48 - [...tail].length);
  return (chars.length > room ? chars.slice(0, room).join("").trimEnd() : chars.join("")) + tail;
}

// A firmware to change: {fw} or null with a problem (not found, not yours, from the hub).
async function firmwareFor(ctx, r, code, {need = "release"} = {}) {
  try {
    const fw = await ctx.client.get("/firmware/" + enc(code));
    if (!fw.can?.[need]) {
      // A run's trusted-publishing credential (login --github-oidc) publishes versions and nothing else.
      const trusted = ctx.trusted ?? (ctx.client.run ? {firmware: ctx.client.run.firmware} : null);
      if (trusted) {
        r.problem("publish_only", trusted.firmware === fw.code && need !== "release"
          ? `This sign-in (trusted publishing from GitHub Actions) publishes ${fw.code}'s versions only: it does not change the firmware`
          : `This sign-in (trusted publishing from GitHub Actions) publishes ${trusted.firmware} only, not ${fw.code}`, {exit: EXIT.refused,
          hint: "Page edits, covers, channels, other firmware and account actions need the owner's own sign-in (the site, or 203c login on a computer)"});
        return fw;
      }
      if (!fw.owner) {
        r.problem("official_from_hub", `${fw.name} (${code}) is an official firmware from the Launcher hub: ${need === "release" ? "its versions are published by its CI through the hub, not by 203c" : "only admins change it"}`,
          {exit: EXIT.refused, hint: "Publish your own firmware instead (publish --name …), or ask an admin", next: [ctx.run(["firmware", "mine"])]});
      } else {
        r.problem("not_yours", `${fw.name} (${code}) belongs to ${fw.owner.name}, not to you`, {exit: EXIT.refused,
          hint: "Fork it and publish to your fork, or use one of your own firmware",
          next: [ctx.run(["firmware", "fork", code, "--name", "<your fork's name>", "--summary", "<what your fork changes>"]), ctx.run(["firmware", "mine"])]});
      }
      return fw;
    }
    return fw;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "not_found" || error.code === "deleted") {
      let what = null;
      try { what = await ctx.client.get("/codes/" + enc(code)); } catch { /* unknown */ }
      if (what?.kind === "version") {
        r.problem("not_found", `${code} is a version code (of firmware ${what.firmware}), not a firmware code`, {exit: EXIT.usage,
          hint: `Use the firmware's code ${what.firmware}`, next: [ctx.cmd({replace: {CODE: [code, what.firmware], firmware: [code, what.firmware]}})]});
      } else {
        r.problem("not_found", error.code === "deleted" ? `Firmware ${code} was deleted` : `No firmware has the code ${code}`, {exit: EXIT.refused,
          hint: "Never guess a code: list yours", next: [ctx.run(["firmware", "mine"])]});
      }
      return null;
    }
    if (error.code === "password_required") {
      r.problem("not_yours", `${code} is someone else's private firmware`, {hint: "Publish to your own firmware", next: [ctx.run(["firmware", "mine"])]});
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// firmware create / fork / edit

export async function createFirmware(ctx, {fork} = {}) {
  const r = newReport(ctx);
  const o = ctx.flags;
  const body = {...pageFields(ctx, r, o, {creating: true, name: o.name}), ...privacy(ctx, r, o, {creating: true})};
  if (o.beta || o.dev) body.channels = {...(o.beta ? {beta: true} : {}), ...(o.dev ? {dev: true} : {})};
  if (o.launcher) body.kind = "launcher";
  const parent = fork ?? o.fork;
  if (parent) {
    const parsed = normalizeCode(parent);
    if (parsed.error) r.problem("usage", parsed.error, {exit: EXIT.usage, field: "fork", hint: parsed.hint});
    else body.forked_from = parsed.code;
  }
  const account = await me(ctx, r);
  if (body.kind === "launcher") launcherRefused(ctx, r, account);
  else if (body.forked_from && account && account.role !== "admin" && await kindOf(ctx, body.forked_from) === "launcher") launcherRefused(ctx, r, account, {fork: body.forked_from});
  if (account && body.name) await nameCollisions(ctx, r, body.name, account);
  pageWarnings(ctx, r, null, body, null);
  let cover = null;
  if (o.cover) cover = await planCover(ctx, r, o.cover, null);
  r.step(`make the ${body.visibility ?? "public"} firmware "${body.name}"${body.forked_from ? " as a fork of " + body.forked_from : ""}${body.kind === "launcher" ? " (a launcher)" : ""}`);
  if (cover) r.step(`set its cover to ${cover.describe}`);
  if (o.dry_run) return dryOut(ctx, r);
  if (r.problems.length) failWith(ctx, r);
  let fw = await ctx.op("firmware_create", body);
  if (cover) fw = await uploadCover(ctx.client, fw.code, cover.bytes, cover.mime);
  return {json: withAdvice(fw, r), text: `Made ${fw.name}: code ${fw.code}\nPage: ${firmwareUrl(ctx, fw.code)}\n` + adviceText(r) +
    `Publish a version: ${ctx.run(["publish", "--firmware", fw.code, "--bin", "build/app.bin", "--dry-run"], {json: false})}`};
}

// Firmware of this name (GET /firmware/lookup: exact, ignoring case): yours (a re-run?) or someone
// else's (a confusing duplicate).
async function nameCollisions(ctx, r, name, account, {exceptCode, fork = null} = {}) {
  let found = [];
  try { found = (await ctx.client.get("/firmware/lookup", {name: name.slice(0, 64)})).items ?? []; }
  catch { found = []; }   // a courtesy check
  const own = found.filter(f => f.owner?.id === account.id && f.code !== exceptCode);
  if (own.length) {
    r.problem("needs_force", `You already have a firmware named ${own[0].name} (${own[0].code})`, {exit: EXIT.confirm,
      hint: `To publish to it: publish --firmware ${own[0].code}. Only if a second one is really meant: add --force`,
      next: [ctx.run(["publish", "--firmware", own[0].code, "--dry-run"]), ctx.cmd({add: {force: true}})]});
    return;
  }
  const clash = found.find(f => f.owner?.id !== account.id && f.code !== fork);
  if (clash) {
    await decide(ctx, r, {flag: "yes", code: "needs_confirmation",
      error: `${clash.official ? "The official firmware" : clash.owner ? clash.owner.name + "'s firmware" : "A firmware"} ${clash.name} (${clash.code}) has this name already`,
      hint: "Two firmware with one name confuse people: choose another name, or confirm", question: "Use the same name anyway?"});
  }
}

export async function editFirmware(ctx) {
  const r = newReport(ctx);
  const o = ctx.flags, code = ctx.args.CODE;
  const fw = await firmwareFor(ctx, r, code, {need: "edit"});
  const body = {...pageFields(ctx, r, o, {creating: false, name: fw?.name}), ...privacy(ctx, r, o, {creating: false, firmware: fw})};
  const channels = {};
  if (o.beta) channels.beta = true; if (o.no_beta) channels.beta = false;
  if (o.dev) channels.dev = true; if (o.no_dev) channels.dev = false;
  if (Object.keys(channels).length) body.channels = channels;
  let cover = null;
  if (o.cover && fw) cover = await planCover(ctx, r, o.cover, fw);
  if (!Object.keys(body).length && !cover && !r.problems.length) {
    throw ctx.usage("Nothing to change: give the fields to change", {hint: "e.g. --summary, --description-file, --tags, --source-url, --cover, --dev",
      next: [ctx.run(["firmware", "edit", "--help"], {json: false})]});
  }
  if (fw) {
    const changed = Object.keys(body).filter(k => !samePageValue(body[k], fw[k]));
    r.step(changed.length ? `change ${changed.join(", ")} of ${fw.name} (${code})` : `nothing differs on ${fw.name}'s page`);
    if (cover) r.step(`set its cover to ${cover.describe}`);
    pageWarnings(ctx, r, fw, {...body, cover}, code);
  }
  if (o.dry_run) return dryOut(ctx, r);
  if (r.problems.length) failWith(ctx, r);
  let updated = Object.keys(body).length ? await ctx.op("firmware_edit", {code, ...body}) : fw;
  if (cover) updated = await uploadCover(ctx.client, code, cover.bytes, cover.mime);
  return {json: withAdvice(updated, r), text: `Changed ${updated.name} (${code}): ${firmwareUrl(ctx, code)}\n` + adviceText(r).trimEnd()};
}

// A page field as the server keeps it (community_text: CR LF as LF, trimmed; "" and null alike), so a
// description file with a final newline is not an edit on every publish.
const pageText = value => typeof value === "string" ? value.replace(/\r\n/g, "\n").replace(/^[ \n\t]+|[ \n\t]+$/g, "") : value ?? "";
const samePageValue = (mine, theirs) => JSON.stringify(pageText(mine)) === JSON.stringify(pageText(theirs));

// API answers keep their shape; 203c's advice comes as "advice" beside them.
const withAdvice = (value, r) => r.warnings.length ? {...value, advice: r.warnings.map(clean)} : value;
const adviceText = r => r.warnings.length ? "To make the page better:\n" + r.warnings.map(w => `  ! ${w.message}${w.hint ? ": " + w.hint : ""}${w.next?.[0] ? "\n    → " + w.next[0] : ""}`).join("\n") + "\n" : "";

function dryOut(ctx, r, extra = {}) {
  const plan = extra.plan ?? r.plan;
  const ready = !r.problems.length;
  const problems = r.sorted();
  // Not ready: the first problem's command, else the command's help (never an empty next).
  const next = ready ? [ctx.cmd({remove: ["dry-run"]})] : problems[0].next.length ? problems[0].next : [ctx.run([...ctx.words, "--help"])];
  const json = {status: "dry_run", ready, plan, problems: problems.map(clean), warnings: r.warnings.map(clean), notes: ctx.notes, ...(extra.json ?? {}), next};
  const lines = ["Dry run: nothing was changed.", "Plan:", ...plan.map((s, i) => `  ${i + 1}. ${s}`)];
  if (extra.lines) lines.push(...extra.lines);
  if (problems.length) {
    lines.push("Problems (fix these first):");
    for (const p of problems) lines.push(`  ✗ ${p.error}${p.hint ? "\n      " + p.hint : ""}${p.next.length ? "\n      → " + p.next.join("\n      → ") : ""}`);
  }
  if (r.warnings.length) {
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  ! ${w.message}${w.hint ? "\n      " + w.hint : ""}${w.next?.length ? "\n      → " + w.next.join("\n      → ") : ""}`);
  }
  lines.push(ready ? `Ready. Run it:\n  ${ctx.cmd({remove: ["dry-run"]}, {json: false})}` : `Not ready (exit ${r.exit()}).`);
  return {json, text: lines.join("\n"), exit: ready ? EXIT.ok : r.exit()};
}

// ---------------------------------------------------------------------------------------------
// publish

export async function publish(ctx, {mode}) {
  const r = newReport(ctx);
  const o = ctx.flags;
  const manifest = mode === "publish" ? loadManifest(ctx) : {data: {}, dir: ctx.cwd, file: null};
  const m = manifest.data;
  // A value from the flags (paths relative to here) or the manifest (relative to its folder).
  const from = (flag, key = flag) => o[flag] !== undefined ? {value: o[flag], base: ctx.cwd, flag: flag.replace(/_/g, "-")}
    : m[key] !== undefined ? {value: m[key], base: manifest.dir, flag: key} : {value: undefined, base: ctx.cwd, flag: flag.replace(/_/g, "-")};

  // The channel.
  let channel = "stable";
  const channelGiven = from("channel").value;
  if (channelGiven !== undefined) {
    const parsed = normalizeChannel(channelGiven);
    if (parsed.error) r.problem("bad_channel", parsed.error, {field: "channel", exit: EXIT.usage, hint: parsed.hint, next: parsed.suggestion ? [ctx.cmd({set: {channel: parsed.suggestion}})] : []});
    else channel = parsed.channel;
  } else ctx.note("channel stable (the default; --channel dev for CI builds)");

  // The BINs: TARGET=PATH, or PATH for the default device.
  const binSource = o.bin !== undefined ? {list: o.bin, base: ctx.cwd} : m.bins ? {list: Object.entries(m.bins).map(([t, p]) => `${t}=${p}`), base: manifest.dir}
    : m.bin ? {list: [m.bin], base: manifest.dir} : {list: [], base: ctx.cwd};
  const bins = [];
  const knownTargets = await targetsKnown(ctx);
  for (const entry of binSource.list) {
    const text = String(entry);
    const at = text.indexOf("=");
    let target = at > 0 ? text.slice(0, at).trim().toLowerCase() : null;
    const file = at > 0 ? text.slice(at + 1) : text;
    if (target && !knownTargets.includes(target)) {
      const guess = nearest(target, knownTargets);
      r.problem("invalid", `"${text.slice(0, at)}" is not a device`, {field: "bin", exit: EXIT.usage, hint: "Devices: " + knownTargets.join(", ") + " (--bin cardenza=build/app.bin)",
        next: guess ? [ctx.cmd({replace: {bin: [text, `${guess}=${file}`]}})] : []});
      continue;
    }
    if (!file) { r.problem("usage", `--bin ${text} names no file`, {exit: EXIT.usage, field: "bin", hint: "--bin cardenza=build/app.bin"}); continue; }
    const candidates = () => findAppImages([path.dirname(path.resolve(binSource.base, file)), path.join(ctx.cwd, "build"), ctx.cwd]);
    const local = readLocal(ctx, r, file, {what: "The BIN", flag: "bin", base: binSource.base, candidates});
    if (local) bins.push({target, file: text, local});
  }
  if (!binSource.list.length) {
    // One app image under ./build is the one (a clone's own build); several or none: ask.
    const lone = findAppImages([path.join(ctx.cwd, "build")]);
    if (lone.length === 1) {
      const rel = path.relative(ctx.cwd, lone[0].path);
      ctx.note(`--bin ${rel} (the only application image in build/; --bin says another)`);
      const local = readLocal(ctx, r, rel, {what: "The BIN", flag: "bin"});
      if (local) bins.push({target: null, file: rel, local});
      binSource.list.push(rel);
    }
  }
  if (!binSource.list.length) {
    const found = findAppImages([path.join(ctx.cwd, "build"), ctx.cwd]);
    r.problem("usage", "Which BIN? Give --bin with the application image idf.py built", {exit: EXIT.usage, field: "bin",
      hint: found.length ? `Found here: ${found.map(f => path.relative(ctx.cwd, f.path)).join(", ")}` : "Usually build/<project>.bin (not bootloader.bin, not the merged image, not the .elf)",
      next: found.slice(0, 2).map(f => ctx.cmd({add: {bin: path.relative(ctx.cwd, f.path)}}))});
  }

  // Who is publishing, and to which firmware: --firmware, else the firmware this clone is bound to
  // (clone / fork set git config 203c.firmware), else 203c.json's.
  const account = await me(ctx, r);
  const trusted = ctx.trusted ?? null;
  let fw = null, creating = false, fwCode = null;
  const bound = mode === "publish" && o.firmware === undefined && o.name === undefined ? gitConfig(ctx.cwd, "203c.firmware") : null;
  if (bound && m.firmware && normalizeCode(m.firmware).code !== bound) ctx.note(`${path.basename(manifest.file)} says ${m.firmware}; this clone is bound to ${bound} (git config 203c.firmware), which wins`);
  else if (bound) ctx.note(`publishing to ${bound}, the firmware this clone is bound to (git config 203c.firmware)`);
  const firmwareGiven = mode === "versions" ? ctx.args.CODE : bound ?? from("firmware").value;
  const nameGiven = from("name").value;
  // Fork provenance (COMMUNITY.md "Fork provenance"): a project file (or a clone) that names someone
  // else's firmware publishes to a fork of it, made now (or the one you have), recorded in 203.json.
  const fromProject = mode === "publish" && o.firmware === undefined && o.name === undefined && (!!bound || m.firmware !== undefined);
  let forkOf = null;
  if (trusted) {
    // A run's trusted-publishing credential publishes its one firmware: never another, never a new one or a fork.
    const given = firmwareGiven !== undefined ? normalizeCode(firmwareGiven) : null;
    if (given && !given.error && given.code !== trusted.firmware) {
      r.problem("publish_only", `This sign-in (trusted publishing from GitHub Actions) publishes ${trusted.firmware} only, not ${given.code}`, {exit: EXIT.refused, field: "firmware",
        hint: `Sign in for ${given.code} (login --github-oidc --firmware ${given.code}; its owner links this repository first), or publish to ${trusted.firmware}`,
        next: [ctx.run(["login", "--github-oidc", "--firmware", given.code])]});
    } else {
      if (firmwareGiven === undefined) ctx.note(`publishing to ${trusted.firmware}, the firmware this run's trusted-publishing credential is for`);
      fwCode = trusted.firmware;
      fw = await firmwareFor(ctx, r, fwCode);
    }
  } else if (firmwareGiven !== undefined) {
    const parsed = normalizeCode(firmwareGiven);
    if (!parsed.error) {
      fwCode = parsed.code;
      if (account && fromProject) {
        let peek = null;
        try { peek = await ctx.client.get("/firmware/" + enc(fwCode)); } catch (error) { if (!(error instanceof ApiError)) throw error; }
        if (peek && !peek.can?.release) { forkOf = peek; fwCode = null; }
        else fw = await firmwareFor(ctx, r, fwCode);
      } else if (account) fw = await firmwareFor(ctx, r, fwCode);
      if (fw && !fw.can?.release) fw = null;
    } else if (account) {
      // Not a code: a name of one of yours?
      const found = await findMine(ctx, r, firmwareGiven, {flag: "firmware"});
      if (found) { fw = found; fwCode = found.code; }
      else if (!r.problems.length) {
        r.problem("usage", parsed.error + ` (and you have no firmware named "${firmwareGiven}")`, {exit: EXIT.usage, field: "firmware", hint: parsed.hint +
          " To make a new firmware, use --name instead of --firmware.", next: [ctx.cmd({remove: ["firmware"], add: {name: firmwareGiven}}), ctx.run(["firmware", "mine"])]});
      }
    } else r.problem("usage", parsed.error, {exit: EXIT.usage, field: "firmware", hint: parsed.hint});
  } else if (nameGiven !== undefined && account) {
    fw = await findMine(ctx, r, nameGiven, {flag: "name", quiet: true});
    if (fw) { fwCode = fw.code; ctx.note(`publishing to your firmware ${fw.name} (${fw.code})`); }
    else if (!r.problems.length) creating = true;
  } else if (account) {
    const mine = (await allPages(ctx, "/me/firmware", {}, 3)).filter(f => f.can?.release !== false);
    if (ctx.interactive && !o.dry_run && mine.length) {
      const choice = await ctx.choose("Publish to which firmware?", [...mine.map(f => `${f.code}  ${f.name}`), "a new firmware"]);
      if (choice !== null && choice < mine.length) { fwCode = mine[choice].code; fw = await firmwareFor(ctx, r, fwCode); }
    }
    if (!fw) {
      const project = bins[0]?.local ? inspectBin(bins[0].local.bytes, {}).project : null;
      r.problem("usage", "Which firmware? Give --firmware CODE (one of yours) or --name NAME (found, or made when you have none of that name)", {exit: EXIT.usage, field: "firmware",
        hint: mine.length ? "Yours: " + mine.slice(0, 6).map(f => `${f.code} ${f.name}`).join(", ") : "You have no firmware yet: --name makes one (with --summary)",
        next: [...mine.slice(0, 3).map(f => ctx.cmd({add: {firmware: f.code}})),
          ctx.cmd({add: {name: project ?? "<name>", summary: "<one line: what it does>"}})]});
    }
  }
  // A project made from another firmware (203.json forked_from, no code of its own yet): its fork.
  const project = manifest.project;
  if (!trusted && !forkOf && !fw && account && fromProject === false && mode === "publish" && o.firmware === undefined && project?.forked_from?.code && !project.code) {
    try { forkOf = await ctx.client.get("/firmware/" + enc(project.forked_from.code)); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      r.problem("invalid", `203.json's forked_from ${project.forked_from.code} cannot be found (${error.message})`, {field: "forked_from",
        hint: "Check the code (a firmware or version code you can see); private originals need their password"});
    }
    if (forkOf) { creating = false; r.problems = r.problems.filter(p => p.field !== "firmware"); }
  }
  let fork = null;
  if (forkOf) {
    const mine = (await allPages(ctx, "/me/firmware", {}, 3)).filter(f => f.forked_from?.code === forkOf.code);
    const wanted = project?.forked_from?.code === forkOf.code ? project.forked_from.version ?? null : forkOf.latest?.stable?.version ?? null;
    if (mine.length) {
      fw = await ctx.client.get("/firmware/" + enc(mine[0].code));
      fwCode = fw.code;
      fork = {from: {code: forkOf.code, name: forkOf.name}, version: wanted, code: fw.code, made: false,
        why: `${forkOf.name} (${forkOf.code}) is not yours: publishing to your fork of it, ${fw.name} (${fw.code}), made before`};
      ctx.note(fork.why);
    } else {
      creating = true;
      let versionCode = null;
      if (wanted) {
        try { versionCode = (await ctx.client.get(`/firmware/${enc(forkOf.code)}/versions/${enc(wanted)}`)).code; }
        catch { r.warn("fork_version_unknown", `${forkOf.name} has no version ${wanted}: the fork records the firmware without a version`); }
      }
      const baseName = String(nameGiven ?? forkOf.name);
      const forkName = baseName.trim().toLowerCase() === forkOf.name.trim().toLowerCase() ? forkNameOf(baseName, account.name) : baseName;
      fork = {from: {code: forkOf.code, name: forkOf.name}, version: wanted, forked_from: versionCode ?? forkOf.code, name: forkName, made: true,
        why: `${forkOf.name} (${forkOf.code}) is ${forkOf.owner ? forkOf.owner.name + "'s" : "an official firmware"}, not yours: publish makes your fork of it` +
          `${wanted ? " (made from " + wanted + ")" : ""}, named "${forkName}", and writes its code into 203.json`};
      ctx.note(fork.why);
      if (forkOf.kind === "launcher") launcherRefused(ctx, r, account, {fork: forkOf.code});
    }
  }
  // 203.json's author is informational: say so when it is not the account publishing (a fork made now takes yours).
  if (project?.author && account && project.author !== account.name && !fork?.made) {
    r.warn("author_differs", `${path.basename(manifest.file)} says the author is ${project.author}, but this publishes as ${account.name}`, {field: "author",
      hint: `The firmware is the signed-in account's. Write "author": "${account.name}" in ${path.basename(manifest.file)} if that is right, or sign in as ${project.author}`});
  }
  const kind = fw?.kind ?? forkOf?.kind ?? (o.launcher || m.launcher ? "launcher" : "app");
  if (creating && kind === "launcher" && !forkOf) launcherRefused(ctx, r, account);

  // On a terminal, what a new firmware needs is asked for.
  if (creating && ctx.interactive && !o.dry_run && from("summary").value === undefined) {
    const answer = await ctx.ask(`A one-line summary of ${nameGiven} (what it does, ≤ 100 characters):`);
    if (answer?.trim()) o.summary = answer.trim();
  }
  // The page: fields given (a new firmware's, or changes to yours).
  const pageSrc = {};
  for (const key of ["name", "summary", "description", "description_file", "tags", "source_url", "clone_url", "license"]) {
    const got = from(key);
    if (got.value !== undefined && !(key === "name" && fw)) pageSrc[key] = got.value;
  }
  if (fork?.made) {
    pageSrc.name = fork.name;
    if (pageSrc.summary === undefined) pageSrc.summary = shorten(forkOf.summary || `${forkOf.name} with my changes`, 100);
    // The original's repository is not this fork's: only a source of its own (203.json source, flags) is bound.
    if (o.source_url === undefined && o.clone_url === undefined && project?.source && forkOf.source_url === project.source) {
      delete pageSrc.source_url; delete pageSrc.clone_url;
    }
  }
  const page = pageFields(ctx, r, pageSrc, {creating, name: fw?.name ?? nameGiven, base: m && Object.keys(pageSrc).some(k => o[k] === undefined) ? manifest.dir : ctx.cwd});
  const priv = creating ? privacy(ctx, r, {private: o.private ?? m.private, password: o.password}, {creating: true}) : {};
  if (creating && account && page.name) await nameCollisions(ctx, r, page.name, account, {fork: fork?.made ? fork.from.code : null});

  // Channels: a new firmware gets the one it publishes to; yours must have it on.
  if (trusted && !(trusted.channel_allowed ?? []).includes(channel)) {
    r.problem("oidc_channel", `This run may publish on ${(trusted.channel_allowed ?? []).join(", ") || "no channel"}, not ${channel}`, {exit: EXIT.refused, field: "channel",
      hint: "stable needs a run on a tag vX.Y.Z, beta a tag vX.Y.Z-beta.N; anything else publishes dev only (and only on the channels its trusted publisher allows)",
      next: (trusted.channel_allowed ?? []).includes("dev") ? [ctx.cmd({set: {channel: "dev"}})] : []});
  } else if (trusted && fw && channel !== "stable" && !fw.channels?.[channel]) {
    r.problem("channel_off", `The ${channel} channel of ${fw.name} is off, and a trusted-publishing credential does not change the page`, {exit: EXIT.refused, field: "channel",
      hint: `Its owner turns it on once: on the site (the firmware's page › edit), or signed in as the owner: firmware edit ${fwCode} --${channel}`,
      next: [ctx.run(["firmware", "edit", fwCode, "--" + channel])]});
  } else if (fw && channel !== "stable" && !fw.channels?.[channel]) {
    await decide(ctx, r, {flag: "yes", code: "channel_off", error: `The ${channel} channel of ${fw.name} is off`,
      hint: `Publishing turns it on (people who choose ${channel} in the Launcher get these builds).`, question: `Turn the ${channel} channel on?`});
  }

  // Devices of the BINs given without one.
  const defaultTarget = fw?.targets?.length === 1 ? fw.targets[0] : DEFAULT_TARGET;
  for (const bin of bins) if (!bin.target) { bin.target = defaultTarget; ctx.note(`--bin ${bin.file}: for the ${bin.target} (write --bin ${bin.target}=${bin.file} to say it)`); }
  const seen = new Set();
  for (const bin of bins) {
    if (seen.has(bin.target)) r.problem("usage", `Two BINs for the ${bin.target}`, {exit: EXIT.usage, field: "bin", hint: "One BIN per device: --bin cardenza=a.bin --bin nullperator=b.bin"});
    seen.add(bin.target);
  }

  // Each BIN as the upload and the checker will see it (a download-only device's: its UF2 file).
  const deviceInfo = bins.length ? await targetsInfo(ctx) : {};
  for (const bin of bins) {
    bin.report = inspectBin(bin.local.bytes, {target: bin.target, firmwareKind: kind, file: bin.local.rel, device: deviceInfo[bin.target] ?? null});
    for (const p of bin.report.problems) {
      // A download-only device takes a .uf2: the ESP app images found here are no answer for it.
      const uf2Device = deviceInfo[bin.target]?.format === "uf2" || UF2_DEVICES[bin.target];
      const found = p.code === "bin.too_large_for_device" || p.code === "bin.too_large" || uf2Device ? [] :
        findAppImages([path.dirname(bin.local.abs), path.join(ctx.cwd, "build"), ctx.cwd]).filter(f => f.path !== bin.local.abs);
      r.problem(p.code === "bin.too_large_for_device" || p.code === "bin.too_large" ? "too_large" : "wrong_file", p.message, {field: "bin",
        hint: p.hint + (found.length ? `. Found: ${found.map(f => path.relative(ctx.cwd, f.path)).join(", ")}` : ""),
        next: found.slice(0, 1).map(f => ctx.cmd({replace: {bin: [bin.file, (bin.file.includes("=") ? bin.target + "=" : "") + path.relative(ctx.cwd, f.path)]}}))});
    }
    for (const w of bin.report.warnings) r.warn(w.code, w.message, {hint: w.hint});
  }

  // The version label: given (a flag, 203.json), else version.txt, else the BIN's own version.
  let label = null;
  let versionGiven = from("version").value;
  const txt = mode === "publish" ? versionTxt(manifest.dir) : null;
  if (txt && o.version === undefined && m.version !== undefined && String(m.version) !== txt.value) {
    r.problem("bad_version", `203.json says version ${m.version} but ${txt.file} says ${txt.value}`, {field: "version", exit: EXIT.usage,
      hint: `${txt.file} is the version when there is one: remove "version" from 203.json, or make the two agree`});
  }
  if (versionGiven === undefined && txt) { versionGiven = txt.value; ctx.note(`version ${txt.value} (from ${txt.file})`); }
  const binVersion = bins.find(b => b.report?.version)?.report.version;
  if (versionGiven !== undefined) {
    const parsed = versionLabel(versionGiven);
    if (parsed.error) r.problem("bad_version", parsed.error, {field: "version", exit: EXIT.usage, hint: parsed.hint, next: parsed.suggestion ? [ctx.cmd({set: {version: parsed.suggestion}})] : []});
    else { label = parsed.label; parsed.notes.forEach(n => ctx.note(n)); }
  } else if (binVersion) {
    const parsed = versionLabel(binVersion);
    if (parsed.error) r.problem("bad_version", `The BIN's version "${binVersion}" cannot be a label`, {field: "version", exit: EXIT.usage, hint: "Give --version (e.g. 1.4.0)",
      next: parsed.suggestion ? [ctx.cmd({add: {version: parsed.suggestion}})] : []});
    else { label = parsed.label; ctx.note(`version ${label} (from the BIN's app description; --version sets another)`); }
  } else if (bins.length && bins.every(b => b.report?.ok)) {
    r.problem("usage", "Which version? The BIN does not say: give --version", {exit: EXIT.usage, field: "version", hint: "e.g. --version 1.4.0", next: []});
  }
  if (label && binVersion && versionsDisagree(label, binVersion)) {
    const message = `The version is ${label} but the BIN says it is ${binVersion}: an old build, or the wrong file?`;
    if (channel === "dev") r.warn("version_mismatch", message, {hint: "Build again after raising the version, or publish it as " + binVersion});
    else if (!o.force) r.problem("needs_force", message, {exit: EXIT.confirm, field: "version", hint: `Build again (the device shows ${binVersion}), publish it as ${binVersion}, or add --force`,
      next: [ctx.cmd({set: {version: binVersion}}), ctx.cmd({add: {force: true}})]});
  }
  const differentVersions = [...new Set(bins.map(b => b.report?.version).filter(Boolean))];
  if (differentVersions.length > 1) r.warn("bins_disagree", `The BINs say different versions: ${differentVersions.join(", ")}`, {hint: "Build every device from the same source"});

  // The simulator version (the same source for the browser, with CardenzaHAL's web target): built here
  // and uploaded with the BINs when this is a CardenzaHAL firmware; --sim-dir uploads a built one.
  const sim = account ? planSim(ctx, r, {bins, kind, manifest}) : {mode: "none", steps: []};

  // Release notes.
  let notes = textValue(ctx, r, from("notes").value, {flag: "notes"});
  // --notes on the command line wins over the project file's notes_file (--notes-file given too: the file).
  const notesOnLine = o.notes !== undefined && o.notes_file === undefined;
  const notesFile = notesOnLine ? {value: undefined} : from("notes_file");
  if (notesOnLine && m.notes_file !== undefined) ctx.note(`notes: --notes (not ${m.notes_file}, which ${path.basename(manifest.file ?? PROJECT_FILE)} names)`);
  if (notesFile.value !== undefined) {
    const file = readLocal(ctx, r, notesFile.value, {what: "The notes file", flag: "notes-file", base: notesFile.base});
    if (file) {
      const text = Buffer.from(file.bytes).toString("utf8");
      const headings = (text.match(/^#{1,3}\s.*\d+\.\d+/gm) ?? []).length;
      const entry = label ? changelogEntry(text, label) : null;
      if (entry) { notes = entry; ctx.note(`notes: the ${label} entry of ${file.rel}`); }
      else if (headings >= 2 || /changelog/i.test(file.rel)) {
        const top = changelogTop(text);
        const missing = `${file.rel} has no entry for ${label ?? "this version"}${top ? ` (its top entry is "${top.heading}")` : ""}`;
        // The project file's CHANGELOG on dev (a CI build such as 0.3.0-dev.57): no notes, dev needs none.
        if (notesFile.flag === "notes_file" && channel === "dev") ctx.note(`${missing}: no release notes (dev versions need none; --notes "…" gives some)`);
        else {
          r.problem("usage", missing, {exit: EXIT.usage, field: "notes-file",
            hint: `Add a heading "## ${label ?? "1.4.0"}" with what changed to ${file.rel}, or give the notes on the command line: --notes "…"`,
            next: [ctx.cmd({remove: ["notes-file"], add: {notes: `<what changed in ${label ?? "this version"}>`}})]});
        }
      } else notes = text;
    }
  } else if (notes === undefined && label) {
    for (const name of ["CHANGELOG.md", "CHANGELOG", "CHANGES.md", "changelog.md"]) {
      const file = path.join(manifest.dir, name);
      if (!fs.existsSync(file)) continue;
      const entry = changelogEntry(fs.readFileSync(file, "utf8"), label);
      if (entry) { notes = entry; ctx.note(`notes: the ${label} entry of ${name}`); }
      break;
    }
  }
  if (notes !== undefined && notes.length > LIMITS.text.notes) r.problem("invalid", `The notes are ${notes.length} characters: at most 10000`, {field: "notes", hint: "Keep the essentials; link to the full changelog"});
  if (notes !== undefined) r.placeholder("notes", notes);

  // The commit and links of this version.
  let commit;
  const commitGiven = from("commit").value;
  if (commitGiven !== undefined) {
    const resolved = resolveCommit(String(commitGiven), ctx.cwd);
    if (resolved.error) r.problem("invalid", resolved.error, {field: "commit", exit: EXIT.usage, hint: resolved.hint});
    else { commit = resolved.commit; if (resolved.note) ctx.note(resolved.note); }
  }
  const versionSource = mode === "versions" ? o.source_url : undefined;
  if (versionSource !== undefined && !httpsUrl(versionSource)) r.problem("invalid", `--source-url ${versionSource} is not an https link`, {field: "source_url", exit: EXIT.usage});
  let notices = null;
  const noticesGiven = from("notices");
  if (noticesGiven.value !== undefined) notices = readLocal(ctx, r, noticesGiven.value, {what: "The notices file", flag: "notices", base: noticesGiven.base, max: LIMITS.notices_bytes});

  // What the firmware already has: this label, the newest on the channel.
  let existing = null, newest = null;
  if (fw && label) {
    const versions = await allPages(ctx, `/firmware/${enc(fwCode)}/versions`, {}, 12);
    existing = versions.find(v => v.version === label) ?? null;
    newest = fw.latest?.[channel] ?? null;
    const previous = versions.find(v => v.status === "published" && v.version !== label);
    const before = previous?.targets?.find(t => t.diagnosis?.project_name)?.diagnosis.project_name;
    const now = bins.find(b => b.report?.project)?.report.project;
    if (before && now && before !== now && !o.force) {
      r.problem("needs_force", `This BIN is the project "${now}", but ${fw.name}'s versions so far are "${before}": the wrong BIN?`, {exit: EXIT.confirm, field: "bin",
        hint: "Check the file (build/<project>.bin of this firmware's source); --force if the project was renamed", next: [ctx.cmd({add: {force: true}})]});
    }
  }
  let resume = null, done = null;
  if (existing) {
    const local = Object.fromEntries(bins.map(b => [b.target, b.report?.sha256]));
    const theirs = Object.fromEntries((existing.targets ?? []).map(t => [t.target, t.sha256]));
    const sameTargets = Object.keys(local).sort().join() === Object.keys(theirs).sort().join();
    const sameBins = sameTargets && Object.keys(local).every(t => local[t] === theirs[t]);
    if (existing.status === "published" && sameBins) done = existing;
    else if (existing.status === "published") {
      const bump = nextVersion(newest && compareVersions(newest.version, label) > 0 ? newest.version : label);
      const binSays = binVersion && !versionsDisagree(label, binVersion);
      r.problem("version_taken", `${fw.name} ${label} (${existing.code}) is already published with ${sameTargets ? "another BIN" : "other devices"}`, {field: "version",
        hint: `A published version never changes. ${binSays ? `This build calls itself ${binVersion} too: raise the version in the source (e.g. ${bump}), build again, then publish that build.`
          : `Publish this build as a new version, e.g. ${bump}.`}`, next: [ctx.cmd({set: {version: bump}})]});
    } else if (existing.status === "rejected") {
      const failed = (existing.check?.steps ?? []).filter(s => s.status === "fail").map(s => `${s.name}${s.target ? " (" + s.target + ")" : ""}: ${s.detail}`);
      r.problem("rejected", `${fw.name} ${label} (${existing.code}) was sent back by the checks: ${failed.join("; ") || "see its report"}`, {exit: EXIT.rejected, field: "version",
        hint: "Fix it and publish a new version, or appeal if the check is wrong", next: [ctx.run(["versions", "check", existing.code]),
          ctx.cmd({set: {version: nextVersion(label)}}),
          ctx.run(["versions", "appeal", existing.code, "--message", "<why the check is wrong: 10-2000 characters>"])]});
    } else if (existing.status === "checking") resume = {kind: "checking", version: existing};
    else if (existing.status === "draft") {
      const uploadedOther = Object.keys(theirs).filter(t => theirs[t] && local[t] && theirs[t] !== local[t]);
      if (existing.channel !== channel || !sameTargets || uploadedOther.length) {
        r.problem("draft_mismatch", `A draft of ${label} (${existing.code}) has ${existing.channel !== channel ? "the channel " + existing.channel : !sameTargets ? "other devices (" + Object.keys(theirs).join(", ") + ")" : "another BIN for " + uploadedOther.join(", ")}`,
          {field: "version", hint: "Delete the draft, then run this command again (drafts are also removed after a day)",
            next: [ctx.run(["versions", "delete", existing.code, "--yes"]), ctx.cmd({})]});
      } else resume = {kind: "draft", version: existing, missing: Object.keys(theirs).filter(t => !theirs[t])};
    }
  }
  if (!notes?.trim() && !done && resume?.kind !== "checking" && channel === "stable" && ctx.interactive && !o.dry_run) {
    const answer = await ctx.ask(`Release notes for ${label ?? "this version"} (what changed; empty for none):`);
    if (answer?.trim()) notes = answer.trim();
  }
  if (!notes?.trim() && !done && resume?.kind !== "checking") {
    // (A CHANGELOG.md here was read already: it has no entry for this version.)
    const changelog = ["CHANGELOG.md", "CHANGES.md"].find(name => fs.existsSync(path.join(manifest.dir, name)));
    if (channel === "stable" && !o.force) {
      r.problem("needs_force", "No release notes for a stable version: people want to know what changed", {exit: EXIT.confirm, field: "notes",
        hint: `Write what changed: --notes "…" (Markdown)${changelog ? `, or add a "## ${label ?? "<version>"}" entry to ${changelog} (read by itself)` : ` or --notes-file CHANGELOG.md with a "## ${label ?? "<version>"}" entry`}. Only if the user wants none: --force`,
        next: [ctx.cmd({add: {notes: "<what changed in " + (label ?? "this version") + ">"}}), ctx.cmd({add: {force: true}})]});
    } else if (channel === "beta") r.warn("no_notes", "No release notes", {hint: 'What should testers try? --notes "…"'});
  }
  if (!existing && newest && label) {
    const order = compareVersions(label, newest.version);
    if (order !== null && order < 0 && !o.force) {
      const binSays = binVersion && !versionsDisagree(label, binVersion);
      r.problem("needs_force", `${label} is lower than the newest ${channel} version, ${newest.version}: the Launcher installs the newest by date, people would go back`, {exit: EXIT.confirm,
        field: "version", hint: binSays ? `This BIN calls itself ${binVersion}: an old build? Raise the version in the source (above ${newest.version}), build, publish that; --force only if going back is meant`
          : `Publish a higher version (e.g. ${nextVersion(newest.version)}), or --force if going back is meant`,
        next: [binSays ? null : ctx.cmd({set: {version: nextVersion(newest.version)}}), ctx.cmd({add: {force: true}})]});
    }
  }

  // The cover and the page's quality.
  const coverGiven = from("cover");
  // A trusted-publishing credential publishes versions only: the cover and the page stay as they are (the owner
  // changes them on the site or with their own sign-in).
  if (trusted && coverGiven.value !== undefined) ctx.note("the cover is left as it is (a trusted-publishing credential publishes versions only)");
  const cover = coverGiven.value !== undefined && account && !trusted ? await planCover(ctx, r, coverGiven.value, fw, {base: coverGiven.base}) : null;
  let pageChanges = fw ? Object.fromEntries(Object.entries(page).filter(([k, v]) => !samePageValue(v, fw[k]))) : {};
  if (trusted && Object.keys(pageChanges).length) {
    ctx.note(`the page's ${Object.keys(pageChanges).join(", ")} ${Object.keys(pageChanges).length > 1 ? "differ" : "differs"} from ${path.basename(manifest.file ?? "the flags")}: left as they are ` +
      "(a trusted-publishing credential publishes versions only; the owner changes the page on the site or with their own sign-in)");
    pageChanges = {};
  }
  if (creating || fw) pageWarnings(ctx, r, fw, {...page, cover: cover ?? (coverGiven.value && !trusted ? true : undefined)}, fwCode, {brief: !!fw, original: forkOf});
  // A stable version needs a cover (COMMUNITY.md "Covers", the user 2026-11-17): the firmware's picture (one given
  // now too), its original's (a fork), its screen after boot, or the web build that goes with this version (its
  // screen, once checked). Without any, only --without-cover goes on (the server says 409 cover_required). Beta and
  // dev (CI's builds) and launchers are never held back. (A trusted-publishing run cannot set a cover: its owner does.)
  const coverAlready = !!(cover || (coverGiven.value !== undefined && !trusted) || fw?.cover || fw?.inherited_cover || fw?.screen ||
    (!fw && (forkOf?.cover || forkOf?.inherited_cover)) || resume?.version?.simulator);
  const coverAsked = channel === "stable" && kind === "app" && !coverAlready && !done && resume?.kind !== "checking";
  const coverRequired = (why) => r.problem("cover_required", `A stable version needs a cover: ${fw ? fw.name + " has" : "the firmware has"} none ` +
    `(no picture${fw?.forked_from || forkOf ? ", none from its original" : ""}, no screen after boot) and ${why}`, {exit: EXIT.confirm, field: "cover",
    hint: trusted ? `Its owner sets a cover on the site (or firmware cover ${fwCode} cover.png with their own sign-in); or send the web build (--sim-dir DIR). Only if the owner wants none: --without-cover`
      : "Add a 16:9 picture (PNG/JPEG/WebP, 1280x720, ≤ 2 MB): --cover cover.png (or 203.json's publish.cover)" +
      (fwCode ? `, or set it first: firmware cover ${fwCode} cover.png` : "") + "; or send the web build (--sim-dir DIR). Only if the user wants none: --without-cover",
    next: [trusted ? null : ctx.cmd({add: {cover: "cover.png"}}), fwCode && !trusted ? ctx.run(["firmware", "cover", fwCode, "cover.png"]) : null, ctx.cmd({add: {without_cover: true}})].filter(Boolean)});
  if (coverAsked && sim.mode === "none" && !o.without_cover) coverRequired("no web build goes with this version");
  // The source archive (203.json "publish_source": true, or --source): the commit's tracked files (git
  // archive), checked for secrets here the way the server checks it (source.mjs).
  const wantSource = mode === "publish" && !o.no_source && (o.source === true || project?.publish_source === true);
  let archive = null;
  if (wantSource) {
    const made = makeArchive(manifest.dir, {name: fork?.name ?? fw?.name ?? page.name ?? nameGiven ?? null});
    if (made.error) r.problem("source_unavailable", made.error, {field: "source", hint: made.hint + "; or publish without it: --no-source", next: [ctx.cmd({add: {no_source: true}})]});
    else if (made.bytes.length > MAX_ARCHIVE) r.problem("too_large", `The source archive is ${size(made.bytes.length)}: at most 16 MB`, {field: "source",
      hint: "Keep large binaries out of git (build output, samples), or publish without it: --no-source", next: [ctx.cmd({add: {no_source: true}})]});
    else if (made.inspected.problem) r.problem("source_secrets", made.inspected.problem + ": " + made.inspected.files.join(", "), {field: "source", data: {files: made.inspected.files},
      hint: "Remove them from git (git rm --cached FILE, add them to .gitignore; a secret that was ever pushed must be revoked and replaced), commit, run again; or --no-source"});
    else {
      archive = made;
      if (made.dirty) r.warn("source_dirty", `The working tree has uncommitted changes: the source archive is the commit ${made.commit.slice(0, 12)} without them`,
        {hint: "Commit first so the source matches the BIN"});
      if (made.submodules.length) ctx.note(`the source archive leaves out the submodules (${made.submodules.join(", ")}): git archive does not include them`);
      if (commit === undefined) { commit = made.commit; ctx.note(`commit ${made.commit.slice(0, 12)} (the source archive's)`); }
      else if (!made.commit.startsWith(commit) && !commit.startsWith(made.commit)) r.warn("source_commit", `--commit ${commit} is not the commit the source archive is made of (${made.commit.slice(0, 12)})`);
    }
  }
  if (o.dry_run && channel === "stable" && commit === undefined && !done && gitInfo(ctx.cwd)) {
    const git = gitInfo(ctx.cwd);
    r.warn("no_commit", "No --commit: the version does not say which source it was built from", {hint: `This folder is at ${git.head.slice(0, 12)}${git.dirty ? " (with uncommitted changes)" : ""}`,
      next: [ctx.cmd({add: {commit: git.head}})]});
  }

  // The plan.
  const describeBin = b => !b.report?.ok ? `${b.target}: ${b.local.rel} (${size(b.local.bytes.length)}: not usable, see the problems)`
    : `${b.target}: ${b.local.rel} (${size(b.local.bytes.length)}, ${b.report.kind === "merged" ? "merged image" : b.report.kind === "uf2" ? `UF2, ${b.report.uf2?.blocks ?? "?"} blocks, download only:` : "ESP32-S3 app"} ${b.report.version ?? ""}` +
    `${b.report.hal ? ", " + halName(b.report.hal) : ""}${b.report.budget ? `, ${b.report.budget.percent} % of the Launcher's ${size(b.report.budget.limit)}` : ""})`;
  const shownName = fw?.name ?? page.name ?? nameGiven ?? "the firmware";
  if (creating) r.step(`make the firmware "${page.name ?? nameGiven}" (${priv.visibility ?? "public"}${channel !== "stable" ? ", " + channel + " channel on" : ""})`);
  if (fw && Object.keys(pageChanges).length) r.step(`change ${Object.keys(pageChanges).join(", ")} on ${fw.name}'s page`);
  if (fw && channel !== "stable" && !fw.channels?.[channel]) r.step(`turn the ${channel} channel of ${fw.name} on`);
  if (cover) r.step(`set the cover to ${cover.describe}`);
  if (done) r.step(`nothing to publish: ${label} (${done.code}) is already published with these BINs`);
  else if (resume?.kind === "checking") r.step(`wait for the checks of ${label} (${resume.version.code}), already sent`);
  else if (label && bins.length) {
    r.step(`${resume ? `resume the draft ${resume.version.code} of` : "publish"} ${shownName} ${label} on ${channel}${notes ? " with release notes" : ""}${commit ? " (commit " + commit.slice(0, 12) + ")" : ""}`);
    for (const b of bins) if (!resume || resume.missing.includes(b.target)) r.step(`upload ${describeBin(b)}`);
    sim.steps.forEach(step => r.step(step));
    if (archive) r.step(`attach the source archive of ${archive.commit.slice(0, 12)} (${archive.inspected.entries} files, ${size(archive.bytes.length)})`);
    r.step(o.no_wait ? "send it to the checks (not waiting)" : `wait for the checks (${bins.length && bins.every(b => b.report?.kind === "uf2") ? "the UF2 file read; nothing booted" : "image, layout, a boot in QEMU"}${sim.mode !== "none" ? ", the simulator version in a browser" : ""}; up to ${Math.round((o.timeout ?? 1200) / 60)} minutes)`);
  } else if (sim.mode !== "none" && (done || resume?.kind === "checking")) {
    sim.steps.forEach(step => r.step(step + " (only if it differs from the one there)"));
  }
  if (archive && (done || resume?.kind === "checking")) r.step(`attach the source archive of ${archive.commit.slice(0, 12)} (only if it differs from the one there)`);
  if (fork?.made) r.plan.unshift(`fork ${fork.from.name} (${fork.from.code}) and record it in 203.json`);

  // The server's own dry run (?dry_run=1): the same call, checked as for real and rolled back.
  if (o.dry_run && account && !r.problems.length) {
    try {
      if (creating) {
        await ctx.client.request("POST", "/firmware", {query: {dry_run: 1}, body: {...page, ...priv, ...(fork?.made ? {forked_from: fork.forked_from} : {}),
          ...(kind === "launcher" && !fork ? {kind} : {})}});
      } else if (fw && label && (!existing || existing.status === "draft")) {
        await ctx.client.request("POST", `/firmware/${enc(fwCode)}/versions`, {query: {dry_run: 1}, body: {channel, version: label, targets: bins.map(b => b.target).sort()}});
      }
      ctx.note("the server's dry run agrees");
    } catch (error) {
      // The run turns the channel on first (--yes): the server's dry run cannot know that.
      const turnsOn = fw && channel !== "stable" && !fw.channels?.[channel];
      if (turnsOn && error instanceof ApiError && error.data?.field === "channel") ctx.note(`the server's dry run agrees once the ${channel} channel is on (the run turns it on first)`);
      else if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) ctx.note("the server's dry run could not run: " + error.message);
      else r.problem(error.code, "The server would refuse it: " + error.message, {field: error.data?.field, exit: error.status === 401 ? EXIT.signin : EXIT.refused,
        hint: "Fix what it says, then run the same command again"});
    }
  }
  if (o.dry_run) {
    return dryOut(ctx, r, {json: {fork, source: archive ? {commit: archive.commit, files: archive.inspected.entries, size: archive.bytes.length, sha256: archive.sha256, dirty: archive.dirty} : null,
      firmware: fw ? {code: fwCode, name: fw.name, url: firmwareUrl(ctx, fwCode)} : creating ? {code: null, name: page.name ?? nameGiven, new: true} : null,
      version: label ? {version: label, channel, targets: bins.map(b => b.target), ...(existing ? {code: existing.code, status: existing.status} : {})} : null,
      bins: bins.map(b => ({target: b.target, file: b.local.rel, size: b.local.bytes.length, sha256: b.report?.sha256, kind: b.report?.kind, chip: b.report?.chip,
        project: b.report?.project, app_version: b.report?.version, idf: b.report?.idf, hal: b.report?.hal, budget: b.report?.budget})),
      simulator: simPlanJson(sim)}});
  }
  if (r.problems.length) failWith(ctx, r);

  // Build the simulator version now, before anything is changed (a build that needs a decision stops here).
  let simLocal = sim.mode === "dir" ? sim.local : null;
  if (sim.mode === "build") simLocal = await buildSim(ctx, r, sim, {channel, targets: bins.map(b => b.target)});
  // The web build was to be the cover (its screen): without it, the cover is asked for as above.
  if (coverAsked && sim.mode !== "none" && !simLocal && !o.without_cover && !r.problems.length) coverRequired("its web build could not be made");
  if (r.problems.length) failWith(ctx, r, sim.failure ?? {});
  const withoutCover = coverAsked && !simLocal && !!o.without_cover;
  if (withoutCover) ctx.note("published without a cover (--without-cover): the card and the Launcher's store show the grey default");

  // Do it.
  if (creating) {
    const channels = channel !== "stable" ? {[channel]: true} : undefined;
    ctx.say(`Making the firmware ${page.name}…`);
    fw = await ctx.client.post("/firmware", {...page, ...priv, ...(channels ? {channels} : {}), ...(kind === "launcher" && !fork ? {kind} : {}),
      ...(fork?.made ? {forked_from: fork.forked_from} : {})});
    fwCode = fw.code;
    ctx.say(`  code ${fw.code}${fork?.made ? ` (a fork of ${fork.from.name} ${fork.from.code})` : ""}`);
    if (fork) fork.code = fw.code;
  }
  if (creating || fork) {
    saveManifest(ctx, manifest, {code: fw.code, ...(fork ? {forked_from: {code: fork.from.code, version: fork.version}} : {}),
      ...(fork?.made && project && project.name !== fork.name ? {name: fork.name} : creating && !fork && project && page.name && project.name !== page.name ? {name: page.name} : {}),
      author: account.name, fork: !!fork?.made});
    if (bound && bound !== fw.code) { git(["config", "203c.firmware", fw.code], {cwd: ctx.cwd}); ctx.note(`this clone now publishes to ${fw.code} (git config 203c.firmware)`); }
  }
  if (!creating) {
    const edit = {...pageChanges};
    if (channel !== "stable" && !fw.channels?.[channel]) edit.channels = {[channel]: true};
    if (Object.keys(edit).length) { ctx.say(`Updating ${fw.name}'s page (${Object.keys(edit).join(", ")})…`); fw = await ctx.client.post(`/firmware/${enc(fwCode)}/edit`, edit); }
  }
  if (cover) { ctx.say(`Uploading the cover (${size(cover.bytes.length)})…`); fw = await uploadCover(ctx.client, fwCode, cover.bytes, cover.mime); }
  let version, uploaded = [], simUploaded = false, sourceUploaded = null;
  if (done) version = done;
  else if (resume?.kind === "checking") version = resume.version;
  else {
    const body = {channel, version: label, targets: bins.map(b => b.target).sort()};
    if (notes) body.notes = notes;
    if (commit) body.source_commit = commit;
    if (versionSource) body.source_url = versionSource;
    const draft = await ctx.client.post(`/firmware/${enc(fwCode)}/versions`, body);
    for (const upload of draft.uploads) {
      const bin = bins.find(b => b.target === upload.target);
      const uf2 = bin.report?.kind === "uf2";
      ctx.say(`Uploading the ${upload.target} ${uf2 ? "UF2 file" : "BIN"} (${size(bin.local.bytes.length)})…`);
      const started = Date.now();
      const form = new FormData();
      form.set("image", new Blob([bin.local.bytes]), uf2 ? "app.uf2" : "app.bin");
      if (notices) form.set("notices", new Blob([notices.bytes]), "NOTICES.txt");
      let response;
      try { response = await ctx.client.fetch(upload.upload_url, {method: "POST", headers: {...ctx.client.langHeaders(), Authorization: "Bearer " + upload.ticket}, body: form}); }
      catch (error) { throw new ApiError(0, "upload_failed", `The ${upload.target} upload failed (${error.cause?.code || error.message})`); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status >= 500 || response.status === 409) throw new ApiError(response.status, "upload_failed", `${upload.target}: ${data.error || "the upload failed"}`, data);
        throw new ApiError(response.status, data.code || "upload_failed", `${upload.target}: ${data.error || "upload refused"}`, data);
      }
      uploaded.push(data);
      ctx.say(`  done in ${((Date.now() - started) / 1000).toFixed(1)} s (sha256 ${data.sha256?.slice(0, 12)}…)`);
    }
    // The simulator version goes with the draft: the version's own checks open it.
    if (simLocal) simUploaded = await uploadSimIfNew(ctx, fwCode, draft.version, simLocal);
    if (archive) { ctx.say(`Attaching the source archive (${size(archive.bytes.length)})…`); sourceUploaded = await uploadSource(ctx.client, fwCode, draft.version.code, archive.bytes, archive.sha256); }
    version = await ctx.client.post(`/firmware/${enc(fwCode)}/versions/${enc(draft.version.code)}/publish`, withoutCover ? {without_cover: true} : {});
    ctx.say(`Sent ${label} (${version.code}) to the checks.`);
  }
  if (!done && version.status === "checking" && !o.no_wait) version = await waitForChecks(ctx, fwCode, version, {timeout: o.timeout ?? 1200, poll: o.poll ?? 5});
  if (version.status === "rejected") throw rejection(ctx, fw, version, label);
  if (!done && version.status === "checking" && o.no_wait) ctx.note("not waiting: the checks run on");
  // Run again on a version already sent: its simulator version is uploaded when it differs (or is missing).
  if (simLocal && (done || resume?.kind === "checking")) simUploaded = await uploadSimIfNew(ctx, fwCode, version, simLocal);
  if (archive && (done || resume?.kind === "checking") && version.status !== "rejected" && version.source?.sha256 !== archive.sha256) {
    ctx.say(`Attaching the source archive (${size(archive.bytes.length)})…`);
    sourceUploaded = await uploadSource(ctx.client, fwCode, version.code, archive.bytes, archive.sha256);
  }
  if (simLocal && !o.no_wait && version.status === "published") {
    version = await waitSim(ctx, version.code, {timeout: Math.min(o.timeout ?? 1200, 600), poll: o.poll ?? 5});
  } else if (simLocal && simUploaded) version = (await ctx.client.get("/versions/" + enc(version.code))).version;
  const simulator = simState(ctx, version, {built: sim.mode === "build" ? !!simLocal : false, uploaded: simUploaded,
    ...(sim.mode === "none" || !simLocal ? {reason: sim.reason ?? null} : {}), ...(simLocal ? {files: simLocal.files.length, size: simLocal.total} : {})});

  // The answer.
  const status = done ? "already_published" : version.status;
  const fresh = await ctx.client.get("/firmware/" + enc(fwCode)).catch(() => fw);
  const list = checklistOf(ctx, fresh, version).map(i => i.ok ? {...i, fix: null} : i);
  const json = {status, firmware: {code: fwCode, name: fresh.name, url: firmwareUrl(ctx, fwCode), created: creating},
    fork: fork ? {from: fork.from, version: fork.version, code: fwCode, made: fork.made, why: fork.why} : null,
    source: archive ? {commit: archive.commit, files: archive.inspected.entries, size: archive.bytes.length, sha256: archive.sha256, uploaded: !!sourceUploaded} : null,
    version: compactVersion(version), uploaded,
    simulator, urls: {firmware: firmwareUrl(ctx, fwCode), version: versionUrl(ctx, version.code), ...(simulator.play_url ? {play: simulator.play_url} : {})},
    install: `In the Launcher: Code ${fwCode} installs the newest ${channel}; ${version.code} installs exactly ${label}`,
    warnings: r.warnings.map(clean), notes: ctx.notes, checklist: list,
    next: trusted ? [ctx.run(["versions", "show", version.code])] : [ctx.run(["firmware", "checklist", fwCode]), ctx.run(["devices", "list"])]};
  const head = status === "already_published" ? `${fresh.name} ${label} was already published with these BINs: ${simUploaded ? "its simulator version was uploaded (it had none, or another build)" : "nothing to do"}.`
    : status === "published" ? `Published ${fresh.name} ${label} on ${channel}.` : `${fresh.name} ${label} is being checked (${version.status}); it is published when the checks pass.`;
  const lines = [head,
    ...(fork ? [`  Fork of        ${fork.from.name} (${fork.from.code})${fork.version ? " " + fork.version : ""}${fork.made ? ": made now, recorded in 203.json" : ""}`] : []),
    `  Firmware code  ${fwCode}   (the Launcher installs the newest ${channel} version with it)`,
    `  Version code   ${version.code}   (exactly this version)`,
    `  Page           ${firmwareUrl(ctx, fwCode)}`,
    `  Version page   ${versionUrl(ctx, version.code)}`];
  for (const t of version.targets ?? []) {
    const d = t.diagnosis;
    lines.push(`  BIN ${t.target.padEnd(10)} ${size(t.size ?? 0)}${d ? `, ${d.project_name ?? "?"} ${d.app_version ?? ""}, ${d.hal ? halName(d.hal) : "no CardenzaHAL"}, ${d.fits_launcher ? "fits the Launcher" : "does NOT fit the Launcher"}` : ""}`);
  }
  if (kind !== "launcher") lines.push("  " + simLine(ctx, simulator, version.code));
  if (archive) lines.push(`  Source         ${archive.inspected.entries} files of ${archive.commit.slice(0, 12)}${sourceUploaded ? " attached" : " (already there)"}`);
  // Why there is none (a build that could not be made): with the simulator line, not with the page's advice.
  for (const w of r.warnings.filter(w => w.code.startsWith("sim_"))) lines.push(`    ! ${w.message}${w.hint ? "\n      " + w.hint : ""}`);
  const pageAdvice = r.warnings;
  r.warnings = r.warnings.filter(w => !w.code.startsWith("sim_"));
  if ((version.warnings ?? []).length) lines.push(`  Tags on the page: ${version.warnings.join(", ")}`);
  const missing = list.filter(i => !i.ok);
  r.warnings = r.warnings.filter(w => w.code !== "page_incomplete" || !missing.length);
  if (r.warnings.length) lines.push(adviceText(r).trimEnd());
  lines.push("Next:", ...json.next.map(n => "  " + n.replace(/ --json$/, "")));
  if (missing.length) lines.splice(lines.indexOf("Next:"), 0, "The page could still have:", ...missing.map(i => `  ✗ ${i.item}${i.fix ? "  → " + i.fix : ""}`));
  r.warnings = pageAdvice;
  return {json, text: lines.join("\n")};
}

// ---------------------------------------------------------------------------------------------
// Simulator versions (sim.mjs): planned with publish, built before anything changes, uploaded with the
// draft (or to the version when it differs), checked by the checker; and the sim commands.

const relTo = (ctx, file) => path.relative(ctx.cwd, file) || ".";
// A BIN's CardenzaHAL: its marker's version, or (the log tag only, a HAL without the marker) unknown.
const halName = hal => hal?.version ? `CardenzaHAL ${hal.version}` : "CardenzaHAL (version unknown)";
const nameOf = (ctx, dir) => relTo(ctx, dir) === "." ? path.basename(dir) : relTo(ctx, dir);

function planSim(ctx, r, {bins, kind, manifest}) {
  const o = ctx.flags, m = manifest.data;
  const none = (reason, extra = {}) => ({mode: "none", reason, steps: [], ...extra});
  if (o.sim_dir !== undefined && o.no_sim) r.problem("usage", "--sim-dir and --no-sim together", {exit: EXIT.usage, hint: "Choose one", next: [ctx.cmd({remove: ["no-sim"]})]});
  if (kind === "launcher") return none("launchers have no simulator version");
  if (o.no_sim || m.sim === false) return none("--no-sim", {skipped: true});
  const targets = bins.map(b => b.target ?? null).filter(Boolean);
  const given = o.sim_dir !== undefined ? path.resolve(ctx.cwd, o.sim_dir) : typeof m.sim === "string" ? path.resolve(manifest.dir, m.sim) : null;
  if (given) {
    const local = readSimDir(given, {targets});
    for (const p of local.problems) r.problem(p.code === "too_large" ? "too_large" : p.code === "file_not_found" ? "file_not_found" : "invalid",
      `The simulator version ${relTo(ctx, given)}: ${p.message}`, {field: "sim-dir", hint: p.hint});
    for (const w of local.warnings) r.warn(w.code, w.message, {hint: w.hint});
    return {mode: "dir", local, dir: given, steps: [`upload the simulator version ${relTo(ctx, given)} (${describeSim(local)}) with the version: the checker opens it, Play once it boots`]};
  }
  const halBuilt = bins.some(b => b.report?.hal);
  let project = null;
  const projectGiven = o.project !== undefined ? path.resolve(ctx.cwd, o.project) : m.project ? path.resolve(manifest.dir, m.project) : null;
  if (projectGiven) {
    if (!fs.existsSync(path.join(projectGiven, "CMakeLists.txt"))) {
      r.problem("sim_not_project", `${relTo(ctx, projectGiven)} is not an ESP-IDF project (no CMakeLists.txt)`, {field: "project", exit: EXIT.usage,
        hint: "Give the folder idf.py builds (its CMakeLists.txt includes project.cmake)"});
      return none("no project");
    }
    project = projectGiven;
  } else {
    const found = findProject({bins: bins.map(b => b.local.abs), from: [...new Set([ctx.cwd, manifest.dir])]});
    if (found?.ambiguous) {
      r.warn("sim_which_project", `Several ESP-IDF projects here build with CardenzaHAL: ${found.ambiguous.map(d => relTo(ctx, d)).join(", ")}: no simulator version`,
        {hint: "Say which one with --project", next: found.ambiguous.slice(0, 2).map(d => ctx.cmd({add: {project: relTo(ctx, d)}}))});
      return none("several projects");
    }
    project = found?.dir ?? null;
  }
  const hal = project ? findHal(project) : null;
  if (!hal && o.hal === undefined) {
    if (halBuilt) {
      r.warn("sim_no_source", "The BIN was built with CardenzaHAL but its source is not here: the version gets no simulator version (no Play)",
        {hint: "Run publish from the firmware's folder (or give --project DIR), or upload a built one with --sim-dir build-web/site"});
      return none("the source is not here");
    }
    return none(project ? "not a CardenzaHAL firmware" : "no ESP-IDF project here");
  }
  if (!project) {
    r.problem("sim_not_project", "--hal is given but no ESP-IDF project of the firmware was found here", {field: "project", exit: EXIT.usage, hint: "Give it: --project DIR"});
    return none("no project");
  }
  const script = halScript(ctx, {project, flagHal: o.hal, dryRun: true});
  if (script.missing) { r.problem("file_not_found", script.why, {field: "hal", exit: EXIT.usage, hint: script.hint}); return none("no HAL"); }
  const out = path.join(project, "build-web", "site");
  const tools = toolchain();
  if (o.dry_run && !tools.emscripten.ok) {
    r.warn("sim_toolchain", `Emscripten was not found (${tools.emscripten.detail}): the simulator version may not build`, {hint: EMSDK_HINT, next: [ctx.cmd({add: {no_sim: true}})]});
  }
  return {mode: "build", project, out, hal: hal?.dir ?? null, script, steps: [
    `build the simulator version of ${nameOf(ctx, project)} with ${script.plan} into ${relTo(ctx, out)} (cardenza_web.py build)`,
    "upload it with the version: the checker opens it in a browser, Play once it boots"]};
}

const simPlanJson = sim => sim.mode === "build" ? {mode: "build", project: sim.project, out: sim.out, hal: sim.hal, script: sim.script?.script ?? null, from: sim.script?.source}
  : sim.mode === "dir" ? {mode: "upload", dir: sim.dir, files: sim.local.files.length, size: sim.local.total, manifest: !!sim.local.manifest}
    : {mode: "none", reason: sim.reason};

// A simulator version that cannot be made: a warning (the BIN alone is published, no Play), or for
// stable and beta, when something is to be done about it (install the toolchain, fix the code), a decision.
async function simTrouble(ctx, r, sim, trouble, {decide = false, channel}) {
  const later = `It can be added later: sim build, then sim upload VCODE ${relTo(ctx, sim.out ?? "build-web/site")}`;
  if (!decide || channel === "dev" || ctx.flags.yes) {
    r.warn(trouble.code, `${trouble.message}; publishing the BIN only, no Play`, {hint: `${trouble.hint ?? ""} ${later}`.trim(),
      ...(trouble.unsupported ? {unsupported: trouble.unsupported, headers: trouble.headers, sources: trouble.sources} : {})});
    sim.reason = trouble.code;
    return;
  }
  if (ctx.interactive && await ctx.confirm(`${trouble.message}.\n${trouble.hint ?? ""}\nPublish without a simulator version (no Play)?`)) {
    r.warn(trouble.code, `${trouble.message}; publishing the BIN only, no Play`, {hint: later});
    sim.reason = trouble.code;
    return;
  }
  r.problem(trouble.code, trouble.message, {exit: EXIT.confirm, field: "sim",
    hint: `${(trouble.hint ?? "").replace(/[.\s]*$/, "")}${/same command again/i.test(trouble.hint ?? "") ? "" : ", then run the same command again"}. ` +
      "Or publish without a simulator version (no Play): --no-sim.",
    next: [ctx.cmd({}), ctx.cmd({add: {no_sim: true}})]});
  sim.failure = trouble.build_log ? {build_log: trouble.build_log} : {};
}

async function buildSim(ctx, r, sim, {channel, targets}) {
  const script = halScript(ctx, {project: sim.project, flagHal: ctx.flags.hal});
  if (script.missing) {
    await simTrouble(ctx, r, sim, {code: script.missing === "no_web_target" ? "sim_no_web_target" : "sim_toolchain", message: script.why, hint: script.hint},
      {decide: script.missing !== "no_web_target", channel});
    return null;
  }
  const result = await runBuild(ctx, {script: script.script, project: sim.project, out: sim.out, hal: script.source === "project" ? null : script.hal,
    debug: ctx.flags.debug, jobs: ctx.flags.jobs});
  if (result.kind !== "built") {
    await simTrouble(ctx, r, sim, explainBuild(result, {project: sim.project}), {decide: ["toolchain", "no_python", "compile", "crash"].includes(result.kind), channel});
    return null;
  }
  const local = readSimDir(sim.out, {targets});
  for (const p of local.problems) r.problem("sim_build_failed", `cardenza_web.py's output ${relTo(ctx, sim.out)}: ${p.message}`, {field: "sim", hint: p.hint});
  for (const w of local.warnings) r.warn(w.code, w.message, {hint: w.hint});
  if (local.problems.length) return null;
  ctx.say(`  built: ${describeSim(local)} in ${relTo(ctx, sim.out)}`);
  return local;
}

async function uploadSimIfNew(ctx, fwCode, version, local) {
  if (sameBuild(local, version.simulator)) { ctx.note(`the simulator version of ${version.version ?? version.code} is already this build: not uploaded again`); return false; }
  await uploadSim(ctx, {code: fwCode, vcode: version.code, local});
  return true;
}

/** sim build [DIR]: the simulator version of the firmware in DIR (default here), built where publish would. */
export async function simBuild(ctx) {
  const r = newReport(ctx);
  const o = ctx.flags;
  const start = path.resolve(ctx.cwd, ctx.args.DIR ?? o.project ?? ".");
  let project = null;
  const found = findProject({from: [start]});
  if (found?.ambiguous) {
    throw new CliError("usage", `Several ESP-IDF projects in ${relTo(ctx, start)} build with CardenzaHAL: ${found.ambiguous.map(d => relTo(ctx, d)).join(", ")}`, {exit: EXIT.usage,
      hint: "Give one: sim build DIR", next: found.ambiguous.slice(0, 2).map(d => ctx.run(["sim", "build", relTo(ctx, d)]))});
  }
  project = found?.dir ?? null;
  if (!project) {
    throw new CliError("sim_not_project", `No ESP-IDF project of a firmware in ${start} (a folder whose CMakeLists.txt includes project.cmake)`, {exit: EXIT.usage,
      hint: "Run it in the firmware's folder, or give it: sim build DIR"});
  }
  const hal = findHal(project);
  if (!hal && o.hal === undefined) {
    throw new CliError("sim_not_hal", `${relTo(ctx, project)} does not build with CardenzaHAL (no component with cardenzaHAL.h): a simulator version is built with CardenzaHAL's web target`,
      {hint: `Build the firmware on CardenzaHAL (${"https://github.com/203-Systems/CardenzaHAL"}), or give --hal DIR if it is somewhere else`});
  }
  const out = o.out !== undefined ? path.resolve(ctx.cwd, o.out) : path.join(project, "build-web", "site");
  const plan = halScript(ctx, {project, flagHal: o.hal, dryRun: true});
  if (plan.missing) throw new CliError("file_not_found", plan.why, {exit: EXIT.usage, field: "hal", hint: plan.hint});
  if (o.dry_run) {
    r.step(`build the simulator version of ${relTo(ctx, project)} with ${plan.plan} into ${relTo(ctx, out)}`);
    const tools = toolchain();
    if (!tools.emscripten.ok) r.warn("sim_toolchain", `Emscripten was not found (${tools.emscripten.detail})`, {hint: EMSDK_HINT});
    return dryOut(ctx, r, {json: {project, out, hal: hal?.dir ?? null, from: plan.source}});
  }
  const script = halScript(ctx, {project, flagHal: o.hal});
  if (script.missing) throw new CliError(script.missing === "no_web_target" ? "sim_no_web_target" : "sim_toolchain", script.why, {hint: script.hint});
  const result = await runBuild(ctx, {script: script.script, project, out, hal: script.source === "project" ? null : script.hal, debug: o.debug, jobs: o.jobs});
  if (result.kind !== "built") {
    const e = explainBuild(result, {project});
    throw new CliError(e.code, e.message, {exit: e.code === "sim_not_project" ? EXIT.usage : EXIT.refused, hint: e.hint,
      data: {...(e.unsupported ? {unsupported: e.unsupported, headers: e.headers, sources: e.sources} : {}), ...(e.build_log ? {build_log: e.build_log} : {}), build_exit: result.code},
      next: e.code === "sim_toolchain" ? [ctx.cmd({})] : []});
  }
  const local = readSimDir(out);
  if (local.problems.length) throw new CliError("sim_build_failed", `cardenza_web.py's output ${relTo(ctx, out)}: ${local.problems[0].message}`, {hint: local.problems[0].hint});
  const m = local.manifest ?? {};
  const json = {status: "built", project, out, hal: {dir: script.hal, from: script.source, version: m.hal?.version ?? null, commit: m.hal?.commit ?? null},
    target: m.target ?? null, firmware: m.firmware ?? null, toolchain: m.toolchain ?? null, keys: Array.isArray(m.keys) ? m.keys.length : 0,
    files: local.files.map(({path: p, size: n, sha256}) => ({path: p, size: n, sha256})), size: local.total,
    warnings: local.warnings, next: [ctx.run(["sim", "upload", "<VCODE>", relTo(ctx, out)]), ctx.run(["publish", "--dry-run"])]};
  return {json, text: [`Built the simulator version of ${nameOf(ctx, project)}: ${describeSim(local)}`, `  in ${out}`,
    ...local.warnings.map(w => `  ! ${w.message}`),
    "publish uploads it with the next version by itself; for a version already published:", `  ${ctx.run(["sim", "upload", "<VCODE>", relTo(ctx, out)], {json: false})}`].join("\n")};
}

/** sim upload VCODE DIR: a built simulator version as a version's web build (only when it differs), then its check. */
export async function simUpload(ctx, {code = null, dir = null} = {}) {
  const r = newReport(ctx);
  const o = ctx.flags;
  const vcode = ctx.args.VCODE;
  const folder = path.resolve(ctx.cwd, dir ?? ctx.args.DIR ?? o.dir);
  const account = await me(ctx, r);
  let answer = null;
  try { answer = await ctx.client.get("/versions/" + enc(vcode)); } catch (error) {
    if (!(error instanceof ApiError) || error.code === "unreachable") throw error;
    r.problem("not_found", `No version of yours has the code ${vcode}`, {hint: "Never guess a code: versions list CODE", next: [ctx.run(["firmware", "mine"])]});
  }
  const version = answer?.version, fw = answer?.firmware;
  if (code && fw && fw.code !== code) r.problem("invalid", `${vcode} is a version of ${fw.name} (${fw.code}), not of ${code}`, {next: [ctx.run(["versions", "list", code])]});
  if (fw && account && fw.owner?.id !== account.id) r.problem("forbidden", `${fw.name} is not yours: only its owner uploads its simulator version`, {});
  if (fw?.kind === "launcher") r.problem("invalid", "Launchers have no simulator version", {});
  if (version?.status === "rejected") r.problem("rejected", `${version.version} (${vcode}) was sent back by the checks: publish a new version with its simulator version`, {exit: EXIT.rejected});
  const local = readSimDir(folder, {targets: (version?.targets ?? []).map(t => t.target)});
  for (const p of local.problems) r.problem(p.code === "too_large" ? "too_large" : p.code === "file_not_found" ? "file_not_found" : "invalid", p.message, {field: "DIR", hint: p.hint});
  for (const w of local.warnings) r.warn(w.code, w.message, {hint: w.hint});
  const same = version && sameBuild(local, version.simulator);
  r.step(same ? `nothing to upload: ${vcode}'s simulator version is already this build (${describeSim(local)})`
    : `upload ${relTo(ctx, folder)} (${describeSim(local)}) as the simulator version of ${fw?.name ?? "?"} ${version?.version ?? vcode}`);
  if (!same) r.step(version?.status === "published" ? "the checker opens it in a browser (a job of its own): Play once it boots" : "the version's checks open it in a browser when it is published");
  if (o.dry_run) return dryOut(ctx, r);
  if (r.problems.length) failWith(ctx, r);
  let uploaded = false;
  if (!same) { await uploadSim(ctx, {code: fw.code, vcode, local}); uploaded = true; }
  return simAnswer(ctx, vcode, {uploaded, files: uploaded ? local.files.map(f => f.path) : [], wait: !o.no_wait && !(same && version.simulator?.status !== "unchecked")});
}

/** sim check VCODE: the simulator version's state; waits while the checker has not opened it; --again asks for another check. */
export async function simCheck(ctx) {
  const o = ctx.flags;
  const vcode = ctx.args.VCODE;
  if (o.again) {
    const {firmware} = await ctx.client.get("/versions/" + enc(vcode));
    await ctx.client.post(`/firmware/${enc(firmware.code)}/versions/${enc(vcode)}/simulator/check`, {status: "unchecked"});
    ctx.say("Asked the checker to open it again.");
  }
  return simAnswer(ctx, vcode, {wait: !o.no_wait});
}

async function simAnswer(ctx, vcode, {uploaded = false, files = undefined, wait = true} = {}) {
  const o = ctx.flags;
  let version = (await ctx.client.get("/versions/" + enc(vcode))).version;
  if (wait && version.simulator?.status === "unchecked" && version.status === "published") version = await waitSim(ctx, vcode, {timeout: o.timeout ?? 600, poll: o.poll ?? 5});
  const state = simState(ctx, version, {uploaded, ...(files ? {uploaded_files: files} : {})});
  const json = {...state, version: {code: version.code, version: version.version, status: version.status}};
  const text = simLine(ctx, state, vcode) + (state.status === "unchecked" && version.status !== "published"
    ? `\n  (${version.version} is ${version.status}: its checks open the simulator version when it is published)` : "");
  if (state.status === "fails") {
    throw new CliError("simulator_fails", `The simulator version of ${version.version} (${vcode}) does not boot: ${state.report?.detail ?? "it did not say it was ready within 15 s"}`,
      {exit: EXIT.refused, hint: "Open it yourself to see why (the build must post {\"cardenza_sim\":\"ready\"} to its parent): fix, build and upload it again, or check it again",
        data: {simulator: state}, next: [ctx.run(["sim", "check", vcode, "--again"])]});
  }
  if (state.status === "unchecked" && wait && version.status === "published") {
    throw new CliError("still_checking", `The simulator version of ${version.version} (${vcode}) is not checked yet`, {exit: EXIT.later,
      hint: "The checker opens it soon; run the same command again later", data: {simulator: state}, next: [ctx.run(["sim", "check", vcode])]});
  }
  if (state.status === "none") return {json, text, exit: EXIT.ok};
  const hal = state.hal?.version ?? (typeof state.hal?.commit === "string" && state.hal.commit !== "unknown" ? state.hal.commit.slice(0, 7) : null);
  return {json, text: text + (state.status === "boots" && hal ? `\n  built with CardenzaHAL ${hal}${state.toolchain?.emscripten ? ", Emscripten " + state.toolchain.emscripten : ""}` : "")};
}

// A version as 203c answers it: what an agent needs, not the whole check log.
function compactVersion(v) {
  return {code: v.code, version: v.version, channel: v.channel, status: v.status, build: v.build, published: v.published, notes: v.notes,
    source_commit: v.source_commit, warnings: v.warnings, check: v.check ? {status: v.check.status, failed: (v.check.steps ?? []).filter(s => s.status === "fail")} : null,
    targets: (v.targets ?? []).map(t => ({target: t.target, size: t.size, sha256: t.sha256, url: t.url, project: t.diagnosis?.project_name ?? null,
      app_version: t.diagnosis?.app_version ?? null, hal: t.diagnosis?.hal ?? null, fits_launcher: t.diagnosis?.fits_launcher ?? null}))};
}

async function targetsKnown(ctx) {
  try { return (await ctx.client.get("/targets")).items.map(t => t.target); } catch { return [...Object.keys(DEVICES), ...Object.keys(UF2_DEVICES)]; }
}
// Each device as GET /targets describes it (format esp or uf2, a UF2 device's family and size), by target.
async function targetsInfo(ctx) {
  try { return Object.fromEntries((await ctx.client.get("/targets")).items.map(t => [t.target, t])); } catch { return {}; }
}

// One of your firmware by name: the firmware (full), or null (a problem when several match).
async function findMine(ctx, r, name, {flag, quiet} = {}) {
  const same = text => String(text ?? "").trim().toLowerCase();
  let hits = null;
  try { hits = ((await ctx.client.get("/firmware/lookup", {name: String(name).slice(0, 64)})).items ?? []).filter(f => f.can?.release !== false && f.owner?.id === ctx.me?.id); }
  catch { hits = null; }
  const mine = hits && hits.length ? hits : await allPages(ctx, "/me/firmware", {}, 3);
  if (!hits || !hits.length) hits = mine.filter(f => same(f.name) === same(name));
  if (hits.length > 1) {
    r.problem("usage", `You have ${hits.length} firmware named "${name}": say which by its code`, {exit: EXIT.usage, field: flag,
      hint: hits.map(f => `${f.code} (${f.visibility}, updated ${String(f.updated).slice(0, 10)})`).join(", "),
      next: hits.slice(0, 3).map(f => ctx.cmd({remove: ["name", "firmware"], add: {firmware: f.code}}))});
    return null;
  }
  if (!hits.length) {
    const close = mine.find(f => nearest(name, [f.name]));
    if (close && !quiet) ctx.note(`you have ${close.name} (${close.code}): is that the one?`);
    if (close && quiet) r.warn("similar_name", `You have a firmware named ${close.name} (${close.code}); "${name}" makes a new one`, {hint: "If you meant yours, publish to it",
      next: [ctx.cmd({remove: ["name"], add: {firmware: close.code}})]});
    return null;
  }
  return await ctx.client.get("/firmware/" + enc(hits[0].code));
}

async function waitForChecks(ctx, fwCode, version, {timeout, poll}) {
  const until = Date.now() + timeout * 1000;
  const started = Date.now();
  let last = "";
  while (version.status === "checking") {
    const step = version.check?.status ?? "queued";
    if (step !== last) { ctx.say(`  checks: ${step} (${Math.round((Date.now() - started) / 1000)} s)`); last = step; }
    if (Date.now() >= until) {
      throw new CliError("still_checking", `The checks of ${version.version} (${version.code}) did not finish within ${timeout} seconds`, {exit: EXIT.later,
        hint: "They go on without you. Run the same command again later (it picks up where it is), or look at the version", data: {version: {code: version.code, status: version.status}},
        next: [ctx.cmd({}), ctx.run(["versions", "check", version.code])]});
    }
    await new Promise(resolve => setTimeout(resolve, poll * 1000));
    version = (await ctx.client.get("/versions/" + enc(version.code))).version;
  }
  ctx.say(`  checks: ${version.check?.status ?? version.status} (${Math.round((Date.now() - started) / 1000)} s)`);
  return version;
}

function rejection(ctx, fw, version, label) {
  const steps = version.check?.steps ?? [];
  const failed = steps.filter(s => s.status === "fail");
  const log = String(version.check?.log ?? "").split("\n").filter(Boolean);
  const tail = log.slice(-12).join("\n");
  const lines = failed.map(s => `${s.name}${s.target ? " (" + s.target + ")" : ""}: ${s.detail}`);
  const next = [ctx.run(["versions", "check", version.code]),
    ctx.cmd({set: {version: nextVersion(label)}}),
    ctx.run(["versions", "appeal", version.code, "--message", "<why the check is wrong: 10-2000 characters>"])];
  return new CliError("rejected", `The checks sent ${fw.name} ${label} (${version.code}) back: ${lines.join("; ") || "see its report"}`, {exit: EXIT.rejected,
    hint: "It is not published. A real failure (a panic, a boot loop, too large): fix it and publish the next version. The emulator has no display, keys, audio or Wi-Fi: " +
      "if it only fails for want of them, appeal (it is a false positive).",
    data: {version: {code: version.code, version: label, channel: version.channel, status: version.status}, failed, log_tail: tail, report: `versions check ${version.code}`},
    next});
}

// ---------------------------------------------------------------------------------------------
// The page checklist

function checklistOf(ctx, fw, newestStable) {
  const code = fw.code;
  const run = (...words) => ctx.run(["firmware", ...words]);
  const stable = fw.latest?.stable;
  // The cover (COMMUNITY.md "Covers"): a stable version needs one (else publish stops with cover_required). A
  // picture of its own is best; a fork's original's (shown with the Fork badge) or the screen after boot count, and
  // say what shows now with the command for its own (`better`).
  const coverNow = fw.cover ? null : fw.inherited_cover ? `it shows ${fw.inherited_cover.from?.name ?? "its original"}'s cover, marked Fork`
    : fw.screen ? "it shows the screen after boot" : null;
  return [
    {item: "a summary that says what it does (≤ 100 characters)", ok: !!fw.summary && !summaryRepeatsName(fw.summary, fw.name), fix: run("edit", code, "--summary", "<one line: what it does>")},
    {item: "a cover (a 16:9 picture; a stable version needs one)", ok: !!(fw.cover || fw.inherited_cover || fw.screen), before_stable: fw.kind !== "launcher",
      fix: run("cover", code, "cover.png"), ...(coverNow ? {now: coverNow, better: run("cover", code, "cover.png")} : {})},
    {item: `a description of 80 characters or more (what it is, how to use it, the keys)${(fw.description ?? "").trim() && (fw.description ?? "").trim().length < 80 ? `: it has ${(fw.description ?? "").trim().length}` : ""}`,
      ok: (fw.description ?? "").trim().length >= 80, fix: run("edit", code, "--description-file", "docs/page.md")},
    {item: "a category tag (" + FIRMWARE_CATEGORIES.join(", ") + ")", ok: (fw.tags ?? []).some(t => FIRMWARE_CATEGORIES.includes(t)), fix: run("edit", code, "--tags", "groovebox")},
    {item: "a source link", ok: !!fw.source_url, fix: run("edit", code, "--source-url", "<https link to the source>")},
    {item: "a clone link (.git)", ok: !!fw.clone_url, fix: run("edit", code, "--clone-url", "<https link ending in .git>")},
    {item: "a stable version", ok: !!stable, fix: ctx.run(["publish", "--firmware", code, "--bin", "build/app.bin", "--dry-run"])},
    ...(newestStable?.channel === "stable" ? [{item: "release notes on the newest stable version", ok: !!(newestStable.notes ?? "").trim(),
      fix: ctx.run(["versions", "edit", newestStable.code, "--notes-file", "CHANGELOG.md"])}] : []),
    {item: "built with CardenzaHAL (no warning tag)", ok: !(fw.warnings ?? []).includes("no_hal"), fix: null},
  ];
}

export async function checklist(ctx) {
  const code = ctx.args.CODE;
  const fw = await ctx.client.get("/firmware/" + enc(code));
  let stable = null;
  if (fw.latest?.stable) { try { stable = (await ctx.client.get("/versions/" + enc(fw.latest.stable.code))).version; } catch { /* hidden */ } }
  const items = checklistOf(ctx, fw, stable).map(i => i.ok ? {...i, fix: null} : i);
  const missing = items.filter(i => !i.ok);
  return {json: {firmware: {code, name: fw.name, url: firmwareUrl(ctx, code)}, complete: !missing.length, items, next: missing.map(i => i.fix).filter(Boolean)},
    text: [`${fw.name} (${code}) — ${firmwareUrl(ctx, code)}`, ...items.map(i => `  ${i.ok ? "✓" : "✗"} ${i.item}${!i.ok && i.fix ? "\n      → " + i.fix : ""}` +
      `${i.ok && i.better ? `\n      (${i.now}; one of its own: ${i.better})` : ""}`),
      missing.length ? `${missing.length} to do.` : "Everything a good page has."].join("\n")};
}

// ---------------------------------------------------------------------------------------------
// Uploads of works, sound packs, projects and models: checked first; --dry-run stops there (web builds:
// the sim commands above).

async function officialFirmware(ctx, r, given, {flag = "firmware"} = {}) {
  const parsed = normalizeCode(given);
  if (parsed.error) { r.problem("usage", parsed.error, {exit: EXIT.usage, field: flag, hint: parsed.hint + " The official firmware's code: firmware list --official", next: [ctx.run(["firmware", "list", "--official"])]}); return null; }
  let fw;
  try { fw = await ctx.client.get("/firmware/" + enc(parsed.code)); } catch (error) {
    if (error instanceof ApiError && ["not_found", "deleted", "password_required"].includes(error.code)) {
      r.problem("not_found", `No firmware has the code ${parsed.code}`, {field: flag, hint: "Sounds, projects and works go with an official firmware", next: [ctx.run(["firmware", "list", "--official"])]});
      return null;
    }
    throw error;
  }
  if (!fw.official) {
    let officials = [];
    try { officials = (await ctx.client.get("/firmware", {official: 1})).items.filter(f => f.kind !== "launcher"); } catch { /* none */ }
    r.problem("official_only", `${fw.name} (${parsed.code}) is a community firmware: sounds, projects and works are only for official firmware (for now)`, {field: flag,
      hint: officials.length ? "Official: " + officials.map(f => `${f.code} ${f.name}`).join(", ") : "List them: firmware list --official",
      next: officials.length === 1 ? [ctx.cmd({set: {firmware: officials[0].code}})] : [ctx.run(["firmware", "list", "--official"])]});
    return null;
  }
  return {...fw, code: parsed.code};
}

export async function dryRunUpload(ctx, kind, {then = false} = {}) {
  const r = newReport(ctx);
  const o = ctx.flags;
  const account = await me(ctx, r);
  const section = {work: "works", sound: "sounds", project: "projects", model: "models"}[kind];
  if (section) {
    try {
      const listed = (await ctx.client.get("/sections")).items.find(x => x.id === section);
      if (listed && listed.open === false && account?.role === "admin") {
        r.warn("section_closed", `The ${listed.label} section is not open yet: as an admin you prepare it; others see nothing there until it opens`,
          {hint: "Open it when it is ready", next: [ctx.run(["admin", "section-set", section, "--open"])]});
      } else if (listed && listed.open === false) {
        r.problem("section_closed", `The ${listed.label} section is not open yet: only admins can share there for now`, {exit: EXIT.refused,
          hint: "Nothing to fix on your side: it opens later (sections shows which are open). Keep the files; share them when it is open."});
      }
    } catch { /* the server decides */ }
  }
  const files = (ctx.args.FILE === undefined ? [] : [].concat(ctx.args.FILE)).filter(Boolean);
  const tagsMax = {work: 5, sound: 8, project: 8, model: 8}[kind];
  let tags;
  if (o.tags !== undefined && tagsMax) {
    const parsed = normalizeTags(o.tags, tagsMax);
    if (parsed.error) r.problem("invalid", parsed.error, {field: "tags", exit: EXIT.usage, hint: parsed.hint});
    else tags = parsed.tags;
  }
  const title = o.title;
  if (typeof title === "string" && (title.trim().length < 1 || title.length > 80)) {
    r.problem("invalid", `The title is ${title.length} characters: 1-80`, {field: "title", exit: EXIT.usage, ...(title.length > 80 ? {next: [ctx.cmd({set: {title: shorten(title, 80)}})]} : {})});
  }
  let args = null, describe = "";
  if (kind === "work") {
    const local = readLocal(ctx, r, files[0], {what: "The work", flag: "FILE"});
    const report = local ? inspectWork(local.bytes, local.rel) : null;
    for (const p of report?.problems ?? []) r.problem(p.code === "work.too_large" ? "too_large" : "wrong_file", p.message, {field: "FILE", hint: p.hint});
    const fw = await officialFirmware(ctx, r, o.firmware);
    if (fw && o.version) await versionOf(ctx, r, fw, o.version);
    if (report) describe = `${report.kind} ${local.rel} (${size(local.bytes.length)}, ${report.mime})`;
    r.step(`share the work "${title ?? path.basename(files[0] ?? "", path.extname(files[0] ?? ""))}": ${describe} made with ${fw?.name ?? o.firmware}`);
    args = {file: local?.abs, title, description: o.description, tags, firmware: fw?.code, version: o.version, version_label: o.version_label};
  } else if (kind === "sound" || kind === "project") {
    const entries = [];
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const fileKind = {".ccpreset": "preset", ".ccproj": "project", ".wav": "sample"}[ext];
      if (!fileKind || (kind === "sound" && fileKind === "project") || (kind === "project" && fileKind === "preset")) {
        r.problem("wrong_file", `${file}: ${kind === "sound" ? "a sound pack takes .ccpreset banks and .wav samples" : "a project takes one .ccproj and its .wav samples"}`, {field: "FILE",
          hint: ext === ".ccproj" ? "A .ccproj is a project: projects upload" : ext === ".ccpreset" ? "A .ccpreset is a sound bank: sounds upload" :
            [".mp3", ".ogg"].includes(ext) ? "A recording to listen to goes in --preview" : "Copy the files from the card's CardenzaSynth folder"});
        continue;
      }
      const local = readLocal(ctx, r, file, {what: "The file", flag: "FILE"});
      if (local) entries.push({name: path.basename(file), kind: fileKind, bytes: local.bytes, abs: local.abs});
    }
    if (o.preview) {
      const local = readLocal(ctx, r, o.preview, {what: "The preview", flag: "preview"});
      if (local) entries.push({name: path.basename(o.preview), kind: "preview", bytes: local.bytes, abs: local.abs});
    }
    const report = inspectPack(kind, entries, {engine: o.engine});
    for (const p of report.problems) {
      if (p.code === "pack.no_engine") r.problem("usage", p.message, {field: "engine", exit: EXIT.usage, hint: p.hint, next: [ctx.cmd({set: {engine: "sampler"}})]});
      else if (p.code === "pack.engine_mismatch") r.problem("invalid", p.message, {field: "engine", exit: EXIT.usage, hint: p.hint, next: [ctx.cmd({remove: ["engine"]})]});
      else r.problem(p.code === "pack.too_large" || p.code === "pack.total" ? "too_large" : "invalid", p.message, {field: p.code === "pack.preview" ? "preview" : "FILE", hint: p.hint});
    }
    for (const w of report.warnings) r.warn(w.code, w.message, {hint: w.hint});
    const fw = await officialFirmware(ctx, r, o.firmware);
    if (fw && o.version) await versionOf(ctx, r, fw, o.version);
    if (!o.preview) r.warn("no_preview", "No --preview: people cannot listen before downloading", {hint: "Record a short demo (.mp3, .ogg or .wav) and add --preview demo.mp3"});
    describe = kind === "sound" ? `${report.engine ?? "?"} sound pack: ${report.presets ?? 0} presets in ${entries.filter(e => e.kind === "preset").length} bank(s), ${entries.filter(e => e.kind === "sample").length} sample(s)`
      : `project (format ${report.format ?? "?"}, ${report.bpm ?? "?"} BPM) with ${entries.filter(e => e.kind === "sample").length} sample(s)`;
    r.step(`share "${title}": ${describe}${o.preview ? ", preview " + path.basename(o.preview) : ""} for ${fw?.name ?? o.firmware}`);
    args = {files: entries.filter(e => e.kind !== "preview").map(e => e.abs), title, firmware: fw?.code, tags, description: ctx.text("description"),
      version: o.version, preview: entries.find(e => e.kind === "preview")?.abs, preview_ms: o.preview_ms, ...(kind === "sound" ? {engine: o.engine} : {bpm: o.bpm})};
  } else if (kind === "model") {
    const licence = o.license;
    if (licence && !LICENSES.includes(licence)) {
      const fixed = LICENSES.find(l => l.toLowerCase() === String(licence).toLowerCase()) ?? nearest(licence, LICENSES);
      r.problem("invalid", `"${licence}" is not a licence the community takes`, {field: "license", exit: EXIT.usage, hint: "Licences: " + LICENSES.join(", "),
        next: fixed ? [ctx.cmd({set: {license: fixed}})] : []});
    }
    const entries = [];
    let total = 0;
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const format = {".stl": "stl", ".step": "step", ".stp": "step", ".3mf": "3mf", ".obj": "obj"}[ext];
      if (!format) { r.problem("wrong_file", `${file}: a model file is .stl, .step/.stp, .3mf or .obj`, {field: "FILE", hint: "Export the model in one of them"}); continue; }
      const local = readLocal(ctx, r, file, {what: "The model file", flag: "FILE", max: LIMITS.model.file});
      if (!local) continue;
      total += local.bytes.length;
      const type = modelType(local.bytes);
      const want = {stl: ["stl"], step: ["step"], "3mf": ["zip"], obj: ["text"]}[format];
      if (!want.includes(type)) r.problem("wrong_file", `${file} is not ${format.toUpperCase()} inside`, {field: "FILE", hint: "Export it again"});
      entries.push({file, format, local});
    }
    if (files.length > LIMITS.model.files) r.problem("invalid", `${files.length} files: at most 10`, {field: "FILE"});
    if (total > LIMITS.model.total) r.problem("too_large", `The files are ${size(total)} together: at most 200 MB`, {field: "FILE"});
    const hasStl = entries.some(e => e.format === "stl");
    if (!o.preview && !hasStl && entries.length) r.problem("usage", "Only an STL is its own preview: give --preview mesh.stl|mesh.glb and --thumbnail picture.png", {exit: EXIT.usage, field: "preview",
      hint: "Export an STL (or GLB) of the model for the 3D preview, and a 640x480 PNG"});
    if (o.preview && ![".stl", ".glb"].includes(path.extname(o.preview).toLowerCase())) r.problem("usage", "--preview is an .stl or .glb mesh", {exit: EXIT.usage, field: "preview"});
    if (o.thumbnail) {
      const local = readLocal(ctx, r, o.thumbnail, {what: "The thumbnail", flag: "thumbnail", max: LIMITS.model.thumbnail});
      if (local && !(local.bytes[0] === 0x89 && local.bytes[1] === 0x50)) r.problem("wrong_file", "--thumbnail is a PNG picture", {field: "thumbnail"});
    } else if (!hasStl && (o.preview ?? "").toLowerCase().endsWith(".glb")) r.problem("usage", "203c draws thumbnails only from an STL: give --thumbnail picture.png", {exit: EXIT.usage, field: "thumbnail"});
    if (o.target) {
      const known = await targetsKnown(ctx);
      if (known.includes(String(o.target).toLowerCase())) o.target = String(o.target).toLowerCase();
      else r.problem("invalid", `"${o.target}" is not a device`, {field: "target", exit: EXIT.usage, hint: "Devices: " + known.join(", "),
        next: nearest(o.target, known) ? [ctx.cmd({set: {target: nearest(o.target, known)}})] : []});
    }
    describe = entries.map(e => `${path.basename(e.file)} (${e.format}, ${size(e.local.bytes.length)})`).join(", ");
    r.step(`share the model "${title}": ${describe}, licence ${licence}`);
    const print = {};
    if (o.material) print.material = o.material;
    if (o.layer_height !== undefined) print.layer_height_mm = o.layer_height;
    if (o.infill !== undefined) print.infill_percent = o.infill;
    if (o.supports) print.supports = true;
    if (o.print_notes) print.notes = o.print_notes;
    args = {files: entries.map(e => e.local.abs), title, license: licence, description: ctx.text("description"), tags, target: o.target, firmware: o.firmware,
      remix_of: o.remix_of, preview: o.preview ? path.resolve(ctx.cwd, o.preview) : undefined, thumbnail: o.thumbnail ? path.resolve(ctx.cwd, o.thumbnail) : undefined,
      ...(Object.keys(print).length ? {print} : {})};
  }
  if (!then) return dryOut(ctx, r);
  if (r.problems.length) failWith(ctx, r);
  const op = {work: "work_upload", sound: "sound_upload", project: "project_upload", model: "model_upload"}[kind];
  ctx.say(`Uploading ${describe || "…"}`);
  const answer = await ctx.op(op, args);
  const url = {work: "/w/", sound: "/sound/", project: "/project/", model: "/model/"}[kind];
  return {json: withAdvice(answer, r), text: (url && answer.id ? `Shared "${answer.title}": ${siteOf(ctx.api)}${url}${answer.id} (id ${answer.id})\n` : JSON.stringify(answer, null, 2) + "\n") + adviceText(r).trimEnd()};
}

async function versionOf(ctx, r, fw, given) {
  const parsed = normalizeCode(given);
  if (parsed.error) { r.problem("usage", parsed.error, {field: "version", exit: EXIT.usage, hint: parsed.hint + " (--version takes a version CODE here; --version-label a name)"}); return; }
  try {
    const answer = await ctx.client.get("/versions/" + enc(parsed.code));
    if (answer.firmware?.code !== fw.code) r.problem("invalid", `${parsed.code} is a version of ${answer.firmware?.name}, not of ${fw.name}`, {field: "version",
      next: [ctx.run(["versions", "list", fw.code])]});
  } catch (error) {
    if (error instanceof ApiError && error.code !== "unreachable") r.problem("not_found", `No version has the code ${parsed.code}`, {field: "version", next: [ctx.run(["versions", "list", fw.code])]});
    else throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// init: 203.json from what the project already says (COMMUNITY.md "The project file 203.json").

export async function init(ctx) {
  const o = ctx.flags;
  const existing = findProjectFile(ctx.cwd);
  const here = path.join(ctx.cwd, PROJECT_FILE);
  if (fs.existsSync(here) && !o.force) {
    throw new CliError("needs_force", "203.json is already here", {exit: EXIT.confirm, hint: "Edit it, or add --force to write it again", next: [ctx.cmd({add: {force: true}})]});
  }
  // The earlier 203c.json is moved over (its keys into 203.json's).
  const legacy = existing?.legacy && path.dirname(existing.file) === ctx.cwd ? JSON.parse(fs.readFileSync(existing.file, "utf8")) : {};
  const account = await ctx.client.get("/me").catch(() => null);
  const found = findAppImages([path.join(ctx.cwd, "build"), ctx.cwd]);
  const bins = {...(legacy.bins ?? {})};
  if (legacy.bin) bins[DEFAULT_TARGET] = legacy.bin;
  for (const entry of o.bin ?? []) {
    const at = String(entry).indexOf("=");
    bins[at > 0 ? entry.slice(0, at) : DEFAULT_TARGET] = at > 0 ? entry.slice(at + 1) : entry;
  }
  if (!Object.keys(bins).length && found[0]) bins[DEFAULT_TARGET] = path.relative(ctx.cwd, found[0].path);
  const fromBin = found[0] ? inspectBin(new Uint8Array(fs.readFileSync(found[0].path)), {}) : {};
  const txt = versionTxt(ctx.cwd);
  const tag = txt ? null : gitTagVersion(ctx.cwd);
  const page = remotePage(ctx.cwd) ?? legacy.source_url ?? null;
  const license = o.license ?? licenseOf(ctx.cwd);
  let fw = null;
  const code = o.firmware ?? legacy.firmware ?? null;
  if (code) {
    const parsed = normalizeCode(code);
    if (parsed.error) throw ctx.usage(parsed.error, {field: "firmware", hint: parsed.hint});
    try { fw = await ctx.client.get("/firmware/" + enc(parsed.code)); } catch { fw = null; }
  }
  const tags = o.tags ?? legacy.tags;
  const project = {
    format: 1,
    name: o.name ?? fw?.name ?? legacy.name ?? cmakeProjectName(ctx.cwd) ?? fromBin.project ?? path.basename(ctx.cwd),
    code: fw?.code ?? (code ? normalizeCode(code).code : null),
    ...(txt ? {} : {version: legacy.version ?? tag ?? fromBin.version ?? "0.1.0"}),
    ...(account ? {author: account.name} : {}),
    ...(o.summary ?? fw?.summary ?? legacy.summary ? {summary: o.summary ?? fw?.summary ?? legacy.summary} : {}),
    ...(tags?.length ? {tags} : fw?.tags?.length ? {tags: fw.tags} : {}),
    devices: Object.keys(bins).length ? Object.keys(bins) : [DEFAULT_TARGET],
    ...(page ? {source: page} : {}),
    ...(license ? {license} : {}),
    forked_from: fw?.forked_from?.code ? {code: fw.forked_from.code, version: fw.forked_from.version?.version ?? null} : null,
    publish_source: !!o.publish_source,
    publish: {
      channel: o.channel ? normalizeChannel(o.channel).channel ?? "stable" : legacy.channel ?? "stable",
      ...(Object.keys(bins).length ? {bins} : {}),
      ...(legacy.notes_file ? {notes_file: legacy.notes_file} : fs.existsSync(path.join(ctx.cwd, "CHANGELOG.md")) ? {notes_file: "CHANGELOG.md"} : {}),
      // A cover picture the project has (COMMUNITY.md "Covers": a stable version needs one).
      ...(legacy.cover ? {cover: legacy.cover} : (() => {
        const found = ["docs/cover.png", "docs/cover.jpg", "docs/cover.webp", "cover.png", "cover.jpg", "cover.webp"].find(f => fs.existsSync(path.join(ctx.cwd, f)));
        return found ? {cover: found} : {};
      })()),
      ...(legacy.description_file ? {description_file: legacy.description_file} : {}),
      ...(legacy.project ? {project: legacy.project} : {}),
      ...(legacy.sim ? {sim: legacy.sim} : {}),
    },
  };
  const problems = checkProject(project);
  if (problems.length) throw new CliError("invalid", problems[0].error, {exit: EXIT.usage, hint: problems[0].hint ?? "Give it with a flag (init --help)"});
  const todo = [];
  if (!project.summary) todo.push('"summary": one line (≤ 100 characters) saying what it does');
  if (!project.publish.bins) todo.push('"publish.bins": {"cardenza": "build/<project>.bin"} (build the firmware first)');
  if (!project.publish.notes_file) todo.push('a CHANGELOG.md with a "## <version>" entry per release ("publish.notes_file")');
  if (!project.publish.cover && !project.forked_from) todo.push('a cover: a 16:9 picture (1280x720 PNG/JPEG/WebP, ≤ 2 MB) at docs/cover.png ("publish.cover"); a stable version needs one');
  if (!project.license) todo.push('"license": the SPDX identifier of your LICENSE (MIT, Apache-2.0, GPL-3.0-only, …)');
  if (!project.source) todo.push('"source": the repository\'s https page (its clone link is derived)');
  if (txt) todo.push(`(the version is ${txt.file}'s: ${txt.value})`);
  writeProject(here, project);
  if (existing?.legacy && Object.keys(legacy).length) ctx.note(`moved ${path.basename(existing.file)} into 203.json; delete ${path.basename(existing.file)} when you have checked it`);
  return {json: {written: here, project, todo, next: [ctx.run(["publish", "--dry-run"])]},
    text: `Wrote ${here}:\n${JSON.stringify(project, null, 2)}\n${todo.length ? "Still to do:\n" + todo.map(t => "  - " + t).join("\n") + "\n" : ""}Commit it with the source. Then check: ${ctx.run(["publish", "--dry-run"], {json: false})}`};
}

// ---------------------------------------------------------------------------------------------
// fork / clone: a firmware's source to change, bound to your fork so that publish from inside it
// goes there (git config 203c.firmware in the clone).

const SCRIPT = fileURLToPath(new URL("./203c.mjs", import.meta.url));
// A command that works from any folder (the next step is often run inside the clone).
const anywhere = (ctx, words) => [...(ctx.prog === "203c" ? ["203c"] : ["node", SCRIPT.includes(" ") ? `'${SCRIPT}'` : SCRIPT]), ...words,
  ...(ctx.api !== (process.env.COMMUNITY_API || DEFAULT_API).replace(/\/+$/, "") ? ["--api", ctx.api] : []), ...(ctx.json ? ["--json"] : [])].join(" ");

function git(args, {cwd, quiet = true} = {}) {
  try {
    const run = spawnSync("git", args, {cwd, encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"],
      env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
    if (run.error) return {missing: run.error.code === "ENOENT", status: -1, stderr: String(run.error.message)};
    return {status: run.status, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim()};
  } catch (error) { return {status: -1, stderr: error.message}; }
}
function gitConfig(dir, key) {
  const got = git(["config", "--get", key], {cwd: dir});
  return got.status === 0 && got.stdout ? got.stdout : null;
}

// The clone link of a firmware, else of its nearest ancestor that has one: {url, from: {code, name}} or null.
async function cloneSource(ctx, fw) {
  if (fw.clone_url) return {url: fw.clone_url, from: {code: fw.code, name: fw.name}};
  for (const ancestor of [...(fw.lineage ?? [])].reverse()) {
    if (!ancestor.code) continue;
    try {
      const parent = await ctx.client.get("/firmware/" + enc(ancestor.code));
      if (parent.clone_url) return {url: parent.clone_url, from: {code: parent.code, name: parent.name}};
    } catch { /* hidden or deleted: the next one up */ }
  }
  return null;
}

export async function forkFirmware(ctx) {
  const r = newReport(ctx);
  const o = ctx.flags, code = ctx.args.CODE;
  const account = await me(ctx, r);
  let parent = null;
  try { parent = await ctx.client.get("/firmware/" + enc(code)); } catch (error) {
    if (!(error instanceof ApiError) || !["not_found", "deleted", "password_required"].includes(error.code)) throw error;
    r.problem("not_found", error.code === "password_required" ? `${code} is a private firmware: unlock it first` : `No firmware has the code ${code}`,
      {hint: "Never guess a code: search or list", next: [ctx.run(["search", code])]});
  }
  if (parent?.kind === "launcher") launcherRefused(ctx, r, account, {fork: code});
  if (parent && account && parent.owner?.id === account.id && !o.new) {
    r.problem("usage", `${parent.name} (${code}) is yours: no fork needed`, {exit: EXIT.usage, hint: "Clone its source and publish to it directly",
      next: [anywhere(ctx, ["clone", code])]});
  }
  // Yours already? (a fork made before: forks are found, not made twice)
  let existing = null;
  if (parent && account && !o.new) existing = (await allPages(ctx, "/me/firmware", {}, 3)).find(f => f.forked_from?.code === code) ?? null;
  const name = o.name ?? forkNameOf(parent?.name ?? code, account?.name ?? "fork");
  const summary = o.summary ?? shorten(`${parent?.name ?? code} with my changes`, 100);
  if (!existing && parent) {
    for (const [flag, value] of [["name", name], ["summary", summary]]) r.placeholder(flag, value);
    if (summary.length > 100) r.problem("invalid", `The summary is ${summary.length} characters: at most 100`, {field: "summary", exit: EXIT.usage, next: [ctx.cmd({set: {summary: shorten(summary, 100)}})]});
  }
  const source = parent ? await cloneSource(ctx, parent) : null;
  if (existing) r.step(`use your fork ${existing.name} (${existing.code}), made before (--new makes another)`);
  else if (parent) r.step(`fork ${parent.name} (${code}) as "${name}"${o.private ? " (private)" : ""}`);
  if (ctx.args.DIR ?? o.clone ?? (source && !o.no_clone && git(["rev-parse", "--is-inside-work-tree"], {cwd: ctx.cwd}).stdout !== "true")) r.step(`clone ${source?.url ?? "(no source bound)"} into ${ctx.args.DIR ?? o.clone ?? defaultDir(source.url)} and write its 203.json (forked_from ${code})`);
  const priv = o.private ? privacy(ctx, r, {private: true, password: o.password}, {creating: true}) : {};
  if (o.dry_run) return dryOut(ctx, r);
  if (r.problems.length) failWith(ctx, r);
  let fork = existing;
  if (!fork) {
    ctx.say(`Forking ${parent.name}…`);
    fork = await ctx.client.post("/firmware", {name, summary, visibility: "public", ...priv, forked_from: code});
  }
  // Inside a clone bound to the parent: now bound to the fork.
  if (gitConfig(ctx.cwd, "203c.firmware") === code) {
    git(["config", "203c.firmware", fork.code], {cwd: ctx.cwd});
    ctx.note(`this clone now publishes to your fork ${fork.code} (git config 203c.firmware)`);
  }
  let cloned = null;
  const into = ctx.args.DIR ?? o.clone;
  // Cloned by itself unless --no-clone, or when run inside a repository already (its own source, rebound above).
  const insideRepo = git(["rev-parse", "--is-inside-work-tree"], {cwd: ctx.cwd}).stdout === "true";
  if (into || (source && !o.no_clone && !insideRepo)) cloned = await cloneInto(ctx, fork, into, source);
  // The clone's 203.json: the fork's code and what it was made from (COMMUNITY.md "Fork provenance").
  let written = null;
  if (cloned) written = writeForkProject(ctx, cloned.dir, {fork, parent, account});
  const next = cloned ? [`cd ${cloned.dir}`, anywhere(ctx, ["publish", "--dry-run"])]
    : [source ? anywhere(ctx, ["clone", fork.code]) : null, anywhere(ctx, ["firmware", "edit", fork.code, "--clone-url", "<https link of your repository, ending in .git>"])].filter(Boolean);
  const json = {status: existing ? "exists" : "forked", fork: {code: fork.code, name: fork.name, url: firmwareUrl(ctx, fork.code)},
    parent: {code, name: parent.name}, clone_url: source?.url ?? null, clone_from: source?.from ?? null, ...(cloned ? {cloned} : {}),
    ...(written ? {project_file: written} : {}), notes: ctx.notes, next};
  const lines = [`${existing ? "Your fork" : "Forked"}: ${fork.name}, code ${fork.code} (${firmwareUrl(ctx, fork.code)})`,
    source ? `Source to change: ${source.url}${source.from.code !== fork.code ? ` (${source.from.name}'s)` : ""}` : `${parent.name} has no source bound (no clone link): ask its owner, or start from your own code`,
    ...(cloned ? [`Cloned into ${cloned.dir}; publish from there goes to ${fork.code}.`] : []),
    ...(written ? [`Wrote ${written.file}: "code": "${fork.code}", "forked_from": ${JSON.stringify(written.project.forked_from)} (commit it).`] : []),
    "Next:", ...next.map(n => "  " + n),
    "When your changes are in your own repository: firmware edit " + fork.code + " --source-url … --clone-url ….git"];
  return {json, text: lines.join("\n")};
}

export async function cloneFirmware(ctx) {
  const r = newReport(ctx);
  const code = ctx.args.CODE;
  let fw;
  try { fw = await ctx.client.get("/firmware/" + enc(code)); } catch (error) {
    if (error instanceof ApiError && ["not_found", "deleted", "password_required"].includes(error.code)) {
      throw new CliError("not_found", error.code === "password_required" ? `${code} is private: unlock it first` : `No firmware has the code ${code}`,
        {hint: "Never guess a code", next: [ctx.run(["search", code])]});
    }
    throw error;
  }
  const source = await cloneSource(ctx, fw);
  if (!source) {
    throw new CliError("no_clone_url", `${fw.name} (${code}) has no source to clone: its owner bound no repository (no clone link)` +
      (fw.source_url ? `; its source page is ${fw.source_url}` : ""), {exit: EXIT.refused,
      hint: fw.can?.edit ? "It is yours: bind your repository first" : "Ask its owner to add a clone link, or start from your own code",
      next: fw.can?.edit ? [ctx.run(["firmware", "edit", code, "--clone-url", "<https link of your repository, ending in .git>"])] : []});
  }
  if (ctx.flags.dry_run) {
    r.step(`git clone ${source.url} into ${ctx.args.DIR ?? defaultDir(source.url)}${source.from.code !== code ? ` (${source.from.name}'s source: ${fw.name} has none of its own)` : ""}`);
    r.step(`bind it to ${code}: publish from inside goes to ${fw.name}`);
    return dryOut(ctx, r);
  }
  const cloned = await cloneInto(ctx, fw, ctx.args.DIR, source);
  const yours = !!fw.can?.release;
  const next = [`cd ${cloned.dir}`, yours ? anywhere(ctx, ["publish", "--dry-run"]) : anywhere(ctx, ["fork", code])];
  return {json: {status: "cloned", firmware: {code, name: fw.name}, dir: cloned.dir, clone_url: source.url, clone_from: source.from, bound: code, yours, notes: ctx.notes, next},
    text: [`Cloned ${source.url} into ${cloned.dir}.`, yours ? `Publish from there goes to ${fw.name} (${code}).` : `${fw.name} is not yours: fork it to publish your changes (inside the clone: ${anywhere(ctx, ["fork", code])}).`,
      "Next:", ...next.map(n => "  " + n)].join("\n")};
}

const defaultDir = url => path.basename(String(url).replace(/\/+$/, "")).replace(/\.git$/, "") || "firmware";

async function cloneInto(ctx, fw, dirGiven, source) {
  const dir = path.resolve(ctx.cwd, dirGiven ?? defaultDir(source.url));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (gitConfig(dir, "203c.firmware")) {
      git(["config", "203c.firmware", fw.code], {cwd: dir});
      ctx.note(`${dir} is already a clone: bound to ${fw.code} now`);
      return {dir, url: source.url, reused: true};
    }
    throw new CliError("usage", `${dir} exists and is not empty`, {exit: EXIT.usage, hint: "Give another folder (clone CODE DIR)", next: [ctx.cmd({args: {DIR: path.basename(dir) + "-2"}})]});
  }
  ctx.say(`git clone ${source.url} ${dir}`);
  const done = git(["clone", source.url, dir], {cwd: ctx.cwd, quiet: ctx.json});
  if (done.missing) throw new CliError("unavailable", "git is not installed", {exit: EXIT.refused, hint: "Install git, then run the same command again", next: [ctx.cmd({})]});
  if (done.status !== 0) {
    const gone = /not found|could not read Username|Authentication failed|terminal prompts disabled|does not exist/i.test(done.stderr ?? "");
    throw new CliError("clone_failed", `git clone ${source.url} failed${done.stderr ? ": " + done.stderr.split("\n").pop() : ""}`, {exit: gone ? EXIT.refused : EXIT.later,
      hint: gone ? "The repository does not exist or is private (git asked for a sign-in): tell the firmware's owner its clone link does not work; with access, sign git in and run it again"
        : "Check the network, then run the same command again", next: gone ? [] : [ctx.cmd({})]});
  }
  git(["config", "203c.firmware", fw.code], {cwd: dir});
  return {dir, url: source.url};
}

// ---------------------------------------------------------------------------------------------
// me edit

export async function editMe(ctx) {
  const o = ctx.flags;
  const body = {};
  if (o.name !== undefined) {
    const name = String(o.name).trim().replace(/\s+/g, " ");
    if (isPlaceholder(name) || !/^[\p{L}\p{N}_.-]+( [\p{L}\p{N}_.-]+)*$/u.test(name) || name.length < 2 || name.length > 24) {
      throw new CliError("invalid", `"${o.name}" cannot be a name`, {exit: EXIT.usage, field: "name", hint: "2-24 letters, digits, Chinese characters, _ - . (single spaces inside), unique"});
    }
    body.name = name;
  }
  const bio = ctx.text("bio");
  if (bio !== undefined) {
    if (bio.length > 300) throw new CliError("invalid", `The bio is ${bio.length} characters: at most 300`, {exit: EXIT.usage, field: "bio", next: [ctx.cmd({set: {bio: shorten(bio, 300)}, remove: ["bio-file"]})]});
    body.bio = bio;
  }
  if (o.avatar !== undefined) {
    const avatar = String(o.avatar).toLowerCase().replace(/^a?(\d)$/, "a0$1").replace(/^(\d\d)$/, "a$1");
    if (!/^a(0[1-9]|1\d|2[0-4])$/.test(avatar)) throw new CliError("invalid", `"${o.avatar}" is not an avatar`, {exit: EXIT.usage, field: "avatar", hint: "a01 … a24 (the site's avatars)"});
    body.avatar = avatar;
  }
  if (!Object.keys(body).length) throw ctx.usage("Nothing to change: --name, --bio or --avatar", {next: [ctx.run(["me", "edit", "--help"], {json: false})]});
  const account = await ctx.op("me_update", body);
  return {json: account, text: `${account.name} (${account.id}): ${Object.keys(body).join(", ")} changed.`};
}

// The 203.json of a fork's clone: the original's (when it has one) with the fork's code, name and
// author, and forked_from the original and its newest stable version.
function writeForkProject(ctx, dir, {fork, parent, account}) {
  const file = path.join(dir, PROJECT_FILE);
  let base = {};
  try { base = JSON.parse(fs.readFileSync(file, "utf8")); } catch { base = {}; }
  const project = {format: 1, ...base, name: fork.name, code: fork.code, ...(account ? {author: account.name} : {}),
    summary: base.summary && base.summary !== parent.summary ? base.summary : fork.summary ?? base.summary,
    forked_from: {code: parent.code, version: parent.latest?.stable?.version ?? base.version ?? null}};
  if (base.source && base.source === parent.source_url) delete project.source;   // the original's repository is not the fork's
  if (!project.devices) project.devices = parent.targets?.length ? parent.targets : [DEFAULT_TARGET];
  try { writeProject(file, project); } catch (error) { ctx.note(`could not write ${file}: ${error.message}`); return null; }
  return {file, project};
}

// ---------------------------------------------------------------------------------------------
// firmware based-on: what a firmware of yours was made from, after the fact (and its 203.json).

export async function basedOn(ctx) {
  const r = newReport(ctx);
  const o = ctx.flags, code = ctx.args.CODE, originGiven = String(ctx.args.ORIGIN);
  const fw = await firmwareFor(ctx, r, code, {need: "edit"});
  let origin = null, versionCode = null;
  const clearing = /^(none|null|-)$/i.test(originGiven);
  if (!clearing) {
    const parsed = normalizeCode(originGiven);
    if (parsed.error) throw ctx.usage(parsed.error + " (ORIGIN is a firmware or version code, or none)", {field: "ORIGIN", hint: parsed.hint});
    try { origin = await ctx.client.request("GET", "/firmware/" + enc(parsed.code), {headers: o.unlock ? {"X-Firmware-Unlock": o.unlock} : {}}); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // A version code: its firmware.
      try { const v = await ctx.client.get("/versions/" + enc(parsed.code)); origin = v.firmware; versionCode = parsed.code; }
      catch { r.problem(error.code === "password_required" ? "password_required" : "not_found", `${parsed.code}: ${error.message}`, {field: "ORIGIN",
        hint: error.code === "password_required" ? "A private original: firmware unlock CODE --password …, then --unlock" : "Never guess a code: search"}); }
    }
    if (origin && o.version && !versionCode) {
      try { versionCode = (await ctx.client.get(`/firmware/${enc(origin.code)}/versions/${enc(o.version)}`)).code; }
      catch { r.problem("not_found", `${origin.name} has no version ${o.version}`, {field: "version", hint: `versions list ${origin.code}`}); }
    }
  }
  r.step(clearing ? `record ${fw?.name ?? code} as an original (based on nothing)` : `record ${fw?.name ?? code} as made from ${origin?.name ?? originGiven}${o.version ? " " + o.version : ""}`);
  if (o.dry_run) {
    if (fw && !r.problems.length) {
      try { await ctx.client.request("POST", `/firmware/${enc(code)}/edit`, {query: {dry_run: 1}, body: {forked_from: clearing ? null : versionCode ?? origin?.code},
        headers: o.unlock ? {"X-Firmware-Unlock": o.unlock} : {}}); }
      catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) r.problem(error.code, "The server would refuse it: " + error.message, {field: error.data?.field}); }
    }
    return dryOut(ctx, r);
  }
  if (r.problems.length) failWith(ctx, r);
  const changed = await ctx.op("firmware_based_on", {code, from: clearing ? null : versionCode ?? origin.code, unlock: o.unlock});
  // The project file here, when it is this firmware's.
  const found = findProjectFile(ctx.cwd);
  if (found && !found.legacy) {
    try {
      const data = JSON.parse(fs.readFileSync(found.file, "utf8"));
      if (normalizeCode(data.code ?? "").code === normalizeCode(code).code) {
        data.forked_from = clearing ? null : {code: origin.code, version: changed.forked_from?.version?.version ?? o.version ?? null};
        writeProject(found.file, data);
        ctx.note(`saved "forked_from" in ${path.relative(ctx.cwd, found.file) || found.file}`);
      }
    } catch { /* the server has it */ }
  }
  const from = changed.forked_from;
  return {json: {status: "changed", firmware: {code: changed.code, name: changed.name}, forked_from: from, lineage: changed.lineage},
    text: from ? `${changed.name} (${changed.code}) is now made from ${from.name ?? from.code}${from.version ? " " + from.version.version : ""}.` : `${changed.name} (${changed.code}) is an original now.`};
}

// ---------------------------------------------------------------------------------------------
// source check / upload: the source archive of a project (source.mjs).

function archiveOf(ctx, dir) {
  const found = findProjectFile(dir);
  let name = null;
  try { name = found && !found.legacy ? JSON.parse(fs.readFileSync(found.file, "utf8")).name : null; } catch { name = null; }
  const made = makeArchive(found?.dir ?? dir, {name});
  if (made.error) throw new CliError("source_unavailable", made.error, {exit: EXIT.refused, hint: made.hint});
  return made;
}

export async function sourceCheck(ctx) {
  const dir = path.resolve(ctx.cwd, ctx.args.DIR ?? ".");
  const made = archiveOf(ctx, dir);
  const i = made.inspected;
  const json = {ok: !i.problem && made.bytes.length <= MAX_ARCHIVE, commit: made.commit, root: made.root, files: i.entries, size: made.bytes.length,
    sha256: made.sha256, dirty: made.dirty, submodules: made.submodules, problem: i.problem, secret_files: i.files, reasons: i.reasons ?? {},
    largest: (i.list ?? []).sort((a, b) => b.size - a.size).slice(0, 5)};
  const lines = [`Source archive of ${made.root} at ${made.commit.slice(0, 12)}: ${i.entries} files, ${size(made.bytes.length)} (at most 16 MB)`];
  if (i.problem) lines.push(`✗ ${i.problem}:`, ...i.files.map(f => `    ${f}${i.reasons?.[f] ? "  (" + i.reasons[f] + ")" : ""}`),
    "  Remove them from git (git rm --cached FILE, add them to .gitignore; a secret that was ever pushed must be revoked and replaced).");
  if (made.bytes.length > MAX_ARCHIVE) lines.push(`✗ larger than 16 MB: keep build output and large binaries out of git`);
  if (made.dirty) lines.push("! uncommitted changes are not in it (it is the commit)");
  if (made.submodules.length) lines.push(`- submodules are not in it: ${made.submodules.join(", ")}`);
  if (json.ok) lines.push("✓ nothing looks secret: it can be published");
  return {json, text: lines.join("\n"), exit: json.ok ? EXIT.ok : EXIT.refused};
}

export async function sourceUpload(ctx) {
  const r = newReport(ctx);
  const vcode = ctx.args.VCODE;
  const dir = path.resolve(ctx.cwd, ctx.args.DIR ?? ".");
  let answer;
  try { answer = await ctx.client.get("/versions/" + enc(vcode)); } catch (error) {
    if (error instanceof ApiError && ["not_found", "deleted"].includes(error.code)) throw new CliError("not_found", `No version has the code ${vcode}`, {hint: "versions list CODE"});
    throw error;
  }
  const fw = answer.firmware, version = answer.version;
  if (!fw.owner || fw.owner.id !== (await ctx.client.get("/me")).id) r.problem("not_yours", `${fw.name} is not yours: only its owner attaches its source`, {});
  const made = archiveOf(ctx, dir);
  if (made.inspected.problem) r.problem("source_secrets", made.inspected.problem + ": " + made.inspected.files.join(", "), {data: {files: made.inspected.files},
    hint: "Remove them from git (git rm --cached FILE, .gitignore; revoke any secret that was pushed), commit, run again", next: [ctx.run(["source", "check"])]});
  if (made.bytes.length > MAX_ARCHIVE) r.problem("too_large", `The source archive is ${size(made.bytes.length)}: at most 16 MB`, {hint: "Keep build output and large binaries out of git"});
  if (made.dirty && !ctx.flags.force) r.problem("needs_force", `Uncommitted changes are not in the archive (it is the commit ${made.commit.slice(0, 12)})`, {exit: EXIT.confirm,
    hint: "Commit first; or --force to attach the commit as it is", next: [ctx.cmd({add: {force: true}})]});
  if (version.source_commit && !made.commit.startsWith(version.source_commit)) r.warn("source_commit", `${fw.name} ${version.version} was built from ${version.source_commit}, the archive is ${made.commit.slice(0, 12)}`);
  if (version.source?.sha256 === made.sha256) {
    return {json: {status: "already", version: vcode, sha256: made.sha256}, text: `${fw.name} ${version.version} already has this source archive.`};
  }
  r.step(`attach the source archive of ${made.commit.slice(0, 12)} (${made.inspected.entries} files, ${size(made.bytes.length)}) to ${fw.name} ${version.version} (${vcode})`);
  if (ctx.flags.dry_run) return dryOut(ctx, r, {json: {files: made.inspected.entries, size: made.bytes.length, sha256: made.sha256, commit: made.commit}});
  if (r.problems.length) failWith(ctx, r);
  const done = await uploadSource(ctx.client, fw.code, vcode, made.bytes, made.sha256);
  return {json: {status: "attached", version: vcode, ...done, commit: made.commit},
    text: `Attached the source archive (${done.files} files, ${size(done.size)}) to ${fw.name} ${version.version}; it is on the firmware page.`};
}

// ---------------------------------------------------------------------------------------------
// rules: the firmware project rules (CardenzaHAL's docs/FIRMWARE-PROJECT.md), the copy in the skill or the site's.

const RULES_FILE = fileURLToPath(new URL("../reference/firmware-project.md", import.meta.url));
export async function rules(ctx) {
  let text = null, from = RULES_FILE;
  if (ctx.flags.online) {
    const site = String(ctx.api).replace(/\/+$/, "").replace(/\/api$/, "");
    from = site + "/develop.md";
    try { const response = await fetch(from); if (response.ok) text = await response.text(); } catch { text = null; }
    if (!text) ctx.note(`could not fetch ${from}: the copy in the skill`);
  }
  if (!text) { from = RULES_FILE; try { text = fs.readFileSync(RULES_FILE, "utf8"); } catch { text = null; } }
  if (!text) throw new CliError("not_found", "The rules are not in this copy of the skill", {hint: "Reinstall the skill, or: 203c rules --online"});
  return {json: {from, text}, text};
}
