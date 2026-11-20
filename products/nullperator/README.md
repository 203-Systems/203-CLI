# NullPerator (零序): making firmware

The NullPerator is 203 Systems' handheld music tracker: an ESP32-S3 with a 240 × 240 screen, a game-pad style set
of buttons, a stereo codec with a speaker, microphone and TRS MIDI, an SD card, Wi-Fi and Bluetooth, and a battery.
Its firmware is open source: an eight-track tracker derived from picoTracker.

Community device id: **`nullperator`**. Firmware for it is installed by the 203 Launcher, like the Cardenza's.
Status: **developer preview**. The firmware's source is public; a stand-alone hardware layer, a project template and a
browser simulator (as the Cardenza has) are not public yet. Until they are, build on the firmware's own tree.

## The recommended way today

1. **Start from the firmware**: [203-Systems/NullPerator](https://github.com/203-Systems/NullPerator) (BSD-3-Clause,
   with the third-party licences listed in its `LICENSE`). Fork it on GitHub, or start a new ESP-IDF project and take
   what you need from it, keeping its licence and notices.
2. **Reach the hardware through the in-tree HAL**: `sources/Adapters/node/hal/nullperator/` (the board's pins are in
   [`board/pins.h`](https://github.com/203-Systems/NullPerator/blob/main/sources/Adapters/node/hal/nullperator/board/pins.h),
   what each driver does in its [README](https://github.com/203-Systems/NullPerator/blob/main/sources/Adapters/node/hal/nullperator/README.md)).
   Keep hardware access there, not spread through your code: it is what a future stand-alone HAL will replace.
3. **Build** with ESP-IDF (below), **install through the Launcher** (`203cli flash --bin …`), never by flashing the
   whole chip.
4. **Publish** with `203cli` and the `nullperator=` prefix (below). Add a `203.json`, `version.txt`, `CHANGELOG.md`,
   `LICENSE` and a CI release the way the Cardenza's rules describe them
   ([`reference/firmware-project.md`](../../reference/firmware-project.md), sections 2, 6, 8 and 9): those parts are
   the same for every Launcher device; the CardenzaHAL parts are not.

## Toolchain and build

| | Version |
|---|---|
| [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.3.5/esp32s3/get-started/) | 5.3.5 (the tree accepts 5.3.x; its CI uses `espressif/idf:v5.3.5`), target `esp32s3` |
| Node.js 18+ | `203cli` |

```sh
git clone https://github.com/203-Systems/NullPerator.git && cd NullPerator
idf.py --project-dir sources -B sources/build/node -DNode=true build
```

The build directory must be `sources/build/node`; the defaults are `sources/Adapters/node/sdkconfig.defaults`. The
application image is `sources/build/node/<project>.bin` (the ESP-IDF project inside is still named `picoTracker`,
so `picoTracker.bin`). The tree's [`docs/HARDWARE.md`](https://github.com/203-Systems/NullPerator/blob/main/docs/HARDWARE.md)
has the details.

**Do not `idf.py flash` a NullPerator that has the 203 Launcher.** The tree's own partition table is a stand-alone
firmware's (its app at 0x10000), which overwrites the Launcher and the software it installed. On a device with the
Launcher, install the application image through it:

```sh
203cli flash --bin sources/build/node/picoTracker.bin --dry-run --json  # then without --dry-run (a USB cable, no sign-in)
```

The Launcher keeps the first 0x1A0000 bytes of the NullPerator's 16 MB flash for itself; a firmware gets the rest
(about 14 MB).

## Publish

```sh
203cli login
203cli publish --bin nullperator=sources/build/node/picoTracker.bin --name "…" --summary "…" --dry-run --json
# then the same without --dry-run; next time: 203cli publish --firmware CODE --bin nullperator=… (or a 203.json)
```

The `nullperator=` prefix matters: without one, a BIN is taken for the Cardenza. Give the application image, not a
merged image, the bootloader or the ELF. The community checks the image and that it fits; it warns that the build is
not on CardenzaHAL (expected here), and it has no simulator version (Play) for this device yet. One firmware can
carry builds for several devices: `--bin cardenza=… --bin nullperator=…`.

The page: 203cli publishes with 3–5 different pictures of it running in the gallery (screenshots or photos:
`--image a.png --image b.png --image c.png`, or 203.json's `publish.images`; `203cli help pictures`) and a short
description for people deciding to install (`203cli help description`).

## Hardware reference

From the product page and the firmware's public pin map:

| | |
|---|---|
| Chip | ESP32-S3, 16 MB flash, 8 MB PSRAM; Wi-Fi and Bluetooth |
| Display | 1.54" 240 × 240 IPS, ST7789V on SPI |
| Buttons | D-pad, A, B, START, SELECT, LB, RB on a PCA9555 I/O expander (which also reads headphone detect and charging); FUNC on GPIO8 |
| Audio | ES8389 stereo codec on I2S; speaker, microphone, headset microphone; the audio jack can switch to stereo input |
| MIDI | TRS in and out (out Type A; in Type A or B) on UART2 |
| Motion | 6-axis IMU (LSM6DS3TR-C; the driver is a stub so far) |
| Storage | microSD, 4-bit SDIO |
| Power | 720 mAh battery, voltage read on an ADC |
| Expansion | 20-pin FPC (6 GPIO, UART, I2C) and a 4-pin JST-SH I2C port |
| USB | the chip's USB (TinyUSB in the firmware: CDC and MIDI), VID 0x0203 |

Schematics, CAD files and a stand-alone SDK are not public yet.

## Links

| | |
|---|---|
| Firmware source | <https://github.com/203-Systems/NullPerator> |
| User manual | <https://np-wiki.203.io> ([source](https://github.com/203-Systems/nullperator-wiki)) |
| The 203 community | <https://cardenza.203.io/community> |
