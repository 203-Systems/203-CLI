# Cardenza (鸣片): making firmware

The Cardenza is 203 Systems' pocket synthesiser: an ESP32-S3 with a 240 × 135 colour screen, 56 keys with a light
each, a speaker, a microphone, an SD card and USB. Its firmware is installed and updated by the **203 Launcher**
from the **203 community**, where anyone can publish one.

Community device id: **`cardenza`** (the default device of `203cli publish`). Status: open to everyone.

## How to make one

1. **Install 203cli (required)**: `npm install -g 203cli && 203cli skill install` (Node.js 18 or later; macOS, Linux and
   Windows alike). Every step below uses it, and a firmware on CardenzaHAL does not build without it: the HAL's build
   stops and says how to install it. Cloning this repository does not install it.
2. **Read the rules**: [`reference/firmware-project.md`](../../reference/firmware-project.md) (`203cli rules` prints
   it). They are CardenzaHAL's
   [`docs/FIRMWARE-PROJECT.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.md)
   ([简体中文](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.zh-CN.md)): dependencies,
   the project's files and `203.json`, the HAL rules, builds for the board and the browser, what the community
   checks, versions and channels, forks, publishing from CI, what never to commit. Follow them; this page only says
   where to start.
3. **Build on [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL)**, the Cardenza's hardware layer (an ESP-IDF
   component, added as a git submodule at `components/CardenzaHAL`). It gives you the keys and key lights, the
   display, audio out and the microphone, the SD card, the Func (HOME) button, IR and USB (MIDI, audio, HID), and the
   native ESP-IDF handles behind them. Reach the hardware only through it: that is what makes the same source build
   for the browser simulator, and what the community's checks expect. Missing something? Open an issue or a pull
   request on CardenzaHAL rather than writing a driver into your firmware.
4. **Start a project**: `203cli new "My firmware" --summary "…"` makes it from
   [`examples/template`](https://github.com/203-Systems/CardenzaHAL/tree/main/examples/template) (the HAL as a submodule,
   the board's defaults, a partition table that keeps the Launcher, `version.txt`, `CHANGELOG.md`, `203.json` and the
   release workflow), named; it builds as it is. A project you have already: `203cli init` writes its `203.json`.
   **Or change a firmware that exists**: `203cli fork CODE my-firmware` clones its source and records where it comes
   from. The official groovebox, [CardenzaSynth](https://github.com/203-Systems/CardenzaSynth) (Cardenza Synth,
   code `V6QK28`), is the largest example of a firmware on the HAL.
5. **Build** with the HAL's tool, for the board and for the browser, and try it on a Cardenza (below).
6. **Publish** with `203cli` (below); after the first version, let CI publish every push and tag (`203cli link`), and read
   what users ask for with `203cli sync` (`.203/community.md`: requests, comments, forks) before each change.

## Toolchain

| | Version | For |
|---|---|---|
| [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.3.5/esp32s3/get-started/) | 5.3.5 (5.3 or later works; CI uses `espressif/idf:v5.3.5`) | the firmware |
| [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and CMake 3.20+ | latest | the simulator version (Play on the community) |
| Node.js | 18 or later | `203cli` |
| Python 3 | | the HAL's host tools (`cardenza_web.py`, `cardenza_flash.py`, `cardenza_usb.py`) |

## Running in a sandboxed agent (Claude Code on the web, Codex cloud…)

A coding agent in a cloud sandbox reaches only the hosts its environment allows, and only the user can change that,
per environment (a file in the repository cannot). npm and GitHub are on Claude Code's default list, so
`npm install -g 203cli` and `203cli skill install` work there; the 203 community is on no default list.

- **Allow `cardenza.203.io` and `apps.203.io`** (the community and its twin). Claude Code on the web: at
  <https://claude.ai/code>, the environment selector under the message box → Cloud → the environment's settings
  (gear) icon → Network access: **Limited**, keep **Allow package managers** on, add both to **Allowed domains** (one
  per line) → **Save changes** (or choose **Full**); a session already open follows within about a minute. A shared
  Team or Enterprise environment: an Owner changes it in claude.ai's admin settings › Cloud environments
  ([Claude Code's cloud environments](https://code.claude.com/docs/en/cloud-environments.md#network-access)). Codex
  cloud and other sandboxes keep their own allowlist per environment: add the same two hosts there.
- Building may need Espressif's hosts as well (the first build fetches TinyUSB from Espressif's component registry):
  allow `*.espressif.com`, or install ESP-IDF and build once in the environment's setup script.
- `203cli doctor` checks both hosts. A blocked request is `network_blocked_sandbox` (the sandbox's allowlist; its
  `hint` has these steps) or `network_blocked_cdn` (the site's firewall, not the sandbox: report its Ray ID).
  `203cli help sandbox` has it all.
- Until then, what needs no network still works: building, `203cli rules`, `203cli skill install`, and on a computer
  with the Cardenza on its USB cable `203cli flash --bin`, `203cli log` and `203cli board`.

## Build and try

The HAL's [`tools/cardenza.py`](https://github.com/203-Systems/CardenzaHAL/blob/main/tools/cardenza.py) is the
preferred way to build: it checks ESP-IDF 5.3, a clean HAL submodule and `203cli` first, and exports ESP-IDF for the
build when the shell has not (an agent's shell starts fresh every time).

```sh
python3 components/CardenzaHAL/tools/cardenza.py doctor   # what this computer still needs, and how to install it
python3 components/CardenzaHAL/tools/cardenza.py build    # build/<project>.bin: the application image you publish
python3 components/CardenzaHAL/tools/cardenza.py web      # the browser version (build-web/site)
python3 components/CardenzaHAL/tools/cardenza_web.py serve build-web/site   # http://localhost:8000/
```

On a board: install your build through the Launcher, the way users get it, and read what it prints.

```sh
203cli flash --bin build/<project>.bin --json  # over a USB cable, no sign-in (macOS, Linux, Windows)
203cli log --json                             # its log: the firmware's console over USB, or the serial port (macOS, Linux)
203cli log --until "ready" --seconds 30 --json  # a test: exit 0 at the line, 1 at a panic or when it never comes
```

### Update notices

`203cli` and the build say when an update is out, once a day at most: a newer `203cli` ("203cli X is out (you have Y):
npm install -g 203cli && 203cli skill install") and this project's CardenzaHAL behind its `main` ("CardenzaHAL in this
project (components/CardenzaHAL) is N commits behind its main: git submodule update --remote components/CardenzaHAL,
build and test, then commit the new pointer"), or not a clean copy of it. `203cli` prints them on stderr after `sim`,
`flash`, `log`, `board`, `new`, `fork`, `publish`, `rules` and the other commands of the work; `idf.py build`,
`cardenza.py build` and the web build print them as a CMake warning; `203cli doctor` and `cardenza.py doctor` list them;
`203cli updates` asks now. They never change an answer or an exit code, and stay silent offline. Off in CI and with
`NO_UPDATE_NOTIFIER=1` (or `C203_NO_UPDATE_CHECK=1`).

### Look inside a running firmware: `203cli board`

A firmware on CardenzaHAL answers a computer's questions about itself over USB, without a line of its own and at no
cost until asked: the HAL's development channel
([`docs/usb-dev.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/usb-dev.md)). `203cli board` is the
computer's side, signed out like `flash` and `log` (macOS, Linux and Windows):

```sh
203cli board info --json               # name, version, code, build, ELF SHA-256, HAL commit, Launcher, chip, reset reason
203cli board memory                    # heaps (internal, PSRAM, DMA) and tasks: stack left, CPU
203cli board partitions                # the flash table, app images, NVS use, the running slot
203cli board screen --out shot.png     # the next frame as a PNG: check what you drew
203cli board press down down ok        # keys as by a finger (cap names, up/down/left/right, fn+s, home)
203cli board coredump --out crash.elf --elf build/<project>.elf  # the last crash, its backtrace decoded
203cli board files ls Apps            # the SD card: ls, get, put, rm, mkdir, mv
203cli board settings                  # the board's settings: volume and its limit, brightness, key lights, mic gain, language
203cli board settings set volume 50    # one of them (get KEY, reset); the device writes it to its flash a second later
```

The board's settings are the HAL's, the same in every firmware on it and in the HOME menu (Settings;
[`docs/SETTINGS.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/SETTINGS.md)): `CardenzaHAL::Init`
applies them, so a firmware does not set the volume or the brightness itself. Every firmware that starts USB answers
`203cli board settings`, also one built without the development channel; a HAL from before 2026-11-23 says
`hal_too_old`.

Two things it needs: the firmware is **built with a current CardenzaHAL** (an older one says `hal_too_old`: update the
submodule, build, flash), and it **starts the HAL's USB device**: `CardenzaHAL::USB::Init();` after
`CardenzaHAL::Init()` in `app_main` (`usb/usb.h`). The template does not call it, so such a firmware is only a serial
port (USB-Serial-JTAG) and `203cli board` says `board_no_usb`; `203cli log` still reads its console there. With the
device in its 203 Launcher there is no firmware to ask (`board_in_launcher`). `203cli help board` has every command.

`idf.py flash` writes the whole flash and **erases the 203 Launcher** with every firmware it installed. While
developing, the HAL's [`tools/cardenza_flash.py`](https://github.com/203-Systems/CardenzaHAL/blob/main/tools/cardenza_flash.py)
refuses to do that and writes only the app into one of the Launcher's slots (`--app-into <label>`). A firmware that
starts USB has no serial port: `python3 components/CardenzaHAL/tools/cardenza_usb.py command launcher` (or
`download`) restarts it into the Launcher (or ROM download mode), and `console` reads its log.

Before you write hot code, read the HAL's [`docs/developing.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/developing.md):
two RAMs (internal and the 2 MB PSRAM), atomics with PSRAM, `memcpy` and division on this chip, flash writes,
reading files, the screen's ticks, USB.

## Publish

```sh
203cli login                       # once: opens the browser, you approve on the site
203cli publish --dry-run --json    # reads ./203.json; fix what it reports
203cli publish --json              # the first version gives the firmware its code: commit 203.json
```

Then the standard release, the same for 203 Systems' own firmware and everyone else's: the template's
`.github/workflows/firmware.yml` with the HAL's
[`community-publish`](https://github.com/203-Systems/CardenzaHAL/blob/main/.github/actions/community-publish/action.yml)
action. A push to `main` publishes a **dev** version, a tag `vX.Y.Z` (equal to `version.txt`, notes from
`CHANGELOG.md`) **stable**, `vX.Y.Z-beta.N` **beta**. No secret is stored: link the repository on the firmware's
page (自动发布 / Trusted publishing) or with `203cli firmware publishers add CODE --repository OWNER/NAME --workflow
firmware.yml`, and the job signs in with its GitHub OIDC token (`203cli help ci`).

The community checks every build: an ESP32-S3 application image (not the bootloader, a merged image or the ELF)
that fits the Launcher's room (`203cli publish --dry-run` says how much of it a build uses), built on CardenzaHAL, that
boots; and a simulator version that boots for Play. A stable version needs a cover (a 16:9 picture).

### The page: a short description and 3–5 screenshots

People who are not developers decide on the page whether to install it, so it reads like a product page
([the guide](https://cardenza.203.io/community/guide/description), `203cli help description`):

- **The description** is `docs/description.md` (203.json's `publish.description_file`; `203cli new` and `203cli init`
  write it from the guide's template: fill in every `<…>`). One or two sentences on what it is, `## Features` with 3–6
  bullets, `## Needs` when it needs something, `## Get started` in 1–3 lines, and a line to its tutorial. Aim for 800
  characters (pictures not counted): 203cli warns over 1500 and refuses over 3000 (`description_too_long`), and so does
  the community. Not in it: key tables and every mode's keys (its tutorial), building it (the README, which is for
  developers and is not the page), what changed (the release notes).
- **The gallery**, the large pictures above the description, is 3–5 different screenshots of the firmware itself: the
  screen people see first, then its main features. With it running on a Cardenza on USB (it starts CardenzaHAL's USB,
  `CardenzaHAL::USB::Init()`): `203cli board screen --out docs/screens/1.png`, and so on; list them in 203.json's
  `publish.images`. `203cli publish` signed in yourself stops before uploading anything unless the gallery it leaves has
  3–5 pictures, all different (`gallery_pictures`); on the website they are only suggested. A trusted-publishing run
  (CI) cannot change pictures, so it never fails for them: it warns (`gallery_short`, an annotation on the run) and the
  owner adds them once.

## Tutorials

How to use a firmware (its keys, menus and settings) goes in a **tutorial** on its community page (the 教程 /
Tutorials tab), not in the description: lessons of short steps in the Cardenza Learn guide's format, each step's
keys lit on a drawing of the board and its screenshot in the board's display. The format, with every rule the
community enforces: [reference/tutorial-format.md](../../reference/tutorial-format.md). Key names are the caps'
names below (`fn`, `ok`, `;`, `home`, `fn+s` for keys pressed together); a step's screenshot can come from the
device itself: `203cli board screen --out docs/shots/menu.png`.

```sh
203cli tutorial new                    # docs/tutorial.json for 203.json's firmware (--languages en for English only)
203cli tutorial check                  # every error with its line and column
203cli tutorial publish --dry-run      # then without --dry-run: pictures uploaded once, your tutorial added or changed
203cli tutorial link CODE https://… --title "Video: the first ten minutes"  # a tutorial elsewhere
```

## Hardware reference

What each part does and where it is in the HAL (header, functions, README section):
[CardenzaHAL README › The hardware](https://github.com/203-Systems/CardenzaHAL/blob/main/README.md#the-hardware). In short:

| | |
|---|---|
| Chip | ESP32-S3 (dual core, 240 MHz), 2 MB quad PSRAM on the flash bus |
| Flash | 16 MB, quad I/O at 120 MHz ([`board/sdkconfig.defaults`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/sdkconfig.defaults)); the 203 Launcher keeps everything below 0x170000 ([`board/partitions.csv`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/partitions.csv)) and uses what its bootloader declares (8 MB on a board flashed with Launcher 0.3.3 or earlier, until its bootloader is written again over USB), so one app gets at most 0x690000 bytes |
| Display | 240 × 135, RGB565, ST7789 on SPI, backlight on LEDC; a whole frame is 17 ms of SPI |
| Keys | 4 rows × 14 columns = 56 keys (numbers 1..56 = `y * 14 + x + 1`), at most 4 held at once are read reliably; a single-colour LED under each key, 16 levels plus a global brightness |
| Buttons | HOME, the side key, on GPIO0 (the HAL's Func button; held at reset it starts the ROM download mode) |
| Audio out | ES8156 codec, 44.1 kHz 16-bit, mono speaker (stereo I2S slots available) |
| Microphone | PDM, 44.1 kHz mono; its clock shares GPIO43 with the speaker's word select |
| Storage | microSD, 4-bit SDMMC, FAT at `/sdcard`; each firmware's files in `/sdcard/Apps/<AppName>/`, the 203 Launcher's in `/sdcard/Launcher/` ([`docs/SD-CARD.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/SD-CARD.md), `storage/app_dir.h`) |
| IR | transmitter on GPIO44 (NEC, 38 kHz) |
| USB | the chip's USB PHY: USB-Serial-JTAG, or the HAL's composite device (MIDI 1.0, Audio 2.0 both ways, HID), VID 0x0203 |
| Pins | [`board/pins.h`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/pins.h) is the source; the HAL README's "Hardware resource ownership" lists which peripheral the HAL owns |

### Keys and their legends

Each cap has its key's character in black, its shifted character in yellow, and on four keys a yellow triangle: the
arrows. Key numbers are the HAL's (`y * 14 + x + 1`, row 0 at the top; `203cli board press` takes the cap names).

| Keys | Caps, left to right (character, shifted character, arrow) |
|---|---|
| 1-14 | esc · 1 ! · 2 @ · 3 # · 4 $ · 5 % · 6 ^ · 7 & · 8 * · 9 ( · 0 ) · - _ · = + · del (←) |
| 15-28 | tab · Q W E R T Y U I O P · [ { · ] } · \ \| |
| 29-42 | fn · shift (⇧) · A S D F G H J K L · ; : ▲ · ' " · ok (enter) |
| 43-56 | ctrl · opt · alt · Z X C V B N M · , < ◀ · . > ▼ · / ? ▶ · space (␣) |
| HOME | the side key left of the screen (GPIO0): opens the HAL's system menu in any firmware |

The arrows are `;` `.` `,` `/` (up, down, left, right, keys 40, 54, 53, 55). In text input they type their
characters, so there the arrows are fn + those keys; lists, menus and games may take them alone, as the 203 Launcher
does. ok confirms, esc goes back. Never invent other arrow keys (no HJKL, IJKL or WASD). CardenzaHAL adds this table as
`keyboard/legends.h` (`kKeyUp`, `kKeyDown`, `kKeyLeft`, `kKeyRight`, `kKeyOk`, `kKeyEsc` …): use those names where your
HAL has it, the numbers above with an older one.

Files:

- Schematic (V1.0): [Cardenza-Hardware/Cardenza_V1.0_SCH.pdf](https://github.com/203-Systems/Cardenza-Hardware/blob/main/Cardenza_V1.0_SCH.pdf)
- PCB 3D model (STEP), for cases and accessories:
  [Cardenza-Hardware/Cardenza-PCB-3D.step](https://github.com/203-Systems/Cardenza-Hardware/blob/main/Cardenza-PCB-3D.step),
  also as a zip from the community: <https://cardenza.203.io/community/downloads/Cardenza-PCB-2026-10-26.zip>
  (share what you print in the community's 模型 / Models section: `203cli models upload`).

## Links

| | |
|---|---|
| CardenzaHAL (the hardware layer, examples, host tools, web target) | <https://github.com/203-Systems/CardenzaHAL> |
| CardenzaSynth (the official firmware, a full example) | <https://github.com/203-Systems/CardenzaSynth> |
| Cardenza-Hardware (schematic, PCB model) | <https://github.com/203-Systems/Cardenza-Hardware> |
| The 203 community and its developer guide | <https://cardenza.203.io/community>, <https://cardenza.203.io/community/develop> |
| Learn Cardenza (the user's guide) | <https://cardenza.203.io> |
| Product page | <https://203.io/products/cardenza-mini-synthsiser> |
