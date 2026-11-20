[en]
# Writing a firmware's description

The description is what people read under the pictures on a firmware's page, and in the Launcher's store under Details. They are not developers: they want to know what it is, what it does for them, what they need and how to start, and then decide to install it. Write it like a product page: short, plain words, what people get before how it works. The manual goes in its tutorial.

## The shape {#shape}

1. **The opening**, without a heading: one or two sentences saying what it is and who it is for. The line that matters most comes first.
2. **`## Features`**: 3–6 bullets of one line each, the benefit before the detail.
3. **`## Needs`** (when it needs something): the device, the Launcher's version, accessories, an SD card.
4. **`## Get started`**: 1–3 lines: the first thing to do once it is installed.
5. A last line pointing to its tutorial for every key and mode.

## Length {#length}

Aim for **800 characters** or fewer (pictures are not counted). Over **1500** the editor and 203c warn; over **3000** a description cannot be saved. Short is not a loss: what does not fit here belongs elsewhere.

| Not in the description | Where it goes |
| --- | --- |
| Key-by-key instructions, key tables, every mode's controls | the firmware's tutorial (教程) |
| Building it, the source's layout, notes for developers | the repository's README |
| What changed in each version | each version's release notes |
| Long questions and answers | the tutorial, or the Discussion tab |

## Pictures {#pictures}

Show it before you describe it: **3–5 different screenshots of the firmware itself** in its gallery, the large pictures above the description. The screen people see first, then one for each main feature. With a Cardenza on the USB cable running it, `203c board screen --out docs/screens/home.png` saves the screen as a PNG (the page enlarges it pixel for pixel); a photo of the device works too. On the site the gallery is a suggestion; `203c publish` needs 3–5 (203.json's `publish.images`). A picture inside the text: **Insert picture** on the site, `![words](image:<id>)` in Markdown.

## The template {#template}

The editor's **Use the template** puts this in; `203c new` writes it to `docs/description.md`. Replace every `<…>`.

```markdown
<What it is and who it is for, in one or two sentences.>

## Features
- <A feature: what people get, in plain words>
- <A second feature>
- <A third feature>

## Needs
- A Cardenza with the 203 Launcher

## Get started
<The first thing to do once it is installed.> Every key is explained in its tutorial.
```

## An example {#example}

Too long: 13,000 characters with every mode's key table, the keycaps' legends, the macros' limits and links into the HAL's source. A user scrolls past it and still does not know whether it is for them. The same firmware in 700:

```markdown
Turns the Cardenza into a controller for your computer and phone: keyboard, mouse, gamepad, MIDI keyboard, USB sound card and TV remote in one.

## Features
- USB and Bluetooth keyboard with four recordable macros
- Mouse and media keys: play, pause, volume, next track
- A gamepad with two sticks and 16 buttons you can remap
- A MIDI keyboard with chords, arpeggios and eight CC controls
- A USB sound card: headphones out, the built-in microphone in
- An infrared remote, with code sets from the SD card

## Needs
- A Cardenza with the 203 Launcher; a microSD card for remote code sets

## Get started
Press **Fn** for the mode menu, then **1–8** to pick one. Every mode's keys are in its tutorial.
```

## Before you save {#check}

- Does the first line say what it is?
- 3–6 features, one line each?
- What it needs, if anything?
- How to start?
- No key tables, build steps or version history?

## Markdown {#markdown}

| Write | To get |
| --- | --- |
| `## Features` | a heading (`#` to `####`) |
| `**words**` · `*words*` | **bold** · *italic* |
| `- item` · `1. item` | a list (indent two spaces for a list inside it) |
| `[text](https://…)` | a link |
| `` `code` `` | `code` |
| `> words` | a quote |
| `---` | a line across |
| a row `\| a \| b \|`, then `\| --- \| --- \|` | a table |
| ` ``` ` on the lines above and below | a block of code |
| `![words](image:<id>)` | one of its own pictures |

A line ends where you end it (do not wrap long lines by hand); a blank line starts a new paragraph. No HTML; pictures from other sites show as links.

[zh]
# 怎样写固件简介

简介是固件页上图片下面的那段文字，也是启动器商店里「详情」显示的内容。读它的人不是开发者：他们想知道这是什么、对自己有什么用、要准备什么、装好以后怎么开始，然后决定装不装。所以要像写产品介绍一样：简洁、用大白话、先说用户得到什么，再说怎么做到的。说明书放到它的教程里。

## 结构 {#shape}

1. **开头**，不加标题：一两句话说清它是什么、给谁用。最重要的一句放在最前面。
2. **`## 功能`**：3–6 条，每条一行，先说好处，再说细节。
3. **`## 需要`**（有要求时才写）：设备、启动器版本、配件、SD 卡。
4. **`## 开始`**：1–3 行，装好后第一步做什么。
5. 最后一行：每个按键、每个模式的用法见它的教程。

## 长度 {#length}

目标是 **800 个字符**以内（插图不算）。超过 **1500** 时，编辑器和 203c 会提醒；超过 **3000** 就保存不了。短不是损失：放不下的内容本来就该放在别处。

| 不写进简介 | 放到哪里 |
| --- | --- |
| 逐键说明、键位表、每个模式的操作 | 固件的教程 |
| 怎么编译、源码结构、给开发者的说明 | 仓库的 README |
| 每个版本改了什么 | 每个版本的发布说明 |
| 很长的问答 | 教程，或讨论区 |

## 图片 {#pictures}

先让人看到，再用文字介绍：在图片（简介上面的大图）里放 **3–5 张固件自己的截图**，每张都不一样：第一张是用户最先看到的画面，然后每个主要功能一张。Cardenza 用 USB 线连着电脑、正在运行这个固件时，`203c board screen --out docs/screens/home.png` 把屏幕存成一张 PNG（页面会按像素放大）；设备的照片也可以。在网页上发布时图片只是建议；用 `203c publish` 发布必须有 3–5 张（203.json 的 `publish.images`）。正文里的插图：网页上点**插入图片**，Markdown 里写 `![说明](image:<id>)`。

## 模板 {#template}

编辑器里点 **用模板**会放进这段；`203c new` 会把它写成 `docs/description.md`。把每个 `<…>` 换成自己的内容。

```markdown
<一两句话：它是什么，给谁用。>

## 功能
- <一个功能：用户得到什么，用大白话>
- <第二个功能>
- <第三个功能>

## 需要
- Cardenza，装好 203 Launcher

## 开始
<装好后第一步做什么。>每个按键的用法见教程。
```

## 例子 {#example}

太长的写法：13000 个字符，写满了每个模式的键位表、键帽丝印、宏的限制和指向 HAL 源码的链接。用户翻完也不知道这是不是自己要的。同一个固件，写成 300 字：

```markdown
把 Cardenza 变成电脑和手机的控制器：键盘、鼠标、手柄、MIDI 键盘、USB 声卡和电视遥控器，一台全有。

## 功能
- USB 和蓝牙键盘，带四个可录制的宏
- 鼠标和媒体键：播放、暂停、音量、切歌
- 手柄：两个摇杆、16 个按钮，可以改键
- MIDI 键盘：和弦、琶音和 8 路 CC
- USB 声卡：耳机输出，内置麦克风输入
- 红外遥控器，码库从 SD 卡导入

## 需要
- Cardenza，装好 203 Launcher；遥控码库要一张 microSD 卡

## 开始
按 **Fn** 打开模式菜单，再按 **1–8** 选一个模式。每个模式的按键见教程。
```

## 保存前检查 {#check}

- 第一句说清它是什么了吗？
- 3–6 个功能，每个一行？
- 需要准备什么（如果有）？
- 怎么开始？
- 没有键位表、编译步骤和版本记录？

## Markdown 写法 {#markdown}

| 这样写 | 显示成 |
| --- | --- |
| `## 功能` | 标题（`#` 到 `####`） |
| `**文字**` · `*文字*` | **粗体** · *斜体* |
| `- 一项` · `1. 一项` | 列表（缩进两个空格是下一级） |
| `[文字](https://…)` | 链接 |
| `` `代码` `` | `代码` |
| `> 文字` | 引用 |
| `---` | 一条分隔线 |
| 一行 `\| 甲 \| 乙 \|`，下面一行 `\| --- \| --- \|` | 表格 |
| 上下各一行 ` ``` ` | 一段代码 |
| `![说明](image:<id>)` | 它自己的一张图片 |

换行就是换行（不要手动折行）；空一行是新的一段。不能写 HTML；别的网站的图片显示成链接。
