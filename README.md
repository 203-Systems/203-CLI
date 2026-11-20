# 203-CLI

[English](README.md) | [简体中文](README.zh-CN.md)

[203 community](https://cardenza.203.io/community) · [Developer guide](https://cardenza.203.io/community/develop) · [Cardenza](products/cardenza/README.md) · [NullPerator](products/nullperator/README.md) · [Mystrix](products/mystrix/README.md)

**Making firmware? Install it first: it is required.** `npm install -g 203c && 203c skill install` (Node.js 18 or
later; macOS, Linux and Windows alike). Cloning this repository does not install it, and a Cardenza firmware does not
build without it.

Everything a developer, or a coding agent, needs to make firmware for 203 Systems devices and share it on the 203
community:

- **`203c`**, the community's command line: sign in, start or fork a firmware project, publish versions from a
  laptop or from CI (trusted publishing, no stored secret), set the page, the cover and its pictures, install a firmware over a
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

On macOS, Linux and Windows alike, with [Node.js](https://nodejs.org) 18 or later:

```sh
npm install -g 203c    # the 203c command
203c skill install     # its Agent Skill, for Claude Code and Codex (run it again after every update)
```

203c says when a newer one is out (and when a firmware project's CardenzaHAL is behind its `main`): a line on stderr
after the commands of the work, at most one check a day; `203c updates` asks now, `NO_UPDATE_NOTIFIER=1` turns it off.

`203c` has no dependencies and no install scripts. `skill install` copies the skill into `~/.claude/skills/203-community`
(`CLAUDE_SKILLS_DIR` to choose; `~/.codex/skills` too when Codex is there; `--dir` for another agent's folder). The USB
cable (`flash`, `log`) is used on macOS and Linux; on Windows the website does it in Chrome or Edge, and every other
command works as anywhere (`board`, a running firmware over USB: also on Windows, with `pip install hidapi`).

From a clone instead (to read the code first, or to try a change to `203c`): `git clone
https://github.com/203-Systems/203-CLI.git && npm install -g ./203-CLI && 203c skill install`, or run it in place
with `node 203-CLI/scripts/203c.mjs`.

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
203c board screen               # what it shows (a PNG); board info, memory, press, coredump, files: 203c help board
203c publish --dry-run          # checks everything the community will check
203c publish
203c tutorial new               # how to use it: a tutorial (lessons, keys, screenshots); tutorial check, tutorial publish
203c sync                       # later: the page, versions, requests, comments and forks in .203/community.md
203c project diff FORK          # what a fork (魔改版) changed
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
| [`reference/`](reference) | `cli.md` (generated from the command table), `api.md` (the community's API), `parity.md` (each page of the site and its command), `firmware-project.md` (the firmware project rules, CardenzaHAL's `docs/FIRMWARE-PROJECT.md`), `tutorial-format.md` (the tutorial format) |
| [`products/`](products) | one development guide per device |
| [`tests/`](tests) | `npm test`: the CLI against stand-in APIs and a demo Launcher on a pseudo-terminal, the local checks, the documents |
| [`AGENTS.md`](AGENTS.md) | for changing this repository |

## License

[MIT](LICENSE). The firmware, HALs and operating systems the guides point to have their own licences.
