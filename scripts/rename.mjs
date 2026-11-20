// 203c is renamed 203cli (the user, 2026-11-20: "改名叫203cli吧,并且之前使用了203c的也能让他们知道203cli是现在的唯一一个选择"):
// the npm package and the command are 203cli, the only CLI of the 203 community. Every old way in still works and says so:
//   node …/203-community/scripts/203c.mjs   the old script path (scripts/203c.mjs: this notice, then 203cli in-process), as
//                                          CardenzaHAL's community-publish action at older commits and the 203c command an
//                                          older install.sh wrote run it
//   npm install -g 203c                    the last 203c package (legacy/203c: its own copy of these words), which depends on
//                                          203cli and runs it with C203_RUN_AS=203c
//   203cli updates, doctor                 say it too when run under the old name
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";

export const NEW_NAME = "203cli";
export const OLD_NAME = "203c";
export const INSTALL = "npm install -g 203cli && 203cli skill install";
export const RENAME_ZH = "203c 已改名为 203cli，203c 不再更新也不再支持。请运行：npm install -g 203cli && 203cli skill install（然后可以 npm uninstall -g 203c）";
export const RENAME_EN = "203c is renamed 203cli; 203c gets no more updates or support. Run: npm install -g 203cli && 203cli skill install (then you can npm uninstall -g 203c)";
// In GitHub Actions: what the workflow's owner changes.
export const RENAME_CI = "This workflow still runs 203c, which is renamed 203cli. It keeps working through 203cli for now; update it: " +
  "CardenzaHAL's community-publish action at a newer commit of the HAL's main (it runs 203cli), or your own steps to 203cli (npm install -g 203cli).";

/** Run under the old name: by the last 203c package (C203_RUN_AS=203c) or through the old script path, scripts/203c.mjs. */
export function runAsOldName(env = process.env, script = process.argv[1]) {
  return env.C203_RUN_AS === OLD_NAME || (!!script && path.basename(script) === "203c.mjs");
}

const escapeData = text => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const MARK = "<!-- 203c-renamed -->";

/**
 * The notice, on stderr (never stdout: --json answers stay JSON): both languages. In GitHub Actions also a ::warning::
 * annotation (stderr reaches the run's log when a step does not redirect it) and, once a step, a line in the job's summary
 * (GITHUB_STEP_SUMMARY: seen even when the step keeps stderr in a file, as the community-publish action does).
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
 * The first command on PATH by that name (203c, or 203cli: `name`), or null: {file, npm (npm installed it: its link,
 * macOS and Linux, or its shims, Windows), script (the file it runs, when known)}.
 */
export function findCommand(name, env = process.env) {
  const real = file => { try { return fs.realpathSync(file); } catch { return null; } };
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const file of [path.join(dir, name), path.join(dir, name + ".cmd")]) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      const target = real(file) ?? file;
      let text = "";
      try { text = stat.size < 4000 ? fs.readFileSync(file, "utf8") : ""; } catch { text = ""; }
      const npm = new RegExp(`node_modules[\\\\/]${name}[\\\\/]`).test(target) || new RegExp(`node_modules[\\\\/]${name}[\\\\/]`).test(text);
      const script = /\.m?js$/.test(target) ? target : (/"([^"]+\.mjs)"/.exec(text) ?? [])[1] ?? null;
      return {file, npm, script};
    }
  }
  return null;
}
