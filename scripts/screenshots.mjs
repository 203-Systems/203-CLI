// 203cli screenshots: the person's screenshots on the community (COMMUNITY.md "Screenshots", the user 2026-11-24). A device takes
// them (HOME + space, or 203cli board screenshot over USB), keeps them on its SD card in /screenshot/ and uploads them to the
// account it is bound to; 203cli uploads others (POST /me/screenshots). Private until their owner makes them public, then on
// the person's page. Here: list (yours, or a person's public ones), show, download (--scale: larger pixel for pixel, a PNG made
// here), public / private, rename (the title), delete, upload. A screenshot is named by its id, or by its file name among yours.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {ApiError, downloadScreenshot, screenshotName, screenshotTakenAt} from "./lib.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {encodePng, size, table} from "./board.mjs";
import {decodePng, scalePixels, isPng, pngSize} from "./png.mjs";

// What the community takes (COMMUNITY.md "Screenshots"): a PNG of at most 256 KiB and 1024 × 1024; 1000 and 200 MB an account.
export const SCREENSHOT_LIMITS = Object.freeze({bytes: 262144, side: 1024, title: 80, count: 1000, total: 209715200});
// A larger copy (--scale) stays a picture a viewer opens: at most 8192 pixels a side.
const SCALED_SIDE = 8192;

const inZh = ctx => ctx.client?.lang === "zh";
const say2 = (ctx, en, zh) => (inZh(ctx) ? zh : en);
const day = at => (at ? String(at).slice(0, 16).replace("T", " ") : "");

// ---------------------------------------------------------------------------------------------
// The community's answers, and its 404s

/** The community has no screenshots at all (it answers 404 to /me/screenshots): an older one. */
function unavailable(ctx) {
  return new CliError("screenshots_unavailable", say2(ctx, `The community at ${ctx.api ?? "the API"} has no screenshots yet (it answers 404 to them): an older community`,
    `${ctx.api ?? "这个社区"} 还没有截图功能（它对截图请求回答 404）：社区版本较旧`), {exit: EXIT.refused,
    hint: say2(ctx, "Screenshots come with its next update. Meanwhile they stay on the device's SD card (/screenshot/), and 203cli board screenshot --no-save --out FILE brings one to this computer over USB",
      "等社区更新后就有。在那之前截图留在设备的 SD 卡里（/screenshot/），用 USB 线时 203cli board screenshot --no-save --out FILE 可以直接取到这台电脑上"),
    next: [ctx.run?.(["board", "screenshot", "--no-save", "--out", "screen.png"])].filter(Boolean)});
}
/** Whether the community has screenshots (a 404 to a screenshot or a person could be either). */
async function haveScreenshots(ctx) {
  try { await ctx.op("screenshots_list", {limit: 1}); return true; } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    return true;
  }
}
/** An operation; a 404 says which it was: an older community, or nothing with that id. */
async function call(ctx, name, args, what = null) {
  try { return await ctx.op(name, args); } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    if (name === "screenshots_list" || !(await haveScreenshots(ctx))) throw unavailable(ctx);
    throw what ? what() : error;
  }
}
const notFound = (ctx, ref) => new CliError("not_found", say2(ctx, `No screenshot ${ref}: none of yours has that id or name, and no public one has that id`,
  `没有截图 ${ref}：你的截图里没有这个 id 或文件名，公开的截图里也没有这个 id`), {exit: EXIT.refused,
  hint: say2(ctx, "screenshots list shows yours, with their ids and names", "screenshots list 列出你的截图和它们的 id、文件名"),
  next: [ctx.run?.(["screenshots", "list"])].filter(Boolean)});

/** Every screenshot of yours, page by page (at most 1000). */
async function everyScreenshot(ctx) {
  const items = [];
  let cursor, quota = null;
  for (let page = 0; page < 50; page++) {
    const got = await call(ctx, "screenshots_list", {limit: 60, ...(cursor ? {cursor} : {})});
    items.push(...(got.items ?? []));
    quota = got.quota ?? quota;
    if (!got.next || !(got.items ?? []).length) break;
    cursor = got.next;
  }
  return {items, quota};
}

// A file's name (a device's: 2026-11-24_101500_CardenzaSynth.png, shot-0001_Launcher.png; or .png) rather than an id.
const looksLikeName = ref => /\.png$/i.test(ref) || ref.includes("_");
/**
 * The screenshot REF names: an id (GET /screenshots/<id>: yours, or a public one), else the file name (with or without .png)
 * or the title of one of yours. Names repeat across devices: two of yours with that name ask for the id.
 */
export async function findScreenshot(ctx, ref) {
  const text = String(ref ?? "").trim();
  if (!text) throw ctx.usage(say2(ctx, "Which screenshot? Give its id or its file name", "哪一张截图？给出它的 id 或文件名"), {next: [ctx.run?.(["screenshots", "list"])].filter(Boolean)});
  if (!looksLikeName(text)) {
    try { return await ctx.op("screenshot_show", {id: text}); } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      if (!(await haveScreenshots(ctx))) throw unavailable(ctx);
    }
  }
  const {items} = await everyScreenshot(ctx);
  const want = text.toLowerCase(), withPng = want.endsWith(".png") ? want : want + ".png";
  let hits = items.filter(s => String(s.name).toLowerCase() === want || String(s.name).toLowerCase() === withPng);
  if (!hits.length) hits = items.filter(s => s.title && String(s.title).toLowerCase() === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw ctx.usage(say2(ctx, `${hits.length} of your screenshots are called ${text} (from different devices): give the id`, `你有 ${hits.length} 张截图都叫 ${text}（来自不同设备）：请给出 id`),
      {field: "ID", hint: hits.map(s => `${s.id} ${s.name}${s.device ? ` (${s.device.name})` : ""}${s.taken_at ? ` ${day(s.taken_at)}` : ""}`).join(", ")});
  }
  throw notFound(ctx, text);
}

// ---------------------------------------------------------------------------------------------
// Words for people

function row(ctx, s) {
  return [s.id, s.name + (s.title ? `  "${s.title}"` : ""), `${s.width ?? "?"}×${s.height ?? "?"}`, size(s.bytes),
    s.public ? say2(ctx, "public", "公开") : say2(ctx, "private", "私密"), day(s.taken_at ?? s.uploaded_at),
    [s.firmware?.name, s.firmware?.version].filter(Boolean).join(" ") || "", s.device?.name ?? ""];
}
export function screenshotText(ctx, s) {
  const lines = [`${s.id}  ${s.name}${s.title ? `  "${s.title}"` : ""}`];
  const line = (label, value) => { if (value) lines.push(`  ${label.padEnd(9)} ${value}`); };
  line(say2(ctx, "picture", "图片"), `${s.width ?? "?"} × ${s.height ?? "?"}, ${size(s.bytes)}`);
  line(say2(ctx, "seen by", "可见"), s.public ? say2(ctx, "anyone (public, on its owner's page)", "所有人（公开，在主页上）") : say2(ctx, "its owner only (private)", "仅自己（私密）"));
  line(say2(ctx, "taken", "拍摄"), s.taken_at ? day(s.taken_at) + " UTC" : say2(ctx, "unknown (the device's clock was not set)", "不详（设备时钟未设置）"));
  line(say2(ctx, "uploaded", "上传"), s.uploaded_at ? day(s.uploaded_at) + " UTC" : "");
  line(say2(ctx, "firmware", "固件"), s.firmware ? [s.firmware.name, s.firmware.version, s.firmware.code ? `(${s.firmware.code})` : null].filter(Boolean).join(" ") : "");
  line(say2(ctx, "device", "设备"), s.device ? `${s.device.name} (${s.device.id})` : "");
  line(say2(ctx, "by", "作者"), s.user?.name ?? "");
  line("PNG", s.url ?? "");
  return lines.join("\n");
}
function quotaText(ctx, q) {
  if (!q) return "";
  return say2(ctx, `${q.count} of ${q.max_count} screenshots, ${size(q.bytes)} of ${size(q.max_bytes)}`, `截图 ${q.count} / ${q.max_count} 张，${size(q.bytes)} / ${size(q.max_bytes)}`);
}

// ---------------------------------------------------------------------------------------------
// The commands

export async function screenshotsList(ctx) {
  const o = ctx.flags ?? {};
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 100)) throw ctx.usage(`--limit is 1-100, not ${o.limit}`, {field: "limit"});
  if (o.all && o.cursor) throw ctx.usage("--all reads every page itself: leave out --cursor", {field: "cursor"});
  let answer;
  if (o.user) answer = await call(ctx, "user_screenshots", {id: String(o.user), cursor: o.cursor, limit: o.limit}, () => new CliError("not_found",
    say2(ctx, `No person has the id ${o.user}`, `没有 id 为 ${o.user} 的用户`), {hint: say2(ctx, "A person's id is on their page (user ID shows one)", "用户的 id 在他的主页上"), next: []}));
  else if (o.all) {
    const all = await everyScreenshot(ctx);
    answer = {items: all.items, next: null, quota: all.quota};
  } else answer = await call(ctx, "screenshots_list", {cursor: o.cursor, limit: o.limit});
  const items = (answer.items ?? []).filter(s => !o.public_only || s.public);
  const json = {...answer, items, ...(o.user ? {user: String(o.user)} : {})};
  const lines = [];
  if (items.length) lines.push(table(items.map(s => row(ctx, s)), [3]));
  else lines.push(o.user ? say2(ctx, "No public screenshots.", "没有公开的截图。")
    : o.public_only ? say2(ctx, "None of these is public (screenshots public ID makes one public).", "这些截图都不是公开的（screenshots public ID 公开一张）。")
      : say2(ctx, "No screenshots yet: a device bound to this account uploads its own (HOME + space, or 203cli board screenshot), or 203cli screenshots upload FILE.png.",
        "还没有截图：绑定到这个账号的设备会上传自己的截图（HOME + 空格，或 203cli board screenshot），也可以 203cli screenshots upload FILE.png。"));
  if (answer.quota) lines.push(quotaText(ctx, answer.quota));
  if (answer.next) lines.push(say2(ctx, `— more: --cursor ${answer.next} (or --all)`, `— 还有：--cursor ${answer.next}（或 --all）`));
  return {json, text: lines.join("\n")};
}

export async function screenshotsShow(ctx) {
  const shot = await findScreenshot(ctx, ctx.args.ID);
  return {json: shot, text: screenshotText(ctx, shot)};
}

/** A local file name for a screenshot (its name from the community, kept to [A-Za-z0-9._-]). */
function localName(shot, scale) {
  const base = screenshotName(shot.name || `${shot.id}.png`);
  return scale > 1 ? base.replace(/\.png$/, `-${scale}x.png`) : base;
}

export async function screenshotsDownload(ctx) {
  const o = ctx.flags ?? {}, cwd = ctx.cwd ?? process.cwd();
  const refs = ctx.args.REF ?? [];
  const scale = o.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw ctx.usage(`--scale is a whole number 1-16, not ${o.scale}`, {field: "scale", hint: "e.g. --scale 4: a 240 × 135 screen becomes 960 × 540, each pixel a 4 × 4 block"});
  // --out: a folder (made when missing), or with one screenshot a file (.png).
  const target = path.resolve(cwd, String(o.out ?? "."));
  const asFile = refs.length === 1 && /\.png$/i.test(target) && !(fs.existsSync(target) && fs.statSync(target).isDirectory());
  if (asFile && !fs.existsSync(path.dirname(target))) throw new CliError("file_not_found", `The folder of --out does not exist (${path.dirname(target)})`, {field: "out"});
  if (!asFile && fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw ctx.usage(`--out ${o.out} is a file: with ${refs.length} screenshots it is a folder`, {field: "out", hint: "Give a folder (made when it is missing), or one screenshot and a .png file"});
  }
  const saved = [];
  for (const ref of refs) {
    const shot = await findScreenshot(ctx, ref);
    let original;
    try { original = await downloadScreenshot(ctx.client, shot.id); } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound(ctx, ref);
      throw error;
    }
    let bytes = original, width = shot.width, height = shot.height;
    if (scale > 1) {
      let pixels;
      try { pixels = decodePng(original); } catch (error) {
        throw new CliError("invalid", `${shot.name} cannot be made larger here: ${error.message}`, {field: "scale", hint: "Download it as it is (leave out --scale)"});
      }
      if (pixels.width * scale > SCALED_SIDE || pixels.height * scale > SCALED_SIDE) {
        throw ctx.usage(`${shot.name} is ${pixels.width} × ${pixels.height}: --scale ${scale} makes it larger than ${SCALED_SIDE} pixels a side`, {field: "scale",
          hint: `At most --scale ${Math.max(1, Math.floor(SCALED_SIDE / Math.max(pixels.width, pixels.height)))} for it`});
      }
      const big = scalePixels(pixels, scale);
      bytes = encodePng(big.width, big.height, big.data, big.channels);
      width = big.width;
      height = big.height;
    }
    if (!asFile) fs.mkdirSync(target, {recursive: true});
    const file = asFile ? target : path.join(target, localName(shot, scale));
    fs.writeFileSync(file, bytes);
    saved.push({id: shot.id, name: shot.name, path: file, width, height, scale, bytes: bytes.length});
  }
  return {json: {saved}, text: saved.map(s => `${s.name} → ${s.path} (${s.width} × ${s.height}${s.scale > 1 ? `, ×${s.scale}` : ""}, ${size(s.bytes)})`).join("\n")};
}

/** public / private: one screenshot made public or private; one that is so already is left as it is. */
export async function screenshotsVisibility(ctx, wanted) {
  const shot = await findScreenshot(ctx, ctx.args.ID);
  const word = wanted ? say2(ctx, "public", "公开") : say2(ctx, "private", "私密");
  if (!!shot.public === wanted) {
    return {json: {status: "unchanged", screenshot: shot}, text: say2(ctx, `${shot.name} is ${word} already: nothing changed.`, `${shot.name} 已经是${word}的，没有改动。`)};
  }
  const after = await call(ctx, "screenshot_edit", {id: shot.id, public: wanted}, () => notFound(ctx, ctx.args.ID));
  const what = wanted ? say2(ctx, "anyone sees it on your page now", "现在所有人都能在你的主页上看到它") : say2(ctx, "only you see it now", "现在只有你能看到它");
  return {json: {status: "changed", screenshot: after}, text: `${after.name ?? shot.name}: ${word}, ${what}.`};
}

export async function screenshotsRename(ctx) {
  const title = (ctx.args.TITLE ?? []).join(" ").trim();
  if ([...title].length > SCREENSHOT_LIMITS.title) {
    throw ctx.usage(`The title is ${[...title].length} characters: at most ${SCREENSHOT_LIMITS.title}`, {field: "TITLE", hint: "Say it shorter"});
  }
  const shot = await findScreenshot(ctx, ctx.args.ID);
  if ((shot.title ?? "") === title) {
    return {json: {status: "unchanged", screenshot: shot}, text: say2(ctx, `${shot.name} has that title already: nothing changed.`, `${shot.name} 已经是这个标题，没有改动。`)};
  }
  const after = await call(ctx, "screenshot_edit", {id: shot.id, title}, () => notFound(ctx, ctx.args.ID));
  return {json: {status: "changed", screenshot: after},
    text: title ? say2(ctx, `${shot.name} is called "${after.title ?? title}" now.`, `${shot.name} 的标题改为“${after.title ?? title}”。`)
      : say2(ctx, `${shot.name} has no title now (its file name shows).`, `${shot.name} 不再有标题（显示文件名）。`)};
}

export async function screenshotsDelete(ctx) {
  const done = [];
  for (const ref of ctx.args.ID ?? []) {
    let shot;
    try { shot = await findScreenshot(ctx, ref); } catch (error) {
      // An id that is gone (deleted before: a run again) is done, not an error; a name nobody has is.
      if (error instanceof CliError && error.code === "not_found" && !looksLikeName(String(ref))) { done.push({id: String(ref), name: null, status: "already_deleted"}); continue; }
      throw error;
    }
    try {
      await ctx.op("screenshot_delete", {id: shot.id});
      done.push({id: shot.id, name: shot.name, status: "deleted"});
    } catch (error) {
      if (!(error instanceof ApiError && (error.status === 404 || error.code === "deleted"))) throw error;
      done.push({id: shot.id, name: shot.name, status: "already_deleted"});
    }
  }
  return {json: {deleted: done}, text: done.map(d => d.status === "deleted"
    ? say2(ctx, `Deleted ${d.id} ${d.name} (a device does not upload one of that name again).`, `已删除 ${d.id} ${d.name}（设备不会再上传同名的截图）。`)
    : say2(ctx, `${d.id}: already deleted (or never yours): nothing to do.`, `${d.id}：已经删除（或不是你的），无需处理。`)).join("\n")};
}

/** A local PNG checked as the community will check it: {file, name, bytes, width, height, taken_at}. */
export function checkUpload(ctx, given) {
  const file = path.resolve(ctx.cwd ?? process.cwd(), String(given));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new CliError("file_not_found", `${given} does not exist (looked at ${file})`, {field: "FILE", hint: "Paths are relative to the current folder"});
  }
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (!isPng(bytes)) throw new CliError("invalid", `${given} is not a PNG`, {field: "FILE", hint: "A screenshot is a PNG (a device's, or 203cli board screenshot's)"});
  const dims = pngSize(bytes);
  if (!dims || !dims.width || !dims.height || dims.width > SCREENSHOT_LIMITS.side || dims.height > SCREENSHOT_LIMITS.side) {
    throw new CliError("invalid", `${given} is ${dims ? `${dims.width} × ${dims.height}` : "a PNG without its size"}: a screenshot is at most ${SCREENSHOT_LIMITS.side} × ${SCREENSHOT_LIMITS.side}`,
      {field: "FILE", hint: "Upload the device's own picture (240 × 135), not one made larger"});
  }
  if (bytes.length > SCREENSHOT_LIMITS.bytes) {
    throw new CliError("too_large", `${given} is ${size(bytes.length)}: a screenshot is at most ${size(SCREENSHOT_LIMITS.bytes)}`, {field: "FILE",
      hint: "Upload the device's own picture (a screen is a few KB as a PNG), not one made larger"});
  }
  const name = screenshotName(file);
  return {file, name, bytes, width: dims.width, height: dims.height, taken_at: screenshotTakenAt(name)};
}

export async function screenshotsUpload(ctx) {
  const o = ctx.flags ?? {};
  if (o.device !== undefined && (!Number.isInteger(o.device) || o.device < 1)) throw ctx.usage(`--device is a device's id (devices list), not ${o.device}`, {field: "device"});
  // Every file checked before anything is sent.
  const files = (ctx.args.FILE ?? []).map(file => checkUpload(ctx, file));
  if (o.dry_run) {
    return {json: {status: "dry_run", ready: true, plan: files.map(f => ({file: f.file, name: f.name, width: f.width, height: f.height, bytes: f.bytes.length,
      taken_at: f.taken_at ? new Date(f.taken_at * 1000).toISOString() : null, ...(o.device ? {device: o.device} : {})})), next: ctx.cmd ? [ctx.cmd({remove: ["dry-run"]})] : []},
      text: [...files.map(f => say2(ctx, `upload ${f.file} as ${f.name} (${f.width} × ${f.height}, ${size(f.bytes.length)}; private)`, `上传 ${f.file}，名为 ${f.name}（${f.width} × ${f.height}，${size(f.bytes.length)}；私密）`)),
        say2(ctx, "Nothing was sent (--dry-run).", "什么都没有发送（--dry-run）。")].join("\n")};
  }
  const uploaded = [];
  for (const f of files) {
    let answer;
    try {
      answer = await call(ctx, "screenshot_upload", {file: f.file, name: f.name, ...(f.taken_at ? {taken_at: f.taken_at} : {}), ...(o.device ? {device: o.device} : {})},
        o.device ? () => new CliError("not_found", say2(ctx, `No device of yours has the id ${o.device}`, `你没有 id 为 ${o.device} 的设备`), {field: "device",
          hint: say2(ctx, "devices list shows yours and their ids; or leave out --device", "devices list 列出你的设备和 id；也可以不加 --device"), next: [ctx.run?.(["devices", "list"])].filter(Boolean)}) : null);
    } catch (error) {
      if (error instanceof ApiError && uploaded.length) error.data = {...error.data, uploaded};
      throw error;
    }
    uploaded.push({file: f.file, name: f.name, status: answer.status, screenshot: answer.screenshot});
  }
  return {json: {uploaded}, text: uploaded.map(u => u.status === "uploaded"
    ? say2(ctx, `${u.file} → ${u.screenshot?.id ?? "?"} ${u.name} (private: screenshots public ${u.screenshot?.id ?? "ID"} shows it on your page)`,
      `${u.file} → ${u.screenshot?.id ?? "?"} ${u.name}（私密：screenshots public ${u.screenshot?.id ?? "ID"} 让它出现在你的主页上）`)
    : u.status === "already_there" ? say2(ctx, `${u.file}: the account has ${u.name} already (${u.screenshot?.id ?? "?"}): nothing new.`, `${u.file}：账号里已经有 ${u.name}（${u.screenshot?.id ?? "?"}），没有新建。`)
      : say2(ctx, `${u.file}: you deleted a screenshot named ${u.name} before: not uploaded again.`, `${u.file}：你之前删除过名为 ${u.name} 的截图，不会再上传。`)).join("\n")};
}
