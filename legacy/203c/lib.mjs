// The last 203c: what it says (the same words as 203cli's scripts/rename.mjs: its tests compare them) and where it finds 203cli.
import fs from "node:fs";
import {createRequire} from "node:module";
import os from "node:os";
import path from "node:path";

export const RENAME_ZH = "203c 已改名为 203cli，203c 不再更新也不再支持。请运行：npm install -g 203cli && 203cli skill install（然后可以 npm uninstall -g 203c）";
export const RENAME_EN = "203c is renamed 203cli; 203c gets no more updates or support. Run: npm install -g 203cli && 203cli skill install (then you can npm uninstall -g 203c)";
export const RENAME_CI = "This workflow still runs 203c, which is renamed 203cli. It keeps working through 203cli for now; update it: " +
  "CardenzaHAL's community-publish action at a newer commit of the HAL's main (it runs 203cli), or your own steps to 203cli (npm install -g 203cli).";
export const MISSING_ZH = "没有找到 203cli（它本该随 203c 一起装上）。请运行：npm install -g 203cli && 203cli skill install";
export const MISSING_EN = "203cli was not found (it comes with this 203c). Run: npm install -g 203cli && 203cli skill install";

const escapeData = text => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const MARK = "<!-- 203c-renamed -->";

/**
 * The notice, on stderr only (a --json answer on stdout stays JSON): both languages. In GitHub Actions also a ::warning::
 * annotation and, once a step, a line in the job's summary (GITHUB_STEP_SUMMARY: seen even when the step keeps stderr in a file).
 */
export function sayRenamed({env = process.env, write = text => process.stderr.write(text)} = {}) {
  write(`${RENAME_ZH}\n${RENAME_EN}\n`);
  if (env.GITHUB_ACTIONS !== "true") return;
  write(`::warning title=203c is renamed 203cli::${escapeData(RENAME_CI)}\n`);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try {
    let text = "";
    try { text = fs.readFileSync(summary, "utf8"); } catch { text = ""; }
    if (text.includes(MARK)) return;
    fs.appendFileSync(summary, `${MARK}\n> [!WARNING]\n> **203c is renamed 203cli.** ${RENAME_CI}\n>\n> ${RENAME_ZH}\n\n`);
  } catch { /* the summary is a courtesy */ }
}

/**
 * The 203cli to run: {file (its scripts/203cli.mjs), via}, or null. First the dependency npm installed with this package
 * (below it, or beside it: Node's resolution from here, global and local installs alike on every system), then a 203cli on
 * PATH (npm's link on macOS and Linux; on Windows npm's shims sit beside the global node_modules), then the Agent Skill's copy.
 */
export function findCli({env = process.env, from = import.meta.url, home = os.homedir()} = {}) {
  const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const binOf = pkgFile => {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (pkg.name !== "203cli") return null;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["203cli"];
      const file = bin ? path.resolve(path.dirname(pkgFile), bin) : null;
      return file && exists(file) ? file : null;
    } catch { return null; }
  };
  try {
    const file = binOf(createRequire(from).resolve("203cli/package.json"));
    if (file) return {file, via: "dependency"};
  } catch { /* not installed with it */ }
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    // Windows: <prefix>\203cli.cmd beside <prefix>\node_modules\203cli.
    const beside = binOf(path.join(dir, "node_modules", "203cli", "package.json"));
    if (beside && (exists(path.join(dir, "203cli.cmd")) || exists(path.join(dir, "203cli")))) return {file: beside, via: "path"};
    const link = path.join(dir, "203cli");
    if (!exists(link)) continue;
    let real = null;
    try { real = fs.realpathSync(link); } catch { real = null; }
    if (real && /\.mjs$/.test(real)) return {file: real, via: "path"};
    // install.sh's two-line script: exec node "<skills>/203-community/scripts/203cli.mjs" "$@".
    try {
      const text = fs.statSync(link).size < 4000 ? fs.readFileSync(link, "utf8") : "";
      const named = (/"([^"]+[\\/]203cli\.mjs)"/.exec(text) ?? [])[1];
      if (named && exists(named)) return {file: named, via: "path"};
    } catch { /* not readable */ }
  }
  const skills = env.CLAUDE_SKILLS_DIR || path.join(home, ".claude", "skills");
  const skill = path.join(skills, "203-community", "scripts", "203cli.mjs");
  return exists(skill) ? {file: skill, via: "skill"} : null;
}
