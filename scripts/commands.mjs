// Every 203c command: its words, arguments, flags (with help), examples, and what it runs (an API
// operation of lib.mjs, or a function of publish.mjs). The parser, --help, unknown-flag suggestions and
// reference/cli.md all come from this table. Part of the Agent Skill skill/203-community.
import {doctor, publish, createFirmware, editFirmware, setCover, checklist, dryRunUpload, init, forkFirmware, cloneFirmware, editMe,
  simBuild, simUpload, simCheck, basedOn, sourceUpload, sourceCheck} from "./publish.mjs";
import {CHANNELS, ENGINES, LICENSES} from "./checks.mjs";
import {recoverDevice} from "./recover.mjs";
import {flashDevice} from "./flash.mjs";
import {deviceLog} from "./devlog.mjs";
import {newProject} from "./scaffold.mjs";
import {inbox, link} from "./feedback.mjs";
import {skillInstall} from "./skill.mjs";
import path from "node:path";

const B = help => ({bool: true, help});
const V = (value, help, extra = {}) => ({value, help, ...extra});
const PAGE = {page: V("N", "Page, from 1 (24 a page)", {type: "int"})};
const SECTION = {...PAGE, cursor: V("C", "The previous answer's next_cursor (the next page)"), limit: V("N", "Items a page, 1-60", {type: "int"})};
const SORT = choices => ({sort: V(choices.join("|"), "Order", {choices})});
const YES = {yes: B("Yes, do it (it cannot be undone)")};
const DRY = {"dry-run": B("Check everything (files, values, permissions) and print the plan; change nothing")};
const FORCE = {force: B("Go on despite a quality warning (only when that is really meant)")};
const FIRMWARE_FIELDS = {
  name: V("NAME", "The firmware's name, 1-64 characters"),
  summary: V("TEXT", "The cover blurb, 1-100 characters: what it does (not just the name)"),
  description: V("TEXT", "The page text (Markdown)"), "description-file": V("PATH", "The page text from a Markdown file"),
  tags: V("a,b", "Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game", {type: "list"}),
  "source-url": V("URL", "https link to the source (e.g. the GitHub repository)"), "clone-url": V("URL", "https://….git for git clone"),
  license: V("SPDX", "The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary"),
  private: B("Only people with the code and the password see it"), password: V("P", "The download password of a private firmware (8-64 characters)", {secret: true}),
  beta: B("Switch the beta channel on"), dev: B("Switch the dev channel on"),
  cover: V("IMAGE", "A cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB)"),
};
const PUBLISH_FLAGS = {
  version: V("V", "The version label (1.4.0; no leading v). Default: the BIN's own version"),
  channel: V("stable|beta|dev", "The channel (default stable; CI builds go to dev)", {choices: CHANNELS}),
  bin: V("[TARGET=]PATH", "The application image for a device (repeat for several devices; TARGET defaults to cardenza); a download-only device takes its .uf2 file (mystrix=MatrixOS-Mystrix1.uf2, mystrix2=MatrixOS-Mystrix2.uf2)", {repeat: true}),
  notes: V("TEXT", "Release notes (Markdown); @FILE reads a file"), "notes-file": V("PATH", "Release notes from a file (CHANGELOG.md: the entry of this version)"),
  commit: V("SHA", "The commit it was built from (7-40 hex, or a git ref like HEAD)"), "source-url": V("URL", "A link to this version's source"),
  notices: V("PATH", "NOTICES.txt (third-party licences, ≤ 1 MB)"),
  "no-wait": B("Do not wait for the checks (answers status checking)"), timeout: V("SECONDS", "How long to wait for the checks (default 1200)", {type: "number"}),
  poll: V("SECONDS", "How often to ask while it is checked (default 5)", {type: "number"}),
  "no-sim": B("No simulator version (no Play): do not build or upload one"),
  "sim-dir": V("PATH", "Upload this built simulator version (cardenza_web.py's output folder, with sim.json) instead of building it"),
  hal: V("DIR", "The CardenzaHAL checkout (with its web target) that builds the simulator version (default: the project's own, else a cached clone)"),
  project: V("DIR", "The firmware's ESP-IDF project, for its simulator version (default: found from the BIN and here)"),
  "no-source": B("Do not attach the source archive (even when 203.json says publish_source)"),
  "without-cover": B("Publish a stable version although the firmware has no cover at all (no picture, none from its original, no screen after boot, no web build with it): only when the user wants none (else cover_required)"),
  source: B("Attach a source archive of the commit (git archive of the tracked files, checked for secrets), as publish_source: true does"),
  ...DRY, ...FORCE, yes: B("Yes to what needs it (turn a channel on, a name someone else uses, no simulator version when it cannot be built)"),
};

export const GLOBAL_FLAGS = {
  json: B("Print the answer as JSON (errors: one JSON line on stderr). Always use it from a program or agent"),
  lang: V("zh|en", "Language of what the server writes (errors, names)", {choices: ["zh", "en"]}),
  api: V("URL", "The API (default https://cardenza.203.io/community/api; or COMMUNITY_API)"),
  token: V("TOKEN", "An access token (else COMMUNITY_TOKEN, else the saved one)", {secret: true}),
  "no-input": B("Never ask questions (also when not on a terminal)"),
  help: B("This command's help"),
};

export const COMMANDS = [];
function cmd(usage, summary, spec = {}) {
  const words = [], params = [];
  for (const token of usage.split(" ")) {
    const optional = token.startsWith("[");
    const name = token.replace(/[[\]]/g, "");
    if (/^[a-z][a-z-]*$/.test(name) && !params.length) words.push(name);
    else params.push({name: name.replace("...", ""), optional, variadic: name.endsWith("..."),
      type: /^V?CODE$|^FORK$|^PARENT$/.test(name) ? "code" : /^(N|VOTE|DEVICE|COMMENT|NUMBER)$/.test(name.replace("...", "")) ? "int" : "text"});
  }
  COMMANDS.push({usage, summary, words, name: words.join(" "), params, flags: spec.flags ?? {}, examples: spec.examples ?? [], ...spec});
}

// ---------------------------------------------------------------------------------------------
// Start, signing in

cmd("doctor", "Check everything 203c needs: Node, the API, the sign-in (kind, scopes), what is left today", {group: "Start", offline: true,
  run: doctor, examples: ["doctor --json"]});
cmd("login", "Sign in: opens the browser, the user approves on the site and it comes back (no browser here: --with-token, a personal token; or --no-browser, a code approved on /activate, then login --wait; in GitHub Actions: --github-oidc --firmware CODE, no secret)",
  {group: "Start", offline: true,
  flags: {name: V("NAME", "What this sign-in is called in the site's Personal tokens list (设置 › 个人令牌)"),
    "with-token": B("Sign in with a personal token made on the site (设置 › 个人令牌, /me/tokens): read from stdin, or asked for on a terminal (not shown); --token TOKEN gives it directly"),
    "no-browser": B("Sign in with a code instead (SSH, CI, a remote agent; also chosen by itself when no browser can be opened)"),
    admin: B("Ask for the admin scope too (admins; the page lets them tick it)"),
    wait: B("With a code: wait for the approval and save the token"),
    "no-wait": B("With a code: only print the link and code (the default when not on a terminal)"),
    timeout: V("SECONDS", "How long it waits (browser default 300, code default 600, a token on stdin 60)", {type: "number"}),
    "github-oidc": B("Trusted publishing in GitHub Actions (permissions: id-token: write): the job's OIDC token for a 15-minute credential that publishes --firmware's versions; kept for this run only, renewed by itself; repeatable"),
    firmware: V("CODE", "With --github-oidc: the firmware whose trusted publisher this repository is (default: 203.json's code)")},
  custom: "login", topic: "ci", examples: ["login", "login --json", "login --with-token < token.txt", "login --no-browser --json", "login --wait --json",
    "login --github-oidc --firmware K7M2QX --json"]});
cmd("logout", "Sign out: revokes this token on the server and forgets it here (in GitHub Actions: the run's trusted-publishing credential)", {group: "Start", offline: true, custom: "logout", examples: ["logout", "logout --json"]});
cmd("whoami", "The signed-in account and this sign-in: its kind (cli or ci), name and scopes", {group: "Start", op: "whoami", examples: ["whoami --json"]});
cmd("quotas", "What is left of every limit (firmware, versions today, works, models, …)", {group: "Start", op: "quotas", examples: ["quotas --json"]});
cmd("help [TOPIC]", "Recipes: help start, publish, ci, manifest, fork, source, checks, page, errors …; or help COMMAND", {group: "Start", offline: true, custom: "help", examples: ["help publish", "help errors"]});
cmd("rules", "The firmware project rules (CardenzaHAL's FIRMWARE-PROJECT.md): dependencies, files, HAL rules, builds, checks, publishing; --online for the newest", {group: "Start",
  offline: true, flags: {online: B("Fetch the newest copy from the site (/develop.md) instead of the one in the skill")}, custom: "rules", examples: ["rules", "rules --online"]});
cmd("init", "Write 203.json (the project file) from what the project says: CMake project(), version.txt or the git tag, you, the git remote, LICENSE", {group: "Start",
  flags: {firmware: V("CODE", "This firmware's code, when it is published already"), name: V("NAME", "Its name (default: CMake's project())"), bin: PUBLISH_FLAGS.bin,
    summary: FIRMWARE_FIELDS.summary, channel: PUBLISH_FLAGS.channel, license: FIRMWARE_FIELDS.license, tags: FIRMWARE_FIELDS.tags,
    "publish-source": B("Attach a source archive to every version (publish_source: true)"), force: B("Overwrite an existing 203.json")},
  run: init, topic: "manifest", examples: ['init --summary "A four-track groovebox" --json', 'init --name "My synth" --bin build/my_synth.bin --publish-source --json']});

cmd("skill install", "Put the Agent Skill (SKILL.md, the guides, this 203c) into the coding agents' skills folders: Claude Code's ~/.claude/skills (CLAUDE_SKILLS_DIR), Codex's ~/.codex/skills when it is there; run it after npm install -g 203c and after every update", {group: "Start",
  offline: true, flags: {dir: V("DIR", "Install into this skills folder only (it gets 203-community/)"), ...DRY},
  run: skillInstall, topic: "start", examples: ["skill install", "skill install --dry-run --json", "skill install --dir ~/.agents/skills"]});
cmd("new NAME [DIR]", "Start a firmware project: CardenzaHAL as a git submodule and its template, named NAME, with 203.json, the README and the release workflow; it builds as it is (no sign-in)", {group: "Start",
  anyone: true, flags: {summary: FIRMWARE_FIELDS.summary, tags: FIRMWARE_FIELDS.tags, device: V("DEVICE", "The device (default cardenza, the only one with a template so far)"),
    project: V("ID", "CMake's project() name, the BIN's name (default from NAME: \"Pocket Metronome\" → pocket_metronome)"), ...DRY},
  run: newProject, topic: "new", examples: ['new "Pocket Metronome" --summary "A metronome with tap tempo and accents" --json', "new Metronome metronome --dry-run --json"]});

// ---------------------------------------------------------------------------------------------
// Publishing

cmd("publish", "Publish a firmware version in one go: makes the firmware if needed, uploads, waits for the checks; safe to run again", {group: "Publishing",
  flags: {firmware: V("CODE", "Your firmware's code (or its exact name)"), name: FIRMWARE_FIELDS.name, ...PUBLISH_FLAGS, "source-url": FIRMWARE_FIELDS["source-url"],
    summary: FIRMWARE_FIELDS.summary, description: FIRMWARE_FIELDS.description, "description-file": FIRMWARE_FIELDS["description-file"],
    tags: FIRMWARE_FIELDS.tags, cover: FIRMWARE_FIELDS.cover, "clone-url": FIRMWARE_FIELDS["clone-url"],
    private: FIRMWARE_FIELDS.private, password: FIRMWARE_FIELDS.password, launcher: B("A new firmware is a launcher (merged full-flash images)"),
    license: FIRMWARE_FIELDS.license, manifest: V("PATH", "The project file (default: 203.json here or above, else 203c.json)")},
  run: ctx => publish(ctx, {mode: "publish"}), write: true, topic: "publish",
  examples: ['publish --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --bin build/my-synth.bin --notes-file CHANGELOG.md --dry-run --json',
    "publish --firmware K7M2QX --bin build/my-synth.bin --json", 'publish --firmware K7M2QX --channel dev --version "dev.$(date +%Y%m%d%H%M)" --bin build/my-synth.bin --json']});
cmd("versions publish CODE", "Publish a version of your firmware CODE (the same checks as publish; never makes a firmware)", {group: "Publishing",
  flags: PUBLISH_FLAGS, run: ctx => publish(ctx, {mode: "versions"}), write: true, topic: "publish",
  examples: ["versions publish K7M2QX --version 1.4.0 --bin cardenza=build/app.bin --notes-file CHANGES.md --dry-run --json"]});
cmd("firmware create", "Make a firmware (its page); publish versions to it with publish", {group: "Publishing",
  flags: {...FIRMWARE_FIELDS, fork: V("CODE", "Fork this firmware or version"), launcher: B("A launcher (merged full-flash images)"), ...DRY, ...FORCE,
    yes: B("Make it even when someone else's firmware has this name")},
  run: createFirmware, write: true, topic: "page",
  examples: ['firmware create --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --tags groovebox --source-url https://github.com/me/my-synth --json']});
cmd("firmware edit CODE", "Change a firmware's page or settings (only the fields given)", {group: "Publishing",
  flags: {...FIRMWARE_FIELDS, public: B("Make a private firmware public (drops the password)"), "no-beta": B("Switch the beta channel off"),
    "no-dev": B("Switch the dev channel off"), ...DRY, ...FORCE},
  run: editFirmware, write: true, topic: "page",
  examples: ['firmware edit K7M2QX --summary "Four-track groovebox: drums, Juno, DX7, sampler" --json', "firmware edit K7M2QX --dev --json"]});
cmd("firmware cover CODE [IMAGE]", "Set a firmware's cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB); --remove takes it away", {group: "Publishing",
  flags: {file: V("IMAGE", "The picture (the same as IMAGE)"), remove: B("Remove the cover (a fork then shows its original's, else the screen after boot shows, else the grey default)"), ...DRY, ...YES}, run: setCover, write: true, topic: "cover",
  examples: ["firmware cover K7M2QX cover.png --json", "firmware cover K7M2QX --file cover.png --dry-run --json", "firmware cover K7M2QX --remove --yes --json"]});
cmd("firmware checklist CODE", "What a firmware's page has and lacks (cover, summary, description, links, notes), with the command for each", {group: "Publishing",
  run: checklist, topic: "page", examples: ["firmware checklist K7M2QX --json"]});
cmd("versions simulator CODE VCODE", "Upload a version's simulator version (the same as sim upload VCODE DIR)", {group: "Publishing",
  flags: {dir: V("PATH", "The folder of the web build"), "no-wait": B("Do not wait for its check"),
    timeout: V("SECONDS", "How long to wait for the checker (default 600: it runs every few minutes)", {type: "number"}), poll: V("SECONDS", "How often to ask (default 5)", {type: "number"}), ...DRY},
  need: ["dir"], write: true, topic: "sim",
  run: ctx => simUpload(ctx, {code: ctx.args.CODE, dir: ctx.flags.dir}),
  examples: ["versions simulator K7M2QX V3X9PA --dir build-web/site --json"]});

// ---------------------------------------------------------------------------------------------
// Simulator versions: the firmware built for the browser with CardenzaHAL's web target

const SIM_WAIT = {"no-wait": B("Do not wait for the checker"), timeout: V("SECONDS", "How long to wait for the checker (default 600: it runs every few minutes)", {type: "number"}),
  poll: V("SECONDS", "How often to ask (default 5)", {type: "number"})};
cmd("sim build [DIR]", "Build the simulator version of the firmware in DIR (default here) with CardenzaHAL's web target; prints where", {group: "Simulator",
  flags: {hal: PUBLISH_FLAGS.hal, out: V("DIR", "Where to write it (default <project>/build-web/site)"), debug: B("A debug build (larger, with symbols)"),
    jobs: V("N", "Parallel compile jobs", {type: "int"}), project: V("DIR", "The ESP-IDF project (the same as DIR)"), ...DRY},
  run: simBuild, topic: "sim", examples: ["sim build --json", "sim build firmware/ --hal ~/CardenzaHAL --json"]});
cmd("sim upload VCODE DIR", "Upload a built simulator version to a version of yours (only when it differs); the checker opens it, Play once it boots", {group: "Simulator",
  flags: {...SIM_WAIT, ...DRY}, write: true, run: ctx => simUpload(ctx), topic: "sim",
  examples: ["sim upload V3X9PA build-web/site --json", "sim upload V3X9PA build-web/site --dry-run --json"]});
cmd("sim check VCODE", "A version's simulator version: boots (Play), fails (why), or waiting for the checker; --again checks it again", {group: "Simulator",
  flags: {again: B("Ask the checker to open it again (owner or admin)"), ...SIM_WAIT}, run: simCheck, topic: "sim",
  examples: ["sim check V3X9PA --json", "sim check V3X9PA --again --json"]});

cmd("fork CODE [DIR]", "Fork a firmware to change it: makes your fork (or finds yours), clones its source into DIR and writes 203.json there (code, forked_from)", {group: "Publishing",
  flags: {name: V("NAME", "Your fork's name (default: the firmware's name and yours)"), summary: V("TEXT", "What your fork changes (default: a line saying it is a fork)"),
    private: FIRMWARE_FIELDS.private, password: FIRMWARE_FIELDS.password, new: B("Make another fork even when you have one of this firmware"),
    clone: V("DIR", "Clone its source into DIR (the same as DIR)"), "no-clone": B("Make the fork only; do not clone"), ...DRY},
  run: forkFirmware, write: true, topic: "fork",
  examples: ["fork V6QK28 my-synth --json", "fork K7M2QX --no-clone --json"]});
cmd("link [CODE]", "Bind this project (203.json) to its firmware, or move the binding after the repository moved: 203.json's code and source, the page's source link, and this GitHub repository as the trusted publisher its CI publishes with", {group: "Publishing",
  flags: {move: B("Also remove the trusted publishers of other repositories (the project left them)"), workflow: V("FILE", "The workflow that publishes (default firmware.yml when it is there)"),
    "no-ci": B("Leave the trusted publishers as they are"), ...DRY},
  run: link, write: true, topic: "link", examples: ["link --dry-run --json", "link K7M2QX --json", "link --move --json"]});
cmd("clone CODE [DIR]", "git clone a firmware's source (its clone link, else its parent's) into DIR; publish from inside goes to CODE", {group: "Publishing",
  flags: {...DRY}, run: cloneFirmware, topic: "fork", examples: ["clone K7M2QX my-synth --json"]});

// ---------------------------------------------------------------------------------------------
// Firmware and versions

cmd("firmware mine", "Your own firmware (private ones too), with their codes", {group: "Firmware", flags: PAGE, op: "my_things",
  args: ctx => ({what: "firmware", page: ctx.flags.page}), examples: ["firmware mine --json"]});
cmd("firmware list", "Public firmware of one device (official ones first)", {group: "Firmware",
  flags: {section: V("official|community|all", "Which ones", {choices: ["official", "community", "all"]}), official: B("Official firmware only"),
    q: V("WORDS", "Search words"), tag: V("TAG", "A category or tag"), target: V("DEVICE", "A device (default cardenza)"),
    kind: V("app|launcher", "Apps (default) or launchers", {choices: ["app", "launcher"]}), forks: B("Forks too (hidden by default)"),
    ...SORT(["new", "hot", "downloads", "likes"]), ...SECTION},
  op: "firmware_list", args: ctx => ({kind: ctx.flags.kind, section: ctx.flags.section, ...(ctx.flags.official ? {official: true} : {}), ...(ctx.flags.forks ? {forks: true} : {}), q: ctx.flags.q,
    tag: ctx.flags.tag, target: ctx.flags.target, sort: ctx.flags.sort, page: ctx.flags.page, cursor: ctx.flags.cursor, limit: ctx.flags.limit}),
  examples: ["firmware list --official --json", "firmware list --q synth --limit 10 --json"]});
cmd("firmware show CODE", "A firmware (a private one needs --unlock)", {group: "Firmware", flags: {unlock: V("TOKEN", "cfu_… from firmware unlock", {secret: true})},
  op: "firmware_show", args: ctx => ({code: ctx.args.CODE, unlock: ctx.flags.unlock}), examples: ["firmware show K7M2QX --json"]});
cmd("firmware fork CODE", "Fork a firmware (or a version) into a new firmware of yours", {group: "Firmware",
  flags: {name: FIRMWARE_FIELDS.name, summary: FIRMWARE_FIELDS.summary, description: FIRMWARE_FIELDS.description, "description-file": FIRMWARE_FIELDS["description-file"],
    private: FIRMWARE_FIELDS.private, password: FIRMWARE_FIELDS.password, ...DRY, ...FORCE, yes: B("Fork even when you have a firmware of this name")},
  need: ["name", "summary"], run: ctx => createFirmware(ctx, {fork: ctx.args.CODE}), write: true,
  examples: ['firmware fork K7M2QX --name "My synth" --summary "K7M2QX with a fifth track" --json']});
cmd("firmware delete CODE", "Delete a firmware (its forks stay)", {group: "Firmware", flags: YES, confirm: true, op: "firmware_delete",
  args: ctx => ({code: ctx.args.CODE}), examples: ["firmware delete K7M2QX --yes --json"]});
for (const [action, on] of [["like", true], ["unlike", false], ["favorite", true], ["unfavorite", false]]) {
  cmd(`firmware ${action} CODE`, `${action[0].toUpperCase() + action.slice(1)} a firmware`, {group: "Firmware",
    op: /like/.test(action) ? "firmware_like" : "firmware_favorite", args: ctx => ({code: ctx.args.CODE, on}), examples: [`firmware ${action} K7M2QX --json`]});
}
cmd("firmware tree CODE", "The fork tree around a firmware", {group: "Firmware", op: "firmware_tree", args: ctx => ({code: ctx.args.CODE}), examples: ["firmware tree K7M2QX --json"]});
// Trusted publishing (COMMUNITY.md "Trusted publishing"): the repositories whose GitHub Actions runs publish without a secret.
cmd("firmware publishers list CODE", "Trusted publishers of your firmware: the GitHub repositories (workflow, environment, channels, last use) whose Actions runs publish it without a secret",
  {group: "Publishing", op: "publishers_list", args: ctx => ({code: ctx.args.CODE}), topic: "ci", examples: ["firmware publishers list K7M2QX --json"]});
cmd("firmware publishers add CODE", "Link a trusted publisher: a GitHub repository whose Actions runs (that workflow, that environment) may publish CODE's versions (at most 5)",
  {group: "Publishing", flags: {repository: V("OWNER/NAME", "The GitHub repository (a github.com link is taken too)"),
    workflow: V("FILE", "The workflow's file in .github/workflows that publishes, e.g. firmware.yml (recommended: else any workflow of the repository)"),
    environment: V("NAME", "Only jobs in this GitHub environment (e.g. release, with its own protection rules)"),
    channels: V("stable,beta,dev", "The channels it may publish on (default all three; a run's ref limits them too: tags vX.Y.Z stable, vX.Y.Z-beta.N beta, else dev)", {type: "list"})},
  need: ["repository"], op: "publisher_add", write: true, topic: "ci",
  args: ctx => ({code: ctx.args.CODE, repository: ctx.flags.repository, workflow: ctx.flags.workflow, environment: ctx.flags.environment, channels: ctx.flags.channels}),
  examples: ["firmware publishers add K7M2QX --repository me/my-synth --workflow firmware.yml --json",
    "firmware publishers add K7M2QX --repository me/my-synth --workflow release.yml --environment release --channels stable,beta --json"]});
cmd("firmware publishers remove CODE ID", "Remove a trusted publisher (ID, or its OWNER/NAME when it is the only one of that repository): its runs' credentials stop working at once",
  {group: "Publishing", flags: YES, confirm: true, write: true, topic: "ci", run: async ctx => {
    let id = String(ctx.args.ID);
    if (!/^\d+$/.test(id)) {
      const items = (await ctx.op("publishers_list", {code: ctx.args.CODE})).items ?? [];
      const repo = id.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/(\.git)?\/*$/, "").toLowerCase();
      const hits = items.filter(p => p.repository.toLowerCase() === repo);
      if (hits.length !== 1) {
        throw ctx.usage(hits.length ? `${ctx.args.ID} is linked ${hits.length} times: give the publisher's id` : `No trusted publisher of ${ctx.args.CODE} is ${ctx.args.ID}`,
          {field: "ID", hint: items.length ? "Its publishers: " + items.map(p => `${p.id} ${p.repository}${p.workflow ? " " + p.workflow : ""}${p.environment ? " (" + p.environment + ")" : ""}`).join(", ") : "It has none"});
      }
      id = String(hits[0].id);
    }
    return await ctx.op("publisher_remove", {code: ctx.args.CODE, id: Number(id)});
  }, examples: ["firmware publishers remove K7M2QX 3 --yes --json", "firmware publishers remove K7M2QX me/my-synth --yes --json"]});
cmd("firmware lookup NAME...", "Firmware with exactly this name (ignoring case): yours first, any device, forks too", {group: "Firmware", op: "firmware_lookup",
  args: ctx => ({name: ctx.args.NAME.join(" ")}), examples: ['firmware lookup "My synth" --json']});
cmd("firmware based-on CODE ORIGIN", "Record what your firmware CODE was made from (ORIGIN: a firmware or version code; none: an original); 203.json follows", {group: "Firmware",
  flags: {version: V("LABEL", "The original's version it was made from (its label, e.g. 0.3.0)"), unlock: V("TOKEN", "cfu_… when the original is private", {secret: true}), ...DRY},
  run: basedOn, write: true, topic: "fork", examples: ["firmware based-on K7M2QX V6QK28 --version 0.3.0 --json", "firmware based-on K7M2QX none --json"]});
cmd("firmware unlock CODE", "Open a private firmware with its password: answers an unlock token for --unlock", {group: "Firmware",
  flags: {password: V("P", "The password", {secret: true})}, need: ["password"], op: "firmware_unlock",
  args: ctx => ({code: ctx.args.CODE, password: ctx.flags.password}), examples: ["firmware unlock K7M2QX --password 1234 --json"]});
cmd("firmware works CODE", "Works made with a firmware", {group: "Firmware", flags: {version: V("VCODE", "One version's works"), ...PAGE},
  op: "firmware_works", args: ctx => ({code: ctx.args.CODE, version: ctx.flags.version, page: ctx.flags.page}), examples: ["firmware works K7M2QX --json"]});
cmd("versions list CODE", "A firmware's versions, newest first (yours: drafts, checking and sent back too)", {group: "Firmware",
  flags: {channel: PUBLISH_FLAGS.channel, target: V("DEVICE", "Only versions with a BIN for this device (e.g. cardenza)"), ...PAGE}, op: "versions_list",
  args: ctx => ({code: ctx.args.CODE, channel: ctx.flags.channel, target: ctx.flags.target, page: ctx.flags.page}),
  examples: ["versions list K7M2QX --json", "versions list K7M2QX --channel beta --target cardenza --json"]});
cmd("versions label CODE LABEL", "A firmware's version by its label (1.4.0)", {group: "Firmware", op: "version_by_label",
  args: ctx => ({code: ctx.args.CODE, label: ctx.args.LABEL}), examples: ["versions label K7M2QX 1.4.0 --json"]});
cmd("versions show VCODE", "A version and its firmware", {group: "Firmware", op: "version_show", args: ctx => ({version_code: ctx.args.VCODE}),
  examples: ["versions show V3X9PA --json"]});
cmd("versions edit VCODE", "Change a version's release notes", {group: "Firmware", flags: {notes: PUBLISH_FLAGS.notes, "notes-file": PUBLISH_FLAGS["notes-file"]},
  op: "version_edit", write: true, args: ctx => ({version_code: ctx.args.VCODE, notes: ctx.text("notes", {need: true})}),
  examples: ['versions edit V3X9PA --notes "Fixes the arpeggiator at 1/32" --json']});
cmd("versions delete VCODE", "Delete a version (its code then answers deleted)", {group: "Firmware", flags: YES, confirm: true, op: "version_delete",
  args: ctx => ({version_code: ctx.args.VCODE}), examples: ["versions delete V3X9PA --yes --json"]});
cmd("versions check VCODE", "A version's status and check report (steps, boot log, appeal)", {group: "Firmware", op: "version_check",
  args: ctx => ({version_code: ctx.args.VCODE}), topic: "checks", examples: ["versions check V3X9PA --json"]});
cmd("versions appeal VCODE", "The checks were wrong (a false positive): say why, 10-2000 characters", {group: "Firmware",
  flags: {message: V("TEXT", "Why the check is wrong"), "message-file": V("PATH", "The message from a file")}, op: "version_appeal", write: true,
  args: ctx => ({version_code: ctx.args.VCODE, message: ctx.text("message", {need: true, min: 10, max: 2000})}), topic: "checks",
  examples: ['versions appeal V3X9PA --message "It panics only because QEMU has no touch controller; on the device it boots" --json']});
cmd("versions download VCODE", "A version's BIN for a device", {group: "Firmware",
  flags: {target: V("DEVICE", "The device, e.g. cardenza"), "accept-risk": B("Accept a third-party launcher's risk"), out: V("PATH", "Save it here")},
  need: ["target"], op: "version_download", args: ctx => ({version_code: ctx.args.VCODE, target: ctx.flags.target, ...(ctx.flags.accept_risk ? {accept_risk: true} : {}),
    ...(ctx.flags.out ? {out: ctx.path("out", {exists: false})} : {})}), examples: ["versions download V3X9PA --target cardenza --out app.bin --json"]});
cmd("builds identify [FILE]", "What a BIN is: its signature checked by the community (a downloaded BIN ends with it), else its SHA-256; the firmware, version, lineage, and whether a newer build is out", {group: "Firmware",
  flags: {sha256: V("HEX", "A file's SHA-256 instead of a file"), target: V("DEVICE", "The device (narrows a SHA-256 match)")}, op: "build_identify",
  args: ctx => ({...(ctx.args.FILE ? {file: path.resolve(ctx.cwd, String(ctx.args.FILE))} : {}), ...(ctx.flags.sha256 ? {sha256: ctx.flags.sha256} : {}),
    ...(ctx.flags.target ? {target: ctx.flags.target} : {})}),
  examples: ["builds identify app.bin --json", "builds identify --sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --json"]});

// ---------------------------------------------------------------------------------------------
// Sounds, projects, works, models

for (const [plural, kind] of [["sounds", "sound"], ["projects", "project"]]) {
  const sound = plural === "sounds";
  cmd(`${plural} upload FILE...`, sound ? "Share a sound pack (.ccpreset banks, .wav samples) for an official firmware"
    : "Share a project (one .ccproj and its .wav samples) for an official firmware", {group: "Sharing",
    flags: {firmware: V("CODE", "The official firmware's code (firmware list --official)"), title: V("TEXT", "1-80 characters"),
      ...(sound ? {engine: V(["dx7", "juno", "sampler", "drums", "mixed"].join("|"), "The engine (read from the banks when left out)", {choices: [...ENGINES, "mixed"]})}
        : {bpm: V("N", "30-300 (the file's tempo wins)", {type: "int"})}),
      version: V("VCODE", "A version code of that firmware"), preview: V("AUDIO", "A .wav, .mp3 or .ogg recording to listen to"),
      "preview-ms": V("MS", "The preview's length in ms", {type: "int"}), description: V("TEXT", "Markdown"), "description-file": V("PATH", "Markdown file"),
      tags: V("a,b", "Up to 8 tags", {type: "list"}), ...DRY},
    need: ["firmware", "title"], write: true, topic: plural,
    run: ctx => dryRunUpload(ctx, kind, {then: !ctx.flags.dry_run}),
    examples: [sound ? 'sounds upload pads.ccpreset pad-c3.wav --firmware 3YGNF5 --title "Warm pads" --tags pad --dry-run --json'
      : 'projects upload NIGHT.ccproj kick.wav --firmware 3YGNF5 --title "Night drive" --preview night.mp3 --dry-run --json']});
  cmd(`${plural} list`, `${sound ? "Sound packs" : "Projects"} (official firmware)`, {group: "Sharing",
    flags: {q: V("WORDS", "Search words"), tag: V("TAG", "A category or tag"), ...(sound ? {engine: V("ENGINE", "dx7, juno, sampler, drums or mixed")} : {}),
      firmware: V("CODE", "A firmware code"), ...SORT(["new", "hot", "downloads"]), ...SECTION},
    op: plural + "_list", args: ctx => ({q: ctx.flags.q, tag: ctx.flags.tag, engine: ctx.flags.engine, firmware: ctx.flags.firmware, sort: ctx.flags.sort,
      page: ctx.flags.page, cursor: ctx.flags.cursor, limit: ctx.flags.limit}), examples: [`${plural} list --tag lofi --json`]});
  cmd(`${plural} show ID`, `A ${kind} (files, preview)`, {group: "Sharing", op: kind + "_show", args: ctx => ({id: ctx.args.ID}), examples: [`${plural} show ab12cd34 --json`]});
  cmd(`${plural} edit ID`, `Change a ${kind}`, {group: "Sharing", flags: {title: V("TEXT", "Title"), description: V("TEXT", "Markdown"), "description-file": V("PATH", "Markdown file"),
    tags: V("a,b", "Tags", {type: "list"}), ...(sound ? {engine: V("ENGINE", "mixed or its banks' engine")} : {bpm: V("N", "30-300", {type: "int"})})},
    op: kind + "_edit", write: true, args: ctx => ({id: ctx.args.ID, title: ctx.flags.title, description: ctx.text("description"), tags: ctx.flags.tags,
      engine: ctx.flags.engine, bpm: ctx.flags.bpm}), examples: [`${plural} edit ab12cd34 --tags pad,keys --json`]});
  cmd(`${plural} delete ID`, `Delete a ${kind}`, {group: "Sharing", flags: YES, confirm: true, op: kind + "_delete", args: ctx => ({id: ctx.args.ID}),
    examples: [`${plural} delete ab12cd34 --yes --json`]});
  cmd(`${plural} download ID`, `A ${kind}'s files (every file into a folder, or --file NAME)`, {group: "Sharing",
    flags: {file: V("NAME", "One file"), out: V("PATH", "Where to save (a folder without --file)")}, op: kind + "_download",
    args: ctx => ({id: ctx.args.ID, file: ctx.flags.file, ...(ctx.flags.out ? {out: ctx.path("out", {exists: false})} : {})}),
    examples: [`${plural} download ab12cd34 --out ./${plural} --json`]});
}
cmd("works upload FILE", "Share a work (audio or video made with an official firmware)", {group: "Sharing",
  flags: {firmware: V("CODE", "The official firmware's code"), version: V("VCODE", "The version it was made with"),
    "version-label": V("LABEL", "A version name when there is no code"), title: V("TEXT", "1-80 characters (default: the file name)"),
    description: V("TEXT", "Text"), tags: V("a,b", "Up to 5 tags", {type: "list"}), ...DRY},
  need: ["firmware"], write: true, topic: "works", run: ctx => dryRunUpload(ctx, "work", {then: !ctx.flags.dry_run}),
  examples: ['works upload song.wav --firmware 3YGNF5 --title "Rain" --tags lofi --dry-run --json']});
cmd("works list", "Works", {group: "Sharing", flags: {q: V("WORDS", "Search words"), tag: V("TAG", "Tag"), firmware: V("CODE", "Firmware"),
  ...SORT(["new", "hot"]), ...SECTION}, op: "works_list", args: ctx => ({q: ctx.flags.q, tag: ctx.flags.tag, firmware: ctx.flags.firmware, sort: ctx.flags.sort,
  page: ctx.flags.page, cursor: ctx.flags.cursor, limit: ctx.flags.limit}), examples: ["works list --tag lofi --json"]});
cmd("works show ID", "A work", {group: "Sharing", op: "work_show", args: ctx => ({id: ctx.args.ID}), examples: ["works show ab12cd34 --json"]});
cmd("works edit ID", "Change a work", {group: "Sharing", flags: {title: V("TEXT", "Title"), description: V("TEXT", "Text"), tags: V("a,b", "Tags", {type: "list"}),
  version: V("VCODE", "A version code (empty: none)")}, op: "work_edit", write: true,
  args: ctx => ({id: ctx.args.ID, title: ctx.flags.title, description: ctx.flags.description, tags: ctx.flags.tags, version: ctx.flags.version}),
  examples: ["works edit ab12cd34 --tags lofi,demo --json"]});
cmd("works delete ID", "Delete a work", {group: "Sharing", flags: YES, confirm: true, op: "work_delete", args: ctx => ({id: ctx.args.ID}), examples: ["works delete ab12cd34 --yes --json"]});
cmd("works approve ID", "Publish a work your device sent (it is held until you approve it)", {group: "Sharing", op: "work_approve", write: true,
  args: ctx => ({id: ctx.args.ID}), examples: ["works approve ab12cd34 --json"]});
cmd("models upload FILE...", "Share a 3D model (.stl .step .3mf .obj)", {group: "Sharing",
  flags: {title: V("TEXT", "1-80 characters"), license: V(LICENSES.join("|"), "The licence", {choices: LICENSES}), description: V("TEXT", "Markdown"),
    "description-file": V("PATH", "Markdown file"), tags: V("a,b", "Tags", {type: "list"}), target: V("DEVICE", "The device it is for"),
    firmware: V("CODE", "A firmware it goes with"), "remix-of": V("ID", "The model it remixes"), preview: V("MESH", ".stl or .glb (needed for STEP/3MF/OBJ)"),
    thumbnail: V("PNG", "A picture (needed for STEP/3MF/OBJ)"), material: V("TEXT", "e.g. PLA"), "layer-height": V("MM", "e.g. 0.2", {type: "number"}),
    infill: V("PERCENT", "0-100", {type: "number"}), supports: B("Needs supports"), "print-notes": V("TEXT", "Print notes"), ...DRY},
  need: ["title", "license"], write: true, topic: "models", run: ctx => dryRunUpload(ctx, "model", {then: !ctx.flags.dry_run}),
  examples: ['models upload stand.stl --title "Desk stand" --license CC-BY-4.0 --target cardenza --dry-run --json']});
cmd("models list", "Models", {group: "Sharing", flags: {q: V("WORDS", "Search words"), tag: V("TAG", "Tag"), target: V("DEVICE", "Device"), firmware: V("CODE", "Firmware"),
  ...SORT(["new", "hot", "downloads"]), ...SECTION}, op: "models_list", args: ctx => ({q: ctx.flags.q, tag: ctx.flags.tag, target: ctx.flags.target,
  firmware: ctx.flags.firmware, sort: ctx.flags.sort, page: ctx.flags.page, cursor: ctx.flags.cursor, limit: ctx.flags.limit}), examples: ["models list --target cardenza --json"]});
cmd("models show ID", "A model", {group: "Sharing", op: "model_show", args: ctx => ({id: ctx.args.ID}), examples: ["models show ab12cd34 --json"]});
cmd("models remixes ID", "Remixes of a model", {group: "Sharing", flags: PAGE, op: "model_remixes", args: ctx => ({id: ctx.args.ID, page: ctx.flags.page}),
  examples: ["models remixes ab12cd34 --json"]});
cmd("models delete ID", "Delete a model", {group: "Sharing", flags: YES, confirm: true, op: "model_delete", args: ctx => ({id: ctx.args.ID}), examples: ["models delete ab12cd34 --yes --json"]});
cmd("models download ID", "A model file", {group: "Sharing", flags: {file: V("NAME", "One file (default the first)"), out: V("PATH", "Save it here")}, op: "model_download",
  args: ctx => ({id: ctx.args.ID, file: ctx.flags.file, ...(ctx.flags.out ? {out: ctx.path("out", {exists: false})} : {})}), examples: ["models download ab12cd34 --out stand.stl --json"]});

// ---------------------------------------------------------------------------------------------
// Browse, people, community

cmd("sections", "The six sections and their counts", {group: "Browse", op: "sections", examples: ["sections --json"]});
cmd("sections show ID", "A section's categories (use them as --tag) and tags", {group: "Browse", op: "section_show", args: ctx => ({id: ctx.args.ID}),
  examples: ["sections show sounds --json"]});
cmd("tags", "The most used tags", {group: "Browse", flags: {kind: V("KIND", "firmware, post, work, model, sound or project"), section: V("official|community", "Firmware only")},
  op: "tags", args: ctx => ({kind: ctx.flags.kind, section: ctx.flags.section}), examples: ["tags --kind sound --json"]});
cmd("search WORDS...", "Search everything (6 of each kind); a code is looked up", {group: "Browse", op: "search", args: ctx => ({q: ctx.args.WORDS.join(" ")}),
  examples: ["search groovebox --json"]});
cmd("code CODE", "What a firmware or version code names", {group: "Browse", op: "code", args: ctx => ({code: ctx.args.CODE}), examples: ["code K7M2QX --json"]});
cmd("targets", "The devices the community knows", {group: "Browse", op: "targets", examples: ["targets --json"]});
cmd("user ID [WHAT]", "A person, or their firmware|works|posts|models|sounds|projects|badges", {group: "Browse",
  op: ctx => ctx.args.WHAT ? "user_things" : "user", args: ctx => ({id: ctx.args.ID, what: ctx.args.WHAT, page: ctx.flags.page}), flags: PAGE,
  examples: ["user ab12cd34 --json", "user ab12cd34 firmware --json"]});
cmd("mine WHAT", "Your firmware|works|posts|models|sounds|projects", {group: "Browse", flags: PAGE, op: "my_things",
  args: ctx => ({what: ctx.args.WHAT, page: ctx.flags.page}), choices: {WHAT: ["firmware", "works", "posts", "models", "sounds", "projects"]},
  examples: ["mine sounds --json"]});
cmd("notifications", "Your notifications (--read marks them read)", {group: "Browse", flags: {read: B("Mark them all read"), ...PAGE},
  op: ctx => ctx.flags.read ? "notifications_read" : "notifications", args: ctx => ({page: ctx.flags.read ? undefined : ctx.flags.page}), examples: ["notifications --json"]});
cmd("favorites", "Your favourites", {group: "Browse", flags: {kind: V("KIND", "firmware, post, work, model, sound or project"), ...PAGE}, op: "favorites",
  args: ctx => ({kind: ctx.flags.kind, page: ctx.flags.page}), examples: ["favorites --kind firmware --json"]});
cmd("posts list", "Forum posts", {group: "Community", flags: {q: V("WORDS", "Search words"), tag: V("TAG", "Tag"), firmware: V("CODE", "Firmware"), ...SORT(["new", "hot"]), ...SECTION},
  op: "posts_list", args: ctx => ({q: ctx.flags.q, tag: ctx.flags.tag, firmware: ctx.flags.firmware, sort: ctx.flags.sort, page: ctx.flags.page,
    cursor: ctx.flags.cursor, limit: ctx.flags.limit}), examples: ["posts list --json"]});
cmd("posts show ID", "A post", {group: "Community", op: "post_show", args: ctx => ({id: ctx.args.ID}), examples: ["posts show ab12cd34 --json"]});
cmd("posts create", "Write a post", {group: "Community", flags: {title: V("TEXT", "1-120 characters"), body: V("TEXT", "Markdown"), "body-file": V("PATH", "Markdown file"),
  tags: V("a,b", "Up to 5", {type: "list"}), firmware: V("CODE", "A firmware it is about")}, need: ["title"], op: "post_create", write: true,
  args: ctx => ({title: ctx.flags.title, body: ctx.text("body", {need: true}), tags: ctx.flags.tags, firmware: ctx.flags.firmware}),
  examples: ['posts create --title "1.4.0 is out" --body "What changed: …" --tags announcement --json']});
cmd("posts edit ID", "Change a post", {group: "Community", flags: {title: V("TEXT", "Title"), body: V("TEXT", "Markdown"), "body-file": V("PATH", "Markdown file"),
  tags: V("a,b", "Tags", {type: "list"})}, op: "post_edit", write: true,
  args: ctx => ({id: ctx.args.ID, title: ctx.flags.title, body: ctx.text("body"), tags: ctx.flags.tags}), examples: ['posts edit ab12cd34 --title "1.4.1 is out" --json']});
cmd("posts delete ID", "Delete a post", {group: "Community", flags: YES, confirm: true, op: "post_delete", args: ctx => ({id: ctx.args.ID}), examples: ["posts delete ab12cd34 --yes --json"]});
const KINDS = ["firmware", "post", "work", "model", "sound", "project", "merge", "request"];
cmd("comments list KIND REF", "Comments on something (REF: a code, an id or CODE/N)", {group: "Community", flags: PAGE, choices: {KIND: KINDS}, op: "comments_list",
  args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, page: ctx.flags.page}), examples: ["comments list firmware K7M2QX --json"]});
cmd("comments replies COMMENT", "Replies to a comment", {group: "Community", flags: PAGE, op: "comment_replies", args: ctx => ({id: ctx.args.COMMENT, page: ctx.flags.page}),
  examples: ["comments replies 42 --json"]});
cmd("comments add KIND REF", "Comment on something", {group: "Community", flags: {body: V("TEXT", "1-4000 characters"), "body-file": V("PATH", "Text file"),
  parent: V("COMMENT", "Reply to this comment id", {type: "int"})}, choices: {KIND: KINDS}, op: "comment_add", write: true,
  args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, body: ctx.text("body", {need: true}), parent: ctx.flags.parent}),
  examples: ['comments add request K7M2QX/3 --body "Done in 1.5.0" --json']});
cmd("comments edit COMMENT", "Change your comment", {group: "Community", flags: {body: V("TEXT", "Text"), "body-file": V("PATH", "Text file")}, op: "comment_edit", write: true,
  args: ctx => ({id: ctx.args.COMMENT, body: ctx.text("body", {need: true})}), examples: ['comments edit 42 --body "…" --json']});
cmd("comments delete COMMENT", "Delete a comment", {group: "Community", flags: YES, confirm: true, op: "comment_delete", args: ctx => ({id: ctx.args.COMMENT}),
  examples: ["comments delete 42 --yes --json"]});
for (const what of ["like", "favorite"]) {
  cmd(`${what} KIND REF`, `${what === "like" ? "Like" : "Favourite"} something (--off undoes it)`, {group: "Community", flags: {off: B("Undo it")},
    choices: {KIND: what === "like" ? [...KINDS.slice(0, 6), "comment"] : KINDS.slice(0, 6)}, op: "react", write: true,
    args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, what, on: !ctx.flags.off}), examples: [`${what} firmware K7M2QX --json`]});
}
cmd("report KIND REF", "Report something to the admins", {group: "Community",
  flags: {reason: V("spam|abuse|illegal|malware|copyright|other", "Why", {choices: ["spam", "abuse", "illegal", "malware", "copyright", "other"]}), detail: V("TEXT", "Up to 1000 characters")},
  need: ["reason"], choices: {KIND: ["firmware", "version", "post", "work", "model", "sound", "project", "comment", "request", "user"]}, op: "report", write: true,
  args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, reason: ctx.flags.reason, detail: ctx.flags.detail}), examples: ["report post ab12cd34 --reason spam --json"]});

// ---------------------------------------------------------------------------------------------
// Requests, trackers, merges, feedback

cmd("inbox [CODE]", "What the community said about this project's firmware (203.json, or CODE) since you last looked: requests with votes and new comments, comments, merge requests, versions sent back, notifications; --out writes it as Markdown for an agent", {group: "Requests",
  flags: {all: B("Everything there is, not only what is new since the last inbox"), out: V("FILE", "Also write it as Markdown (e.g. .203/inbox.md: git-ignore .203/)"),
    "no-mark": B("Do not remember this look: the next inbox shows the same as new")},
  run: inbox, topic: "requests", examples: ["inbox", "inbox --out .203/inbox.md --json", "inbox K7M2QX --all --json"]});
cmd("requests list CODE", "Requests under a firmware", {group: "Requests", flags: {...SORT(["top", "new"]), ...PAGE}, op: "requests_list",
  args: ctx => ({code: ctx.args.CODE, sort: ctx.flags.sort, page: ctx.flags.page}), examples: ["requests list K7M2QX --sort top --json"]});
cmd("requests show CODE N", "A request", {group: "Requests", op: "request_show", args: ctx => ({code: ctx.args.CODE, number: ctx.args.N}), examples: ["requests show K7M2QX 3 --json"]});
cmd("requests create CODE", "Ask for something in a firmware", {group: "Requests", flags: {title: V("TEXT", "4-80 characters"), body: V("TEXT", "Markdown"), "body-file": V("PATH", "File")},
  need: ["title"], op: "request_create", write: true, args: ctx => ({code: ctx.args.CODE, title: ctx.flags.title, body: ctx.text("body")}),
  examples: ['requests create K7M2QX --title "Swing for the arpeggiator" --json']});
cmd("requests vote CODE N VOTE", "Vote a request up (1), down (-1) or take it back (0)", {group: "Requests", op: "request_vote", write: true,
  args: ctx => ({code: ctx.args.CODE, number: ctx.args.N, vote: ctx.args.VOTE}), examples: ["requests vote K7M2QX 3 1 --json"]});
cmd("dev list", "Tracker: your firmware's requests with their internal status", {group: "Requests",
  flags: {firmware: V("CODE", "One firmware"), status: V("STATUS", "new, accepted, planned, in_progress, done or rejected"), ...SORT(["top", "new", "updated"]), ...PAGE},
  op: "dev_requests", topic: "requests", args: ctx => ({firmware: ctx.flags.firmware, status: ctx.flags.status, sort: ctx.flags.sort, page: ctx.flags.page}),
  examples: ["dev list --firmware K7M2QX --sort top --json"]});
cmd("dev read CODE N", "Tracker: a request with votes, internal notes and the whole discussion", {group: "Requests", op: "dev_request_read", topic: "requests",
  args: ctx => ({code: ctx.args.CODE, number: ctx.args.N}), examples: ["dev read K7M2QX 3 --json"]});
cmd("dev update CODE N", "Tracker: status, progress, labels, a note, a link (never notifies anyone)", {group: "Requests",
  flags: {status: V("STATUS", "new, accepted, planned, in_progress, done or rejected", {choices: ["new", "accepted", "planned", "in_progress", "done", "rejected"]}),
    progress: V("0-100", "Progress", {type: "int"}), labels: V("a,b", "Replaces the labels", {type: "list"}), note: V("TEXT", "Appended note"), "note-file": V("PATH", "Note from a file"),
    link: V("URL", "An https link, appended")}, op: "dev_request_update", write: true, topic: "requests",
  args: ctx => ({code: ctx.args.CODE, number: ctx.args.N, status: ctx.flags.status, progress: ctx.flags.progress, labels: ctx.flags.labels, note: ctx.text("note"), link: ctx.flags.link}),
  examples: ['dev update K7M2QX 3 --status in_progress --progress 10 --note "Plan: …" --json']});
cmd("merges list CODE", "Merge requests aimed at a firmware", {group: "Requests", flags: {status: V("open|merged|closed|all", "Which"), ...PAGE}, op: "merges_list",
  args: ctx => ({code: ctx.args.CODE, status: ctx.flags.status, page: ctx.flags.page}), examples: ["merges list K7M2QX --json"]});
cmd("merges show CODE N", "A merge request", {group: "Requests", op: "merge_show", args: ctx => ({code: ctx.args.CODE, number: ctx.args.N}), examples: ["merges show K7M2QX 1 --json"]});
cmd("merges open PARENT", "Offer your fork back to its parent", {group: "Requests", flags: {from: V("CODE", "Your fork's code"), title: V("TEXT", "1-120 characters"),
  body: V("TEXT", "Markdown"), "body-file": V("PATH", "File"), "from-version": V("VCODE", "A version of the fork"), "github-url": V("URL", "A GitHub pull request")},
  need: ["from", "title"], op: "merge_open", write: true, args: ctx => ({code: ctx.args.PARENT, from: ctx.flags.from, title: ctx.flags.title, body: ctx.text("body"),
    from_version: ctx.flags.from_version, github_url: ctx.flags.github_url}), examples: ['merges open K7M2QX --from P4RK9T --title "A fifth track" --json']});
cmd("merges status CODE N STATUS", "Merge, close or reopen a merge request (STATUS: merged, closed, open)", {group: "Requests",
  flags: {"merged-version": V("VCODE", "For merged: the version that has it")}, choices: {STATUS: ["merged", "closed", "open"]}, op: "merge_status", write: true,
  args: ctx => ({code: ctx.args.CODE, number: ctx.args.N, status: ctx.args.STATUS, merged_version: ctx.flags.merged_version}), examples: ["merges status K7M2QX 1 merged --json"]});
cmd("feedback", "Send feedback about the community (a bug or an idea)", {group: "Requests",
  flags: {kind: V("bug|idea", "Which", {choices: ["bug", "idea"]}), title: V("TEXT", "1-120 characters"), message: V("TEXT", "1-2000 characters"),
    "message-file": V("PATH", "File"), page: V("PATH", "Where on the site")}, need: ["kind", "title"], op: "feedback", write: true,
  args: ctx => ({kind: ctx.flags.kind, title: ctx.flags.title, message: ctx.text("message", {need: true}), page: ctx.flags.page}),
  examples: ['feedback --kind bug --title "Typo on /levels" --message "Experiance" --json']});
cmd("feedback mine", "Your appeals and feedback, with their status and our reply", {group: "Requests", flags: PAGE, op: "my_feedback", args: ctx => ({page: ctx.flags.page}),
  examples: ["feedback mine --json"]});

// ---------------------------------------------------------------------------------------------
// Devices, experience

cmd("devices list", "Your devices: online (in its Launcher, or a firmware running) or off, last seen", {group: "Devices", op: "devices", examples: ["devices list --json"]});
// Credentials are made and removed on the website only (COMMUNITY.md "Credentials"): these say where.
const WEB_DEVICES = {page: "/me/devices", why: "devices are signed in and out there"};
cmd("devices bind-code", "Web only: a Launcher signs in by approving its code on the site (/activate); the bind code is on /me/devices", {group: "Devices",
  flags: {new: B("(web only)")}, webOnly: WEB_DEVICES, examples: ["devices bind-code"]});
cmd("devices rename DEVICE NAME...", "Web only: rename a device on /me/devices", {group: "Devices", webOnly: WEB_DEVICES, examples: ['devices rename 3 "Studio Cardenza"']});
cmd("devices unbind DEVICE", "Web only: sign a device out on /me/devices (我的设备)", {group: "Devices", webOnly: WEB_DEVICES, examples: ["devices unbind 3"]});
// Over a USB cable, no sign-in (the user, 2026-11-18: 线刷 needs no account; signing in is for Wi-Fi): `anyone`.
// 线刷 (the website's 用 USB 线安装): through the device's 203 Launcher, its console from power-on.
cmd("flash [CODE]", "Install a firmware on a device over a USB cable (线刷), through its 203 Launcher: a firmware's newest build for the device (--channel) or a version, by its code, or a local --bin. No sign-in and no bound device: the device on, on a cable, in its Launcher or running a firmware (restarted into the Launcher first) (macOS and Linux)", {group: "Devices",
  anyone: true, flags: {bin: V("PATH", "A local application image (build/<project>.bin) instead of a code"), port: V("PORT", "The serial port (/dev/ttyACM0, /dev/cu.usbmodem…; default: the one a running firmware comes back on, else the one USB serial port there is)"),
    channel: V("stable|beta|dev", "The line of a firmware's code (default stable)", {choices: CHANNELS}), target: V("DEVICE", "The device (default: what its Launcher says; cardenza with --dry-run)"),
    name: V("NAME", "The name the Launcher keeps it under (default: the firmware's)"), ...DRY},
  run: flashDevice, topic: "devices", examples: ["flash V6QK28 --json", "flash V6QK28 --channel beta --port /dev/ttyACM0 --json", "flash --bin build/app.bin --json", "flash V6QK28 --dry-run --json"]});
cmd("log", "A Cardenza's log over its USB cable: a running firmware's console (CardenzaHAL's system channel) or the serial port (the 203 Launcher, a firmware without USB); --until makes it a test (no sign-in; macOS and Linux)", {group: "Devices",
  anyone: true, flags: {seconds: V("N", "How long to read (default: until Ctrl-C on a terminal, 20 s for a program, 60 s with --until)", {type: "number"}),
    until: V("REGEX", "A test: stop with exit 0 at the first line that matches; exit 1 (log_timeout) when none does, or (device_crashed) at a panic or restart"),
    fail: V("REGEX", "Stop with exit 1 (device_crashed) at a line that matches (default with --until: a panic, abort, Backtrace, a restart)"),
    port: V("PORT", "Read this serial port (/dev/ttyACM0, /dev/cu.usbmodem…) instead of looking"), out: V("FILE", "Also append the lines to FILE")},
  run: deviceLog, topic: "devices", examples: ["log", "log --seconds 30 --json", 'log --until "ready" --seconds 30 --json', "log --port /dev/ttyACM0 --out boot.log"]});
// 恢复刷机 (the website's /recover): no bound device needed; Node has no serial port, so esptool (Python) writes it.
cmd("devices recover", "Recovery flash: the newest official Launcher and the device's official firmware, as the Launcher would have them (erases the whole internal flash; the SD card is not touched). --out saves the images and the esptool command, --port writes them with esptool", {group: "Devices",
  flags: {target: V("DEVICE", "The device (default cardenza; GET /recovery lists them)"), port: V("PORT", "Write it now over USB with esptool (python3 -m esptool): /dev/ttyACM0, COM5 …; the device in download mode (a running CardenzaHAL firmware is restarted into it)"),
    out: V("DIR", "Save the images, plan.json and flash.sh (the esptool command) here instead"), "launcher-only": B("Restore the Launcher alone (no official firmware)"),
    ...DRY, yes: B("Yes, erase the device's internal flash (with --port)")},
  anyone: true, run: recoverDevice, topic: "devices", examples: ["devices recover --dry-run --json", "devices recover --out recover --json", "devices recover --port /dev/ttyACM0 --yes"]});
cmd("devices send DEVICE CODE", "Install a firmware (newest on a channel) or a version on a bound, online device and follow it", {group: "Devices",
  flags: {start: B("Start it after installing"), channel: PUBLISH_FLAGS.channel, "no-wait": B("Do not follow it"), unlock: V("TOKEN", "cfu_… for someone else's private firmware", {secret: true})},
  op: "device_send", write: true, topic: "devices", args: ctx => ({device: ctx.args.DEVICE, code: ctx.args.CODE, ...(ctx.flags.start ? {start: true} : {}),
    channel: ctx.flags.channel, wait: !ctx.flags.no_wait, unlock: ctx.flags.unlock}), examples: ["devices send 3 K7M2QX --start --json", "devices send 3 K7M2QX --no-wait --json"]});
cmd("devices status DEVICE COMMAND", "A command sent to a device (its id from devices send): downloading n %, installed, started, or why it failed; --wait follows it",
  {group: "Devices", flags: {wait: B("Follow it until it ends")}, op: "device_command", topic: "devices",
  args: ctx => ({device: ctx.args.DEVICE, command: ctx.args.COMMAND, wait: !!ctx.flags.wait}), examples: ["devices status 3 41 --json", "devices status 3 41 --wait --json"]});
cmd("devices update-launcher DEVICE", "Upgrade the device's 203 Launcher to the newest for it (我的设备's 升级启动器) and follow it until the new Launcher runs; devices list shows launcher_update", {group: "Devices",
  flags: {channel: PUBLISH_FLAGS.channel, "no-wait": B("Do not follow it")},
  op: "device_update_launcher", write: true, topic: "devices", args: ctx => ({device: ctx.args.DEVICE, channel: ctx.flags.channel, wait: !ctx.flags.no_wait}),
  examples: ["devices update-launcher 3 --json", "devices update-launcher 3 --no-wait --json"]});
cmd("me edit", "Change your name, bio or avatar", {group: "People",
  flags: {name: V("NAME", "2-24 letters, digits, CJK, _ - . (single spaces inside)"), bio: V("TEXT", "Up to 300 characters"), "bio-file": V("PATH", "The bio from a file"),
    avatar: V("a01..a24", "One of the site's avatars")}, run: editMe, write: true, examples: ['me edit --name "Lin" --bio "Makes grooveboxes for the Cardenza" --json']});
cmd("xp", "Your XP history and level", {group: "People", flags: PAGE, op: "xp_history", args: ctx => ({page: ctx.flags.page}), examples: ["xp --json"]});
cmd("levels", "Levels and the XP rules", {group: "People", op: "levels", examples: ["levels --json"]});
cmd("badges", "Your badges", {group: "People", op: "my_badges", examples: ["badges --json"]});
cmd("badges all", "Every badge and how it is earned", {group: "People", op: "badges_all", examples: ["badges all --json"]});
cmd("badges wear ID...", "Wear 0-3 of your badges, in this order (none: take them all off)", {group: "People", op: "badges_wear", write: true, params0: true,
  args: ctx => ({worn: ctx.args.ID.length === 1 && ctx.args.ID[0].toLowerCase() === "none" ? [] : ctx.args.ID}),
  examples: ["badges wear b4k9 x2m7 --json", "badges wear none --json"]});
cmd("titles", "Your titles", {group: "People", op: "my_titles", examples: ["titles --json"]});
cmd("titles wear ID", "Wear a title (none: no title)", {group: "People", op: "title_wear", write: true, args: ctx => ({title: ctx.args.ID === "none" ? null : ctx.args.ID}),
  examples: ["titles wear none --json"]});

// ---------------------------------------------------------------------------------------------
// Admin

const ADMIN = {group: "Admin", topic: "admin"};
cmd("admin overview", "Admin: counts", {...ADMIN, op: "admin_overview", examples: ["admin overview --json"]});
cmd("admin users", "Admin: people", {...ADMIN, flags: {q: V("TEXT", "Name or id"), status: V("STATUS", "active, banned or deleted"), ...PAGE}, op: "admin_users",
  args: ctx => ({q: ctx.flags.q, status: ctx.flags.status, page: ctx.flags.page}), examples: ["admin users --q mika --json"]});
cmd("admin ban ID", "Admin: ban a person", {...ADMIN, flags: {reason: V("TEXT", "Why"), days: V("1|7|30", "How long (default: until lifted)", {type: "int"})}, need: ["reason"],
  op: "admin_ban", write: true, args: ctx => ({id: ctx.args.ID, reason: ctx.flags.reason, days: ctx.flags.days}), examples: ['admin ban ab12cd34 --reason "spam" --days 7 --json']});
cmd("admin unban ID", "Admin: lift a ban", {...ADMIN, op: "admin_unban", write: true, args: ctx => ({id: ctx.args.ID}), examples: ["admin unban ab12cd34 --json"]});
cmd("admin delete-user ID", "Admin: close an account", {...ADMIN, flags: {reason: V("TEXT", "Why"), ...YES}, need: ["reason"], confirm: true, op: "admin_delete_user",
  args: ctx => ({id: ctx.args.ID, reason: ctx.flags.reason}), examples: ['admin delete-user ab12cd34 --reason "asked" --yes --json']});
for (const action of ["hide", "unhide", "delete"]) {
  cmd(`admin ${action} KIND REF`, `Admin: ${action} content`, {...ADMIN, flags: {reason: V("TEXT", "Why"), ...(action === "delete" ? YES : {})}, confirm: action === "delete",
    choices: {KIND: ["firmware", "version", "post", "work", "model", "sound", "project", "comment"]}, op: "admin_content",
    args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, action, reason: ctx.flags.reason}), examples: [`admin ${action} post ab12cd34 --reason spam${action === "delete" ? " --yes" : ""} --json`]});
}
cmd("admin feature KIND REF", "Admin: feature (加精) firmware, a sound, project, work, model or post (--off undoes it)", {...ADMIN, flags: {off: B("Undo it")},
  choices: {KIND: ["firmware", "sound", "project", "work", "model", "post"]}, op: "admin_feature", write: true,
  args: ctx => ({kind: ctx.args.KIND, ref: ctx.args.REF, on: !ctx.flags.off}), examples: ["admin feature firmware K7M2QX --json"]});
cmd("admin official CODE", "Admin: the official tag on a firmware (--off removes it)", {...ADMIN, flags: {off: B("Remove it")}, op: "admin_official", write: true,
  args: ctx => ({code: ctx.args.CODE, on: !ctx.flags.off}), examples: ["admin official K7M2QX --json"]});
for (const flag of ["pin", "lock"]) {
  cmd(`admin ${flag} ID`, `Admin: ${flag} a post (--off undoes it)`, {...ADMIN, flags: {off: B("Undo it")}, op: "admin_post_flag", write: true,
    args: ctx => ({id: ctx.args.ID, flag, on: !ctx.flags.off}), examples: [`admin ${flag} ab12cd34 --json`]});
}
cmd("admin add-official HUB_APP_ID", "Admin: show a hub App as an official firmware", {...ADMIN, flags: {tags: V("a,b", "Tags", {type: "list"})}, op: "admin_official_create", write: true,
  args: ctx => ({hub_app_id: ctx.args.HUB_APP_ID, tags: ctx.flags.tags}), examples: ["admin add-official 0b7c…-uuid --json"]});
cmd("admin section-set ID", "Admin: replace a section's categories and / or open or close it", {...ADMIN,
  flags: {categories: V("JSON", '[{"tag":"lofi","label_zh":"Lo-fi","label_en":"Lo-fi"}]'), open: B("Open the section to everyone"), closed: B("Close it (admins only)")},
  op: "admin_section_set", write: true, args: ctx => {
    if (ctx.flags.categories === undefined && !ctx.flags.open && !ctx.flags.closed) throw ctx.usage("Give --categories JSON, --open or --closed");
    if (ctx.flags.open && ctx.flags.closed) throw ctx.usage("--open or --closed, not both");
    return {id: ctx.args.ID, ...(ctx.flags.categories !== undefined ? {categories: ctx.json("categories")} : {}),
      ...(ctx.flags.open ? {open: true} : ctx.flags.closed ? {open: false} : {})};
  }, examples: [`admin section-set models --categories '[{"tag":"case","label_zh":"外壳","label_en":"Cases"}]' --json`, "admin section-set sounds --open --json"]});
cmd("admin reports", "Admin: reports", {...ADMIN, flags: {status: V("open|resolved", "Which"), ...PAGE}, op: "admin_reports", args: ctx => ({status: ctx.flags.status, page: ctx.flags.page}),
  examples: ["admin reports --json"]});
cmd("admin resolve N ACTION", "Admin: resolve a report (ACTION: dismiss, hide, delete, ban)", {...ADMIN, flags: {note: V("TEXT", "Note"), days: V("N", "Ban days", {type: "int"})},
  choices: {ACTION: ["dismiss", "hide", "delete", "ban"]}, op: "admin_resolve", write: true,
  args: ctx => ({id: ctx.args.N, action: ctx.args.ACTION, note: ctx.flags.note, days: ctx.flags.days}), examples: ["admin resolve 12 dismiss --json"]});
cmd("admin audit", "Admin: the audit log", {...ADMIN, flags: {actor: V("ID", "A user id"), ...PAGE}, op: "admin_audit", args: ctx => ({actor: ctx.flags.actor, page: ctx.flags.page}),
  examples: ["admin audit --json"]});
cmd("admin titles", "Admin: titles", {...ADMIN, op: "admin_titles", examples: ["admin titles --json"]});
cmd("admin title-create [TEXT]", "Admin: make a title (--zh / --en; one may be left out)", {...ADMIN,
  flags: {zh: V("TEXT", "Chinese, up to 8 characters"), en: V("TEXT", "English, up to 16"), color: V("COLOR", "cyan, yellow, violet, green, pink, blue, lime, amber (needed but for an admin title)",
    {choices: ["cyan", "yellow", "violet", "green", "pink", "blue", "lime", "amber"]}), admin: B("An admin title (its colour is the admins' orange-red)")},
  op: "admin_title_create", write: true, args: ctx => {
    const texts = {...(ctx.flags.zh ? {text_zh: ctx.flags.zh} : {}), ...(ctx.flags.en ? {text_en: ctx.flags.en} : {}), ...(ctx.args.TEXT ? {text: ctx.args.TEXT} : {})};
    if (!Object.keys(texts).length) throw ctx.usage("Needs the title's text: TEXT, --zh or --en", {next: [ctx.cmd({add: {en: "Helper"}})]});
    if (!ctx.flags.color && !ctx.flags.admin) throw ctx.usage("Needs --color: cyan, yellow, violet, green, pink, blue, lime or amber (an admin title, --admin, has none)", {field: "color"});
    return {...texts, color: ctx.flags.color, ...(ctx.flags.admin ? {admin: true} : {})};
  }, examples: ['admin title-create --zh 测试员 --en Tester --color cyan --json']});
cmd("admin grant-title USER TITLE", "Admin: grant a title (--off takes it back)", {...ADMIN, flags: {off: B("Take it back")}, op: "admin_grant_title", write: true,
  args: ctx => ({user: ctx.args.USER, title: ctx.args.TITLE, on: !ctx.flags.off}), examples: ["admin grant-title ab12cd34 t9p4b98w --json"]});
cmd("admin badge-create [NAME]", "Admin: make a badge to grant", {...ADMIN,
  flags: {zh: V("TEXT", "Chinese name"), en: V("TEXT", "English name"), icon: V("b01..b32", "Its icon"), description: V("TEXT", "Description"),
    "description-zh": V("TEXT", "Chinese description"), "description-en": V("TEXT", "English description")}, need: ["icon"], op: "admin_badge_create", write: true,
  args: ctx => {
    const names = {...(ctx.flags.zh ? {name_zh: ctx.flags.zh} : {}), ...(ctx.flags.en ? {name_en: ctx.flags.en} : {}), ...(ctx.args.NAME ? {name: ctx.args.NAME} : {})};
    if (!Object.keys(names).length) throw ctx.usage("Needs a name: NAME, --zh or --en");
    return {...names, icon: ctx.flags.icon, description: ctx.flags.description, description_zh: ctx.flags.description_zh, description_en: ctx.flags.description_en};
  }, examples: ["admin badge-create --en Helper --icon b05 --json"]});
cmd("admin grant-badge USER BADGE", "Admin: grant a badge (--off takes it back)", {...ADMIN, flags: {off: B("Take it back")}, op: "admin_grant_badge", write: true,
  args: ctx => ({user: ctx.args.USER, badge: ctx.args.BADGE, on: !ctx.flags.off}), examples: ["admin grant-badge ab12cd34 x2m7 --json"]});
cmd("admin xp USER DELTA", "Admin: adjust a person's XP (audited)", {...ADMIN, flags: {reason: V("TEXT", "Why")}, need: ["reason"], op: "admin_xp", write: true,
  args: ctx => {
    const delta = Number(ctx.args.DELTA);
    if (!Number.isInteger(delta)) throw ctx.usage("DELTA is a whole number, e.g. 50 or -20");
    return {user: ctx.args.USER, delta, reason: ctx.flags.reason};
  }, examples: ['admin xp ab12cd34 50 --reason "Helped with the docs" --json']});
cmd("admin issues", "Admin: appeals, bug reports and ideas", {...ADMIN, flags: {kind: V("false_positive|bug|idea", "Which"), status: V("STATUS", "Status"), ...PAGE},
  op: "community_issues", args: ctx => ({kind: ctx.flags.kind, status: ctx.flags.status, page: ctx.flags.page}), examples: ["admin issues --kind false_positive --json"]});
cmd("admin issue N", "Admin: an issue with the full check report, log and BINs", {...ADMIN, op: "community_issue_read", args: ctx => ({number: ctx.args.N}),
  examples: ["admin issue 7 --json"]});
cmd("admin issue-update N", "Admin: status, note, link, or a reply the author sees", {...ADMIN,
  flags: {status: V("STATUS", "new, investigating, false_positive, confirmed, fixed or wont_fix"), note: V("TEXT", "Internal note"), "note-file": V("PATH", "File"),
    link: V("URL", "A link"), reply: V("TEXT", "Shown to the author"), "reply-file": V("PATH", "File")}, op: "community_issue_update", write: true,
  args: ctx => ({number: ctx.args.N, status: ctx.flags.status, note: ctx.text("note"), link: ctx.flags.link, reply: ctx.text("reply")}),
  examples: ['admin issue-update 7 --status false_positive --reply "Fixed in the checker" --json']});
cmd("admin override VCODE", "Admin: publish a version the checks sent back (a false positive)", {...ADMIN, flags: {note: V("TEXT", "Why"), "note-file": V("PATH", "File")},
  op: "admin_version_override", write: true, args: ctx => ({version_code: ctx.args.VCODE, note: ctx.text("note", {need: true})}),
  examples: ['admin override V3X9PA --note "Touch IC missing in QEMU" --json']});
cmd("admin recheck VCODE", "Admin: run a version's checks again", {...ADMIN, op: "admin_version_recheck", write: true, args: ctx => ({version_code: ctx.args.VCODE}),
  examples: ["admin recheck V3X9PA --json"]});

// ---------------------------------------------------------------------------------------------
// Anything else

cmd("api METHOD PATH", "Call any endpoint (reference/api.md): GET or POST, a path below the API", {group: "Other", flags: {body: V("JSON", "A JSON body for POST")},
  choices: {METHOD: ["GET", "POST", "get", "post"]}, op: "api_request",
  args: ctx => ({method: ctx.args.METHOD.toUpperCase(), path: ctx.args.PATH, ...(ctx.flags.body ? {body: ctx.json("body")} : {})}),
  examples: ["api GET /firmware/K7M2QX/versions --json"]});
cmd("ops", "Every API operation with its JSON schema (for programs)", {group: "Other", offline: true, custom: "ops", examples: ["ops"]});

// ---------------------------------------------------------------------------------------------
// Source archives

cmd("source check [DIR]", "What the source archive of the project in DIR (default here) would hold: the commit's tracked files, checked for secrets", {group: "Publishing",
  run: sourceCheck, topic: "source", examples: ["source check --json"]});
cmd("source upload VCODE [DIR]", "Attach the source archive of the project in DIR (default here) to a version of yours (git archive of the commit, checked for secrets)", {group: "Publishing",
  flags: {...DRY, force: B("Upload although the working tree has uncommitted changes (they are not in the archive)")}, run: sourceUpload, write: true, topic: "source",
  examples: ["source upload V3X9PA --dry-run --json", "source upload V3X9PA --json"]});
cmd("source delete CODE VCODE", "Remove a version's source archive", {group: "Publishing", flags: YES, confirm: true, op: "version_source_delete", write: true,
  args: ctx => ({code: ctx.args.CODE, version_code: ctx.args.VCODE}), examples: ["source delete K7M2QX V3X9PA --yes --json"]});

// Groups whose bare word runs one of their commands (devices → devices list).
export const GROUP_DEFAULT = {devices: "devices list", me: "whoami"};
// Words people use for commands that have other names: suggested, never run silently.
export const ALIASES = {
  release: "publish", deploy: "publish", upload: "publish", push: "publish", ship: "publish", "publish-version": "publish", new: "firmware create", create: "firmware create",
  signin: "login", "sign-in": "login", auth: "login", authenticate: "login", profile: "me edit", status: "doctor", check: "doctor", health: "doctor", version: "versions",
  fw: "firmware", firmwares: "firmware", sound: "sounds", project: "projects", work: "works", model: "models", post: "posts", comment: "comments",
  request: "requests", device: "devices", merge: "merges", cover: "firmware cover", list: "firmware mine", info: "doctor",
  checkout: "clone", "git-clone": "clone", remix: "fork", "based-on": "firmware based-on", lineage: "firmware based-on", spec: "rules", guide: "rules",
  quota: "quotas", limits: "quotas", lookup: "firmware lookup", archive: "source upload",
  simulator: "sim", emulator: "sim", wasm: "sim build", web: "sim build", play: "sim check",
};

export function findCommand(words) {
  for (const count of [3, 2, 1]) {
    const name = words.slice(0, count).join(" ");
    const found = COMMANDS.find(c => c.name === name);
    if (found) return {command: found, used: count};
  }
  return null;
}
export const GROUPS = [...new Set(COMMANDS.filter(c => c.words.length > 1).map(c => c.words[0]))];
