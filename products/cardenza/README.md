# Cardenza (鸣片): making firmware

The Cardenza is 203 Systems' pocket synthesiser: an ESP32-S3 with a 240 × 135 colour screen, 56 keys with a light
each, a speaker, a microphone, an SD card and USB. Its firmware is installed and updated by the **203 Launcher**
from the **203 community**, where anyone can publish one.

Community device id: **`cardenza`** (the default device of `203c publish`). Status: open to everyone.

## The recommended way

1. **Read the rules**: [`reference/firmware-project.md`](../../reference/firmware-project.md) (`203c rules` prints
   it). They are CardenzaHAL's
   [`docs/FIRMWARE-PROJECT.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.md)
   ([简体中文](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.zh-CN.md)): dependencies,
   the project's files and `203.json`, the HAL rules, builds for the board and the browser, what the community
   checks, versions and channels, forks, publishing from CI, what never to commit. Follow them; this page only says
   where to start.
2. **Build on [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL)**, the Cardenza's hardware layer (an ESP-IDF
   component, added as a git submodule at `components/CardenzaHAL`). It gives you the keys and key lights, the
   display, audio out and the microphone, the SD card, the Func (HOME) button, IR and USB (MIDI, audio, HID), and the
   native ESP-IDF handles behind them. Reach the hardware only through it: that is what makes the same source build
   for the browser simulator, and what the community's checks expect. Missing something? Open an issue or a pull
   request on CardenzaHAL rather than writing a driver into your firmware.
3. **Start a project** from [`examples/template`](https://github.com/203-Systems/CardenzaHAL/tree/main/examples/template)
   (the HAL as a submodule, the board's defaults, a partition table that keeps the Launcher, `version.txt`,
   `CHANGELOG.md`, `203.json` and the release workflow), then `203c init` to fill `203.json` in.
   **Or change a firmware that exists**: `203c fork CODE my-firmware` clones its source and records where it comes
   from. The official groovebox, [CardenzaSynth](https://github.com/203-Systems/CardenzaSynth) (Cardenza Synth,
   code `V6QK28`), is the largest example of a firmware on the HAL.
4. **Build** for the board and for the browser, and try it (below).
5. **Publish** with `203c` (below); after the first version, let CI publish every push and tag.

## Toolchain

| | Version | For |
|---|---|---|
| [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.3.5/esp32s3/get-started/) | 5.3.5 (5.3 or later works; CI uses `espressif/idf:v5.3.5`) | the firmware |
| [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and CMake 3.20+ | latest | the simulator version (Play on the community) |
| Node.js | 18 or later | `203c` |
| Python 3 | | the HAL's host tools (`cardenza_web.py`, `cardenza_flash.py`, `cardenza_usb.py`) |

## Build and try

```sh
idf.py set-target esp32s3          # once
idf.py build                       # build/<project>.bin: the application image you publish
python3 components/CardenzaHAL/tools/cardenza_web.py build .          # the browser version (build-web/site)
python3 components/CardenzaHAL/tools/cardenza_web.py serve build-web/site   # http://localhost:8000/
```

On a board: install your build through the Launcher, the way users get it.

```sh
203c flash --bin build/<project>.bin --dry-run --json   # then without --dry-run: over a USB cable, no sign-in
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

| | |
|---|---|
| Chip | ESP32-S3 (dual core, 240 MHz), 2 MB quad PSRAM on the flash bus |
| Flash | 16 MB, quad I/O at 120 MHz ([`board/sdkconfig.defaults`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/sdkconfig.defaults)); the 203 Launcher keeps everything below 0x170000 ([`board/partitions.csv`](https://github.com/203-Systems/CardenzaHAL/blob/main/board/partitions.csv)) |
| Display | 240 × 135, RGB565, ST7789 on SPI, backlight on LEDC; a whole frame is 17 ms of SPI |
| Keys | 4 rows × 14 columns = 56 keys (numbers 1..56 = `y * 14 + x + 1`), at most 4 held at once are read reliably; a single-colour LED under each key, 16 levels plus a global brightness |
| Buttons | Func / HOME on GPIO0 (also the ROM boot pin) |
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
