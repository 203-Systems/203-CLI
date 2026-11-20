// The project file 203.json (COMMUNITY.md "The project file 203.json"): one file at a firmware project's
// root saying what it is called, its version, who makes it, what it was made from. Found, read, checked,
// written back (the code after the first publish, a fork's provenance), and made by init from what the
// project already says (CMake project(), version.txt or a git tag, the git remote, LICENSE).
// The earlier 203c.json is still read when there is no 203.json. Part of the Agent Skill.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

export const PROJECT_FILE = "203.json";
export const LEGACY_FILE = "203c.json";
export const KEYS = ["format", "name", "code", "version", "author", "summary", "tags", "devices", "source", "license", "forked_from",
  "publish_source", "publish", "description_file"];
export const PUBLISH_KEYS = ["channel", "bins", "bin", "notes_file", "cover", "description_file", "images", "notices", "sim", "project", "private", "launcher"];
const ORDER = ["$schema", "format", "name", "code", "version", "author", "summary", "tags", "devices", "source", "license", "forked_from",
  "publish_source", "publish"];

// A firmware's name as the community takes it (COMMUNITY.md "Firmware names"; the API refuses others with
// 400 invalid_name): 2-48 characters of Chinese, English letters, digits, single spaces and these symbols.
export const NAME_RULE = "2-48 characters: Chinese, English letters, digits, single spaces and - _ . + & ( ) [ ] ! # , : ' · （ ） ： ，";
const NAME_CHARS = /^[A-Za-z0-9 \u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005\u3007\u{20000}-\u{3134F}_.+&()!#,:'\u00B7\uFF08\uFF09\uFF1A\uFF0C[\]-]+$/u;
export function nameOk(name) {
  if (typeof name !== "string") return false;
  const length = [...name].length;
  return length >= 2 && length <= 48 && !/^ | $|  /.test(name) && NAME_CHARS.test(name);
}

function git(args, cwd) {
  const run = spawnSync("git", args, {cwd, encoding: "utf8", timeout: 20000, env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  return run.status === 0 ? (run.stdout ?? "").trim() : null;
}

// The project's root: where 203.json (or 203c.json) is, from here up to the repository's top.
export function findProjectFile(from) {
  const top = git(["rev-parse", "--show-toplevel"], from);
  let dir = path.resolve(from);
  for (let i = 0; i < 12; i++) {
    for (const name of [PROJECT_FILE, LEGACY_FILE]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return {file, legacy: name === LEGACY_FILE, dir};
    }
    if ((top && path.resolve(dir) === path.resolve(top)) || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return null;
}

// Problems with a 203.json's values: [{key, error, hint}] (unknown keys, wrong types, secrets).
export function checkProject(data) {
  const problems = [];
  const add = (key, error, hint) => problems.push({key, error, hint});
  if (!data || typeof data !== "object" || Array.isArray(data)) return [{key: null, error: "203.json is a JSON object", hint: "help manifest"}];
  for (const key of Object.keys(data)) {
    if (key.startsWith("$") || key.startsWith("x-") || key === "comment") continue;
    if (["password", "token", "secret"].some(word => key.toLowerCase().includes(word))) { add(key, `203.json holds a ${key}: never keep secrets in it`, "Remove it; give --password on the command line, COMMUNITY_TOKEN for the token"); continue; }
    if (!KEYS.includes(key)) add(key, `203.json: unknown key "${key}"`, "Keys: " + KEYS.join(", ") + " (x-… for your own)");
  }
  const text = (key, max, {required = false, pattern} = {}) => {
    const value = data[key];
    if (value === undefined || value === null) { if (required) add(key, `203.json needs "${key}"`); return; }
    if (typeof value !== "string" || !value.trim() || value.length > max || (pattern && !pattern.test(value))) add(key, `203.json: "${key}" is not valid (${JSON.stringify(value).slice(0, 60)})`);
  };
  if (data.format !== undefined && data.format !== 1) add("format", "203.json: format is 1", "Set \"format\": 1");
  text("name", 64);
  if (typeof data.name === "string" && data.name.trim() && !nameOk(data.name)) {
    add("name", `203.json: "name" is not a name the community takes (${JSON.stringify(data.name).slice(0, 60)})`, "A firmware's name is " + NAME_RULE);
  }
  text("code", 6, {pattern: /^[2-9A-HJ-NP-Za-hj-np-z]{6}$/});
  text("version", 32, {pattern: /^[0-9A-Za-z._+-]+$/});
  text("author", 24);
  text("summary", 100);
  text("source", 300, {pattern: /^https:\/\//});
  text("license", 64, {pattern: /^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$/});
  for (const key of ["tags", "devices"]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(v => typeof v !== "string"))) add(key, `203.json: "${key}" is a list of words`);
  }
  if (data.forked_from !== undefined && data.forked_from !== null) {
    const f = data.forked_from;
    if (typeof f !== "object" || Array.isArray(f) || typeof f.code !== "string" || !/^[2-9A-HJ-NP-Za-hj-np-z]{6}$/.test(f.code) ||
        (f.version !== undefined && f.version !== null && typeof f.version !== "string")) {
      add("forked_from", "203.json: \"forked_from\" is {\"code\": \"ABC234\", \"version\": \"1.2.0\"} or null");
    }
  }
  if (data.publish_source !== undefined && typeof data.publish_source !== "boolean") add("publish_source", "203.json: \"publish_source\" is true or false");
  if (data.publish !== undefined) {
    if (!data.publish || typeof data.publish !== "object" || Array.isArray(data.publish)) add("publish", "203.json: \"publish\" is an object");
    else for (const key of Object.keys(data.publish)) if (!PUBLISH_KEYS.includes(key)) add("publish", `203.json: unknown key publish.${key}`, "publish takes: " + PUBLISH_KEYS.join(", "));
    // The gallery (COMMUNITY.md "Pictures"): at most 9, each a path or {"file", "caption"}.
    const images = data.publish && typeof data.publish === "object" ? data.publish.images : undefined;
    if (images !== undefined) {
      const entry = x => typeof x === "string" ? !!x.trim() : !!x && typeof x === "object" && !Array.isArray(x) && typeof x.file === "string" && !!x.file.trim() &&
        Object.keys(x).every(k => ["file", "caption"].includes(k)) && (x.caption === undefined || (typeof x.caption === "string" && [...x.caption].length <= 60));
      if (!Array.isArray(images) || images.length > 9 || !images.every(entry)) {
        add("publish", "203.json: publish.images is the gallery: up to 9 pictures, each a path or {\"file\": \"docs/a.png\", \"caption\": \"≤ 60 characters\"}",
          "e.g. \"images\": [\"docs/home.png\", {\"file\": \"docs/seq.png\", \"caption\": \"The sequencer\"}]");
      }
    }
  }
  return problems;
}

// The clone link for a repository page: its .git on the hosts that serve one there.
export function cloneUrlOf(source) {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:") return null;
    const parts = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
    if (["github.com", "gitlab.com", "gitee.com", "codeberg.org", "bitbucket.org"].includes(url.hostname) && parts.length >= 2) {
      return `https://${url.hostname}/${parts.slice(0, url.hostname === "gitlab.com" ? parts.length : 2).join("/")}.git`;
    }
  } catch { /* not a URL */ }
  return null;
}

// What publish reads from it, in the keys of the earlier 203c.json (relative paths stay relative to its folder).
export function manifestOf(data, {legacy = false} = {}) {
  if (legacy) return {...data};
  const p = data.publish ?? {};
  const out = {};
  if (data.code) out.firmware = data.code;
  if (data.name) out.name = data.name;
  for (const key of ["summary", "tags", "license", "version"]) if (data[key] !== undefined && data[key] !== null) out[key] = data[key];
  if (data.source) { out.source_url = data.source; const clone = cloneUrlOf(data.source); if (clone) out.clone_url = clone; }
  for (const key of ["channel", "bins", "bin", "notes_file", "cover", "description_file", "images", "notices", "sim", "project", "private", "launcher"]) {
    if (p[key] !== undefined) out[key] = p[key];
  }
  if (data.description_file !== undefined && out.description_file === undefined) out.description_file = data.description_file;
  return out;
}

// Written back in its own key order (known keys first), two-space indented, a newline at the end.
export function writeProject(file, data) {
  const ordered = {};
  for (const key of ORDER) if (key in data) ordered[key] = data[key];
  for (const key of Object.keys(data)) if (!(key in ordered)) ordered[key] = data[key];
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + "\n");
}

// The version a project says: version.txt (major.minor.patch, as CardenzaSynth's CMake reads it),
// else 203.json's.
export function versionTxt(dir) {
  for (const name of ["version.txt", "VERSION"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
      if (/^[0-9A-Za-z._+-]{1,32}$/.test(value)) return {value, file: name};
    }
  }
  return null;
}

// The name in CMake's project(...) of the top-level CMakeLists.txt.
export function cmakeProjectName(dir) {
  for (const file of [path.join(dir, "CMakeLists.txt")]) {
    try {
      const text = fs.readFileSync(file, "utf8").replace(/#[^\n]*/g, "");
      const match = /\bproject\s*\(\s*([A-Za-z0-9_.+-]+)/i.exec(text);
      if (match) return match[1];
    } catch { /* none */ }
  }
  return null;
}

// LICENSE's SPDX identifier, read from its first lines (the common ones), or null.
export function licenseOf(dir) {
  const name = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENCE"].find(n => fs.existsSync(path.join(dir, n)));
  if (!name) return null;
  const text = fs.readFileSync(path.join(dir, name), "utf8").slice(0, 4000);
  const rules = [[/MIT License|Permission is hereby granted, free of charge/i, "MIT"], [/Apache License[\s\S]{0,40}Version 2\.0/i, "Apache-2.0"],
    [/GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i, "AGPL-3.0-only"], [/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i, "LGPL-3.0-only"],
    [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i, "GPL-3.0-only"], [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 2/i, "GPL-2.0-only"],
    [/Mozilla Public License,? (v\. |Version )2\.0/i, "MPL-2.0"], [/BSD 3-Clause|Redistributions in binary form[\s\S]*Neither the name/i, "BSD-3-Clause"],
    [/BSD 2-Clause|Redistributions in binary form must reproduce/i, "BSD-2-Clause"], [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
    [/CC0 1\.0/i, "CC0-1.0"], [/ISC License/i, "ISC"], [/zlib License|This software is provided 'as-is'/i, "Zlib"]];
  for (const [pattern, id] of rules) if (pattern.test(text)) return id;
  return null;
}

// The repository's page from its git remote (origin), when it is on the web over https or ssh.
export function remotePage(dir) {
  const remote = git(["config", "--get", "remote.origin.url"], dir);
  if (!remote) return null;
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(remote) ?? /^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https:\/\//.test(remote)) return remote.replace(/\.git$/, "").replace(/\/\/[^@/]+@/, "//");
  return null;
}

// The newest git tag that looks like a version (v1.2.0 → 1.2.0).
export function gitTagVersion(dir) {
  const tag = git(["describe", "--tags", "--abbrev=0"], dir);
  const match = tag && /^v?([0-9][0-9A-Za-z._+-]{0,30})$/.exec(tag);
  return match ? match[1] : null;
}
