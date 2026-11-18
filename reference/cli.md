# 203c command reference

Generated from the CLI's command table (`node scripts/203c.mjs help --reference > reference/cli.md`). `203c` is the command
install.sh puts on PATH, else `node <the skill's folder>/scripts/203c.mjs`; run it from the firmware project's folder. Every
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
| `publish_only` | 1 | a trusted-publishing credential tried something else than publishing its firmware's versions (page edits, other firmware, account actions) | do that with the owner's own sign-in (on the site, or 203c login on a computer) |
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
| `needs_confirmation` | 6 | an action that needs a yes (deleting, a name someone else uses, turning a channel on) | add --yes if the user agrees |
| `launcher_official_only` | 1 | only the official 203 Launcher is offered: launchers are made and forked by admins only | publish your firmware as an app (leave out --launcher); do not fork a launcher |
| `sim_not_hal` | 1 | the simulator version cannot be built: the firmware calls the chip's drivers instead of CardenzaHAL (`unsupported` lists them) | use the HAL's API; publish goes on with the BIN alone (no Play) |
| `sim_toolchain` | 6 | Emscripten, CMake or Python is missing for the simulator version (in publish, on stable / beta: a decision) | install what `hint` says, or --no-sim |
| `sim_build_failed` | 6 | the firmware does not compile for the browser (`log_tail` has the errors) | fix them, or --no-sim (publish); sim build shows them again |
| `sim_no_web_target` | 1 | the CardenzaHAL found has no web target yet (no tools/cardenza_web.py) | --hal DIR with a checkout that has it; publish goes on with the BIN alone |
| `sim_not_project` | 2 | no ESP-IDF project of the firmware where 203c looked | --project DIR (publish) or sim build DIR |
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
| `firmware_unreachable` | 1 | flash / devices recover: the device runs a firmware and 203c cannot ask it to restart (Linux: no permission for its MIDI or HID; macOS: no python3 for CoreMIDI) | Linux: the audio group; macOS: xcode-select --install; or put it in its Launcher yourself (hold FN while turning it on) |
| `no_launcher_port` | 3 | flash / devices recover: the firmware was asked to restart and no serial port came up | plug the cable in again and run it again; a firmware that does not take the command: hold FN while turning it on |
| `launcher_countdown` | 3 | flash: the restarted Launcher started the firmware again before 203c reached it (twice) | hold FN on the device, run it again, let go of FN once the Launcher's menu shows |
| `launcher_busy` | 3 | flash: the Launcher is in a menu | go back to its home screen, then run it again |
| `device_timeout` | 3 | flash: the device stopped answering | plug the cable in again and run it again |
| `launcher_old` | 1 | flash: this Launcher cannot install over USB | update the Launcher (its home screen: Update Launcher) |
| `install_refused` | 1 | flash: the Launcher refused the image (its words follow) | read `error`; a broken or foreign image: build it again |
| `wrong_device` | 1 | flash: the device on the port is not the --target | leave out `--target` (the device says what it is) |
| `not_an_app` | 1 | flash --bin: not an application image (a merged image, bootloader, ELF …) | give build/<project>.bin; a Launcher comes back with `devices recover` |
| `launcher_image` | 1 | flash: the code is a launcher, which the Launcher does not install | `devices recover` restores the official Launcher |
| `download_only` | 1 | flash: the device takes a UF2 file copied onto it (Mystrix), no Launcher | `versions download VCODE --target …` and copy it onto the device |
| `unsupported_platform` | 1 | flash: the serial port is used on macOS and Linux only | on Windows: the firmware's page on the website, 用 USB 线安装 (Chrome or Edge) |
| `flash_failed` | 1 | esptool stopped while writing the device (`log_tail`) | put the device in download mode, check the cable and port, run it again: a device can always be restored again |
| `device_offline` | 1 | the device is off or not online (设备没开机或没联网) | ask the user to switch it on with Wi-Fi (in its Launcher or any CardenzaHAL firmware), then retry |
| `source_secrets` | 1 | the source archive holds files that look secret (`files`) | remove them from git (and revoke any pushed secret), commit, retry; or --no-source |
| `source_unavailable` | 1 | no source archive can be made here (not a git repository, no commit, git missing) | commit the source, or --no-source |
| `device_busy` | 3 | the device is installing something | wait, then retry |
| `not_installable` | 1 | launchers are flashed from the website, never sent | flash it on the website |
| `risk_not_accepted` | 1 | a third-party launcher | add --accept-risk if the user accepts it |
| `unreachable` | 3 | the API cannot be reached | check the network / --api; `doctor` |
| `unavailable` | 3 | the API or a provider failed | try again later |
| `upload_failed` | 3 | an upload failed | run the same command again: it resumes |

## Start

### `203c doctor`

Check everything 203c needs: Node, the API, the sign-in (kind, scopes), what is left today

    203c doctor --json

### `203c login`

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

    203c login
    203c login --json
    203c login --with-token < token.txt
    203c login --no-browser --json
    203c login --wait --json
    203c login --github-oidc --firmware K7M2QX --json

### `203c logout`

Sign out: revokes this token on the server and forgets it here (in GitHub Actions: the run's trusted-publishing credential)

    203c logout
    203c logout --json

### `203c whoami`

The signed-in account and this sign-in: its kind (cli or ci), name and scopes

    203c whoami --json

### `203c quotas`

What is left of every limit (firmware, versions today, works, models, …)

    203c quotas --json

### `203c help [TOPIC]`

Recipes: help start, publish, ci, manifest, fork, source, checks, page, errors …; or help COMMAND

    203c help publish
    203c help errors

### `203c rules`

The firmware project rules (CardenzaHAL's FIRMWARE-PROJECT.md): dependencies, files, HAL rules, builds, checks, publishing; --online for the newest

- `--online` Fetch the newest copy from the site (/develop.md) instead of the one in the skill

    203c rules
    203c rules --online

### `203c init`

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

    203c init --summary "A four-track groovebox" --json
    203c init --name "My synth" --bin build/my_synth.bin --publish-source --json

## Publishing

### `203c publish`

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
- `--description-file PATH` The page text from a Markdown file
- `--tags a,b` Up to 8 tags, comma-separated; one category: instrument, groovebox, tool, network, game
- `--cover IMAGE` A cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB)
- `--clone-url URL` https://….git for git clone
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--launcher` A new firmware is a launcher (merged full-flash images)
- `--license SPDX` The licence: an SPDX identifier (MIT, Apache-2.0, GPL-3.0-only, …) or proprietary
- `--manifest PATH` The project file (default: 203.json here or above, else 203c.json)

    203c publish --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --bin build/my-synth.bin --notes-file CHANGELOG.md --dry-run --json
    203c publish --firmware K7M2QX --bin build/my-synth.bin --json
    203c publish --firmware K7M2QX --channel dev --version "dev.$(date +%Y%m%d%H%M)" --bin build/my-synth.bin --json

### `203c versions publish CODE`

Publish a version of your firmware CODE (the same checks as publish; never makes a firmware) (sign-in with write)

- `--version V` The version label (1.4.0; no leading v). Default: the BIN's own version
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--bin [TARGET=]PATH` The application image for a device (repeat for several devices; TARGET defaults to cardenza); a download-only device takes its .uf2 file (mystrix=MatrixOS-Mystrix1.uf2, mystrix2=MatrixOS-Mystrix2.uf2) (repeatable)
- `--notes TEXT` Release notes (Markdown); @FILE reads a file
- `--notes-file PATH` Release notes from a file (CHANGELOG.md: the entry of this version)
- `--commit SHA` The commit it was built from (7-40 hex, or a git ref like HEAD)
- `--source-url URL` A link to this version's source
- `--notices PATH` NOTICES.txt (third-party licences, ≤ 1 MB)
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

    203c versions publish K7M2QX --version 1.4.0 --bin cardenza=build/app.bin --notes-file CHANGES.md --dry-run --json

### `203c firmware create`

Make a firmware (its page); publish versions to it with publish (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file
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

    203c firmware create --name "My synth" --summary "Four-track groovebox: drums, Juno, DX7, sampler" --tags groovebox --source-url https://github.com/me/my-synth --json

### `203c firmware edit CODE`

Change a firmware's page or settings (only the fields given) (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file
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

    203c firmware edit K7M2QX --summary "Four-track groovebox: drums, Juno, DX7, sampler" --json
    203c firmware edit K7M2QX --dev --json

### `203c firmware cover CODE [IMAGE]`

Set a firmware's cover picture (PNG/JPEG/WebP, 16:9, ≤ 2 MB); --remove takes it away (sign-in with write)

- `--file IMAGE` The picture (the same as IMAGE)
- `--remove` Remove the cover (a fork then shows its original's, else the screen after boot shows, else the grey default)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, do it (it cannot be undone)

    203c firmware cover K7M2QX cover.png --json
    203c firmware cover K7M2QX --file cover.png --dry-run --json
    203c firmware cover K7M2QX --remove --yes --json

### `203c firmware checklist CODE`

What a firmware's page has and lacks (cover, summary, description, links, notes), with the command for each

    203c firmware checklist K7M2QX --json

### `203c versions simulator CODE VCODE`

Upload a version's simulator version (the same as sim upload VCODE DIR) (sign-in with write)

- `--dir PATH` The folder of the web build (required)
- `--no-wait` Do not wait for its check
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c versions simulator K7M2QX V3X9PA --dir build-web/site --json

### `203c fork CODE [DIR]`

Fork a firmware to change it: makes your fork (or finds yours), clones its source into DIR and writes 203.json there (code, forked_from) (sign-in with write)

- `--name NAME` Your fork's name (default: the firmware's name and yours)
- `--summary TEXT` What your fork changes (default: a line saying it is a fork)
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--new` Make another fork even when you have one of this firmware
- `--clone DIR` Clone its source into DIR (the same as DIR)
- `--no-clone` Make the fork only; do not clone
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c fork V6QK28 my-synth --json
    203c fork K7M2QX --no-clone --json

### `203c clone CODE [DIR]`

git clone a firmware's source (its clone link, else its parent's) into DIR; publish from inside goes to CODE

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c clone K7M2QX my-synth --json

### `203c firmware publishers list CODE`

Trusted publishers of your firmware: the GitHub repositories (workflow, environment, channels, last use) whose Actions runs publish it without a secret

    203c firmware publishers list K7M2QX --json

### `203c firmware publishers add CODE`

Link a trusted publisher: a GitHub repository whose Actions runs (that workflow, that environment) may publish CODE's versions (at most 5) (sign-in with write)

- `--repository OWNER/NAME` The GitHub repository (a github.com link is taken too) (required)
- `--workflow FILE` The workflow's file in .github/workflows that publishes, e.g. firmware.yml (recommended: else any workflow of the repository)
- `--environment NAME` Only jobs in this GitHub environment (e.g. release, with its own protection rules)
- `--channels stable,beta,dev` The channels it may publish on (default all three; a run's ref limits them too: tags vX.Y.Z stable, vX.Y.Z-beta.N beta, else dev)

    203c firmware publishers add K7M2QX --repository me/my-synth --workflow firmware.yml --json
    203c firmware publishers add K7M2QX --repository me/my-synth --workflow release.yml --environment release --channels stable,beta --json

### `203c firmware publishers remove CODE ID`

Remove a trusted publisher (ID, or its OWNER/NAME when it is the only one of that repository): its runs' credentials stop working at once (sign-in with write) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c firmware publishers remove K7M2QX 3 --yes --json
    203c firmware publishers remove K7M2QX me/my-synth --yes --json

### `203c source check [DIR]`

What the source archive of the project in DIR (default here) would hold: the commit's tracked files, checked for secrets

    203c source check --json

### `203c source upload VCODE [DIR]`

Attach the source archive of the project in DIR (default here) to a version of yours (git archive of the commit, checked for secrets) (sign-in with write)

- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Upload although the working tree has uncommitted changes (they are not in the archive)

    203c source upload V3X9PA --dry-run --json
    203c source upload V3X9PA --json

### `203c source delete CODE VCODE`

Remove a version's source archive (sign-in with write) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c source delete K7M2QX V3X9PA --yes --json

## Simulator

### `203c sim build [DIR]`

Build the simulator version of the firmware in DIR (default here) with CardenzaHAL's web target; prints where

- `--hal DIR` The CardenzaHAL checkout (with its web target) that builds the simulator version (default: the project's own, else a cached clone)
- `--out DIR` Where to write it (default <project>/build-web/site)
- `--debug` A debug build (larger, with symbols)
- `--jobs N` Parallel compile jobs
- `--project DIR` The ESP-IDF project (the same as DIR)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c sim build --json
    203c sim build firmware/ --hal ~/CardenzaHAL --json

### `203c sim upload VCODE DIR`

Upload a built simulator version to a version of yours (only when it differs); the checker opens it, Play once it boots (sign-in with write)

- `--no-wait` Do not wait for the checker
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c sim upload V3X9PA build-web/site --json
    203c sim upload V3X9PA build-web/site --dry-run --json

### `203c sim check VCODE`

A version's simulator version: boots (Play), fails (why), or waiting for the checker; --again checks it again

- `--again` Ask the checker to open it again (owner or admin)
- `--no-wait` Do not wait for the checker
- `--timeout SECONDS` How long to wait for the checker (default 600: it runs every few minutes)
- `--poll SECONDS` How often to ask (default 5)

    203c sim check V3X9PA --json
    203c sim check V3X9PA --again --json

## Firmware

### `203c firmware mine`

Your own firmware (private ones too), with their codes

- `--page N` Page, from 1 (24 a page)

    203c firmware mine --json

### `203c firmware list`

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

    203c firmware list --official --json
    203c firmware list --q synth --limit 10 --json

### `203c firmware show CODE`

A firmware (a private one needs --unlock)

- `--unlock TOKEN` cfu_… from firmware unlock

    203c firmware show K7M2QX --json

### `203c firmware fork CODE`

Fork a firmware (or a version) into a new firmware of yours (sign-in with write)

- `--name NAME` The firmware's name, 1-64 characters (required)
- `--summary TEXT` The cover blurb, 1-100 characters: what it does (not just the name) (required)
- `--description TEXT` The page text (Markdown)
- `--description-file PATH` The page text from a Markdown file
- `--private` Only people with the code and the password see it
- `--password P` The download password of a private firmware (8-64 characters)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--force` Go on despite a quality warning (only when that is really meant)
- `--yes` Fork even when you have a firmware of this name

    203c firmware fork K7M2QX --name "My synth" --summary "K7M2QX with a fifth track" --json

### `203c firmware delete CODE`

Delete a firmware (its forks stay) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c firmware delete K7M2QX --yes --json

### `203c firmware like CODE`

Like a firmware

    203c firmware like K7M2QX --json

### `203c firmware unlike CODE`

Unlike a firmware

    203c firmware unlike K7M2QX --json

### `203c firmware favorite CODE`

Favorite a firmware

    203c firmware favorite K7M2QX --json

### `203c firmware unfavorite CODE`

Unfavorite a firmware

    203c firmware unfavorite K7M2QX --json

### `203c firmware tree CODE`

The fork tree around a firmware

    203c firmware tree K7M2QX --json

### `203c firmware lookup NAME...`

Firmware with exactly this name (ignoring case): yours first, any device, forks too

    203c firmware lookup "My synth" --json

### `203c firmware based-on CODE ORIGIN`

Record what your firmware CODE was made from (ORIGIN: a firmware or version code; none: an original); 203.json follows (sign-in with write)

- `--version LABEL` The original's version it was made from (its label, e.g. 0.3.0)
- `--unlock TOKEN` cfu_… when the original is private
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c firmware based-on K7M2QX V6QK28 --version 0.3.0 --json
    203c firmware based-on K7M2QX none --json

### `203c firmware unlock CODE`

Open a private firmware with its password: answers an unlock token for --unlock

- `--password P` The password (required)

    203c firmware unlock K7M2QX --password 1234 --json

### `203c firmware works CODE`

Works made with a firmware

- `--version VCODE` One version's works
- `--page N` Page, from 1 (24 a page)

    203c firmware works K7M2QX --json

### `203c versions list CODE`

A firmware's versions, newest first (yours: drafts, checking and sent back too)

- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--target DEVICE` Only versions with a BIN for this device (e.g. cardenza)
- `--page N` Page, from 1 (24 a page)

    203c versions list K7M2QX --json
    203c versions list K7M2QX --channel beta --target cardenza --json

### `203c versions label CODE LABEL`

A firmware's version by its label (1.4.0)

    203c versions label K7M2QX 1.4.0 --json

### `203c versions show VCODE`

A version and its firmware

    203c versions show V3X9PA --json

### `203c versions edit VCODE`

Change a version's release notes (sign-in with write)

- `--notes TEXT` Release notes (Markdown); @FILE reads a file
- `--notes-file PATH` Release notes from a file (CHANGELOG.md: the entry of this version)

    203c versions edit V3X9PA --notes "Fixes the arpeggiator at 1/32" --json

### `203c versions delete VCODE`

Delete a version (its code then answers deleted) Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c versions delete V3X9PA --yes --json

### `203c versions check VCODE`

A version's status and check report (steps, boot log, appeal)

    203c versions check V3X9PA --json

### `203c versions appeal VCODE`

The checks were wrong (a false positive): say why, 10-2000 characters (sign-in with write)

- `--message TEXT` Why the check is wrong
- `--message-file PATH` The message from a file

    203c versions appeal V3X9PA --message "It panics only because QEMU has no touch controller; on the device it boots" --json

### `203c versions download VCODE`

A version's BIN for a device

- `--target DEVICE` The device, e.g. cardenza (required)
- `--accept-risk` Accept a third-party launcher's risk
- `--out PATH` Save it here

    203c versions download V3X9PA --target cardenza --out app.bin --json

### `203c builds identify [FILE]`

What a BIN is: its signature checked by the community (a downloaded BIN ends with it), else its SHA-256; the firmware, version, lineage, and whether a newer build is out

- `--sha256 HEX` A file's SHA-256 instead of a file
- `--target DEVICE` The device (narrows a SHA-256 match)

    203c builds identify app.bin --json
    203c builds identify --sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --json

## Sharing

### `203c sounds upload FILE...`

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

    203c sounds upload pads.ccpreset pad-c3.wav --firmware 3YGNF5 --title "Warm pads" --tags pad --dry-run --json

### `203c sounds list`

Sound packs (official firmware)

- `--q WORDS` Search words
- `--tag TAG` A category or tag
- `--engine ENGINE` dx7, juno, sampler, drums or mixed
- `--firmware CODE` A firmware code
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203c sounds list --tag lofi --json

### `203c sounds show ID`

A sound (files, preview)

    203c sounds show ab12cd34 --json

### `203c sounds edit ID`

Change a sound (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Tags
- `--engine ENGINE` mixed or its banks' engine

    203c sounds edit ab12cd34 --tags pad,keys --json

### `203c sounds delete ID`

Delete a sound Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c sounds delete ab12cd34 --yes --json

### `203c sounds download ID`

A sound's files (every file into a folder, or --file NAME)

- `--file NAME` One file
- `--out PATH` Where to save (a folder without --file)

    203c sounds download ab12cd34 --out ./sounds --json

### `203c projects upload FILE...`

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

    203c projects upload NIGHT.ccproj kick.wav --firmware 3YGNF5 --title "Night drive" --preview night.mp3 --dry-run --json

### `203c projects list`

Projects (official firmware)

- `--q WORDS` Search words
- `--tag TAG` A category or tag
- `--firmware CODE` A firmware code
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203c projects list --tag lofi --json

### `203c projects show ID`

A project (files, preview)

    203c projects show ab12cd34 --json

### `203c projects edit ID`

Change a project (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Markdown
- `--description-file PATH` Markdown file
- `--tags a,b` Tags
- `--bpm N` 30-300

    203c projects edit ab12cd34 --tags pad,keys --json

### `203c projects delete ID`

Delete a project Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c projects delete ab12cd34 --yes --json

### `203c projects download ID`

A project's files (every file into a folder, or --file NAME)

- `--file NAME` One file
- `--out PATH` Where to save (a folder without --file)

    203c projects download ab12cd34 --out ./projects --json

### `203c works upload FILE`

Share a work (audio or video made with an official firmware) (sign-in with write)

- `--firmware CODE` The official firmware's code (required)
- `--version VCODE` The version it was made with
- `--version-label LABEL` A version name when there is no code
- `--title TEXT` 1-80 characters (default: the file name)
- `--description TEXT` Text
- `--tags a,b` Up to 5 tags
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c works upload song.wav --firmware 3YGNF5 --title "Rain" --tags lofi --dry-run --json

### `203c works list`

Works

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--firmware CODE` Firmware
- `--sort new|hot` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203c works list --tag lofi --json

### `203c works show ID`

A work

    203c works show ab12cd34 --json

### `203c works edit ID`

Change a work (sign-in with write)

- `--title TEXT` Title
- `--description TEXT` Text
- `--tags a,b` Tags
- `--version VCODE` A version code (empty: none)

    203c works edit ab12cd34 --tags lofi,demo --json

### `203c works delete ID`

Delete a work Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c works delete ab12cd34 --yes --json

### `203c works approve ID`

Publish a work your device sent (it is held until you approve it) (sign-in with write)

    203c works approve ab12cd34 --json

### `203c models upload FILE...`

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

    203c models upload stand.stl --title "Desk stand" --license CC-BY-4.0 --target cardenza --dry-run --json

### `203c models list`

Models

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--target DEVICE` Device
- `--firmware CODE` Firmware
- `--sort new|hot|downloads` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203c models list --target cardenza --json

### `203c models show ID`

A model

    203c models show ab12cd34 --json

### `203c models remixes ID`

Remixes of a model

- `--page N` Page, from 1 (24 a page)

    203c models remixes ab12cd34 --json

### `203c models delete ID`

Delete a model Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c models delete ab12cd34 --yes --json

### `203c models download ID`

A model file

- `--file NAME` One file (default the first)
- `--out PATH` Save it here

    203c models download ab12cd34 --out stand.stl --json

## Browse

### `203c sections`

The six sections and their counts

    203c sections --json

### `203c sections show ID`

A section's categories (use them as --tag) and tags

    203c sections show sounds --json

### `203c tags`

The most used tags

- `--kind KIND` firmware, post, work, model, sound or project
- `--section official|community` Firmware only

    203c tags --kind sound --json

### `203c search WORDS...`

Search everything (6 of each kind); a code is looked up

    203c search groovebox --json

### `203c code CODE`

What a firmware or version code names

    203c code K7M2QX --json

### `203c targets`

The devices the community knows

    203c targets --json

### `203c user ID [WHAT]`

A person, or their firmware|works|posts|models|sounds|projects|badges

- `--page N` Page, from 1 (24 a page)

    203c user ab12cd34 --json
    203c user ab12cd34 firmware --json

### `203c mine WHAT`

Your firmware|works|posts|models|sounds|projects

- `--page N` Page, from 1 (24 a page)

    203c mine sounds --json

### `203c notifications`

Your notifications (--read marks them read)

- `--read` Mark them all read
- `--page N` Page, from 1 (24 a page)

    203c notifications --json

### `203c favorites`

Your favourites

- `--kind KIND` firmware, post, work, model, sound or project
- `--page N` Page, from 1 (24 a page)

    203c favorites --kind firmware --json

## Community

### `203c posts list`

Forum posts

- `--q WORDS` Search words
- `--tag TAG` Tag
- `--firmware CODE` Firmware
- `--sort new|hot` Order
- `--page N` Page, from 1 (24 a page)
- `--cursor C` The previous answer's next_cursor (the next page)
- `--limit N` Items a page, 1-60

    203c posts list --json

### `203c posts show ID`

A post

    203c posts show ab12cd34 --json

### `203c posts create`

Write a post (sign-in with write)

- `--title TEXT` 1-120 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` Markdown file
- `--tags a,b` Up to 5
- `--firmware CODE` A firmware it is about

    203c posts create --title "1.4.0 is out" --body "What changed: …" --tags announcement --json

### `203c posts edit ID`

Change a post (sign-in with write)

- `--title TEXT` Title
- `--body TEXT` Markdown
- `--body-file PATH` Markdown file
- `--tags a,b` Tags

    203c posts edit ab12cd34 --title "1.4.1 is out" --json

### `203c posts delete ID`

Delete a post Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c posts delete ab12cd34 --yes --json

### `203c comments list KIND REF`

Comments on something (REF: a code, an id or CODE/N)

- `--page N` Page, from 1 (24 a page)

    203c comments list firmware K7M2QX --json

### `203c comments replies COMMENT`

Replies to a comment

- `--page N` Page, from 1 (24 a page)

    203c comments replies 42 --json

### `203c comments add KIND REF`

Comment on something (sign-in with write)

- `--body TEXT` 1-4000 characters
- `--body-file PATH` Text file
- `--parent COMMENT` Reply to this comment id

    203c comments add request K7M2QX/3 --body "Done in 1.5.0" --json

### `203c comments edit COMMENT`

Change your comment (sign-in with write)

- `--body TEXT` Text
- `--body-file PATH` Text file

    203c comments edit 42 --body "…" --json

### `203c comments delete COMMENT`

Delete a comment Needs `--yes`.

- `--yes` Yes, do it (it cannot be undone)

    203c comments delete 42 --yes --json

### `203c like KIND REF`

Like something (--off undoes it) (sign-in with write)

- `--off` Undo it

    203c like firmware K7M2QX --json

### `203c favorite KIND REF`

Favourite something (--off undoes it) (sign-in with write)

- `--off` Undo it

    203c favorite firmware K7M2QX --json

### `203c report KIND REF`

Report something to the admins (sign-in with write)

- `--reason spam|abuse|illegal|malware|copyright|other` Why (required)
- `--detail TEXT` Up to 1000 characters

    203c report post ab12cd34 --reason spam --json

## Requests

### `203c requests list CODE`

Requests under a firmware

- `--sort top|new` Order
- `--page N` Page, from 1 (24 a page)

    203c requests list K7M2QX --sort top --json

### `203c requests show CODE N`

A request

    203c requests show K7M2QX 3 --json

### `203c requests create CODE`

Ask for something in a firmware (sign-in with write)

- `--title TEXT` 4-80 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` File

    203c requests create K7M2QX --title "Swing for the arpeggiator" --json

### `203c requests vote CODE N VOTE`

Vote a request up (1), down (-1) or take it back (0) (sign-in with write)

    203c requests vote K7M2QX 3 1 --json

### `203c dev list`

Tracker: your firmware's requests with their internal status

- `--firmware CODE` One firmware
- `--status STATUS` new, accepted, planned, in_progress, done or rejected
- `--sort top|new|updated` Order
- `--page N` Page, from 1 (24 a page)

    203c dev list --firmware K7M2QX --sort top --json

### `203c dev read CODE N`

Tracker: a request with votes, internal notes and the whole discussion

    203c dev read K7M2QX 3 --json

### `203c dev update CODE N`

Tracker: status, progress, labels, a note, a link (never notifies anyone) (sign-in with write)

- `--status STATUS` new, accepted, planned, in_progress, done or rejected
- `--progress 0-100` Progress
- `--labels a,b` Replaces the labels
- `--note TEXT` Appended note
- `--note-file PATH` Note from a file
- `--link URL` An https link, appended

    203c dev update K7M2QX 3 --status in_progress --progress 10 --note "Plan: …" --json

### `203c merges list CODE`

Merge requests aimed at a firmware

- `--status open|merged|closed|all` Which
- `--page N` Page, from 1 (24 a page)

    203c merges list K7M2QX --json

### `203c merges show CODE N`

A merge request

    203c merges show K7M2QX 1 --json

### `203c merges open PARENT`

Offer your fork back to its parent (sign-in with write)

- `--from CODE` Your fork's code (required)
- `--title TEXT` 1-120 characters (required)
- `--body TEXT` Markdown
- `--body-file PATH` File
- `--from-version VCODE` A version of the fork
- `--github-url URL` A GitHub pull request

    203c merges open K7M2QX --from P4RK9T --title "A fifth track" --json

### `203c merges status CODE N STATUS`

Merge, close or reopen a merge request (STATUS: merged, closed, open) (sign-in with write)

- `--merged-version VCODE` For merged: the version that has it

    203c merges status K7M2QX 1 merged --json

### `203c feedback`

Send feedback about the community (a bug or an idea) (sign-in with write)

- `--kind bug|idea` Which (required)
- `--title TEXT` 1-120 characters (required)
- `--message TEXT` 1-2000 characters
- `--message-file PATH` File
- `--page PATH` Where on the site

    203c feedback --kind bug --title "Typo on /levels" --message "Experiance" --json

### `203c feedback mine`

Your appeals and feedback, with their status and our reply

- `--page N` Page, from 1 (24 a page)

    203c feedback mine --json

## Devices

### `203c devices list`

Your devices: online (in its Launcher, or a firmware running) or off, last seen

    203c devices list --json

### `203c devices bind-code`

Web only: a Launcher signs in by approving its code on the site (/activate); the bind code is on /me/devices

- `--new` (web only)

    203c devices bind-code

### `203c devices rename DEVICE NAME...`

Web only: rename a device on /me/devices

    203c devices rename 3 "Studio Cardenza"

### `203c devices unbind DEVICE`

Web only: sign a device out on /me/devices (我的设备)

    203c devices unbind 3

### `203c flash [CODE]`

Install a firmware on a device over a USB cable (线刷), through its 203 Launcher: a firmware's newest build for the device (--channel) or a version, by its code, or a local --bin. No sign-in and no bound device: the device on, on a cable, in its Launcher or running a firmware (restarted into the Launcher first) (macOS and Linux)

- `--bin PATH` A local application image (build/<project>.bin) instead of a code
- `--port PORT` The serial port (/dev/ttyACM0, /dev/cu.usbmodem…; default: the one a running firmware comes back on, else the one USB serial port there is)
- `--channel stable|beta|dev` The line of a firmware's code (default stable)
- `--target DEVICE` The device (default: what its Launcher says; cardenza with --dry-run)
- `--name NAME` The name the Launcher keeps it under (default: the firmware's)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing

    203c flash V6QK28 --json
    203c flash V6QK28 --channel beta --port /dev/ttyACM0 --json
    203c flash --bin build/app.bin --json
    203c flash V6QK28 --dry-run --json

### `203c devices recover`

Recovery flash: the newest official Launcher and the device's official firmware, as the Launcher would have them (erases the whole internal flash; the SD card is not touched). --out saves the images and the esptool command, --port writes them with esptool

- `--target DEVICE` The device (default cardenza; GET /recovery lists them)
- `--port PORT` Write it now over USB with esptool (python3 -m esptool): /dev/ttyACM0, COM5 …; the device in download mode (a running CardenzaHAL firmware is restarted into it)
- `--out DIR` Save the images, plan.json and flash.sh (the esptool command) here instead
- `--launcher-only` Restore the Launcher alone (no official firmware)
- `--dry-run` Check everything (files, values, permissions) and print the plan; change nothing
- `--yes` Yes, erase the device's internal flash (with --port)

    203c devices recover --dry-run --json
    203c devices recover --out recover --json
    203c devices recover --port /dev/ttyACM0 --yes

### `203c devices send DEVICE CODE`

Install a firmware (newest on a channel) or a version on a bound, online device and follow it (sign-in with write)

- `--start` Start it after installing
- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--no-wait` Do not follow it
- `--unlock TOKEN` cfu_… for someone else's private firmware

    203c devices send 3 K7M2QX --start --json
    203c devices send 3 K7M2QX --no-wait --json

### `203c devices status DEVICE COMMAND`

A command sent to a device (its id from devices send): downloading n %, installed, started, or why it failed; --wait follows it

- `--wait` Follow it until it ends

    203c devices status 3 41 --json
    203c devices status 3 41 --wait --json

### `203c devices update-launcher DEVICE`

Upgrade the device's 203 Launcher to the newest for it (我的设备's 升级启动器) and follow it until the new Launcher runs; devices list shows launcher_update (sign-in with write)

- `--channel stable|beta|dev` The channel (default stable; CI builds go to dev)
- `--no-wait` Do not follow it

    203c devices update-launcher 3 --json
    203c devices update-launcher 3 --no-wait --json

## People

### `203c me edit`

Change your name, bio or avatar (sign-in with write)

- `--name NAME` 2-24 letters, digits, CJK, _ - . (single spaces inside)
- `--bio TEXT` Up to 300 characters
- `--bio-file PATH` The bio from a file
- `--avatar a01..a24` One of the site's avatars

    203c me edit --name "Lin" --bio "Makes grooveboxes for the Cardenza" --json

### `203c xp`

Your XP history and level

- `--page N` Page, from 1 (24 a page)

    203c xp --json

### `203c levels`

Levels and the XP rules

    203c levels --json

### `203c badges`

Your badges

    203c badges --json

### `203c badges all`

Every badge and how it is earned

    203c badges all --json

### `203c badges wear ID...`

Wear 0-3 of your badges, in this order (none: take them all off) (sign-in with write)

    203c badges wear b4k9 x2m7 --json
    203c badges wear none --json

### `203c titles`

Your titles

    203c titles --json

### `203c titles wear ID`

Wear a title (none: no title) (sign-in with write)

    203c titles wear none --json

## Admin

### `203c admin overview`

Admin: counts

    203c admin overview --json

### `203c admin users`

Admin: people

- `--q TEXT` Name or id
- `--status STATUS` active, banned or deleted
- `--page N` Page, from 1 (24 a page)

    203c admin users --q mika --json

### `203c admin ban ID`

Admin: ban a person (sign-in with write)

- `--reason TEXT` Why (required)
- `--days 1|7|30` How long (default: until lifted)

    203c admin ban ab12cd34 --reason "spam" --days 7 --json

### `203c admin unban ID`

Admin: lift a ban (sign-in with write)

    203c admin unban ab12cd34 --json

### `203c admin delete-user ID`

Admin: close an account Needs `--yes`.

- `--reason TEXT` Why (required)
- `--yes` Yes, do it (it cannot be undone)

    203c admin delete-user ab12cd34 --reason "asked" --yes --json

### `203c admin hide KIND REF`

Admin: hide content

- `--reason TEXT` Why

    203c admin hide post ab12cd34 --reason spam --json

### `203c admin unhide KIND REF`

Admin: unhide content

- `--reason TEXT` Why

    203c admin unhide post ab12cd34 --reason spam --json

### `203c admin delete KIND REF`

Admin: delete content Needs `--yes`.

- `--reason TEXT` Why
- `--yes` Yes, do it (it cannot be undone)

    203c admin delete post ab12cd34 --reason spam --yes --json

### `203c admin feature KIND REF`

Admin: feature (加精) firmware, a sound, project, work, model or post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203c admin feature firmware K7M2QX --json

### `203c admin official CODE`

Admin: the official tag on a firmware (--off removes it) (sign-in with write)

- `--off` Remove it

    203c admin official K7M2QX --json

### `203c admin pin ID`

Admin: pin a post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203c admin pin ab12cd34 --json

### `203c admin lock ID`

Admin: lock a post (--off undoes it) (sign-in with write)

- `--off` Undo it

    203c admin lock ab12cd34 --json

### `203c admin add-official HUB_APP_ID`

Admin: show a hub App as an official firmware (sign-in with write)

- `--tags a,b` Tags

    203c admin add-official 0b7c…-uuid --json

### `203c admin section-set ID`

Admin: replace a section's categories and / or open or close it (sign-in with write)

- `--categories JSON` [{"tag":"lofi","label_zh":"Lo-fi","label_en":"Lo-fi"}]
- `--open` Open the section to everyone
- `--closed` Close it (admins only)

    203c admin section-set models --categories '[{"tag":"case","label_zh":"外壳","label_en":"Cases"}]' --json
    203c admin section-set sounds --open --json

### `203c admin reports`

Admin: reports

- `--status open|resolved` Which
- `--page N` Page, from 1 (24 a page)

    203c admin reports --json

### `203c admin resolve N ACTION`

Admin: resolve a report (ACTION: dismiss, hide, delete, ban) (sign-in with write)

- `--note TEXT` Note
- `--days N` Ban days

    203c admin resolve 12 dismiss --json

### `203c admin audit`

Admin: the audit log

- `--actor ID` A user id
- `--page N` Page, from 1 (24 a page)

    203c admin audit --json

### `203c admin titles`

Admin: titles

    203c admin titles --json

### `203c admin title-create [TEXT]`

Admin: make a title (--zh / --en; one may be left out) (sign-in with write)

- `--zh TEXT` Chinese, up to 8 characters
- `--en TEXT` English, up to 16
- `--color COLOR` cyan, yellow, violet, green, pink, blue, lime, amber (needed but for an admin title)
- `--admin` An admin title (its colour is the admins' orange-red)

    203c admin title-create --zh 测试员 --en Tester --color cyan --json

### `203c admin grant-title USER TITLE`

Admin: grant a title (--off takes it back) (sign-in with write)

- `--off` Take it back

    203c admin grant-title ab12cd34 t9p4b98w --json

### `203c admin badge-create [NAME]`

Admin: make a badge to grant (sign-in with write)

- `--zh TEXT` Chinese name
- `--en TEXT` English name
- `--icon b01..b32` Its icon (required)
- `--description TEXT` Description
- `--description-zh TEXT` Chinese description
- `--description-en TEXT` English description

    203c admin badge-create --en Helper --icon b05 --json

### `203c admin grant-badge USER BADGE`

Admin: grant a badge (--off takes it back) (sign-in with write)

- `--off` Take it back

    203c admin grant-badge ab12cd34 x2m7 --json

### `203c admin xp USER DELTA`

Admin: adjust a person's XP (audited) (sign-in with write)

- `--reason TEXT` Why (required)

    203c admin xp ab12cd34 50 --reason "Helped with the docs" --json

### `203c admin issues`

Admin: appeals, bug reports and ideas

- `--kind false_positive|bug|idea` Which
- `--status STATUS` Status
- `--page N` Page, from 1 (24 a page)

    203c admin issues --kind false_positive --json

### `203c admin issue N`

Admin: an issue with the full check report, log and BINs

    203c admin issue 7 --json

### `203c admin issue-update N`

Admin: status, note, link, or a reply the author sees (sign-in with write)

- `--status STATUS` new, investigating, false_positive, confirmed, fixed or wont_fix
- `--note TEXT` Internal note
- `--note-file PATH` File
- `--link URL` A link
- `--reply TEXT` Shown to the author
- `--reply-file PATH` File

    203c admin issue-update 7 --status false_positive --reply "Fixed in the checker" --json

### `203c admin override VCODE`

Admin: publish a version the checks sent back (a false positive) (sign-in with write)

- `--note TEXT` Why
- `--note-file PATH` File

    203c admin override V3X9PA --note "Touch IC missing in QEMU" --json

### `203c admin recheck VCODE`

Admin: run a version's checks again (sign-in with write)

    203c admin recheck V3X9PA --json

## Other

### `203c api METHOD PATH`

Call any endpoint (reference/api.md): GET or POST, a path below the API

- `--body JSON` A JSON body for POST

    203c api GET /firmware/K7M2QX/versions --json

### `203c ops`

Every API operation with its JSON schema (for programs)

    203c ops

## Help topics

- `203c help start` — Start here: what to run for what
- `203c help signin` — Signing in
- `203c help publish` — Publishing a firmware version
- `203c help ci` — Publishing from CI: trusted publishing from GitHub Actions (no secret)
- `203c help manifest` — 203.json (the project file)
- `203c help channels` — Channels
- `203c help versions` — Version labels and codes
- `203c help checks` — When the checks send a version back (exit 5)
- `203c help page` — A good firmware page
- `203c help cover` — Covers
- `203c help sounds` — Sound packs (official firmware only; the section may not be open yet)
- `203c help projects` — Projects (official firmware only)
- `203c help works` — Works (official firmware only)
- `203c help models` — 3D models
- `203c help errors` — Errors and exit codes
- `203c help fork` — Changing someone's firmware: fork, clone, publish (provenance)
- `203c help source` — Source code on the firmware page
- `203c help rules` — The firmware project rules
- `203c help sim` — Simulator versions (Play)
- `203c help launchers` — Launchers: only the official 203 Launcher
- `203c help devices` — Installing firmware on a device: over a USB cable (no sign-in) or sent over Wi-Fi
- `203c help requests` — Requests and the developer tracker
- `203c help admin` — Admins
