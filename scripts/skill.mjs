// 203cli skill install: the Agent Skill (SKILL.md, scripts/, reference/, products/, LICENSE: this package's files) into the
// skills folder of the coding agents on this computer, from wherever 203cli was installed (npm install -g 203cli, the
// user 2026-11-18: "直接NPM就好了"; a clone). No postinstall script does it (many people turn them off): the README's second
// line runs it, and doctor says when it is missing or older than this 203cli. Folders: CLAUDE_SKILLS_DIR, else Claude Code's
// ~/.claude/skills (always); ~/.codex/skills when Codex is there; --dir for any other. Each gets 203-community/, replaced
// whole (a new copy next to it, then renamed over), the same layout install.sh makes.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {CLI_VERSION} from "./lib.mjs";
import {CliError, EXIT} from "./guide.mjs";

export const SKILL_NAME = "203-community";
export const SKILL_ITEMS = ["SKILL.md", "LICENSE", "scripts", "reference", "products"];
/** This 203cli's own files: the folder with SKILL.md above scripts/. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The skills folders to install into: [{agent, dir}]. */
export function skillFolders({dir = null, env = process.env, home = os.homedir()} = {}) {
  if (dir) return [{agent: "given", dir: path.resolve(String(dir))}];
  const out = [{agent: "claude", dir: env.CLAUDE_SKILLS_DIR || path.join(home, ".claude", "skills")}];
  if (fs.existsSync(path.join(home, ".codex"))) out.push({agent: "codex", dir: path.join(home, ".codex", "skills")});
  return out;
}

/** The version of the skill installed in `dir` (its scripts/lib.mjs CLI_VERSION), or null. */
export function installedVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, SKILL_NAME, "scripts", "lib.mjs"), "utf8");
    return (/export const CLI_VERSION = "([^"]+)"/.exec(text) || [])[1] ?? null;
  } catch { return null; }
}

/** What doctor says about the skill: {ok, detail} (the first folder, Claude Code's, decides). */
export function skillState(options = {}) {
  const [first] = skillFolders(options);
  const there = path.join(first.dir, SKILL_NAME);
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  if (real(there) === real(PACKAGE_ROOT)) return {ok: true, detail: `${there} (this 203cli runs from it)`};
  const version = installedVersion(first.dir);
  if (!version) return {ok: false, detail: `not installed in ${first.dir} (203cli skill install)`};
  return version === CLI_VERSION ? {ok: true, detail: `${there} ${version}`}
    : {ok: false, detail: `${there} is ${version}, this 203cli is ${CLI_VERSION} (203cli skill install)`};
}

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, {recursive: true});
    for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
  } else fs.copyFileSync(from, to);
}

export async function skillInstall(ctx) {
  const o = ctx.flags;
  const folders = skillFolders({dir: o.dir});
  const missing = SKILL_ITEMS.filter(item => !fs.existsSync(path.join(PACKAGE_ROOT, item)));
  if (missing.length) {
    throw new CliError("skill_incomplete", `This 203cli (${PACKAGE_ROOT}) lacks ${missing.join(", ")}: it cannot install the skill`, {exit: EXIT.refused,
      hint: "Install 203cli again: npm install -g 203cli"});
  }
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const plan = folders.map(f => ({...f, path: path.join(f.dir, SKILL_NAME), before: installedVersion(f.dir), self: real(path.join(f.dir, SKILL_NAME)) === real(PACKAGE_ROOT)}));
  if (o.dry_run) {
    return {json: {dry_run: true, version: CLI_VERSION, from: PACKAGE_ROOT, into: plan.map(({agent, path: p, before, self}) => ({agent, path: p, before, self}))},
      text: plan.map(p => p.self ? `${p.path}: this 203cli runs from it (nothing to do)` : `Would install the skill ${CLI_VERSION} into ${p.path}${p.before ? ` (replacing ${p.before})` : ""}`).join("\n")};
  }
  const done = [];
  for (const p of plan) {
    if (p.self) { done.push({agent: p.agent, path: p.path, version: CLI_VERSION, status: "self"}); continue; }
    try {
      fs.mkdirSync(p.dir, {recursive: true});
      const fresh = path.join(p.dir, `.${SKILL_NAME}.new`);
      fs.rmSync(fresh, {recursive: true, force: true});
      fs.mkdirSync(fresh);
      for (const item of SKILL_ITEMS) copy(path.join(PACKAGE_ROOT, item), path.join(fresh, item));
      for (const script of ["203cli.mjs", "203c.mjs"]) try { fs.chmodSync(path.join(fresh, "scripts", script), 0o755); } catch { /* Windows */ }
      fs.rmSync(p.path, {recursive: true, force: true});
      fs.renameSync(fresh, p.path);
      done.push({agent: p.agent, path: p.path, version: CLI_VERSION, status: p.before ? "updated" : "installed", ...(p.before ? {before: p.before} : {})});
    } catch (error) {
      throw new CliError("skill_failed", `Could not write ${p.path}: ${error.code || error.message}`, {exit: EXIT.refused,
        hint: "Check that the folder is yours and writable, or give another with --dir"});
    }
  }
  return {json: {status: "installed", version: CLI_VERSION, skill: done},
    text: done.map(d => d.status === "self" ? `${d.path}: this 203cli runs from it` : `${d.status === "updated" ? "Updated" : "Installed"} the 203-community skill ${d.version} in ${d.path}${d.before ? ` (was ${d.before})` : ""}`).join("\n") +
      "\nAgents (Claude Code, Codex) load it in their next session."};
}
