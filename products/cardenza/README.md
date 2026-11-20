# Cardenza (鸣片): making firmware

The Cardenza is 203 Systems' pocket synthesiser: an ESP32-S3 with a 240 × 135 colour screen, 56 keys with a light
each, a speaker, a microphone, an SD card and USB. Its firmware is installed and updated by the **203 Launcher**
from the **203 community**, where anyone can publish one.

Community device id: **`cardenza`** (the default device of `203c publish`). Status: open to everyone.

## How to make one

1. **Install 203c (required)**: `npm install -g 203c && 203c skill install` (Node.js 18 or later; macOS, Linux and
   Windows alike). Every step below uses it, and a firmware on CardenzaHAL does not build without it: the HAL's build
   stops and says how to install it. Cloning this repository does not install it.
2. **Read the rules**: [`reference/firmware-project.md`](../../reference/firmware-project.md) (`203c rules` prints
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
4. **Start a project**: `203c new "My firmware" --summary "…"` makes it from
   [`examples/template`](https://github.com/203-Systems/CardenzaHAL/tree/main/examples/template) (the HAL as a submodule,
   the board's defaults, a partition table that keeps the Launcher, `version.txt`, `CHANGELOG.md`, `203.json` and the
   release workflow), named; it builds as it is. A project you have already: `203c init` writes its `203.json`.
   **Or change a firmware that exists**: `203c fork CODE my-firmware` clones its source and records where it comes
   from. The official groovebox, [CardenzaSynth](https://github.com/203-Systems/CardenzaSynth) (Cardenza Synth,
   code `V6QK28`), is the largest example of a firmware on the HAL.
5. **Build** with the HAL's tool, for the board and for the browser, and try it on a Cardenza (below).
6. **Publish** with `203c` (below); after the first version, let CI publish every push and tag (`203c link`), and read
   what users ask for with `203c sync` (`.203/community.md`: requests, comments, forks) before each change.

## Toolchain

| | Version | For |
|---|---|---|
| [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.3.5/esp32s3/get-started/) | 5.3.5 (5.3 or later works; CI uses `espressif/idf:v5.3.5`) | the firmware |
| [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and CMake 3.20+ | latest | the simulator version (Play on the community) |
| Node.js | 18 or later | `203c` |
| Python 3 | | the HAL's host tools (`cardenza_web.py`, `cardenza_flash.py`, `cardenza_usb.py`) |

## Build and try

The HAL's [`tools/cardenza.py`](https://github.com/203-Systems/CardenzaHAL/blob/main/tools/cardenza.py) is the
preferred way to build: it checks ESP-IDF 5.3, a clean HAL submodule and `203c` first, and exports ESP-IDF for the
build when the shell has not (an agent's shell starts fresh every time).

```sh
python3 components/CardenzaHAL/tools/cardenza.py doctor   # what this computer still needs, and how to install it
python3 components/CardenzaHAL/tools/cardenza.py build    # build/<project>.bin: the application image you publish
python3 components/CardenzaHAL/tools/cardenza.py web      # the browser version (build-web/site)
python3 components/CardenzaHAL/tools/cardenza_web.py serve build-web/site   # http://localhost:8000/
```

On a board: install your build through the Launcher, the way users get it, and read what it prints.

```sh
203c flash --bin build/<project>.bin --json   # over a USB cable, no sign-in (macOS, Linux; Windows: the website)
203c log --json                               # its log: the firmware's console over USB, or the serial port
203c log --until "ready" --seconds 30 --json  # a test: exit 0 at the line, 1 at a panic or when it never comes
```

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
203c login                         # once: opens the browser, you approve on the site
203c publish --dry-run --json      # reads ./203.json; fix what it reports
203c publish --json                # the first version gives the firmware its code: commit 203.json
```

Then the standard release, the same for 203 Systems' own firmware and everyone else's: the template's
`.github/workflows/firmware.yml` with the HAL's
[`community-publish`](https://github.com/203-Systems/CardenzaHAL/blob/main/.github/actions/community-publish/action.yml)
action. A push to `main` publishes a **dev** version, a tag `vX.Y.Z` (equal to `version.txt`, notes from
`CHANGELOG.md`) **stable**, `vX.Y.Z-beta.N` **beta**. No secret is stored: link the repository on the firmware's
page (自动发布 / Trusted publishing) or with `203c firmware publishers add CODE --repository OWNER/NAME --workflow
firmware.yml`, and the job signs in with its GitHub OIDC token (`203c help ci`).

The community checks every build: an ESP32-S3 application image (not the bootloader, a merged image or the ELF)
that fits the Launcher's room (`203c publish --dry-run` says how much of it a build uses), built on CardenzaHAL, that
boots; and a simulator version that boots for Play. A stable version needs a cover (a 16:9 picture).

## Hardware reference

What each part does and where it is in the HAL (header, functions, README section):
[CardenzaHAL README › The hardware](https://github.com/203-Systems/CardenzaHAL/blob/main/README.md#the-hardware). In short:

| | |
|---|---|
| Chip | ESP32-S3 (dual core, 240 MHz), 2 MB quad PSRAM on the flash bus |
| Flash | 16 MB, quad I/O at 120 MHz ([`board/sdkconfig.defaults`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/sdkconfig.defaults)); the 203 Launcher keeps everything below 0x170000 ([`board/partitions.csv`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/partitions.csv)) |
| Display | 240 × 135, RGB565, ST7789 on SPI, backlight on LEDC; a whole frame is 17 ms of SPI |
| Keys | 4 rows × 14 columns = 56 keys (numbers 1..56 = `y * 14 + x + 1`), at most 4 held at once are read reliably; a single-colour LED under each key, 16 levels plus a global brightness |
| Buttons | HOME, the side key, on GPIO0 (the HAL's Func button; held at reset it starts the ROM download mode) |
| Audio out | ES8156 codec, 44.1 kHz 16-bit, mono speaker (stereo I2S slots available) |
| Microphone | PDM, 44.1 kHz mono; its clock shares GPIO43 with the speaker's word select |
| Storage | microSD, 4-bit SDMMC, FAT at `/sdcard` |
| IR | transmitter on GPIO44 (NEC, 38 kHz) |
| USB | the chip's USB PHY: USB-Serial-JTAG, or the HAL's composite device (MIDI 1.0, Audio 2.0 both ways, HID), VID 0x0203 |
| Pins | [`board/pins.h`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/pins.h) is the source; the HAL README's "Hardware resource ownership" lists which peripheral the HAL owns |

Files:

- Schematic (V1.0): [Cardenza-Hardware/Cardenza_V1.0_SCH.pdf](https://github.com/203-Systems/Cardenza-Hardware/blob/main/Cardenza_V1.0_SCH.pdf)
- PCB 3D model (STEP), for cases and accessories:
  [Cardenza-Hardware/Cardenza-PCB-3D.step](https://github.com/203-Systems/Cardenza-Hardware/blob/main/Cardenza-PCB-3D.step),
  also as a zip from the community: <https://cardenza.203.io/community/downloads/Cardenza-PCB-2026-10-26.zip>
  (share what you print in the community's 模型 / Models section: `203c models upload`).

## Links

| | |
|---|---|
| CardenzaHAL (the hardware layer, examples, host tools, web target) | <https://github.com/203-Systems/CardenzaHAL> |
| CardenzaSynth (the official firmware, a full example) | <https://github.com/203-Systems/CardenzaSynth> |
| Cardenza-Hardware (schematic, PCB model) | <https://github.com/203-Systems/Cardenza-Hardware> |
| The 203 community and its developer guide | <https://cardenza.203.io/community>, <https://cardenza.203.io/community/develop> |
| Learn Cardenza (the user's guide) | <https://cardenza.203.io> |
| Product page | <https://203.io/products/cardenza-mini-synthsiser> |
