// A project and its firmware on the community, from the project's folder (203.json):
//   inbox  what the community said since the last look: requests (votes, status, new comments), comments on the firmware,
//          merge requests, versions the checks sent back, unread notifications about it; as Markdown an agent reads
//          (--out FILE) and JSON. The last look is remembered per firmware (~/.config/203c/inbox/CODE.json).
//   link   binds the project to its firmware, or moves the binding (a repository moved, renamed, transferred, a new clone):
//          203.json's code and source, the page's source and clone links, and this repository as the trusted publisher
//          its CI publishes with (--move: the other repositories' publishers removed).
// Both only call the API's existing operations. Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {PROJECT_FILE, remotePage, writeProject, cloneUrlOf} from "./project.mjs";
import {whichFirmware, readCursor, writeCursor} from "./project-view.mjs";
import {siteOf} from "./sim.mjs";
import {CliError, EXIT} from "./guide.mjs";

const after = (when, since) => !since || (when && Date.parse(when) > Date.parse(since));
const day = when => (when ? String(when).slice(0, 16).replace("T", " ") : "");
const short = (text, n = 280) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const votesOf = v => (v && typeof v === "object" ? v.score ?? (v.up ?? 0) - (v.down ?? 0) : v ?? 0);

export async function inbox(ctx) {
  const o = ctx.flags;
  const {code, project} = whichFirmware(ctx, ctx.args.CODE);
  const state = o.all ? null : readCursor(code, project);
  const since = state?.seen ?? null;
  const now = new Date().toISOString();
  const safe = promise => promise.catch(error => ({error}));
  const [fw, requests, comments, merges, versions, notes] = await Promise.all([
    ctx.op("firmware_show", {code}),
    safe(ctx.op("dev_requests", {firmware: code, sort: "updated"})),
    safe(ctx.op("comments_list", {kind: "firmware", ref: code})),
    safe(ctx.op("merges_list", {code, status: "open"})),
    safe(ctx.op("versions_list", {code})),
    safe(ctx.op("notifications", {})),
  ]);
  const problems = [requests, comments, merges, versions, notes].filter(r => r?.error).map(r => r.error.message);
  const known = state?.requests ?? {};
  const reqs = (requests.items ?? []).filter(r => !["done", "rejected"].includes(r.internal?.status) || after(r.internal?.updated, since)).map(r => ({
    number: r.number, title: r.title, body: short(r.body), author: r.author?.name ?? null, created: r.created, votes: votesOf(r.votes), comments: r.comments ?? 0,
    status: r.internal?.status ?? "new", progress: r.internal?.progress ?? 0,
    new: after(r.created, since), new_comments: Math.max(0, (r.comments ?? 0) - (known[r.number] ?? (since ? r.comments ?? 0 : 0))),
    read: ctx.run(["dev", "read", code, String(r.number)]),
  }));
  const flat = [];
  for (const c of comments.items ?? []) {
    flat.push(c);
    for (const reply of c.replies ?? []) flat.push({...reply, parent: c.id});
  }
  const comms = flat.filter(c => !c.deleted && !c.hidden && (o.all || after(c.created, since))).map(c => ({
    id: c.id, author: c.author?.name ?? null, created: c.created, body: short(c.body, 500), ...(c.parent ? {reply_to: c.parent} : {}),
    answer: ctx.run(["comments", "add", "firmware", code, "--parent", String(c.parent ?? c.id), "--body", "…"]),
  }));
  const mrs = (merges.items ?? []).map(m => ({number: m.number, title: m.title, from: m.from?.code ?? null, author: m.author?.name ?? null, created: m.created,
    new: after(m.created, since) || after(m.updated, since), show: ctx.run(["merges", "show", code, String(m.number)])}));
  const back = (versions.items ?? []).filter(v => v.status === "rejected" && (o.all || after(v.created, since)))
    .map(v => ({code: v.code, version: v.version, channel: v.channel, created: v.created, check: ctx.run(["versions", "check", v.code])}));
  const about = (notes.items ?? []).filter(n => !n.read && String(n.subject?.ref ?? "").toUpperCase().startsWith(code))
    .map(n => ({kind: n.kind, text: short(n.text ?? n.subject?.title, 200), created: n.created, actor: n.actor?.name ?? null}));
  const counts = fw.counts ? Object.fromEntries(Object.entries(fw.counts).filter(([, v]) => typeof v === "number")) : {};
  const result = {
    firmware: {code, name: fw.name, page: `${siteOf(ctx.api)}/${code}`, counts},
    since, checked: now,
    new: {requests: reqs.filter(r => r.new).length, request_comments: reqs.reduce((n, r) => n + r.new_comments, 0), comments: comms.length,
      merges: mrs.filter(m => m.new).length, sent_back: back.length, notifications: about.length},
    requests: reqs, comments: comms, merges: mrs, sent_back: back, notifications: about,
    ...(problems.length ? {incomplete: problems} : {}),
    next: [...reqs.filter(r => r.new || r.new_comments).slice(0, 3).map(r => r.read), ...back.slice(0, 1).map(v => v.check)],
  };
  const markdown = inboxMarkdown(result);
  if (o.out) {
    const file = path.resolve(ctx.cwd, String(o.out));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, markdown);
    result.written = file;
  }
  if (!o.no_mark) {
    writeCursor(code, project, {seen: now, requests: Object.fromEntries((requests.items ?? []).map(r => [r.number, r.comments ?? 0]))});
  }
  return {json: result, text: markdown.trimEnd() + (result.written ? `\n\n(written to ${result.written})` : "")};
}

export function inboxMarkdown(r) {
  const lines = [`# ${r.firmware.name} (${r.firmware.code}) on the 203 community`, "",
    `${r.since ? `New since ${day(r.since)}` : "Everything"} · checked ${day(r.checked)} · ${r.firmware.page}`];
  const totals = Object.entries(r.firmware.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  if (totals) lines.push(totals);
  lines.push("", `## Requests (${r.new.requests} new, ${r.requests.length} open)`, "");
  if (!r.requests.length) lines.push("None.");
  for (const q of r.requests) {
    const marks = [q.new ? "new" : null, q.new_comments ? `${q.new_comments} new comment${q.new_comments > 1 ? "s" : ""}` : null].filter(Boolean).join(", ");
    lines.push(`- #${q.number}${marks ? ` [${marks}]` : ""} ${q.title}: ${q.votes} votes, ${q.comments} comments, ${q.status}${q.progress ? ` ${q.progress}%` : ""} (${q.author ?? "?"}, ${day(q.created)})`);
    if (q.body) lines.push(`  > ${q.body}`);
    lines.push(`  ${q.read}`);
  }
  lines.push("", `## Comments on the firmware (${r.comments.length}${r.since ? " new" : ""})`, "");
  if (!r.comments.length) lines.push("None.");
  for (const c of r.comments) lines.push(`- ${c.author ?? "?"}, ${day(c.created)}${c.reply_to ? ` (reply to ${c.reply_to})` : ""}: ${c.body}`, `  ${c.answer}`);
  if (r.merges.length) {
    lines.push("", `## Open merge requests (${r.merges.length})`, "");
    for (const m of r.merges) lines.push(`- #${m.number}${m.new ? " [new]" : ""} ${m.title} from ${m.from ?? "?"} (${m.author ?? "?"})`, `  ${m.show}`);
  }
  if (r.sent_back.length) {
    lines.push("", `## Versions the checks sent back (${r.sent_back.length})`, "");
    for (const v of r.sent_back) lines.push(`- ${v.version} (${v.code}, ${v.channel}): ${v.check}`);
  }
  if (r.notifications.length) {
    lines.push("", `## Unread notifications (${r.notifications.length})`, "");
    for (const n of r.notifications) lines.push(`- ${n.kind}${n.actor ? ` from ${n.actor}` : ""}: ${n.text}`);
  }
  if (r.incomplete) lines.push("", `(Some lists could not be read: ${r.incomplete.join("; ")})`);
  lines.push("", "Answer people with comments add (they are notified); track a request with dev update (internal).");
  return lines.join("\n") + "\n";
}

/** owner/name of a GitHub page, or null. */
const githubRepo = page => (/^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/i.exec(page ?? "") || [])[1] ?? null;

export async function link(ctx) {
  const o = ctx.flags;
  const {code, project} = whichFirmware(ctx, ctx.args.CODE);
  if (!project || project.legacy) {
    throw new CliError("no_project", `No ${PROJECT_FILE} here or above`, {exit: EXIT.usage, hint: "Run it in the project's folder (new or init makes 203.json)",
      next: [ctx.run(["init", "--firmware", code])]});
  }
  const [fw, me] = await Promise.all([ctx.op("firmware_show", {code}), ctx.op("whoami", {})]);
  if (fw.owner?.id !== me.id) {
    throw new CliError("not_yours", `${fw.name} (${code}) is ${fw.owner ? fw.owner.name + "'s" : "an official firmware"}, not yours`, {exit: EXIT.refused,
      hint: "A firmware cannot change hands: make your own from it (fork) and link that", next: [ctx.run(["fork", code])]});
  }
  const page = remotePage(project.dir);
  const repo = githubRepo(page);
  const workflow = o.workflow ? String(o.workflow) : fs.existsSync(path.join(project.dir, ".github/workflows/firmware.yml")) ? "firmware.yml" : null;
  const steps = [];
  const data = {...project.data};
  if (data.code !== code) steps.push({what: "203.json", change: `code ${data.code ?? "null"} → ${code}`});
  if (page && data.source !== page) steps.push({what: "203.json", change: `source → ${page}`});
  if (page && fw.source_url !== page) steps.push({what: "page", change: `source link → ${page}`});
  let publishers = [];
  if (repo && !o.no_ci) {
    publishers = (await ctx.op("publishers_list", {code})).items ?? [];
    if (!publishers.some(p => p.repository?.toLowerCase() === repo.toLowerCase())) {
      steps.push({what: "trusted publisher", change: `add ${repo}${workflow ? ` (${workflow})` : ""}: its GitHub Actions publish ${code}'s versions without a secret`});
    }
    if (o.move) for (const p of publishers.filter(p => p.repository?.toLowerCase() !== repo.toLowerCase())) steps.push({what: "trusted publisher", change: `remove ${p.repository} (id ${p.id})`, id: p.id});
  }
  const notes = [
    ...(!page ? ["no git remote here: the page's source link and CI stay as they are (git remote add origin https://github.com/OWNER/NAME, then link again)"] : []),
    ...(page && !repo ? [`${page} is not on GitHub: trusted publishing works from GitHub Actions only (other CI: a personal token)`] : []),
  ];
  const summary = steps.map(s => `${s.what}: ${s.change}`);
  if (o.dry_run) {
    return {json: {dry_run: true, firmware: {code, name: fw.name}, repository: repo, steps: summary, notes, next: [ctx.cmd({remove: ["dry-run"]})]},
      text: (summary.length ? "Would change:\n  " + summary.join("\n  ") : "Nothing to change: this project is linked to " + code) + (notes.length ? "\n" + notes.join("\n") : "")};
  }
  if (page && fw.source_url !== page) await ctx.op("firmware_edit", {code, source_url: page, clone_url: cloneUrlOf(page) ?? undefined});
  for (const s of steps.filter(s => s.what === "trusted publisher")) {
    if (s.id !== undefined) await ctx.op("publisher_remove", {code, id: s.id});
    else await ctx.op("publisher_add", {code, repository: repo, ...(workflow ? {workflow} : {})});
  }
  if (steps.some(s => s.what === "203.json")) {
    data.code = code;
    if (page) data.source = page;
    writeProject(project.file, data);
  }
  return {json: {status: steps.length ? "linked" : "already_linked", firmware: {code, name: fw.name}, repository: repo, changed: summary, notes,
      next: steps.some(s => s.what === "203.json") ? [`git add ${PROJECT_FILE} && git commit -m "203.json: ${code}"`] : []},
    text: steps.length ? `Linked to ${fw.name} (${code}):\n  ${summary.join("\n  ")}` + (steps.some(s => s.what === "203.json") ? `\nCommit ${PROJECT_FILE}.` : "")
      : `Already linked to ${fw.name} (${code}).` + (notes.length ? "\n" + notes.join("\n") : "")};
}
