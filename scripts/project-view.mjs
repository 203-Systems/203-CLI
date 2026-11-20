// Everything the community has about the project's firmware (203.json's code, or CODE), read-only, for the developer and
// the AI working on it (the user, 2026-11-18: "绑定项目可以获取该项目的社区页面所发，用户所发的需求跟评论等等。方便AI知道用户提出了
// 什么建议。也方便获取Fork找不同。"):
//   project show      the page: name, summary, description, tags, links, cover and screen, counts, newest versions
//   project versions  every version with its notes, status, checks and source archive (paged)
//   project feedback  requests (votes, status, answered, their discussion) and comments with every reply and like, merge
//                     requests; each marked new since the last look and with the version that was newest when written
//   project forks     the forks (魔改版) of it, forks of forks too: base version, newest versions, counts
//   project diff      two sources compared, file by file (--patch: the unified diff): this folder, a version of this
//                     firmware (label or code), a fork (its newest source archive, else its repository)
//   sync              all of it in one report for an agent: .203/community.md and .203/community.json in the project
// The last look is kept per firmware: .203/state.json in the project (git-ignored), else ~/.config/203cli/inbox/CODE.json.
// Only the API's existing read operations. Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {tokenFile} from "./lib.mjs";
import {PROJECT_FILE, findProjectFile} from "./project.mjs";
import {siteOf} from "./sim.mjs";
import {normalizeCode} from "./checks.mjs";
import {CliError, EXIT} from "./guide.mjs";

export const day = when => (when ? String(when).slice(0, 16).replace("T", " ") : "");
const short = (text, n = 280) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const votesOf = v => (v && typeof v === "object" ? v.score ?? (v.up ?? 0) - (v.down ?? 0) : v ?? 0);
const after = (when, since) => !!since && !!when && Date.parse(when) > Date.parse(since);
const safe = promise => promise.catch(error => ({error}));

// ---------------------------------------------------------------------------------------------
// The firmware a command is about, and the last look

/** The firmware the command is about: CODE, else 203.json's code. {code, project: {file, dir, data} | null} */
export function whichFirmware(ctx, given) {
  const found = findProjectFile(ctx.cwd);
  const data = found && !found.legacy ? JSON.parse(fs.readFileSync(found.file, "utf8")) : null;
  const raw = given ?? data?.code;
  if (!raw) {
    throw new CliError("no_firmware", found ? `${PROJECT_FILE} has no code yet: the firmware is made by its first publish` : `No ${PROJECT_FILE} here or above, and no CODE given`,
      {exit: EXIT.usage, hint: found ? "Publish the first version (publish --dry-run, then publish), or link it to a firmware you have" : "Run it in the project's folder, or give the firmware's code",
        next: found ? [ctx.run(["publish", "--dry-run"]), ctx.run(["firmware", "mine"])] : [ctx.run(["firmware", "mine"])]});
  }
  const parsed = normalizeCode(raw);
  if (parsed.error) throw ctx.usage(parsed.error, {field: "CODE", hint: parsed.hint});
  return {code: parsed.code, project: found ? {...found, data} : null};
}

function cursorPath(code, project) {
  return project ? path.join(project.dir, ".203", "state.json") : path.join(path.dirname(tokenFile()), "inbox", code + ".json");
}
export function readCursor(code, project) {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(code, project), "utf8"));
    return project ? data[code] ?? null : data;
  } catch { return null; }
}
export function writeCursor(code, project, value) {
  const file = cursorPath(code, project);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; }
  if (project) data[code] = {...(data[code] ?? {}), ...value};
  else data = {...data, ...value};
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
/** --since: last (the last look), all (none), or a date. */
function sinceOf(ctx, code, project, flag = "since") {
  const raw = ctx.flags[flag];
  if (raw === undefined || raw === "last") return readCursor(code, project)?.seen ?? null;
  if (raw === "all") return null;
  if (!Number.isFinite(Date.parse(raw))) throw ctx.usage(`--${flag} is last, all or a date (2026-11-01, 2026-11-01T10:00Z)`, {field: flag});
  return new Date(Date.parse(raw)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// What the API has, as stable shapes

async function allPages(load, {max = 5} = {}) {
  const items = [];
  for (let page = 1; page <= max; page++) {
    const got = await load(page);
    items.push(...(got.items ?? []));
    if (!got.items?.length || items.length >= (got.total ?? Infinity) || got.items.length < (got.page_size ?? 24)) break;
  }
  return items;
}

const versionShape = v => ({code: v.code, version: v.version, channel: v.channel, status: v.status ?? "published",
  published: v.published ?? null, created: v.created ?? null, notes: v.notes ?? "",
  targets: (v.targets ?? []).map(t => t.target ?? t).filter(Boolean),
  source: v.source ? {url: v.source.url, size: v.source.size, files: v.source.files ?? null} : null,
  check: v.check ? {status: v.check.status ?? null, failed: (v.check.steps ?? []).filter(s => s.status === "fail" || s.ok === false).map(s => s.name ?? s.step)} : null});

function pageShape(ctx, fw) {
  return {code: fw.code, name: fw.name, page: `${siteOf(ctx.api)}/${fw.code}`, summary: fw.summary ?? "", description: fw.description ?? "",
    tags: fw.tags ?? [], license: fw.license ?? null, visibility: fw.visibility ?? "public", official: !!fw.official,
    owner: fw.owner ? {id: fw.owner.id, name: fw.owner.name} : null,
    forked_from: fw.forked_from?.code ? {code: fw.forked_from.code, name: fw.forked_from.name ?? null, version: fw.forked_from.version?.version ?? fw.forked_from.version ?? null} : null,
    source_url: fw.source_url ?? null, clone_url: fw.clone_url ?? null,
    cover_url: fw.cover?.url ? new URL(fw.cover.url, ctx.api + "/").href : null, screen_url: fw.screen?.url ? new URL(fw.screen.url, ctx.api + "/").href : null,
    counts: fw.counts ?? {}, latest: Object.fromEntries(Object.entries(fw.latest ?? {}).filter(([, v]) => v).map(([k, v]) => [k, {code: v.code, version: v.version, published: v.published ?? null}])),
    channels: fw.channels ?? null, warnings: fw.warnings ?? [], created: fw.created ?? null, updated: fw.updated ?? null,
    source_archive: fw.source_archive ? {version: fw.source_archive.version?.version ?? null, url: fw.source_archive.url, files: fw.source_archive.files ?? null} : null};
}

/** The version that was the newest published one when something was written (what a remark most likely refers to). */
function versionAt(versions) {
  const published = versions.filter(v => v.status === "published" && (v.published || v.created))
    .map(v => ({version: v.version, at: Date.parse(v.published || v.created)})).sort((a, b) => a.at - b.at);
  return when => {
    const t = Date.parse(when);
    let found = null;
    for (const v of published) if (v.at <= t) found = v.version;
    return found;
  };
}

async function loadPage(ctx, code) {
  const fw = await ctx.op("firmware_show", {code});
  const versions = (await safe(allPages(page => ctx.op("versions_list", {code, page}), {max: 4})));
  return {fw, versions: Array.isArray(versions) ? versions.map(versionShape) : [], problems: versions?.error ? [versions.error.message] : []};
}

async function loadFeedback(ctx, code, {fw, versions, since, threads = true}) {
  const me = ctx.client.token ? await safe(ctx.op("whoami", {})) : null;
  const ownerId = fw.owner?.id ?? null;
  const owner = !!(me && !me.error && ownerId && me.id === ownerId);
  const at = versionAt(versions);
  const problems = [];
  const byOwner = author => !!(ownerId && author?.id === ownerId);
  // Requests: the tracker's for the owner (status, progress), the public list for anyone else.
  let raw = await safe(allPages(page => owner ? ctx.op("dev_requests", {firmware: code, sort: "updated", page}) : ctx.op("requests_list", {code, sort: "new", page}), {max: 5}));
  if (raw.error) { problems.push(`requests: ${raw.error.message}`); raw = []; }
  const requests = [];
  for (const r of raw) {
    const request = {number: r.number, title: r.title, body: r.body ?? "", author: r.author?.name ?? null, created: r.created, edited: r.edited ?? null,
      votes: votesOf(r.votes), comments: r.comments ?? 0, status: r.internal?.status ?? null, progress: r.internal?.progress ?? null, labels: r.internal?.labels ?? [],
      version_at: at(r.created), new: after(r.created, since), answered: null, discussion: []};
    if (threads && request.comments > 0 && requests.filter(q => q.discussion.length).length < 30) {
      const got = await safe(owner ? ctx.op("dev_request_read", {code, number: r.number}) : ctx.op("comments_list", {kind: "request", ref: `${code}/${r.number}`}));
      const list = got.error ? [] : owner ? got.discussion ?? [] : got.items ?? [];
      request.discussion = list.map(c => commentShape(c, {at, since, byOwner}));
      request.answered = request.discussion.some(c => c.by_owner);
    }
    request.new_comments = request.discussion.filter(c => c.new).length;
    request.read = ctx.run(owner ? ["dev", "read", code, String(r.number)] : ["requests", "show", code, String(r.number)]);
    request.answer = ctx.run(["comments", "add", "request", `${code}/${r.number}`, "--body", "…"]);
    if (owner) request.mark = ctx.run(["dev", "update", code, String(r.number), "--status", "planned"]);
    requests.push(request);
  }
  // Comments on the firmware: every thread with all its replies.
  let top = await safe(allPages(page => ctx.op("comments_list", {kind: "firmware", ref: code, page}), {max: 5}));
  if (top.error) { problems.push(`comments: ${top.error.message}`); top = []; }
  const comments = [];
  for (const c of top) {
    let replies = c.replies ?? [];
    if (threads && (c.reply_count ?? 0) > replies.length) {
      const all = await safe(allPages(page => ctx.op("comment_replies", {id: c.id, page}), {max: 5}));
      if (!all.error) replies = all;
    }
    const thread = commentShape({...c, replies}, {at, since, byOwner});
    thread.answered = thread.by_owner || thread.replies.some(r => r.by_owner);
    thread.answer = ctx.run(["comments", "add", "firmware", code, "--parent", String(c.id), "--body", "…"]);
    comments.push(thread);
  }
  let merges = await safe(ctx.op("merges_list", {code, status: "all"}));
  if (merges.error) { problems.push(`merges: ${merges.error.message}`); merges = {items: []}; }
  return {owner, problems, requests, comments,
    merges: (merges.items ?? []).map(m => ({number: m.number, title: m.title, status: m.status, from: m.from?.code ?? null, from_name: m.from?.name ?? null,
      author: m.author?.name ?? null, created: m.created, updated: m.updated ?? null, comments: m.comments ?? 0, new: after(m.created, since) || after(m.updated, since),
      show: ctx.run(["merges", "show", code, String(m.number)])}))};
}

function commentShape(c, {at, since, byOwner}) {
  return {id: c.id, author: c.author?.name ?? null, by_owner: byOwner(c.author), created: c.created, edited: c.edited ?? null, body: c.deleted ? "" : c.body ?? "",
    deleted: !!c.deleted, likes: c.likes ?? 0, version_at: at(c.created), new: after(c.created, since),
    ...(c.replies ? {replies: c.replies.map(r => commentShape(r, {at, since, byOwner}))} : {})};
}

async function loadForks(ctx, code) {
  const items = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const got = await ctx.client.get("/firmware", {family: code, forks: 1, section: "all", sort: "new", limit: 60, ...(cursor ? {cursor} : {})});
    items.push(...(got.items ?? []));
    cursor = got.next_cursor;
    if (!cursor) break;
  }
  return items.filter(f => f.code !== code).map(f => ({code: f.code, name: f.name, owner: f.owner?.name ?? null,
    base: f.forked_from?.code ? {code: f.forked_from.code, version: f.forked_from.version?.version ?? f.forked_from.version ?? null} : null,
    latest: Object.fromEntries(Object.entries(f.latest ?? {}).filter(([, v]) => v).map(([k, v]) => [k, v.version])),
    counts: f.counts ?? {}, updated: f.updated ?? null, summary: f.summary ?? "", diff: ctx.run(["project", "diff", f.code])}));
}

// ---------------------------------------------------------------------------------------------
// Commands

export async function projectShow(ctx) {
  const {code} = whichFirmware(ctx, ctx.args.CODE);
  const {fw, versions, problems} = await loadPage(ctx, code);
  const page = pageShape(ctx, fw);
  const shown = versions.slice(0, 10);
  return {json: {firmware: page, versions: shown, more_versions: Math.max(0, versions.length - shown.length), ...(problems.length ? {incomplete: problems} : {})},
    text: pageMarkdown(page, shown)};
}

export async function projectVersions(ctx) {
  const {code} = whichFirmware(ctx, ctx.args.CODE);
  const got = await ctx.op("versions_list", {code, channel: ctx.flags.channel, page: ctx.flags.page});
  const items = (got.items ?? []).map(versionShape);
  return {json: {firmware: code, page: got.page ?? 1, total: got.total ?? items.length, items},
    text: items.map(versionLine).join("\n\n") + `\n\n(page ${got.page ?? 1}, ${got.total ?? items.length} versions${(got.total ?? 0) > (got.page ?? 1) * 24 ? `: --page ${(got.page ?? 1) + 1} for more` : ""})`};
}

export async function projectFeedback(ctx) {
  const {code, project} = whichFirmware(ctx, ctx.args.CODE);
  const since = sinceOf(ctx, code, project);
  const {fw, versions} = await loadPage(ctx, code);
  const feedback = await loadFeedback(ctx, code, {fw, versions, since, threads: !ctx.flags.no_threads});
  const only = !!ctx.flags.new;
  const pick = list => only ? list.filter(x => x.new || x.new_comments || x.replies?.some(r => r.new)) : list;
  const result = {firmware: {code, name: fw.name}, since, owner: feedback.owner, requests: pick(feedback.requests), comments: pick(feedback.comments),
    merges: pick(feedback.merges), ...(feedback.problems.length ? {incomplete: feedback.problems} : {})};
  return {json: result, text: feedbackMarkdown(result)};
}

export async function projectForks(ctx) {
  const {code} = whichFirmware(ctx, ctx.args.CODE);
  const forks = await loadForks(ctx, code);
  return {json: {firmware: code, total: forks.length, items: forks}, text: forksMarkdown(code, forks)};
}

export async function sync(ctx) {
  const o = ctx.flags;
  const {code, project} = whichFirmware(ctx, ctx.args.CODE);
  const since = sinceOf(ctx, code, project);
  const now = new Date().toISOString();
  const {fw, versions, problems} = await loadPage(ctx, code);
  const feedback = await loadFeedback(ctx, code, {fw, versions, since});
  const forks = await safe(loadForks(ctx, code));
  const report = {checked: now, since, firmware: pageShape(ctx, fw), versions, owner: feedback.owner,
    requests: feedback.requests, comments: feedback.comments, merges: feedback.merges, forks: forks.error ? [] : forks,
    new: {requests: feedback.requests.filter(r => r.new).length, request_comments: feedback.requests.reduce((n, r) => n + (r.new_comments ?? 0), 0),
      comments: feedback.comments.reduce((n, c) => n + (c.new ? 1 : 0) + (c.replies ?? []).filter(r => r.new).length, 0),
      merges: feedback.merges.filter(m => m.new).length},
    ...([...problems, ...feedback.problems, ...(forks.error ? [`forks: ${forks.error.message}`] : [])].length
      ? {incomplete: [...problems, ...feedback.problems, ...(forks.error ? [`forks: ${forks.error.message}`] : [])]} : {})};
  const dir = path.resolve(ctx.cwd, o.out ? String(o.out) : project ? path.join(project.dir, ".203") : ".203");
  fs.mkdirSync(dir, {recursive: true});
  const md = syncMarkdown(report);
  fs.writeFileSync(path.join(dir, "community.md"), md);
  fs.writeFileSync(path.join(dir, "community.json"), JSON.stringify(report, null, 2) + "\n");
  if (!o.no_mark) writeCursor(code, project, {seen: now});
  const n = report.new;
  return {json: {status: "synced", firmware: {code, name: fw.name}, since, files: {markdown: path.join(dir, "community.md"), json: path.join(dir, "community.json")}, new: n,
      counts: {versions: versions.length, requests: report.requests.length, comments: report.comments.length, merges: report.merges.length, forks: report.forks.length}},
    text: `Wrote ${path.join(dir, "community.md")} (and community.json): ${fw.name} (${code}), ${versions.length} versions, ${report.requests.length} requests, ` +
      `${report.comments.length} comment threads, ${report.forks.length} forks.\nNew since ${since ? day(since) : "ever"}: ${n.requests} requests, ${n.request_comments} request comments, ${n.comments} comments, ${n.merges} merge requests.`};
}

// ---------------------------------------------------------------------------------------------
// diff: two sources, file by file

/** The files of a .tar.gz (git archive's: one top folder, stripped) into `dir`. */
export function untarGz(bytes, dir) {
  const tar = zlib.gunzipSync(bytes, {maxOutputLength: 256 * 1024 * 1024});
  const cString = b => b.toString("utf8").split("\0")[0];
  const octal = b => parseInt(cString(b).trim() || "0", 8);
  let at = 0, paxPath = null, longName = null, files = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = cString(body); continue; }
    if (type === "x" || type === "g") { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8")); if (type === "x" && m) paxPath = m[1]; continue; }
    const prefix = cString(header.subarray(345, 500));
    const name = paxPath ?? longName ?? (prefix ? prefix + "/" : "") + cString(header.subarray(0, 100));
    paxPath = null; longName = null;
    if (!["0", "\0"].includes(type)) continue;
    const rel = name.split("/").slice(1).join("/");
    if (!rel || rel.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(rel)) continue;
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, body);
    files++;
  }
  return files;
}

function git(args, cwd) {
  const run = spawnSync("git", args, {cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300000, env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  if (run.error) return {status: -1, missing: run.error.code === "ENOENT", stdout: "", stderr: String(run.error.message)};
  return {status: run.status, stdout: run.stdout ?? "", stderr: String(run.stderr ?? "").trim()};
}

/** A side of a diff into `dir`: {label, kind, ...}. ref: local (this folder's tracked and new files), a version of `code`, or a fork. */
async function materialize(ctx, ref, {code, project, dir}) {
  fs.mkdirSync(dir, {recursive: true});
  if (ref === "local") {
    const root = project?.dir ?? ctx.cwd;
    const list = git(["ls-files", "-co", "--exclude-standard", "-z"], root);
    if (list.status !== 0) throw new CliError(list.missing ? "git_missing" : "not_a_repository", list.missing ? "git is not installed" : `${root} is not a git repository`, {exit: EXIT.refused,
      hint: "diff compares this folder's git files; give two versions or a fork instead (project diff 1.0.0 1.1.0)"});
    let n = 0;
    for (const rel of list.stdout.split("\0").filter(Boolean)) {
      const from = path.join(root, rel);
      if (rel.startsWith(".203/") || !fs.existsSync(from) || !fs.statSync(from).isFile()) continue;   // submodules, deleted files
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(from, to);
      n++;
    }
    return {ref, kind: "local", label: `this folder (${root})`, files: n};
  }
  const parsed = normalizeCode(ref);
  let version = null, fork = null;
  if (!parsed.error) {
    const what = await ctx.op("code", {code: parsed.code}).catch(() => null);
    if (what?.kind === "version") version = await ctx.op("version_show", {version_code: parsed.code});
    else fork = await ctx.op("firmware_show", {code: parsed.code});
  } else {
    version = await ctx.op("version_by_label", {code, label: String(ref).replace(/^v(?=\d)/, "")}).catch(() => null);
    if (!version) throw new CliError("not_found", `No version ${ref} of ${code} and no firmware or version with that code`, {exit: EXIT.refused,
      hint: "A version label (1.4.0) or code of this firmware, a fork's code (project forks lists them), or local", next: [ctx.run(["project", "versions"]), ctx.run(["project", "forks"])]});
  }
  const fetchArchive = async (url, label) => {
    const response = await ctx.client.fetch(new URL(url, ctx.api + "/").href);
    if (!response.ok) throw new CliError("download_failed", `${label}: the source archive did not download (HTTP ${response.status})`, {exit: EXIT.later, next: [ctx.cmd()]});
    return untarGz(Buffer.from(await response.arrayBuffer()), dir);
  };
  if (version) {
    const label = `${version.firmware?.name ?? code} ${version.version ?? ref}`;
    if (!version.source?.url) throw new CliError("no_source", `${label} has no source archive`, {exit: EXIT.refused,
      hint: "Versions published with publish_source: true in 203.json carry one; diff it against another version that has one, or local"});
    return {ref, kind: "version", label, code: version.code, version: version.version ?? null, files: await fetchArchive(version.source.url, label)};
  }
  const label = `${fork.name} (${fork.code})`;
  if (fork.source_archive?.url) {
    return {ref, kind: "firmware", label: `${label} ${fork.source_archive.version?.version ?? ""}`.trim(), code: fork.code, version: fork.source_archive.version?.version ?? null,
      files: await fetchArchive(fork.source_archive.url, label)};
  }
  const clone = fork.clone_source?.url ?? fork.clone_url;
  if (!clone) throw new CliError("no_source", `${label} has no source archive and no repository`, {exit: EXIT.refused, hint: "Ask its author to publish with publish_source or link the repository"});
  ctx.say(`git clone --depth 1 ${clone}…`);
  const cloned = git(["clone", "-q", "--depth", "1", clone, path.join(dir, ".clone")], dir);
  if (cloned.status !== 0) throw new CliError("clone_failed", `git clone ${clone} failed: ${cloned.stderr.split("\n").pop()}`, {exit: EXIT.later, next: [ctx.cmd()]});
  const list = git(["ls-files", "-z"], path.join(dir, ".clone")).stdout.split("\0").filter(Boolean);
  for (const rel of list) {
    const from = path.join(dir, ".clone", rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
    fs.copyFileSync(from, path.join(dir, rel));
  }
  fs.rmSync(path.join(dir, ".clone"), {recursive: true, force: true});
  return {ref, kind: "repository", label: `${label} (${clone})`, code: fork.code, files: list.length};
}

export async function projectDiff(ctx) {
  const {code, project} = whichFirmware(ctx, ctx.flags.firmware);
  const [aRef, bRef] = [ctx.args.A ?? null, ctx.args.B ?? null];
  if (!aRef) throw ctx.usage("What to compare: a fork's code, a version (label or code), or two of them", {field: "A",
    hint: "project diff FORK (a fork against this folder), project diff 1.0.0 1.1.0 (two versions), project diff 1.1.0 local", next: [ctx.run(["project", "forks"])]});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-diff-"));
  try {
    const a = await materialize(ctx, aRef, {code, project, dir: path.join(root, "a")});
    const b = await materialize(ctx, bRef ?? "local", {code, project, dir: path.join(root, "b")});
    const names = git(["-c", "core.quotepath=false", "diff", "--no-index", "--no-renames", "--name-status", "-z", "a", "b"], root);
    const stats = git(["-c", "core.quotepath=false", "diff", "--no-index", "--no-renames", "--numstat", "-z", "a", "b"], root);
    if (names.missing) throw new CliError("git_missing", "git is not installed: diff uses git diff --no-index", {exit: EXIT.refused, hint: "Install git"});
    const strip = p => p.replace(/^[ab]\//, "");
    const files = {added: [], removed: [], changed: []};
    const counts = {};
    // numstat -z: "added\tdeleted\tpath\0" (or "\0old\0new\0" for a pair)
    const s = stats.stdout.split("\0");
    for (let i = 0; i < s.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(s[i]);
      if (!m) continue;
      let p = m[3];
      if (!p) { const from = s[++i], to = s[++i]; p = to === "/dev/null" ? from : to; }
      counts[strip(p)] = {added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2])};
    }
    const n = names.stdout.split("\0");
    for (let i = 0; i + 1 < n.length; i += 2) {
      const [status, p] = [n[i], strip(n[i + 1] || "")];
      if (!status) continue;
      const c = counts[p] ?? {added: null, deleted: null};
      if (status === "A") files.added.push({path: p, lines: c.added});
      else if (status === "D") files.removed.push({path: p, lines: c.deleted});
      else files.changed.push({path: p, added: c.added, deleted: c.deleted, binary: c.added === null});
    }
    let patch = null;
    if (ctx.flags.patch) {
      patch = git(["-c", "core.quotepath=false", "diff", "--no-index", "--no-renames", "--src-prefix=", "--dst-prefix=", "a", "b"], root).stdout;
      const max = ctx.flags.max ?? 400000;
      if (patch.length > max) patch = patch.slice(0, max) + `\n… (cut at ${max} characters: --max for more)\n`;
    }
    const total = {added: files.added.length, removed: files.removed.length, changed: files.changed.length,
      lines_added: [...files.added.map(f => f.lines ?? 0), ...files.changed.map(f => f.added ?? 0)].reduce((x, y) => x + y, 0),
      lines_deleted: [...files.removed.map(f => f.lines ?? 0), ...files.changed.map(f => f.deleted ?? 0)].reduce((x, y) => x + y, 0)};
    const side = x => ({ref: x.ref, kind: x.kind, label: x.label, files: x.files, ...(x.code ? {code: x.code} : {}), ...(x.version ? {version: x.version} : {})});
    const summary = [`a: ${a.label} (${a.files} files)`, `b: ${b.label} (${b.files} files)`,
      `${total.changed} changed, ${total.added} only in b, ${total.removed} only in a; +${total.lines_added} −${total.lines_deleted} lines`, "",
      ...files.changed.map(f => `M ${f.path}${f.binary ? " (binary)" : `  +${f.added} −${f.deleted}`}`),
      ...files.added.map(f => `A ${f.path}${f.lines !== null ? `  +${f.lines}` : ""}`),
      ...files.removed.map(f => `D ${f.path}${f.lines !== null ? `  −${f.lines}` : ""}`)];
    return {json: {a: side(a), b: side(b), total, files, ...(patch !== null ? {patch} : {})},
      text: summary.join("\n") + (patch !== null ? "\n\n" + patch : total.changed + total.added + total.removed ? `\n\nThe unified diff: ${ctx.run(["project", "diff", aRef, ...(bRef ? [bRef] : []), "--patch"], {json: false})}` : "")};
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------------------------
// Text: Markdown an agent (or a person) reads

function versionLine(v) {
  const head = `### ${v.version} (${v.code}) · ${v.channel} · ${v.status}${v.published ? " · " + day(v.published) : v.created ? " · " + day(v.created) : ""}` +
    `${v.source ? ` · source ${v.source.files ?? "?"} files` : ""}${v.check?.failed?.length ? ` · checks failed: ${v.check.failed.join(", ")}` : ""}`;
  return v.notes ? `${head}\n\n${v.notes.trim()}` : head;
}

export function pageMarkdown(p, versions) {
  const lines = [`# ${p.name} (${p.code})`, "", p.summary, "", `${p.page}`,
    `Owner: ${p.owner?.name ?? "official"} · licence ${p.license ?? "?"} · tags ${p.tags.join(", ") || "none"}` +
      (p.forked_from ? ` · forked from ${p.forked_from.name ?? p.forked_from.code} (${p.forked_from.code}) ${p.forked_from.version ?? ""}` : ""),
    `Counts: ${Object.entries(p.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `Newest: ${Object.entries(p.latest).map(([k, v]) => `${k} ${v.version}`).join(", ") || "none published"}`,
    ...(p.source_url ? [`Source: ${p.source_url}`] : []), ...(p.cover_url ? [`Cover: ${p.cover_url}`] : []), ...(p.screen_url ? [`Screen: ${p.screen_url}`] : []),
    ...(p.warnings.length ? [`Warnings: ${p.warnings.join(", ")}`] : []), "", "## The page", "", p.description.trim() || "(no description)"];
  if (versions) lines.push("", "## Versions", "", ...versions.map(versionLine).flatMap(v => [v, ""]));
  return lines.join("\n").trimEnd() + "\n";
}

function threadLines(c, depth = 0) {
  const pad = "  ".repeat(depth);
  const marks = [c.new ? "new" : null, c.by_owner ? "owner" : null, c.likes ? `${c.likes} likes` : null, c.version_at ? `on ${c.version_at}` : null].filter(Boolean).join(", ");
  const out = [`${pad}- ${c.author ?? "?"}, ${day(c.created)}${marks ? ` [${marks}]` : ""}: ${c.deleted ? "(deleted)" : short(c.body, 1200)}`];
  for (const r of c.replies ?? []) out.push(...threadLines(r, depth + 1));
  return out;
}

export function feedbackMarkdown(r) {
  const lines = [`# What people say about ${r.firmware.name} (${r.firmware.code})`, "", r.since ? `New since ${day(r.since)} is marked [new].` : "Everything (no earlier look)."];
  lines.push("", `## Requests (${r.requests.length})`, "");
  if (!r.requests.length) lines.push("None.");
  for (const q of r.requests) {
    const marks = [q.new ? "new" : null, q.new_comments ? `${q.new_comments} new comment${q.new_comments > 1 ? "s" : ""}` : null,
      q.answered === true ? "answered" : q.answered === false ? "not answered" : null].filter(Boolean).join(", ");
    lines.push(`### #${q.number} ${q.title}${marks ? ` [${marks}]` : ""}`, "",
      `${q.votes} votes · ${q.comments} comments${q.status ? ` · ${q.status}${q.progress ? " " + q.progress + "%" : ""}` : ""} · ${q.author ?? "?"}, ${day(q.created)}${q.version_at ? ` · when ${q.version_at} was newest` : ""}`);
    if (q.body) lines.push("", q.body.trim());
    if (q.discussion.length) lines.push("", ...q.discussion.flatMap(c => threadLines(c)));
    lines.push("", `Read: ${q.read} · answer: ${q.answer}${q.mark ? ` · track: ${q.mark}` : ""}`, "");
  }
  lines.push(`## Comments on the firmware (${r.comments.length} threads)`, "");
  if (!r.comments.length) lines.push("None.");
  for (const c of r.comments) lines.push(...threadLines(c), `  answer: ${c.answer}${c.answered ? "" : " (not answered yet)"}`);
  if (r.merges.length) {
    lines.push("", `## Merge requests (${r.merges.length})`, "");
    for (const m of r.merges) lines.push(`- #${m.number}${m.new ? " [new]" : ""} ${m.title}: ${m.status}, from ${m.from_name ?? ""} (${m.from}) by ${m.author ?? "?"} · ${m.show}`);
  }
  if (r.incomplete) lines.push("", `(Not complete: ${r.incomplete.join("; ")})`);
  return lines.join("\n").trimEnd() + "\n";
}

export function forksMarkdown(code, forks) {
  const lines = [`# Forks of ${code} (${forks.length})`, ""];
  if (!forks.length) lines.push("None public.");
  for (const f of forks) {
    lines.push(`- ${f.name} (${f.code}) by ${f.owner ?? "?"}: from ${f.base ? `${f.base.code} ${f.base.version ?? ""}`.trim() : "?"}; newest ${Object.entries(f.latest).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ` +
      `${Object.entries(f.counts).map(([k, v]) => `${k} ${v}`).join(", ")}${f.summary ? `\n  ${short(f.summary, 200)}` : ""}\n  compare: ${f.diff}`);
  }
  return lines.join("\n") + "\n";
}

function syncMarkdown(r) {
  return [`<!-- 203cli sync, ${r.checked}: what the 203 community has about this firmware. Read it before planning changes. -->`, "",
    pageMarkdown(r.firmware, r.versions).trimEnd(), "",
    feedbackMarkdown({firmware: {code: r.firmware.code, name: r.firmware.name}, since: r.since, requests: r.requests, comments: r.comments, merges: r.merges,
      ...(r.incomplete ? {incomplete: r.incomplete} : {})}).replace(/^# .*\n/, "# What people say\n").trimEnd(), "",
    forksMarkdown(r.firmware.code, r.forks).replace(/^# Forks of \S+/, "# Forks").trimEnd(), ""].join("\n");
}
