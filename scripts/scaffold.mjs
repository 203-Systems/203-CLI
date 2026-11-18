// 203c new: a firmware project to start from, the way the rules lay one out (CardenzaHAL docs/FIRMWARE-PROJECT.md "Start a
// project"), in one step: a git repository, CardenzaHAL as the submodule components/CardenzaHAL, the HAL's
// examples/template copied next to it and named (CMake's project(), 203.json, the release workflow), a README that says
// how to build, try and publish it. It builds as it is (the template does), for the board and the browser. Nothing is
// committed (whose name would it carry?) and nothing is published. Only the Cardenza has a template so far.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {HAL_REPO} from "./sim.mjs";
import {nameOk, NAME_RULE, writeProject, PROJECT_FILE} from "./project.mjs";
import {CliError, EXIT} from "./guide.mjs";

const RULES = "https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.md";
export const TEMPLATE_NAME = "my_firmware";
// Windows has python (and py), rarely python3.
const PYTHON = process.platform === "win32" ? "python" : "python3";

/** CMake's project() name for a firmware's name: lower-case letters, digits and _ ("Pocket Metronome" → pocket_metronome). */
export function projectId(name) {
  const id = String(name).normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return /^[a-z]/.test(id) ? id : id ? "fw_" + id : "firmware";
}

function git(args, cwd) {
  const run = spawnSync("git", args, {cwd, encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GIT_TERMINAL_PROMPT: "0"}});
  if (run.error) return {status: -1, missing: run.error.code === "ENOENT", stderr: String(run.error.message)};
  return {status: run.status, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim()};
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(target, {recursive: true}); copyTree(source, target); }
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}
const edit = (file, change) => { if (fs.existsSync(file)) fs.writeFileSync(file, change(fs.readFileSync(file, "utf8"))); };

function readme({name, summary, id, tool}) {
  // Commands with their comments in one column.
  const block = rows => rows.map(([command, comment]) => `${command.padEnd(Math.max(...rows.map(r => r[0].length)) + 2)}# ${comment}`).join("\n");
  const hal = `${PYTHON} components/CardenzaHAL/tools/`;
  const build = tool
    ? [[hal + "cardenza.py doctor", "what this computer still needs"], [hal + "cardenza.py build", `checks, then build/${id}.bin`],
       [hal + "cardenza.py web", "the browser version: build-web/site"]]
    : [["idf.py build", `in an ESP-IDF 5.3.5 shell: build/${id}.bin`], [hal + "cardenza_web.py build .", "the browser version: build-web/site"]];
  return `# ${name}

${summary || "What this firmware does, in a line."}

A firmware for the 203 Systems Cardenza (鸣片), built on [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL).

## Build

\`\`\`sh
${block([["git submodule update --init --recursive", "after cloning: the HAL"], ...build])}
\`\`\`

## Try it on a Cardenza

\`\`\`sh
${block([[`203c flash --bin build/${id}.bin`, "over the USB cable, through the 203 Launcher (which stays)"], ["203c log", "what it prints"]])}
\`\`\`

## Publish

\`\`\`sh
${block([["203c login", "once on a computer: the browser asks you to approve"], ["203c publish --dry-run", "what the community will check"],
    ["203c publish", "the first version; then CI: .github/workflows/firmware.yml"], ["203c inbox", "what people asked for and said"]])}
\`\`\`

The rules every firmware on CardenzaHAL follows: [FIRMWARE-PROJECT.md](${RULES}).
`;
}

export async function newProject(ctx) {
  const o = ctx.flags;
  const name = String(ctx.args.NAME).trim();
  if (!nameOk(name)) throw ctx.usage(`"${name}" is not a firmware name: ${NAME_RULE}`, {field: "NAME"});
  const device = String(o.device || "cardenza").toLowerCase();
  if (device !== "cardenza") {
    throw new CliError("no_template", `There is no project template for ${device} yet (only cardenza)`, {exit: EXIT.refused,
      hint: "Read the device's guide: products/<device>/README.md in 203-CLI (203c rules for the Cardenza)"});
  }
  const id = o.project ? String(o.project) : projectId(name);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id)) throw ctx.usage(`--project ${id}: letters, digits and _, starting with a letter`, {field: "project"});
  const dir = path.resolve(ctx.cwd, ctx.args.DIR ?? id.replace(/_/g, "-"));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    throw new CliError("dir_not_empty", `${dir} is not empty`, {exit: EXIT.refused, field: "DIR", hint: "Give a new folder: new NAME DIR",
      next: [ctx.cmd({args: {DIR: path.basename(dir) + "-2"}})]});
  }
  const repo = process.env.COMMUNITY_HAL_REPO || HAL_REPO;
  const plan = [`git init ${dir}`, `git submodule add ${repo} components/CardenzaHAL`,
    "copy components/CardenzaHAL/examples/template, named " + id, "203.json, README.md, CHANGELOG.md for " + JSON.stringify(name)];
  if (o.dry_run) return {json: {dry_run: true, dir, name, project: id, device, plan}, text: "Would make:\n  " + plan.join("\n  ")};

  const made = !fs.existsSync(dir);
  fs.mkdirSync(dir, {recursive: true});
  try {
    const init = git(["init", "-q", "-b", "main", dir], ctx.cwd);
    if (init.status !== 0) {
      throw new CliError(init.missing ? "git_missing" : "git_failed", init.missing ? "git is not installed" : `git init failed: ${init.stderr}`, {exit: EXIT.refused,
        hint: init.missing ? "Install git, then run it again" : "Check the folder"});
    }
    ctx.say(`Adding CardenzaHAL (${repo}) as components/CardenzaHAL…`);
    const local = !/^[a-z]+:\/\//i.test(repo) && !/^git@/.test(repo);
    const added = git([...(local ? ["-c", "protocol.file.allow=always"] : []), "submodule", "add", "-q", repo, "components/CardenzaHAL"], dir);
    const hal = path.join(dir, "components", "CardenzaHAL");
    if (added.status !== 0 || !fs.existsSync(path.join(hal, "examples", "template"))) {
      throw new CliError("hal_unavailable", `git submodule add ${repo} failed: ${(added.stderr || "no examples/template in it").split("\n").pop()}`, {exit: EXIT.later,
        hint: "Check the network (github.com), then run it again", next: [ctx.cmd()]});
    }
    copyTree(path.join(hal, "examples", "template"), dir);
    const swap = text => text.split(TEMPLATE_NAME).join(id);
    edit(path.join(dir, "CMakeLists.txt"), swap);
    edit(path.join(dir, ".github", "workflows", "firmware.yml"), swap);
    edit(path.join(dir, "main", "main.cpp"), swap);
    let author = null;
    if (ctx.client.token) { try { author = (await ctx.client.get("/me")).name; } catch { /* offline */ } }
    const template = JSON.parse(fs.readFileSync(path.join(dir, PROJECT_FILE), "utf8"));
    const summary = o.summary ? String(o.summary).trim() : null;
    if (summary && (summary.length < 1 || summary.length > 100)) throw ctx.usage("--summary is 1-100 characters", {field: "summary"});
    const {summary: _ignored, ...rest} = template;
    const project = {...rest, name, code: null, ...(author ? {author} : {}), ...(summary ? {summary} : {}),
      ...(o.tags ? {tags: o.tags} : {}), publish: {...template.publish, bins: {cardenza: `build/${id}.bin`}}};
    writeProject(path.join(dir, PROJECT_FILE), project);
    const tool = fs.existsSync(path.join(hal, "tools", "cardenza.py"));
    fs.writeFileSync(path.join(dir, "README.md"), readme({name, summary, id, tool}));
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n`203c publish` takes a version's release notes from its `## <version>` entry here.\n\n## 0.1.0\n\n- First version.\n");
    git(["add", "-A"], dir);
    const halCommit = git(["-C", hal, "rev-parse", "--short", "HEAD"], dir).stdout || null;
    const rel = path.relative(ctx.cwd, dir) || ".";
    const build = tool ? `${PYTHON} components/CardenzaHAL/tools/cardenza.py build` : "idf.py build";
    const todo = [
      ...(summary ? [] : ["203.json \"summary\": what it does, 1-100 characters (the first publish needs it)"]),
      "a LICENSE file, and its SPDX id in 203.json \"license\"",
      "main/main.cpp: the firmware (the template shows the keys; read the HAL's README for the API)",
      "git commit (everything is staged), then a repository online and its link in 203.json \"source\"",
    ];
    const next = [`cd ${rel}`, build, `203c flash --bin build/${id}.bin`, "203c log", "203c publish --dry-run"];
    return {json: {status: "created", dir, name, project: id, device, hal: {repo, commit: halCommit}, bin: `build/${id}.bin`, todo, next},
      text: `Made ${name} in ${dir} (CMake project ${id}, CardenzaHAL ${halCommit ?? ""}).\nStill to do:\n${todo.map(t => "  - " + t).join("\n")}\nNext:\n${next.map(n => "  " + n).join("\n")}`};
  } catch (error) {
    if (made) fs.rmSync(dir, {recursive: true, force: true});
    throw error;
  }
}
