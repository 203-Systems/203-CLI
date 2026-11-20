// A firmware's tutorial (教程), the one format every tutorial on the 203 community is written in: the Cardenza
// Learn guide's (docs/learn/guide.json in CardenzaSynth: lessons of short steps, each with the keys to press and a
// picture of the screen), simplified for authors. The specification is reference/tutorial-format.md (served by
// the community at /tutorial-format.md and /tutorials/format); COMMUNITY.md "Tutorials" is the contract.
//
// One plain ES module for every side: 203c checks a file with it before it publishes (`203c tutorial check`), the
// community's API refuses a document it does not pass, and the website's editor checks while one types and draws
// the steps' words with its tokens (inline()). Keep it free of Node, Deno and DOM APIs. The community keeps
// byte-identical copies (site/tutorial-format.js, supabase/functions/_shared/tutorial-format.js).

export const FORMAT = "203-tutorial/1";
export const LANGUAGES = Object.freeze(["zh", "en"]);

// Limits (the guide's steps are short: half of them under 60 Chinese characters or 80 English letters). Widths count
// a Chinese, Japanese or Korean character (or a full-width sign) as 2, anything else as 1, on the words as shown (a
// link's address and the markup's signs are not counted; {{key:fn}} counts as the key's name).
export const LIMITS = Object.freeze({
  bytes: 200 * 1024,       // the file, UTF-8
  title: [2, 60],          // the tutorial's title
  summary: 200,            // the tutorial's summary (optional)
  lessons: [1, 30],
  lessonTitle: [1, 60],
  lead: 200,               // a lesson's lead (optional)
  steps: [1, 30],          // a lesson's steps
  allSteps: 300,           // every lesson's together
  say: [1, 280],           // a step's words
  keys: 8,                 // a step's key groups
  combo: 4,                // keys pressed together in one group (fn+s)
  pictures: 60,            // different pictures in one tutorial (the author's pictures for a firmware: also 60)
  linkTitle: [2, 60],      // a link tutorial's title
  url: 500,
});

// The Cardenza's key caps, as CardenzaHAL's keyboard/legends.h names them (key number = row * 14 + column + 1), and
// HOME, the side key left of the screen (not in the matrix). The same names as `203c board press`.
export const KEY_ROWS = Object.freeze([
  ["esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "del"],
  ["tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"],
  ["fn", "shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "ok"],
  ["ctrl", "opt", "alt", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "space"],
]);
export const HOME = "home";
// Other names: ok is enter; the yellow arrows printed on ; . , / (what lists and menus take).
export const KEY_ALIASES = Object.freeze({enter: "ok", up: ";", down: ".", left: ",", right: "/"});
const KEY_POS = new Map(KEY_ROWS.flatMap((row, r) => row.map((name, c) => [name, [r, c]])));

/** A key's place on the board, [row, column], or null (HOME and unknown names). */
export const keyPosition = name => KEY_POS.get(name) ?? null;

/** One key's canonical name (the cap's, lower case; an alias resolved), or null. */
export function keyName(text) {
  const lower = String(text).trim().toLowerCase();
  const name = KEY_ALIASES[lower] ?? lower;
  return name === HOME || KEY_POS.has(name) ? name : null;
}

/** A key group (one key, or keys pressed together: fn+s): its keys' canonical names, or null when one is unknown. */
export function keyGroup(text) {
  const raw = String(text).trim();
  if (!raw || raw.length > 40) return null;
  // "+" joins keys; no key is called "+" (it is the shifted =).
  const parts = raw.split("+").map(p => p.trim());
  const names = [];
  for (const part of parts) {
    const name = keyName(part);
    if (!name || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

const KEY_HELP = "esc 1-0 - = del, tab q-p [ ] \\, fn shift a-l ; ' ok, ctrl opt alt z-m , . / space, home; enter up down left right";

// ---------------------------------------------------------------------------------------------
// Widths and the steps' words

const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** Width: 2 for a wide character (CJK, full-width), 1 for any other. */
export function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += WIDE.test(ch) || ch.codePointAt(0) >= 0x20000 && ch.codePointAt(0) <= 0x3fffd ? 2 : 1;
  return width;
}

// The inline markup of a step's words (a lesson's lead too): `code`, {{key:fn}} (a key cap; keys pressed together
// fn+s), **bold**, *italic*, [words](https://…) and bare https:// links. Nothing else: no HTML, no pictures, no
// headings, lists or quotes, no line breaks.
const INLINE = /`([^`\n]{1,200})`|\{\{key:([^{}\n]{1,40})\}\}|\*\*([^*\n](?:[^*\n]|\*(?!\*))*?)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)|(https:\/\/[^\s<>()[\]{}"'`]{1,500})/g;

/**
 * The words as tokens, for drawing them without HTML: {text}, {code}, {key: [names]} (keys null when unknown),
 * {bold: [tokens]}, {em: [tokens]}, {link: href | null (not https), kids: [tokens]}. A sentence's last full stop or
 * comma is not part of a bare link.
 */
export function inline(text, depth = 0) {
  const out = [];
  const s = String(text ?? "");
  let pos = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > pos) out.push({text: s.slice(pos, m.index)});
    const [all, code, key, bold, em, linkText, linkUrl, bare] = m;
    if (code !== undefined) out.push({code});
    else if (key !== undefined) out.push({key: keyGroup(key), raw: key});
    else if (bold !== undefined) out.push({bold: depth < 2 ? inline(bold, depth + 1) : [{text: bold}]});
    else if (em !== undefined) out.push({em: depth < 2 ? inline(em, depth + 1) : [{text: em}]});
    else if (linkText !== undefined) out.push({link: httpsLink(linkUrl), url: linkUrl, kids: depth < 2 ? inline(linkText, depth + 1) : [{text: linkText}]});
    else {
      let url = bare, tail = "";
      while (/[.,;:!?。，；：！？]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
      out.push({link: httpsLink(url), url, kids: [{text: url.replace(/^https:\/\//, "")}]});
      if (tail) out.push({text: tail});
    }
    pos = m.index + all.length;
  }
  if (pos < s.length) out.push({text: s.slice(pos)});
  return out;
}

/** The words as shown, without markup (what the widths count). */
export function plainText(text) {
  const walk = tokens => tokens.map(t => t.text ?? t.code ?? (t.key !== undefined ? (t.key ? t.key.join("+") : t.raw)
    : walk(t.bold ?? t.em ?? t.kids ?? []))).join("");
  return walk(inline(text));
}

/** An https link as given, or null (another scheme, a user name or password in it, a space, too long). */
export function httpsLink(value) {
  const s = String(value ?? "").trim();
  if (s.length > LIMITS.url || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s<>"\\]*)?$/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  } catch { return null; }
  return s;
}

// What the words may not have: the problems of one text, [code, params]. Inline markup is read with the same tokens
// as it is drawn.
function wordProblems(text) {
  const problems = [];
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text.replace(/\n/g, ""))) problems.push(["control", {}]);
  if (/\n/.test(text)) problems.push(["newline", {}]);
  if (/<[A-Za-z!/?]/.test(text) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(text)) problems.push(["html", {}]);
  if (/!\[[^\]\n]*\]\(/.test(text)) problems.push(["picture_in_text", {}]);
  if (/^\s*(#{1,6}\s|>|[-*+]\s|```|~~~)/.test(text)) problems.push(["block", {}]);
  const walk = tokens => {
    for (const t of tokens) {
      if (t.key === null) problems.push(["key_unknown", {key: t.raw}]);
      else if (t.link === null) problems.push(["link", {url: t.url}]);
      else if (t.text !== undefined && /\{\{|\}\}/.test(t.text)) problems.push(["markup", {}]);
      if (t.bold || t.em || t.kids) walk(t.bold ?? t.em ?? t.kids);
    }
  };
  walk(inline(text));
  return problems;
}

// ---------------------------------------------------------------------------------------------
// JSON with places: every value's and key's line and column (1-based), duplicate keys refused.

class Syntax extends Error {
  constructor(message, line, column, code = "syntax") { super(message); this.line = line; this.column = column; this.code = code; }
}

/** Parses JSON text: {value, at: Map(path → {line, column}), keyAt: Map(path → {line, column})}; throws Syntax. */
export function parseJson(text) {
  const s = String(text);
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1, lineStart = i;
  const at = new Map(), keyAt = new Map();
  const place = () => ({line, column: i - lineStart + 1});
  const fail = (message, code) => { throw new Syntax(message, line, i - lineStart + 1, code); };
  const space = () => {
    for (;;) {
      const c = s[i];
      if (c === "\n") { i++; line++; lineStart = i; }
      else if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) fail("JSON has no comments", "syntax_comment");
      else return;
    }
  };
  const string = () => {
    i++;
    let out = "";
    for (;;) {
      if (i >= s.length) fail("A text is not closed (a \" is missing)");
      const c = s[i];
      if (c === "\"") { i++; return out; }
      if (c === "\n") fail("A text is not closed on its line (a \" is missing; a line break in a text is written \\n)");
      if (c < " ") fail("A control character in a text");
      if (c === "\\") {
        const e = s[i + 1];
        const simple = {"\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t"}[e];
        if (simple !== undefined) { out += simple; i += 2; continue; }
        if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
        fail("An unknown escape \\" + (e ?? "") + " in a text");
      }
      out += c;
      i++;
    }
  };
  const value = path => {
    space();
    at.set(path, place());
    const c = s[i];
    if (c === "{") {
      i++;
      const obj = {};
      space();
      if (s[i] === "}") { i++; return obj; }
      for (;;) {
        space();
        if (s[i] !== "\"") fail(s[i] === "}" ? "A comma before } (JSON has no trailing commas)" : "A field's name is a text in \"…\"");
        const where = place();
        const key = string();
        const sub = path ? path + "." + key : key;
        if (Object.prototype.hasOwnProperty.call(obj, key)) throw new Syntax(`"${key}" twice in one object`, where.line, where.column, "duplicate_field");
        keyAt.set(sub, where);
        space();
        if (s[i] !== ":") fail(`A : after "${key}"`);
        i++;
        obj[key] = value(sub);
        space();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return obj; }
        fail("A , or } after a field");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      space();
      if (s[i] === "]") { i++; return arr; }
      for (;;) {
        space();
        if (s[i] === "]") fail("A comma before ] (JSON has no trailing commas)");
        arr.push(value(path + "." + arr.length));
        space();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return arr; }
        fail("A , or ] after an item");
      }
    }
    if (c === "\"") return string();
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 40));
    if (!m) fail(i >= s.length ? "The file ends too early" : s[i] === "'" ? "Texts are in double quotes \"…\", not '…'" : `Unexpected ${JSON.stringify(s[i])}`);
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  const result = value("");
  space();
  if (i < s.length) fail("More after the end of the JSON");
  return {value: result, at, keyAt};
}

// ---------------------------------------------------------------------------------------------
// Messages: every error has a code, its params and a sentence in English and Chinese.

const MESSAGES = {
  syntax: [p => p.detail, p => "JSON 写错了：" + p.detail],
  syntax_comment: [() => "JSON has no comments", () => "JSON 不能写注释"],
  duplicate_field: [p => p.detail, p => `同一个对象里有两个 "${p.field}"`],
  too_big: [p => `The file is ${p.bytes} bytes; at most ${p.max}`, p => `文件有 ${p.bytes} 字节，最多 ${p.max}`],
  not_object: [() => "A tutorial is a JSON object {…}", () => "教程是一个 JSON 对象 {…}"],
  format: [() => `"format" is "${FORMAT}"`, () => `"format" 要写 "${FORMAT}"`],
  unknown_field: [p => `Unknown field "${p.field}" (${p.allowed})`, p => `不认识的字段 "${p.field}"（可以有：${p.allowed}）`],
  required: [p => `"${p.field}" is missing`, p => `缺少 "${p.field}"`],
  type: [p => `Should be ${p.want}`, p => `应该是${p.want_zh}`],
  languages: [() => `"languages" lists "zh", "en" or both: the languages every text is written in`, () => `"languages" 写 "zh"、"en" 或两个都写：每段文字用哪几种语言写`],
  language_missing: [p => `No ${p.lang} text (the tutorial is in ${p.languages})`, p => `缺少 ${p.lang} 的文字（这个教程用 ${p.languages}）`],
  language_extra: [p => `"${p.lang}" is not in "languages"`, p => `"${p.lang}" 不在 "languages" 里`],
  empty: [() => "Empty", () => "是空的"],
  too_long: [p => `Too long: ${p.width} of at most ${p.max} (a Chinese character counts 2)`, p => `太长：${p.width}，最多 ${p.max}（一个汉字算 2）`],
  too_short: [p => `Too short: at least ${p.min}`, p => `太短：至少 ${p.min}`],
  count: [p => `${p.count} ${p.what}: ${p.min} to ${p.max}`, p => `${p.count} 个${p.what_zh}：要 ${p.min} 到 ${p.max} 个`],
  all_steps: [p => `${p.count} steps in all; at most ${p.max}`, p => `一共 ${p.count} 步，最多 ${p.max} 步`],
  control: [() => "A control or invisible character", () => "有控制字符或看不见的字符"],
  newline: [() => "One paragraph: no line breaks (make it two steps)", () => "一段话，不能换行（拆成两步）"],
  html: [() => "No HTML (no <tags> or &entities;)", () => "不能写 HTML（<标签>、&实体;）"],
  picture_in_text: [() => "No pictures in the words: a step's picture is its \"image\"", () => "文字里不能放图片：一步的图片写在 \"image\""],
  block: [() => "Only inline markup: no headings, lists, quotes, tables or code blocks", () => "只能用行内标记：不能写标题、列表、引用、表格、代码块"],
  markup: [() => "{{…}} is only {{key:NAME}}, a key cap", () => "{{…}} 只能写 {{key:键名}}，按键"],
  key_unknown: [p => `Unknown key "${p.key}". Keys: ${KEY_HELP}; pressed together: fn+s`, p => `不认识的按键 "${p.key}"。键名：${KEY_HELP}；同时按：fn+s`],
  key_twice: [p => `"${p.key}" twice in this step's keys`, p => `"${p.key}" 在这一步的按键里写了两次`],
  combo: [p => `${p.count} keys pressed together; at most ${LIMITS.combo}`, p => `同时按 ${p.count} 个键，最多 ${LIMITS.combo} 个`],
  link: [p => `Links are https:// (${p.url})`, p => `链接只能是 https://（${p.url}）`],
  picture_path: [p => `A picture is a PNG, JPEG or WebP file of this project (a relative path like shots/menu.png), or image:<id> once uploaded: ${p.ref}`,
    p => `图片是项目里的 PNG、JPEG 或 WebP 文件（相对路径，比如 shots/menu.png），上传后写 image:<id>：${p.ref}`],
  picture_remote: [() => "Pictures come from the community only: upload it (203c tutorial publish, or the editor's 图片 / Pictures)",
    () => "图片只能来自社区：先上传（203c tutorial publish，或编辑器的「图片」）"],
  picture_not_uploaded: [p => `${p.ref} is not uploaded yet: add it under Pictures (the file named ${p.name}), or publish with 203c`,
    p => `${p.ref} 还没上传：在「图片」里加上这个文件（${p.name}），或用 203c 发布`],
  picture_unknown: [p => `image:${p.id} is not one of your pictures for this firmware`, p => `image:${p.id} 不是你给这个固件上传的图片`],
  too_many_pictures: [p => `${p.count} different pictures; at most ${LIMITS.pictures}`, p => `${p.count} 张不同的图片，最多 ${LIMITS.pictures} 张`],
  firmware: [p => `"firmware" is ${p.code}, but this tutorial is for ${p.want}`, p => `"firmware" 写的是 ${p.code}，这个教程却是给 ${p.want} 的`],
  firmware_code: [() => `"firmware" is a firmware's six-character code (V6QK28)`, () => `"firmware" 是固件的 6 位代码（如 V6QK28）`],
};

const TYPES = {object: ["an object {…}", "对象 {…}"], array: ["a list […]", "列表 […]"], string: ["a text \"…\"", "文字 \"…\""],
  text: ["a text \"…\" or {\"zh\": …, \"en\": …}", "文字 \"…\" 或 {\"zh\": …, \"en\": …}"], texts: ["{\"zh\": \"…\", \"en\": \"…\"} (one text a language)", "每种语言一段：{\"zh\": \"…\", \"en\": \"…\"}"]};

/** An error's sentence in a language ("zh" or "en"). */
export function errorMessage(error, lang = "en") {
  const m = MESSAGES[error.code];
  if (!m) return error.code;
  return m[lang === "zh" ? 1 : 0](error.params ?? {});
}

/** Where an error is, for people: "lesson 2, step 3" / "第 2 课第 3 步" (from its path), or "". */
export function errorWhere(error, lang = "en") {
  const m = /^lessons\.(\d+)(?:\.steps\.(\d+))?/.exec(error.path ?? "");
  if (!m) return "";
  const lesson = Number(m[1]) + 1, step = m[2] !== undefined ? Number(m[2]) + 1 : null;
  return lang === "zh" ? `第 ${lesson} 课` + (step ? `第 ${step} 步` : "") : `lesson ${lesson}` + (step ? `, step ${step}` : "");
}

/** A path as written in JSON terms: lessons[1].steps[2].say.en. */
export function jsonPath(path) {
  return String(path ?? "").split(".").filter(Boolean).map((part, n) => (/^\d+$/.test(part) ? `[${part}]` : (n ? "." : "") + part)).join("");
}

/** One line for a terminal or a list: "14:9 lessons[0].steps[2].say.en: Too long … (lesson 1, step 3)". */
export function formatError(error, lang = "en", file = "") {
  const where = errorWhere(error, lang);
  const place = error.line ? `${file ? file + ":" : ""}${error.line}:${error.column}` : file;
  return `${place ? place + " " : ""}${error.path ? jsonPath(error.path) + ": " : ""}${errorMessage(error, lang)}${where ? (lang === "zh" ? `（${where}）` : ` (${where})`) : ""}`;
}

// ---------------------------------------------------------------------------------------------
// The check

const IMAGE_REF = /^image:([2-9a-hjkmnp-z]{8})$/;
const PICTURE_FILE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\\:*?"<>|\u0000-\u001f]{1,200}\.(png|jpe?g|webp)$/i;
const CODE = /^[2-9A-HJ-NP-Z]{6}$/;

/**
 * Checks a tutorial: its text (JSON) or an object already parsed.
 *   pictures: "local" (203c: a picture may be a relative path of a file, or image:<id>), "uploaded" (the API: image:<id>
 *             only, each one of `uploaded` when that is given) or "any" (the editor: paths are said to need uploading;
 *             with `names`, a path whose file name is among them says so).
 *   uploaded: the ids (Set or array) of the author's pictures for the firmware.
 *   firmware: the code it is checked for ("firmware" in the file must then be that one).
 * → {ok, errors: [{code, params, path, line, column}], tutorial (normalized: every text {lang: words}, keys by their
 *   canonical names, null when not ok), pictures: [{ref, id | null, path | null, line, column, step: [lesson, step]}]}.
 */
export function checkTutorial(input, {pictures: mode = "local", uploaded = null, firmware = null} = {}) {
  const errors = [];
  let parsed;
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).length;
    if (bytes > LIMITS.bytes) return {ok: false, errors: [{code: "too_big", params: {bytes, max: LIMITS.bytes}, path: "", line: 1, column: 1}], tutorial: null, pictures: []};
    try { parsed = parseJson(input); }
    catch (e) {
      if (!(e instanceof Syntax)) throw e;
      const params = e.code === "duplicate_field" ? {detail: e.message, field: /"([^"]*)"/.exec(e.message)?.[1] ?? ""} : {detail: e.message};
      return {ok: false, errors: [{code: e.code, params, path: "", line: e.line, column: e.column}], tutorial: null, pictures: []};
    }
  } else parsed = {value: input, at: new Map(), keyAt: new Map()};
  const {value: doc, at, keyAt} = parsed;
  const err = (code, path, params = {}, key = false) => {
    const where = (key ? keyAt.get(path) : null) ?? at.get(path) ?? nearest(at, path) ?? {line: 0, column: 0};
    errors.push({code, params, path, line: where.line, column: where.column});
  };
  const known = uploaded ? new Set(uploaded) : null;
  const pics = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    err("not_object", "");
    return {ok: false, errors, tutorial: null, pictures: []};
  }
  const fields = (obj, path, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err("unknown_field", path ? path + "." + k : k, {field: k, allowed: allowed.join(", ")}, true);
  };
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const typeErr = (path, want) => err("type", path, {want: TYPES[want][0], want_zh: TYPES[want][1]});

  fields(doc, "", ["format", "firmware", "languages", "title", "summary", "lessons"]);
  if (!("format" in doc)) err("required", "", {field: "format"});
  else if (doc.format !== FORMAT) err("format", "format");
  let firmwareCode = null;
  if ("firmware" in doc && doc.firmware !== null) {
    const code = typeof doc.firmware === "string" ? doc.firmware.trim().toUpperCase() : "";
    if (!CODE.test(code)) err("firmware_code", "firmware");
    else if (firmware && code !== String(firmware).toUpperCase()) err("firmware", "firmware", {code, want: String(firmware).toUpperCase()});
    else firmwareCode = code;
  }
  let languages = [];
  if (!("languages" in doc)) err("required", "", {field: "languages"});
  else if (!Array.isArray(doc.languages) || !doc.languages.length || doc.languages.length > 2 ||
           doc.languages.some(l => !LANGUAGES.includes(l)) || new Set(doc.languages).size !== doc.languages.length) err("languages", "languages");
  else languages = doc.languages.slice();
  const langs = languages.length ? languages : ["en"];

  // A text in every language of the tutorial: "words" (one language) or {"zh": "…", "en": "…"}. markup: the step's
  // inline markup is read (else plain). An optional text that is absent, null or empty in every language is none.
  const text = (obj, key, path, {min = 1, max, markup = false, optional = false} = {}) => {
    const sub = path ? path + "." + key : key;
    const value = obj[key];
    if (!(key in obj) || value === null || optional && (value === "" || isObj(value) && Object.values(value).every(v => v === ""))) {
      if (!optional) err("required", path, {field: key});
      return null;
    }
    let texts = value;
    if (typeof value === "string") {
      if (languages.length > 1) { typeErr(sub, "texts"); return null; }
      texts = {[langs[0]]: value};
      if (at.has(sub)) at.set(sub + "." + langs[0], at.get(sub));
    } else if (!isObj(value)) { typeErr(sub, languages.length > 1 ? "texts" : "text"); return null; }
    const out = {};
    for (const k of Object.keys(texts)) if (!LANGUAGES.includes(k) || languages.length && !languages.includes(k)) err("language_extra", sub + "." + k, {lang: k}, true);
    for (const lang of languages.length ? languages : LANGUAGES.filter(l => l in texts)) {
      const p = sub + "." + lang;
      if (!(lang in texts)) { err("language_missing", sub, {lang, languages: languages.join(", ")}); continue; }
      if (typeof texts[lang] !== "string") { typeErr(p, "string"); continue; }
      const words = texts[lang].trim();
      if (!words) { err("empty", p); continue; }
      for (const [code, params] of markup ? wordProblems(words) : plainProblems(words)) err(code, p, params);
      const width = textWidth(markup ? plainText(words) : words);
      if (width > max) err("too_long", p, {width, max});
      else if (width < min) err("too_short", p, {min});
      out[lang] = words;
    }
    return out;
  };

  const tutorial = {format: FORMAT, firmware: firmwareCode, languages: langs, title: null, summary: null, lessons: []};
  tutorial.title = text(doc, "title", "", {min: LIMITS.title[0], max: LIMITS.title[1]});
  tutorial.summary = text(doc, "summary", "", {min: 0, max: LIMITS.summary, optional: true});
  let total = 0;
  if (!("lessons" in doc)) err("required", "", {field: "lessons"});
  else if (!Array.isArray(doc.lessons)) typeErr("lessons", "array");
  else {
    const [lo, hi] = LIMITS.lessons;
    if (doc.lessons.length < lo || doc.lessons.length > hi) err("count", "lessons", {count: doc.lessons.length, what: "lessons", what_zh: "课", min: lo, max: hi});
    doc.lessons.slice(0, hi).forEach((lesson, li) => {
      const lp = "lessons." + li;
      if (!isObj(lesson)) { typeErr(lp, "object"); return; }
      fields(lesson, lp, ["title", "lead", "steps"]);
      const out = {title: text(lesson, "title", lp, {min: LIMITS.lessonTitle[0], max: LIMITS.lessonTitle[1]}),
        lead: text(lesson, "lead", lp, {min: 0, max: LIMITS.lead, markup: true, optional: true}), steps: []};
      if (!("steps" in lesson)) err("required", lp, {field: "steps"});
      else if (!Array.isArray(lesson.steps)) typeErr(lp + ".steps", "array");
      else {
        const [slo, shi] = LIMITS.steps;
        if (lesson.steps.length < slo || lesson.steps.length > shi) err("count", lp + ".steps", {count: lesson.steps.length, what: "steps", what_zh: "步", min: slo, max: shi});
        total += lesson.steps.length;
        lesson.steps.slice(0, shi).forEach((step, si) => {
          const sp = lp + ".steps." + si;
          if (!isObj(step)) { typeErr(sp, "object"); return; }
          fields(step, sp, ["say", "keys", "image"]);
          const st = {say: text(step, "say", sp, {min: LIMITS.say[0], max: LIMITS.say[1], markup: true}), keys: [], image: null};
          if ("keys" in step && step.keys !== null) {
            if (!Array.isArray(step.keys)) typeErr(sp + ".keys", "array");
            else {
              if (step.keys.length > LIMITS.keys) err("count", sp + ".keys", {count: step.keys.length, what: "key groups", what_zh: "按键组", min: 0, max: LIMITS.keys});
              const seen = new Set();
              step.keys.forEach((token, ki) => {
                const kp = sp + ".keys." + ki;
                if (typeof token !== "string") { typeErr(kp, "string"); return; }
                const group = keyGroup(token);
                if (!group) { err("key_unknown", kp, {key: token}); return; }
                if (group.length > LIMITS.combo) { err("combo", kp, {count: group.length}); return; }
                const canonical = group.join("+");
                if (seen.has(canonical)) { err("key_twice", kp, {key: canonical}); return; }
                seen.add(canonical);
                st.keys.push(canonical);
              });
            }
          }
          if ("image" in step && step.image !== null) {
            const ip = sp + ".image";
            const where = at.get(ip) ?? {line: 0, column: 0};
            if (typeof step.image !== "string") typeErr(ip, "string");
            else {
              const ref = step.image.trim();
              const id = IMAGE_REF.exec(ref.toLowerCase())?.[1] ?? null;
              if (id) {
                if (known && !known.has(id)) err("picture_unknown", ip, {id});
                st.image = "image:" + id;
                pics.push({ref: st.image, id, path: null, ...where, step: [li, si]});
              } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) err(/^https?:/i.test(ref) ? "picture_remote" : "picture_path", ip, {ref});
              else if (!PICTURE_FILE.test(ref.replace(/^\.\//, ""))) err("picture_path", ip, {ref});
              else if (mode === "uploaded") err("picture_not_uploaded", ip, {ref, name: ref.split("/").pop()});
              else {
                const path = ref.replace(/^\.\//, "");
                if (mode === "any") err("picture_not_uploaded", ip, {ref, name: path.split("/").pop()});
                st.image = path;
                pics.push({ref: path, id: null, path, ...where, step: [li, si]});
              }
            }
          }
          out.steps.push(st);
        });
      }
      tutorial.lessons.push(out);
    });
    if (total > LIMITS.allSteps) err("all_steps", "lessons", {count: total, max: LIMITS.allSteps});
  }
  const distinct = new Set(pics.map(p => p.ref)).size;
  if (distinct > LIMITS.pictures) err("too_many_pictures", "lessons", {count: distinct});
  errors.sort((a, b) => a.line - b.line || a.column - b.column);
  return {ok: !errors.length, errors, tutorial: errors.length ? null : tutorial, pictures: pics};
}

// A title's or a summary's text: plain (no markup is drawn there), no control characters, no HTML.
function plainProblems(text) {
  const problems = [];
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text)) problems.push(["control", {}]);
  if (/<[A-Za-z!/?]/.test(text)) problems.push(["html", {}]);
  return problems;
}

// The place of the closest value or key above a path (a missing field is said where its object begins).
function nearest(at, path) {
  let p = path;
  while (p) {
    p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
    if (at.has(p)) return at.get(p);
  }
  return at.get("") ?? null;
}

/** The words of a text in a language: that language's, else the tutorial's first. */
export function pick(texts, lang, languages = LANGUAGES) {
  if (!texts) return "";
  return texts[lang] ?? texts[languages[0]] ?? Object.values(texts)[0] ?? "";
}

/** The steps of a tutorial in order, each with its lesson and step numbers (0-based): [{lesson, step, …step}]. */
export function allSteps(tutorial) {
  return (tutorial?.lessons ?? []).flatMap((lesson, li) => lesson.steps.map((step, si) => ({lesson: li, step: si, ...step})));
}

/** A link tutorial ({"title", "url", "languages"?}): its problems [{code, params, field}] and the cleaned values. */
export function checkLink({title, url} = {}) {
  const errors = [];
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) errors.push({code: "required", params: {field: "title"}, field: "title"});
  else {
    const w = textWidth(t);
    if (w < LIMITS.linkTitle[0]) errors.push({code: "too_short", params: {min: LIMITS.linkTitle[0]}, field: "title"});
    if (w > LIMITS.linkTitle[1]) errors.push({code: "too_long", params: {width: w, max: LIMITS.linkTitle[1]}, field: "title"});
    for (const [code, params] of plainProblems(t)) errors.push({code, params, field: "title"});
  }
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) errors.push({code: "required", params: {field: "url"}, field: "url"});
  else if (!httpsLink(u)) errors.push({code: "link", params: {url: u.slice(0, 80)}, field: "url"});
  return {ok: !errors.length, errors, title: t, url: u};
}

/** A new tutorial's text, to start from: one lesson of two steps, in the languages given. */
export function starter({languages = ["zh", "en"], title = null, firmware = null} = {}) {
  const both = languages.length > 1;
  const words = (zh, en) => (both ? {zh, en} : languages[0] === "zh" ? zh : en);
  const doc = {
    format: FORMAT,
    ...(firmware ? {firmware} : {}),
    languages,
    title: title ? (both ? {zh: title, en: title} : title) : words("上手", "Getting started"),
    summary: words("几分钟学会最常用的操作。", "The few things you do most, in a few minutes."),
    lessons: [{
      title: words("第一步", "First steps"),
      lead: words("开机，认识按键。", "Switch it on and meet the keys."),
      steps: [
        {say: words("按 {{key:ok}}：打开菜单。", "Press {{key:ok}}: the menu opens."), keys: ["ok"]},
        {say: words("按 {{key:;}} 和 {{key:.}} 上下移动，{{key:esc}} 返回。", "{{key:;}} and {{key:.}} move up and down; {{key:esc}} goes back."),
          keys: [";", ".", "esc"]},
      ],
    }],
  };
  return JSON.stringify(doc, null, 2) + "\n";
}
