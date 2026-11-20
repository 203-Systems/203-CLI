// The last 203c (legacy/203c) installed the way people get it, before 203cli is on npm: both packages packed, 203cli
// served by a stand-in registry on 127.0.0.1 (203c's dependency comes from there), then
//   npm install -g 203c   (into a temporary prefix)        and   npm install 203c   (a project's node_modules)
// and `203c` run from every shell this system has (Windows: cmd, PowerShell, Git Bash; macOS and Linux: sh, bash):
// stdout is 203cli's alone, the rename notice is on stderr, the exit code is 203cli's, the commands it prints say 203c.
// Also 203cli itself installed globally (npm install -g 203cli, then 203cli skill install). CI runs it on the three
// systems (ci.yml); locally: node tools/legacy-install-check.mjs. Nothing is published, nothing outside a temporary folder changes.
import {spawn, spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY = path.join(ROOT, "legacy", "203c");
const windows = process.platform === "win32";
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "203c-legacy-"));
let failures = 0;
const check = (ok, what, detail = "") => {
  if (ok) console.log(`ok   ${what}`);
  else { failures++; console.log(`FAIL ${what}${detail ? "\n     " + String(detail).trim().split("\n").join("\n     ") : ""}`); }
};

// npm itself, through the shell (npm.cmd on Windows), with the stand-in registry and nothing else from the network.
// Asynchronous: the registry below answers from this process.
function npm(args, {cwd = temp, env = {}} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(["npm", ...args.map(a => JSON.stringify(a))].join(" "), {cwd, shell: true,
      env: {...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`npm ${args.join(" ")} failed (${code}):\n${stdout}\n${stderr}`)));
  });
}

const packDir = path.join(temp, "packs");
fs.mkdirSync(packDir);
const packed = async dir => path.join(packDir, JSON.parse(await npm(["pack", "--json", "--pack-destination", packDir], {cwd: dir}))[0].filename);
const cliTgz = await packed(ROOT), oldTgz = await packed(LEGACY);

// The stand-in registry: 203cli at this version, from its tarball.
const bytes = fs.readFileSync(cliTgz);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const registry = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${registry.address().port}`;
  if (req.url === "/203cli") {
    const manifest = {...pkg, _id: `203cli@${version}`, dist: {tarball: `${base}/203cli/-/203cli-${version}.tgz`,
      integrity: "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"), shasum: crypto.createHash("sha1").update(bytes).digest("hex")}};
    res.writeHead(200, {"content-type": "application/json"});
    return res.end(JSON.stringify({name: "203cli", "dist-tags": {latest: version}, versions: {[version]: manifest}}));
  }
  if (req.url === `/203cli/-/203cli-${version}.tgz`) { res.writeHead(200, {"content-type": "application/octet-stream"}); return res.end(bytes); }
  res.writeHead(404, {"content-type": "application/json"});
  res.end(JSON.stringify({error: "not found"}));
});
await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
const REGISTRY = `http://127.0.0.1:${registry.address().port}/`;
const cache = path.join(temp, "npm-cache");

// The shells to run a command line in: [name, program, args before the line].
function shells() {
  const out = [];
  const has = (cmd, args) => spawnSync(cmd, args, {stdio: "ignore", shell: false}).status === 0;
  if (windows) {
    out.push(["cmd", process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c"]]);
    for (const ps of ["pwsh", "powershell"]) if (has(ps, ["-NoProfile", "-Command", "exit 0"])) { out.push([ps, ps, ["-NoProfile", "-Command"]]); break; }
    const git = ["C:\\Program Files\\Git\\bin\\bash.exe", "bash"].find(b => has(b, ["-c", "exit 0"]));
    if (git) out.push(["git-bash", git, ["-c"]]);
  } else {
    out.push(["sh", "/bin/sh", ["-c"]]);
    if (has("bash", ["-c", "exit 0"])) out.push(["bash", "bash", ["-c"]]);
  }
  return out;
}

function inShell([name, program, pre], line, env) {
  return new Promise(resolve => {
    // cmd: the whole line in quotes after /s /c, passed as it is (as Node's shell: true does). PowerShell: a quoted
    // path is run with &, and the native command's exit code is the shell's.
    const cmd = name === "cmd";
    const ps = name === "pwsh" || name === "powershell";
    const text = cmd ? `"${line}"` : ps ? `${line.startsWith('"') ? "& " : ""}${line}; exit $LASTEXITCODE` : line;
    const child = spawn(program, [...pre, text], {env: {...process.env, NO_UPDATE_NOTIFIER: "1", CI: "1", GITHUB_ACTIONS: "", ...env},
      windowsVerbatimArguments: cmd});
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => resolve({code, stdout, stderr}));
  });
}

// What a 203c run must give, from any shell.
async function expect203c(label, shell, invoke, env) {
  const {RENAME_EN} = await import(new URL("../legacy/203c/lib.mjs", import.meta.url).href);
  const v = await inShell(shell, `${invoke} --version`, env);
  check(v.code === 0 && v.stdout.trim() === version && v.stderr.includes(RENAME_EN), `${label} [${shell[0]}]: 203c --version is 203cli's, the notice on stderr`, JSON.stringify(v));
  const bad = await inShell(shell, `${invoke} nonsense --json`, env);
  let error = null;
  try { error = JSON.parse(bad.stderr.trim().split(/\r?\n/).pop()); } catch { error = null; }
  check(bad.code === 2 && error?.code === "usage" && bad.stdout === "" && /^203c /.test(error?.next?.[0] ?? ""),
    `${label} [${shell[0]}]: an error keeps 203cli's exit code (2), JSON last on stderr, next names 203c`, JSON.stringify(bad));
  const help = await inShell(shell, `${invoke} --help --json`, env);
  let json = null;
  try { json = JSON.parse(help.stdout); } catch { json = null; }
  check(help.code === 0 && json?.run_as === "203c", `${label} [${shell[0]}]: --json stdout is JSON alone`, help.stdout.slice(0, 300) + help.stderr.slice(0, 300));
}

try {
  const list = shells();
  console.log(`203cli ${version}, 203c ${JSON.parse(fs.readFileSync(path.join(LEGACY, "package.json"), "utf8")).version}; shells: ${list.map(s => s[0]).join(", ")}`);

  // npm install -g 203c: its dependency from the registry, below it.
  const prefix = path.join(temp, "global");
  await npm(["install", "-g", "--prefix", prefix, "--registry", REGISTRY, "--cache", cache, oldTgz]);
  const binDir = windows ? prefix : path.join(prefix, "bin");
  const nested = windows ? path.join(prefix, "node_modules", "203c", "node_modules", "203cli") : path.join(prefix, "lib", "node_modules", "203c", "node_modules", "203cli");
  check(fs.existsSync(path.join(nested, "scripts", "203cli.mjs")), "npm install -g 203c installed 203cli with it");
  for (const shell of list) {
    const env = {PATH: binDir + path.delimiter + process.env.PATH};
    await expect203c("global", shell, "203c", env);
  }

  // npm install 203c in a project: node_modules/.bin/203c, and npx.
  const project = path.join(temp, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({name: "a-project", version: "1.0.0", private: true}));
  await npm(["install", "--registry", REGISTRY, "--cache", cache, oldTgz], {cwd: project});
  for (const shell of list) {
    const local = path.join(project, "node_modules", ".bin");
    await expect203c("local", shell, shell[0] === "git-bash" || !windows ? `"${local.split(path.sep).join("/")}/203c"` : `"${path.join(local, "203c")}"`, {});
  }

  // npm install -g 203cli: its own command, and its skill.
  const prefix2 = path.join(temp, "global-cli");
  await npm(["install", "-g", "--prefix", prefix2, "--registry", REGISTRY, "--cache", cache, cliTgz]);
  const bin2 = windows ? prefix2 : path.join(prefix2, "bin");
  const home = path.join(temp, "home");
  for (const shell of list) {
    const r = await inShell(shell, "203cli --version", {PATH: bin2 + path.delimiter + process.env.PATH});
    check(r.code === 0 && r.stdout.trim() === version && !/203c is renamed/.test(r.stderr), `203cli [${shell[0]}]: 203cli --version, no notice`, JSON.stringify(r));
  }
  const skill = await inShell(list[0], "203cli skill install --json", {PATH: bin2 + path.delimiter + process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_SKILLS_DIR: ""});
  const skillDir = path.join(home, ".claude", "skills", "203-community", "scripts");
  check(skill.code === 0 && fs.existsSync(path.join(skillDir, "203cli.mjs")) && fs.existsSync(path.join(skillDir, "203c.mjs")),
    "203cli skill install: the skill has scripts/203cli.mjs and the old path scripts/203c.mjs", JSON.stringify(skill));
  for (const shell of list) {
    const old = await inShell(shell, `node "${path.join(skillDir, "203c.mjs").split(path.sep).join("/")}" --version`, {});
    check(old.code === 0 && old.stdout.trim() === version && /203c is renamed 203cli/.test(old.stderr), `the skill's old path [${shell[0]}]: node …/scripts/203c.mjs runs 203cli`, JSON.stringify(old));
  }
} catch (error) {
  failures++;
  console.log("FAIL " + error.message);
} finally {
  await new Promise(resolve => registry.close(resolve));
  try { fs.rmSync(temp, {recursive: true, force: true}); } catch { /* Windows may hold a file a moment */ }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
