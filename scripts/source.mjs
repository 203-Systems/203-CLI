// A version's source archive (COMMUNITY.md "Source code"): `git archive --format=tar.gz` of the commit's
// tracked files, read back and checked the way the server checks it (supabase/functions/community/
// source.ts: the same names and patterns) before anything is uploaded. Part of the Agent Skill.
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

export const MAX_ARCHIVE = 16 * 1024 * 1024;
export const MAX_UNPACKED = 64 * 1024 * 1024;
export const MAX_ENTRIES = 20000;
const SCAN_BYTES = 2 * 1024 * 1024;

// File names that hold secrets. `.env.example` / `.env.sample` / `.env.template` are allowed.
export function secretName(file) {
  const base = file.split("/").pop().toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(base) && !base.endsWith(".pub")) return true;
  if (base.includes("secret")) return true;
  if ([".npmrc", ".netrc", ".git-credentials", ".pypirc"].includes(base)) return true;
  if (/^credentials.*\.json$/.test(base)) return true;
  return false;
}

export const SECRET_PATTERNS = [
  ["a private key", /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
  ["a 203 credential", /\b(cct|ccd|cfu|upl|cms)_[a-f0-9]{64}\b/],
  ["a GitHub token", /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["an AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ["an API key (sk-…)", /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];
export function secretText(text) {
  for (const [what, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return what;
  return null;
}

const cString = bytes => bytes.toString("utf8").split("\0")[0];
const octal = bytes => { const v = cString(bytes).trim(); return /^[0-7]*$/.test(v) ? parseInt(v || "0", 8) : NaN; };

// Reads a .tar.gz: {problem, files: [paths causing it], entries, list: [{path, size}]}.
export function inspectArchive(archive) {
  const bad = (problem, files = []) => ({problem, files: files.slice(0, 20), entries: 0, list: []});
  if (archive.length < 20 || archive[0] !== 0x1f || archive[1] !== 0x8b) return bad("The source archive is not a .tar.gz");
  let tar;
  try { tar = zlib.gunzipSync(archive, {maxOutputLength: MAX_UNPACKED + 1024 * 1024}); } catch (error) {
    return bad(/maxOutputLength|buffer/i.test(error.message) ? "The source archive unpacks to more than 64 MB" : "The source archive is not a valid gzip file");
  }
  const secrets = [], unsafe = [], list = [], reasons = {};
  let at = 0, entries = 0, longName = null, paxPath = null, total = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    if (cString(header.subarray(257, 262)) !== "ustar") return bad("The source archive is not a tar file");
    const size = octal(header.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0) return bad("The source archive is damaged (a size)");
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.length < size) return bad("The source archive is cut short");
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = cString(body); continue; }
    if (type === "x" || type === "g") {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (type === "x" && match) paxPath = match[1];
      continue;
    }
    const prefix = cString(header.subarray(345, 500));
    const name = paxPath ?? longName ?? (prefix ? prefix + "/" : "") + cString(header.subarray(0, 100));
    paxPath = null; longName = null;
    entries++;
    if (entries > MAX_ENTRIES) return bad("The source archive has more than 20000 entries");
    if (name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name) || name.includes("\\")) { unsafe.push(name); continue; }
    if (!["0", "\0", "7"].includes(type)) continue;
    total += size;
    list.push({path: name, size});
    if (secretName(name)) { secrets.push(name); reasons[name] = "its name"; continue; }
    if (size && size <= SCAN_BYTES && !body.subarray(0, Math.min(8192, size)).includes(0)) {
      const what = secretText(body.toString("utf8"));
      if (what) { secrets.push(name); reasons[name] = what; }
    }
  }
  if (unsafe.length) return bad("The source archive has paths that leave its folder (absolute, .. or \\)", unsafe);
  if (secrets.length) return {...bad("The source archive has files that look secret (keys, tokens, .env): leave them out of git", secrets), reasons};
  if (!list.length) return bad("The source archive has no files");
  if (total > MAX_UNPACKED) return bad("The source archive unpacks to more than 64 MB");
  return {problem: null, files: [], entries: list.length, list, total};
}

function git(args, cwd, {binary = false} = {}) {
  const run = spawnSync("git", args, {cwd, encoding: binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120000,
    env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  if (run.error) return {status: -1, missing: run.error.code === "ENOENT", stdout: binary ? Buffer.alloc(0) : "", stderr: String(run.error.message)};
  return {status: run.status, stdout: binary ? run.stdout : (run.stdout ?? "").trim(), stderr: String(run.stderr ?? "").trim()};
}

// The archive of a project: the commit's tracked files (git archive), with a prefix of the project's
// name. Answers {bytes, sha256, commit, inspected, dirty, submodules, root} or {error, hint}.
export function makeArchive(dir, {name = null, ref = "HEAD"} = {}) {
  const top = git(["rev-parse", "--show-toplevel"], dir);
  if (top.missing) return {error: "git is not installed", hint: "Install git: the source archive is made from the repository's commit"};
  if (top.status !== 0) return {error: `${dir} is not in a git repository`, hint: "The source archive is the commit's tracked files: git init, commit, then publish (or leave publish_source out)"};
  const root = top.stdout;
  const commit = git(["rev-parse", "--verify", ref + "^{commit}"], root);
  if (commit.status !== 0) return {error: "The repository has no commit yet", hint: "Commit the source first"};
  const prefix = (name || path.basename(root)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
  const made = git(["archive", "--format=tar.gz", "--prefix=" + prefix + "/", commit.stdout], root, {binary: true});
  if (made.status !== 0) return {error: "git archive failed: " + made.stderr.split("\n").pop(), hint: "Check the repository"};
  const bytes = new Uint8Array(made.stdout);
  const status = git(["status", "--porcelain", "--untracked-files=no"], root);
  const submodules = git(["config", "--file", ".gitmodules", "--get-regexp", "path"], root).stdout.split("\n").filter(Boolean)
    .map(line => line.split(/\s+/)[1]).filter(Boolean);
  return {bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), commit: commit.stdout, root, prefix,
    dirty: status.status === 0 && status.stdout.length > 0, submodules, inspected: inspectArchive(bytes)};
}
