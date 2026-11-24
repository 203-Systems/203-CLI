---
name: 203-community
description: Work with the 203 Systems firmware community (community.203.io; live copy cardenza.203.io/community) through its CLI, 203cli, and make firmware for 203 devices the recommended way (a guide and hardware reference per product: Cardenza 鸣片, NullPerator 零序, Mystrix 魔矩; 203cli rules, 203.json). Use it to start a Cardenza firmware from CardenzaHAL's template (new), try it on the user's device over USB (flash through the Launcher, log, board), publish versions from a laptop or CI (trusted publishing) with simulator versions and source archives, create or fork firmware and clone their source, bind a project to its firmware or move it (link), set the cover and page, read what the community has about the project's firmware for planning (sync: page, versions, requests, comments, forks; project diff) and keep the tracker, see why the checks sent a version back and appeal it, share sound packs, projects, works and 3D models, send firmware over Wi-Fi, search and comment, and, for admins, moderate.
---

# 203 community

Everything goes through one command, `203cli` (Node 18+, nothing else to install):

```sh
203cli <command> … --json
```

Install (macOS, Linux, Windows; Node.js 18+): `npm install -g 203cli`, then `203cli skill install` puts this skill where
the agents read it (run it again after an update; `203cli doctor` says when it is older than the command). Where `203cli`
is not found, run `node <this skill's folder>/scripts/203cli.mjs` instead (e.g.
`node ~/.claude/skills/203-community/scripts/203cli.mjs`): the same CLI. **Run it from the firmware project's folder**
(where `203.json` and `build/` are): paths are relative to the current folder, and `publish` reads `./203.json`.
The commands 203cli prints in `next` are ready to run as they are (with the full path when `203cli` is not on PATH).
Making a firmware? Read the device's page first (below); for the Cardenza, `203cli rules` prints the firmware project
rules (CardenzaHAL's `docs/FIRMWARE-PROJECT.md`: dependencies, files, HAL rules, builds, checks, publishing).

## Products: what to read first

Each 203 device has its recommended way to make firmware: what to build on, the toolchain, how to try a build without
breaking the device, how to publish it, the hardware reference. Read the page of the device you build for, in this
skill's folder (also at https://github.com/203-Systems/203-CLI):

| Device | Read | Build on | Publish |
|---|---|---|---|
| Cardenza (鸣片) | `products/cardenza/README.md`, then `203cli rules` | CardenzaHAL, ESP-IDF 5.3.5 | `publish` (device `cardenza`, the default) |
| NullPerator (零序) | `products/nullperator/README.md` | the NullPerator firmware tree, ESP-IDF 5.3.5 (developer preview) | `publish --bin nullperator=….bin` |
| Mystrix, Mystrix Pro, Mystrix 2 (魔矩) | `products/mystrix/README.md` | Matrix OS, ESP-IDF 5.3.x | `publish --bin mystrix=….uf2 --bin mystrix2=….uf2` (download only) |

`products/README.md` compares them. Reach the hardware only through the device's HAL or OS, never by flashing the
whole chip of a device that has the 203 Launcher (install through it: `flash --bin FILE`).

## Hard rules

1. **Always add `--json`.** The answer is JSON on stdout; an error is one JSON line on stderr (its last line; `login`
   may print one `{"status":"waiting",…}` line before it while it waits). `--help --json` describes any command as JSON.
2. **Run `doctor` first** (`203cli doctor --json`): it says whether you are signed in and what to do if not.
   Every command but `login`, `logout`, `help`, `doctor`, `rules`, `updates` and `ops` needs the sign-in (exit 4 without it), except what
   goes over a USB cable: `flash`, `log`, `board` and `devices recover` work signed out (signing in is for Wi-Fi: sending to a bound device), and `new`.
   On a person's own terminal a command that needs the sign-in starts it by itself (the browser, once on a computer).
3. **Before anything that publishes or uploads, run it with `--dry-run` first.** It checks the files and values the way the server will and prints the plan. Go on only when it says `"ready": true`.
4. **Never guess a code.** Codes are 6 characters (e.g. `K7M2QX`). Get them from `firmware mine --json`, `firmware list --official --json` or `search WORDS --json`.
5. **On an error, read `code`, `hint` and `next`.** `next[0]` is the exact command to run next. If it contains `<…>`, replace that part with the real value (the CLI refuses placeholders). Exit 6 means a decision: add `--force` / `--yes` only if the user wants it.
6. Never ask the user for passwords, cookies or tokens (a personal token goes into `login --with-token` on their own terminal, never into the chat). Do not invent summaries, release notes or appeal reasons: write them from what you know, or ask.
7. **Working on a firmware that is published (203.json has a `code`)? Run `203cli sync --json` first and read
   `.203/community.md`**: its page, every version's notes, what users asked for and said (requests, comments, replies),
   merge requests and forks. Plan from it; answer people with `comments add` when the work is done.
8. Paths are relative to the current folder. Give the application image `build/<project>.bin` (not `bootloader.bin`, not a merged image, not the `.elf`); the CLI names the right file when you give a wrong one.

## What to run

| You want to … | Run |
|---|---|
| make a new firmware for a Cardenza (from nothing) | `new "NAME" --summary "…" --json`, then workflow 0 |
| check that everything works | `doctor --json` |
| is 203cli, or this project's CardenzaHAL, out of date? | `updates --json` (below: "Update notices") |
| sign in | `login --json` (opens the browser; the user approves on the site; it waits up to 5 minutes) — no browser: the user runs `login --with-token` (a personal token from the site) — remote: `login --no-browser --json` → give the user `verify_url` and `user_code` → `login --wait --json` |
| see your firmware and their codes | `firmware mine --json` |
| install a firmware on a device over a USB cable (线刷; no sign-in, no bound device; macOS / Linux / Windows) | `flash CODE --dry-run --json`, then `flash CODE --json` (the device on and on a cable, in its Launcher or running a firmware: 203cli restarts a running firmware into its Launcher first; `--bin build/app.bin` for a local build, `--port PORT` when there are several) |
| read a device's log over the USB cable (no sign-in; macOS / Linux) | `log --json` (20 s; a running firmware's console, else the serial port); a test: `log --until "ready" --seconds 30 --json` (exit 0 at the line; 1 `device_crashed` at a panic, `log_timeout`) |
| look inside the firmware running on the user's Cardenza (no sign-in): what it is, memory and tasks, its screen, keys, last crash, SD card | `board info --json`, `board memory --json`, `board screen --out shot.png --json` (then look at the PNG), `board press down ok --json` (cap names; arrows are `; . , /`), `board coredump --elf build/<project>.elf --json`, `board files ls --json` (`help board`). It needs a firmware built with a current CardenzaHAL that calls `CardenzaHAL::USB::Init()`: `hal_too_old` and `board_no_usb` say what to change |
| read or change the board's settings over USB (no sign-in): volume and its limit, screen brightness, key lights, mic gain, language; the HAL's, shared by every firmware and in HOME > Settings (the user may call them device settings) | `board settings --json`, `board settings get volume --json`, `board settings set volume 50 --json` (the device keeps a value in range: `clamped`, and `changes` lists what moved; language: `en`, `zh`, `ja`, `id`, `vi`), `board settings reset --json` (exit 6 `needs_confirmation`: `--yes` only when the user asked to reset). A HAL from before 2026-11-23: `hal_too_old` |
| everything the community has about this project's firmware, for planning (203.json here) | `sync --json`, then read `.203/community.md` (the page, versions and notes, requests and comments with replies, merges, forks; new ones marked) |
| what users asked for and said since the last look | `inbox --json`, or `project feedback --new --json`; a request in full: `dev read CODE N --json` |
| the page, the versions, the forks | `project show --json`, `project versions --json`, `project forks --json` |
| what a fork or another version changed | `project diff FORK --json` (against this folder; `--patch` the unified diff), `project diff 1.0.0 1.1.0 --json` |
| bind this project to its firmware, or move it to a new repository | `link --dry-run --json`, then `link --json` (`--move` also unlinks the old repository's trusted publisher) |
| publish a firmware version (new or existing firmware) | `publish --bin build/app.bin --name "NAME" --summary "…" --dry-run --json`, then without `--dry-run` |
| publish to your firmware by its code | `publish --firmware CODE --bin build/app.bin --notes "…" --dry-run --json` |
| release the next version of your firmware (203.json here) | raise `version.txt`, add its `## <version>` to CHANGELOG.md, build; `publish --dry-run --json`, then `publish --json` (workflow 2) |
| a beta or a CI (dev) build | `publish --channel beta --dry-run --json`; CI: `publish --channel dev --version "$(cat version.txt)-dev.$RUN" --commit "$SHA" --json` |
| one build per device | `publish --bin cardenza=build/a.bin --bin nullperator=build-np/a.bin …` (`targets --json` lists the devices) |
| publish a Mystrix / Mystrix 2 build (Matrix OS: a UF2 file each, download only, never the Launcher's; two devices: the file goes to the one it is built for) | `publish --firmware CODE --bin mystrix=build/Mystrix1/MatrixOS-Mystrix1.uf2 --bin mystrix2=build/Mystrix2/MatrixOS-Mystrix2.uf2 --dry-run --json` |
| your versions, a version's state | `versions list CODE --json` (`--channel beta`, `--target cardenza`), `versions show VCODE --json`, `versions check VCODE --json` |
| the simulator version (Play) of a version | `sim build --json`, then `sim upload VCODE build-web/site --json`; `sim check VCODE --json` (workflow 6) |
| set the cover picture | `firmware cover CODE cover.png --json` |
| show screenshots large above the description (the gallery, like a store page) | 3–5 different screenshots of the firmware: `board screen --out docs/screens/1.png --json` with it running on a Cardenza on USB, then `firmware images add CODE docs/screens/1.png … --json` or 203.json's `publish.images` (publish needs 3–5; `firmware images list|edit|order|remove CODE …`; `help pictures`) |
| write the description | `help description` (the guide): for people deciding to install, not a manual: what it is, 3–6 features, what it needs, how to start; aim for 800 characters, at most 3000; in `docs/description.md` (`publish.description_file`) |
| put pictures in the description | `firmware images add CODE flow.png --description --json`, then `![words](image:ID)` in the text; or name local files in the description file (`![](docs/shot.png)`): `--description-file` uploads them (`help pictures`) |
| improve the page (summary, description, links, tags) | `firmware checklist CODE --json`, then the `fix` commands it lists |
| write how to use a firmware (a manual: keys, menus, settings) | a tutorial, not the description: `tutorial new --json` (docs/tutorial.json), write its lessons in the format of `reference/tutorial-format.md`, `tutorial check --json` (every error with its line and column), `tutorial publish --dry-run --json`, then `tutorial publish --json`; a link to one elsewhere: `tutorial link CODE URL --title "…" --json` (`help tutorials`) |
| start a firmware project / its 203.json | `rules`, then `init --json` (writes 203.json from CMake, version.txt, git, LICENSE) |
| change someone's firmware | `fork CODE DIR --json` (clones it and writes 203.json with `forked_from`; the same as `fork CODE --clone DIR`), build in DIR, then `publish --dry-run --json` inside DIR |
| record what your firmware was made from | `firmware based-on CODE ORIGIN --version LABEL --json` |
| attach the source to the firmware page | `"publish_source": true` in 203.json (publish attaches it), or `source upload VCODE --json`; `source check --json` first |
| what is left of today's limits | `quotas --json` |
| which sign-in this is (kind, scopes) | `whoami --json` (`credential`) |
| get a firmware's source | `clone CODE DIR --json` |
| see why a version was sent back | `versions check VCODE --json` |
| share a sound pack / project / work | `sounds upload … --firmware OFFICIAL --title "…" --dry-run --json` (workflow 4) |
| change your name or bio | `me edit --name "…" --bio "…" --json` |
| ask for something in a firmware, or report a problem with it, with pictures, a video or a log | `requests create CODE --title "…" --body-file report.md --attach screen.png --attach log.txt --json` (`--attach` repeats, at most 9: pictures ≤ 10 MB, videos ≤ 95 MB, other files ≤ 20 MB; `posts create`, `comments add` and `feedback` take it too) |
| feedback about the community itself (not a firmware) | `feedback --kind bug|idea --title "…" --message-file report.txt --attach shot.png --json` |
| where a request stands | `requests list CODE --status 正在完成 --json` (`status`: new 未处理, in_progress 正在完成, done 已完成, rejected 已拒绝), `requests show CODE N --json` |
| an admin action (`admin …`) | an admin sign-in has the admin scope: `login --admin --json` (exit 4 `admin_scope_required` says so) |
| anything else | `help start`, `help <topic>`, `<command> --help --json` |

Topics: `help start|new|project|publish|sim|ci|manifest|link|fork|source|rules|channels|versions|checks|page|description|cover|pictures|tutorials|sounds|projects|works|models|signin|errors|devices|requests|launchers|admin`.
Every command with its flags: `reference/cli.md`; every endpoint: `reference/api.md`; what the site does and the
command for each: `reference/parity.md`; the firmware project rules: `reference/firmware-project.md` (`203cli rules`); the
tutorial format: `reference/tutorial-format.md`.

**Official firmware.** An official firmware that has an owner (`owner` in `firmware show`) is that person's firmware:
they publish its versions with 203cli like any of theirs (yours if it is yours: `firmware mine` lists it). Only an
official firmware **from the Launcher hub** (`owner` null) takes no versions from 203cli (`official_from_hub`).

**203.json.** A firmware project keeps `203.json` at its root (name, code, version or version.txt, author,
summary, tags, devices, source, license, forked_from, publish_source, publish: channel/bins/notes_file/cover).
`publish` reads it and needs no flags in the common case, and writes `code` back. When its `code` is someone
else's firmware (a clone of theirs), `publish` makes your fork first, rewrites `code` and `forked_from` and says
so (`fork` in `--json`): tell the user, and commit 203.json.

## The common workflows

### 0. A new Cardenza firmware, from nothing to a release

"Make a metronome for the Cardenza" and the like. Read `products/cardenza/README.md` and `203cli rules` first.

```sh
203cli new "Pocket Metronome" --summary "A metronome: tap tempo, accents, a click" --json  # the project, CardenzaHAL inside
cd pocket-metronome                                     # write main/main.cpp with the HAL's public headers
python3 components/CardenzaHAL/tools/cardenza.py doctor # what this computer lacks (ESP-IDF 5.3.5, Emscripten, 203cli, sign-in)
python3 components/CardenzaHAL/tools/cardenza.py build  # the preferred build: checks, then idf.py build; --web: the browser version too
203cli flash --bin build/pocket_metronome.bin --json    # onto the user's Cardenza over USB, through its Launcher (never idf.py flash)
203cli log --until "ready" --seconds 30 --json          # did it start? (its log; device_crashed: decode the backtrace with the ELF)
203cli board screen --out shot.png --json               # what it shows (look at the PNG); board press …, board memory: help board
203cli login --json                                     # once on a computer (the user approves in the browser)
203cli publish --dry-run --json  then   203cli publish --json   # ask the user first; commit 203.json (its code)
203cli link --json                                      # this GitHub repository publishes from CI (trusted publishing)
203cli sync --json                                      # later, before each change: .203/community.md (requests, comments, forks)
```

### 1. Sign in

```sh
203cli doctor --json
# "signed_in": true → done. Otherwise:
203cli login --json
```

On the user's own computer `login` opens their browser on the site's sign-in page (`/authorize`): tell the user
"Approve 203cli in the browser that just opened (sign in to the site first if it asks)". It waits up to 5 minutes
(`--timeout SECONDS`), so give the call that long (or run it in the background); with `--json` it writes
`{"status":"waiting","via":"browser","authorize_url":"…"}` on stderr first (the link, if the browser did not open). It
answers `{"status":"signed_in","via":"browser","user":{…},"scopes":["read","write"],"saved":"~/.config/203cli/token"}`.
(It is OAuth's authorization code with PKCE and a redirect to 203cli on 127.0.0.1: nothing to copy.)

Where no browser can be opened, a personal token: the user makes one on the site (设置 › 个人令牌, `/me/tokens`)
and runs this in their own terminal on this computer (it asks for the token without showing it, checks it, saves it):

```sh
203cli login --with-token
# Paste a personal token (设置 › 个人令牌 on the site):
# Signed in as …; scopes read, write.
```

A script pipes it in instead: `login --with-token --json < token.txt` → `{"status":"signed_in","via":"token",…}`.
Never ask the user to paste a token into the chat.

An agent running remotely (over SSH, the user at no terminal of this computer) signs in with a code instead
(`--no-browser`; also chosen by itself when no browser can be opened):

```sh
203cli login --no-browser --json
# {"status":"pending","via":"code","verify_url":"https://cardenza.203.io/community/activate?code=ABCD-EFGH","user_code":"ABCD-EFGH",…}
```

Tell the user: "Open <verify_url> and approve the code <user_code>." Then (it waits up to 10 minutes; `--timeout`):

```sh
203cli login --wait --json
# {"status":"signed_in","via":"code","user":{"id":"…","name":"…"},"scopes":["read","write"],"saved":"~/.config/203cli/token"}
```

Every way saves a personal token, listed on the site under 设置 › 个人令牌 (Personal tokens). It has no end: sign in
once, and it works until it is deleted there or `logout` revokes it.

In GitHub Actions there is no token to store: **trusted publishing** (`help ci`). The firmware's owner links the
repository once (the firmware's page › 开发 › 自动发布, or `203cli firmware publishers add CODE --repository OWNER/NAME
--workflow firmware.yml`); the job has `permissions: id-token: write` and runs `203cli login --github-oidc --firmware CODE`,
then `203cli publish` as usual. That credential publishes the firmware's versions only (15 minutes, renewed by 203cli,
kept for the run; the channel follows the ref: tag `vX.Y.Z` stable, `vX.Y.Z-beta.N` beta, else dev), never changes
its page (publish leaves 203.json's page fields as they are, with a note), and `login --github-oidc` may run again
in the same job. Another CI: a personal token made on the site in `COMMUNITY_TOKEN`.
Exit 4 anywhere means: sign in again. A token publishes and acts for the user but never sees personal data and
never manages personal tokens, devices or bind codes (that is the website's: `devices bind-code|rename|unbind`
answer `web_only` with the page to open: 我的设备, the user's profile tab, which `/me/devices` leads to).

### 2. Publish a firmware version

```sh
203cli publish --bin build/my-synth.bin --name "My synth" \
  --summary "Four-track groovebox: drums, Juno, DX7 and a sampler" \
  --notes-file CHANGELOG.md --cover docs/cover.png --tags groovebox,synth \
  --source-url https://github.com/me/my-synth --dry-run --json
# {"status":"dry_run","ready":true,"plan":["make the firmware \"My synth\" (public)","set the cover to …",
#   "publish My synth 1.4.0 on stable with release notes",
#   "upload cardenza: build/my-synth.bin (1.8 MB, ESP32-S3 app 1.4.0, CardenzaHAL 0.1.0, 27 % of the Launcher's 6.6 MB)", …],
#  "problems":[],"warnings":[…],"next":["… publish … (the same command without --dry-run)"]}
```

If `ready` is true, run `next[0]`. It waits for the automatic checks (image, layout, a 20 s boot in an
emulator) and answers:

```text
{"status":"published","firmware":{"code":"K7M2QX","name":"My synth","url":"…/K7M2QX","created":true},
 "version":{"code":"V3X9PA","version":"1.4.0","channel":"stable","status":"published",…},
 "simulator":{"status":"boots","play_url":"…/play/V3X9PA","hal":{"version":"0.5.0",…},…},
 "urls":{"firmware":"…/K7M2QX","version":"…/V3X9PA","play":"…/play/V3X9PA"},"checklist":[…],"next":[…]}
```

Tell the user the firmware code (the Launcher installs it), the version code, the page URL and, when
`simulator.status` is `boots`, the Play link.

- In a project with `203.json` (the usual case) `publish --dry-run --json` alone is the whole command: the firmware
  (`code`), the BINs (`publish.bins`), the version (`version.txt`), the notes (CHANGELOG.md's `## <version>`), the
  cover, the page text, the notices and the source archive (`publish_source`) all come from it; flags win over it.
- The version defaults to `version.txt`, else the BIN's own version (its app description); `--version 1.4.0` sets it
  (no leading `v`). On stable and beta the BIN must say the same version (raise `version.txt`, build again).
- The channel defaults to `stable`; also `beta`, and `dev` for CI. `release` means stable, `nightly` means dev.
- Stable versions need release notes: `--notes "…"` (wins over 203.json's `notes_file`), `--notes-file CHANGELOG.md`
  (its entry for that version) or a `CHANGELOG.md` here. A dev build needs none (a missing CHANGELOG entry is skipped).
- `--name NAME` publishes to your firmware of that name, or makes it (then it needs `--summary`: at most 100 characters, saying what it does). `--firmware CODE` publishes to one you have.
- Running it again is safe: an interrupted run resumes; an already published version answers `"status":"already_published"` (exit 0).
- The gallery must end with 3–5 different screenshots of it (`publish.images`, else the firmware's as it is): without
  them publish stops before uploading anything (`gallery_pictures`, exit 1). Take them with the firmware running on the
  user's Cardenza (`board screen --out docs/screens/1.png --json`, 2, 3…), put them in `publish.images`, run it again;
  never publish someone else's pictures or ones that are not of this firmware. A trusted-publishing run (CI) only
  warns (`gallery_short`). The description over 3000 characters (pictures not counted) is refused
  (`description_too_long`), over 1500 warned about: shorten it as the guide says (`help description`), move the manual
  to its tutorial; never pad or cut it blindly.
- `--channel beta` / `dev` on a firmware whose channel is off stops with `channel_off` (exit 6): with the user's yes,
  `--yes` turns it on while publishing (the dry run with `--yes` is then ready).
- A CardenzaHAL firmware also gets its **simulator version**: publish builds the same source for the browser
  (`python3 <HAL>/tools/cardenza_web.py build <project>`), uploads it with the BIN, and the checker opens it; the
  site shows Play only when it boots. Run publish from the firmware's folder (or `--project DIR`). Workflow 6.

### 3. Make the page good

```sh
203cli firmware checklist K7M2QX --json
# {"complete":false,"items":[{"item":"a cover (a 16:9 picture; a stable version needs one)","ok":false,"before_stable":true,"fix":"… firmware cover K7M2QX cover.png --json"}, …]}
# (a fork without a picture shows its original's, marked Fork: ok, with "now" and "better", the command for its own)
203cli firmware cover K7M2QX docs/cover.png --dry-run --json    # PNG/JPEG/WebP, 16:9, ≤ 2 MB
203cli firmware cover K7M2QX docs/cover.png --json
203cli board screen --out docs/screens/1.png --json                                  # the firmware running on the user's Cardenza
203cli firmware images add K7M2QX docs/screens/1.png --caption "The home screen" --json  # 3–5 different ones, shown large above the description
203cli firmware edit K7M2QX --description-file docs/description.md --tags groovebox,synth \
  --source-url https://github.com/me/my-synth --clone-url https://github.com/me/my-synth.git --json
# docs/description.md: the guide's template filled in (help description: what it is, 3–6 features, needs, get started;
# aim for 800 characters). It may name local pictures, ![The grid](grid.png): they go up as the description's (once)
# The description says in a few lines what it is; how to use it (keys, menus, settings) is a tutorial (the 教程 tab):
203cli tutorial new --json                    # docs/tutorial.json: lessons of short steps, keys, screenshots
203cli tutorial check --json                  # the community's own checks: every error with its line and column
203cli tutorial publish --dry-run --json      # then without --dry-run (its pictures go up once; your file stays as written)
```

### 4. Share a sound pack, a project or a work (official firmware only)

```sh
203cli firmware list --official --json      # the official firmware's code, e.g. CardenzaSynth
203cli sounds upload pads.ccpreset pad-c3.wav --firmware CODE --title "Warm pads" --tags pad --preview demo.mp3 --dry-run --json
203cli projects upload NIGHT.ccproj kick.wav --firmware CODE --title "Night drive" --preview night.mp3 --dry-run --json
203cli works upload song.wav --firmware CODE --title "Rain" --tags lofi --dry-run --json
```

Then the same without `--dry-run`. Community firmware are refused (`official_only`). A section that is not
open yet answers `section_closed`: only admins share there for now; nothing to fix, tell the user.

### 5. A version the checks sent back (exit 5)

```sh
203cli versions check VCODE --json   # check.steps: which step failed; check.log: the boot log
```

- A real failure (a panic, a boot loop, too large): fix it, build, publish the next version label (`next` has the command).
- A false positive (the emulator has no display, keys, audio or Wi-Fi and the firmware only fails for want of them):
  `versions appeal VCODE --message "<the real reason, 10-2000 characters>" --json`, then `feedback mine --json` for our reply.

### 6. The simulator version (Play)

The same source compiled for the browser with CardenzaHAL's web target, uploaded with the BIN; the community
plays a version only when its simulator version boots (the checker's headless browser: the build must post
`{"cardenza_sim":"ready"}` within 15 s).

```sh
203cli doctor --json          # checks python, emscripten, cmake (needed to build it)
203cli sim build --json       # only build it: {"out":".../build-web/site","hal":{…},"files":[…]}
203cli sim upload VCODE build-web/site --json  # a version already published (only when it differs)
203cli sim check VCODE --json  # boots (play_url) / fails (report.detail) / not checked yet
```

- publish builds it by itself; `--no-sim` leaves it out, `--sim-dir DIR` uploads one built before, `--hal DIR`
  names the CardenzaHAL checkout (default: the project's own copy when it has the web target, else a cached clone).
- `sim_not_hal`: the firmware calls the chip's drivers (`unsupported` lists them): the BIN is published, no Play.
  `sim_toolchain` (exit 6 on stable / beta): install Emscripten as `hint` says, or `--no-sim` if the user agrees.
  `sim_build_failed` (exit 6): the firmware's own code does not compile for the browser (`build_log`). On dev these are warnings.
- Launchers: only the official 203 Launcher is offered (`launcher_official_only`): publish firmware as apps.

## Errors

With `--json` an error is one JSON line on stderr (the last line):
`{"error":"…","code":"…","field":"the flag","hint":"what to do","next":["the exact next command"],"exit":N}`

| exit | meaning | do |
|---|---|---|
| 0 | done (or it was already done) | report the result |
| 1 | refused (a file, a value, a permission) | fix what `hint` says; run `next[0]` |
| 2 | the command is wrong | run `next[0]` (the corrected command) or `<command> --help` |
| 3 | try again later (network, server, rate limit, checks still running) | run the same command again later |
| 4 | sign in | `login --json` (browser); no browser: the user runs `login --with-token`; remote: `login --no-browser --json`, then `login --wait --json` |
| 5 | sent back by the checks | workflow 5 |
| 6 | needs a decision (`needs_force`, `needs_confirmation`, `channel_off`, `cover_required`) | ask the user; add `--force` / `--yes` / `--without-cover` only if they agree |

| code | what to do |
|---|---|
| `signin_required` / `invalid_token` | sign in (workflow 1); a token the site does not take was deleted there or mistyped: a new one on 设置 › 个人令牌 |
| `not_yours` | fork it (`fork CODE --json`), or publish to your own (`firmware mine --json`) |
| `official_from_hub` | that official firmware is published by its CI through the Launcher hub; use your own firmware |
| `wrong_file` / `file_not_found` | use the file `hint` / `next` names (the app image `build/<project>.bin`) |
| `version_taken` | publish a new version (raise it in the source, build, publish) |
| `needs_force` | a quality warning (no notes on stable, a lower version, a BIN that says another version, a summary that only repeats the name): fix it, or `--force` if the user wants |
| `cover_required` | a stable version of a firmware with no cover at all: ask the user for a 16:9 picture (`--cover cover.png`, or `firmware cover CODE cover.png`) or send the web build; a fork shows its original's by itself; `--without-cover` only if the user wants none (beta and dev never need one) |
| `placeholder` | replace the `<…>` text with the real value (in a description: the template's, `help description`) |
| `gallery_pictures` | publish needs 3–5 different screenshots in the gallery: take them with the firmware running (`board screen --out docs/screens/N.png`), list them in 203.json's `publish.images` (or `firmware images add`), run it again; more than 5: keep the best; never invent pictures |
| `description_too_long` | the description is over 3000 characters (pictures not counted): rewrite it as the guide says (`help description`: what it is, 3–6 features, needs, get started), the manual to its tutorial, building to the README, history to the release notes |
| `official_only` / `section_closed` | sounds, projects and works: official firmware only / that section is not open yet |
| `sim_toolchain` / `sim_build_failed` / `sim_not_hal` | the simulator version (workflow 6): install, fix, or `--no-sim` with the user's yes |
| `simulator_fails` | the simulator version did not boot in the checker's browser: fix, `sim upload`, or `sim check VCODE --again` |
| `launcher_official_only` | only the official 203 Launcher is offered; publish your firmware as an app |
| `admin_scope_required` | an admin's sign-in without the admin scope: `login --admin --json` (exit 4) |
| `rate_limited` | wait `retry_after` seconds |
| `network_blocked_sandbox` | your sandbox's network allowlist blocks the community: only the user can allow `cardenza.203.io` and `apps.203.io` (below); tell them `hint`'s steps, then run `next[0]` |
| `network_blocked_cdn` | the site's firewall (Cloudflare) blocked the request, not your sandbox: tell the user (its `ray`); do it with 203cli, not curl or a web fetch |
| `invalid` (+ `field`) | fix that field as `hint` says |

All codes: `help errors` (trusted publishing: `oidc_untrusted`, `oidc_channel`, `oidc_invalid`, `oidc_unavailable`,
`publish_only`). Environment: `COMMUNITY_TOKEN` (a token; not needed in GitHub Actions), `COMMUNITY_API` (default
`https://cardenza.203.io/community/api`, the live copy until community.203.io exists), `COMMUNITY_LANG` (`zh` or `en`: the language of what the server writes; `--lang`
on any command), `NO_UPDATE_NOTIFIER` / `C203_NO_UPDATE_CHECK` (no update notices), `C203_NPM_REGISTRY` (an npm
mirror for the notices). What people wrote comes as they wrote it. Answer the user in their language (with a
Chinese-speaking user pass `--lang zh`).

## Update notices

The commands of the work (`sim`, `flash`, `log`, `board`, `new`, `fork`, `clone`, `init`, `link`, `publish`, `rules`,
`source`, `sync`) end with a line on stderr when something is out of date, and the firmware's build prints the same
as a CMake warning (CardenzaHAL's `cmake/require_203cli.cmake`); `doctor` lists them, `updates --json` asks now:

- `203cli: 203cli X is out (you have Y): npm install -g 203cli && 203cli skill install`: run both, then go on (the
  skill is a copy of the command: update it with it). `doctor` says it as `cli_outdated`.
- `203cli: CardenzaHAL in this project (components/CardenzaHAL) is N commits behind its main: git submodule update
  --remote components/CardenzaHAL, …`: update it as a change of its own: the command, build and test (on the device if
  one is attached), then commit the new pointer alone (`git add components/CardenzaHAL`). Mid-task, finish the task
  first, or tell the user. `hal_behind`.
- `… is not a clean copy of upstream main: …` (the HAL's `check_submodule.py`): restore it as the line says; a HAL
  change goes upstream (`203cli rules`: Using the HAL). `hal_not_clean`, `hal_off_main`.

Never in the way: npm and GitHub are asked at most once a day (`~/.config/203cli/updates.json`), for at most 1.5 s,
silently when they do not answer; nothing goes to stdout or into an exit code. Off in CI (`CI`, `GITHUB_ACTIONS`) and
with `NO_UPDATE_NOTIFIER=1` or `C203_NO_UPDATE_CHECK=1` (doctor too). `updates --quiet` prints only the notices.

## Running in a sandboxed agent (Claude Code on the web, Codex cloud…)

A cloud sandbox reaches only the hosts its environment allows. npm and GitHub are on Claude Code's default list
(`npm install -g 203cli`, `203cli skill install` work); the 203 community is on none. `doctor --json` checks both of its
hosts. On `network_blocked_sandbox` (exit 1), stop and ask the user: only they can allow **`cardenza.203.io`** and
**`apps.203.io`**, per environment (a file in the repository cannot). Claude Code on the web: claude.ai/code → the
environment selector under the message box → Cloud → the environment's settings icon → Network access: Limited, keep
Allow package managers, add both to Allowed domains → Save changes (a shared Team/Enterprise environment: an Owner, in
admin settings › Cloud environments); Codex cloud and other sandboxes: their own per-environment allowlist. An open
session follows within a minute: then run `next[0]`. Meanwhile what needs no network works: building, `203cli rules`,
`203cli skill install`, and over USB `flash --bin`, `log`, `board`. All of it: `help sandbox`.

## Also

- Requests like pull requests (the owner): `dev list --firmware CODE --json`, `dev read CODE N --json` (the spec and its discussion), `dev update CODE N --status in_progress --progress 10 --note "…" --json` (`help requests`).
- Devices: over a USB cable, signed in or not: `flash CODE --json` (or `--bin FILE`; a running firmware is restarted into its Launcher first; `firmware_unreachable` or `launcher_countdown`: ask the user to press HOME (the key left of the screen) and choose Back to Launcher, then run it again (a firmware without that menu: hold FN while it restarts or is plugged in); `help devices`); over Wi-Fi to a bound device: `devices list --json`, `devices send ID CODE --start --json`, its Launcher to the newest: `devices update-launcher ID --json` (`--no-wait`: only send it, then `devices status ID COMMAND --wait --json`; `help devices`); a device that no longer starts: `devices recover --dry-run --json`, then `--out DIR` or `--port PORT --yes` (erases its internal flash; esptool writes it).
- 3D models: `models upload case.stl --title "…" --license CC-BY-4.0 --target cardenza --dry-run --json` (`help models`).
- Admins: `help admin`. Bot accounts (role `bot`, shown with a 机器人 tag; never an admin): `admin bots create NAME --token-file PATH --json` (its token, shown once, into PATH with mode 600), `admin bots list --json`, `admin bots rotate ID|NAME --token-file PATH --overwrite --json`. A bot signs in only with its token, as `COMMUNITY_TOKEN`: it writes posts, comments, requests and feedback with attachments and reads; anything else is refused (`bot_not_allowed`). What it filed: `admin issues --author NAME --json`, `dev list --author NAME --json`.
