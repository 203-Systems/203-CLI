# 203cli command reference

Generated from the CLI's command table (`node scripts/203cli.mjs help --reference > reference/cli.md`). `203cli` is the command
`npm install -g 203cli` puts on PATH, else `node <the skill's folder>/scripts/203cli.mjs`; run it
from the firmware project's folder. Every
command takes the global options; with `--json` the answer is JSON on stdout and an error is one JSON line on stderr (its
last line): `{"error","code","field","hint","next":[commands],"exit"}`. `--help --json` gives any command (or, alone,
all of them) as JSON.

## Global options

| option | |
|---|---|
| `--json` | Print the answer as JSON (errors: one JSON line on stderr). Always use it from a program or agent |
| `--lang zh\|en` | Language of what the server writes (errors, names) |
| `--api URL` | The API (default https://cardenza.203.io/community/api; or COMMUNITY_API) |
| `--token TOKEN` | An access token (else COMMUNITY_TOKEN, else the saved one) |
| `--no-input` | Never ask questions (also when not on a terminal) |
| `--help` | This command's help |

## Exit codes

| exit | meaning |
|---|---|
| 0 | done (also: nothing to do, it was done before) |
| 1 | refused: the API or a local check said no; fix what `error` / `field` / `hint` say, then run `next[0]` |
| 2 | usage: the command itself is wrong (unknown command or flag, missing or bad argument); run `next[0]` or see --help |
| 3 | try again later: the network or the API failed, a rate limit, or the checks are still running; run the same command again |
| 4 | sign in: no token, or the token is not valid any more; run `login` |
| 5 | the automatic checks sent the version back: read the report (`versions check`), fix and publish a new version, or appeal |
| 6 | needs your decision: a warning stops here; run `next[0]` (the same command with --force or --yes) only if that is what the user wants |

## Error codes

| code | exit | meaning | what to do |
|---|---|---|---|
| `usage` | 2 | the command is wrong | run next[0], or `<command> --help` |
| `signin_required` | 4 | not signed in (every command but login, logout, help, doctor, rules, flash and devices recover needs it), or the token was deleted / revoked / mistyped, or a run's trusted-publishing credential ended | `login` (the browser; no browser: `login --with-token`, a personal token, or `login --no-browser`, then `login --wait`); in GitHub Actions `login --github-oidc --firmware CODE` (again: it is repeatable) |
| `oidc_untrusted` | 1 | login --github-oidc: no trusted publisher of the firmware matches this run (repository, workflow file, environment) | the firmware's owner links the repository: its page (开发 › 自动发布) or `firmware publishers add CODE --repository OWNER/NAME --workflow FILE` |
| `oidc_channel` | 1 | trusted publishing: this run may not publish on that channel (`channel_allowed`; stable needs a tag vX.Y.Z, beta a tag vX.Y.Z-beta.N, else dev; and the publisher's channels) | publish on an allowed channel, or run on such a tag |
| `oidc_invalid` | 4 | login --github-oidc: the community did not take GitHub's token (`reason`: audience, expired, replayed, …) | run login --github-oidc again; audience: --api must be the community's API base |
| `oidc_unavailable` | 2 | login --github-oidc outside GitHub Actions, or a job without permissions: id-token: write | give the job permissions: id-token: write (help ci) |
| `publish_only` | 1 | a trusted-publishing credential tried something else than publishing its firmware's versions (page edits, other firmware, account actions) | do that with the owner's own sign-in (on the site, or 203cli login on a computer) |
| `bot_not_allowed` | 1 | a bot account (role bot) tried what bots may not: vote, like, favourite, report, publish, change its profile, anything admin | a bot only writes posts, comments, requests and feedback (with --attach) and reads; the rest needs a person's sign-in |
| `invalid_token` | 4 | login --with-token / --token: not a personal token (cct_ and 64 hex digits) | copy the whole token, or the user makes a new one on the site (设置 › 个人令牌, /me/tokens) |
| `web_only` | 1 | personal tokens, bind codes, devices and personal data are managed on the website only | ask the user to open the page in `url` |
| `reauth_required` | 4 | the website needs a recent sign-in for this | the user signs in again on the site |
| `forbidden` | 1 | not yours, an official firmware, or the token lacks write / admin | read `hint`; fork it, or sign in again with write |
| `admin_scope_required` | 4 | an admin whose sign-in lacks the admin scope | `login --admin` (the user ticks admin on the approval page) |
| `not_yours` | 1 | the firmware belongs to someone else | `firmware fork CODE …` and publish to your fork |
| `official_from_hub` | 1 | an official firmware whose versions come from the Launcher hub | its CI publishes through the hub; publish your own firmware instead |
| `not_found` | 1 | no such code or id | check it: `code CODE`, `firmware mine`, `search WORDS` |
| `invalid` | 1 | a value the API does not take (`field` names it) | fix that field as `hint` says |
| `invalid_name` | 1 | a firmware name the community does not take | 2-48 characters: Chinese, English letters, digits, single spaces and - _ . + & ( ) [ ] ! # , : ' · （ ） ： ， |
| `file_not_found` | 1 | a file path that does not exist (paths are relative to the current folder) | use the path `hint` suggests |
| `wrong_file` | 1 | the file is not what the command needs (e.g. a bootloader or ELF instead of the app BIN) | use the file `hint` / `next` name |
| `bad_version` | 1 | a version label the API does not take | letters, digits and . _ + - only, ≤ 32 |
| `bad_channel` | 1 | not stable, beta or dev | use the channel `next` suggests |
| `channel_off` | 6 | the beta or dev channel of this firmware is off | add --yes to turn it on while publishing |
| `already_published` | 0 | this exact BIN is already published under that version | nothing to do |
| `version_taken` | 1 | the version is published with another BIN | publish a new version (next suggests one) |
| `draft_mismatch` | 1 | a draft of that version has another BIN, channel or devices | delete the draft (next), then publish again |
| `conflict` | 1 | e.g. the version exists, a BIN is missing | read `hint` |
| `rejected` | 5 | the checks sent the version back | `versions check VCODE`; fix and publish a new version, or `versions appeal` |
| `still_checking` | 3 | the checks did not finish in time | run the same command again (it resumes) or `versions check VCODE` |
| `needs_force` | 6 | a quality warning (e.g. no release notes on stable, a lower version, a BIN that says another version) | fix it, or add --force if it is really meant |
| `cover_required` | 6 | a stable version of a firmware with no cover at all (no picture, none from its original, no screen after boot, no web build with it) | add one (`--cover cover.png`, `firmware cover CODE cover.png`) or send the web build; `--without-cover` only if the user wants none |
| `gallery_pictures` | 1 | publish (signed in yourself, an app): the gallery would not hold 3-5 different pictures (`count`, `duplicates`); also firmware images add / edit --place gallery past 5 | take screenshots with the firmware running on a Cardenza on USB (`board screen --out docs/screens/1.png`, then 2, 3), list them in 203.json's publish.images (or `firmware images add CODE …`), run it again; nothing was uploaded |
| `description_too_long` | 1 | the description is over 3000 characters (pictures not counted; `length`): a product page, not a manual | keep what it is, 3-6 features, what it needs and how to start (aim for 800); key tables to its tutorial, building to the README, history to the release notes (`help description`) |
| `needs_confirmation` | 6 | an action that needs a yes (deleting, a name someone else uses, turning a channel on) | add --yes if the user agrees |
| `launcher_official_only` | 1 | only the official 203 Launcher is offered: launchers are made and forked by admins only | publish your firmware as an app (leave out --launcher); do not fork a launcher |
| `sim_not_hal` | 1 | the simulator version cannot be built: the firmware calls the chip's drivers instead of CardenzaHAL (`unsupported` lists them) | use the HAL's API; publish goes on with the BIN alone (no Play) |
| `sim_toolchain` | 6 | Emscripten, CMake or Python is missing for the simulator version (in publish, on stable / beta: a decision) | install what `hint` says, or --no-sim |
| `sim_build_failed` | 6 | the firmware does not compile for the browser (`log_tail` has the errors) | fix them, or --no-sim (publish); sim build shows them again |
| `sim_no_web_target` | 1 | the CardenzaHAL found has no web target yet (no tools/cardenza_web.py) | --hal DIR with a checkout that has it; publish goes on with the BIN alone |
| `sim_not_project` | 2 | no ESP-IDF project of the firmware where 203cli looked | --project DIR (publish) or sim build DIR |
| `simulator_fails` | 1 | the simulator version did not say it was ready within 15 s in the checker's browser | fix it and sim upload again, or sim check VCODE --again |
| `official_only` | 1 | sounds, projects and works are only for official firmware | use the official firmware's code (`firmware list --official`) |
| `section_closed` | 1 | that section (sounds, projects or works) is not open yet: admins only | nothing to fix; share it when the section opens (`sections`) |
| `placeholder` | 2 | a value copied from an example without filling it in ("<…>", TODO) | write the real value; ask the user if unsure |
| `no_clone_url` | 1 | the firmware (and its parents) bound no repository | ask its owner; yours: `firmware edit CODE --clone-url …` |
| `clone_failed` | 3 | git clone failed | check the network / access, run it again |
| `password_required` | 1 | a private firmware | `firmware unlock CODE --password …`, then --unlock with its answer |
| `password_wrong` | 1 | a wrong password (`attempts_left`) | ask the owner for the password |
| `too_large` | 1 | a file over the limit | make it smaller |
| `rate_limited` | 3 | too many today (`retry_after` seconds) | wait, then run it again |
| `moved` | 1 | the community moved (`api`: where it is now); 203cli follows a move by itself, so this comes only when it could not (an address that is not the community's) | run it with --api set to `api` (next), and update 203cli: npm install -g 203cli |
| `expired` | 1 | a code, ticket or sign-in ran out | start again (next) |
| `deleted` | 1 | it was deleted | nothing to do with it |
| `not_for_target` | 1 | that version has no BIN for that device | choose another version or device |
| `download_failed` | 3 | a download failed (network, mirror) | run the same command again |
| `sha_mismatch` | 3 | a downloaded file is not the one the API describes (its SHA-256) | run it again; a broken mirror is retried |
| `recovery_plan` | 1 | the recovery images cannot be laid out for this device (`data.code` says why) | report it (`feedback --kind bug`); nothing was written |
| `esptool_missing` | 1 | esptool (Python) is not installed: devices recover --port needs it | `pip install esptool`, or `devices recover --out DIR` and flash the files another way |
| `port_not_found` | 1 | flash: no USB serial port and no device running a firmware (not plugged in, a charging-only cable, or off) | plug it in with a data cable and turn it on; or give `--port` |
| `port_ambiguous` | 1 | flash: several USB serial ports | say which with `--port` (next lists them) |
| `port_unavailable` | 1 | flash: the port cannot be opened (no permission, another program has it, not a serial port) | Linux: the dialout group; close serial monitors and the website's page; check `--port` |
| `port_failed` | 3 | flash: the port failed while it was used (unplugged) | plug it in again and run it again |
| `no_launcher` | 1 | flash: no 203 Launcher answered on the port (another device's port, or the Launcher in USB Drive mode) | leave USB Drive (its home screen) or give the right `--port`, then run it again |
| `firmware_unreachable` | 1 | flash / devices recover / board: the device runs a firmware and 203cli cannot reach it (Linux: no permission for its MIDI or HID, or another program has its MIDI port; macOS: no python3 for CoreMIDI) | Linux: the audio group; macOS: xcode-select --install; or put it in its Launcher yourself (press HOME, left of the screen, and choose Back to Launcher; a firmware without that menu: hold FN while plugging it in) |
| `no_launcher_port` | 3 | flash / devices recover: the firmware was asked to restart and no serial port came up | plug the cable in again and run it again; a firmware that does not take the command: press HOME and choose Back to Launcher (no such menu: hold FN while plugging it in) |
| `launcher_countdown` | 3 | flash: the restarted Launcher started the firmware again before 203cli reached it (twice) | press HOME on the device and choose Back to Launcher, then run it again; a firmware without that menu: hold FN, run it again, let go of FN once the Launcher's menu shows |
| `launcher_busy` | 3 | flash: the Launcher is in a menu | go back to its home screen, then run it again |
| `device_timeout` | 3 | flash: the device stopped answering | plug the cable in again and run it again |
| `launcher_old` | 1 | flash: this Launcher cannot install over USB | update the Launcher (its home screen: Update Launcher) |
| `install_refused` | 1 | flash: the Launcher refused the image (its words follow) | read `error`; a broken or foreign image: build it again |
| `wrong_device` | 1 | flash: the device on the port is not the --target | leave out `--target` (the device says what it is) |
| `not_an_app` | 1 | flash --bin: not an application image (a merged image, bootloader, ELF …) | give build/<project>.bin; a Launcher comes back with `devices recover` |
| `launcher_image` | 1 | flash: the code or the file is a launcher, which the Launcher does not install this way | give the firmware's build/<project>.bin; the Launcher updates itself; `devices recover` restores the official Launcher |
| `download_only` | 1 | flash: the device takes a UF2 file copied onto it (Mystrix), no Launcher | `versions download VCODE --target …` and copy it onto the device |
| `unsupported_platform` | 1 | flash and log: the USB cable is used on macOS and Linux only (board: also Windows, through python's hidapi) | on Windows: the website in Chrome or Edge (a firmware's page: 用 USB 线安装; a local BIN: /firmware › Flash a local file); the log: CardenzaHAL's tools/cardenza_usb.py console (pip install hidapi) |
| `launcher_full` | 1 | flash: no room on the device for the file (the Launcher names what to delete) | delete that, or other software, on the device; then run it again |
| `device_crashed` | 1 | log: the device printed a panic, an abort or a restart | read log_tail; decode the backtrace with the build's ELF (xtensa-esp32s3-elf-addr2line -pfiaC -e build/<project>.elf …) |
| `log_timeout` | 1 | log --until: no line matched before --seconds ran out | read log_tail: the firmware did not print it (or starts slower: a longer --seconds) |
| `python_missing` | 1 | log and board on macOS: python3 is needed for CoreMIDI | xcode-select --install |
| `board_not_found` | 1 | board: no Cardenza on USB (no firmware with CardenzaHAL's USB device, and no serial port either) | plug it in with a data cable (not a charging-only one), turn it on, start the firmware |
| `board_no_usb` | 1 | board: the firmware does not start CardenzaHAL's USB device (only its serial port is there, as with the template), so it has no development channel | add `CardenzaHAL::USB::Init();` after `CardenzaHAL::Init()` in app_main, rebuild, flash; `log` reads its console meanwhile |
| `board_in_launcher` | 1 | board: the device is in its 203 Launcher, not running a firmware | start the firmware from the Launcher (or `flash --bin` a build), run it again |
| `hal_too_old` | 1 | board: the firmware's CardenzaHAL is older than the development channel (IDENTIFY says protocol 1, or no answer to HELLO) | rebuild the firmware with a current CardenzaHAL (update its submodule), install it (`flash --bin`), run it again |
| `dev_channel_off` | 1 | board: the firmware was built with CONFIG_CARDENZA_HAL_USB_DEV off | turn it on in its sdkconfig, build and install it again |
| `hidapi_missing` | 1 | board on Windows: python's hidapi package (or python) is missing | `pip install hidapi` |
| `board_refused` | 1 | board: the firmware refused the request (`reason`: no framebuffer, a path not found, no SD card, …) | read `error` and `hint` |
| `board_busy` | 3 | board: the firmware's development channel has 8 requests queued | wait a moment, run it again |
| `board_timeout` | 3 | board: the device stopped answering, or part of an answer was lost more than once | run it again; if it keeps happening, read its log (`log`) |
| `board_lost` | 3 | board: the device went away (restarted, unplugged) | plug it in, let the firmware start, run it again |
| `board_protocol` | 1 | board: the firmware's answer is not what this 203cli reads | update 203cli (`npm install -g 203cli`); else report it |
| `dir_not_empty` | 1 | new: the folder is there and not empty | give another DIR |
| `git_missing` | 1 | new, project diff: git is not installed | install git |
| `not_a_repository` | 1 | project diff local: this folder is not a git repository | compare two versions or a fork instead, or git init |
| `no_source` | 1 | project diff: that version or fork has no source archive (and no repository) | versions published with publish_source: true carry one; pick another version |
| `skill_incomplete` | 1 | skill install: this 203cli lacks the skill's files | npm install -g 203cli again |
| `skill_failed` | 1 | skill install: the skills folder could not be written | check the folder, or give another with --dir |
| `git_failed` | 1 | new: git init failed | read the message; check the folder |
| `hal_unavailable` | 3 | new: CardenzaHAL could not be added (the network, GitHub) | run it again |
| `no_template` | 1 | new: no project template for that device yet | read the device's guide (products/<device>/README.md) |
| `no_firmware` | 2 | inbox, link: no CODE given and 203.json has no code (nothing published yet) | publish the first version, or give the code (firmware mine lists yours) |
| `no_project` | 2 | link: no 203.json here or above | run it in the project's folder (new or init makes 203.json) |
| `flash_failed` | 1 | esptool stopped while writing the device (`log_tail`) | put the device in download mode, check the cable and port, run it again: a device can always be restored again |
| `device_offline` | 1 | the device is off or not online (设备没开机或没联网) | ask the user to switch it on with Wi-Fi (in its Launcher or any CardenzaHAL firmware), then retry |
| `source_secrets` | 1 | the source archive holds files that look secret (`files`) | remove them from git (and revoke any pushed secret), commit, retry; or --no-source |
| `source_unavailable` | 1 | no source archive can be made here (not a git repository, no commit, git missing) | commit the source, or --no-source |
| `device_busy` | 3 | the device is installing something | wait, then retry |
| `not_installable` | 1 | launchers are flashed from the website, never sent | flash it on the website |
| `risk_not_accepted` | 1 | a third-party launcher | add --accept-risk if the user accepts it |
| `unreachable` | 3 | the API cannot be reached (ENOTFOUND in a sandboxed agent: its allowlist may lack the community's hosts) | check the network / --api; `doctor`; a sandbox: `help sandbox` |
| `network_blocked_sandbox` | 1 | a network allowlist on the way blocked the community (an agent's sandbox: Claude Code on the web, Codex …; a 403 with x-deny-reason: host_not_allowed, or one that is not the API's; in a sandbox also ENOTFOUND or a proxy's certificate) | only the user can allow it: cardenza.203.io and apps.203.io in the environment's network settings (`hint` says where; `help sandbox`), then run it again |
| `network_blocked_cdn` | 1 | the firewall in front of the site (Cloudflare) blocked the request (`ray`) | nothing to fix in the project: other programs (curl, urllib, web fetches) are blocked, 203cli normally passes; report it with the Ray ID or try another network |
| `unavailable` | 3 | the API or a provider failed | try again later |
| `upload_failed` | 3 | an upload failed | run the same command again: it resumes |

## Start

### `203cli doctor`

Check everything 203cli needs: Node, the API, the sign-in (kind, scopes), what is left today

    203cli doctor --json

### `203cli login`

Sign in: opens the browser, the user approves on the site and it comes back (no browser here: --with-token, a personal token; or --no-browser, a code approved on /activate, then login --wait; in GitHub Actions: --github-oidc --firmware CODE, no secret)

- `--name NAME` What this sign-in is called in the site's Personal tokens list (设置 › 个人令牌)
- `--with-token` Sign in with a personal token made on the site (设置 › 个人令牌, /me/tokens): read from stdin, or asked for on a terminal (not shown); --token TOKEN gives it directly
- `--no-browser` Sign in with a code instead (SSH, CI, a remote agent; also chosen by itself when no browser can be opened)
- `--admin` Ask for the admin scope too (admins; the page lets them tick it)
- `--wait` With a code: wait for the approval and save the token
- `--no-wait` With a code: only print the link and code (the default when not on a terminal)
- `--timeout SECONDS` How long it waits (browser default 300, code default 600, a token on stdin 60)
- `--github-oidc` Trusted publishing in GitHub Actions (permissions: id-token: write): the job's OIDC token for a 15-minute credential that publishes --firmware's versions; kept for this run only, renewed by itself; repeatable
- `--firmware CODE` With --github-oidc: the firmware whose trusted publisher this repository is (default: 203.json's code)

    203cli login
    203cli login --json
    203cli login --with-token < token.txt
    203cli login --no-browser --json
    203cli login --wait --json
    203cli login --github-oidc --firmware K7M2QX --json

### `203cli logout`

Sign out: revokes this token on the server and forgets it here (in GitHub Actions: the run's trusted-publishing credential)

    203cli logout
    203cli logout --json

### `203cli whoami`

The signed-in account and this sign-in: its kind (cli or ci), name and scopes

    203cli whoami --json

### `203cli quotas`

What is left of every limit (firmware, versions today, works, models, …)

    203cli quotas --json

### `203cli help [TOPIC]`

Recipes: help start, publish, ci, manifest, fork, source, checks, page, errors …; or help COMMAND

    203cli help publish
    203cli help errors

### `203cli rules`

The firmware project rules (CardenzaHAL's FIRMWARE-PROJECT.md): dependencies, files, HAL rules, builds, checks, publishing; --online for the newest

- `--online` Fetch the newest copy from the site (/develop.md) instead of the one in the skill

    203cli rules
    203cli rules --online

### `203cli init`

Write 203.json (the project file) from what the project says: CMake project(), version.txt or the git tag, you, the git remote, LICENSE

- `--firmware CODE` This firmware's code, when it is published already
- `--name NAME` Its name (default: CMake's project())
- `--bin [TARGET=]PATH` The application image for a device (repeat for several devices; TARGET defaults to cardenza); a download-only device takes its .uf2 file (mystrix=MatrixOS-Mystrix1.uf2, mystrix2=MatrixOS-Mystrix2.uf2) (repeatable)
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--license SPDX` The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--publish-source` Attach a source archive to every version (publish_source: true)
- `--force` Overwrite an existing 203.json

    203cli init --summary "A four-track groovebox" --json
    203cli init --name "My synth" --bin build/my_synth.bin --publish-source --json

### `203cli skill install`

Put the Agent Skill (SKILL.md, the guides, this 203cli) into the coding agents' skills folders: Claude Code's ~/.claude/skills (CLAUDE_SKILLS_DIR), Codex's ~/.codex/skills when it is there; run it after npm install -g 203cli and after every update

- `--dir DIR` Install into this skills folder only (it gets 203-community/)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli skill install
    203cli skill install --dry-run --json
    203cli skill install --dir ~/.agents/skills

### `203cli updates`

Whether a newer 203cli is out (npm) and whether this project's CardenzaHAL submodule is behind its main or not a clean copy, with the command for each; --quiet: only those notices, from today's answer (for scripts and CardenzaHAL's build). The commands of the work (sim, flash, log, board, new, fork, publish, rules, …) print the same notices on stderr when they end, asking at most once a day; off in CI and with NO_UPDATE_NOTIFIER or C203_NO_UPDATE_CHECK=1

- `--project DIR` The firmware project whose CardenzaHAL submodule is checked (default: here)
- `--quiet` Only the notices, nothing when all is current; from today's answer, and none in CI or with the opt-outs (for scripts and builds)

    203cli updates
    203cli updates --json
    203cli updates --quiet --project .

### `203cli new NAME [DIR]`

Start a firmware project: CardenzaHAL as a git submodule and its template, named NAME, with 203.json, the README and the release workflow; it builds as it is (no sign-in)

- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--device DEVICE` The device (default cardenza, the only one with a template so far)
- `--project ID` CMake's project() name, the BIN's name (default from NAME: "Pocket Metronome" → pocket_metronome)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli new "Pocket Metronome" --summary "A metronome with tap tempo and accents" --json
    203cli new Metronome metronome --dry-run --json

## Publishing

### `203cli publish`

Publish a firmware version in one go: makes the firmware if needed, uploads, waits for the checks; safe to run again (sign-in with write)

- `--firmware CODE` Your firmware's code (or its exact name)
- `--name NAME` The firmware's name, 1-64 characters
- `--version V` The version label (1.4.0; no leading v). Default: the BIN's own version
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--bin [TARGET=]PATH` The application image for a device (repeat for several devices; TARGET defaults to cardenza); a download-only device takes its .uf2 file (mystrix=MatrixOS-Mystrix1.uf2, mystrix2=MatrixOS-Mystrix2.uf2) (repeatable)
- `--notes TEXT` Release notes (Markdown); @FILE reads a file
- `--notes-file PATH` Release notes from a file (CHANGELOG.md: the entry of this version)
- `--commit SHA` The commit it was built from (7-40 hex, or a git ref like HEAD)
- `--source-url URL` https link to the source (e.g. the GitHub repository)
- `--notices PATH` NOTICES.txt (third-party licences, ≤ 1 MB)
- `--image PATH` A gallery picture (repeat: 3-5 different screenshots of the firmware, PNG/JPEG/WebP ≤ 2 MB; the gallery becomes exactly these, as 203.json's publish.images; help pictures) (repeatable)
- `--no-wait` Do not wait for the checks (answers status checking)
- `--timeout SECONDS` How long to wait for the checks (default 1200)
- `--poll SECONDS` How often to ask while it is checked (default 5)
- `--no-sim` No simulator version (no Play): do not build or upload one
- `--sim-dir PATH` Upload this built simulator version (cardenza_web.py's output folder, with sim.json) instead of building it
- `--hal DIR` The CardenzaHAL checkout (with its web target) that builds the simulator version (default: the project's own, else a cached clone)
- `--project DIR` The firmware's ESP-IDF project, for its simulator version (default: found from the BIN and here)
- `--no-source` Do not attach the source archive (even when 203.json says publish_source)
- `--without-cover` Publish a stable version although the firmware has no cover at all (no picture, none from its original, no screen after boot, no web build with it): only when the user wants none (else cover_required)
- `--source` Attach a source archive of the commit (git archive of the tracked files, checked for secrets), as publish_source: true does
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)
- `--yes` Yes to what needs it (turn a channel on, a name someone else uses, no simulator version when it cannot be built)
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file; the local pictures it names go up as the description's (help pictures)
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--cover IMAGE` A cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB)
- `--clone-url URL` https://….git for git clone
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--launcher` A new firmware is a launcher (merged full-flash images)
- `--license SPDX` The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary
- `--manifest PATH` The project file (default: 203.json here or above, else 203cli.json)

    203cli publish --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --bin build/my-synth.bin --notes-file CHANGELOG.md --dry-run --json
    203cli publish --firmware K7M2QX --bin build/my-synth.bin --json
    203cli publish --firmware K7M2QX --channel dev --version "dev.$(date +%Y%m%d%H%M)" --bin build/my-synth.bin --json

### `203cli versions publish CODE`

Publish a version of your firmware CODE (the same checks as publish; never makes a firmware) (sign-in with write)

- `--version V` The version label (1.4.0; no leading v). Default: the BIN's own version
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--bin [TARGET=]PATH` The application image for a device (repeat for several devices; TARGET defaults to cardenza); a download-only device takes its .uf2 file (mystrix=MatrixOS-Mystrix1.uf2, mystrix2=MatrixOS-Mystrix2.uf2) (repeatable)
- `--notes TEXT` Release notes (Markdown); @FILE reads a file
- `--notes-file PATH` Release notes from a file (CHANGELOG.md: the entry of this version)
- `--commit SHA` The commit it was built from (7-40 hex, or a git ref like HEAD)
- `--source-url URL` A link to this version's source
- `--notices PATH` NOTICES.txt (third-party licences, ≤ 1 MB)
- `--image PATH` A gallery picture (repeat: 3-5 different screenshots of the firmware, PNG/JPEG/WebP ≤ 2 MB; the gallery becomes exactly these, as 203.json's publish.images; help pictures) (repeatable)
- `--no-wait` Do not wait for the checks (answers status checking)
- `--timeout SECONDS` How long to wait for the checks (default 1200)
- `--poll SECONDS` How often to ask while it is checked (default 5)
- `--no-sim` No simulator version (no Play): do not build or upload one
- `--sim-dir PATH` Upload this built simulator version (cardenza_web.py's output folder, with sim.json) instead of building it
- `--hal DIR` The CardenzaHAL checkout (with its web target) that builds the simulator version (default: the project's own, else a cached clone)
- `--project DIR` The firmware's ESP-IDF project, for its simulator version (default: found from the BIN and here)
- `--no-source` Do not attach the source archive (even when 203.json says publish_source)
- `--without-cover` Publish a stable version although the firmware has no cover at all (no picture, none from its original, no screen after boot, no web build with it): only when the user wants none (else cover_required)
- `--source` Attach a source archive of the commit (git archive of the tracked files, checked for secrets), as publish_source: true does
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)
- `--yes` Yes to what needs it (turn a channel on, a name someone else uses, no simulator version when it cannot be built)

    203cli versions publish K7M2QX --version 1.4.0 --bin cardenza=build/app.bin --notes-file CHANGES.md --dry-run --json

### `203cli firmware create`

Make a firmware (its page); publish versions to it with publish (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file; the local pictures it names go up as the description's (help pictures)
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--source-url URL` https link to the source (e.g. the GitHub repository)
- `--clone-url URL` https://….git for git clone
- `--license SPDX` The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--beta` Switch the beta channel on
- `--dev` Switch the dev channel on
- `--cover IMAGE` A cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB)
- `--fork CODE` Fork this firmware or version
- `--launcher` A launcher (merged full-flash images)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)
- `--yes` Make it even when someone else's firmware has this name

    203cli firmware create --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --tags groovebox --source-url https://github.com/me/my-synth --json

### `203cli firmware edit CODE`

Change a firmware's page or settings (only the fields given) (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file; the local pictures it names go up as the description's (help pictures)
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--source-url URL` https link to the source (e.g. the GitHub repository)
- `--clone-url URL` https://….git for git clone
- `--license SPDX` The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--beta` Switch the beta channel on
- `--dev` Switch the dev channel on
- `--cover IMAGE` A cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB)
- `--public` Make a private firmware public (drops the password)
- `--no-beta` Switch the beta channel off
- `--no-dev` Switch the dev channel off
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)

    203cli firmware edit K7M2QX --summary "Four-track groovebox: drums, Juno, DX7, sampler" --json
    203cli firmware edit K7M2QX --dev --json

### `203cli firmware cover CODE [IMAGE]`

Set a firmware's cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB); --remove takes it away (sign-in with write)

- `--file IMAGE` The picture (the same as IMAGE)
- `--remove` Remove the cover (a fork then shows its original's, else the screen after boot shows, else the grey default)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, do it (it cannot be undone)

    203cli firmware cover K7M2QX cover.png --json
    203cli firmware cover K7M2QX --file cover.png --dry-run --json
    203cli firmware cover K7M2QX --remove --yes --json

### `203cli firmware images list CODE`

A firmware's pictures: the gallery (shown large above the description, at most 9, in order) and the description's own (at most 20), each with its id, caption, size, the reference to put in the description and whether it is there

    203cli firmware images list K7M2QX --json

### `203cli firmware images add CODE IMAGE...`

Add pictures (PNG/JPEG/WebP, ≤ 2 MB each) to the gallery above the description, or with --description to the description (it prints each one's ![](image:ID) to put in the text); a picture it has already is skipped (sign-in with write)

- `--caption TEXT` One line under the picture (≤ 60 characters; one picture only)
- `--description` Into the description (placed by its text: ![words](image:ID)), not the gallery
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli firmware images add K7M2QX docs/home.png --caption "The home screen" --json
    203cli firmware images add K7M2QX docs/seq.png docs/mix.png --dry-run --json
    203cli firmware images add K7M2QX docs/signal-flow.png --description --json

### `203cli firmware images edit CODE ID`

A picture's caption ("": none) or place: the gallery or the description (sign-in with write)

- `--caption TEXT` One line under the picture (≤ 60 characters; "" removes it)
- `--place gallery|description` Move it: into the gallery it goes last
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli firmware images edit K7M2QX 7ces8nvr --caption "Sixteen steps a page" --json
    203cli firmware images edit K7M2QX 7ces8nvr --place description --json

### `203cli firmware images remove CODE ID...`

Remove pictures (the description keeps its words where it named one: there it shows nothing) (sign-in with write)

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, do it (it cannot be undone)

    203cli firmware images remove K7M2QX 7ces8nvr --dry-run --json
    203cli firmware images remove K7M2QX 7ces8nvr --yes --json

### `203cli firmware images order CODE ID...`

The gallery's order: these ids first, in this order, the others after them as they were (sign-in with write)

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli firmware images order K7M2QX q4hzuufx 7ces8nvr --json

### `203cli firmware images prune CODE`

Remove the description's pictures its text no longer uses (sign-in with write)

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, do it (it cannot be undone)

    203cli firmware images prune K7M2QX --dry-run --json
    203cli firmware images prune K7M2QX --yes --json

### `203cli firmware checklist CODE`

What a firmware's page has and lacks (cover, pictures, summary, description, links, notes), with the command for each

    203cli firmware checklist K7M2QX --json

### `203cli versions simulator CODE VCODE`

Upload a version's simulator version (the same as sim upload VCODE DIR) (sign-in with write)

- `--dir PATH` The folder of the web build (required)
- `--no-wait` Do not wait for its check
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli versions simulator K7M2QX V3X9PA --dir build-web/site --json

### `203cli fork CODE [DIR]`

Fork a firmware to change it: makes your fork (or finds yours), clones its source into DIR and writes 203.json there (code, forked_from) (sign-in with write)

- `--name NAME` Your fork's name (default: the firmware's name and yours)
- `--summary TEXT` What your fork changes (default: a line saying it is a fork)
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--new` Make another fork even when you have one of this firmware
- `--clone DIR` Clone its source into DIR (the same as DIR)
- `--no-clone` Make the fork only; do not clone
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli fork V6QK28 my-synth --json
    203cli fork K7M2QX --no-clone --json

### `203cli link [CODE]`

Bind this project (203.json) to its firmware, or move the binding after the repository moved: 203.json's code and source, the page's source link, and this GitHub repository as the trusted publisher its CI publishes with (sign-in with write)

- `--move` Also remove the trusted publishers of other repositories (the project left them)
- `--workflow FILE` The workflow that publishes (default firmware.yml when it is there)
- `--no-ci` Leave the trusted publishers as they are
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli link --dry-run --json
    203cli link K7M2QX --json
    203cli link --move --json

### `203cli clone CODE [DIR]`

git clone a firmware's source (its clone link, else its parent's) into DIR; publish from inside goes to CODE

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli clone K7M2QX my-synth --json

### `203cli firmware publishers list CODE`

Trusted publishers of your firmware: the GitHub repositories (workflow, environment, channels, last use) whose Actions runs publish it without a secret

    203cli firmware publishers list K7M2QX --json

### `203cli firmware publishers add CODE`

Link a trusted publisher: a GitHub repository whose Actions runs (that workflow, that environment) may publish CODE's versions (at most 5) (sign-in with write)

- `--repository OWNER/NAME` The GitHub repository (a github.com link is taken too) (required)
- `--workflow FILE` The workflow's file in .github/workflows that publishes, e.g. firmware.yml (recommended: else any workflow of the repository)
- `--environment NAME` Only jobs in this GitHub environment (e.g. release, with its own protection rules)
- `--channels stable,beta,dev` The channels it may publish on (default all three; a run's ref limits them too: tags vX.Y.Z stable, vX.Y.Z-beta.N beta, else dev)

    203cli firmware publishers add K7M2QX --repository me/my-synth --workflow firmware.yml --json
    203cli firmware publishers add K7M2QX --repository me/my-synth --workflow release.yml --environment release --channels stable,beta --json

### `203cli firmware publishers remove CODE ID`

Remove a trusted publisher (ID, or its OWNER/NAME when it is the only one of that repository): its runs' credentials stop working at once (sign-in with write) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli firmware publishers remove K7M2QX 3 --yes --json
    203cli firmware publishers remove K7M2QX me/my-synth --yes --json

### `203cli source check [DIR]`

What the source archive of the project in DIR (default here) would hold: the commit's tracked files, checked for secrets

    203cli source check --json

### `203cli source upload VCODE [DIR]`

Attach the source archive of the project in DIR (default here) to a version of yours (git archive of the commit, checked for secrets) (sign-in with write)

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Upload although the working tree has uncommitted changes (they are not in the archive)

    203cli source upload V3X9PA --dry-run --json
    203cli source upload V3X9PA --json

### `203cli source delete CODE VCODE`

Remove a version's source archive (sign-in with write) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli source delete K7M2QX V3X9PA --yes --json

## Tutorials

### `203cli tutorial new [FILE]`

Start a tutorial file (default docs/tutorial.json): the format with one lesson of two steps to write over, for 203.json's firmware

- `--languages zh|en|zh,en` The languages every text is written in (default zh,en)
- `--title TEXT` The tutorial's title (2-60 wide)
- `--firmware CODE` The firmware it is for (default 203.json's code)
- `--force` Write over the file when it exists
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli tutorial new --json
    203cli tutorial new docs/tutorial.json --languages en --title "Getting started" --firmware K7M2QX --json

### `203cli tutorial check [FILE]`

Check a tutorial file as the community will: the format (fields, languages, lengths, markup, key names) and its local pictures; every error with its line and column

- `--firmware CODE` The firmware it is for: "firmware" in the file must be this one

    203cli tutorial check --json
    203cli tutorial check docs/tutorial.json

### `203cli tutorial publish [FILE]`

Publish your tutorial of a firmware (one each): checks it, uploads its local pictures it lacks (once, by SHA-256), adds it or changes yours; safe to run again (sign-in with write)

- `--firmware CODE` The firmware (default: "firmware" in the file, else 203.json's code)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli tutorial publish --dry-run --json
    203cli tutorial publish docs/tutorial.json --firmware K7M2QX --json

### `203cli tutorial link CODE URL`

Add a link to a tutorial elsewhere (a video, a blog; https only, up to 5 of yours a firmware); the same URL again changes its title (sign-in with write)

- `--title TEXT` What it is (2-60 wide, plain text) (required)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli tutorial link K7M2QX https://www.bilibili.com/video/BV1xx411c7mD --title "Video: the first ten minutes" --json

### `203cli tutorial list [CODE]`

A firmware's tutorials (the official ones, its owner's, first), with ids and pages; --all: every firmware that has tutorials

- `--all` Every firmware with tutorials, the most downloaded first
- `--target DEVICE` With --all: firmware for this device
- `--q WORDS` With --all: search words
- `--page N` Page, from 1 (24 a page)

    203cli tutorial list K7M2QX --json
    203cli tutorial list --all --target cardenza --json

### `203cli tutorial show CODE ID`

A tutorial: a guide's lessons and steps (its file as written, for its author), or a link's address; --out saves a guide's file

- `--out PATH` Save the guide's file there (to change it and publish again)
- `--force` Write over --out when it exists

    203cli tutorial show K7M2QX 7ces8nvr --json
    203cli tutorial show K7M2QX 7ces8nvr --out docs/tutorial.json

### `203cli tutorial rm CODE ID`

Delete your tutorial (admins: any) (sign-in with write) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli tutorial rm K7M2QX 7ces8nvr --yes --json

### `203cli tutorial hide CODE ID`

Hide a tutorial on your firmware (its owner, an admin; its author is told), or --off to show it again (sign-in with write)

- `--off` Show it again
- `--reason TEXT` Why (its author reads it)

    203cli tutorial hide K7M2QX 7ces8nvr --reason "Another firmware's keys" --json
    203cli tutorial hide K7M2QX 7ces8nvr --off --json

## Simulator

### `203cli sim build [DIR]`

Build the simulator version of the firmware in DIR (default here) with CardenzaHAL's web target; prints where

- `--hal DIR` The CardenzaHAL checkout (with its web target) that builds the simulator version (default: the project's own, else a cached clone)
- `--out DIR` Where to write it (default <project>/build-web/site)
- `--debug` A debug build (larger, with symbols)
- `--jobs N` Parallel compile jobs
- `--project DIR` The ESP-IDF project (the same as DIR)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli sim build --json
    203cli sim build firmware/ --hal ~/CardenzaHAL --json

### `203cli sim upload VCODE DIR`

Upload a built simulator version to a version of yours (only when it differs); the checker opens it, Play once it boots (sign-in with write)

- `--no-wait` Do not wait for the checker
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli sim upload V3X9PA build-web/site --json
    203cli sim upload V3X9PA build-web/site --dry-run --json

### `203cli sim check VCODE`

A version's simulator version: boots (Play), fails (why), or waiting for the checker; --again checks it again

- `--again` Ask the checker to open it again (owner or admin)
- `--no-wait` Do not wait for the checker
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)

    203cli sim check V3X9PA --json
    203cli sim check V3X9PA --again --json

## Firmware

### `203cli firmware mine`

Your own firmware (private ones too), with their codes

- `--page N` Page, from 1 (24 a page)

    203cli firmware mine --json

### `203cli firmware list`

Public firmware of one device (official ones first)

- `--section official|community|all` Which ones
- `--official` Official firmware only
- `--q WORDS` Search words
- `--tag TAG` A category or tag
- `--target DEVICE` A device (default cardenza)
- `--kind app|launcher` Apps (default) or launchers
- `--forks` Forks too (hidden by default)
- `--sort new|hot|downloads|likes` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli firmware list --official --json
    203cli firmware list --q synth --limit 10 --json

### `203cli firmware show CODE`

A firmware (a private one needs --unlock)

- `--unlock TOKEN` cfu_… from firmware unlock

    203cli firmware show K7M2QX --json

### `203cli firmware fork CODE`

Fork a firmware (or a version) into a new firmware of yours (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters (required)
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name) (required)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file; the local pictures it names go up as the description's (help pictures)
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)
- `--yes` Fork even when you have a firmware of this name

    203cli firmware fork K7M2QX --name "My synth" --summary "K7M2QX with a fifth track" --json

### `203cli firmware delete CODE`

Delete a firmware (its forks stay) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli firmware delete K7M2QX --yes --json

### `203cli firmware like CODE`

Like a firmware

    203cli firmware like K7M2QX --json

### `203cli firmware unlike CODE`

Unlike a firmware

    203cli firmware unlike K7M2QX --json

### `203cli firmware favorite CODE`

Favorite a firmware

    203cli firmware favorite K7M2QX --json

### `203cli firmware unfavorite CODE`

Unfavorite a firmware

    203cli firmware unfavorite K7M2QX --json

### `203cli firmware tree CODE`

The fork tree around a firmware

    203cli firmware tree K7M2QX --json

### `203cli firmware lookup NAME...`

Firmware with exactly this name (ignoring case): yours first, any device, forks too

    203cli firmware lookup "My synth" --json

### `203cli firmware based-on CODE ORIGIN`

Record what your firmware CODE was made from (ORIGIN: a firmware or version code; none: an original); 203.json follows (sign-in with write)

- `--version LABEL` The original's version it was made from (its label, e.g. 0.3.0)
- `--unlock TOKEN` cfu_… when the original is private
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli firmware based-on K7M2QX V6QK28 --version 0.3.0 --json
    203cli firmware based-on K7M2QX none --json

### `203cli firmware unlock CODE`

Open a private firmware with its password: answers an unlock token for --unlock

- `--password P` The password (required)

    203cli firmware unlock K7M2QX --password 1234 --json

### `203cli firmware works CODE`

Works made with a firmware

- `--version VCODE` One version's works
- `--page N` Page, from 1 (24 a page)

    203cli firmware works K7M2QX --json

### `203cli versions list CODE`

A firmware's versions, newest first (yours: drafts, checking and sent back too)

- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--target DEVICE` Only versions with a BIN for this device (e.g. cardenza)
- `--page N` Page, from 1 (24 a page)

    203cli versions list K7M2QX --json
    203cli versions list K7M2QX --channel beta --target cardenza --json

### `203cli versions label CODE LABEL`

A firmware's version by its label (1.4.0)

    203cli versions label K7M2QX 1.4.0 --json

### `203cli versions show VCODE`

A version and its firmware

    203cli versions show V3X9PA --json

### `203cli versions edit VCODE`

Change a version's release notes (sign-in with write)

- `--notes TEXT` Release notes (Markdown); @FILE reads a file
- `--notes-file PATH` Release notes from a file (CHANGELOG.md: the entry of this version)

    203cli versions edit V3X9PA --notes "Fixes the arpeggiator at 1/32" --json

### `203cli versions delete VCODE`

Delete a version (its code then answers deleted) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli versions delete V3X9PA --yes --json

### `203cli versions check VCODE`

A version's status and check report (steps, boot log, appeal)

    203cli versions check V3X9PA --json

### `203cli versions appeal VCODE`

The checks were wrong (a false positive): say why, 10-2000 characters (sign-in with write)

- `--message TEXT` Why the check is wrong
- `--message-file PATH` The message from a file

    203cli versions appeal V3X9PA --message "It panics only because QEMU has no touch controller; on the device it boots" --json

### `203cli versions download VCODE`

A version's BIN for a device

- `--target DEVICE` The device, e.g. cardenza (required)
- `--accept-risk` Accept a third-party launcher's risk
- `--out PATH` Save it here

    203cli versions download V3X9PA --target cardenza --out app.bin --json

### `203cli builds identify [FILE]`

What a BIN is: its signature checked by the community (a downloaded BIN ends with it), else its SHA-256; the firmware, version, lineage, and whether a newer build is out

- `--sha256 HEX` A file's SHA-256 instead of a file
- `--target DEVICE` The device (narrows a SHA-256 match)

    203cli builds identify app.bin --json
    203cli builds identify --sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --json

## Sharing

### `203cli sounds upload FILE...`

Share a sound pack (.ccpreset banks, .wav samples) for an official firmware (sign-in with write)

- `--firmware CODE` The official firmware's code (firmware list --official) (required)
- `--title TEXT` 1-80 characters (required)
- `--engine dx7|juno|sampler|drums|mixed` The engine (read from the banks when left out)
- `--version VCODE` A version code of that firmware
- `--preview AUDIO` A .wav, .mp3 or .ogg recording to listen to
- `--preview-ms MS` The preview's length in ms
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Up to 8 tags
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli sounds upload pads.ccpreset pad-c3.wav --firmware 3YGNF5 --title "Warm pads" --tags pad --dry-run --json

### `203cli sounds list`

Sound packs (official firmware)

- `--q WORDS` Search words
- `--tag TAG` A category or tag
- `--engine ENGINE` dx7, juno, sampler, drums or mixed
- `--firmware CODE` A firmware code
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli sounds list --tag lofi --json

### `203cli sounds show ID`

A sound (files, preview)

    203cli sounds show ab12cd34 --json

### `203cli sounds edit ID`

Change a sound (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Tags
- `--engine ENGINE` mixed or its banks' engine

    203cli sounds edit ab12cd34 --tags pad,keys --json

### `203cli sounds delete ID`

Delete a sound Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli sounds delete ab12cd34 --yes --json

### `203cli sounds download ID`

A sound's files (every file into a folder, or --file NAME)

- `--file NAME` One file
- `--out PATH` Where to save (a folder without --file)

    203cli sounds download ab12cd34 --out ./sounds --json

### `203cli projects upload FILE...`

Share a project (one .ccproj and its .wav samples) for an official firmware (sign-in with write)

- `--firmware CODE` The official firmware's code (firmware list --official) (required)
- `--title TEXT` 1-80 characters (required)
- `--bpm N` 30-300 (the file's tempo wins)
- `--version VCODE` A version code of that firmware
- `--preview AUDIO` A .wav, .mp3 or .ogg recording to listen to
- `--preview-ms MS` The preview's length in ms
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Up to 8 tags
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli projects upload NIGHT.ccproj kick.wav --firmware 3YGNF5 --title "Night drive" --preview night.mp3 --dry-run --json

### `203cli projects list`

Projects (official firmware)

- `--q WORDS` Search words
- `--tag TAG` A category or tag
- `--firmware CODE` A firmware code
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli projects list --tag lofi --json

### `203cli projects show ID`

A project (files, preview)

    203cli projects show ab12cd34 --json

### `203cli projects edit ID`

Change a project (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Tags
- `--bpm N` 30-300

    203cli projects edit ab12cd34 --tags pad,keys --json

### `203cli projects delete ID`

Delete a project Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli projects delete ab12cd34 --yes --json

### `203cli projects download ID`

A project's files (every file into a folder, or --file NAME)

- `--file NAME` One file
- `--out PATH` Where to save (a folder without --file)

    203cli projects download ab12cd34 --out ./projects --json

### `203cli works upload FILE`

Share a work (audio or video made with an official firmware) (sign-in with write)

- `--firmware CODE` The official firmware's code (required)
- `--version VCODE` The version it was made with
- `--version-label LABEL` A version name when there is no code
- `--title TEXT` 1-80 characters (default: the file name)
- `--description TEXT` Text
- `--tags a,b` Up to 5 tags
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli works upload song.wav --firmware 3YGNF5 --title "Rain" --tags lofi --dry-run --json

### `203cli works list`

Works

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--firmware CODE` Firmware
- `--sort new|hot` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli works list --tag lofi --json

### `203cli works show ID`

A work

    203cli works show ab12cd34 --json

### `203cli works edit ID`

Change a work (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Text
- `--tags a,b` Tags
- `--version VCODE` A version code (empty: none)

    203cli works edit ab12cd34 --tags lofi,demo --json

### `203cli works delete ID`

Delete a work Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli works delete ab12cd34 --yes --json

### `203cli works approve ID`

Publish a work your device sent (it is held until you approve it) (sign-in with write)

    203cli works approve ab12cd34 --json

### `203cli models upload FILE...`

Share a 3D model (.stl .step .3mf .obj) (sign-in with write)

- `--title TEXT` 1-80 characters (required)
- `--license CC-BY-4.0|CC-BY-SA-4.0|CC-BY-NC-4.0|CC-BY-NC-SA-4.0|CC0-1.0|all-rights-reserved` The licence (required)
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Tags
- `--target DEVICE` The device it is for
- `--firmware CODE` A firmware it goes with
- `--remix-of ID` The model it remixes
- `--preview MESH` .stl or .glb (needed for STEP/3MF/OBJ)
- `--thumbnail PNG` A picture (needed for STEP/3MF/OBJ)
- `--material TEXT` e.g. PLA
- `--layer-height MM` e.g. 0.2
- `--infill PERCENT` 0-100
- `--supports` Needs supports
- `--print-notes TEXT` Print notes
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli models upload stand.stl --title "Desk stand" --license CC-BY-4.0 --target cardenza --dry-run --json

### `203cli models list`

Models

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--target DEVICE` Device
- `--firmware CODE` Firmware
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli models list --target cardenza --json

### `203cli models show ID`

A model

    203cli models show ab12cd34 --json

### `203cli models remixes ID`

Remixes of a model

- `--page N` Page, from 1 (24 a page)

    203cli models remixes ab12cd34 --json

### `203cli models delete ID`

Delete a model Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli models delete ab12cd34 --yes --json

### `203cli models download ID`

A model file

- `--file NAME` One file (default the first)
- `--out PATH` Save it here

    203cli models download ab12cd34 --out stand.stl --json

## Browse

### `203cli sections`

The six sections and their counts

    203cli sections --json

### `203cli sections show ID`

A section's categories (use them as --tag) and tags

    203cli sections show sounds --json

### `203cli tags`

The most used tags

- `--kind KIND` firmware, post, work, model, sound or project
- `--section official|community` Firmware only

    203cli tags --kind sound --json

### `203cli search WORDS...`

Search everything (6 of each kind); a code is looked up

    203cli search groovebox --json

### `203cli code CODE`

What a firmware or version code names

    203cli code K7M2QX --json

### `203cli targets`

The devices the community knows

    203cli targets --json

### `203cli user ID [WHAT]`

A person, or their firmware|works|posts|models|sounds|projects|badges

- `--page N` Page, from 1 (24 a page)

    203cli user ab12cd34 --json
    203cli user ab12cd34 firmware --json

### `203cli mine WHAT`

Your firmware|works|posts|models|sounds|projects

- `--page N` Page, from 1 (24 a page)

    203cli mine sounds --json

### `203cli notifications`

Your notifications (--read marks them read)

- `--read` Mark them all read
- `--page N` Page, from 1 (24 a page)

    203cli notifications --json

### `203cli favorites`

Your favourites

- `--kind KIND` firmware, post, work, model, sound or project
- `--page N` Page, from 1 (24 a page)

    203cli favorites --kind firmware --json

## Community

### `203cli posts list`

Forum posts

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--firmware CODE` Firmware
- `--sort new|hot` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203cli posts list --json

### `203cli posts show ID`

A post

    203cli posts show ab12cd34 --json

### `203cli posts create`

Write a post (--attach: pictures, videos or files under it) (sign-in with write)

- `--title TEXT` 1-120 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` Markdown file
- `--tags a,b` Up to 5
- `--firmware CODE` A firmware it is about
- `--attach FILE` Attach a local file (repeat, at most 9): a picture (PNG, JPEG, WebP, GIF ≤ 10 MB), a video (MP4, WebM, MOV ≤ 95 MB) or another file (a log, .txt, .zip, .ccproj, .bin, .elf, .json, .csv, .pdf … ≤ 20 MB); uploaded before the item is made (repeatable)

    203cli posts create --title "1.4.0 is out" --body "What changed: …" --tags announcement --json
    203cli posts create --title "My desk setup" --body-file post.md --attach desk.jpg --attach demo.mp4 --json

### `203cli posts edit ID`

Change a post (sign-in with write)

- `--title TEXT` Title
- `--body TEXT` Markdown
- `--body-file PATH` Markdown file
- `--tags a,b` Tags

    203cli posts edit ab12cd34 --title "1.4.1 is out" --json

### `203cli posts delete ID`

Delete a post Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli posts delete ab12cd34 --yes --json

### `203cli comments list KIND REF`

Comments on something (REF: a code, an id or CODE/N)

- `--page N` Page, from 1 (24 a page)

    203cli comments list firmware K7M2QX --json

### `203cli comments replies COMMENT`

Replies to a comment

- `--page N` Page, from 1 (24 a page)

    203cli comments replies 42 --json

### `203cli comments add KIND REF`

Comment on something, or reply (--parent); --attach: pictures, videos or files under it (the body may then be empty) (sign-in with write)

- `--body TEXT` 1-4000 characters (may be left out with --attach)
- `--body-file PATH` Text file
- `--parent COMMENT` Reply to this comment id
- `--attach FILE` Attach a local file (repeat, at most 9): a picture (PNG, JPEG, WebP, GIF ≤ 10 MB), a video (MP4, WebM, MOV ≤ 95 MB) or another file (a log, .txt, .zip, .ccproj, .bin, .elf, .json, .csv, .pdf … ≤ 20 MB); uploaded before the item is made (repeatable)

    203cli comments add request K7M2QX/3 --body "Done in 1.5.0" --json
    203cli comments add post ab12cd34 --body "The log of the crash" --attach log.txt --json
    203cli comments add request K7M2QX/3 --parent 42 --attach screen.png --json

### `203cli comments edit COMMENT`

Change your comment (sign-in with write)

- `--body TEXT` Text
- `--body-file PATH` Text file

    203cli comments edit 42 --body "…" --json

### `203cli comments delete COMMENT`

Delete a comment Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203cli comments delete 42 --yes --json

### `203cli like KIND REF`

Like something (--off undoes it) (sign-in with write)

- `--off` Undo it

    203cli like firmware K7M2QX --json

### `203cli favorite KIND REF`

Favourite something (--off undoes it) (sign-in with write)

- `--off` Undo it

    203cli favorite firmware K7M2QX --json

### `203cli report KIND REF`

Report something to the admins (sign-in with write)

- `--reason spam|abuse|illegal|malware|copyright|other` Why (required)
- `--detail TEXT` Up to 1000 characters

    203cli report post ab12cd34 --reason spam --json

## Project

### `203cli sync [CODE]`

Everything the community has about this project's firmware in one report for an agent: the page, every version and its notes, requests and comments with their replies, merge requests, forks; .203/community.md and .json, new since the last sync marked. Run it before planning changes

- `--since last|all|DATE` What counts as new (default last: since the previous sync or inbox)
- `--out DIR` Write the report here (default the project's .203/)
- `--no-mark` Do not remember this look

    203cli sync
    203cli sync --json
    203cli sync --since 2026-11-01 --json

### `203cli project show [CODE]`

The firmware's page as people see it: name, summary, description, tags, licence, links, cover and screen, counts, newest versions, the latest 10 versions with their notes

    203cli project show
    203cli project show V6QK28 --json

### `203cli project versions [CODE]`

Every version with its notes, channel, status, checks and source archive, newest first (24 a page)

- `--channel stable|beta|dev` One channel
- `--page N` Page, from 1 (24 a page)

    203cli project versions --json
    203cli project versions --page 2 --json

### `203cli project feedback [CODE]`

What people asked for and said: requests (votes, status, answered or not, the discussion) and comment threads with every reply and like, merge requests; each with the version newest when it was written, new ones marked

- `--since last|all|DATE` What is marked new (default last: since the previous sync or inbox)
- `--new` Only what is new
- `--no-threads` Leave out the discussions and the replies beyond the newest (faster)

    203cli project feedback --json
    203cli project feedback --new --json
    203cli project feedback V6QK28 --since 2026-11-01

### `203cli project forks [CODE]`

The forks (魔改版) of the firmware, forks of forks too: each one's base version, newest versions, counts, and the command that compares it

    203cli project forks
    203cli project forks V6QK28 --json

### `203cli project diff [A] [B]`

Compare two sources file by file (+/- lines; --patch the unified diff): A and B are a fork's code, a version of this firmware (label or code), or local (this folder, B's default)

- `--patch` Also the unified diff
- `--max N` Cut the patch at N characters (default 400000)
- `--firmware CODE` The firmware whose versions labels name (default 203.json's)

    203cli project diff K9FORK
    203cli project diff 1.0.0 1.1.0 --json
    203cli project diff K9FORK 1.1.0 --patch

### `203cli inbox [CODE]`

What the community said about this project's firmware (203.json, or CODE) since you last looked: requests with votes and new comments, comments, merge requests, versions sent back, notifications; --out writes it as Markdown for an agent

- `--all` Everything there is, not only what is new since the last inbox
- `--out FILE` Also write it as Markdown (e.g. .203/inbox.md: git-ignore .203/)
- `--no-mark` Do not remember this look: the next inbox shows the same as new

    203cli inbox
    203cli inbox --out .203/inbox.md --json
    203cli inbox K7M2QX --all --json

## Requests

### `203cli requests list CODE`

Requests under a firmware, each with its status (未处理 new, 正在完成 in_progress, 已完成 done, 已拒绝 rejected)

- `--status STATUS` Only these: 未处理|正在完成|进行中|已完成|已拒绝 or new|in_progress|done|rejected
- `--sort top|new` Order
- `--page N` Page, from 1 (24 a page)

    203cli requests list K7M2QX --sort top --json
    203cli requests list K7M2QX --status 正在完成 --json
    203cli requests list K7M2QX --status done --json

### `203cli requests show CODE N`

A request: its status, words, votes and attachments

    203cli requests show K7M2QX 3 --json

### `203cli requests create CODE`

Ask for something in a firmware (--attach: pictures, videos or files under it) (sign-in with write)

- `--title TEXT` 4-80 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` File
- `--attach FILE` Attach a local file (repeat, at most 9): a picture (PNG, JPEG, WebP, GIF ≤ 10 MB), a video (MP4, WebM, MOV ≤ 95 MB) or another file (a log, .txt, .zip, .ccproj, .bin, .elf, .json, .csv, .pdf … ≤ 20 MB); uploaded before the item is made (repeatable)

    203cli requests create K7M2QX --title "Swing for the arpeggiator" --json
    203cli requests create K7M2QX --title "Crash when saving" --body-file report.md --attach log.txt --attach screen.png --json

### `203cli requests vote CODE N VOTE`

Vote a request up (1), down (-1) or take it back (0) (sign-in with write)

    203cli requests vote K7M2QX 3 1 --json

### `203cli dev list`

Tracker: your firmware's requests with their internal status

- `--firmware CODE` One firmware
- `--status STATUS` new, accepted, planned, in_progress, done or rejected
- `--author ID|NAME` Only those this person (or bot) filed: a user id or an exact name
- `--sort top|new|updated` Order
- `--page N` Page, from 1 (24 a page)

    203cli dev list --firmware K7M2QX --sort top --json
    203cli dev list --author 大肥鱼 --sort new --json

### `203cli dev read CODE N`

Tracker: a request with votes, internal notes and the whole discussion

    203cli dev read K7M2QX 3 --json

### `203cli dev update CODE N`

Tracker: status, progress, labels, a note, a link (never notifies anyone) (sign-in with write)

- `--status STATUS` new, accepted, planned, in_progress, done or rejected
- `--progress 0-100` Progress
- `--labels a,b` Replaces the labels
- `--note TEXT` Appended note
- `--note-file PATH` Note from a file
- `--link URL` An https link, appended

    203cli dev update K7M2QX 3 --status in_progress --progress 10 --note "Plan: …" --json

### `203cli merges list CODE`

Merge requests aimed at a firmware

- `--status open|merged|closed|all` Which
- `--page N` Page, from 1 (24 a page)

    203cli merges list K7M2QX --json

### `203cli merges show CODE N`

A merge request

    203cli merges show K7M2QX 1 --json

### `203cli merges open PARENT`

Offer your fork back to its parent (sign-in with write)

- `--from CODE` Your fork's code (required)
- `--title TEXT` 1-120 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` File
- `--from-version VCODE` A version of the fork
- `--github-url URL` A GitHub pull request

    203cli merges open K7M2QX --from P4RK9T --title "A fifth track" --json

### `203cli merges status CODE N STATUS`

Merge, close or reopen a merge request (STATUS: merged, closed, open) (sign-in with write)

- `--merged-version VCODE` For merged: the version that has it

    203cli merges status K7M2QX 1 merged --json

### `203cli feedback`

Send feedback about the community (a bug or an idea; --attach: pictures, videos or files with it) (sign-in with write)

- `--kind bug|idea` Which (required)
- `--title TEXT` 1-120 characters (required)
- `--message TEXT` 1-2000 characters
- `--message-file PATH` File
- `--page PATH` Where on the site
- `--attach FILE` Attach a local file (repeat, at most 9): a picture (PNG, JPEG, WebP, GIF ≤ 10 MB), a video (MP4, WebM, MOV ≤ 95 MB) or another file (a log, .txt, .zip, .ccproj, .bin, .elf, .json, .csv, .pdf … ≤ 20 MB); uploaded before the item is made (repeatable)

    203cli feedback --kind bug --title "Typo on /levels" --message "Experiance" --json
    203cli feedback --kind bug --title "Upload stops at 90%" --message-file report.txt --attach screen.png --json

### `203cli feedback mine`

Your appeals and feedback, with their status and our reply

- `--page N` Page, from 1 (24 a page)

    203cli feedback mine --json

## Devices

### `203cli devices list`

Your devices: online (in its Launcher, or a firmware running) or off, last seen

    203cli devices list --json

### `203cli devices bind-code`

Web only: a Launcher signs in by approving its code on the site (/activate); the bind code is on /me/devices

- `--new` (web only)

    203cli devices bind-code

### `203cli devices rename DEVICE NAME...`

Web only: rename a device on /me/devices

    203cli devices rename 3 "Studio Cardenza"

### `203cli devices unbind DEVICE`

Web only: sign a device out on /me/devices (我的设备)

    203cli devices unbind 3

### `203cli flash [CODE]`

Install a firmware on a device over a USB cable (线刷), through its 203 Launcher: a firmware's newest build for the device (--channel) or a version, by its code, or a local --bin. No sign-in and no bound device: the device on, on a cable, in its Launcher or running a firmware (restarted into the Launcher first) (macOS and Linux)

- `--bin PATH` A local application image (build/<project>.bin) instead of a code
- `--port PORT` The serial port (/dev/ttyACM0, /dev/cu.usbmodem…; default: the one a running firmware comes back on, else the one USB serial port there is)
- `--channel stable|beta|dev` The line of a firmware's code (default stable)
- `--target DEVICE` The device (default: what its Launcher says; cardenza with --dry-run)
- `--name NAME` The name the Launcher keeps it under (default: the firmware's)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203cli flash V6QK28 --json
    203cli flash V6QK28 --channel beta --port /dev/ttyACM0 --json
    203cli flash --bin build/app.bin --json
    203cli flash V6QK28 --dry-run --json

### `203cli log`

A Cardenza's log over its USB cable: a running firmware's console (CardenzaHAL's system channel) or the serial port (the 203 Launcher, a firmware without USB); --until makes it a test (no sign-in; macOS and Linux)

- `--seconds N` How long to read (default: until Ctrl-C on a terminal, 20 s for a program, 60 s with --until)
- `--until REGEX` A test: stop with exit 0 at the first line that matches; exit 1 (log_timeout) when none does, or (device_crashed) at a panic or restart
- `--fail REGEX` Stop with exit 1 (device_crashed) at a line that matches (default with --until: a panic, abort, Backtrace, a restart)
- `--port PORT` Read this serial port (/dev/ttyACM0, /dev/cu.usbmodem…) instead of looking
- `--out FILE` Also append the lines to FILE

    203cli log
    203cli log --seconds 30 --json
    203cli log --until "ready" --seconds 30 --json
    203cli log --port /dev/ttyACM0 --out boot.log

### `203cli devices recover`

Recovery flash: the newest official Launcher and the device's official firmware, as the Launcher would have them (erases the whole internal flash; the SD card is not touched). --out saves the images and the esptool command, --port writes them with esptool

- `--target DEVICE` The device (default cardenza; GET /recovery lists them)
- `--port PORT` Write it now over USB with esptool (python3 -m esptool): /dev/ttyACM0, COM5 …; the device in download mode (a running CardenzaHAL firmware is restarted into it)
- `--out DIR` Save the images, plan.json and flash.sh (the esptool command) here instead
- `--launcher-only` Restore the Launcher alone (no official firmware)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, erase the device's internal flash (with --port)

    203cli devices recover --dry-run --json
    203cli devices recover --out recover --json
    203cli devices recover --port /dev/ttyACM0 --yes

### `203cli devices send DEVICE CODE`

Install a firmware (newest on a channel) or a version on a bound, online device and follow it (sign-in with write)

- `--start` Start it after installing
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--no-wait` Do not follow it
- `--unlock TOKEN` cfu_… for someone else's private firmware

    203cli devices send 3 K7M2QX --start --json
    203cli devices send 3 K7M2QX --no-wait --json

### `203cli devices status DEVICE COMMAND`

A command sent to a device (its id from devices send): downloading n %, installed, started, or why it failed; --wait follows it

- `--wait` Follow it until it ends

    203cli devices status 3 41 --json
    203cli devices status 3 41 --wait --json

### `203cli devices update-launcher DEVICE`

Upgrade the device's 203 Launcher to the newest for it (我的设备's 升级启动器) and follow it until the new Launcher runs; devices list shows launcher_update (sign-in with write)

- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--no-wait` Do not follow it

    203cli devices update-launcher 3 --json
    203cli devices update-launcher 3 --no-wait --json

## Board (a running firmware over USB)

### `203cli board info`

What the firmware on the cable is: name, version, community code, build, ELF SHA-256, CardenzaHAL commit, Launcher, chip, uptime and reset reason

    203cli board info
    203cli board info --json

### `203cli board partitions`

The flash: every partition (offsets and sizes in hex), app images and how full, NVS entries used, the running one, free flash

    203cli board partitions
    203cli board partitions --json

### `203cli board memory`

Heaps (internal, PSRAM, DMA: free, least free, largest block) and tasks (core, priority, stack left, CPU)

- `--window MS` How long CPU per task is measured, 10-2550 ms (default 500)

    203cli board memory
    203cli board memory --window 2000 --json

### `203cli board storage`

The SD card: mounted, its size, the file system's size and free space

    203cli board storage --json

### `203cli board status`

The display, keys down, the system menu, USB and the presence service

    203cli board status --json

### `203cli board i2c`

Every device that answers on the shared I2C bus (the codec, the expansion port's)

    203cli board i2c --json

### `203cli board screen`

A screenshot: the firmware's next frame as a PNG (prints its path)

- `--out FILE.png` Where to write it (default cardenza-<date>-<time>.png in the current folder)

    203cli board screen
    203cli board screen --out menu.png --json

### `203cli board press KEY...`

Press keys as a finger would, one after another (fn+s: together): esc, 1, q, fn, ok, space, up/down/left/right (; . , /), home …

- `--hold MS` How long each is held (default 100)
- `--gap MS` The pause after each (default 100)

    203cli board press down down ok
    203cli board press fn+s
    203cli board press home --json
    203cli board press esc --hold 1500

### `203cli board keys [STEP...]`

Keys down and up step by step (KEY:down, KEY:up, a number: milliseconds to wait); none: the keys held from the computer

    203cli board keys fn:down s:down 200 s:up fn:up
    203cli board keys --json

### `203cli board coredump`

The last crash's core dump: whether there is one, its task and backtrace; --out saves it, --elf decodes the backtrace, --erase erases it

- `--out FILE` Save the dump (for esp-coredump info_corefile -c FILE ELF)
- `--elf FILE` The firmware's ELF (build/<project>.elf): decode the backtrace with xtensa-esp32s3-elf-addr2line
- `--erase` Erase the dump afterwards (after --out saved it)

    203cli board coredump
    203cli board coredump --out crash.elf --elf build/my_synth.elf --json
    203cli board coredump --out crash.elf --erase

### `203cli board files ls [PATH]`

The files in a folder of the SD card (default its root; paths are from the card's root, a leading / or /sdcard/ is dropped)

    203cli board files ls
    203cli board files ls CardenzaSynth/Projects --json

### `203cli board files get PATH [LOCAL]`

Copy a file from the SD card here (LOCAL: a file or folder; default its name in the current folder)

    203cli board files get CardenzaSynth/Logs/log.txt
    203cli board files get CardenzaSynth/Projects/DEMO.ccproj backup/ --json

### `203cli board files put LOCAL [PATH]`

Copy a file onto the SD card (PATH: the file, or a folder it goes into; default its name at the root)

    203cli board files put kick.wav CardenzaSynth/Samples/
    203cli board files put song.ccproj CardenzaSynth/Projects/song.ccproj --json

### `203cli board files rm PATH`

Remove a file (or an empty folder) from the SD card

    203cli board files rm CardenzaSynth/Samples/old.wav --json

### `203cli board files mkdir PATH`

Make a folder on the SD card

    203cli board files mkdir CardenzaSynth/Samples/drums --json

### `203cli board files mv FROM TO`

Rename or move a file or folder on the SD card

    203cli board files mv Samples/a.wav Samples/kick.wav --json

## People

### `203cli me edit`

Change your name, bio or avatar (sign-in with write)

- `--name NAME` 2-24 letters, digits, CJK, _ - . (single spaces inside)
- `--bio TEXT` Up to 300 characters
- `--bio-file PATH` The bio from a file
- `--avatar a01..a24` One of the site's avatars

    203cli me edit --name "Lin" --bio "Makes grooveboxes for the Cardenza" --json

### `203cli xp`

Your XP history and level

- `--page N` Page, from 1 (24 a page)

    203cli xp --json

### `203cli levels`

Levels and the XP rules

    203cli levels --json

### `203cli badges`

Your badges

    203cli badges --json

### `203cli badges all`

Every badge and how it is earned

    203cli badges all --json

### `203cli badges wear ID...`

Wear 0-3 of your badges, in this order (none: take them all off) (sign-in with write)

    203cli badges wear b4k9 x2m7 --json
    203cli badges wear none --json

### `203cli titles`

Your titles

    203cli titles --json

### `203cli titles wear ID`

Wear a title (none: no title) (sign-in with write)

    203cli titles wear none --json

## Admin

### `203cli admin overview`

Admin: counts

    203cli admin overview --json

### `203cli admin users`

Admin: people

- `--q TEXT` Name or id
- `--status STATUS` active, banned or deleted
- `--page N` Page, from 1 (24 a page)

    203cli admin users --q mika --json

### `203cli admin ban ID`

Admin: ban a person (sign-in with write)

- `--reason TEXT` Why (required)
- `--days 1|7|30` How long (default: until lifted)

    203cli admin ban ab12cd34 --reason "spam" --days 7 --json

### `203cli admin unban ID`

Admin: lift a ban (sign-in with write)

    203cli admin unban ab12cd34 --json

### `203cli admin delete-user ID`

Admin: close an account Needs `--yes`.

- `--reason TEXT` Why (required)
- `--yes` Yes, do it (it cannot be undone)

    203cli admin delete-user ab12cd34 --reason "asked" --yes --json

### `203cli admin hide KIND REF`

Admin: hide content

- `--reason TEXT` Why

    203cli admin hide post ab12cd34 --reason spam --json

### `203cli admin unhide KIND REF`

Admin: unhide content

- `--reason TEXT` Why

    203cli admin unhide post ab12cd34 --reason spam --json

### `203cli admin delete KIND REF`

Admin: delete content Needs `--yes`.

- `--reason TEXT` Why
- `--yes` Yes, do it (it cannot be undone)

    203cli admin delete post ab12cd34 --reason spam --yes --json

### `203cli admin feature KIND REF`

Admin: feature (加精) firmware, a sound, project, work, model or post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203cli admin feature firmware K7M2QX --json

### `203cli admin official CODE`

Admin: the official tag on a firmware (--off removes it) (sign-in with write)

- `--off` Remove it

    203cli admin official K7M2QX --json

### `203cli admin pin ID`

Admin: pin a post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203cli admin pin ab12cd34 --json

### `203cli admin lock ID`

Admin: lock a post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203cli admin lock ab12cd34 --json

### `203cli admin add-official HUB_APP_ID`

Admin: show a hub App as an official firmware (sign-in with write)

- `--tags a,b` Tags

    203cli admin add-official 0b7c…-uuid --json

### `203cli admin section-set ID`

Admin: replace a section's categories and / or open or close it (sign-in with write)

- `--categories JSON` [{"tag":"lofi","label_zh":"Lo-fi","label_en":"Lo-fi"}]
- `--open` Open the section to everyone
- `--closed` Close it (admins only)

    203cli admin section-set models --categories '[{"tag":"case","label_zh":"外壳","label_en":"Cases"}]' --json
    203cli admin section-set sounds --open --json

### `203cli admin reports`

Admin: reports

- `--status open|resolved` Which
- `--page N` Page, from 1 (24 a page)

    203cli admin reports --json

### `203cli admin resolve N ACTION`

Admin: resolve a report (ACTION: dismiss, hide, delete, ban) (sign-in with write)

- `--note TEXT` Note
- `--days N` Ban days

    203cli admin resolve 12 dismiss --json

### `203cli admin audit`

Admin: the audit log

- `--actor ID` A user id
- `--page N` Page, from 1 (24 a page)

    203cli admin audit --json

### `203cli admin titles`

Admin: titles

    203cli admin titles --json

### `203cli admin title-create [TEXT]`

Admin: make a title (--zh / --en; one may be left out) (sign-in with write)

- `--zh TEXT` Chinese, up to 8 characters
- `--en TEXT` English, up to 16
- `--color COLOR` cyan, yellow, violet, green, pink, blue, lime, amber (needed but for an admin title)
- `--admin` An admin title (its colour is the admins' orange-red)

    203cli admin title-create --zh 测试员 --en Tester --color cyan --json

### `203cli admin grant-title USER TITLE`

Admin: grant a title (--off takes it back) (sign-in with write)

- `--off` Take it back

    203cli admin grant-title ab12cd34 t9p4b98w --json

### `203cli admin badge-create [NAME]`

Admin: make a badge to grant (sign-in with write)

- `--zh TEXT` Chinese name
- `--en TEXT` English name
- `--icon b01..b32` Its icon (required)
- `--description TEXT` Description
- `--description-zh TEXT` Chinese description
- `--description-en TEXT` English description

    203cli admin badge-create --en Helper --icon b05 --json

### `203cli admin grant-badge USER BADGE`

Admin: grant a badge (--off takes it back) (sign-in with write)

- `--off` Take it back

    203cli admin grant-badge ab12cd34 x2m7 --json

### `203cli admin xp USER DELTA`

Admin: adjust a person's XP (audited) (sign-in with write)

- `--reason TEXT` Why (required)

    203cli admin xp ab12cd34 50 --reason "Helped with the docs" --json

### `203cli admin issues`

Admin: appeals, bug reports and ideas, with their attachments

- `--kind false_positive|bug|idea` Which
- `--status STATUS` Status
- `--author ID|NAME` Only those this person (or bot) filed: a user id or an exact name
- `--page N` Page, from 1 (24 a page)

    203cli admin issues --kind false_positive --json
    203cli admin issues --author 大肥鱼 --json

### `203cli admin issue N`

Admin: an issue with the full check report, log and BINs

    203cli admin issue 7 --json

### `203cli admin issue-update N`

Admin: status, note, link, or a reply the author sees (sign-in with write)

- `--status STATUS` new, investigating, false_positive, confirmed, fixed or wont_fix
- `--note TEXT` Internal note
- `--note-file PATH` File
- `--link URL` A link
- `--reply TEXT` Shown to the author
- `--reply-file PATH` File

    203cli admin issue-update 7 --status false_positive --reply "Fixed in the checker" --json

### `203cli admin override VCODE`

Admin: publish a version the checks sent back (a false positive) (sign-in with write)

- `--note TEXT` Why
- `--note-file PATH` File

    203cli admin override V3X9PA --note "Touch IC missing in QEMU" --json

### `203cli admin recheck VCODE`

Admin: run a version's checks again (sign-in with write)

    203cli admin recheck V3X9PA --json

### `203cli admin bots create NAME`

Admin: make a bot account (role bot, tagged 机器人; it posts, comments, files requests and feedback with attachments, and reads; no votes, likes, reports, publishing or admin) and its token, shown once (sign-in with write)

- `--bio TEXT` Up to 300 characters
- `--bio-file PATH` The bio from a file
- `--token-file PATH` Write the token to this file (mode 600) and print only the path, instead of printing the token
- `--overwrite` With --token-file: replace a file that is there

    203cli admin bots create 大肥鱼 --bio "203 的客服机器人" --token-file ~/.config/dafeiyu/token --json
    203cli admin bots create 大肥鱼 --json

### `203cli admin bots list`

Admin: the bot accounts, with when each one's token was made and last used

- `--page N` Page, from 1 (24 a page)

    203cli admin bots list --json

### `203cli admin bots rotate ID`

Admin: a new token for a bot (ID: its id or name); the old one stops working at once (sign-in with write)

- `--token-file PATH` Write the token to this file (mode 600) and print only the path, instead of printing the token
- `--overwrite` With --token-file: replace a file that is there

    203cli admin bots rotate 大肥鱼 --token-file ~/.config/dafeiyu/token --overwrite --json
    203cli admin bots rotate ab12cd34 --json

## Other

### `203cli api METHOD PATH`

Call any endpoint (reference/api.md): GET or POST, a path below the API

- `--body JSON` A JSON body for POST

    203cli api GET /firmware/K7M2QX/versions --json

### `203cli ops`

Every API operation with its JSON schema (for programs)

    203cli ops

## Help topics

- `203cli help start` — Start here: what to run for what
- `203cli help new` — A new firmware for the Cardenza: make, build, try, publish, listen
- `203cli help project` — The project's firmware on the community: page, versions, what people say, forks, differences
- `203cli help link` — Binding a project to its firmware, and moving it
- `203cli help signin` — Signing in
- `203cli help publish` — Publishing a firmware version
- `203cli help ci` — Publishing from CI: trusted publishing from GitHub Actions (no secret)
- `203cli help manifest` — 203.json (the project file)
- `203cli help channels` — Channels
- `203cli help versions` — Version labels and codes
- `203cli help checks` — When the checks send a version back (exit 5)
- `203cli help page` — A good firmware page
- `203cli help cover` — Covers
- `203cli help description` — Writing the description: short, for people deciding to install (the guide, its template and an example)
- `203cli help pictures` — Pictures: the gallery above the description (3-5 screenshots), and pictures in the description
- `203cli help tutorials` — Tutorials (教程): how to use a firmware, in the one tutorial format
- `203cli help sounds` — Sound packs (official firmware only; the section may not be open yet)
- `203cli help projects` — Projects (official firmware only)
- `203cli help works` — Works (official firmware only)
- `203cli help models` — 3D models
- `203cli help errors` — Errors and exit codes
- `203cli help fork` — Changing someone's firmware: fork, clone, publish (provenance)
- `203cli help source` — Source code on the firmware page
- `203cli help rules` — The firmware project rules
- `203cli help sim` — Simulator versions (Play)
- `203cli help launchers` — Launchers: only the official 203 Launcher
- `203cli help devices` — Installing firmware on a device: over a USB cable (no sign-in) or sent over Wi-Fi
- `203cli help board` — A running firmware over USB: what it is, its memory, screen, keys, crash and SD card (203cli board)
- `203cli help requests` — Requests and the developer tracker
- `203cli help sandbox` — Running in a sandboxed agent (Claude Code on the web, Codex cloud…): allowing the community's hosts
- `203cli help admin` — Admins
