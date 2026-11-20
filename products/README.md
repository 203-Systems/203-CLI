# Products: how to make firmware for each 203 Systems device

Read the page of the device you build for before you write code: it says which hardware layer or OS to build on,
the toolchain, how to try a build without breaking the device, how to publish it on the 203 community with `203cli`,
and where the hardware references are.

| Device | 中文 | Community id | Build on | A build is | Installed by | Page |
|---|---|---|---|---|---|---|
| Cardenza | 鸣片 | `cardenza` | [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL) + ESP-IDF 5.3.5 | an ESP32-S3 app `.bin` (+ a browser simulator version) | the 203 Launcher | [cardenza](cardenza/README.md) |
| NullPerator | 零序 | `nullperator` | the [NullPerator](https://github.com/203-Systems/NullPerator) firmware tree + ESP-IDF 5.3.5 (developer preview) | an ESP32-S3 app `.bin` | the 203 Launcher | [nullperator](nullperator/README.md) |
| Mystrix, Mystrix Pro | 魔矩 | `mystrix` | [Matrix OS](https://github.com/203-Systems/MatrixOS) + ESP-IDF 5.3.x | `MatrixOS-Mystrix1.uf2` | the user (download, copy in update mode) | [mystrix](mystrix/README.md) |
| Mystrix 2 | 魔矩 | `mystrix2` | [Matrix OS](https://github.com/203-Systems/MatrixOS) + ESP-IDF 5.3.x | `MatrixOS-Mystrix2.uf2` | the user (download, copy in update mode) | [mystrix](mystrix/README.md) |

`203cli targets --json` lists the devices the community takes today, with each one's format and limits.

What is the same everywhere:

- **Publish with `203cli`**, `--dry-run` first; a firmware's builds for several devices go in one version
  (`--bin cardenza=… --bin nullperator=…`, `--bin mystrix=… --bin mystrix2=…`).
- **Release from CI** with trusted publishing (no stored secret): a push to `main` is a dev version, a tag `vX.Y.Z`
  stable, `vX.Y.Z-beta.N` beta (`203cli help ci`).
- **A project file**, `203.json`, at the root says what the firmware is and what `publish` uploads (`203cli help manifest`).
- **Never commit secrets**: tokens, `.env` files, keys, Wi-Fi passwords.
- **Keep the licence** of what you build on, and credit it (`203cli fork` records where a firmware comes from).
