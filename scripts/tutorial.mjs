// 203c tutorial: a firmware's tutorials (教程, COMMUNITY.md "Tutorials"), written in the one tutorial format
// (reference/tutorial-format.md, checked by tutorial-format.mjs, the module the community's API and editor run too):
// start a file, check it with every error at its line and column, publish it (its local pictures uploaded once, by
// SHA-256, and sent as image:<id>; the file itself stays as written), add a link to a tutorial elsewhere, list, show,
// remove and hide. Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {ApiError, uploadTutorialPicture} from "./lib.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {findProjectFile, PROJECT_FILE} from "./project.mjs";
import {imageInfo, sha256, size} from "./checks.mjs";
import {FORMAT, LANGUAGES, LIMITS, allSteps, checkLink, checkTutorial, errorMessage, errorWhere, formatError, jsonPath, pick, starter} from "./tutorial-format.mjs";

const enc = encodeURIComponent;
export const DEFAULT_FILE = "docs/tutorial.json";
const PICTURE_BYTES = 2 * 1024 * 1024;
const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/;

function siteOf(api) {
  const base = String(api).replace(/\/+$/, "");
  return base.endsWith("/api") ? base.slice(0, -4) : new URL(base).origin;
}
export const tutorialUrl = (ctx, code, id) => `${siteOf(ctx.api)}/${code}/t/${id}`;
export const tutorialsUrl = (ctx, code) => `${siteOf(ctx.api)}/${code}/tutorials`;
const langOf = ctx => (ctx.client?.lang === "zh" ? "zh" : "en");
const shown = (ctx, abs) => path.relative(ctx.cwd, abs) || abs;

// The project (203.json) here or above: {dir, code} or null.
function projectOf(ctx) {
  const found = findProjectFile(ctx.cwd);
  if (!found || path.basename(found.file) !== PROJECT_FILE) return found ? {dir: found.dir, code: null} : null;
  try {
    const data = JSON.parse(fs.readFileSync(found.file, "utf8"));
    return {dir: found.dir, code: typeof data.code === "string" && CODE_RE.test(data.code.toUpperCase()) ? data.code.toUpperCase() : null};
  } catch { return {dir: found.dir, code: null}; }
}

// The tutorial file: FILE (relative to here), else docs/tutorial.json of the project (203.json's folder), else of here.
function fileOf(ctx) {
  if (ctx.args.FILE) return path.resolve(ctx.cwd, ctx.args.FILE);
  return path.resolve(projectOf(ctx)?.dir ?? ctx.cwd, DEFAULT_FILE);
}

// The firmware: --firmware, else the code the file names, else 203.json's; null when none says.
function firmwareOf(ctx, fileCode = null) {
  if (ctx.flags.firmware) {
    const code = String(ctx.flags.firmware).trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      throw new CliError("usage", `--firmware ${ctx.flags.firmware} is not a firmware's code (six characters: 2-9 and A-Z without I and O)`, {exit: EXIT.usage,
        field: "firmware", hint: "Never guess a code: firmware mine lists yours; a firmware's page shows its code", next: [ctx.run(["firmware", "mine"])]});
    }
    return code;
  }
  return fileCode ?? projectOf(ctx)?.code ?? null;
}

// ---------------------------------------------------------------------------------------------
// The local check: the format (tutorial-format.mjs), then every local picture (there, PNG, JPEG or WebP, ≤ 2 MB).

const LOCAL_MESSAGES = {
  picture_missing: [p => `${p.ref} does not exist (looked at ${p.abs})`, p => `${p.ref} 不存在（找的是 ${p.abs}）`],
  picture_type: [p => `${p.ref} is ${p.what}: a picture is a PNG, JPEG or WebP file`, p => `${p.ref} 是${p.what_zh}：图片要是 PNG、JPEG 或 WebP 文件`],
  picture_too_large: [p => `${p.ref} is ${p.size}: a picture is at most 2 MB`, p => `${p.ref} 有 ${p.size}：图片最大 2 MB`],
};
const messageOf = (error, lang) => (LOCAL_MESSAGES[error.code] ? LOCAL_MESSAGES[error.code][lang === "zh" ? 1 : 0](error.params) : errorMessage(error, lang));
const lineOf = (error, lang, file) => {
  if (!LOCAL_MESSAGES[error.code]) return formatError(error, lang, file);
  const where = errorWhere(error, lang);
  return `${file}:${error.line}:${error.column} ${jsonPath(error.path)}: ${messageOf(error, lang)}${where ? (lang === "zh" ? `（${where}）` : ` (${where})`) : ""}`;
};

/**
 * Reads and checks a tutorial file: {abs, rel, text, result, errors (each with its message), pictures: [{ref, id, abs,
 * bytes, mime, sha, width, height, line, column, lesson, step}]}. uploaded: the author's picture ids (image:<id> checked).
 */
export function checkFile(ctx, abs, {firmware = null, uploaded = null} = {}) {
  const rel = shown(ctx, abs);
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch (error) {
    const missing = error.code === "ENOENT";
    throw new CliError("file_not_found", missing ? `${rel} does not exist (looked at ${abs})` : `Cannot read ${rel}: ${error.code || error.message}`, {exit: EXIT.refused,
      field: "FILE", hint: missing ? `Start one: tutorial new${rel === DEFAULT_FILE ? "" : " " + rel} (or give the file's path; paths are relative to the current folder)` : "Check the file's permissions",
      next: missing ? [ctx.run(["tutorial", "new", ...(ctx.args.FILE ? [ctx.args.FILE] : [])])] : []});
  }
  const result = checkTutorial(text, {pictures: "local", firmware, uploaded});
  const errors = [...result.errors];
  const pictures = [];
  const dir = path.dirname(abs);
  const seen = new Map();
  for (const p of result.pictures) {
    const at = {line: p.line, column: p.column, lesson: p.step[0], step: p.step[1]};
    if (p.id) { pictures.push({ref: p.ref, id: p.id, ...at}); continue; }
    const file = path.resolve(dir, p.path);
    const where = {path: `lessons.${p.step[0]}.steps.${p.step[1]}.image`, line: p.line, column: p.column};
    if (seen.has(file)) { const before = seen.get(file); if (before) pictures.push({...before, ...at}); continue; }
    let bytes = null;
    try { bytes = new Uint8Array(fs.readFileSync(file)); } catch { /* below */ }
    if (!bytes) { errors.push({code: "picture_missing", params: {ref: p.path, abs: file}, ...where}); seen.set(file, null); continue; }
    const info = imageInfo(bytes);
    if (!info) {
      const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
      const [what, whatZh] = /^GIF8/.test(head) ? ["a GIF", " GIF"] : /^\s*<(svg|\?xml)/i.test(head) ? ["an SVG", " SVG"] : ["not a picture", "别的文件"];
      errors.push({code: "picture_type", params: {ref: p.path, what, what_zh: whatZh}, ...where}); seen.set(file, null); continue;
    }
    if (bytes.length > PICTURE_BYTES) { errors.push({code: "picture_too_large", params: {ref: p.path, size: size(bytes.length)}, ...where}); seen.set(file, null); continue; }
    const picture = {ref: p.path, id: null, abs: file, file: shown(ctx, file), bytes, mime: info.mime, sha: sha256(bytes), width: info.width ?? null, height: info.height ?? null};
    seen.set(file, picture);
    pictures.push({...picture, ...at});
  }
  errors.sort((a, b) => a.line - b.line || a.column - b.column);
  const lang = langOf(ctx);
  return {abs, rel, text, result, pictures, errors: errors.map(e => ({line: e.line, column: e.column, path: e.path, code: e.code, params: e.params, message: messageOf(e, lang)})),
    lines: errors.map(e => lineOf(e, lang, rel))};
}

const countsOf = result => {
  const t = result.tutorial;
  return t ? {lessons: t.lessons.length, steps: allSteps(t).length} : {lessons: null, steps: null};
};
const pictureRows = pictures => [...new Map(pictures.map(p => [p.id ?? p.abs, p])).values()].map(p => (p.id
  ? {ref: "image:" + p.id, id: p.id, uploaded: true}
  : {ref: p.ref, file: p.file, size: p.bytes.length, mime: p.mime, width: p.width, height: p.height, sha256: p.sha, uploaded: false}));

// A check that failed, as an error (publish) with every error in `errors`.
function invalid(ctx, checked, more = {}) {
  const first = checked.errors[0];
  return new CliError("invalid", `${checked.rel}: ${checked.errors.length} error${checked.errors.length > 1 ? "s" : ""} (the first: ${checked.lines[0]})`, {exit: EXIT.refused,
    field: "document", hint: "Fix each one at its line and column (the format: reference/tutorial-format.md, help tutorials), then run it again",
    next: [ctx.run(["tutorial", "check", ...(ctx.args.FILE ? [ctx.args.FILE] : [])]), ctx.run(["help", "tutorials"], {json: false})],
    data: {file: checked.rel, errors: checked.errors, ...more, first_line: first.line}});
}

// ---------------------------------------------------------------------------------------------
// tutorial new

export async function tutorialNew(ctx) {
  const o = ctx.flags;
  const abs = fileOf(ctx);
  const rel = shown(ctx, abs);
  let languages = ["zh", "en"];
  if (o.languages !== undefined) {
    languages = [...new Set(String(o.languages).split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
    if (!languages.length || languages.length > 2 || languages.some(l => !LANGUAGES.includes(l))) {
      throw new CliError("usage", `--languages ${o.languages}: zh, en or zh,en`, {exit: EXIT.usage, field: "languages", hint: "The languages every text is written in: zh, en or both (zh,en)",
        next: [ctx.cmd({set: {languages: "zh,en"}})]});
    }
  }
  const firmware = firmwareOf(ctx);
  const text = starter({languages, title: o.title ?? null, firmware});
  const check = checkTutorial(text, {pictures: "local"});
  if (!check.ok) {
    throw new CliError("invalid", `--title: ${errorMessage(check.errors[0], langOf(ctx))}`, {exit: EXIT.usage, field: "title",
      hint: `A title is ${LIMITS.title[0]}-${LIMITS.title[1]} wide (a Chinese character counts 2), plain text`});
  }
  if (fs.existsSync(abs) && !o.force) {
    throw new CliError("needs_force", `${rel} exists already: tutorial new would write over it`, {exit: EXIT.confirm, field: "FILE",
      hint: "Check or publish the one you have (tutorial check, tutorial publish), give another FILE, or add --force only if the user wants it replaced",
      next: [ctx.cmd({add: {force: true}}), ctx.run(["tutorial", "check", ...(ctx.args.FILE ? [ctx.args.FILE] : [])])]});
  }
  if (o.dry_run) {
    return {json: {status: "dry_run", ready: true, plan: [`write ${rel} (${FORMAT}, ${languages.join(" + ")}${firmware ? `, for ${firmware}` : ""})`], file: rel, firmware, languages,
      text, next: [ctx.cmd({remove: ["dry-run"]})]}, text: `Dry run: nothing was written.\nIt would write ${rel}:\n\n${text}`};
  }
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, text);
  const fileArgs = ctx.args.FILE ? [ctx.args.FILE] : [];
  const next = [ctx.run(["tutorial", "check", ...fileArgs]), ctx.run(["tutorial", "publish", ...fileArgs, ...(firmware ? [] : ["--firmware", "<CODE>"])])];
  return {json: {status: "written", file: rel, firmware, languages, lessons: 1, steps: 2, format: FORMAT, next},
    text: [`Wrote ${rel}: one lesson of two steps to start from (${languages.join(" + ")}${firmware ? `, for ${firmware}` : ""}).`,
      "Write the firmware's lessons: one action a step, the keys it asks for, a screenshot of the screen (\"image\": \"shots/…png\").",
      `Then: ${next[0]}`, `      ${next[1]}`, "The format: reference/tutorial-format.md (help tutorials)."].join("\n")};
}

// ---------------------------------------------------------------------------------------------
// tutorial check

export async function tutorialCheck(ctx) {
  const abs = fileOf(ctx);
  const firmware = ctx.flags.firmware ? firmwareOf(ctx) : null;
  const checked = checkFile(ctx, abs, {firmware});
  const counts = countsOf(checked.result);
  const pictures = pictureRows(checked.pictures);
  const ok = !checked.errors.length;
  const fileArgs = ctx.args.FILE ? [ctx.args.FILE] : [];
  const next = ok ? [ctx.run(["tutorial", "publish", ...fileArgs, "--dry-run"])] : [ctx.cmd({}), ctx.run(["help", "tutorials"], {json: false})];
  const json = {status: ok ? "ok" : "invalid", ok, file: checked.rel, format: FORMAT, errors: checked.errors, ...counts,
    languages: checked.result.tutorial?.languages ?? null, pictures, next};
  if (!ok) {
    return {json: {...json, code: "invalid", field: "document", exit: EXIT.refused}, exit: EXIT.refused,
      text: [...checked.lines, `${checked.errors.length} error${checked.errors.length > 1 ? "s" : ""} in ${checked.rel}. The format: reference/tutorial-format.md (${ctx.run(["help", "tutorials"], {json: false})}).`].join("\n")};
  }
  const toUpload = pictures.filter(p => !p.uploaded).length;
  return {json, text: `${checked.rel}: it follows the format (${counts.lessons} lesson${counts.lessons > 1 ? "s" : ""}, ${counts.steps} step${counts.steps > 1 ? "s" : ""}, ` +
    `${pictures.length} picture${pictures.length === 1 ? "" : "s"}${toUpload ? `, ${toUpload} to upload` : ""}).\nPublish it: ${next[0]}`};
}

// ---------------------------------------------------------------------------------------------
// The author's tutorials on a firmware

async function allTutorials(ctx, code) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const answer = await ctx.client.get(`/firmware/${enc(code)}/tutorials`, {page});
    items.push(...(answer.items ?? []));
    if (!answer.items?.length || items.length >= (answer.total ?? 0)) break;
  }
  return items;
}

async function firmwareRef(ctx, code) {
  try { return await ctx.client.get("/firmware/" + enc(code)); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "not_found" || error.code === "deleted") {
      throw new CliError("not_found", error.code === "deleted" ? `Firmware ${code} was deleted` : `No firmware has the code ${code}`, {exit: EXIT.refused, field: "firmware",
        hint: "Never guess a code: a firmware's page shows it; firmware mine lists yours", next: [ctx.run(["firmware", "mine"]), ctx.run(["search", code])]});
    }
    throw error;
  }
}

async function myAccount(ctx) {
  if (!ctx.me) ctx.me = await ctx.client.get("/me");
  return ctx.me;
}

// The text to send: each local picture's path replaced by image:<id> where it stands in the file (the rest as written).
export function withImageIds(text, pictures, idOf) {
  const starts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const edits = [];
  for (const p of pictures) {
    if (p.id || !p.line) continue;
    const id = idOf(p);
    if (!id) continue;
    const at = starts[p.line - 1] + p.column - 1;
    if (text[at] !== "\"") continue;
    let end = at + 1;
    while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
    edits.push([at, end + 1, JSON.stringify("image:" + id)]);
  }
  let out = text;
  for (const [from, to, value] of [...new Map(edits.map(e => [e[0], e])).values()].sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + value + out.slice(to);
  return out;
}

// A guide's document as the server keeps it, for comparing: the checked file with its pictures' ids.
const sameDocument = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The server's refusal of a document, said with the file's lines.
function refusedDocument(ctx, error, checked) {
  const errors = error.data?.errors;
  if (!(error instanceof ApiError) || error.code !== "invalid" || !Array.isArray(errors) || !errors.length) return error;
  const lines = errors.map(e => (e.line ? `${checked.rel}:${e.line}:${e.column} ` : "") + `${e.path ? jsonPath(e.path) + ": " : ""}${e.message ?? e.code}`);
  return new CliError("invalid", `The community refused ${checked.rel}: ${errors.length} error${errors.length > 1 ? "s" : ""} (the first: ${lines[0]})`, {exit: EXIT.refused,
    field: "document", hint: "Fix each one at its line and column, then publish again (tutorial check runs the same checks here)",
    next: [ctx.run(["tutorial", "check", ...(ctx.args.FILE ? [ctx.args.FILE] : [])])], data: {file: checked.rel, errors, lines}});
}

// ---------------------------------------------------------------------------------------------
// tutorial publish

export async function tutorialPublish(ctx) {
  const o = ctx.flags;
  const abs = fileOf(ctx);
  // Read once without the firmware to learn the code the file names.
  const first = checkFile(ctx, abs);
  const code = firmwareOf(ctx, first.result.tutorial?.firmware ?? fileFirmware(first.text));
  if (!code) {
    throw new CliError("usage", "Which firmware is this tutorial for? Give --firmware CODE, or put \"firmware\": \"CODE\" in the file (or run it in the project, 203.json's code)",
      {exit: EXIT.usage, field: "firmware", hint: "Never guess a code: a firmware's page shows it; firmware mine lists yours", next: [ctx.cmd({set: {firmware: "<CODE>"}}), ctx.run(["firmware", "mine"])]});
  }
  if (first.errors.length) throw invalid(ctx, checkFile(ctx, abs, {firmware: code}));
  const fw = await firmwareRef(ctx, code);
  const me = await myAccount(ctx);
  const pool = (await ctx.client.get(`/firmware/${enc(code)}/tutorial-images`)).items ?? [];
  const ready = pool.filter(x => x.status !== "pending");
  const checked = checkFile(ctx, abs, {firmware: code, uploaded: ready.map(x => x.id)});
  if (checked.errors.length) throw invalid(ctx, checked);
  // The local pictures: the author's pool has those of the same SHA-256 already; the others go up.
  const bySha = new Map(ready.filter(x => x.sha256).map(x => [x.sha256, x.id]));
  const locals = [...new Map(checked.pictures.filter(p => !p.id).map(p => [p.abs, p])).values()];
  const uploads = locals.filter(p => !bySha.has(p.sha));
  const plan = [];
  for (const p of locals) plan.push(bySha.has(p.sha) ? `${p.file}: uploaded already (image:${bySha.get(p.sha)})` : `upload ${p.file} (${p.width ?? "?"}x${p.height ?? "?"} ${p.mime.split("/")[1].toUpperCase()}, ${size(p.bytes.length)})`);
  if (ready.length + uploads.length > LIMITS.pictures) {
    throw new CliError("conflict", `You have ${ready.length} pictures for ${fw.name}'s tutorials: ${uploads.length} more would be over ${LIMITS.pictures}`, {exit: EXIT.refused,
      field: "images", hint: "Use fewer pictures, or remove the ones no tutorial uses (they go by themselves after 7 days)"});
  }
  const mine = (await allTutorials(ctx, code)).find(t => t.kind === "guide" && t.author?.id === me.id) ?? null;
  const counts = countsOf(checked.result);
  const sizes = `${counts.lessons} lesson${counts.lessons === 1 ? "" : "s"}, ${counts.steps} step${counts.steps === 1 ? "" : "s"}`;
  plan.push(mine ? `change your tutorial ${mine.id} on ${fw.name} (${code}): ${sizes}` : `add your tutorial to ${fw.name} (${code}): ${sizes}`);
  if (o.dry_run) {
    // The server's own dry run, with the pictures it has; the ones to upload are left out of it.
    const document = structuredClone(checked.result.tutorial);
    for (const lesson of document.lessons) {
      for (const step of lesson.steps) {
        if (step.image && !step.image.startsWith("image:")) {
          const p = locals.find(x => x.ref === step.image);
          step.image = p && bySha.has(p.sha) ? "image:" + bySha.get(p.sha) : null;
        }
      }
    }
    const problems = [];
    try {
      await ctx.client.request("POST", mine ? `/firmware/${enc(code)}/tutorials/${enc(mine.id)}/edit` : `/firmware/${enc(code)}/tutorials`, {query: {dry_run: 1}, body: {document}});
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) throw error;
      problems.push({code: error.code, error: error.message, field: error.data?.field, ...(error.data?.errors ? {errors: error.data.errors} : {})});
    }
    const readyToGo = !problems.length;
    return {json: {status: "dry_run", ready: readyToGo, plan, problems, firmware: {code, name: fw.name}, file: checked.rel, ...counts, pictures: pictureRows(checked.pictures),
      tutorial: mine ? {id: mine.id, url: tutorialUrl(ctx, code, mine.id)} : null, next: readyToGo ? [ctx.cmd({remove: ["dry-run"]})] : [ctx.run(["tutorial", "check", ...(ctx.args.FILE ? [ctx.args.FILE] : [])])]},
    text: ["Dry run: nothing was changed.", "Plan:", ...plan.map((s, i) => `  ${i + 1}. ${s}`), ...problems.map(p => `  ✗ ${p.error}`),
      readyToGo ? `Ready. Run it:\n  ${ctx.cmd({remove: ["dry-run"]}, {json: false})}` : `Not ready (exit ${EXIT.refused}).`].join("\n"),
    exit: readyToGo ? EXIT.ok : EXIT.refused};
  }
  const uploaded = [];
  for (const p of uploads) {
    ctx.say(`Uploading ${p.file} (${size(p.bytes.length)})…`);
    const done = await uploadTutorialPicture(ctx.client, code, p.bytes, p.mime);
    bySha.set(p.sha, done.id);
    uploaded.push({file: p.file, id: done.id});
  }
  const text = withImageIds(checked.text, checked.pictures, p => bySha.get(p.sha) ?? null);
  const sent = checkTutorial(text, {pictures: "uploaded", firmware: code, uploaded: [...bySha.values(), ...ready.map(x => x.id)]});
  if (!sent.ok) throw invalid(ctx, {...checked, errors: sent.errors.map(e => ({...e, message: errorMessage(e, langOf(ctx))})), lines: sent.errors.map(e => formatError(e, langOf(ctx), checked.rel))});
  let tutorial, status;
  try {
    if (mine) {
      const current = await ctx.client.get(`/firmware/${enc(code)}/tutorials/${enc(mine.id)}`);
      if (current.source === text || (current.source == null && sameDocument(current.document, sent.tutorial))) { tutorial = current; status = "already_published"; }
      else { tutorial = await ctx.client.post(`/firmware/${enc(code)}/tutorials/${enc(mine.id)}/edit`, {document: text}); status = "updated"; }
    } else {
      try { tutorial = await ctx.client.post(`/firmware/${enc(code)}/tutorials`, {document: text}); status = "published"; }
      catch (error) {
        // Made meanwhile (another run, the site): that one is changed.
        if (!(error instanceof ApiError && error.status === 409 && error.data?.field === "document" && error.data?.id)) throw error;
        tutorial = await ctx.client.post(`/firmware/${enc(code)}/tutorials/${enc(error.data.id)}/edit`, {document: text}); status = "updated";
      }
    }
  } catch (error) { throw refusedDocument(ctx, error, checked); }
  const url = tutorialUrl(ctx, code, tutorial.id);
  const words = {published: "Published", updated: "Updated", already_published: "Already published (nothing changed)"}[status];
  return {json: {status, tutorial: {id: tutorial.id, title: tutorial.title, url, lessons: tutorial.lessons ?? counts.lessons, steps: tutorial.steps ?? counts.steps,
    hidden: !!tutorial.hidden}, firmware: {code, name: fw.name, tutorials: tutorialsUrl(ctx, code)}, uploaded, file: checked.rel},
  text: [`${words}: ${tutorial.title ?? pick(checked.result.tutorial.title, langOf(ctx))} on ${fw.name} (${code})`, `  ${url}`,
    ...uploaded.map(u => `  uploaded ${u.file} → image:${u.id}`), tutorial.hidden ? "  (hidden: only you, the firmware's owner and admins see it)" : ""].filter(Boolean).join("\n")};
}

// The code a file names, read leniently (a file with errors still says which firmware it is for).
function fileFirmware(text) {
  const m = /"firmware"\s*:\s*"([2-9A-HJ-NP-Za-hj-np-z]{6})"/.exec(text ?? "");
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------------------------
// tutorial link

export async function tutorialLink(ctx) {
  const code = ctx.args.CODE, o = ctx.flags;
  if (o.title === undefined) {
    throw ctx.usage("Missing --title for \"tutorial link\": what the link is (2-60 wide, a Chinese character counts 2)", {field: "title",
      hint: `e.g. ${ctx.run(["tutorial", "link", code, ctx.args.URL ?? "https://…", "--title", "Video: the first ten minutes"], {json: false})}`});
  }
  const checked = checkLink({title: o.title, url: ctx.args.URL});
  if (!checked.ok) {
    const e = checked.errors[0];
    throw new CliError("invalid", `${e.field === "url" ? "URL" : "--title"}: ${errorMessage(e, langOf(ctx))}`, {exit: EXIT.usage, field: e.field === "url" ? "URL" : "title",
      hint: e.field === "url" ? "A link tutorial's address is https:// (at most 500 characters, no user name or password in it)" : `A title is ${LIMITS.linkTitle[0]}-${LIMITS.linkTitle[1]} wide, plain text`});
  }
  const fw = await firmwareRef(ctx, code);
  const me = await myAccount(ctx);
  const mine = (await allTutorials(ctx, code)).filter(t => t.kind === "link" && t.author?.id === me.id);
  const same = mine.find(t => t.url === checked.url) ?? null;
  const plan = [same ? (same.title === checked.title ? `nothing differs on your link ${same.id}` : `change the title of your link ${same.id} to "${checked.title}"`)
    : `add a link to ${fw.name} (${code}): "${checked.title}" → ${checked.url}`];
  if (o.dry_run) {
    const problems = [];
    if (!same || same.title !== checked.title) {
      try {
        await ctx.client.request("POST", same ? `/firmware/${enc(code)}/tutorials/${enc(same.id)}/edit` : `/firmware/${enc(code)}/tutorials`, {query: {dry_run: 1},
          body: same ? {title: checked.title} : {title: checked.title, url: checked.url}});
      } catch (error) {
        if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) throw error;
        problems.push({code: error.code, error: error.message, field: error.data?.field});
      }
    }
    return {json: {status: "dry_run", ready: !problems.length, plan, problems, firmware: {code, name: fw.name}, next: problems.length ? [] : [ctx.cmd({remove: ["dry-run"]})]},
      text: ["Dry run: nothing was changed.", ...plan.map(s => "  " + s), ...problems.map(p => `  ✗ ${p.error}`)].join("\n"), exit: problems.length ? EXIT.refused : EXIT.ok};
  }
  let tutorial, status;
  if (same && same.title === checked.title) { tutorial = same; status = "already_published"; }
  else if (same) { tutorial = await ctx.client.post(`/firmware/${enc(code)}/tutorials/${enc(same.id)}/edit`, {title: checked.title}); status = "updated"; }
  else { tutorial = await ctx.client.post(`/firmware/${enc(code)}/tutorials`, {title: checked.title, url: checked.url}); status = "published"; }
  const url = tutorialUrl(ctx, code, tutorial.id);
  return {json: {status, tutorial: {id: tutorial.id, kind: "link", title: tutorial.title, url: tutorial.url ?? checked.url, page: url}, firmware: {code, name: fw.name}},
    text: `${{published: "Added", updated: "Updated", already_published: "Already there"}[status]}: "${tutorial.title}" on ${fw.name} (${code}) — ${url}`};
}

// ---------------------------------------------------------------------------------------------
// tutorial list, show, rm, hide

const row = t => `  ${t.id}  ${t.official ? "official " : ""}${t.kind === "link" ? "link " : "guide"}  ${t.title}` +
  (t.kind === "link" ? `  (${t.host ?? t.url})` : `  (${t.lessons} lesson${t.lessons === 1 ? "" : "s"}, ${t.steps} step${t.steps === 1 ? "" : "s"})`) +
  `  — ${t.author?.name ?? "?"}${t.hidden ? "  [hidden]" : ""}`;

export async function tutorialList(ctx) {
  const o = ctx.flags;
  if (o.all) {
    const answer = await ctx.client.get("/tutorials", {target: o.target, q: o.q, page: o.page});
    const items = answer.items ?? [];
    return {json: answer, text: items.length ? [`Firmware with tutorials (${answer.total ?? items.length}):`,
      ...items.map(x => `  ${x.firmware.code}  ${x.firmware.name}: ${x.total} tutorial${x.total === 1 ? "" : "s"} — ${tutorialsUrl(ctx, x.firmware.code)}`)].join("\n")
      : "No firmware has tutorials yet."};
  }
  const code = ctx.args.CODE ?? projectOf(ctx)?.code;
  if (!code) {
    throw ctx.usage("Which firmware? Give its CODE (or run it in the project: 203.json's code); --all lists every firmware with tutorials", {field: "CODE",
      next: [ctx.run(["tutorial", "list", "--all"]), ctx.run(["firmware", "mine"])]});
  }
  const items = await allTutorials(ctx, code);
  return {json: {firmware: {code, tutorials: tutorialsUrl(ctx, code)}, total: items.length, items: items.map(t => ({...t, page: tutorialUrl(ctx, code, t.id)}))},
    text: items.length ? [`Tutorials of ${code} (${items.length}) — ${tutorialsUrl(ctx, code)}`, ...items.map(row)].join("\n")
      : `${code} has no tutorials yet. Write one: ${ctx.run(["tutorial", "new"], {json: false})}`};
}

export async function tutorialShow(ctx) {
  const {CODE: code, ID: id} = ctx.args;
  const t = await ctx.client.get(`/firmware/${enc(code)}/tutorials/${enc(String(id).toLowerCase())}`);
  let saved = null;
  if (ctx.flags.out) {
    const out = path.resolve(ctx.cwd, ctx.flags.out);
    if (t.kind !== "guide") throw new CliError("usage", "--out saves a guide's file: this tutorial is a link", {exit: EXIT.usage, field: "out"});
    if (fs.existsSync(out) && !ctx.flags.force) {
      throw new CliError("needs_force", `${shown(ctx, out)} exists already`, {exit: EXIT.confirm, field: "out", hint: "Give another --out, or --force only if the user wants it replaced",
        next: [ctx.cmd({add: {force: true}})]});
    }
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, t.source ?? JSON.stringify(t.document, null, 2) + "\n");
    saved = shown(ctx, out);
  }
  const lang = langOf(ctx);
  const lines = [`${t.title} (${t.kind === "link" ? "a link" : "a guide"}${t.official ? ", official" : ""}${t.hidden ? ", hidden" : ""}) by ${t.author?.name ?? "?"} — ${tutorialUrl(ctx, code, t.id)}`];
  if (t.kind === "link") lines.push(`  → ${t.url}`);
  else for (const [i, lesson] of (t.document?.lessons ?? []).entries()) lines.push(`  ${i + 1}. ${pick(lesson.title, lang, t.document.languages)} (${lesson.steps.length} step${lesson.steps.length === 1 ? "" : "s"})`);
  if (saved) lines.push(`Saved its file to ${saved}${t.source ? "" : " (as the community keeps it)"}.`);
  return {json: {...t, page: tutorialUrl(ctx, code, t.id), ...(saved ? {saved} : {})}, text: lines.join("\n")};
}

export async function tutorialRm(ctx) {
  const {CODE: code} = ctx.args;
  const id = String(ctx.args.ID).toLowerCase();
  try {
    await ctx.client.post(`/firmware/${enc(code)}/tutorials/${enc(id)}/delete`);
  } catch (error) {
    if (!(error instanceof ApiError && ["deleted", "not_found"].includes(error.code))) throw error;
    // The tutorial is gone already (a run again): done. A firmware that is not there is still an error.
    await firmwareRef(ctx, code);
    return {json: {status: "already_deleted", id, note: error.message}, text: `Already deleted: ${id} (${error.message})`};
  }
  return {json: {status: "deleted", id, firmware: {code, tutorials: tutorialsUrl(ctx, code)}}, text: `Deleted the tutorial ${id} of ${code}.`};
}

export async function tutorialHide(ctx) {
  const {CODE: code} = ctx.args;
  const id = String(ctx.args.ID).toLowerCase();
  const on = !ctx.flags.off;
  const t = await ctx.client.post(`/firmware/${enc(code)}/tutorials/${enc(id)}/hide`, {on, ...(ctx.flags.reason ? {reason: ctx.flags.reason} : {})});
  return {json: {status: on ? "hidden" : "shown", tutorial: t}, text: `${on ? "Hidden" : "Shown again"}: "${t.title}" (${id}) on ${code}${on ? " (its author is told; it shows to its author, the firmware's owner and admins only)" : ""}.`};
}
