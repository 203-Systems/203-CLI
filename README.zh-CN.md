# 203-CLI

[English](README.md) | [简体中文](README.zh-CN.md)

[203 社区](https://cardenza.203.io/community) · [开发指引](https://cardenza.203.io/community/develop) · [鸣片](products/cardenza/README.md) · [零序](products/nullperator/README.md) · [魔矩](products/mystrix/README.md)

给 203 Systems 的设备做固件、并分享到 203 社区，开发者（或者 AI 编程助手）需要的东西都在这里：

- **`203c`**：社区的命令行。登录、新建或魔改（fork）固件项目、在电脑上或 CI 里发布版本（可信发布，不存任何密钥）、设置固件页和封面、用 USB 线刷固件、回复需求、分享音色包、作品和 3D 模型。加 `--json` 时每个回答都是 JSON，每个错误都写明下一步该运行什么：这就是给 AI 用的工具。
- **每个产品的开发指引**：基于什么开发、工具链、怎样试运行而不弄坏设备、怎样发布、硬件资料。
- **Agent Skill**（[`SKILL.md`](SKILL.md)）：给 Claude Code、Codex、Cursor 等 AI 的规则和流程，和命令行一起安装。

| 设备 | 英文名 | 基于 | 指引 |
|---|---|---|---|
| 鸣片 | Cardenza | [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL)（ESP-IDF） | [products/cardenza](products/cardenza/README.md) |
| 零序 | NullPerator | [NullPerator](https://github.com/203-Systems/NullPerator) 固件源码（ESP-IDF；开发者预览） | [products/nullperator](products/nullperator/README.md) |
| 魔矩 | Mystrix、Mystrix Pro、Mystrix 2 | [Matrix OS](https://github.com/203-Systems/MatrixOS)（ESP-IDF） | [products/mystrix](products/mystrix/README.md) |

## 安装

```sh
curl -fsSL https://cardenza.203.io/community/skill/install.sh | sh
```

Skill 装到 `~/.claude/skills/203-community`（`CLAUDE_SKILLS_DIR` 可改），`203c` 命令装到 `~/.local/bin`（`COMMUNITY_BIN_DIR` 可改），下载会校验 SHA-256，不需要 sudo。装的就是社区锁定的那个提交的本仓库。`203c` 只需要 Node.js 18 或更新的版本，没有任何依赖。

也可以从克隆安装（先看代码、离线使用、或者试改 `203c`）：

```sh
git clone https://github.com/203-Systems/203-CLI.git
sh 203-CLI/install.sh            # 同样的布局，来自这份克隆
node 203-CLI/scripts/203c.mjs --help   # 或者直接运行
```

## 用法

```sh
203c doctor                     # 一切就绪了吗？
203c login                      # 打开浏览器，在网站上批准（远程时加 --no-browser）
203c rules                      # 固件项目规则（鸣片）
203c init                       # 给当前目录的项目写 203.json
203c fork V6QK28 my-synth       # 或者从别人的固件开始（这里是 Cardenza Synth）
203c publish --dry-run          # 先按社区的检查全部检查一遍
203c publish
203c help start                 # 想做什么就运行什么
```

在固件项目的目录里运行。给程序用时加 `--json`；`203c <命令> --help --json` 用 JSON 描述任何命令。所有命令和参数见 [`reference/cli.md`](reference/cli.md)，社区 API 见 [`reference/api.md`](reference/api.md)。

### 交给 AI

照上面安装，然后告诉 AI 你想做什么、给哪台设备做；或者复制社区[开发指引](https://cardenza.203.io/community/develop)里的那段话。Skill 会让它先读这台设备的指引、遵守规则、先用 `--dry-run` 检查，并且绝不经手你的令牌。

## 各产品怎么开发

### 鸣片（Cardenza）

在 [CardenzaHAL](https://github.com/203-Systems/CardenzaHAL) 上开发（ESP-IDF 5.3.5，HAL 作为 git 子模块放在 `components/CardenzaHAL`），只通过 HAL 的公开接口访问硬件，这样同一份源码也能编译成浏览器模拟器。先读规则（`203c rules`，即 HAL 的 [`docs/FIRMWARE-PROJECT.zh-CN.md`](https://github.com/203-Systems/CardenzaHAL/blob/main/docs/FIRMWARE-PROJECT.zh-CN.md)），从 HAL 的 `examples/template` 开始，或者 `203c fork V6QK28` 改官方固件 [CardenzaSynth](https://github.com/203-Systems/CardenzaSynth)。不要对装了 203 Launcher 的设备 `idf.py flash`（会抹掉 Launcher）：用 `203c flash --bin build/<项目>.bin` 通过 Launcher 安装。原理图和 PCB 三维模型在 [Cardenza-Hardware](https://github.com/203-Systems/Cardenza-Hardware)。详见 [products/cardenza](products/cardenza/README.md)。

### 零序（NullPerator）

开发者预览：固件源码 [NullPerator](https://github.com/203-Systems/NullPerator) 是公开的（BSD-3-Clause），独立的 HAL、项目模板和网页模拟器还没有公开。在源码树里开发，硬件访问集中在树内的 HAL（`sources/Adapters/node/hal/nullperator/`）；用 `idf.py --project-dir sources -B sources/build/node -DNode=true build` 编译，通过 Launcher 安装（`203c flash --bin …`），发布时写 `--bin nullperator=…`。详见 [products/nullperator](products/nullperator/README.md)。

### 魔矩（Mystrix）

运行 [Matrix OS](https://github.com/203-Systems/MatrixOS)。最简单的是写 Python 应用（Matrix OS 4，开发中），其次是编进系统的 C++ 应用，改系统本身就给 Matrix OS 提 PR。`make DEVICE=Mystrix1 FAMILY=Mystrix1 build-release uf2` 和 `Mystrix2` 分别生成两台设备的 `.uf2`；按住功能键插上 USB 进入更新模式，把 `.uf2` 拷进去。社区里魔矩固件只供下载：`203c publish --bin mystrix=… --bin mystrix2=…`。文档在 [matrix.203.io](https://matrix.203.io/zh-Hans/)。详见 [products/mystrix](products/mystrix/README.md)。

## 许可

[MIT](LICENSE)。指引里提到的固件、HAL 和操作系统各有自己的许可。
