// A firmware's description and gallery as the community wants them (the user, 2026-11-20: "简介必须按照产品简介一样，简洁
// 高效" and "使用CLI应该强制上传3~5张不同的"): the guide (reference/description-guide.md, also the website's
// /guide/description), its template, the description's length as the community counts it, and the gallery's rule for a
// publish with 203c. Pure functions: publish.mjs, scaffold.mjs and guide.mjs use them. Part of the Agent Skill
// skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const GUIDE_URL = "https://cardenza.203.io/community/guide/description";
export const GUIDE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reference", "description-guide.md");
// Characters, pictures not counted: aim for 800; over 1500 a warning; over 3000 the community refuses a new or changed one.
export const DESCRIPTION_TARGET = 800, DESCRIPTION_WARN = 1500, DESCRIPTION_MAX = 3000;
// The gallery a publish with 203c leaves (the site only suggests it): 3-5 pictures, all different.
export const GALLERY_MIN = 3, GALLERY_MOST = 5;

// A picture placed by the description (![words](image:<id>)): not counted.
const PLACED_PICTURE = /!\[[^\]\n]{0,200}\]\(\s*image:[A-Za-z0-9-]{1,32}\s*\)/gi;

/** The description's length as the community counts it: code points, CR LF as LF, trimmed, its image:<id> pictures taken out. */
export function descriptionLength(text) {
  const kept = String(text ?? "").replace(/\r\n/g, "\n").replace(/^[ \n\t]+|[ \n\t]+$/g, "");
  return [...kept.replace(PLACED_PICTURE, "")].length;
}

let guide = null;
/** The guide's text ([en] part, then [zh]), or "" when the file is not there. */
export function guideText() {
  if (guide === null) { try { guide = fs.readFileSync(GUIDE_FILE, "utf8"); } catch { guide = ""; } }
  return guide;
}

/** The guide's part in a language (zh or en; English when it has no such part). */
export function guidePart(lang = "en") {
  const parts = {};
  let current = null;
  for (const line of guideText().split("\n")) {
    const marker = /^\[(en|zh)\][ \t]*$/.exec(line);
    if (marker) { current = marker[1]; parts[current] = []; continue; }
    if (current) parts[current].push(line);
  }
  const part = parts[lang === "zh" ? "zh" : "en"] ?? parts.en ?? [];
  return part.join("\n").trim();
}

/** The template (the guide's {#template} section's Markdown block) in a language, ending in a newline. */
export function descriptionTemplate(lang = "en") {
  const part = guidePart(lang);
  const at = part.search(/^## .*\{#template\}/m);
  const block = at < 0 ? null : /```markdown\n([\s\S]*?)```/.exec(part.slice(at));
  return block ? block[1].replace(/\n+$/, "") + "\n" : "";
}

/** The template's placeholders (each <…> it holds), in both languages. */
export function templatePlaceholders() {
  const found = new Set();
  for (const lang of ["en", "zh"]) for (const [token] of descriptionTemplate(lang).matchAll(/<[^<>\n]+>/g)) found.add(token);
  return found;
}

/** The first of the template's placeholders a text still holds, or null. */
export function placeholderIn(text) {
  if (typeof text !== "string" || !text.includes("<")) return null;
  return [...templatePlaceholders()].find(token => text.includes(token)) ?? null;
}

/**
 * The gallery's rule: {count, distinct, duplicates, ok, problem: "few" | "many" | "same" | null} for a list of
 * {sha (null: unknown, counted as its own), name}.
 */
export function galleryRule(items) {
  const seen = new Map(), duplicates = [];
  for (const item of items) {
    if (!item.sha) continue;
    if (seen.has(item.sha)) duplicates.push(item.name);
    else seen.set(item.sha, item.name);
  }
  const count = items.length, distinct = count - duplicates.length;
  const problem = duplicates.length ? "same" : count < GALLERY_MIN ? "few" : count > GALLERY_MOST ? "many" : null;
  return {count, distinct, duplicates, ok: !problem, problem};
}

/**
 * A project's docs/description.md from the template (in lang) when it has none: {rel, written}. One that is the other
 * language's untouched template is written again in this one.
 */
export function scaffoldDescription(dir, lang = "en") {
  const rel = "docs/description.md", file = path.join(dir, rel);
  const text = descriptionTemplate(lang);
  if (!text) return {rel: null, written: false};
  if (fs.existsSync(file)) {
    const other = descriptionTemplate(lang === "zh" ? "en" : "zh");
    if (fs.readFileSync(file, "utf8") !== other || other === text) return {rel, written: false};
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
  return {rel, written: true};
}
