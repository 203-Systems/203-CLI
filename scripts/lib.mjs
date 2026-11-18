// The community API for agents and scripts, without dependencies (Node 18+): a client, the saved
// token, and every operation (OPS: what 203c's commands run; `203c ops` lists them as JSON).
// Part of the Agent Skill skill/203-community (this folder is the only copy of the CLI).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {parseStl, renderThumbnail} from "./stl.mjs";

// The live copy until community.203.io exists (COMMUNITY.md "203c (the CLI) and the developer guide").
export const DEFAULT_API = "https://cardenza.203.io/community/api";
// 203c's own version (doctor prints it; the API sees it in User-Agent).
export const CLI_VERSION = "3.4.0";

export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status; this.code = code; this.data = data;
  }
}

// ---------------------------------------------------------------------------------------------
// The token: COMMUNITY_TOKEN, else in GitHub Actions this run's trusted-publishing credential (login
// --github-oidc), else ~/.config/203c/token (XDG_CONFIG_HOME respected), mode 600.

export function tokenFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "203c", "token");
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
  return inGithubActions(env) && env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, "203c", "oidc.json") : null;
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
  const jwt = await githubOidcToken(client.api, {env, fetch: client.fetch});
  return await client.request("POST", "/auth/oidc/github", {auth: false, body: {token: jwt, firmware}});
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

export class Client {
  constructor({api = process.env.COMMUNITY_API || DEFAULT_API, token, fetch: fetcher = globalThis.fetch, lang = defaultLang()} = {}) {
    this.api = api.replace(/\/+$/, "");
    this.token = token === undefined ? loadToken(this.api) : token;
    this.fetch = fetcher;
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
  langHeaders() { return {"Accept-Language": this.lang === "zh" ? "zh-CN,zh;q=0.9" : "en", "User-Agent": "203c/" + CLI_VERSION}; }

  async request(method, apiPath, options = {}) {
    if (this.run && options.auth !== false && Date.parse(this.run.expires_at) - Date.now() < 60_000 && oidcAvailable()) await this.renewRun();
    try { return await this.send(method, apiPath, options); }
    catch (error) {
      // Ended early (revoked with its publisher, or the clock): once more with a new one.
      if (!(this.run && options.auth !== false && error instanceof ApiError && error.status === 401 && oidcAvailable())) throw error;
      await this.renewRun();
      return await this.send(method, apiPath, options);
    }
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
    catch (error) { throw new ApiError(0, "unreachable", "Cannot reach " + this.api + " (" + (error.cause?.code || error.message) + ")"); }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
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
  catch (error) { throw new ApiError(0, "unreachable", "The upload failed: " + (error.cause?.code || error.message)); }
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
    catch (error) { throw new ApiError(0, "unreachable", "The upload failed: " + (error.cause?.code || error.message)); }
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
      ` — appeal with: 203c versions appeal ${published.code} --message "…"`, {version: published, uploaded});
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
  catch (error) { throw new ApiError(0, "upload_failed", `The source upload failed (${error.cause?.code || error.message})`); }
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

/** Why no browser can be opened here (then 203c uses the device code), or null. BROWSER names one. */
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

const callbackPage = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>203c</title>
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
    const checked = await client.request("GET", "/auth/authorize", {auth: false, query: {response_type: "code", client_id: "203c", redirect_uri: redirect,
      code_challenge: challenge, code_challenge_method: "S256", state, scope: admin ? "read write admin" : "read write",
      name: (name || "203c on " + os.hostname()).slice(0, 40)}});
    say(checked.authorize_url);
    const opened = await open(checked.authorize_url);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ApiError(0, "expired", "Nobody approved the sign-in in the browser in time")), timeout * 1000);
      if (!opened) say(checked.authorize_url, {opened: false});
      let handled = false;
      server.on("request", async (req, res) => {
        // The page goes out whole before 203c moves on (and closes the listener).
        const reply = (status, title, text) => new Promise(done => {
          res.writeHead(status, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", connection: "close"});
          res.end(callbackPage(title, text), done);
        });
        const url = new URL(req.url, redirect);
        if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        // Anything without this sign-in's state is not its answer: refused, and 203c goes on waiting.
        if (url.searchParams.get("state") !== state) { await reply(400, "Not this sign-in", "This page does not belong to the sign-in 203c is waiting for."); return; }
        // Only the first answer counts: a reload must never present the code again (that revokes it).
        if (handled) { await reply(200, "Done", "203c already has its answer. You can close this tab."); return; }
        handled = true;
        clearTimeout(timer);
        if (url.searchParams.get("error")) {
          await reply(200, "Sign-in refused", "203c was not signed in. You can close this tab.");
          reject(new ApiError(403, "access_denied", "The sign-in was refused in the browser"));
          return;
        }
        try {
          const got = await client.request("POST", "/auth/token", {auth: false, body: {grant_type: "authorization_code", code: url.searchParams.get("code") ?? "",
            code_verifier: verifier, redirect_uri: redirect, client_id: "203c"}});
          await reply(200, "203c is signed in", `Signed in as ${escapeHtml(got.user?.name ?? "")}. You can close this tab and go back to the terminal.`);
          resolve(got);
        } catch (error) {
          await reply(400, "Sign-in failed", escapeHtml(error.message) + ". Run 203c login again.");
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
  return await client.request("POST", "/auth/device/start", {body: {client: "cli", name: (name || "203c on " + os.hostname()).slice(0, 40)}, auth: false});
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
