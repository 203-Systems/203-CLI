// What 203c says when something goes wrong (each error: what was wrong, the valid values, the exact
// next command), its exit codes, and its help topics (203c help <topic>). Part of the Agent Skill
// skill/203-community.

import {NAME_RULE} from "./project.mjs";
import {BLOCKED_CODES, COMMUNITY_HOSTS, OFFLINE_EN, OFFLINE_ZH, defaultLang, isDnsFailure, sandboxSteps} from "./lib.mjs";
import {GUIDE_URL, guidePart} from "./description.mjs";

// Exit codes: the same for every command (SKILL.md and reference/cli.md list them).
export const EXIT = {ok: 0, refused: 1, usage: 2, later: 3, signin: 4, rejected: 5, confirm: 6};
export const EXIT_TEXT = [
  [0, "done (also: nothing to do, it was done before)"],
  [1, "refused: the API or a local check said no; fix what `error` / `field` / `hint` say, then run `next[0]`"],
  [2, "usage: the command itself is wrong (unknown command or flag, missing or bad argument); run `next[0]` or see --help"],
  [3, "try again later: the network or the API failed, a rate limit, or the checks are still running; run the same command again"],
  [4, "sign in: no token, or the token is not valid any more; run `login`"],
  [5, "the automatic checks sent the version back: read the report (`versions check`), fix and publish a new version, or appeal"],
  [6, "needs your decision: a warning stops here; run `next[0]` (the same command with --force or --yes) only if that is what the user wants"],
];

// An error 203c reports: {error, code, field?, hint, next:[commands], exit}.
export class CliError extends Error {
  constructor(code, message, {exit = EXIT.refused, field, hint, next = [], status, data = {}} = {}) {
    super(message);
    this.code = code; this.exit = exit; this.field = field; this.hint = hint; this.next = next.filter(Boolean); this.status = status; this.data = data;
  }
}
export const usage = (message, more = {}) => new CliError("usage", message, {exit: EXIT.usage, ...more});

// Every error code 203c can print, what it means and what to do (help errors, reference/cli.md, SKILL.md).
export const ERROR_CODES = [
  ["usage", 2, "the command is wrong", "run next[0], or `<command> --help`"],
  ["signin_required", 4, "not signed in (every command but login, logout, help, doctor, rules, flash and devices recover needs it), or the token was deleted / revoked / mistyped, or a run's trusted-publishing credential ended", "`login` (the browser; no browser: `login --with-token`, a personal token, or `login --no-browser`, then `login --wait`); in GitHub Actions `login --github-oidc --firmware CODE` (again: it is repeatable)"],
  ["oidc_untrusted", 1, "login --github-oidc: no trusted publisher of the firmware matches this run (repository, workflow file, environment)", "the firmware's owner links the repository: its page (开发 › 自动发布) or `firmware publishers add CODE --repository OWNER/NAME --workflow FILE`"],
  ["oidc_channel", 1, "trusted publishing: this run may not publish on that channel (`channel_allowed`; stable needs a tag vX.Y.Z, beta a tag vX.Y.Z-beta.N, else dev; and the publisher's channels)", "publish on an allowed channel, or run on such a tag"],
  ["oidc_invalid", 4, "login --github-oidc: the community did not take GitHub's token (`reason`: audience, expired, replayed, …)", "run login --github-oidc again; audience: --api must be the community's API base"],
  ["oidc_unavailable", 2, "login --github-oidc outside GitHub Actions, or a job without permissions: id-token: write", "give the job permissions: id-token: write (help ci)"],
  ["publish_only", 1, "a trusted-publishing credential tried something else than publishing its firmware's versions (page edits, other firmware, account actions)", "do that with the owner's own sign-in (on the site, or 203c login on a computer)"],
  ["invalid_token", 4, "login --with-token / --token: not a personal token (cct_ and 64 hex digits)", "copy the whole token, or the user makes a new one on the site (设置 › 个人令牌, /me/tokens)"],
  ["web_only", 1, "personal tokens, bind codes, devices and personal data are managed on the website only", "ask the user to open the page in `url`"],
  ["reauth_required", 4, "the website needs a recent sign-in for this", "the user signs in again on the site"],
  ["forbidden", 1, "not yours, an official firmware, or the token lacks write / admin", "read `hint`; fork it, or sign in again with write"],
  ["admin_scope_required", 4, "an admin whose sign-in lacks the admin scope", "`login --admin` (the user ticks admin on the approval page)"],
  ["not_yours", 1, "the firmware belongs to someone else", "`firmware fork CODE …` and publish to your fork"],
  ["official_from_hub", 1, "an official firmware whose versions come from the Launcher hub", "its CI publishes through the hub; publish your own firmware instead"],
  ["not_found", 1, "no such code or id", "check it: `code CODE`, `firmware mine`, `search WORDS`"],
  ["invalid", 1, "a value the API does not take (`field` names it)", "fix that field as `hint` says"],
  ["invalid_name", 1, "a firmware name the community does not take", "2-48 characters: Chinese, English letters, digits, single spaces and - _ . + & ( ) [ ] ! # , : ' · （ ） ： ，"],
  ["file_not_found", 1, "a file path that does not exist (paths are relative to the current folder)", "use the path `hint` suggests"],
  ["wrong_file", 1, "the file is not what the command needs (e.g. a bootloader or ELF instead of the app BIN)", "use the file `hint` / `next` name"],
  ["bad_version", 1, "a version label the API does not take", "letters, digits and . _ + - only, ≤ 32"],
  ["bad_channel", 1, "not stable, beta or dev", "use the channel `next` suggests"],
  ["channel_off", 6, "the beta or dev channel of this firmware is off", "add --yes to turn it on while publishing"],
  ["already_published", 0, "this exact BIN is already published under that version", "nothing to do"],
  ["version_taken", 1, "the version is published with another BIN", "publish a new version (next suggests one)"],
  ["draft_mismatch", 1, "a draft of that version has another BIN, channel or devices", "delete the draft (next), then publish again"],
  ["conflict", 1, "e.g. the version exists, a BIN is missing", "read `hint`"],
  ["rejected", 5, "the checks sent the version back", "`versions check VCODE`; fix and publish a new version, or `versions appeal`"],
  ["still_checking", 3, "the checks did not finish in time", "run the same command again (it resumes) or `versions check VCODE`"],
  ["needs_force", 6, "a quality warning (e.g. no release notes on stable, a lower version, a BIN that says another version)", "fix it, or add --force if it is really meant"],
  ["cover_required", 6, "a stable version of a firmware with no cover at all (no picture, none from its original, no screen after boot, no web build with it)", "add one (`--cover cover.png`, `firmware cover CODE cover.png`) or send the web build; `--without-cover` only if the user wants none"],
  ["gallery_pictures", 1, "publish (signed in yourself, an app): the gallery would not hold 3-5 different pictures (`count`, `duplicates`); also firmware images add / edit --place gallery past 5", "take screenshots with the firmware running on a Cardenza on USB (`board screen --out docs/screens/1.png`, then 2, 3), list them in 203.json's publish.images (or `firmware images add CODE …`), run it again; nothing was uploaded"],
  ["description_too_long", 1, "the description is over 3000 characters (pictures not counted; `length`): a product page, not a manual", "keep what it is, 3-6 features, what it needs and how to start (aim for 800); key tables to its tutorial, building to the README, history to the release notes (`help description`)"],
  ["needs_confirmation", 6, "an action that needs a yes (deleting, a name someone else uses, turning a channel on)", "add --yes if the user agrees"],
  ["launcher_official_only", 1, "only the official 203 Launcher is offered: launchers are made and forked by admins only", "publish your firmware as an app (leave out --launcher); do not fork a launcher"],
  ["sim_not_hal", 1, "the simulator version cannot be built: the firmware calls the chip's drivers instead of CardenzaHAL (`unsupported` lists them)", "use the HAL's API; publish goes on with the BIN alone (no Play)"],
  ["sim_toolchain", 6, "Emscripten, CMake or Python is missing for the simulator version (in publish, on stable / beta: a decision)", "install what `hint` says, or --no-sim"],
  ["sim_build_failed", 6, "the firmware does not compile for the browser (`log_tail` has the errors)", "fix them, or --no-sim (publish); sim build shows them again"],
  ["sim_no_web_target", 1, "the CardenzaHAL found has no web target yet (no tools/cardenza_web.py)", "--hal DIR with a checkout that has it; publish goes on with the BIN alone"],
  ["sim_not_project", 2, "no ESP-IDF project of the firmware where 203c looked", "--project DIR (publish) or sim build DIR"],
  ["simulator_fails", 1, "the simulator version did not say it was ready within 15 s in the checker's browser", "fix it and sim upload again, or sim check VCODE --again"],
  ["official_only", 1, "sounds, projects and works are only for official firmware", "use the official firmware's code (`firmware list --official`)"],
  ["section_closed", 1, "that section (sounds, projects or works) is not open yet: admins only", "nothing to fix; share it when the section opens (`sections`)"],
  ["placeholder", 2, "a value copied from an example without filling it in (\"<…>\", TODO)", "write the real value; ask the user if unsure"],
  ["no_clone_url", 1, "the firmware (and its parents) bound no repository", "ask its owner; yours: `firmware edit CODE --clone-url …`"],
  ["clone_failed", 3, "git clone failed", "check the network / access, run it again"],
  ["password_required", 1, "a private firmware", "`firmware unlock CODE --password …`, then --unlock with its answer"],
  ["password_wrong", 1, "a wrong password (`attempts_left`)", "ask the owner for the password"],
  ["too_large", 1, "a file over the limit", "make it smaller"],
  ["rate_limited", 3, "too many today (`retry_after` seconds)", "wait, then run it again"],
  ["expired", 1, "a code, ticket or sign-in ran out", "start again (next)"],
  ["deleted", 1, "it was deleted", "nothing to do with it"],
  ["not_for_target", 1, "that version has no BIN for that device", "choose another version or device"],
  ["download_failed", 3, "a download failed (network, mirror)", "run the same command again"],
  ["sha_mismatch", 3, "a downloaded file is not the one the API describes (its SHA-256)", "run it again; a broken mirror is retried"],
  ["recovery_plan", 1, "the recovery images cannot be laid out for this device (`data.code` says why)", "report it (`feedback --kind bug`); nothing was written"],
  ["esptool_missing", 1, "esptool (Python) is not installed: devices recover --port needs it", "`pip install esptool`, or `devices recover --out DIR` and flash the files another way"],
  ["port_not_found", 1, "flash: no USB serial port and no device running a firmware (not plugged in, a charging-only cable, or off)", "plug it in with a data cable and turn it on; or give `--port`"],
  ["port_ambiguous", 1, "flash: several USB serial ports", "say which with `--port` (next lists them)"],
  ["port_unavailable", 1, "flash: the port cannot be opened (no permission, another program has it, not a serial port)", "Linux: the dialout group; close serial monitors and the website's page; check `--port`"],
  ["port_failed", 3, "flash: the port failed while it was used (unplugged)", "plug it in again and run it again"],
  ["no_launcher", 1, "flash: no 203 Launcher answered on the port (another device's port, or the Launcher in USB Drive mode)", "leave USB Drive (its home screen) or give the right `--port`, then run it again"],
  ["firmware_unreachable", 1, "flash / devices recover / board: the device runs a firmware and 203c cannot reach it (Linux: no permission for its MIDI or HID, or another program has its MIDI port; macOS: no python3 for CoreMIDI)", "Linux: the audio group; macOS: xcode-select --install; or put it in its Launcher yourself (press HOME, left of the screen, and choose Back to Launcher; a firmware without that menu: hold FN while plugging it in)"],
  ["no_launcher_port", 3, "flash / devices recover: the firmware was asked to restart and no serial port came up", "plug the cable in again and run it again; a firmware that does not take the command: press HOME and choose Back to Launcher (no such menu: hold FN while plugging it in)"],
  ["launcher_countdown", 3, "flash: the restarted Launcher started the firmware again before 203c reached it (twice)", "press HOME on the device and choose Back to Launcher, then run it again; a firmware without that menu: hold FN, run it again, let go of FN once the Launcher's menu shows"],
  ["launcher_busy", 3, "flash: the Launcher is in a menu", "go back to its home screen, then run it again"],
  ["device_timeout", 3, "flash: the device stopped answering", "plug the cable in again and run it again"],
  ["launcher_old", 1, "flash: this Launcher cannot install over USB", "update the Launcher (its home screen: Update Launcher)"],
  ["install_refused", 1, "flash: the Launcher refused the image (its words follow)", "read `error`; a broken or foreign image: build it again"],
  ["wrong_device", 1, "flash: the device on the port is not the --target", "leave out `--target` (the device says what it is)"],
  ["not_an_app", 1, "flash --bin: not an application image (a merged image, bootloader, ELF …)", "give build/<project>.bin; a Launcher comes back with `devices recover`"],
  ["launcher_image", 1, "flash: the code or the file is a launcher, which the Launcher does not install this way", "give the firmware's build/<project>.bin; the Launcher updates itself; `devices recover` restores the official Launcher"],
  ["download_only", 1, "flash: the device takes a UF2 file copied onto it (Mystrix), no Launcher", "`versions download VCODE --target …` and copy it onto the device"],
  ["unsupported_platform", 1, "flash and log: the USB cable is used on macOS and Linux only (board: also Windows, through python's hidapi)", "on Windows: the website in Chrome or Edge (a firmware's page: 用 USB 线安装; a local BIN: /firmware › Flash a local file); the log: CardenzaHAL's tools/cardenza_usb.py console (pip install hidapi)"],
  ["launcher_full", 1, "flash: no room on the device for the file (the Launcher names what to delete)", "delete that, or other software, on the device; then run it again"],
  ["device_crashed", 1, "log: the device printed a panic, an abort or a restart", "read log_tail; decode the backtrace with the build's ELF (xtensa-esp32s3-elf-addr2line -pfiaC -e build/<project>.elf …)"],
  ["log_timeout", 1, "log --until: no line matched before --seconds ran out", "read log_tail: the firmware did not print it (or starts slower: a longer --seconds)"],
  ["python_missing", 1, "log and board on macOS: python3 is needed for CoreMIDI", "xcode-select --install"],
  ["board_not_found", 1, "board: no Cardenza on USB (no firmware with CardenzaHAL's USB device, and no serial port either)", "plug it in with a data cable (not a charging-only one), turn it on, start the firmware"],
  ["board_no_usb", 1, "board: the firmware does not start CardenzaHAL's USB device (only its serial port is there, as with the template), so it has no development channel", "add `CardenzaHAL::USB::Init();` after `CardenzaHAL::Init()` in app_main, rebuild, flash; `log` reads its console meanwhile"],
  ["board_in_launcher", 1, "board: the device is in its 203 Launcher, not running a firmware", "start the firmware from the Launcher (or `flash --bin` a build), run it again"],
  ["hal_too_old", 1, "board: the firmware's CardenzaHAL is older than the development channel (IDENTIFY says protocol 1, or no answer to HELLO)", "rebuild the firmware with a current CardenzaHAL (update its submodule), install it (`flash --bin`), run it again"],
  ["dev_channel_off", 1, "board: the firmware was built with CONFIG_CARDENZA_HAL_USB_DEV off", "turn it on in its sdkconfig, build and install it again"],
  ["hidapi_missing", 1, "board on Windows: python's hidapi package (or python) is missing", "`pip install hidapi`"],
  ["board_refused", 1, "board: the firmware refused the request (`reason`: no framebuffer, a path not found, no SD card, …)", "read `error` and `hint`"],
  ["board_busy", 3, "board: the firmware's development channel has 8 requests queued", "wait a moment, run it again"],
  ["board_timeout", 3, "board: the device stopped answering, or part of an answer was lost more than once", "run it again; if it keeps happening, read its log (`log`)"],
  ["board_lost", 3, "board: the device went away (restarted, unplugged)", "plug it in, let the firmware start, run it again"],
  ["board_protocol", 1, "board: the firmware's answer is not what this 203c reads", "update 203c (`npm install -g 203c`); else report it"],
  ["dir_not_empty", 1, "new: the folder is there and not empty", "give another DIR"],
  ["git_missing", 1, "new, project diff: git is not installed", "install git"],
  ["not_a_repository", 1, "project diff local: this folder is not a git repository", "compare two versions or a fork instead, or git init"],
  ["no_source", 1, "project diff: that version or fork has no source archive (and no repository)", "versions published with publish_source: true carry one; pick another version"],
  ["skill_incomplete", 1, "skill install: this 203c lacks the skill's files", "npm install -g 203c again"],
  ["skill_failed", 1, "skill install: the skills folder could not be written", "check the folder, or give another with --dir"],
  ["git_failed", 1, "new: git init failed", "read the message; check the folder"],
  ["hal_unavailable", 3, "new: CardenzaHAL could not be added (the network, GitHub)", "run it again"],
  ["no_template", 1, "new: no project template for that device yet", "read the device's guide (products/<device>/README.md)"],
  ["no_firmware", 2, "inbox, link: no CODE given and 203.json has no code (nothing published yet)", "publish the first version, or give the code (firmware mine lists yours)"],
  ["no_project", 2, "link: no 203.json here or above", "run it in the project's folder (new or init makes 203.json)"],
  ["flash_failed", 1, "esptool stopped while writing the device (`log_tail`)", "put the device in download mode, check the cable and port, run it again: a device can always be restored again"],
  ["device_offline", 1, "the device is off or not online (设备没开机或没联网)", "ask the user to switch it on with Wi-Fi (in its Launcher or any CardenzaHAL firmware), then retry"],
  ["source_secrets", 1, "the source archive holds files that look secret (`files`)", "remove them from git (and revoke any pushed secret), commit, retry; or --no-source"],
  ["source_unavailable", 1, "no source archive can be made here (not a git repository, no commit, git missing)", "commit the source, or --no-source"],
  ["device_busy", 3, "the device is installing something", "wait, then retry"],
  ["not_installable", 1, "launchers are flashed from the website, never sent", "flash it on the website"],
  ["risk_not_accepted", 1, "a third-party launcher", "add --accept-risk if the user accepts it"],
  ["unreachable", 3, "the API cannot be reached (ENOTFOUND in a sandboxed agent: its allowlist may lack the community's hosts)", "check the network / --api; `doctor`; a sandbox: `help sandbox`"],
  ["network_blocked_sandbox", 1, "a network allowlist on the way blocked the community (an agent's sandbox: Claude Code on the web, Codex …; a 403 with x-deny-reason: host_not_allowed, or one that is not the API's; in a sandbox also ENOTFOUND or a proxy's certificate)", "only the user can allow it: cardenza.203.io and apps.203.io in the environment's network settings (`hint` says where; `help sandbox`), then run it again"],
  ["network_blocked_cdn", 1, "the firewall in front of the site (Cloudflare) blocked the request (`ray`)", "nothing to fix in the project: other programs (curl, urllib, web fetches) are blocked, 203c normally passes; report it with the Ray ID or try another network"],
  ["unavailable", 3, "the API or a provider failed", "try again later"],
  ["upload_failed", 3, "an upload failed", "run the same command again: it resumes"],
];

// ---------------------------------------------------------------------------------------------
// Help topics: recipes with exact commands. {P} is how 203c was run (e.g. node scripts/203c.mjs).

export const TOPICS = {
  start: {title: "Start here: what to run for what", text: `
Always add --json when a program reads the answer. Run doctor first. Never guess a code: list them.

  You want to …                                   Run
  make a new firmware for a Cardenza (start here)  {P} new "My firmware" --summary "…" --json   ({P} help new: build, try, publish)
  check that everything works (sign-in, API, quota) {P} doctor --json
  is 203c, or this project's CardenzaHAL, outdated? {P} updates --json   (the commands of the work say so on stderr)
  sign in (needed for everything else)             {P} login --json   (opens the browser; remote: help signin)
  see your firmware and their codes                {P} firmware mine --json
  publish a firmware version (new or existing)     {P} publish --bin build/app.bin --name "My synth" --summary "…" --dry-run --json
                                                   then the same without --dry-run
  publish to a firmware you have (by its code)     {P} publish --firmware K7M2QX --bin build/app.bin --dry-run --json
  release the next version (203.json here)         raise version.txt, add "## <version>" to CHANGELOG.md, build, then
                                                   {P} publish --dry-run --json   then   {P} publish --json
  publish a CI build to the dev channel            {P} publish --channel dev --version "$(cat version.txt)-dev.$RUN" --commit "$SHA" --json
  the simulator version (Play) of a version        {P} sim build --json   then   {P} sim upload VCODE build-web/site --json   ({P} help sim)
  set the cover picture                            {P} firmware cover K7M2QX cover.png --json
  change the page (summary, description, links)    {P} firmware edit K7M2QX --summary "…" --source-url https://github.com/… --json
  write how to use it (a tutorial, lessons)        {P} tutorial new --json, then {P} tutorial publish --dry-run --json   ({P} help tutorials)
  see why a version was sent back                  {P} versions check VCODE --json
  try a build on your Cardenza (USB cable)         {P} flash --bin build/<project>.bin --json   then   {P} log --json
  look inside it running: screen, keys, memory, SD {P} board info --json, board screen, board press …   ({P} help board)
  everything about this project's firmware (an AI) {P} sync --json   (.203/community.md: page, versions, requests, comments, forks)
  what users asked for and said since last time    {P} inbox --json   ({P} help project)
  compare a fork (魔改版) with this project          {P} project forks --json   then   {P} project diff FORK --patch
  link this project to its firmware / move it      {P} link --dry-run --json   ({P} help link)
  share a sound pack / project / work              {P} sounds upload bank.ccpreset --firmware OFFICIAL --title "…" --dry-run --json
  find the official firmware's code                {P} firmware list --official --json
  change someone's firmware (fork, clone, publish) {P} fork V6QK28 my-synth --json   ({P} help fork)
  start a project / its 203.json                   {P} init --json   ({P} help manifest; the rules: {P} rules)
  attach the source to the firmware page           "publish_source": true in 203.json, or {P} source upload VCODE --json
  what is left of today's limits                   {P} quotas --json
  change your name or bio                          {P} me edit --name "…" --bio "…" --json

Topics: {P} help <topic>   (new project publish sim ci manifest link fork source rules channels versions checks page cover pictures tutorials sounds projects works models signin errors devices board requests launchers sandbox admin)`},

  new: {title: "A new firmware for the Cardenza: make, build, try, publish, listen", text: `
1. {P} new "My firmware" --summary "What it does" --json     a folder with CardenzaHAL (git submodule) and its template,
   named; it builds as it is. (Changing someone's firmware instead: {P} help fork.)
2. cd my-firmware; write main/main.cpp with CardenzaHAL's public headers (its README: the hardware and its API).
3. python3 components/CardenzaHAL/tools/cardenza.py build    the HAL's build tool: checks ESP-IDF 5.3, the HAL, 203c,
   then idf.py build (ESP-IDF is exported for it when the shell has not); build/<project>.bin. Its doctor says what is missing.
4. {P} flash --bin build/<project>.bin --json                  onto the Cardenza on the USB cable through its 203 Launcher
   (which stays: never idf.py flash), no sign-in; {P} log --json reads what it prints (--until "ready" makes it a test).
5. {P} login (once on a computer: the browser asks the user to approve), then {P} publish --dry-run --json and
   {P} publish --json: the first version makes the firmware and writes its code into 203.json (commit it).
6. CI from then on (.github/workflows/firmware.yml, trusted publishing: {P} help ci; {P} link links the repository).
7. {P} inbox --out .203/inbox.md --json                         what people asked for and said since the last look;
   {P} dev read CODE N --json for a request in full, {P} comments add … to answer.
The rules for every step: {P} rules.`},

  project: {title: "The project's firmware on the community: page, versions, what people say, forks, differences", text: `
In the project's folder (203.json's code; or give CODE), read-only, plain text or --json:
{P} sync --json                       everything in one report for an agent: .203/community.md and community.json (the page,
                                     every version and its notes, requests and comments with replies, merges, forks);
                                     new since the last sync marked. Run it before planning changes.
{P} project show --json               the page: summary, description, tags, licence, links, cover, counts, newest versions
{P} project versions --page 2 --json  every version with its notes, status, checks and source archive (24 a page)
{P} project feedback --new --json     requests (votes, status, answered?, discussion) and comment threads (replies, likes),
                                     merge requests; --since last|all|DATE; each with the version newest when it was written
{P} project forks --json              its forks (魔改版), forks of forks too: base version, newest versions, counts
{P} project diff FORK                 a fork against this folder, file by file (+/- lines); --patch for the unified diff
{P} project diff 1.0.0 1.1.0          two versions of this firmware (their source archives: publish_source: true)
{P} inbox --json                      only what is new since the last look (and versions sent back, notifications)
Answer and track from here: {P} comments add firmware CODE --parent ID --body "…", {P} comments add request CODE/N --body "…",
{P} dev update CODE N --status planned|in_progress|done (owners; never notifies). The last look is kept in .203/state.json.`},

  link: {title: "Binding a project to its firmware, and moving it", text: `
A project is bound to its firmware by 203.json's "code" (the first publish writes it), the firmware's page by its source
link, and CI by the trusted publisher (the GitHub repository whose Actions may publish its versions).
{P} link --dry-run --json          what it would change, from 203.json and this folder's git remote
{P} link --json                    203.json's code and source, the page's source and clone links, this repository as
                                   trusted publisher (workflow firmware.yml when there); idempotent
{P} link CODE --json               bind this project to your firmware CODE (a project made before, a new clone)
{P} link --move --json             the repository moved (renamed, transferred, a new one): also unlink the old ones
A firmware cannot change hands: someone else makes their own from it ({P} fork CODE) and links that.`},

  signin: {title: "Signing in", text: `
1. {P} doctor --json                → "signed_in": true? Then you are done.
2. {P} login --json                 → opens the user's browser on the site (/authorize): they sign in to the site if
   it asks and approve "203c on <this computer>"; the browser comes back to 203c, which saves the token
   ({"status":"signed_in","via":"browser", …}). It waits up to 5 minutes (--timeout SECONDS): give the call that
   long. With --json it first writes {"status":"waiting","via":"browser","authorize_url":"…"} on stderr (the link,
   should the browser not open). (OAuth's authorization code with PKCE and a redirect to 203c on 127.0.0.1.)
Where no browser can be opened, a personal token: the user makes one on the site (设置 › 个人令牌, /me/tokens), then
   {P} login --with-token              → asks for it on the terminal (not shown), checks it and saves it
                                          ({"status":"signed_in","via":"token", …})
   {P} login --with-token < token.txt  the same, the token read from stdin
An agent running remotely with nobody at its terminal: a code the user approves on the site instead:
2. {P} login --no-browser --json    → {"status":"pending","via":"code","verify_url":"…/activate?code=ABCD-EFGH","user_code":"ABCD-EFGH"}
   Give the link and the code to the user: they open it signed in and approve (the Launcher signs in the same way).
3. {P} login --wait --json          → waits (up to 10 minutes) and saves the token: {"status":"signed_in", …}
   (with --json, while it waits: {"status":"waiting","via":"code","verify_url":…,"user_code":…} on stderr)
Admins: the admin commands need the admin scope: {P} login --admin --json (the user ticks admin on the approval page;
it replaces the saved sign-in; an admin sign-in lasts 30 days). Without it: exit 4, admin_scope_required.
Every way saves a personal token, listed on the site (设置 › 个人令牌); it has no end: it works until it is deleted
there or {P} logout revokes it. Every command but login, logout, help, doctor and rules needs the sign-in (exit 4
without it).
Never ask the user for passwords or cookies, or to paste a token into the chat (they paste it on their own terminal).
In GitHub Actions: trusted publishing, no secret (help ci): {P} login --github-oidc --firmware CODE. The token is read from
--token, else COMMUNITY_TOKEN, else (GitHub Actions) the run's own from login --github-oidc, else ~/.config/203c/token
(mode 600). {P} whoami says which sign-in this is (kind cli or ci, scopes; publish: a run's trusted publishing).
A token is a "cli" or "ci" credential: it publishes and acts for the user but never sees personal data or manages
personal tokens or devices (that is the website's). A token deleted on the site gives exit 4: sign in again.`},

  publish: {title: "Publishing a firmware version", text: `
One command does it all and can be run again safely (it never makes duplicates; it resumes a half-done run):

  {P} publish --bin build/app.bin --name "My synth" --summary "A short line (≤ 100 characters)" --dry-run --json
  {P} publish --bin build/app.bin --name "My synth" --summary "…" --json

- Firmware: --firmware CODE (yours) or --name NAME (your firmware of that name; made when there is none).
- BIN: --bin build/<project>.bin (the application image idf.py writes; not bootloader.bin, not the merged
  image, not the .elf). Several devices: --bin cardenza=a.bin --bin nullperator=b.bin (default device: cardenza).
- Version: --version 1.4.0, or left out: the BIN's own version (its app description). No leading v.
- Channel: --channel stable (default), beta or dev. "release" is stable, "nightly" is dev.
- Notes: --notes "…", --notes-file CHANGES.md, or the CHANGELOG.md entry of that version (needed on stable).
- Also: --cover cover.png, --tags groovebox,synth, --source-url https://github.com/…, --commit $(git rev-parse HEAD).
- Pictures: the gallery must end with 3-5 different screenshots of it (203.json's publish.images, else the firmware's):
  publish stops before uploading anything without them (gallery_pictures; {P} board screen takes them; help pictures).
- The description (--description-file, 203.json's description_file: docs/description.md): short, for people deciding to
  install; over 1500 characters a warning, over 3000 refused (description_too_long; {P} help description).
- Simulator version: for a CardenzaHAL firmware it also builds the same source for the browser (CardenzaHAL's
  tools/cardenza_web.py) and uploads it with the BIN; the community shows Play once it boots ({P} help sim).
  --no-sim leaves it out; --sim-dir DIR uploads one built before; --hal DIR / --project DIR when not found.
- It waits for the automatic checks (up to --timeout 1200 seconds) and prints the codes, the page and Play.
- Exit 0: published (or already was). 5: sent back (see {P} help checks). 6: a warning needs --force / --yes
  (or a simulator version that cannot be built on stable / beta: install Emscripten, fix the code, or --no-sim).
In a project, 203.json holds all of this and publish needs no flags ({P} help manifest; --notes and other flags win over it).`},

  ci: {title: "Publishing from CI: trusted publishing from GitHub Actions (no secret)", text: `
No token is stored anywhere (the user, 2026-11-17): the community trusts GitHub Actions' own identity (its OIDC token)
for the repositories a firmware's owner links, as PyPI's trusted publishing does.

1. Once, the firmware's owner links the repository (its page › 开发 › 自动发布, or signed in as the owner):
     {P} firmware publishers add K7M2QX --repository OWNER/NAME --workflow firmware.yml [--environment release] --json
   (workflow: the file in .github/workflows that publishes; environment: only jobs in that GitHub environment;
   --channels stable,beta,dev limits it further; at most 5 a firmware; {P} firmware publishers list K7M2QX).
2. The workflow's job asks GitHub for its token and signs in for that run only:
     permissions:
       id-token: write           # the job's OIDC token (and contents: read for the checkout)
     …
     - run: {P} login --github-oidc --firmware K7M2QX --json
     - run: {P} publish --channel dev --version "$(tr -d '[:space:]' < version.txt)-dev.$GITHUB_RUN_NUMBER" --commit "$GITHUB_SHA" --json
   login asks for a token whose audience is the API's base (--api / COMMUNITY_API), exchanges it for a credential that
   publishes this firmware's versions only (its BINs, notices, notes, source archive, simulator version) for 15 minutes,
   keeps it in $RUNNER_TEMP/203c (emptied after the job) and renews it by itself while publish waits for the checks.
   login --github-oidc may run again in the same job at any time (each run exchanges a new token); publish resumes.
- The channel follows the run's ref: a tag vX.Y.Z may publish stable (and beta, dev), vX.Y.Z-beta.N beta (and dev),
  anything else (a branch, a pull request) dev only; beyond it: exit 1, oidc_channel.
- The credential never changes the firmware's page: publish leaves 203.json's page fields, the cover and the channels
  as they are (a note says so); the dev / beta channel is turned on once by the owner ({P} firmware edit K7M2QX --dev).
- Nor its pictures: a gallery that is not 3-5 different screenshots is a warning (gallery_short, and a ::warning
  annotation on the run), never a failure, so releases go on; the owner adds them once (the edit page's 图片, or
  {P} firmware images add K7M2QX … signed in), which a publish signed in yourself requires (help pictures).
- Refusals: oidc_untrusted (no publisher matches: the message says what: repository, workflow, environment),
  oidc_invalid (GitHub's token: audience, expired, replayed …), oidc_unavailable (no permissions: id-token: write).
- The label: version.txt's version, then -dev.<run>: unique, in order, and the BIN says the same version
  (outside a project: --firmware K7M2QX --bin build/app.bin). No --notes needed on dev.
- dev keeps the newest 30 versions; 300 dev and 30 stable/beta versions a day per account.
- A retried run with the same --version resumes its draft; a published one is reported as done (exit 0).
- Exit 5 fails the job when the checks send the build back; the JSON has the failed steps and the log.
- The simulator version is built too when the runner has Emscripten (emsdk) and Python 3; on dev a build that
  cannot be made is a warning (the BIN alone). --no-sim in CI that has no Emscripten.
- Elsewhere (another CI, a script): a personal token made on the site (设置 › 个人令牌) in COMMUNITY_TOKEN still works.`},

  manifest: {title: "203.json (the project file)", text: `
Every firmware project keeps 203.json at its root, committed with the source: what it is called, its version,
who makes it, what it was made from. {P} init writes it from what the project says (CMake project(), version.txt or
the git tag, you, the git remote, LICENSE); {P} publish reads it (here or above; --manifest PATH) and needs no flags
in the common case; flags win over it; it writes "code" back after the first publish. The full rules: {P} rules.

  {
    "format": 1,
    "name": "My Synth",
    "code": "K7M2QX",                     // null until the first publish (then written back)
    "version": "1.4.0",                   // leave it out when there is a version.txt (that is the version)
    "author": "your community name",
    "summary": "≤ 100 characters: what it does",
    "tags": ["groovebox"],
    "devices": ["cardenza"],
    "source": "https://github.com/me/my-synth",      // the clone link (+ .git) is derived
    "license": "MIT",                     // SPDX id, or proprietary
    "forked_from": {"code": "V6QK28", "version": "0.3.0"},   // null for an original
    "publish_source": true,               // attach a source archive (git archive of the commit) to every version
    "publish": {"channel": "stable", "bins": {"cardenza": "build/my_synth.bin"}, "notes_file": "CHANGELOG.md",
                "cover": "docs/cover.png", "description_file": "docs/description.md",   // the page's text (help description)
                "images": ["docs/screens/home.png", {"file": "docs/screens/seq.png", "caption": "The sequencer"},
                           "docs/screens/mix.png"]}   // the gallery: 3-5 different screenshots (help pictures)
  }
- A "code" that is someone else's firmware (you cloned theirs): publish makes your fork of it first, rewrites "code"
  and "forked_from", and says so ("fork" in --json). A "forked_from" without "code": the new firmware is its fork.
- No passwords or tokens in it (refused). Unknown keys are refused (x-… keys are yours). The earlier 203c.json is
  still read; {P} init moves it over.`},

  channels: {title: "Channels", text: `
stable  releases, published by hand; release notes expected; the Launcher installs it by default
beta    a big change to try (switch it on: {P} firmware edit CODE --beta)
dev     CI builds, many a day; the newest 30 are kept (switch it on: {P} firmware edit CODE --dev)
Other words are refused with the right one: release/production → stable, nightly/ci → dev, rc/preview → beta.`},

  versions: {title: "Version labels and codes", text: `
A label is 1-32 of 0-9 A-Z a-z . _ + - (1.4.0, 1.4.0-rc1, dev.20261114.3); unique per firmware. A leading
v is dropped (v1.4.0 → 1.4.0). Every version gets its own 6-character code (the firmware's code installs the
newest on a channel; a version code installs that exact version). Codes use 23456789 and A-Z without I and O,
any case. Publishing the same label again: done if it is the same BIN, refused if it is another.`},

  checks: {title: "When the checks send a version back (exit 5)", text: `
1. {P} versions check VCODE --json    → check.steps (which step failed on which device) and check.log
2. A real failure (a panic, a boot loop, too large): fix it and publish a NEW version label.
3. A false positive (the emulator has no display, keys, audio or Wi-Fi; your firmware only fails for want
   of them): {P} versions appeal VCODE --message "<why the check is wrong: 10-2000 characters>" --json
   then follow it: {P} feedback mine --json
A version sent back keeps its label for 30 days: publish the fix as the next label (e.g. 1.4.1).`},

  page: {title: "A good firmware page", text: `
What people see first: the cover (16:9 picture) and the summary (≤ 100 characters). A good page has:
  - a summary that says what it does (not just the name): "Four-track groovebox: drums, Juno, DX7, sampler"
  - a cover: {P} firmware cover CODE cover.png (PNG/JPEG/WebP, 16:9, e.g. 1280x720, ≤ 2 MB); a stable version needs one
  - pictures shown large above the description, like a store page's: {P} firmware images add CODE shot.png (help pictures)
  - a description (Markdown) for people deciding to install: what it is, 3-6 features, what it needs, how to start
    (aim for 800 characters, at most 3000; the manual goes in its tutorial): docs/description.md, {P} help description
  - 3-5 different screenshots in the gallery ({P} board screen; help pictures): 203c publish needs them
  - how to use it (keys, menus, settings) as a tutorial, not in the description: {P} tutorial new, then tutorial publish (help tutorials)
  - one category tag: instrument, groovebox, tool, network or game (--tags groovebox,synth)
  - the source: --source-url https://github.com/… and --clone-url https://github.com/….git
  - release notes on every stable version
{P} firmware checklist CODE --json shows what is missing, with the command for each.`},

  cover: {title: "Covers", text: `
{P} firmware cover CODE cover.png --json        (owner; admins for any firmware)
{P} firmware cover CODE --remove --yes --json   (then: a fork shows its original's, else the screen after boot, else grey)
PNG, JPEG or WebP up to 2 MB, shown 16:9 cropped to the centre: 1280x720 is ideal. --dry-run checks it.
Without a picture of its own a fork shows its original's, marked Fork (魔改版) in the top-left corner; else the
screen after boot of its web build; else a plain grey cover. A stable version needs one of them: publish stops with
cover_required (give --cover cover.png, or send the web build); --without-cover only when the user wants none.
Beta and dev versions (CI's builds) never need one. The checklist says what shows now: {P} firmware checklist CODE --json`},

  description: {title: "Writing the description: short, for people deciding to install (the guide, its template and an example)", text: "{DESCRIPTION}"},

  pictures: {title: "Pictures: the gallery above the description (3-5 screenshots), and pictures in the description", text: `
A firmware's page shows its gallery large above the description (like a store page: the picture chosen, then a strip
of thumbnails; nothing when there are none), and the description places pictures of its own where its text says.
PNG, JPEG or WebP up to 2 MB each, a caption of at most 60 characters; at most 9 in the gallery, 20 in the description.
The gallery is 3-5 different screenshots of the firmware itself: the screen people see first, then its main features.
Take them with it running on a Cardenza on the USB cable (CardenzaHAL's USB started: CardenzaHAL::USB::Init()):
  {P} board screen --out docs/screens/1.png       (a PNG of the screen; the page enlarges it pixel for pixel)
A device without a screen: photos of it running. The browser simulator has no screenshot of its own.
{P} publish, signed in yourself, needs them: it stops before uploading anything (gallery_pictures, exit 1) unless the
gallery it leaves (203.json's publish.images, else the firmware's as it is) holds 3-5 pictures, all different (by
their SHA-256); firmware images add / edit --place gallery stop past 5, and taking pictures out below 3 is a warning.
A trusted-publishing run (CI) cannot change pictures: it warns (gallery_short, also a GitHub annotation) and goes on.
On the website the gallery is a suggestion. A launcher's gallery is not held to it.
{P} firmware images add CODE home.png --caption "The home screen" --json       the gallery (in the order added)
{P} firmware images add CODE flow.png --description --json                    the description's: prints ![](image:ID)
{P} firmware images list CODE --json        both, with ids, captions and whether the description uses each
{P} firmware images order CODE ID ID … --json    {P} firmware images edit CODE ID --caption "…" --place gallery|description
{P} firmware images remove CODE ID --yes --json  {P} firmware images prune CODE --dry-run --json (the description's unused)
In the description: ![words](image:ID) (any of its pictures, gallery or description). The pictures of one line stand
side by side, as high as each other (up to 3); a picture on a line of its own as wide as the text; the words (else
the picture's caption) under it. Pictures from other sites are not loaded: they show as links.
From files: --description-file README.md (and 203.json's publish.description_file) uploads the local pictures it names
(![words](docs/shot.png), relative to the file) as the description's and sends image:ID instead; a picture the
firmware has already (the same file) is not sent again; pictures in code are left alone, and one that cannot go up
(missing, a GIF, over 2 MB) stays as written with a warning. 203.json's publish.images is the gallery:
  "images": ["docs/home.png", {"file": "docs/seq.png", "caption": "The sequencer"}]
publish makes the gallery exactly that, in that order (adds what is missing, sets the captions given, removes the rest);
--dry-run says what it would change. A trusted-publishing run (CI) changes no pictures: the owner does.`},

  tutorials: {title: "Tutorials (教程): how to use a firmware, in the one tutorial format", text: `
A firmware's page has a 教程 / Tutorials tab: its owner's tutorials (official) first, then other people's. A tutorial is
a guide written in the tutorial format (reference/tutorial-format.md, the Cardenza Learn guide's: lessons of short
steps, each step a sentence or two, the keys it asks for lit on a drawing of the board, a screenshot of the screen),
or a link to one elsewhere (https only; it opens through a page that says you are leaving the community).
Description or tutorial: the description says in a few lines what the firmware is and why one would want it, with
pictures; how to use it (key tables, menus, every setting) is a tutorial, and the description links to the tab.

The file (JSON, at most 200 KB; no comments, no trailing commas):
  {"format": "203-tutorial/1", "firmware": "K7M2QX", "languages": ["zh", "en"],
   "title": {"zh": "上手", "en": "Getting started"}, "summary": {…},
   "lessons": [{"title": {…}, "lead": {…}, "steps": [
     {"say": {"zh": "按 {{key:fn}}：打开菜单。", "en": "Press {{key:fn}}: the menu opens."}, "keys": ["fn"], "image": "shots/menu.png"}]}]}
One language ("languages": ["en"]): every text may be a plain string. 1-30 lessons, 1-30 steps each (300 in all), a
step's words at most 280 wide (a Chinese character counts 2). In a step's words: {{key:fn}} (a key cap; fn+s: pressed
together), **bold**, *italic*, \`code\`, [words](https://…); nothing else (no HTML, no line breaks). Keys are the caps'
names (esc 1 … del, tab q … \\, fn shift a … ' ok, ctrl opt alt z … / space, home; enter up down left right). A step's
"image" is a PNG, JPEG or WebP file (≤ 2 MB) relative to the file: publish uploads it and sends image:<id>.

{P} tutorial new --json                       docs/tutorial.json to start from (203.json's firmware; --languages en)
{P} tutorial check --json                     every error with its line and column (the community's own checks)
{P} tutorial publish --dry-run --json         then without --dry-run: uploads the pictures it lacks (once, by SHA-256),
                                             adds your tutorial or changes it (one each a firmware); your file stays as written
{P} tutorial link CODE https://… --title "…" --json    a link (up to 5 of yours a firmware)
{P} tutorial list CODE --json    {P} tutorial show CODE ID --out docs/tutorial.json    {P} tutorial rm CODE ID --yes --json
{P} tutorial hide CODE ID --reason "…" --json  (your firmware: hide someone's tutorial; --off shows it again)
On the site: the tab's 写教程 / Write a tutorial (an editor that checks while you type) and 添加链接 / Add a link.`},

  sounds: {title: "Sound packs (official firmware only; the section may not be open yet)", text: `
{P} firmware list --official --json            → the official firmware's code (e.g. CardenzaSynth)
{P} sounds upload pads.ccpreset more.ccpreset pad-c3.wav --firmware CODE --title "Warm pads" --tags pad --dry-run --json
Banks are CardenzaSynth's .ccpreset files (from the card: CardenzaSynth/Presets/<engine>/); samples .wav;
--preview demo.mp3 (a recording). The engine is read from the banks (several engines: mixed).
Community firmware are refused: sounds belong to official firmware. Sounds, projects and works open later: until
then only admins can share there (section_closed; {P} sections --json shows "open" for each).`},

  projects: {title: "Projects (official firmware only)", text: `
{P} projects upload SONG.ccproj kick.wav --firmware CODE --title "Night drive" --preview song.mp3 --dry-run --json
Exactly one .ccproj (from the card: CardenzaSynth/Projects/) and its .wav samples; format and tempo are read
from the file.`},

  works: {title: "Works (official firmware only)", text: `
{P} works upload song.wav --firmware CODE --title "Rain" --tags lofi --dry-run --json
Audio (.wav .mp3 .ogg .flac .m4a, ≤ 50 MB) or video (.mp4 .webm, ≤ 300 MB) made with an official firmware;
--version VCODE says which version. 20 a day.`},

  models: {title: "3D models", text: `
{P} models upload case.stl --title "Desk stand" --license CC-BY-4.0 --target cardenza --dry-run --json
Licences: CC-BY-4.0, CC-BY-SA-4.0, CC-BY-NC-4.0, CC-BY-NC-SA-4.0, CC0-1.0, all-rights-reserved.
An STL is its own preview (203c draws the thumbnail); STEP/3MF/OBJ need --preview mesh.stl --thumbnail pic.png.`},

  errors: {title: "Errors and exit codes", text: `
With --json an error is one JSON line on stderr:
  {"error":"what was wrong","code":"machine_code","field":"the flag","hint":"what to do","next":["the exact next command"],"exit":N}
Act on "code"; run next[0] when it fits what the user wants. Exit codes:
{EXITS}
Codes:
{CODES}`},

  fork: {title: "Changing someone's firmware: fork, clone, publish (provenance)", text: `
  {P} fork V6QK28 my-synth --json               your fork (found again if you have one) + its source in ./my-synth + 203.json there
                                               ("code": your fork, "forked_from": {"code": "V6QK28", "version": …})
  cd my-synth  (change it, build it: idf.py build)
  {P} publish --dry-run --json                 from inside: goes to your fork, the BIN from build/
  {P} publish --json
- Cloned someone's repository yourself? Its 203.json names their code: publish makes your fork automatically and
  rewrites 203.json (commit it). Nothing is ever published as an original by mistake.
- Published as an original but it was made from another firmware? Record it: {P} firmware based-on YOURS ORIGIN --version 0.3.0
  (ORIGIN none clears it). A private original needs --unlock (firmware unlock ORIGIN --password …).
- clone CODE [DIR] alone clones a firmware's source (its clone link, else its parent's); "no_clone_url" when nobody bound a repository.
- Put your changes in a repository of your own: "source" in 203.json, or {P} firmware edit FORK --source-url https://github.com/you/repo
- Keep the original's licence terms and credit it. Offer changes back: {P} merges open PARENT --from FORK --title "…"`},

  source: {title: "Source code on the firmware page", text: `
A version may carry its source archive: the commit's tracked files (git archive), checked for secrets here and on the
server (.env, *.pem, *.key, id_*, *secret*, credentials, tokens in text), at most 16 MB. The firmware page offers it
with the repository link and git clone.
  {P} source check --json                 what it would hold; any file that looks secret, and why
  "publish_source": true in 203.json      publish attaches it to every version (--source / --no-source for one run)
  {P} source upload VCODE --json          attach it to a version published before (the commit checked out here)
  {P} source delete CODE VCODE --yes      remove it
Submodules (e.g. CardenzaHAL) are not in it. Uncommitted changes are not in it: commit first.`},

  rules: {title: "The firmware project rules", text: `
{P} rules                  CardenzaHAL's docs/FIRMWARE-PROJECT.md (the copy in this skill): dependencies and setup, required
                           files, HAL rules, build commands, what the community checks, versions, forks, publishing
{P} rules --online         the newest copy (the site's /develop.md)`},

  sim: {title: "Simulator versions (Play)", text: `
A version's simulator is its simulator version: the same source compiled for the browser with CardenzaHAL's
web target. The community plays a version (Play, /play/VCODE) only when its simulator version boots: the
checker opens it in a headless browser and it must post {"cardenza_sim":"ready"} within 15 s.

  {P} publish … --json             a CardenzaHAL firmware: builds it (python3 <HAL>/tools/cardenza_web.py build <project>)
                                   and uploads it with the BIN; "simulator": {"status": "boots", "play_url": …}
  {P} sim build --json             only build it (default into <project>/build-web/site); prints where
  {P} sim upload VCODE build-web/site --json    add it to a version (also one already published); only when it differs
  {P} sim check VCODE --json       boots / fails (why) / not checked yet; --again checks it again

- The HAL: the project's own CardenzaHAL when it has the web target (web/ and tools/cardenza_web.py), else --hal DIR,
  else a clone of ${"https://github.com/203-Systems/CardenzaHAL"} kept in ~/.cache/203c/CardenzaHAL.
- Needs Python 3, CMake and Emscripten (emsdk): {P} doctor shows them.
- The build's exit codes: 1 the firmware's own code does not compile for the browser (the errors are shown);
  3 it does not follow the HAL (it calls the chip's drivers: the calls, headers and source files are listed;
    the BIN is published, no Play);
  4 Emscripten or CMake missing (the install hint is shown).
- sim.json (written by the build) says the device, the HAL version, the toolchain and the key map: the
  player shows the keys. --no-sim publishes without one (no Play).`},

  launchers: {title: "Launchers: only the official 203 Launcher", text: `
The account binding and sign-in live in the 203 Launcher, so the community offers only the official one
(the user, 2026-11-14). Launchers are made and forked by the community's admins only: anyone else gets
"Only the official 203 Launcher is offered here" (code launcher_official_only, 403 from the API).
Publish your firmware as an app (leave out --launcher): people install it with the 203 Launcher.
The official 203 Launcher is a system firmware (the user, 2026-11-17): in no list, search or category and with no page
for people; devices get it from 我的设备 (升级启动器) or the Launcher's own update page, and the recovery flash. Its
releases are published like any launcher by an admin: {P} publish with "launcher": true (a merged full-flash image;
the app in it becomes the Launcher image its own update installs).`},

  devices: {title: "Installing firmware on a device: over a USB cable (no sign-in) or sent over Wi-Fi", text: `
Over a USB cable (线刷), signed in or not, no bound device: the device on, on a cable to this computer (macOS or Linux;
Windows: the firmware's page on the website, 用 USB 线安装, in Chrome or Edge), in its 203 Launcher or running a firmware:
{P} flash CODE --json                                     a firmware's newest build for that device (--channel beta|dev) or a version,
                                                          downloaded with the community's signature: the Launcher updates it later
{P} flash --bin build/app.bin --json                       a local application image
{P} flash CODE --dry-run --json                            what it would write (nothing downloaded, no device needed)
{P} log --json                                            what it prints: a running firmware's console (CardenzaHAL's system channel,
                                                          over its MIDI or HID), else the serial port (the Launcher, a firmware without USB)
{P} log --until "ready" --seconds 30 --json                a test: exit 0 at the line, 1 at a crash or when it never comes
The port: --port PORT, else the one USB serial port there is. Nothing to switch on: the Launcher's console runs from power-on.
A device running a firmware (CardenzaHAL: no serial port) is restarted into its Launcher first, over its MIDI (Linux: ALSA
raw MIDI, else its HID; macOS: CoreMIDI through python3), and the port it comes back on is used; a Launcher counting down
to the firmware is kept in its menus. If that fails (firmware_unreachable, launcher_countdown): on the device, press HOME (the
key left of the screen) and choose Back to Launcher in its system menu, then run it again; a firmware without that
menu (released before it): hold FN while it starts (or while 203c restarts it) and the Launcher stays in its menus.

Sent over Wi-Fi to a bound device (signing in and binding are for Wi-Fi):
{P} devices list --json                                   → each device's id, online (and where: its Launcher or a firmware running), running
{P} devices send ID CODE --json                            install it (do not run); --start: install and run; --channel beta|dev
{P} devices send ID CODE --no-wait --json                  only send it (the answer's id), then {P} devices status ID COMMAND [--wait] --json
The device must be on and online: in its Launcher, or running a CardenzaHAL firmware that stays online (the HAL's presence
service; it hands over to its Launcher. Cardenza Synth 0.2.1 does not: leave it for the Launcher first).
Off or not online: refused at once (device_offline), nothing is queued. Launchers are never sent (flashed on the website).
{P} devices update-launcher ID --json                      its 203 Launcher to the newest for it (devices list: launcher_update);
                                                          up_to_date when it runs it; followed until the new Launcher runs (started)
Devices sign in and out on the website only (我的设备, the profile's tab; /me/devices leads there): a Launcher shows a code, the user approves it at /activate.

A device that no longer starts (恢复刷机, the website's /recover; no bound device needed):
{P} devices recover --dry-run --json                       what would be written: the official Launcher and official firmware
{P} devices recover --out DIR --json                       the images, plan.json and flash.sh (esptool), nothing written
{P} devices recover --port /dev/ttyACM0 --yes              written now with Python's esptool (pip install esptool)
It erases the whole internal flash (installed firmware, Launcher settings, Wi-Fi, its sign-in); the SD card is not touched.
The device in download mode: in its Launcher esptool resets it there; a running CardenzaHAL firmware (no port) is restarted
into it by 203c; else (Cardenza) hold HOME while plugging the USB cable in.`},

  board: {title: "A running firmware over USB: what it is, its memory, screen, keys, crash and SD card (203c board)", text: `
A firmware on CardenzaHAL that starts USB answers these over the HAL's development channel (CardenzaHAL docs/usb-dev.md),
without a line of its own and at no cost until asked. No sign-in. The firmware must be built with a current CardenzaHAL
(hal_too_old otherwise: update the HAL submodule, build, {P} flash --bin build/<project>.bin). The device on the cable,
running the firmware (not in its Launcher). macOS and Linux over its MIDI (Linux: ALSA raw MIDI, else hidraw; macOS:
CoreMIDI through python3); Windows through python's hidapi (pip install hidapi).

{P} board info --json                     name, version, code, build time, ELF SHA-256, CardenzaHAL commit, Launcher, chip, reset reason
{P} board partitions                      the flash table: offsets and sizes, app images, NVS entries used, the running one, free flash
{P} board memory --window 2000            heaps (internal, PSRAM, DMA) and tasks: stack left, CPU over 2 s
{P} board storage | status | i2c --json   the SD card; display, keys, system menu, USB; the I2C bus
{P} board screen --out shot.png           the next frame as a PNG (240 × 135; prints the path)
{P} board press down down ok              keys pressed as by a finger: cap names (esc 1 q fn shift opt alt ok space del …),
                                          up down left right (the arrows on ; . , /), home (the side key); fn+s together;
                                          --hold MS, --gap MS; 10-57 or k1-k57 are the HAL's key numbers
{P} board keys fn:down s:down 200 s:up fn:up    step by step (a number: ms to wait); keys held are let go 10 s later
{P} board coredump --out crash.elf --elf build/<project>.elf    the last crash: task, backtrace decoded
                                          (xtensa-esp32s3-elf-addr2line on PATH: ESP-IDF's export); --erase after
{P} board files ls CardenzaSynth          the SD card: ls, get PATH [LOCAL], put LOCAL [PATH], rm, mkdir, mv FROM TO
                                          (paths from the card's root; a progress line on a terminal)
A test with screenshots: {P} flash --bin …, {P} log --until "ready" --seconds 30, then board press … and board screen.
Only a serial port there? board_no_usb: the firmware does not start CardenzaHAL's USB device (the template does not): add
CardenzaHAL::USB::Init(); after CardenzaHAL::Init() in app_main, rebuild, flash ({P} log reads its console meanwhile);
board_in_launcher: the device is in its 203 Launcher, start the firmware.
Ctrl-C stops a transfer (the device is told to stop; an upload is aborted). Errors: board_not_found, firmware_unreachable
(Linux: the audio group, or close what holds its MIDI port: a {P} log, a DAW), hal_too_old, dev_channel_off,
board_refused (the firmware's reason), board_busy, board_timeout, board_lost.`},

  requests: {title: "Requests and the developer tracker", text: `
{P} inbox --json                                          everything new about this project's firmware (203.json) since
                                                          the last look: requests, comments, merges, versions sent back
{P} inbox --out .203/inbox.md --json                      the same as Markdown in the project, for an agent to read
{P} dev list --firmware CODE --sort top --json           your firmware's requests with their internal status
{P} dev read CODE N --json                                the request, votes and discussion (the specification)
{P} dev update CODE N --status in_progress --progress 10 --note "Plan: …" --json
{P} dev update CODE N --status done --progress 100 --note "In 1.5.0 (VCODE)" --json
The tracker is internal (nobody is notified); tell users with {P} comments add request CODE/N --body "…" --json.`},

  sandbox: {title: "Running in a sandboxed agent (Claude Code on the web, Codex cloud…): allowing the community's hosts", text: `
A coding agent in a sandbox reaches only the hosts its environment allows. Claude Code's default environment allows
package registries and GitHub (npm install -g 203c and {P} skill install work there; Codex cloud installs in its setup
script); the 203 community is on no default list: the user allows ${COMMUNITY_HOSTS.join(" and ")}.
{P} doctor --json checks both and says what blocks them. The errors:
  network_blocked_sandbox  the sandbox's allowlist blocked the host (a 403 with x-deny-reason: host_not_allowed; a 403
                           that is not the community's JSON; in a sandbox also ENOTFOUND or a proxy's certificate)
  network_blocked_cdn      the firewall in front of the site (Cloudflare) blocked the request: not the sandbox
  unreachable (ENOTFOUND)  the name does not resolve: offline, or a sandbox whose allowlist lacks it

{STEPS}`},

  admin: {title: "Admins", text: `
{P} admin issues --json, {P} admin issue N --json, {P} admin issue-update N --status false_positive --reply "…"
{P} admin override VCODE --note "…" (publish a false positive), {P} admin recheck VCODE
{P} admin official CODE (the official tag on a firmware published here: its owner keeps publishing it with 203c), {P} admin reports, {P} admin hide|unhide|delete KIND REF --reason …`},
};

export function topicText(name, prog, lang = defaultLang()) {
  const topic = TOPICS[name];
  if (!topic) return null;
  const exits = EXIT_TEXT.map(([code, text]) => `  ${code}  ${text}`).join("\n");
  const codes = ERROR_CODES.map(([code, exit, meaning, todo]) => `  ${code.padEnd(19)} exit ${exit}  ${meaning}; ${todo}`).join("\n");
  // The description's guide is the website's (reference/description-guide.md), in the client's language.
  const text = topic.text === "{DESCRIPTION}" ? guidePart(lang).replace(/ \{#[a-z-]+\}$/gm, "") + (lang === "zh" ? `\n\n网页版：${GUIDE_URL}` : `\n\nOn the website: ${GUIDE_URL}`) : topic.text;
  return `${topic.title}\n${text.replace(/\{P\}/g, prog).replace("{EXITS}", exits).replace("{CODES}", codes).replace("{STEPS}", () => sandboxSteps("en"))}\n`;
}

// ---------------------------------------------------------------------------------------------
// The API's refusals in 203c's words: hint and next commands. ctx: {cmd(changes), run(words…),
// tokenSource, args, flags, command}.

export function explainApiError(error, ctx) {
  const code = error.code, field = error.data?.field, message = error.message;
  const status = error.status;
  const out = {code, field, hint: undefined, next: [], exit: EXIT.refused};
  const a = ctx.args ?? {}, o = ctx.flags ?? {};
  const fwCode = a.CODE ?? o.firmware;
  if (code === "usage") { out.exit = EXIT.usage; out.hint = "Fix the command (see --help)"; out.next = [ctx.run([...ctx.words, "--help"], {json: false})]; return out; }
  if (BLOCKED_CODES.has(code)) {
    // A network on the way, not the API: the user changes the sandbox's settings (or, the CDN, the site's owner).
    const lang = ctx.client?.lang ?? defaultLang();
    out.exit = EXIT.refused;
    out.hint = error.hint ?? (code === "network_blocked_sandbox" ? sandboxSteps(lang, {more: [error.data?.host]}) : lang === "zh" ? OFFLINE_ZH : OFFLINE_EN);
    out.next = [...new Set([ctx.cmd({}), ctx.run(["doctor"])])];
    return out;
  }
  if (code === "unreachable" || status === 0) {
    out.code = "unreachable"; out.exit = EXIT.later;
    out.hint = `Check the network and the API address (${ctx.api}); --api URL or COMMUNITY_API sets it. Then run the same command again.`;
    const dns = /\b(ENOTFOUND|EAI_AGAIN)\b/.exec(message ?? "");
    if (dns && isDnsFailure(dns[1])) out.hint += " " + maybeSandbox(ctx.client?.lang ?? defaultLang());
    out.next = [ctx.run(["doctor"])];
    return out;
  }
  if (code === "upload_failed") { out.exit = EXIT.later; out.hint = "Run the same command again: it resumes where it stopped."; out.next = [ctx.cmd({})]; return out; }
  if (status >= 500 || code === "unavailable") {
    // HTTP 5xx: "unavailable" (the server's own codes such as internal, or none, are not 203c's "internal").
    if (/^http_5|^internal$/.test(code ?? "")) out.code = "unavailable";
    out.exit = EXIT.later; out.hint = "The service failed for now; run the same command again in a minute."; out.next = [ctx.cmd({})]; return out;
  }
  switch (code) {
    case "oidc_channel":
      out.hint = `This run may publish on ${(error.data?.channel_allowed ?? []).join(", ") || "no channel"}: stable needs a run on a tag vX.Y.Z, beta a tag vX.Y.Z-beta.N (anything else: dev), and only the channels its trusted publisher allows`;
      return out;
    case "signin_required": case "authorization_pending":
      out.exit = EXIT.signin;
      if (ctx.tokenSource === "oidc") {
        out.hint = "This run's trusted-publishing credential ended or was revoked (its publisher removed?): sign in again (it is repeatable), then run the same command (it resumes)";
        out.next = [ctx.run(["login", "--github-oidc"]), ctx.cmd({})];
        return out;
      }
      out.hint = ctx.tokenSource === "env" ? "COMMUNITY_TOKEN holds a token the API does not take (deleted on the site, or mistyped): make a new one on the site (设置 › 个人令牌, /me/tokens) or unset it and sign in"
        : ctx.tokenSource === "file" ? `The saved token (${ctx.tokenFile}) does not work any more (deleted on the site?): sign in again`
        : ctx.tokenSource === "flag" ? "The --token given is not valid: check it, or sign in instead"
        : "Not signed in: sign in (login opens the browser; where there is none, login --with-token takes a personal token, login --no-browser gives a code to approve)";
      out.next = [ctx.run(["login"]), ctx.run(["login", "--no-browser"])];
      return out;
    case "forbidden":
      if (error.data?.reason === "publish_only") {
        out.code = "publish_only";
        out.hint = "This is a run's trusted-publishing credential (GitHub Actions): it publishes its firmware's versions and nothing else. Page edits, other firmware and account actions need the owner's own sign-in (the site, or 203c login on a computer).";
      } else if (/only read|write scope|没有 write 权限/i.test(message)) {
        out.hint = "This token can only read. Sign in again and let the user tick write on the approval page (or make a token with write).";
        out.exit = EXIT.signin; out.next = [ctx.run(["login"])];
      } else if (field === "kind" || /203 Launcher|官方 203 Launcher/.test(message)) {
        out.code = "launcher_official_only";
        out.hint = "Only the official 203 Launcher is offered (the account binding and sign-in live in it): launchers are added and forked by the community's admins only. Publish your firmware as an app: leave out --launcher (and do not fork a launcher).";
        out.next = [ctx.run(["help", "launchers"], {json: false})];
      } else if (error.data?.reason === "section_closed" || error.data?.section || /not open/i.test(message)) {
        out.code = "section_closed";
        out.hint = `The ${error.data?.section ?? ""} section is not open yet: only admins can add things there for now. Nothing to fix on your side; share it when it opens.`;
        out.next = [ctx.run(["sections"])];
      } else if (/owner|所有者|作者/i.test(message) && ["merges", "dev", "requests", "source"].includes(ctx.words?.[0])) {
        out.code = "not_yours";
        out.hint = "Only the firmware's owner (or an admin) can do this (merge requests, the tracker, source archives): ask them.";
      } else if (/admin scope|没有 admin 权限/i.test(message)) {
        // An admin whose sign-in was given read and write only: sign in again with the admin scope.
        out.code = "admin_scope_required"; out.exit = EXIT.signin;
        out.hint = "This sign-in lacks the admin scope. Sign in again with it: login --admin (the approval page lets an admin tick admin; it replaces the saved sign-in, " +
          "an admin sign-in lasts 30 days). A token made on the site needs the admin scope too.";
        out.next = [ctx.run(["login", "--admin"])];
      } else if (/admin/i.test(message)) {
        out.hint = "Only admins can do this (and only with a token that has the admin scope).";
      } else if (/hub/i.test(message)) {
        out.code = "official_from_hub";
        out.hint = "This official firmware's versions come from the Launcher hub (its CI publishes them there): 203c cannot publish them. Publish your own firmware (publish --name …).";
        out.next = [ctx.run(["firmware", "mine"])];
      } else if (/owner/i.test(message) && fwCode) {
        out.code = "not_yours";
        out.hint = `Firmware ${fwCode} is not yours. Fork it and publish to your fork, or use one of your own (firmware mine).`;
        out.next = [ctx.run(["firmware", "fork", fwCode, "--name", "<your fork's name>", "--summary", "<what your fork changes>"]), ctx.run(["firmware", "mine"])];
      } else out.hint = "Not allowed: it is not yours, or the token lacks the scope (write / admin).";
      return out;
    case "banned": out.hint = "This account is banned" + (error.data?.banned_until ? " until " + error.data.banned_until : "") + "."; return out;
    case "password_required":
      out.hint = "A private firmware: unlock it with its password, then pass --unlock with the token it answers.";
      if (fwCode) out.next = [ctx.run(["firmware", "unlock", fwCode, "--password", "<password>"])];
      return out;
    case "password_wrong": out.hint = `Wrong password (${error.data?.attempts_left ?? "few"} attempts left): ask the owner.`; return out;
    case "not_found": case "not_for_target":
      out.hint = code === "not_for_target" ? "That version has no BIN for that device: pick a version or device that matches (versions show VCODE)."
        : "Nothing has this code or id. Codes are 6 characters (any case); check it, or find it:";
      if (code === "not_found" && ctx.words?.[0] === "devices" && /command|命令|指令/i.test(message)) { out.hint = "That device has no command with this id: devices send answers the id."; return out; }
      if (code === "not_found" && ctx.words?.[0] === "devices" && /device|设备/i.test(message)) { out.hint = "No device of yours has this id: the list has them."; out.next = [ctx.run(["devices", "list"])]; return out; }
      if (code === "not_found" && ["merges", "requests", "dev"].includes(ctx.words?.[0]) && fwCode && /request|请求|需求|合并/i.test(message)) {
        out.hint = "That firmware has no such number: the list has them.";
        out.next = [ctx.words[0] === "dev" ? ctx.run(["dev", "list", "--firmware", String(fwCode)]) : ctx.run([ctx.words[0], "list", String(fwCode)])];
        return out;
      }
      if (code === "not_found") out.next = [ctx.run(["firmware", "mine"]), ...(fwCode ? [ctx.run(["code", String(fwCode)])] : [])];
      return out;
    case "rate_limited":
      out.exit = EXIT.later;
      out.hint = `Too many for now${error.data?.retry_after ? `: wait ${error.data.retry_after} seconds` : ""}, then run the same command again.`;
      out.next = [ctx.cmd({})];
      return out;
    case "too_large": out.hint = "The file is over the limit: make it smaller (help " + (ctx.topic ?? "errors") + ")."; return out;
    case "expired": out.hint = "It ran out: start again."; out.next = [ctx.cmd({})]; return out;
    case "deleted": out.hint = "It was deleted: nothing more to do with it (running the same command again answers the same)."; return out;
    case "device_offline": out.hint = "The device is off or not online (设备没开机或没联网): ask the user to switch it on with Wi-Fi (its Launcher, or any CardenzaHAL firmware running), then run the same command again."; out.next = [ctx.cmd({})]; return out;
    case "reauth_required": out.exit = EXIT.signin; out.hint = "The website needs a recent sign-in for this: the user signs in again on the site."; return out;
    case "device_busy": out.exit = EXIT.later; out.hint = "The device is installing something: wait a minute, then run the same command again."; out.next = [ctx.cmd({})]; return out;
    case "not_installable": out.hint = "Launchers are flashed from the website (Web Serial), never sent to a device."; return out;
    case "risk_not_accepted": out.hint = "A third-party launcher may leave the device unable to start. Only if the user accepts that:"; out.next = [ctx.cmd({add: {accept_risk: true}})]; return out;
    case "conflict": out.hint = conflictHint(message, ctx, out); return out;
    case "rejected": out.exit = EXIT.rejected; return out;
    case "invalid": return invalidHint(out, field, message, ctx);
    case "invalid_name": out.hint = "A firmware's name is " + NAME_RULE + ". Choose another (--name)."; return out;
  }
  if (/^command_/.test(code)) { out.hint = "The device reported a failure: read `error`; run the same command again once it is fixed."; out.next = [ctx.cmd({})]; return out; }
  out.hint = "Read `error`; see help errors.";
  return out;
}

/** ENOTFOUND outside a known sandbox: offline, or a sandbox that says nothing of itself. */
export function maybeSandbox(lang = "en") {
  return lang === "zh"
    ? `如果这是在 AI 的沙箱里（Claude Code 网页版、Codex 云端……），它的网络白名单里没有的域名也会这样解析不了：请用户放行 ${COMMUNITY_HOSTS.join("、")}（203c help sandbox 有每一步）。`
    : `In a sandboxed agent (Claude Code on the web, Codex cloud…) a host its network allowlist lacks fails like this too: ask the user to allow ${COMMUNITY_HOSTS.join(" and ")} (203c help sandbox has the steps).`;
}

function conflictHint(message, ctx, out) {
  if (/appeal/i.test(message)) { out.next = [ctx.run(["feedback", "mine"])]; return "It is appealed already: feedback mine shows the appeal, its status and our reply"; }
  if (/already exists|label/i.test(message)) return "That version label is taken: publish the next label, or see the versions: versions list CODE";
  if (/missing/i.test(message)) return "A BIN was not uploaded: run the same publish command again (it resumes and uploads what is missing)";
  if (/sent back/i.test(message)) return "That version was sent back by the checks: versions check VCODE, then publish a new label or appeal";
  if (/channel is off/i.test(message)) return "Turn the channel on: firmware edit CODE --beta / --dev";
  if (/at most 50/i.test(message)) return "An account has at most 50 firmware: publish to one of yours (firmware mine) or delete one";
  return "It clashes with what is there: read `error`";
}

const FIELD_HINTS = {
  summary: "The summary (the cover blurb) is 1-100 characters: what the firmware does, not just its name.",
  name: "A name is 1-64 characters.",
  version: "A version label is 1-32 of 0-9 A-Z a-z . _ + -, unique per firmware (no spaces).",
  channel: "Channels: stable, beta or dev; beta and dev must be switched on first.",
  tags: "Tags: comma-separated, each 1-24 lower-case letters, digits or - (firmware 8, works 5); official is given by admins.",
  source_url: "An https:// link, e.g. https://github.com/you/repo",
  clone_url: "An https:// link ending in .git, e.g. https://github.com/you/repo.git",
  source_commit: "7-40 hex digits: --commit $(git rev-parse HEAD)",
  password: "A private firmware needs a password of 8-64 characters (--password …).",
  firmware: "Sounds, projects and works are only for official firmware: use an official firmware's code (firmware list --official).",
  license: "Licences: CC-BY-4.0, CC-BY-SA-4.0, CC-BY-NC-4.0, CC-BY-NC-SA-4.0, CC0-1.0, all-rights-reserved.",
  title: "A title is 1-80 characters (posts 1-120).",
  notes: "Notes are up to 10000 characters.",
  description: "A description is up to 20000 characters (Markdown).",
  files: "The files list is wrong: see help sounds / help projects / help models.",
  engine: "Engines: dx7, juno, sampler, drums, or mixed.",
  cursor: "A cursor comes from the previous answer's next_cursor with the same filters.",
  targets: "Devices: cardenza, nullperator (203c targets lists them).",
};

function invalidHint(out, field, message, ctx) {
  out.hint = FIELD_HINTS[field] ?? "Fix the value the message names.";
  if (field === "firmware") {
    out.code = "official_only";
    out.next = [ctx.run(["firmware", "list", "--official"])];
  }
  if (field === "channel" && /off/i.test(message) && (ctx.args?.CODE || ctx.flags?.firmware)) {
    const code = ctx.args?.CODE || ctx.flags?.firmware;
    out.code = "channel_off";
    out.next = [ctx.run(["firmware", "edit", code, "--" + (/dev/.test(message) ? "dev" : "beta")])];
  }
  return out;
}
