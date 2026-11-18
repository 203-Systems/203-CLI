# 203-CLI

[English](README.md) | [简体中文](README.zh-CN.md)

[203 community](https://cardenza.203.io/community) · [Developer guide](https://cardenza.203.io/community/develop) · [Cardenza](products/cardenza/README.md) · [NullPerator](products/nullperator/README.md) · [Mystrix](products/mystrix/README.md)

Everything a developer, or a coding agent, needs to make firmware for 203 Systems devices the recommended way and
share it on the 203 community:

- **`203c`**, the community's command line: sign in, start or fork a firmware project, publish versions from a
  laptop or from CI (trusted publishing, no stored secret), set the page and the cover, install a firmware over a
  USB cable, answer requests, share sound packs, works and 3D models. Every answer is JSON with `--json`, every
  error says what to run next: it is the tool AI agents use.
- **A development guide for each product**: what to build on, the toolchain, how to try a build without breaking
  the device, how to publish it, and the hardware reference.
- **An Agent Skill** ([`SKILL.md`](SKILL.md)): the rules and the workflows for Claude Code, Codex, Cursor and other
  agents, installed with the CLI.

| Device | 中文 | Build on | Guide |
|---|---|---|---|
| Cardenza | 鸣片 | [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL) (ESP-IDF) | [products/cardenza](products/cardenza/README.md) |
| NullPerator | 零序 | the [NullPerator](https://github.com/203-Systems/NullPerator) firmware (ESP-IDF; developer preview) | [products/nullperator](products/nullperator/README.md) |
| Mystrix, Mystrix Pro, Mystrix 2 | 魔矩 | [Matrix OS](https://github.com/203-Systems/MatrixOS) (ESP-IDF) | [products/mystrix](products/mystrix/README.md) |

## Install

```sh
curl -fsSL https://cardenza.203.io/community/skill/install.sh | sh
```

It installs the skill into `~/.claude/skills/203-community` (`CLAUDE_SKILLS_DIR` to choose) and the `203c` command
into `~/.local/bin` (`COMMUNITY_BIN_DIR`), checking the download's SHA-256; no sudo. What it installs is this
repository at the commit the community pins. Node.js 18 or later is all `203c` needs: it has no dependencies.

On Windows: the same line in Git Bash (Claude Code's own shell there, and Git for Windows'), or without a shell
`npm install -g github:203-Systems/203-CLI` (the command only; the skill is for agents with a shell). 203c runs
everywhere Node does; the USB cable (`flash`, `log`) is used on macOS and Linux, and on Windows from the website in
Chrome or Edge.

From a clone instead (to read the code first, to work offline, or to try a change to `203c`):

```sh
git clone https://github.com/203-Systems/203-CLI.git
sh 203-CLI/install.sh            # the same layout, from this checkout
node 203-CLI/scripts/203c.mjs --help   # or run it in place
```

## Use

```sh
203c doctor                     # is everything ready?
203c login                      # once on a computer: opens the browser, you approve on the site (remote: --no-browser)
203c rules                      # the firmware project rules (Cardenza)
203c new "My synth"             # a new Cardenza firmware project (CardenzaHAL and its template), or:
203c fork V6QK28 my-synth       # start from someone's firmware (here: Cardenza Synth); init: 203.json for a project you have
python3 components/CardenzaHAL/tools/cardenza.py build   # the HAL's build tool (Cardenza)
203c flash --bin build/my_synth.bin   # onto your Cardenza over USB, through its Launcher
203c log                        # what it prints
203c publish --dry-run          # checks everything the community will check
203c publish
203c inbox                      # later: what people asked for and said
203c help start                 # what to run for what (every command takes --help)
```

Run it from the firmware project's folder. Add `--json` for machines; `203c <command> --help --json` describes any
command. Every command and flag: [`reference/cli.md`](reference/cli.md); the community's API:
[`reference/api.md`](reference/api.md).

### With an AI agent

Install as above, then tell your agent what you want to make and for which device; or copy the prompt on the
community's [developer guide](https://cardenza.203.io/community/develop). The skill tells it to read the
device's guide first, follow its rules, check with `--dry-run` and never handle your tokens.

## The repository

| | |
|---|---|
| [`SKILL.md`](SKILL.md) | the Agent Skill: hard rules, what to run, workflows, errors |
| [`scripts/`](scripts) | `203c` (`scripts/203c.mjs`), zero dependencies |
| [`reference/`](reference) | `cli.md` (generated from the command table), `api.md` (the community's API), `parity.md` (each page of the site and its command), `firmware-project.md` (the firmware project rules, CardenzaHAL's `docs/FIRMWARE-PROJECT.md`) |
| [`products/`](products) | one development guide per device |
| [`tests/`](tests) | `npm test`: the CLI against stand-in APIs and a demo Launcher on a pseudo-terminal, the local checks, the documents |
| [`AGENTS.md`](AGENTS.md) | for changing this repository |

## License

[MIT](LICENSE). The firmware, HALs and operating systems the guides point to have their own licences.
