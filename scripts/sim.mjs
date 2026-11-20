// Simulator versions (the user, 2026-11-14): a firmware's simulator is its *simulator version*, the same
// source compiled for the browser with CardenzaHAL's web target, built by the author when they publish
// and uploaded with the BIN; the community plays a version only when its simulator version boots (the
// checker's simulator step). This module finds the firmware's ESP-IDF project and its CardenzaHAL, runs
// the HAL's own build (`python3 <HAL>/tools/cardenza_web.py build <project>`), reads and verifies what it
// wrote (sim.json and the files it lists), uploads the folder as the version's web build (only when it
// differs from the one there, by SHA-256) and follows the check. Used by publish and `sim build|upload|check`.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {ApiError, failed} from "./lib.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {size} from "./checks.mjs";

const enc = encodeURIComponent;
export const HAL_REPO = "https://github.com/203-Systems/CardenzaHAL";
export const SIM_LIMITS = {files: 20, total: 64 * 1024 * 1024};
const PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SKIP = new Set([".git", "node_modules", "managed_components", "build-web", ".cache", "dist"]);
const skipDir = name => SKIP.has(name) || /^build/.test(name) || name.startsWith(".");

// ---------------------------------------------------------------------------------------------
// The firmware's project and its CardenzaHAL

const isIdfProject = dir => {
  try { return /project\.cmake/.test(fs.readFileSync(path.join(dir, "CMakeLists.txt"), "utf8")); } catch { return false; }
};
const isHal = dir => fs.existsSync(path.join(dir, "cardenzaHAL.h"));
// A HAL that can build simulator versions: its web target and the script.
const halWeb = dir => fs.existsSync(path.join(dir, "web")) && fs.existsSync(path.join(dir, "tools", "cardenza_web.py"));

function walk(dir, depth, visit) {
  let entries = [];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || skipDir(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (visit(full) === false) continue;
    if (depth > 1) walk(full, depth - 1, visit);
  }
}

/** The CardenzaHAL copy a project builds with (the component dir with cardenzaHAL.h), or null. */
export function findHal(project) {
  if (!project) return null;
  const found = [];
  // EXTRA_COMPONENT_DIRS written as paths: the project's own folder's variables, and simple variables
  // of its CMakeLists.txt (set(NAME "…"), get_filename_component(NAME "…" ABSOLUTE), as the HAL's
  // examples write `set(EXTRA_COMPONENT_DIRS "${hal_dir}")`), resolved; anything else is left alone.
  try {
    const cmake = fs.readFileSync(path.join(project, "CMakeLists.txt"), "utf8").replace(/#.*$/gm, "");
    const vars = {CMAKE_CURRENT_LIST_DIR: project, CMAKE_CURRENT_SOURCE_DIR: project, CMAKE_SOURCE_DIR: project, PROJECT_DIR: project};
    const expand = text => text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (all, name) => vars[name] ?? all).replace(/\$ENV\{([A-Za-z0-9_]+)\}/g, (all, name) => process.env[name] ?? all);
    for (const match of cmake.matchAll(/\b(set|get_filename_component)\s*\(\s*([A-Za-z0-9_]+)\s+("[^"]*"|[^\s)"]+)([^)]*)\)/g)) {
      const [, how, name, rawValue, rest] = match;
      if (name === "EXTRA_COMPONENT_DIRS" || (how === "get_filename_component" && !/\b(ABSOLUTE|REALPATH)\b/.test(rest))) continue;
      if (how === "set" && rest.trim()) continue;   // a list or a cache entry: not a path
      const value = expand(rawValue.replace(/^"|"$/g, ""));
      if (!/\$/.test(value)) vars[name] = how === "get_filename_component" ? path.resolve(project, value) : value;
    }
    for (const match of cmake.matchAll(/EXTRA_COMPONENT_DIRS\s+([^)]*)\)/g)) {
      for (const raw of match[1].match(/"[^"]*"|[^\s"]+/g) ?? []) {
        const text = expand(raw.replace(/^"|"$/g, ""));
        if (/\$/.test(text) || text === "EXTRA_COMPONENT_DIRS" || text === "APPEND") continue;
        const dir = path.resolve(project, text);
        if (isHal(dir)) found.push(dir);
        else walk(dir, 1, sub => { if (isHal(sub)) found.push(sub); });
      }
    }
  } catch { /* no CMakeLists */ }
  if (!found.length) walk(project, 3, dir => { if (isHal(dir)) { found.push(dir); return false; } });
  const dir = found[0];
  return dir ? {dir, web: halWeb(dir)} : null;
}

/**
 * The firmware's ESP-IDF project: from the BIN's folder up (build/<project>.bin), then from here up, then
 * the projects below here (depth 3) that build with CardenzaHAL (not the HAL's own examples). Answers
 * {dir} or {ambiguous: [dirs]} or null.
 */
export function findProject({bins = [], from = []} = {}) {
  const up = start => {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      if (isIdfProject(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };
  // Up from the BIN and from here: the project being worked on (one of the HAL's own examples too).
  for (const start of [...bins.map(b => path.dirname(b)), ...from]) {
    const dir = up(start);
    if (dir) return {dir};
  }
  const below = [];
  for (const start of from) {
    walk(path.resolve(start), 3, dir => {
      if (isHal(dir)) return false;
      if (isIdfProject(dir) && findHal(dir)) below.push(dir);
    });
    if (below.length) break;
  }
  const unique = [...new Set(below)];
  return unique.length === 1 ? {dir: unique[0]} : unique.length ? {ambiguous: unique} : null;
}

// ---------------------------------------------------------------------------------------------
// The build script: the project's HAL copy when it has the web target, else --hal, else a clone of
// CardenzaHAL kept in the cache (~/.cache/203c/CardenzaHAL).

export function halCache() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "203c", "CardenzaHAL");
}
const halRepo = () => process.env.COMMUNITY_HAL_REPO || HAL_REPO;

function git(args, cwd) {
  const run = spawnSync("git", args, {cwd, encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  if (run.error) return {status: -1, missing: run.error.code === "ENOENT", stderr: String(run.error.message)};
  return {status: run.status, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim()};
}

/**
 * Which cardenza_web.py builds: {script, hal, source: "flag" | "project" | "cache", plan} or {missing, why, hint}.
 * dryRun: nothing is cloned (the plan says it would be).
 */
export function halScript(ctx, {project, flagHal, dryRun = false}) {
  if (flagHal) {
    const dir = path.resolve(ctx.cwd, String(flagHal).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(path.join(dir, "tools", "cardenza_web.py"))) {
      return {missing: "flag", why: `--hal ${flagHal} has no tools/cardenza_web.py (looked at ${dir})`,
        hint: `Give a CardenzaHAL checkout with the web target (${halRepo()}), or leave --hal out`};
    }
    return {script: path.join(dir, "tools", "cardenza_web.py"), hal: dir, source: "flag", plan: `CardenzaHAL at ${dir} (--hal)`};
  }
  const own = project ? findHal(project) : null;
  if (own?.web) return {script: path.join(own.dir, "tools", "cardenza_web.py"), hal: own.dir, source: "project", plan: `the project's CardenzaHAL (${own.dir})`};
  const cache = halCache();
  const why = own ? `the project's CardenzaHAL (${own.dir}) has no web target yet` : "no CardenzaHAL copy with the web target here";
  if (dryRun) {
    return fs.existsSync(path.join(cache, "tools", "cardenza_web.py"))
      ? {script: path.join(cache, "tools", "cardenza_web.py"), hal: cache, source: "cache", plan: `CardenzaHAL's web target from ${cache} (${why}; updated first)`}
      : {script: null, hal: cache, source: "cache", plan: `CardenzaHAL's web target: git clone ${halRepo()} into ${cache} (${why})`};
  }
  if (fs.existsSync(path.join(cache, ".git"))) {
    ctx.say(`Updating CardenzaHAL in ${cache} (${why})…`);
    const fetched = git(["-C", cache, "fetch", "--depth", "1", "origin", "HEAD"]);
    if (fetched.status === 0) git(["-C", cache, "reset", "--hard", "FETCH_HEAD"]);
    else ctx.note(`could not update ${cache} (${(fetched.stderr || "").split("\n").pop()}): building with the copy there`);
  } else {
    ctx.say(`Fetching CardenzaHAL's web target: git clone ${halRepo()} ${cache} (${why})…`);
    fs.mkdirSync(path.dirname(cache), {recursive: true});
    const cloned = git(["clone", "--depth", "1", halRepo(), cache]);
    if (cloned.status !== 0) {
      return {missing: cloned.missing ? "git" : "clone", why: cloned.missing ? "git is not installed (needed to fetch CardenzaHAL's web target)"
        : `git clone ${halRepo()} failed: ${(cloned.stderr || "").split("\n").pop()}`,
        hint: cloned.missing ? "Install git, or give --hal <a CardenzaHAL checkout>" : "Check the network, or give --hal <a CardenzaHAL checkout>"};
    }
  }
  if (!fs.existsSync(path.join(cache, "tools", "cardenza_web.py"))) {
    return {missing: "no_web_target", why: `This CardenzaHAL (${cache}) has no web target yet (no tools/cardenza_web.py)`,
      hint: "CardenzaHAL's web target is not released yet: publish the BIN now and the simulator version later (sim build, sim upload), or give --hal <a checkout with it>"};
  }
  return {script: path.join(cache, "tools", "cardenza_web.py"), hal: cache, source: "cache", plan: `CardenzaHAL's web target from ${cache}`};
}

// ---------------------------------------------------------------------------------------------
// The toolchain (for doctor and the plan: the build itself says what is missing, exit 4)

const python = () => process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
function version(cmd, args = ["--version"]) {
  try {
    const run = spawnSync(cmd, args, {encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"]});
    if (run.error || run.status !== 0) return null;
    return ((run.stdout || "") + (run.stderr || "")).trim().split("\n")[0].slice(0, 120);
  } catch { return null; }
}
export function toolchain() {
  const home = os.homedir();
  const emsdk = [process.env.EMSDK, path.join(home, "emsdk")].filter(Boolean).find(dir => fs.existsSync(path.join(dir, "upstream", "emscripten")));
  const emcc = version("emcc");
  const cmakeDirs = (() => { try { return fs.readdirSync(path.join(home, ".espressif", "tools", "cmake")); } catch { return []; } })();
  const cmake = version("cmake");
  return {
    python: {ok: !!version(python()), detail: version(python()) ?? `${python()} not found`},
    emscripten: {ok: !!(emcc || emsdk), detail: emcc ? emcc : emsdk ? `emsdk at ${emsdk} (not on PATH: the build activates it if it can)` : "not found (emcc, $EMSDK, ~/emsdk)"},
    cmake: {ok: !!(cmake || cmakeDirs.length), detail: cmake ?? (cmakeDirs.length ? `ESP-IDF's cmake in ~/.espressif/tools/cmake (not on PATH)` : "not found")},
  };
}
export const EMSDK_HINT = "Install Emscripten: git clone https://github.com/emscripten-core/emsdk ~/emsdk && cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh (and CMake 3.16+)";

// ---------------------------------------------------------------------------------------------
// Running the build

/**
 * python3 <script> build <project> --out <out> [--hal] [--debug] [--jobs]. Its lines go to stderr as
 * they come (not with --json); answers {code, stderr tail, kind, unsupported, headers, hint}.
 * Exit codes (cardenza_web.py): 0 built; 1 the firmware's own compile / link errors; 2 usage or not an
 * ESP-IDF project; 3 does not follow the HAL (unsupported: / unsupported-header: / unsupported-source: lines); 4 toolchain missing.
 */
export function runBuild(ctx, {script, project, out, hal, debug, jobs}) {
  const args = [script, "build", project, "--out", out, ...(hal ? ["--hal", hal] : []), ...(debug ? ["--debug"] : []), ...(jobs ? ["--jobs", String(jobs)] : [])];
  // Paths below here relative, others as they are (a HAL elsewhere reads better absolute than as ../../..).
  const shown = a => {
    const rel = path.isAbsolute(a) ? path.relative(ctx.cwd, a) || "." : a;
    const text = path.isAbsolute(a) && rel.startsWith("..") ? a : rel;
    return /\s/.test(text) ? `'${text}'` : text;
  };
  ctx.say(`Building the simulator version: ${python()} ${args.map(shown).join(" ")}`);
  return new Promise(resolve => {
    let child;
    try { child = spawn(python(), args, {cwd: project, stdio: ["ignore", "pipe", "pipe"], env: process.env}); }
    catch (error) { resolve(classify(-1, String(error.message))); return; }
    let text = "";
    const keep = chunk => {
      text += chunk;
      if (text.length > 256 * 1024) text = text.slice(-128 * 1024);
      ctx.progress?.(String(chunk));
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), 45 * 60 * 1000);
    child.on("error", error => { clearTimeout(timer); resolve(classify(error.code === "ENOENT" ? -2 : -1, String(error.message))); });
    child.on("close", code => { clearTimeout(timer); resolve(classify(code ?? -1, text)); });
  });
}

function classify(code, text) {
  const lines = String(text).split("\n").map(l => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd()).filter(Boolean);
  const tail = lines.slice(-30).join("\n");
  const unsupported = [...new Set(lines.map(l => /^\s*unsupported:\s*(.+)$/.exec(l)?.[1]?.trim()).filter(Boolean))];
  const headers = [...new Set(lines.map(l => /^\s*unsupported-header:\s*(.+)$/.exec(l)?.[1]?.trim()).filter(Boolean))];
  const sources = [...new Set(lines.map(l => /^\s*unsupported-source:\s*(.+)$/.exec(l)?.[1]?.trim()).filter(Boolean))];
  // A Python error in the script itself also exits 1: that is not the firmware's code.
  const traceback = lines.some(l => /^Traceback \(most recent call last\)/.test(l));
  const kind = code === 0 ? "built" : code === 1 && !traceback ? "compile" : code === 2 ? "usage" : code === 3 ? "not_hal" : code === 4 ? "toolchain"
    : code === -2 ? "no_python" : "crash";
  const hint = kind === "toolchain" ? (lines.filter(l => /install|emsdk|emscripten|cmake/i.test(l)).slice(-3).join(" ") || EMSDK_HINT) : null;
  return {code, kind, tail, unsupported, headers, sources, hint, lines: lines.length};
}

/** What a failed build means, for publish (a warning or a decision) and sim build (an error). */
export function explainBuild(result, {project}) {
  switch (result.kind) {
    case "not_hal": {
      const what = [...result.unsupported, ...result.headers.map(h => h + " (header)"), ...result.sources.map(f => f + " (source)")];
      return {code: "sim_not_hal", message: `The firmware does not follow CardenzaHAL, so it cannot run in the simulator${what.length ? `: it uses ${what.slice(0, 12).join(", ")}${what.length > 12 ? ` and ${what.length - 12} more` : ""}` : ""}`,
        hint: "Use the HAL's API for these (keyboard, display, audio, storage, USB: the public headers of CardenzaHAL) instead of the chip's drivers; until then the version has no simulator version (no Play).",
        unsupported: result.unsupported, headers: result.headers, sources: result.sources};
    }
    case "toolchain": return {code: "sim_toolchain", message: "Emscripten or CMake is missing: the simulator version cannot be built here", hint: result.hint || EMSDK_HINT};
    case "no_python": return {code: "sim_toolchain", message: `Python 3 is needed to build the simulator version (${python()} was not found)`, hint: "Install Python 3 (or set PYTHON to it)"};
    case "compile": return {code: "sim_build_failed", message: "The firmware does not compile for the browser (CardenzaHAL's web target)", hint: "Fix the errors below (they are in the firmware's own code), then run the same command again",
      build_log: result.tail};
    case "usage": return {code: "sim_not_project", message: `cardenza_web.py could not build ${project}: ${result.tail.split("\n").pop()}`, hint: "Give the firmware's ESP-IDF project with --project DIR", build_log: result.tail};
    default: return {code: "sim_build_failed", message: `cardenza_web.py itself failed (exit ${result.code}${/Traceback/.test(result.tail) ? ", a Python error" : ""})`,
      hint: "Not the firmware's code: update CardenzaHAL (or give --hal a newer checkout) and run the same command again; if it stays, tell CardenzaHAL's maintainers with the lines below",
      build_log: result.tail};
  }
}

// ---------------------------------------------------------------------------------------------
// The folder: sim.json and the files it lists (or, without sim.json, a hand-made build: every file)

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Reads a simulator version's folder: {files: [{path, size, sha256, full}], manifest | null, total, problems, warnings}.
 * targets: the devices of the version (sim.json's target must be one of them).
 */
export function readSimDir(dir, {targets = []} = {}) {
  const out = {dir, files: [], manifest: null, total: 0, problems: [], warnings: []};
  const problem = (code, message, hint) => out.problems.push({code, message, hint});
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { problem("file_not_found", `The folder ${dir} does not exist`, "Build it first: sim build"); return out; }
  const simJson = path.join(dir, "sim.json");
  const add = rel => {
    const full = path.join(dir, ...rel.split("/"));
    let bytes;
    try { bytes = fs.readFileSync(full); } catch { problem("file_not_found", `${rel} is missing from ${dir}`, "Build it again (sim build)"); return null; }
    const file = {path: rel, size: bytes.length, sha256: sha(bytes), full};
    out.files.push(file);
    out.total += bytes.length;
    return file;
  };
  if (fs.existsSync(simJson)) {
    let m;
    try { m = JSON.parse(fs.readFileSync(simJson, "utf8")); } catch (error) { problem("invalid", `sim.json is not valid JSON (${error.message})`, "Build it again (sim build)"); return out; }
    out.manifest = m;
    if (m.format !== 1) out.warnings.push({code: "sim_format", message: `sim.json says format ${m.format}: 203c knows format 1`, hint: "Update the skill if the upload is refused"});
    if (m.entry && m.entry !== "index.html") problem("invalid", `sim.json's entry is ${m.entry}: the community opens index.html`, "Build it with CardenzaHAL's cardenza_web.py");
    if (targets.length && m.target && !targets.includes(m.target)) {
      problem("sim_wrong_target", `This simulator version is a ${m.target}'s, but the version is for ${targets.join(", ")}`, "Build the simulator version of the same device (or publish the BIN for that device)");
    }
    const listed = Array.isArray(m.files) ? m.files : [];
    if (!listed.length) problem("invalid", "sim.json lists no files", "Build it again (sim build)");
    for (const f of listed) {
      if (!f || typeof f.path !== "string" || !PATH_RE.test(f.path) || f.path.split("/").includes("..")) { problem("invalid", `sim.json lists a bad path: ${JSON.stringify(f?.path)}`); continue; }
      if (f.path === "sim.json") continue;
      const file = add(f.path);
      if (!file) continue;
      if (typeof f.size === "number" && f.size !== file.size) problem("sim_changed", `${f.path} is ${file.size} bytes, sim.json says ${f.size}: the folder changed after the build`, "Build it again (sim build)");
      if (typeof f.sha256 === "string" && f.sha256.toLowerCase() !== file.sha256) problem("sim_changed", `${f.path} is not the file sim.json describes (SHA-256 differs)`, "Build it again (sim build)");
    }
    add("sim.json");
  } else {
    out.warnings.push({code: "sim_no_manifest", message: `${dir} has no sim.json: a hand-made build (the page cannot show its HAL version or key map)`,
      hint: "Build it with CardenzaHAL's cardenza_web.py (sim build), which writes sim.json"});
    const walkFiles = (folder, prefix) => {
      for (const entry of fs.readdirSync(folder, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) walkFiles(path.join(folder, entry.name), rel);
        else if (entry.isFile()) {
          if (!PATH_RE.test(rel)) { problem("invalid", `${rel}: file names are letters, digits and . _ - /`, "Rename it"); continue; }
          add(rel);
        }
      }
    };
    walkFiles(dir, "");
  }
  if (!out.files.some(f => f.path === "index.html")) problem("invalid", `${dir} has no index.html`, "Give the folder the build wrote (it holds index.html)");
  if (out.files.length > SIM_LIMITS.files) problem("invalid", `${out.files.length} files: a web build is at most ${SIM_LIMITS.files}`, "Leave out maps and sources");
  if (out.total > SIM_LIMITS.total) problem("too_large", `${size(out.total)}: a web build is at most 64 MB`, "Build it in release mode (no --debug)");
  return out;
}

/** The web build on the server is this one (every path with the same SHA-256). */
export function sameBuild(local, server) {
  if (!server || !Array.isArray(server.files) || !local?.files?.length) return false;
  const theirs = new Map(server.files.map(f => [f.path, f.sha256]));
  return theirs.size === local.files.length && local.files.every(f => theirs.get(f.path) === f.sha256);
}

const halOfSim = hal => hal?.version ? `, CardenzaHAL ${hal.version}` : typeof hal?.commit === "string" && /^[0-9a-f]{7,}$/.test(hal.commit) ? `, CardenzaHAL ${hal.commit.slice(0, 7)}` : "";
export const describeSim = (local) => `${local.files.length} files, ${size(local.total)}${halOfSim(local.manifest?.hal)}` +
  `${local.manifest?.toolchain?.emscripten ? `, Emscripten ${local.manifest.toolchain.emscripten}` : ""}`;

// ---------------------------------------------------------------------------------------------
// Uploading and following the check

/** Uploads the folder's files as the version's web build: one ticket each (POST …/simulator). */
export async function uploadSim(ctx, {code, vcode, local}) {
  ctx.say(`Uploading the simulator version (${describeSim(local)})…`);
  const made = await ctx.client.post(`/firmware/${enc(code)}/versions/${enc(vcode)}/simulator`, {files: local.files.map(f => ({path: f.path, size: f.size}))});
  const uploaded = [];
  for (const upload of made.uploads) {
    const file = local.files.find(f => f.path === upload.path);
    const form = new FormData();
    form.set("file", new Blob([fs.readFileSync(file.full)]), path.basename(file.path));
    let response;
    try { response = await ctx.client.fetch(upload.upload_url, {method: "POST", headers: {...ctx.client.langHeaders(), Authorization: "Bearer " + upload.ticket}, body: form}); }
    catch (error) { throw failed(error, reason => new ApiError(0, "upload_failed", `${upload.path}: the upload failed (${reason})`)); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status >= 500 || response.status === 409) throw new ApiError(response.status, "upload_failed", `${upload.path}: ${data.error || "the upload failed"}`, data);
      throw new ApiError(response.status, data.code || "upload_failed", `${upload.path}: ${data.error || "upload refused"}`, data);
    }
    if (data.sha256 && data.sha256 !== file.sha256) throw new ApiError(0, "upload_failed", `${upload.path}: the server got other bytes (SHA-256 differs); run it again`);
    uploaded.push(data);
  }
  return uploaded;
}

/**
 * Waits while the version's web build is unchecked (the checker checks it: with the version's checks,
 * or a job of its own once the version is published). Answers the version.
 */
export async function waitSim(ctx, vcode, {timeout = 300, poll = 5} = {}) {
  const until = Date.now() + timeout * 1000;
  let version = (await ctx.client.get("/versions/" + enc(vcode))).version;
  let said = false;
  while (version.simulator?.status === "unchecked" && ["published", "checking"].includes(version.status) && Date.now() < until) {
    if (!said) { ctx.say("  simulator version: waiting for the checker (it opens it in a headless browser, up to 15 s)…"); said = true; }
    await new Promise(resolve => setTimeout(resolve, poll * 1000));
    version = (await ctx.client.get("/versions/" + enc(vcode))).version;
  }
  return version;
}

export function siteOf(api) {
  const base = String(api).replace(/\/+$/, "");
  return base.endsWith("/api") ? base.slice(0, -4) : new URL(base).origin;
}
export const playUrl = (ctx, vcode) => `${siteOf(ctx.api)}/play/${vcode}`;

/** The simulator version of a version as 203c answers it. */
export function simState(ctx, version, extra = {}) {
  const s = version?.simulator;
  if (!s) return {status: "none", ...extra};
  return {status: s.status, url: s.url, play_url: s.status === "boots" ? playUrl(ctx, version.code) : null, checked: s.checked ?? null,
    report: s.report ?? null, hal: s.hal ?? null, toolchain: s.toolchain ?? null, target: s.target ?? null, keys: s.keys?.length ?? 0, ...extra};
}

/** One line for people. */
export function simLine(ctx, state, vcode) {
  if (state.status === "boots") return `Simulator version: boots. Play: ${playUrl(ctx, vcode)}`;
  if (state.status === "fails") return `Simulator version: does not boot${state.report?.detail ? ` (${state.report.detail})` : ""}: no Play. Fix it and upload it again, or check it again: sim check ${vcode} --again`;
  if (state.status === "unchecked") return `Simulator version: not checked yet (the checker opens it soon): sim check ${vcode}`;
  return `Simulator version: none${state.reason && !/^sim_/.test(state.reason) ? ` (${state.reason})` : ""}: no Play`;
}

export function simError(code, message, extra = {}) {
  return new CliError(code, message, {exit: EXIT.refused, ...extra});
}
