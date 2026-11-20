# Mystrix (魔矩): making firmware and apps

The Mystrix is 203 Systems' grid controller: an 8 × 8 grid of lit pads and a touch bar on an ESP32-S3, running
**Matrix OS**, an open-source operating system for grid controllers. There are two devices, each with its own
firmware file:

| Device | Matrix OS family | Build file | Community device id |
|---|---|---|---|
| Mystrix and Mystrix Pro | `Mystrix1` | `build/Mystrix1/MatrixOS-Mystrix1.uf2` | **`mystrix`** |
| Mystrix 2 | `Mystrix2` | `build/Mystrix2/MatrixOS-Mystrix2.uf2` | **`mystrix2`** |

They are **download-only** on the 203 community: a build is a `.uf2` file that people download and copy onto the
device in its update mode. The 203 Launcher does not install Mystrix firmware.

## The recommended way

Pick the smallest thing that does what you want:

1. **An app in Python** (Matrix OS 4, in development): no firmware to build. An app is a folder with `AppInfo.json`
   and `main.py`, copied to the device's storage or installed over USB with Matrix OS's `Tools/AppInstaller`.
   [Python applications](https://matrix.203.io/docs/Developer/PythonApplication),
   [the Python API](https://matrix.203.io/docs/Developer/MatrixOSApplicationPythonAPI/Overview),
   examples in [`Applications/Python/examples`](https://github.com/203-Systems/MatrixOS/tree/main/Applications/Python).
2. **An app in C++**: compiled into Matrix OS. Put it in `Applications/<App>/` (a class derived from `Application`
   with `Setup` / `Loop` / `End`, registered with `RegisterApplicationClass()` in its `CMakeLists.txt`) and list it
   in `Devices/<family>/ApplicationList.txt` (a `git:URL@ref` line pulls an app from its own repository).
   [C++ applications](https://matrix.203.io/docs/Developer/CppApplication),
   [the C++ API](https://matrix.203.io/docs/Developer/MatrixOSApplicationCppAPI/Overview);
   the contract an app sees is [`OS/MatrixOS.h`](https://github.com/203-Systems/MatrixOS/blob/main/OS/MatrixOS.h).
   A C++ app reaches users as a Matrix OS build that includes it: publish that build (below).
3. **A change to Matrix OS itself**: fork [MatrixOS](https://github.com/203-Systems/MatrixOS) and open a pull request
   there for anything every user should get (issues and discussions are on that repository).

Reach the hardware through Matrix OS's API, not around it: then one source builds for both devices and the
[Matrix OS Developer Toolkit](https://matrix.203.io/docs/Developer/MatrixOSDeveloperToolkit) (a simulator in the
browser, <https://dev.203.io>) runs it too.

## Toolchain and build

| | Version |
|---|---|
| [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.3.4/esp32s3/get-started/) | 5.3.x (Matrix OS's CI builds with v5.3.4), target `esp32s3` |
| Python 3 | Matrix OS's tools (UF2 conversion and upload) |
| Node.js 18+ | `203cli` |

```sh
git clone https://github.com/203-Systems/MatrixOS.git && cd MatrixOS
git submodule update --init
make DEVICE=Mystrix1 FAMILY=Mystrix1 build-release uf2   # build/Mystrix1/MatrixOS-Mystrix1.uf2
make DEVICE=Mystrix2 FAMILY=Mystrix2 build-release uf2   # build/Mystrix2/MatrixOS-Mystrix2.uf2
```

`build-dev` keeps the log on; plain `build` makes no `.uf2`. `make DEVICE=Mystrix1 uf2-upload` builds and copies it to
a device in update mode (`pip install psutil`). The simulator: `make DEVICE=MystrixSim setup`, `build-dev`, `run`.
Step-by-step setup for Windows, macOS, Linux and GitHub Actions:
[Building Matrix OS](https://matrix.203.io/docs/Developer/BuildingMatrixOS/Overview).

## Try it on a device

Hold the function key (on the Mystrix, the middle button) while plugging in USB, or use the update button in
Matrix OS's settings: the device starts its UF2 bootloader and shows a green arrow once the computer sees it. A
drive appears; copy the `.uf2` for that device onto it. It installs and restarts.
[Updating Matrix OS](https://matrix.203.io/docs/Mystrix/UpdateMatrixOS). The bootloader is
[Matrix-Bootloader](https://github.com/203-Systems/Matrix-Bootloader) (TinyUF2); the host upload tool is
[UF2-Upload](https://github.com/203-Systems/UF2-Upload).

## Publish

One firmware on the community holds both devices' files; each file goes to the device it is built for (the
community refuses a Mystrix 1 build in the Mystrix 2 slot and the other way round):

```sh
203cli login
203cli publish --firmware CODE \
  --bin mystrix=build/Mystrix1/MatrixOS-Mystrix1.uf2 \
  --bin mystrix2=build/Mystrix2/MatrixOS-Mystrix2.uf2 --dry-run --json
# then the same without --dry-run
```

Without a code yet, `--name "…" --summary "…"` makes the firmware (or keep them in a `203.json` with
`"devices": ["mystrix", "mystrix2"]` and `publish.bins` naming the two files: `203cli help manifest`). CI publishes
the same way: `203cli help ci` (trusted publishing from GitHub Actions, no stored secret). `203cli targets --json` lists
each device's UF2 family and size limit.

The page: 203cli publishes with 3–5 different photos of it running in the gallery (`--image a.jpg --image b.jpg
--image c.jpg`, or 203.json's `publish.images`; `203cli help pictures`) and a short description for people deciding to
install (`203cli help description`).

## Hardware reference

| | Mystrix / Mystrix Pro | Mystrix 2 |
|---|---|---|
| Chip | ESP32-S3 (ESP32-S3-MINI-1 module), 8 MB flash | ESP32-S3, 8 MB flash |
| Grid | 8 × 8 pads; the Pro senses velocity and pressure | 8 × 8 pads with per-pad x / y / pressure (MPE), read by a coprocessor |
| Lights | RGB (WS2812B), 64 pads + 32 underglow on the Pro | RGBW, 64 + 32 |
| Also | 16-segment touch bar, function key, USB and BLE MIDI, TRS MIDI out (adapter) | touch bar, function key, USB and BLE MIDI, microSD |
| App room | 3776 KB | 4 MB |
| UF2 family | `0xc47e5767` | `0xc47e5767` |

Sources: pin maps and the device contract in Matrix OS, `Devices/Mystrix1/Variants/Mystrix/*/Config.h`,
`Devices/Mystrix2/Variants/Mystrix2/*/Config.h`, `Devices/*/partition-table.csv` and
[`Devices/Device.h`](https://github.com/203-Systems/MatrixOS/blob/main/Devices/Device.h). Design files of the
Mystrix (schematic, PCB, mechanical; CERN-OHL-P-2.0):
[Matrix-Block6-Hardware](https://github.com/203-Systems/Matrix-Block6-Hardware), described on
[Mystrix hardware designs](https://matrix.203.io/docs/Resources/MystrixHardwareDesigns). The Mystrix 2's design
files are not public.

## Links

| | |
|---|---|
| Matrix OS (source, issues, releases) | <https://github.com/203-Systems/MatrixOS> |
| Documentation (users and developers) | <https://matrix.203.io> ([中文](https://matrix.203.io/zh-Hans/)) |
| App template (C++) | <https://github.com/203-Systems/Matrix-OS-APP-Template> |
| Control map editor | <https://matrix-os-keymap-editor.vercel.app> |
| Open-source repositories | <https://matrix.203.io/docs/Resources/OpenSourcedRepos> |
| The 203 community | <https://cardenza.203.io/community> |
