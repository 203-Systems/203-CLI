#!/usr/bin/env node
// 203c: the firmware community from a terminal or an agent (the Agent Skill skill/203-community).
// Zero dependencies, Node 18+. Commands, flags and help: commands.mjs; errors and help topics:
// guide.mjs; local checks: checks.mjs; the guided workflows (doctor, publish, …): publish.mjs.
//   node scripts/203c.mjs doctor --json            is everything ready?
//   node scripts/203c.mjs help start               what to run for what
// Exit codes: 0 done, 1 refused, 2 usage, 3 try again later, 4 sign in, 5 sent back by the checks,
// 6 needs --force / --yes (guide.mjs EXIT_TEXT).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {fileURLToPath} from "node:url";
import {Client, ApiError, DEFAULT_API, CLI_VERSION, OPS, opsByName, loadToken, saveToken, forgetToken, tokenFile, loginStart, loginPoll, browserLogin, browserProblem,
  oidcExchange, oidcAvailable, inGithubActions, runCredentialOf, saveRunCredential, forgetRunCredential, runCredentialFile} from "./lib.mjs";
import {COMMANDS, GLOBAL_FLAGS, GROUPS, GROUP_DEFAULT, ALIASES, findCommand} from "./commands.mjs";
import {CliError, EXIT, EXIT_TEXT, ERROR_CODES, TOPICS, explainApiError, topicText, usage} from "./guide.mjs";
import {isPlaceholder, nearest, normalizeChannel, normalizeCode, normalizeTags} from "./checks.mjs";
import {rules} from "./publish.mjs";

// Flag names that mean another flag (suggested, never used silently).
const FLAG_SYNONYMS = {binary: "bin", image: "bin", file: "bin", "bin-file": "bin", "firmware-bin": "bin", path: "bin", ver: "version", tag: "tags",
  chan: "channel", "release-notes": "notes", changelog: "notes-file", "notes-path": "notes-file", sha: "commit", "git-commit": "commit", code: "firmware",
  id: "firmware", repo: "source-url", source: "source-url", url: "source-url", "repo-url": "source-url", desc: "description", text: "body", msg: "message",
  dry: "dry-run", dryrun: "dry-run", "dry-mode": "dry-run", check: "dry-run", "no-wait-checks": "no-wait", confirm: "yes", y: "yes", f: "force", picture: "cover",
  title: "name", label: "version", device: "target", engine_: "engine", licence: "license", "no-simulator": "no-sim", nosim: "no-sim",
  "simulator-dir": "sim-dir", "web-dir": "sim-dir", "hal-dir": "hal"};

// ---------------------------------------------------------------------------------------------
// How 203c was run (for the commands it prints) and quoting.

const SELF = fileURLToPath(import.meta.url);
function program() {
  const script = process.argv[1] ? path.resolve(process.argv[1]) : SELF;
  if (installedCommand(script)) return "203c";
  const relative = path.relative(process.cwd(), script);
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : script;
  // Forward slashes on Windows too: node takes them, and cmd, PowerShell and Git Bash read them alike, unquoted.
  return "node " + quote(process.platform === "win32" ? shown.split(path.sep).join("/") : shown);
}
// The first 203c on PATH runs this file: npm's link to it (macOS, Linux), npm's shims (Windows: 203c.cmd, and a sh script
// beside it), or the two-line script install.sh writes. Then the commands 203c prints (next, hints) are "203c …", as
// SKILL.md writes them.
function installedCommand(script) {
  const real = file => { try { return fs.realpathSync(file); } catch { return null; } };
  const self = real(script) ?? script;
  const npm = /node_modules[\\/]203c[\\/]scripts[\\/]203c\.mjs/;
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["203c", "203c.cmd"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      if (real(file) === self) return true;
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      if (text.length > 4000) return false;
      return text.includes(`"${script}"`) || (npm.test(text) && npm.test(self));
    }
  }
  return false;
}
const quote = value => {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
};
const dashed = key => key.replace(/_/g, "-");
const keyOf = flag => flag.replace(/-/g, "_");

// ---------------------------------------------------------------------------------------------
// Parsing: the command first (its words), then its flags and arguments with its own table.

const ALL_BOOLEANS = new Set([...Object.entries(GLOBAL_FLAGS), ...COMMANDS.flatMap(c => Object.entries(c.flags))].filter(([, f]) => f.bool).map(([n]) => n));
const ALL_VALUES = new Set([...Object.entries(GLOBAL_FLAGS), ...COMMANDS.flatMap(c => Object.entries(c.flags))].filter(([, f]) => !f.bool).map(([n]) => n));

function flagToken(token) {
  if (/^--?[0-9]/.test(token) || token === "-" || token === "--") return null;
  if (token.startsWith("--")) {
    const body = token.slice(2), at = body.indexOf("=");
    return {name: (at >= 0 ? body.slice(0, at) : body).toLowerCase().replace(/_/g, "-"), value: at >= 0 ? body.slice(at + 1) : undefined, raw: token};
  }
  if (token.startsWith("-") && token.length > 1) {
    const body = token.slice(1), at = body.indexOf("=");
    const name = (at >= 0 ? body.slice(0, at) : body).toLowerCase().replace(/_/g, "-");
    const short = {h: "help", y: "yes", j: "json", f: "force", n: "dry-run"}[name];
    return {name: short ?? name, value: at >= 0 ? body.slice(at + 1) : undefined, raw: token, single: !short};
  }
  return null;
}

function parse(argv) {
  // Pass 1: the words (tokens that are not flags or their values).
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") { words.push(...argv.slice(i + 1)); break; }
    const flag = flagToken(argv[i]);
    if (!flag) { words.push(argv[i]); continue; }
    if (flag.value === undefined && ALL_VALUES.has(flag.name) && !ALL_BOOLEANS.has(flag.name) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) i++;
  }
  return {words};
}

function resolveCommand(words, argv, ctxBase) {
  const lowered = words.map(w => String(w).toLowerCase());
  const found = findCommand(lowered);
  if (found) return found;
  if (lowered.length === 1 && GROUP_DEFAULT[lowered[0]]) return {command: COMMANDS.find(c => c.name === GROUP_DEFAULT[lowered[0]]), used: 1};
  // Not a command: the closest one, with the same arguments.
  const first = lowered[0];
  // Three words (firmware publishers list): the second names a group of its own.
  const deeper = COMMANDS.filter(c => c.words.length > 2 && c.words[0] === first && c.words[1] === lowered[1]);
  if (deeper.length) {
    const actions = deeper.map(c => c.words[2]);
    const action = lowered[2] ? nearest(lowered[2], actions) : null;
    throw usage(lowered[2] ? `Unknown command: ${first} ${words[1]} ${words[2]}` : `"${first} ${words[1]}" needs an action`, {
      hint: `${action ? `Did you mean ${first} ${words[1]} ${action}? ` : ""}${first} ${words[1]} takes: ${actions.join(", ")}`,
      next: deeper.map(c => `${ctxBase.prog} ${c.name} --help${ctxBase.json ? " --json" : ""}`)});
  }
  const without = drop => argv.filter((token, i) => !(drop.includes(token) && argv.indexOf(token) === i));
  if (GROUPS.includes(first)) {
    const actions = [...new Set(COMMANDS.filter(c => c.words[0] === first && c.words.length > 1).map(c => c.words[1]))];
    const alias = ALIASES[lowered[1]]?.split(" ").pop();
    const action = lowered[1] ? (actions.includes(alias) ? alias : nearest(lowered[1], actions)) : null;
    throw usage(lowered[1] ? `Unknown command: ${first} ${words[1]}` : `"${first}" needs an action`, {
      hint: `${action ? `Did you mean ${first} ${action}? ` : ""}${first} takes: ${actions.join(", ")}`,
      next: [action ? `${ctxBase.prog} ${[first, action, ...without([words[0], words[1]])].map(quote).join(" ")}` : null, `${ctxBase.prog} ${first} --help${ctxBase.json ? " --json" : ""}`].filter(Boolean)});
  }
  const close = ALIASES[first] ? first : nearest(first, [...new Set([...COMMANDS.map(c => c.words[0]), ...Object.keys(ALIASES)])]);
  const suggestion = close ? ALIASES[close] ?? close : null;
  throw usage(`Unknown command: ${words[0]}`, {
    hint: suggestion ? `Did you mean ${suggestion}? (${ctxBase.prog} --help lists every command)` : `${ctxBase.prog} --help lists every command; ${ctxBase.prog} help start says what to run for what`,
    next: suggestion ? [`${ctxBase.prog} ${[...suggestion.split(" "), ...without([words[0]])].map(quote).join(" ")}`, `${ctxBase.prog} help start${ctxBase.json ? " --json" : ""}`] : [`${ctxBase.prog} help start${ctxBase.json ? " --json" : ""}`]});
}

// Pass 2: the command's flags and arguments, checked against its table.
function parseFor(command, argv, used, base) {
  const specs = {...GLOBAL_FLAGS, ...command.flags};
  const flags = {}, order = [], positional = [];
  let wordsLeft = used;
  const fail = (message, extra) => { throw usage(message, {...extra, next: extra?.next ?? [`${base.prog} ${command.name} --help${base.json ? " --json" : ""}`]}); };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") { positional.push(...argv.slice(i + 1)); break; }
    const flag = flagToken(argv[i]);
    if (!flag) {
      if (wordsLeft > 0 && command.words.includes(String(argv[i]).toLowerCase())) { wordsLeft--; continue; }
      positional.push(argv[i]); continue;
    }
    let name = flag.name;
    if (flag.single && specs[name]) base.notes.push(`-${name} read as --${name}`);
    const spec = specs[name];
    if (!spec) {
      const synonym = FLAG_SYNONYMS[name];
      const guess = (synonym && specs[synonym] ? synonym : null) ?? nearest(name, Object.keys(command.flags)) ?? nearest(name, Object.keys(GLOBAL_FLAGS));
      const guessSpec = guess ? specs[guess] : null;
      // The same command with the right flag; never a decision (--force, --yes) from a guess: next[0] is run as it is.
      const decision = ["force", "yes", "accept-risk"].includes(guess) && synonym !== guess;
      const rest = [...argv];
      if (guess) rest.splice(i, 1, "--" + guess + (flag.value !== undefined && guessSpec && !guessSpec.bool ? "=" + flag.value : ""));
      const others = Object.keys(command.flags).map(f => "--" + f);
      fail(`Unknown flag ${flag.raw} for "${command.name}"`, {field: name,
        hint: (guess ? `Did you mean --${guess}?${decision ? " (a decision: add it only if the user wants it)" : ""} ` : "") + (others.length ? `Its flags: ${others.join(" ")}` : `"${command.name}" takes no flags`) + ` (and ${Object.keys(GLOBAL_FLAGS).map(f => "--" + f).join(" ")})`,
        next: guess && !decision ? [`${base.prog} ${rest.map(quote).join(" ")}`] : [`${base.prog} ${command.name} --help${base.json ? " --json" : ""}`]});
    }
    let value = flag.value;
    if (spec.bool) {
      if (value === undefined && i + 1 < argv.length && /^(true|false|yes|no|on|off)$/i.test(argv[i + 1])) value = argv[++i];
      if (value === undefined) value = true;
      else if (/^(true|yes|on|1)$/i.test(value)) value = true;
      else if (/^(false|no|off|0)$/i.test(value)) value = false;
      else fail(`--${name} is a switch: it takes no value ("${value}")`, {field: name, hint: `Write --${name} alone`});
    } else if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        fail(`--${name} needs a value (${spec.value})`, {field: name, hint: `${spec.help}; e.g. --${name} ${exampleValue(name, spec)}`});
      }
      value = next; i++;
    }
    const key = keyOf(name);
    if (spec.repeat) (flags[key] ??= []).push(value);
    else {
      if (flags[key] !== undefined && flags[key] !== value && !spec.bool) base.notes.push(`--${name} given twice: the last one (${spec.secret ? "…" : value}) counts`);
      flags[key] = value;
    }
    order.push({name, value, spec});
  }
  if (flags.help) return {flags, order, positional, help: true};
  // Values: numbers, lists, choices, channels.
  for (const {name, spec} of order) {
    const key = keyOf(name);
    const value = flags[key];
    if (spec.bool || value === undefined) continue;
    if (spec.type === "int" || spec.type === "number") {
      const n = Number(value);
      if (value === "" || !Number.isFinite(n) || (spec.type === "int" && !Number.isInteger(n))) {
        fail(`--${name} is ${spec.type === "int" ? "a whole number" : "a number"}, not "${value}"`, {field: name, hint: `e.g. --${name} ${exampleValue(name, spec)}`});
      }
      flags[key] = n;
    } else if (spec.type === "list") {
      flags[key] = String(value).split(",").map(x => x.trim()).filter(Boolean);
    } else if (name === "channel") {
      const parsed = normalizeChannel(value);
      if (parsed.error) fail(parsed.error, {field: "channel", hint: parsed.hint, next: parsed.suggestion ? [rebuild(base, command, order, positional, {set: {channel: parsed.suggestion}})] : undefined});
      flags[key] = parsed.channel;
    } else if (spec.choices && !spec.choices.includes(value)) {
      const exact = spec.choices.find(c => c.toLowerCase() === String(value).toLowerCase());
      if (exact) { flags[key] = exact; continue; }
      const guess = nearest(value, spec.choices);
      fail(`--${name} ${value} is not one of: ${spec.choices.join(", ")}`, {field: name, hint: guess ? `Did you mean ${guess}?` :
        name === "license" ? `${value} is not a licence for models here: CC-BY-4.0 (credit me), CC-BY-NC-4.0 (credit, not commercial), CC0-1.0 (public domain) or all-rights-reserved` : `Use one of: ${spec.choices.join(", ")}`,
        next: guess ? [rebuild(base, command, order, positional, {set: {[name]: guess}})] : undefined});
    }
  }
  return {flags, order, positional};
}

function exampleValue(name, spec) {
  const known = {version: "1.4.0", channel: "stable", bin: "cardenza=build/app.bin", notes: '"Fixes the arpeggiator"', "notes-file": "CHANGELOG.md", summary: '"Four-track groovebox"',
    name: '"My synth"', firmware: "K7M2QX", tags: "groovebox,synth", "source-url": "https://github.com/you/repo", cover: "cover.png", commit: "$(git rev-parse HEAD)",
    title: '"Warm pads"', license: "CC-BY-4.0", page: "2", limit: "24", timeout: "1200", poll: "5", target: "cardenza", password: "'<password>'", dir: "build/web"};
  return known[name] ?? (spec.choices ? spec.choices[0] : spec.value);
}

function bindArguments(command, positional, base) {
  const args = {};
  const params = command.params;
  const fail = (message, extra = {}) => { throw usage(message, {next: [`${base.prog} ${command.name} --help${base.json ? " --json" : ""}`], ...extra}); };
  let at = 0;
  for (const param of params) {
    if (param.variadic) { args[param.name] = positional.slice(at); at = positional.length; if (!param.optional && !args[param.name].length) fail(`Missing ${param.name} for "${command.name}"`, {hint: "Usage: " + command.usage}); continue; }
    const value = positional[at++];
    if (value === undefined) {
      if (param.optional) continue;
      // The short help right here (what it does, its usage, an example): nothing to look up for a missing argument.
      fail(`Missing ${param.name} for "${command.name}"`, {hint: `${command.summary}. Usage: ${command.usage}` + (command.examples[0] ? `; e.g. ${base.prog} ${command.examples[0]}` : "") +
        (param.type === "code" ? ". Never guess a code: firmware mine lists yours" : ""),
        next: [`${base.prog} ${command.name} --help${base.json ? " --json" : ""}`, ...(param.type === "code" ? [`${base.prog} firmware mine${base.json ? " --json" : ""}`] : [])]});
    }
    args[param.name] = value;
  }
  if (at < positional.length) {
    const extra = positional.slice(at);
    fail(`Unexpected ${extra.length > 1 ? "arguments" : "argument"} for "${command.name}": ${extra.map(quote).join(" ")}`, {
      hint: `Usage: ${command.usage}. A text with spaces goes in quotes: --notes "two words"`});
  }
  for (const param of params) {
    const value = args[param.name];
    if (value === undefined) continue;
    if (param.type === "code") {
      const parsed = normalizeCode(value);
      if (parsed.error) {
        fail(`${parsed.error} (${param.name} is a 6-character ${param.name === "VCODE" ? "version" : "firmware"} code)`, {exit: EXIT.usage, hint: parsed.hint + (parsed.looksLikeName ? ` "${value}" looks like a name: find its code with firmware mine (yours) or search.` : ""),
          next: [`${base.prog} firmware mine${base.json ? " --json" : ""}`, `${base.prog} search ${quote(value)}${base.json ? " --json" : ""}`]});
      }
      args[param.name] = parsed.code;
    } else if (param.type === "int") {
      const n = Number(value);
      if (!Number.isInteger(n)) fail(`${param.name} is a whole number, not "${value}"`, {hint: "Usage: " + command.usage});
      args[param.name] = n;
    }
    const choices = command.choices?.[param.name];
    if (choices && !choices.includes(value)) {
      const exact = choices.find(c => c.toLowerCase() === String(value).toLowerCase());
      if (exact) { args[param.name] = exact; continue; }
      const singular = String(value).replace(/s$/, "");
      const guess = choices.includes(singular) ? singular : nearest(value, choices);
      fail(`${param.name} "${value}" is not one of: ${choices.join(", ")}`, {hint: guess ? `Did you mean ${guess}?` : "Usage: " + command.usage,
        next: guess ? [`${base.prog} ${[...command.words, ...positional.map(p => p === value ? guess : p)].map(quote).join(" ")}${base.json ? " --json" : ""}`] : undefined});
    }
  }
  return args;
}

// A command line with changes (copy-pasteable): set/add flags, remove some, replace values or arguments.
function rebuild(base, command, order, positional, changes = {}, {json = base.json} = {}) {
  const set = Object.fromEntries(Object.entries({...(changes.set ?? {}), ...(changes.add ?? {})}).map(([k, v]) => [dashed(k), v]));
  const remove = new Set((changes.remove ?? []).map(dashed));
  const replace = Object.fromEntries(Object.entries(changes.replace ?? {}).map(([k, v]) => [dashed(k), v]));
  const parts = [base.prog, ...command.words];
  const params = command.params;
  let at = 0;
  for (const param of params) {
    if (param.variadic) { parts.push(...positional.slice(at).map(quote)); at = positional.length; continue; }
    let value = changes.args?.[param.name] ?? base.args?.[param.name] ?? positional[at];
    at++;
    if (replace[param.name] && String(value) === String(replace[param.name][0])) value = replace[param.name][1];
    if (value !== undefined) parts.push(quote(value));
  }
  if (changes.args) for (const [name, value] of Object.entries(changes.args)) if (!params.some(p => p.name === name)) parts.push(quote(value));
  const shown = new Set();
  const render = (name, value, spec) => {
    if (spec?.secret) return name === "token" ? null : `--${name} ${quote(value === true ? "" : "<" + name + ">")}`;
    if (value === true) return `--${name}`;
    if (value === false) return null;
    return `--${name} ${quote(Array.isArray(value) ? value.join(",") : value)}`;
  };
  const specs = {...GLOBAL_FLAGS, ...command.flags};
  for (const {name, value, spec} of order) {
    if (remove.has(name) || name === "json" || name === "help") continue;
    if (name in set && !spec.repeat) {
      if (shown.has(name)) continue;
      shown.add(name);
      const piece = render(name, set[name], spec);
      if (piece) parts.push(piece);
      continue;
    }
    let shownValue = value;
    if (replace[name] && String(value) === String(replace[name][0])) shownValue = replace[name][1];
    const piece = render(name, shownValue, spec);
    if (piece) parts.push(piece);
    shown.add(name);
  }
  for (const [name, value] of Object.entries(set)) {
    if (shown.has(name) || remove.has(name)) continue;
    const piece = render(name, value, specs[name]);
    if (piece) parts.push(piece);
  }
  if (json) parts.push("--json");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Help

function usageLine(command) {
  const needed = (command.need ?? []).map(flag => `--${flag} ${command.flags[flag]?.value ?? "…"}`);
  return [command.usage, ...needed].join(" ");
}

function mainHelp(prog) {
  const groups = {};
  for (const command of COMMANDS) (groups[command.group ?? "Other"] ??= []).push(command);
  const lines = [`203c ${CLI_VERSION} — the 203 Systems firmware community from a terminal or an agent (${DEFAULT_API.replace(/\/api$/, "")})`, "",
    "Start here", `  ${prog} doctor --json                     is everything ready (token, API, today's limits)?`,
    `  ${prog} help start                        what to run for what`,
    `  ${prog} publish … --dry-run --json        check a release (nothing changes), then run it without --dry-run`, "",
    `Commands (add --help to any of them for its flags and examples)`];
  for (const [group, commands] of Object.entries(groups)) {
    lines.push(` ${group}`);
    for (const command of commands) lines.push(`  ${usageLine(command).padEnd(44)} ${command.summary}`);
  }
  lines.push("", "Options everywhere: " + Object.entries(GLOBAL_FLAGS).map(([name, spec]) => `--${name}${spec.bool ? "" : " " + spec.value}`).join("  "),
    `Every command but login, logout, help, doctor and rules needs a sign-in (203c login: the user approves it in the browser on the site; or login --with-token, a personal token;` +
      ` in GitHub Actions login --github-oidc --firmware CODE: trusted publishing, no secret).`,
    `Token: --token, else COMMUNITY_TOKEN, else in GitHub Actions this run's (login --github-oidc), else ${tokenFile()} (mode 600). API: --api, else COMMUNITY_API, else ${DEFAULT_API}.`,
    "Exit codes: " + EXIT_TEXT.map(([code, text]) => `${code} ${text.split(":")[0].split(" (")[0]}`).join(" · "),
    `Topics: ${prog} help ${Object.keys(TOPICS).join("|")}`);
  return lines.join("\n");
}

export function commandHelp(command, prog) {
  const flagLines = Object.entries(command.flags).map(([name, spec]) =>
    `  --${name}${spec.bool ? "" : " " + spec.value}`.padEnd(34) + " " + spec.help + ((command.need ?? []).includes(name) ? " (required)" : "") + (spec.repeat ? " (repeatable)" : ""));
  return [`${prog} ${command.usage}`, "", command.summary + (command.write ? " (needs a sign-in with write)" : ""), "",
    ...(flagLines.length ? ["Options", ...flagLines, ""] : []),
    "Everywhere: " + Object.entries(GLOBAL_FLAGS).map(([name, spec]) => `--${name}${spec.bool ? "" : " " + spec.value}`).join("  "), "",
    "Examples", ...command.examples.map(example => `  ${prog} ${example}`),
    ...(command.topic ? ["", `More: ${prog} help ${command.topic}`] : [])].join("\n");
}

const groupHelp = (group, prog) => [`${prog} ${group} <action> …`, "", ...COMMANDS.filter(c => c.words[0] === group).map(c => `  ${usageLine(c).padEnd(44)} ${c.summary}`), "",
  `Each one's flags and examples: ${prog} ${group} <action> --help`].join("\n") + "\n";

// --help --json: a command as data (the same table as --help and reference/cli.md).
const flagJson = (name, spec, command) => ({name: "--" + name, ...(spec.bool ? {switch: true} : {value: spec.value}), help: spec.help,
  ...(spec.choices ? {choices: spec.choices} : {}), ...(spec.type ? {type: spec.type} : {}), ...(spec.repeat ? {repeat: true} : {}),
  ...((command?.need ?? []).includes(name) ? {required: true} : {})});
export function commandJson(command, prog) {
  return {command: command.name, usage: `${prog} ${usageLine(command)}`, summary: command.summary, group: command.group ?? "Other",
    arguments: command.params.map(p => ({name: p.name, ...(p.optional ? {optional: true} : {}), ...(p.variadic ? {variadic: true} : {}), type: p.type,
      ...(command.choices?.[p.name] ? {choices: [...new Set(command.choices[p.name].map(c => c.toLowerCase()))]} : {})})),
    flags: Object.entries(command.flags).map(([name, spec]) => flagJson(name, spec, command)),
    signin: command.offline || command.anyone ? false : command.write ? "write" : true, ...(command.confirm ? {needs_yes: true} : {}), ...(command.webOnly ? {web_only: true} : {}),
    examples: command.examples.map(example => `${prog} ${example}`), ...(command.topic ? {topic: `${prog} help ${command.topic}`} : {})};
}
function groupJson(group, prog) {
  return {group, commands: COMMANDS.filter(c => c.words[0] === group).map(c => ({command: c.name, usage: `${prog} ${usageLine(c)}`, summary: c.summary}))};
}
// --help --json without a command: everything an agent needs to drive 203c.
function helpJson(prog) {
  return {cli: CLI_VERSION, run_as: prog, api: {default: DEFAULT_API, env: "COMMUNITY_API", flag: "--api"},
    token: {flag: "--token", env: "COMMUNITY_TOKEN", github_actions: "login --github-oidc --firmware CODE (trusted publishing: the run's own, in $RUNNER_TEMP/203c)", file: tokenFile()},
    output: "With --json the answer is JSON on stdout; an error is one JSON line on stderr (its last line): {error, code, field?, hint, next: [commands], exit}",
    global_flags: Object.entries(GLOBAL_FLAGS).map(([name, spec]) => flagJson(name, spec)),
    exit_codes: EXIT_TEXT.map(([exit, meaning]) => ({exit, meaning})), error_codes: ERROR_CODES.map(([code, exit, meaning, todo]) => ({code, exit, meaning, todo})),
    topics: Object.entries(TOPICS).map(([name, topic]) => ({topic: name, title: topic.title, help: `${prog} help ${name} --json`})),
    commands: COMMANDS.map(c => ({command: c.name, usage: `${prog} ${usageLine(c)}`, summary: c.summary, group: c.group ?? "Other",
      signin: c.offline || c.anyone ? false : c.write ? "write" : true, help: `${prog} ${c.name} --help --json`}))};
}

// reference/cli.md: every command, generated from the table (tests check it is current).
export function referenceMarkdown() {
  const prog = "203c";
  const lines = ["# 203c command reference", "",
    "Generated from the CLI's command table (`node scripts/203c.mjs help --reference > reference/cli.md`). `203c` is the command",
    "`npm install -g 203c` puts on PATH, else `node <the skill's folder>/scripts/203c.mjs`; run it",
    "from the firmware project's folder. Every",
    "command takes the global options; with `--json` the answer is JSON on stdout and an error is one JSON line on stderr (its",
    "last line): `{\"error\",\"code\",\"field\",\"hint\",\"next\":[commands],\"exit\"}`. `--help --json` gives any command (or, alone,",
    "all of them) as JSON.", "",
    "## Global options", "", "| option | |", "|---|---|", ...Object.entries(GLOBAL_FLAGS).map(([name, spec]) => `| \`--${name}${spec.bool ? "" : " " + spec.value.replace(/\|/g, "\\|")}\` | ${spec.help} |`), "",
    "## Exit codes", "", "| exit | meaning |", "|---|---|", ...EXIT_TEXT.map(([code, text]) => `| ${code} | ${text} |`), "",
    "## Error codes", "", "| code | exit | meaning | what to do |", "|---|---|---|---|", ...ERROR_CODES.map(([code, exit, meaning, todo]) => `| \`${code}\` | ${exit} | ${meaning.replace(/\|/g, "\\|")} | ${todo.replace(/\|/g, "\\|")} |`), ""];
  const groups = {};
  for (const command of COMMANDS) (groups[command.group ?? "Other"] ??= []).push(command);
  for (const [group, commands] of Object.entries(groups)) {
    lines.push(`## ${group}`, "");
    for (const command of commands) {
      lines.push(`### \`${prog} ${command.usage}\``, "", command.summary + (command.write ? " (sign-in with write)" : "") + (command.confirm ? " Needs `--yes`." : ""), "");
      const flags = Object.entries(command.flags);
      if (flags.length) lines.push(...flags.map(([name, spec]) => `- \`--${name}${spec.bool ? "" : " " + spec.value}\` ${spec.help}${(command.need ?? []).includes(name) ? " (required)" : ""}${spec.repeat ? " (repeatable)" : ""}`), "");
      lines.push(...command.examples.map(example => "    " + prog + " " + example), "");
    }
  }
  lines.push("## Help topics", "", ...Object.entries(TOPICS).map(([name, topic]) => `- \`203c help ${name}\` — ${topic.title}`), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Human output of API answers (custom workflows bring their own text).

const who = u => u ? `${u.title ? "[" + u.title.text + "] " : ""}${u.name}${u.badges?.length ? " " + u.badges.map(x => "‹" + x.name + "›").join("") : ""} (Lv${u.level ?? "?"})` : "—";
function human(name, value) {
  if (value === null || value === undefined) return "done";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value.items) && "total" in value) {
    const lines = value.items.map(item => line(item));
    return [...lines, `— ${value.items.length} of ${value.total}${value.page ? ` (page ${value.page})` : ""}${value.unread !== undefined ? `, ${value.unread} unread` : ""}` +
      (value.next_cursor ? `\n— more: --cursor ${value.next_cursor}` : "")].join("\n");
  }
  if (name === "sections") return value.items.map(line).join("\n");
  if (name === "whoami" || name === "user") {
    const c = value.credential;
    return `${who(value)}  id ${value.id}\nXP ${value.xp}${value.next_level_xp ? " / " + value.next_level_xp : ""} · firmware ${value.stats?.firmware} · works ${value.stats?.works}` +
      ` · models ${value.stats?.models} · sounds ${value.stats?.sounds} · projects ${value.stats?.projects} · posts ${value.stats?.posts}` +
      (c ? `\nsigned in as: ${c.kind} "${c.name}" (${c.id}) · scopes ${(c.scopes ?? value.scopes ?? []).join(", ")} · made ${String(c.created).slice(0, 10)}` +
        `${c.last_used ? " · last used " + String(c.last_used).slice(0, 16).replace("T", " ") : ""}${c.expires_at ? " · ends " + String(c.expires_at).slice(0, 10) : ""}`
        : value.scopes ? "\nscopes: " + value.scopes.join(", ") : "");
  }
  if (name === "quotas") return value.items.map(q => `${q.what.padEnd(22)} ${String(q.left).padStart(4)} left of ${q.limit}${q.per === "day" ? " (last 24 h)" : ""}`).join("\n");
  if (name === "devices") {
    return value.items.length ? value.items.map(d => `${String(d.id).padEnd(5)} ${d.name}  ${d.target}  ${d.online ? "online" + (d.where ? " (" + (d.where === "firmware" ? "a firmware running" : "in its Launcher") + ")" : "")
      : "off or not online"}${d.last_seen ? "  last seen " + String(d.last_seen).slice(0, 16).replace("T", " ") : ""}`).join("\n")
      : "No device is signed in to this account (a Launcher signs in from Account on its home screen, older Launchers System Settings › Account › Bind account; the user approves its code on the site).";
  }
  if (value.code && value.summary !== undefined) {
    const latest = Object.entries(value.latest ?? {}).filter(([, v]) => v).map(([c, v]) => `${c} ${v.version} (${v.code})`).join(", ");
    return `${value.code}  ${value.name}${value.official ? "  [official]" : ""}${value.visibility === "private" ? "  [private]" : ""}\n${value.summary}\n` +
      `by ${who(value.owner)} · ${latest || "no versions yet"} · ♥ ${value.counts?.likes} · ⇩ ${value.counts?.downloads} · forks ${value.counts?.forks}`;
  }
  return JSON.stringify(value, null, 2);
}
function line(item) {
  if (item.code && item.summary !== undefined) return `${item.code}  ${item.name}${item.official ? " [official]" : ""} — ${item.summary} (${who(item.owner)})`;
  if (item.code && item.channel) return `${item.code}  ${item.version}  ${item.channel}  ${item.status ?? ""}  build ${item.build ?? ""}`;
  if (item.kind && item.subject) return `${item.read ? " " : "•"} ${item.kind}  ${item.subject.title || item.subject.ref}  ${item.text ?? ""}`;
  if (item.number && item.from) return `!${item.number}  ${item.status}  ${item.title}  (${who(item.author)})`;
  if (item.license) return `${item.id}  ${item.title}  ${item.license}  ⇩ ${item.counts?.downloads}  (${who(item.author)})`;
  if (item.engine) return `${item.id}  ${item.title}  ${item.engine}  ${item.presets} presets  ⇩ ${item.counts?.downloads}  (${who(item.author)})`;
  if ("format" in item && "bpm" in item) return `${item.id}  ${item.title}  ${item.bpm ? item.bpm + " BPM" : ""}  ⇩ ${item.counts?.downloads}  (${who(item.author)})`;
  if (item.label !== undefined && item.count !== undefined && item.id) return `${item.id}  ${item.label}  ${item.count}${item.open === false ? "  (not open yet: admins only)" : ""}`;
  if (item.media) return `${item.id}  ${item.title}  ${item.kind}  ▶ ${item.counts?.plays}  (${who(item.author)})`;
  if (item.excerpt !== undefined) return `${item.id}  ${item.pinned ? "📌 " : ""}${item.title}  (${who(item.author)})`;
  if (item.body !== undefined && item.target) return `#${item.id}  ${who(item.author)}: ${item.body.replace(/\s+/g, " ").slice(0, 100)}`;
  if (item.action && item.xp !== undefined) return `${item.at}  ${item.xp > 0 ? "+" : ""}${item.xp}  ${item.action}${item.revoked ? " (taken back)" : ""}`;
  return JSON.stringify(item);
}

// ---------------------------------------------------------------------------------------------
// Signing in (COMMUNITY.md "Signing in"): in the browser where there is one (the authorization code with
// PKCE: login opens the site's /authorize page and waits for it to come back); otherwise (--no-browser,
// SSH, CI, no display) with a code approved on the site's /activate: on a terminal it waits, else login
// prints the link and login --wait waits. Both give the same cli credential. Or with a personal token made
// on the site (设置 › 个人令牌, /me/tokens): login --with-token reads it from stdin (asks for it, hidden, on
// a terminal), login --token TOKEN takes it from the command line; checked with GET /me, then saved.

const pendingFile = () => path.join(path.dirname(tokenFile()), "pending-login.json");
const siteOf = api => String(api).replace(/\/+$/, "").replace(/\/api$/, "");
const TOKEN_PROMPT = "Paste a personal token (设置 › 个人令牌 on the site): ";
const TOKEN_FLAGS_APART = ["no-browser", "wait", "no-wait", "admin", "name"];
function readPending(api) {
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile(), "utf8"));
    if (pending.api === api && Date.parse(pending.expires_at) > Date.now()) return pending;
  } catch { /* none */ }
  return null;
}
function writePending(value) {
  fs.mkdirSync(path.dirname(pendingFile()), {recursive: true, mode: 0o700});
  fs.writeFileSync(pendingFile(), JSON.stringify(value), {mode: 0o600});
}

async function login(ctx) {
  const o = ctx.flags;
  if (o.github_oidc) return await loginGithubOidc(ctx);
  if (o.firmware !== undefined) throw ctx.usage("--firmware goes with --github-oidc (trusted publishing in GitHub Actions)", {hint: `${ctx.run(["login", "--github-oidc", "--firmware", o.firmware], {json: false})}`});
  if (o.with_token || ctx.tokenSource === "flag") return await loginWithToken(ctx);
  if (ctx.client.token && !o.wait) {
    try {
      const account = await ctx.client.get("/me");
      // --admin with a sign-in that lacks the admin scope: a new sign-in (it replaces the saved one).
      const wantsAdmin = o.admin && !(account.scopes ?? []).includes("admin");
      if (wantsAdmin && account.role !== "admin") {
        throw new CliError("forbidden", `${account.name} is not an admin: there is no admin scope to ask for`, {exit: EXIT.refused, hint: "Admins are made by the community's administrators"});
      }
      if (wantsAdmin && ctx.tokenSource === "env") {
        throw new CliError("forbidden", "COMMUNITY_TOKEN is set and has no admin scope", {exit: EXIT.signin,
          hint: "Unset COMMUNITY_TOKEN (or make a token with the admin scope on the site: 设置 › 个人令牌), then sign in with --admin", next: [ctx.run(["login", "--admin"])]});
      }
      if (wantsAdmin) ctx.note(`signing in again with the admin scope (the sign-in saved now has ${(account.scopes ?? []).join(", ")})`);
      else return {json: {status: "signed_in", already: true, user: {id: account.id, name: account.name}, scopes: account.scopes, source: ctx.tokenSource},
        text: `Already signed in as ${account.name} (${account.id}). ${ctx.run(["logout"], {json: false})} first to sign in as someone else.`};
    } catch (error) { if (!(error instanceof ApiError) || error.code !== "signin_required") throw error; }
  }
  const noBrowser = o.no_browser ? "--no-browser" : o.wait || o.no_wait ? "--wait" : browserProblem();
  if (!noBrowser) return await loginInBrowser(ctx);
  let pending = readPending(ctx.api);
  const wait = o.wait || (ctx.interactive && !o.no_wait);
  if (!pending || (!o.wait && !wait)) {
    const started = await loginStart(ctx.client, typeof o.name === "string" ? o.name : undefined);
    pending = {api: ctx.api, request_id: started.request_id, user_code: started.user_code, verify_url: started.verify_url_complete ?? started.verify_url, interval: started.interval,
      expires_at: new Date(Date.now() + started.expires_in * 1000).toISOString()};
    writePending(pending);
  }
  const minutes = Math.max(1, Math.round((Date.parse(pending.expires_at) - Date.now()) / 60000));
  if (!wait) {
    return {json: {status: "pending", via: "code", ...(noBrowser !== "--wait" && noBrowser !== "--no-browser" ? {no_browser: noBrowser} : {}), verify_url: pending.verify_url, user_code: pending.user_code, expires_in: minutes * 60,
      todo: `Give the user the link and the code: they open it signed in to the site and approve${o.admin ? " (ticking admin)" : ""}. Then run next[0].`, next: [ctx.run(["login", "--wait"])]},
      text: `Open ${pending.verify_url}\nand approve the code ${pending.user_code} (valid ${minutes} minutes). Then run:\n  ${ctx.run(["login", "--wait"], {json: false})}`};
  }
  // While it waits: the link and the code (with --json one JSON line; the answer or the error comes after it).
  process.stderr.write(ctx.json ? JSON.stringify({status: "waiting", via: "code", verify_url: pending.verify_url, user_code: pending.user_code, expires_in: minutes * 60,
    todo: "Give the user verify_url and user_code: they open it signed in to the site and approve"}) + "\n"
    : `Open ${pending.verify_url}\nand approve the code ${pending.user_code} (valid ${minutes} minutes).\n`);
  let got;
  try { got = await loginPoll(ctx.client, pending.request_id, {interval: pending.interval ?? 3, timeout: o.timeout ?? 600}); }
  catch (error) {
    if (error instanceof ApiError && ["expired", "forbidden"].includes(error.code)) {
      try { fs.unlinkSync(pendingFile()); } catch { /* gone */ }
      throw new CliError(error.code === "expired" ? "expired" : "forbidden", error.code === "expired" ? "The sign-in code expired before it was approved" : "The user refused the sign-in",
        {exit: EXIT.signin, hint: "Start again and give the user the new link", next: [ctx.run(["login"])]});
    }
    if (error instanceof ApiError && error.code === "authorization_pending") {
      throw new CliError("authorization_pending", "Not approved yet", {exit: EXIT.later, hint: `The user approves ${pending.user_code} at ${pending.verify_url}`, next: [ctx.run(["login", "--wait"])]});
    }
    throw error;
  }
  try { fs.unlinkSync(pendingFile()); } catch { /* gone */ }
  const file = saveToken(got.token);
  if (!ctx.json) process.stderr.write(`Signed in as ${got.user.name}; the token is in ${file}\n`);
  return {json: {status: "signed_in", via: "code", user: got.user, scopes: got.scopes, saved: file}, text: `Signed in as ${got.user.name} (${got.user.id}); scopes ${got.scopes.join(", ")}.`};
}

// Trusted publishing (COMMUNITY.md "Trusted publishing", the user 2026-11-17: no stored CI secret): in a GitHub
// Actions job with permissions: id-token: write, the job's OIDC token (audience: the API's base) for a ci
// credential that publishes FIRMWARE's versions for 15 minutes, kept for this run only ($RUNNER_TEMP/203c, never
// ~/.config) and renewed by 203c before it ends. Run it again in the same job whenever: it exchanges a new one.
async function loginGithubOidc(ctx) {
  const o = ctx.flags;
  const apart = ["with-token", "no-browser", "wait", "no-wait", "admin", "name"].filter(flag => o[keyOf(flag)] !== undefined && o[keyOf(flag)] !== false);
  if (apart.length || ctx.tokenSource === "flag") {
    throw ctx.usage(`${[...apart.map(f => "--" + f), ...(ctx.tokenSource === "flag" ? ["--token"] : [])].join(", ")} ${apart.length + (ctx.tokenSource === "flag") > 1 ? "do" : "does"} not go with --github-oidc`,
      {hint: "Trusted publishing needs nothing but the firmware's code: " + ctx.run(["login", "--github-oidc", "--firmware", "CODE"], {json: false})});
  }
  const workflowHint = "In the workflow: permissions: id-token: write (the job, or the workflow), then 203c login --github-oidc --firmware CODE";
  if (!inGithubActions() || !oidcAvailable()) {
    throw new CliError(inGithubActions() ? "oidc_unavailable" : "usage", inGithubActions()
      ? "This job cannot ask GitHub for an OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL is not set): it needs permissions: id-token: write"
      : "--github-oidc works in GitHub Actions only: there the job's own identity signs in, with no secret", {exit: EXIT.usage, field: "github-oidc",
      hint: inGithubActions() ? workflowHint : "On a computer: 203c login (the browser) or login --with-token; in GitHub Actions: " + workflowHint,
      next: inGithubActions() ? [ctx.run(["help", "ci"], {json: false})] : [ctx.run(["login"]), ctx.run(["help", "ci"], {json: false})]});
  }
  if (!runCredentialFile()) {
    throw new CliError("usage", "RUNNER_TEMP is not set: 203c keeps the run's credential there (GitHub sets it in every job)", {exit: EXIT.usage});
  }
  let firmware = typeof o.firmware === "string" ? o.firmware : null;
  if (!firmware) {
    // 203.json's code (the project being published), else ask for it.
    let dir = ctx.cwd, found = null;
    for (let i = 0; i < 6 && !found; i++) {
      for (const name of ["203.json", "203c.json"]) {
        try { const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); found = data.code ?? data.firmware ?? null; if (found) break; } catch { /* none */ }
      }
      if (path.dirname(dir) === dir) break;
      dir = path.dirname(dir);
    }
    if (!found) throw ctx.usage("Which firmware? --firmware CODE (the one whose trusted publisher this repository is)", {field: "firmware",
      hint: "The code is on the firmware's page; 203.json's \"code\" is taken when there is one"});
    firmware = String(found);
    ctx.note(`--firmware ${firmware} (203.json's code)`);
  }
  firmware = firmware.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[2-9A-HJ-NP-Z]{6}$/.test(firmware)) throw ctx.usage(`--firmware ${o.firmware} is not a firmware code (6 of 2-9 and A-Z without I and O)`, {field: "firmware"});
  let got;
  try { got = await oidcExchange(ctx.client, firmware); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const repo = process.env.GITHUB_REPOSITORY || "OWNER/NAME";
    const workflow = (process.env.GITHUB_WORKFLOW_REF || "").replace(/^.*\/\.github\/workflows\//, "").replace(/@.*$/, "") || "firmware.yml";
    const link = `${ctx.prog} firmware publishers add ${firmware} --repository ${repo} --workflow ${workflow}`;
    if (error.code === "oidc_untrusted") {
      throw new CliError("oidc_untrusted", error.message, {exit: EXIT.refused, status: error.status, data: pickData(error.data),
        hint: `The firmware's owner links this repository as a trusted publisher: on the firmware's page (开发 › 自动发布), or signed in as the owner: ${link}`,
        next: [link]});
    }
    if (error.code === "oidc_channel") {
      throw new CliError("oidc_channel", error.message, {exit: EXIT.refused, status: error.status, data: pickData(error.data),
        hint: "stable needs a run on a tag vX.Y.Z, beta a tag vX.Y.Z-beta.N; anything else publishes dev only, and only on the channels the trusted publisher allows"});
    }
    if (error.code === "oidc_invalid") {
      throw new CliError("oidc_invalid", error.message, {exit: EXIT.signin, status: error.status, data: pickData(error.data),
        hint: error.data?.reason === "audience" ? `203c asks GitHub for a token with the audience ${ctx.client.api} (--api / COMMUNITY_API): it must be the community's API base`
          : error.data?.reason === "replayed" ? "Run login --github-oidc again: it asks GitHub for a new token"
          : "Run login --github-oidc again; if it keeps failing, the community cannot check GitHub's token (help ci)", next: [ctx.cmd({})]});
    }
    throw error;
  }
  const run = runCredentialOf(ctx.client, got);
  const file = saveRunCredential(run);
  // The token never shows in the job's log (203c never prints it; this hides it should anything else).
  process.stderr.write("::add-mask::" + got.token + "\n");
  const minutes = Math.round((Date.parse(got.expires_at) - Date.now()) / 60000);
  if (!ctx.json) process.stderr.write(`Signed in for ${got.firmware} (trusted publishing from ${process.env.GITHUB_REPOSITORY || "GitHub Actions"}); the credential is in ${file}\n`);
  return {json: {status: "signed_in", via: "github-oidc", firmware: got.firmware, channel_allowed: got.channel_allowed, expires_at: got.expires_at, scopes: got.scopes,
      user: got.user ?? null, repository: process.env.GITHUB_REPOSITORY ?? null, saved: file,
      note: "For this run only (renewed by 203c before it ends); publish only this firmware's versions on these channels"},
    text: `Signed in for ${got.firmware} as ${got.user?.name ?? "its owner"}: may publish on ${got.channel_allowed.join(", ")} for ${minutes} minutes (renewed by itself).`};
}
const pickData = data => Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !["error", "code"].includes(key)));

async function loginInBrowser(ctx) {
  const o = ctx.flags;
  let got;
  try {
    got = await browserLogin(ctx.client, {name: typeof o.name === "string" ? o.name : undefined, admin: !!o.admin, timeout: o.timeout ?? 300,
      // With --json one JSON line (a program may show it while 203c waits; the answer or the error comes after it).
      say: (url, {opened = true} = {}) => process.stderr.write(ctx.json
        ? JSON.stringify({status: "waiting", via: "browser", opened, authorize_url: url, todo: opened ? "The user approves 203c in the browser that opened (signing in to the site first if it asks)"
          : "No browser could be opened: give the user authorize_url, or stop and use login --no-browser (a code) or login --with-token"}) + "\n"
        : opened
        ? `Opening the browser to approve 203c on the site. If it does not open, visit:\n  ${url}\n`
        : `No browser could be opened: visit the link above, or stop and run ${ctx.run(["login", "--with-token"], {json: false})} (a personal token) or ` +
          `${ctx.run(["login", "--no-browser"], {json: false})} (a code to approve).\n`)});
  } catch (error) {
    if (error instanceof ApiError && ["access_denied", "expired"].includes(error.code)) {
      throw new CliError(error.code === "expired" ? "expired" : "forbidden", error.message,
        {exit: EXIT.signin, hint: "Start again; where no browser can be opened (SSH, a remote agent) sign in with a personal token (login --with-token) or a code (login --no-browser)",
          next: [ctx.run(["login"]), ctx.run(["login", "--no-browser"])]});
    }
    throw error;
  }
  const file = saveToken(got.token);
  if (!ctx.json) process.stderr.write(`Signed in as ${got.user.name}; the token is in ${file}\n`);
  return {json: {status: "signed_in", via: "browser", user: got.user, scopes: got.scopes, saved: file},
    text: `Signed in as ${got.user.name} (${got.user.id}); scopes ${got.scopes.join(", ")}.`};
}

// A personal token (as gh auth login --with-token): from --token, else stdin (piped, or pasted hidden on a
// terminal); its format, then GET /me with it; then saved (mode 600). The token itself is never printed.
async function loginWithToken(ctx) {
  const o = ctx.flags;
  const tokensPage = siteOf(ctx.api) + "/me/tokens";
  const makeOne = `make one on the site: 设置 › 个人令牌 (${tokensPage})`;
  if (o.with_token && ctx.tokenSource === "flag") {
    throw ctx.usage("--with-token reads the token from stdin and --token gives it on the command line: use one of them",
      {hint: `Pipe it in: ${ctx.run(["login", "--with-token"], {json: false})} < token.txt`});
  }
  const apart = TOKEN_FLAGS_APART.filter(flag => o[keyOf(flag)] !== undefined && o[keyOf(flag)] !== false);
  if (apart.length) {
    throw ctx.usage(`${apart.map(f => "--" + f).join(", ")} ${apart.length > 1 ? "do" : "does"} not go with a personal token`, {
      hint: "A personal token was named and given its scopes when it was made on the site; login only checks it and saves it"});
  }
  const token = (ctx.tokenSource === "flag" ? String(ctx.client.token ?? "") : await readToken(ctx, makeOne)).trim();
  if (!/^cct_[a-f0-9]{64}$/.test(token)) {
    const looks = /^ccd_/.test(token) ? "like a device's token (ccd_…)" : /^cms_/.test(token) ? "like a website session (cms_…)" : /^cct_/i.test(token) ? "cut short or changed" : null;
    throw new CliError("invalid_token", `That is not a personal token${looks ? `: it looks ${looks}` : ""} (a personal token is cct_ and 64 hex digits; ${token.length} characters came)`,
      {exit: EXIT.signin, hint: `Copy the whole token, or ${makeOne}; or sign in in the browser (login)`, next: [ctx.run(["login"])]});
  }
  let account;
  try { account = await new Client({api: ctx.api, token, lang: ctx.client.lang}).get("/me"); }
  catch (error) {
    if (error instanceof ApiError && error.code === "signin_required") {
      throw new CliError("signin_required", "The site does not take this token: it was deleted or revoked, or it is mistyped", {exit: EXIT.signin,
        hint: `${makeOne[0].toUpperCase() + makeOne.slice(1)}, then run login --with-token again; or sign in in the browser (login)`,
        next: [ctx.run(["login"]), ctx.run(["login", "--no-browser"])], data: {url: tokensPage}});
    }
    throw error;
  }
  const before = (() => { try { return fs.readFileSync(tokenFile(), "utf8").trim(); } catch { return null; } })();
  const file = saveToken(token);
  try { fs.unlinkSync(pendingFile()); } catch { /* none */ }
  if (!ctx.json) process.stderr.write(`Signed in as ${account.name}; the token is in ${file}\n`);
  if (before && before !== token) ctx.note(`it replaces the token saved before (that one works until it is deleted on the site: 设置 › 个人令牌, ${tokensPage})`);
  if (process.env.COMMUNITY_TOKEN && process.env.COMMUNITY_TOKEN.trim() !== token) ctx.note("COMMUNITY_TOKEN is set and comes first: unset it to use the saved token");
  const scopes = account.scopes ?? [];
  return {json: {status: "signed_in", via: "token", user: {id: account.id, name: account.name}, scopes, saved: file, ...(ctx.notes.length ? {notes: ctx.notes} : {})},
    text: `Signed in as ${account.name} (${account.id}); scopes ${scopes.join(", ")}.`};
}

// The token from stdin: piped (read to the end; nothing within --timeout seconds, default 60, is an
// error), or typed / pasted on a terminal without echo.
async function readToken(ctx, makeOne) {
  const piped = `${ctx.run(["login", "--with-token"], {json: false})} < token.txt`;
  if (process.stdin.isTTY) {
    if (ctx.flags.no_input) throw ctx.usage("--no-input: 203c may not ask for the token", {hint: `Pipe it in: ${piped}`});
    return await readHidden(TOKEN_PROMPT);
  }
  const seconds = ctx.flags.timeout ?? 60;
  const text = await new Promise((resolve, reject) => {
    let got = "";
    const timer = setTimeout(() => reject(ctx.usage(`No token came on stdin within ${seconds} seconds`, {hint: `Pipe a personal token in (${makeOne}): ${piped}`})), seconds * 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      got += chunk;
      if (got.length > 4096) { clearTimeout(timer); process.stdin.pause(); resolve(got); }
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(got); });
    process.stdin.on("error", error => { clearTimeout(timer); reject(error); });
  });
  if (!text.trim()) throw ctx.usage("No token came on stdin", {hint: `Pipe a personal token in (${makeOne}): ${piped}`});
  return text;
}

// A line typed on the terminal without echo (raw mode): Enter ends it, Backspace erases, Ctrl-C stops 203c.
function readHidden(prompt) {
  return new Promise(resolve => {
    const input = process.stdin;
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    let text = "";
    const finish = value => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = chunk => {
      // A paste in bracketed-paste mode comes wrapped in ESC [200~ … ESC [201~.
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") return finish(text);
        if (ch === "\x03") { input.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\x7f" || ch === "\b") text = text.slice(0, -1);
        else if (ch >= " ") text += ch;
      }
    };
    input.on("data", onData);
  });
}

// ---------------------------------------------------------------------------------------------

async function main(argv) {
  const json = argv.some(token => /^--?json(=true|=1)?$/i.test(token));
  const notes = [];
  const prog = program();
  const base = {prog, json, notes};
  const words = parse(argv).words;
  const wantsHelp = argv.some(t => ["--help", "-h"].includes(t));
  const bare = !words.length || (words[0] === "help" && words.length === 1);
  if (words[0] === "help" && argv.includes("--reference")) { process.stdout.write(referenceMarkdown()); return EXIT.ok; }
  // Help is JSON too with --json (helpJson): an agent reads the commands, flags and examples as data.
  const out = value => { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); return EXIT.ok; };
  if (bare) {
    if (argv.includes("--version")) return json ? out({cli: CLI_VERSION}) : (process.stdout.write(CLI_VERSION + "\n"), EXIT.ok);
    if (json) return out(helpJson(prog));
    process.stdout.write(mainHelp(prog) + "\n");
    return EXIT.ok;
  }
  if (words[0] === "help") {
    const topic = String(words[1]).toLowerCase();
    if (TOPICS[topic]) return json ? out({topic, title: TOPICS[topic].title, text: topicText(topic, prog)}) : (process.stdout.write(topicText(topic, prog)), EXIT.ok);
    const found = findCommand(words.slice(1).map(w => String(w).toLowerCase()));
    if (found) return json ? out(commandJson(found.command, prog)) : (process.stdout.write(commandHelp(found.command, prog) + "\n"), EXIT.ok);
    const group = String(words[1]).toLowerCase();
    if (GROUPS.includes(group)) return json ? out(groupJson(group, prog)) : (process.stdout.write(groupHelp(group, prog)), EXIT.ok);
    const guess = nearest(topic, [...Object.keys(TOPICS), ...COMMANDS.map(c => c.words[0])]);
    throw usage(`No help topic or command "${words.slice(1).join(" ")}"`, {hint: `Topics: ${Object.keys(TOPICS).join(", ")}`,
      next: [guess ? `${prog} help ${guess}${json ? " --json" : ""}` : `${prog} help start${json ? " --json" : ""}`]});
  }
  // A group alone (203c firmware) is answered with its short help: every action and what it does, nothing to look up.
  const bareGroup = words.length === 1 && !json && !GROUP_DEFAULT[String(words[0]).toLowerCase()];
  if ((wantsHelp || bareGroup) && GROUPS.includes(String(words[0]).toLowerCase()) && !findCommand(words.map(w => String(w).toLowerCase()))) {
    const group = String(words[0]).toLowerCase();
    if (json) return out(groupJson(group, prog));
    process.stdout.write(groupHelp(group, prog));
    return EXIT.ok;
  }
  const {command, used} = resolveCommand(words, argv, base);
  const parsed = parseFor(command, argv, used, base);
  if (parsed.help) {
    if (json) { process.stdout.write(JSON.stringify(commandJson(command, prog), null, 2) + "\n"); return EXIT.ok; }
    process.stdout.write(commandHelp(command, prog) + "\n");
    return EXIT.ok;
  }
  const {flags, order, positional} = parsed;
  const lang = typeof flags.lang === "string" ? flags.lang : undefined;
  const client = new Client({api: flags.api || undefined, token: typeof flags.token === "string" ? flags.token : undefined, ...(lang ? {lang} : {})});
  const tokenSource = typeof flags.token === "string" ? "flag" : process.env.COMMUNITY_TOKEN ? "env" : client.run ? "oidc" : client.token ? "file" : null;
  // The token travels only over https (plain http only to this machine, for a local dev stack).
  let apiUrl = null;
  try { apiUrl = new URL(client.api); } catch { apiUrl = null; }
  if (!apiUrl || !(apiUrl.protocol === "https:" || (apiUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname)))) {
    throw usage(`The API ${client.api} is not https`, {field: "api", hint: "The API is https (plain http only to localhost, for a local dev stack): --api https://… or unset COMMUNITY_API",
      next: [`${prog} doctor${json ? " --json" : ""}`]});
  }
  const interactive = !json && !flags.no_input && !!process.stdin.isTTY && !!process.stderr.isTTY && !process.env.CI;
  const globals = order.filter(o => ["api", "lang"].includes(o.name));
  const ctx = {
    client, json, interactive, prog, api: client.api, tokenSource, tokenFile: tokenFile(), cwd: process.cwd(), notes, command,
    words: command.words, flags, pendingLogin: readPending(client.api),
    say: text => { if (!json) process.stderr.write(text + "\n"); },
    // A long job's own output (a simulator version's build), as it comes; nothing with --json.
    progress: chunk => { if (!json) process.stderr.write(chunk); },
    note: text => { notes.push(text); if (!json) process.stderr.write("203c: " + text + "\n"); },
    usage: (message, extra = {}) => usage(message, {next: [`${prog} ${command.name} --help${json ? " --json" : ""}`], ...extra}),
    run: (words2, {json: asJson = json} = {}) => [prog, ...words2.map(quote), ...globals.map(g => `--${g.name} ${quote(g.value)}`), ...(asJson ? ["--json"] : [])].join(" "),
  };
  lastContext = ctx;
  // Notes made while parsing.
  if (!json) for (const n of notes) process.stderr.write("203c: " + n + "\n");
  ctx.args = bindArguments(command, positional, {...base, args: {}});
  ctx.cmd = (changes = {}, {json: asJson = json} = {}) => rebuild({...base, args: ctx.args}, command, order, positional, changes, {json: asJson});
  ctx.text = (key, {need, min, max} = {}) => {
    const fileKey = key + "_file";
    let value;
    if (typeof flags[fileKey] === "string") {
      const file = path.resolve(ctx.cwd, flags[fileKey]);
      if (!fs.existsSync(file)) {
        throw new CliError("file_not_found", `--${dashed(fileKey)} ${flags[fileKey]} does not exist (looked at ${file})`, {exit: EXIT.refused, field: dashed(fileKey),
          hint: /\s/.test(flags[fileKey]) ? `That looks like text, not a file: use --${dashed(key)} "…"` : "Paths are relative to the current folder",
          next: /\s/.test(flags[fileKey]) ? [ctx.cmd({remove: [fileKey], set: {[key]: flags[fileKey]}})] : []});
      }
      value = fs.readFileSync(file, "utf8");
    } else if (typeof flags[key] === "string") {
      value = flags[key];
      if (value.startsWith("@") && fs.existsSync(path.resolve(ctx.cwd, value.slice(1)))) value = fs.readFileSync(path.resolve(ctx.cwd, value.slice(1)), "utf8");
      else if (!value.includes("\n") && value.includes("\\n")) value = value.replace(/\\n/g, "\n");
    }
    if (value !== undefined && isPlaceholder(value)) {
      throw new CliError("placeholder", `--${dashed(key)} "${value.trim().slice(0, 60)}" is a placeholder from an example, not a real value`, {exit: EXIT.usage, field: dashed(key),
        hint: "Write the real text (ask the user if you do not know it)"});
    }
    if (need && (value === undefined || !value.trim())) {
      throw ctx.usage(`Missing --${dashed(key)} (or --${dashed(fileKey)} PATH)`, {field: dashed(key), hint: `${command.flags[dashed(key)]?.help ?? ""}; e.g. --${dashed(key)} "…"`});
    }
    if (value !== undefined && ((min && value.trim().length < min) || (max && value.length > max))) {
      throw new CliError("invalid", `--${dashed(key)} is ${value.trim().length} characters: ${min ?? 1}-${max}`, {exit: EXIT.usage, field: dashed(key),
        hint: min && value.trim().length < min ? "Say more: what happens and why" : "Say it shorter"});
    }
    return value;
  };
  ctx.path = (key, {exists = true} = {}) => {
    const file = path.resolve(ctx.cwd, String(flags[key]));
    if (exists && !fs.existsSync(file)) throw new CliError("file_not_found", `--${dashed(key)} ${flags[key]} does not exist (looked at ${file})`, {field: dashed(key), hint: "Paths are relative to the current folder"});
    if (!exists && !fs.existsSync(path.dirname(file))) throw new CliError("file_not_found", `The folder of --${dashed(key)} ${flags[key]} does not exist (${path.dirname(file)})`, {field: dashed(key)});
    return file;
  };
  ctx.json = key => {
    try { return JSON.parse(flags[key]); } catch { throw ctx.usage(`--${dashed(key)} is JSON`, {field: dashed(key), hint: "Quote it for the shell: --" + dashed(key) + " '[{\"tag\":\"case\"}]'"}); }
  };
  ctx.op = async (name, args) => {
    const operation = opsByName[name];
    for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
    if (operation.write && !client.token) throw new ApiError(401, "signin_required", "Sign in first");
    const onStep = json ? undefined : step => process.stderr.write(`${step.status}${step.progress ? " " + step.progress + "%" : ""}\n`);
    return operation.run(client, args, {onStep});
  };
  ctx.ask = async question => {
    if (!interactive) return null;
    const rl = readline.createInterface({input: process.stdin, output: process.stderr});
    try { return await new Promise(resolve => rl.question(question + " ", resolve)); } finally { rl.close(); }
  };
  ctx.confirm = async question => /^y(es)?$/i.test((await ctx.ask(question + " [y/N]")) ?? "");
  ctx.choose = async (question, options) => {
    if (!interactive) return null;
    process.stderr.write(question + "\n" + options.map((option, i) => `  ${i + 1}. ${option}`).join("\n") + "\n");
    const answer = Number(await ctx.ask("Number:"));
    return Number.isInteger(answer) && answer >= 1 && answer <= options.length ? answer - 1 : null;
  };

  // Required flags.
  for (const flag of command.need ?? []) {
    if (flags[keyOf(flag)] === undefined && !(command.flags[flag + "-file"] && flags[keyOf(flag) + "_file"] !== undefined)) {
      throw ctx.usage(`Missing --${flag} for "${command.name}"`, {field: flag, hint: `${command.flags[flag]?.help ?? ""}; e.g. --${flag} ${exampleValue(flag, command.flags[flag] ?? {})}. Example: ${prog} ${command.examples[0] ?? command.usage}`});
    }
  }
  if (flags.tags !== undefined && Array.isArray(flags.tags)) {
    const max = {firmware: 8, posts: 5, works: 5}[command.words[0]] ?? 8;
    const tags = normalizeTags(flags.tags, max);
    if (tags.error) throw new CliError("invalid", tags.error, {exit: EXIT.usage, field: "tags", hint: tags.hint,
      next: tags.fixed ? [ctx.cmd({set: {tags: tags.fixed.join(",")}})] : []});
    flags.tags = tags.tags;
  }
  // Things that cannot be undone ask first.
  if (command.confirm && !flags.yes) {
    const what = `${command.name} ${Object.values(ctx.args).join(" ")}`.trim();
    if (!(interactive && await ctx.confirm(`This cannot be undone: ${what}. Go on?`))) {
      throw new CliError("needs_confirmation", `"${what}" cannot be undone: it needs --yes`, {exit: EXIT.confirm, hint: "Add --yes only if the user asked for it", next: [ctx.cmd({add: {yes: true}})]});
    }
  }
  // 203c is used signed in (the user, 2026-11-14): every command but signing in, help, version, doctor and
  // the offline rules and spec needs a sign-in (COMMUNITY.md "Credentials"); but what goes over a USB cable (flash,
  // devices recover: `anyone`) needs none (the user, 2026-11-18: signing in is for Wi-Fi).
  // On a person's own terminal the sign-in starts by itself, once on a computer (the browser asks them to approve 203c), and
  // the command goes on (the user, 2026-11-18: "尽可能要去用户登录cli"). A program (--json, no terminal, CI) gets exit 4.
  if (!command.offline && !command.anyone && !client.token && interactive && tokenSource === null && !browserProblem()) {
    process.stderr.write(`"${command.name}" needs a sign-in, and this computer has none yet: signing in first (once)…\n`);
    await login({...ctx, flags: {}, json: false});
    client.token = loadToken(client.api);
  }
  if (!command.offline && !command.anyone && !client.token) {
    throw new CliError("signin_required", `"${command.name}" needs a sign-in: 203c is used signed in`, {exit: EXIT.signin,
      hint: "Sign in: login opens the browser and the user approves on the site (no browser here: login --with-token, a personal token on stdin; or login --no-browser, a code to approve). " +
        "In GitHub Actions: login --github-oidc --firmware CODE (trusted publishing: the repository linked on the firmware's page, permissions: id-token: write; no secret).",
      next: [ctx.run(["login"]), ctx.run(["login", "--no-browser"])]});
  }
  if (command.webOnly) {
    const site = siteOf(client.api);
    throw new CliError("web_only", `"${command.name}" is done on the website (signed in there): ${command.webOnly.why}`, {exit: EXIT.refused,
      hint: `Personal tokens, bind codes and devices are managed only on the website, so a token that leaks cannot make or remove them. Ask the user to open ${site}${command.webOnly.page}`,
      next: [], data: {url: site + command.webOnly.page}});
  }

  let result;
  if (command.custom === "login") result = await login(ctx);
  else if (command.custom === "logout") {
    // The token revokes itself on the server (POST /auth/logout), then the file goes; offline, the file
    // goes and the token stays listed on the site until revoked there.
    let revoked = false, offline = false;
    if (client.token && tokenSource !== "env") {
      // (Not renewed to be revoked: a run's credential that ended is gone anyway.)
      client.run = null;
      try { revoked = (await client.post("/auth/logout")).status === "revoked"; }
      catch (error) { offline = !(error instanceof ApiError) || error.status === 0 || error.status >= 500; }
    }
    const removed = tokenSource === "env" ? false : tokenSource === "oidc" ? forgetRunCredential() : forgetToken();
    try { fs.unlinkSync(pendingFile()); } catch { /* none */ }
    const where = "the site: 设置 › 个人令牌 (/me/tokens)";
    result = {json: {status: revoked ? "revoked" : removed ? "signed_out" : "no_token", revoked, removed,
        note: revoked ? "The token was revoked on the server and removed here." : tokenSource === "env" ? "COMMUNITY_TOKEN is set: unset it (203c never revokes a CI token; revoke it on " + where + ")"
          : offline ? "Removed here; the server could not be reached: revoke it on " + where : "Nothing was saved here."},
      text: revoked ? "Signed out: the token was revoked and removed." : tokenSource === "env" ? "COMMUNITY_TOKEN is set: unset it (revoke it on " + where + ")."
        : removed ? `Signed out here${offline ? " (the server could not be reached: revoke the token on " + where + ")" : ""}.` : "There was no saved token."};
  }
  else if (command.custom === "rules") {
    result = await rules(ctx);
  } else if (command.custom === "ops") {
    process.stdout.write(JSON.stringify(OPS.map(({name, description, inputSchema}) => ({name, description, inputSchema})), null, 2) + "\n");
    return EXIT.ok;
  } else if (command.run) {
    result = await command.run(ctx);
    if (result !== undefined && (result === null || typeof result !== "object" || !("json" in result))) result = {json: result, text: human(command.name, result)};
  }
  else {
    const name = typeof command.op === "function" ? command.op(ctx) : command.op;
    let value;
    try { value = await ctx.op(name, command.args ? command.args(ctx) : {}); }
    catch (error) {
      // Deleting what is deleted already (a run again): done, not an error.
      if (!(error instanceof ApiError && error.code === "deleted" && command.words.at(-1) === "delete")) throw error;
      value = {status: "already_deleted", note: error.message};
    }
    result = {json: value, text: value?.status === "already_deleted" ? `Already deleted: ${value.note}` : human(name, value)};
  }
  if (result === undefined) return EXIT.ok;
  process.stdout.write((json ? JSON.stringify(result.json, null, 2) : result.text ?? human(command.name, result.json)) + "\n");
  return result.exit ?? EXIT.ok;
}

// The error: one JSON line on stderr with --json, else readable lines; the exit code says what kind.
function report(error, argv) {
  const json = argv.some(token => /^--?json(=true|=1)?$/i.test(token));
  const prog = program();
  let out;
  if (error instanceof CliError) {
    out = {error: error.message, code: error.code, ...(error.field ? {field: error.field} : {}), ...(error.hint ? {hint: error.hint} : {}), next: error.next, exit: error.exit,
      ...(error.status ? {status: error.status} : {}), ...error.data};
  } else if (error instanceof ApiError) {
    const ctx = lastContext ?? {};
    const explained = explainApiError(error, {...ctx, api: ctx.api ?? process.env.COMMUNITY_API ?? DEFAULT_API, words: ctx.words ?? [],
      run: ctx.run ?? (words => [prog, ...words, ...(json ? ["--json"] : [])].join(" ")), cmd: ctx.cmd ?? (() => [prog, ...argv.map(quote)].join(" ")),
      tokenSource: ctx.tokenSource, tokenFile: tokenFile(), topic: ctx.command?.topic});
    const {data = {}} = error;
    const extra = Object.fromEntries(Object.entries(data).filter(([key]) => !["error", "code"].includes(key)));
    out = {error: error.message, code: explained.code, ...(explained.field ? {field: explained.field} : {}), ...(explained.hint ? {hint: explained.hint} : {}),
      next: explained.next.filter(Boolean), exit: explained.exit, ...(error.status ? {status: error.status} : {}), ...extra};
  } else {
    out = {error: String(error?.message ?? error), code: "internal", hint: "A bug in 203c: please send this message with the command (feedback --kind bug)", next: [], exit: EXIT.later,
      ...(process.env.DEBUG_203C ? {stack: error?.stack} : {})};
  }
  if (lastContext?.notes?.length) out.notes = lastContext.notes;
  if (json) process.stderr.write(JSON.stringify(out) + "\n");
  else {
    const lines = [`203c: ${out.error}${out.code && !["usage", "internal"].includes(out.code) ? ` (${out.code})` : ""}`];
    if (out.hint) lines.push(`  ${out.hint}`);
    for (const p of out.problems ?? []) if (p.error !== out.error) lines.push(`  also: ${p.error}${p.hint ? " — " + p.hint : ""}`);
    if (out.log_tail) lines.push("  Last lines of the boot log:", ...out.log_tail.split("\n").map(l => "    " + l));
    if (out.build_log) lines.push("  Last lines of the build:", ...out.build_log.split("\n").map(l => "    " + l));
    if (out.unsupported?.length || out.headers?.length || out.sources?.length) lines.push("  Not CardenzaHAL: " + [...(out.unsupported ?? []), ...(out.headers ?? []), ...(out.sources ?? [])].join(", "));
    if (out.next?.length) lines.push(`  next: ${out.next[0]}`, ...out.next.slice(1).map(n => `        ${n}`));
    process.stderr.write(lines.join("\n") + "\n");
  }
  return out.exit;
}

// The context of the command being run, to explain the API's refusals in its terms.
let lastContext = null;
const argv = process.argv.slice(2);
// Exit once stdout and stderr have written everything: to a pipe they are asynchronous on macOS, and exiting at once
// cut long answers short there (--help --json read by an agent).
const exitAfterOutput = code => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
main(argv).then(code => exitAfterOutput(code ?? 0), error => exitAfterOutput(report(error, argv)));
