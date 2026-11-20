# What the site does, and the 203cli command for it

Everything a person does on the site, 203cli does (the user, 2026-11-14: "the CLI is the tool AI uses"). Each page
of the site (`site/pages/*.js`) and its functions, with the command. **Web only** marks what is done on the
website by design: making or removing credentials (sign-ins, bind codes, devices), personal data and closing the
account; a token never does those (COMMUNITY.md "Credentials"). `203cli` is the installed command (else
`node <the skill's folder>/scripts/203cli.mjs`), run from the firmware project's folder.

## Sections and finding things (home.js, section.js)

| Site | 203cli |
|---|---|
| Firmware section: one device, tag tree, Official, Featured, Show forks, sort, search | `firmware list --target cardenza --tag … --official --forks --sort hot --q WORDS --json` (`--cursor` for the next page) |
| The tag tree of a section, its counts | `sections --json`, `sections show firmware --json` |
| Search everything; a code typed opens it | `search WORDS --json`, `code CODE --json` |
| Models, sounds, projects, works, posts lists | `models list`, `sounds list`, `projects list`, `works list`, `posts list` (`--tag`, `--sort`, `--cursor`) |
| Devices offered in the picker | `targets --json` |

## A firmware's page (firmware.js)

| Site | 203cli |
|---|---|
| The page (header, about, builds, lineage, clone source, source archive, licence) | `firmware show CODE --json` |
| A version's page (`/<VCODE>`) | `versions show VCODE --json`; by its label: `versions label CODE 1.4.0 --json` |
| Releases (per device and channel) | `versions list CODE --target cardenza --channel stable --json` |
| Download .bin | `versions download VCODE --target cardenza --out app.bin --json` |
| Source: download the archive, git clone | `firmware show CODE --json` (`source_archive.url`, `clone_source.url`); `clone CODE DIR --json` |
| Send to my device / install and run | `devices list --json`, `devices send DEVICE CODE [--start] --json` |
| The downloads list (sends followed in the background) | `devices send DEVICE CODE --no-wait --json`, then `devices status DEVICE COMMAND [--wait] --json` |
| Send to my device over a USB cable (通过 USB 线发送: the device's chip checked, the build with its signature written with the Launcher's `flash firmware`, then recorded with `POST /me/devices/<id>/installed`) | **web only** (Web Serial to the Launcher's USB console; Node has no serial port, and recording it needs the website's session); over Wi-Fi: `devices send` |
| Install with the Launcher (the code) | the code from `firmware show`; nothing to run |
| 用 USB 线安装 Install over USB (线刷: through the Launcher's console, `flash firmware`; no sign-in, no bound device) | `flash CODE --json` (or `--bin FILE`, `--channel`, `--port`; macOS and Linux: the tty in raw mode) |
| A launcher's page: flash it over USB (Web Serial, esptool-js) | web only (a browser API); `versions download` then esptool; the official Launcher: `devices recover` |
| Play (the simulator version) | `sim check VCODE --json` (`play_url`) |
| Like, favourite | `like firmware CODE`, `favorite firmware CODE` (`--off`) |
| Discussion | `comments list firmware CODE`, `comments add firmware CODE --body …` |
| Requests (public) | `requests list CODE`, `requests show CODE N`, `requests create CODE`, `requests vote CODE N 1` |
| Forks (the tree) | `firmware tree CODE --json` |
| Works made with it | `firmware works CODE --json` |
| Merge requests | `merges list CODE`, `merges show CODE N`, `merges open PARENT --from FORK`, `merges status CODE N merged` |
| For developers (repository, AI prompt) | `firmware show CODE --json`, `rules`, `fork CODE DIR` |
| Unlock a private firmware | `firmware unlock CODE --password … --json` |
| Report | `report firmware CODE --reason … --json` |
| "⋯" owner: edit, delete | `firmware edit CODE …`, `firmware delete CODE --yes` |
| "⋯" admin: feature, official, hide, delete | `admin feature firmware CODE`, `admin official CODE`, `admin hide|unhide|delete firmware CODE` |

## Tutorials (tutorials.js: a firmware's 教程 tab, a tutorial's page, the editor)

| Site | 203cli |
|---|---|
| The 教程 / Tutorials tab (`/<CODE>/tutorials`: the official ones first, then others' with their author) | `tutorial list CODE --json` |
| Every firmware with tutorials (`/tutorials`) | `tutorial list --all --target cardenza --json` |
| A guide (`/<CODE>/t/<id>`: lessons, steps, the board with the step's keys, the screen) | `tutorial show CODE ID --json` (`document`); its file: `--out docs/tutorial.json` |
| A link's leaving page | `tutorial show CODE ID --json` (`url`) |
| 写教程 / Write a tutorial (the editor: the file's text, its errors with their lines as one types, the preview, pictures) | `tutorial new`, `tutorial check --json` (the same checks, the same errors), `tutorial publish --dry-run --json`, then `tutorial publish --json` (pictures uploaded once by SHA-256) |
| Change your tutorial (编辑) | change the file, `tutorial publish --json` (one guide each a firmware: it changes yours) |
| 添加链接 / Add a link | `tutorial link CODE https://… --title "…" --json` |
| Delete your tutorial | `tutorial rm CODE ID --yes --json` |
| Hide one on your firmware (the owner, an admin) | `tutorial hide CODE ID --reason "…" --json` (`--off` shows it again) |
| The format (`/tutorials/format`) | `reference/tutorial-format.md`, `help tutorials` |

## Making and changing a firmware (firmware-forms.js)

| Site | 203cli |
|---|---|
| /new: an original | `init`, then `publish --dry-run` / `publish` (or `firmware create --name … --summary …`) |
| /new: a mod (its original picked first) | `fork CODE DIR` (clones, writes 203.json with `forked_from`); `publish` from inside |
| Edit: name, blurb, description, tags, source, clone link, visibility, password, channels | `firmware edit CODE --summary … --tags … --source-url … --private --password … --beta --dev --json` |
| Edit: licence | `firmware edit CODE --license MIT --json`, or 203.json `license` |
| Edit: made from ("based on") | `firmware based-on CODE ORIGIN --version 0.3.0 --json` (`none` clears it) |
| Cover (/new's cover step, the edit page; a mod keeps its original's) | `firmware cover CODE cover.png --json` (`--remove`); `publish --cover cover.png` |
| 图片 Pictures (/new's step, the edit page): the gallery shown large above the description, up to 9 with captions, in order | `firmware images add CODE shot.png --caption "…" --json`; `firmware images list|edit|order|remove CODE …`; 203.json `publish.images` (publish makes the gallery that list) |
| 插入图片 in the description (the edit page, /new): pictures placed by the text, `![words](image:ID)`, up to 20 | `firmware images add CODE flow.png --description --json` (prints the reference); `--description-file` uploads the local pictures it names; `firmware images prune CODE` |
| Release page: 这次不加封面 (a stable version without any cover) | `publish … --without-cover` (else `cover_required`) |
| Release a version (BINs, notes, web build) | `publish …` / `versions publish CODE …` (the simulator version with it) |
| 开发 › 自动发布 (Trusted publishing): linked repositories, add, remove | `firmware publishers list CODE`, `firmware publishers add CODE --repository OWNER/NAME --workflow FILE [--environment ENV] [--channels …]`, `firmware publishers remove CODE ID --yes`; the run signs in with `login --github-oidc --firmware CODE` |
| A version's notes | `versions edit VCODE --notes …` |
| A version's source archive | `source check`, `source upload VCODE`, `source delete CODE VCODE --yes`; 203.json `publish_source` |
| Delete a version | `versions delete VCODE --yes` |
| Appeal a version sent back | `versions check VCODE`, `versions appeal VCODE --message …` |
| Page quality | `firmware checklist CODE --json` |
| Check before doing it | every publishing command takes `--dry-run`; publish also asks the server's own dry run |

## Sharing (works.js, models.js, packs.js, posts.js, comments)

| Site | 203cli |
|---|---|
| Upload a work / model / sound pack / project | `works upload FILE`, `models upload FILE…`, `sounds upload FILE…`, `projects upload FILE…` (`--dry-run`) |
| Show, edit, delete, download | `works|models|sounds|projects show|edit|delete|download ID` |
| Approve a work your device sent (held) | `works approve ID` |
| Model remixes | `models remixes ID` |
| Posts | `posts list|show|create|edit|delete` |
| Comments and replies, likes | `comments list|replies|add|edit|delete`, `like KIND REF` |

## The account (me.js, user.js, misc.js)

| Site | 203cli |
|---|---|
| Profile: name, avatar (preset), bio | `me edit --name … --avatar a07 --bio …` |
| Drawn avatar | web only (the drawing board); `api POST /me` with `avatar_pixels` works too |
| Title and badges worn | `titles`, `titles wear ID`, `badges`, `badges wear ID…`, `badges all` |
| XP history, levels | `xp`, `levels` |
| Notifications | `notifications [--read]` |
| Favourites, my things | `favorites --kind firmware`, `mine firmware|works|posts|models|sounds|projects`, `firmware mine` |
| A person's page | `user ID [WHAT]` |
| What is left of today's limits | `quotas --json` (the site shows it nowhere yet) |
| This sign-in (kind, scopes) | `whoami --json` (`credential`) |
| 个人令牌 Personal tokens: list, delete, new | **web only** (/me/tokens); `logout` revokes 203cli's own |
| Sign 203cli in | `login` (opens /authorize in the browser; `--with-token`: a personal token made on /me/tokens; `--no-browser`: a code for /activate) |
| Approve a sign-in (/authorize, /activate) | **web only** (the site's own sign-in says who approves) |
| 我的设备 (the profile's tab; /me/devices leads there): the list, online or off | `devices list --json` |
| 我的设备: 升级启动器 (a device's Launcher behind the newest: from → to, the version's notes) | `devices list --json` (`launcher_update`), `devices update-launcher DEVICE --json` |
| 我的设备: add a device (approve its code), rename, unbind (更多), the old bind code | **web only** (/me/devices, /activate); `devices bind-code|rename|unbind` say so |
| 我的设备 › 添加设备 › 用 USB 线 (binding the device on a USB cable: `account`, `POST /me/devices/usb`, `account bind`) | **web only** (a credential is made, and Web Serial reaches the device; Node has no serial port) |
| 我的设备 › files (/files): a device's TF card and internal flash over USB (upload, download, rename, delete, a partition backup) | **web only** (Web Serial to the Launcher's USB console; Node has no serial port) |
| 恢复刷机 Recovery flash (/recover, Web Serial): the official Launcher and official firmware, whole flash erased | `devices recover --dry-run --json`; `--out DIR` (the images, plan.json, flash.sh); `--port PORT --yes` (writes it with Python's esptool: Node has no serial port) |
| Feedback and appeals | `feedback --kind bug --title … --message …`, `feedback mine` |
| Close the account (注销) | **web only**, after a recent sign-in |
| Linked sign-ins (GitHub, WeChat) | **web only** (personal data) |

## Developers (requests.js, the tracker)

| Site | 203cli |
|---|---|
| The internal tracker of your firmware's requests | `dev list`, `dev read CODE N`, `dev update CODE N --status … --note …` |

## Admins (admin.js, item-menu.js)

| Site | 203cli |
|---|---|
| Overview, people, ban, unban, close an account | `admin overview`, `admin users`, `admin ban ID`, `admin unban ID`, `admin delete-user ID --yes` |
| Content: hide, unhide, delete, feature; hidden list | `admin hide|unhide|delete KIND REF`, `admin feature KIND REF`, `api GET /admin/hidden` |
| Official firmware, posts pinned or locked | `admin official CODE`, `admin add-official HUB_APP_ID`, `admin pin ID`, `admin lock ID` |
| Sections: tree of tags, open or close | `admin section-set ID --categories … --open` |
| Titles, badges, XP | `admin titles`, `admin title-create`, `admin grant-title`, `admin badge-create`, `admin grant-badge`, `admin xp` |
| Reports | `admin reports`, `admin resolve N ACTION` |
| The community tracker (appeals, feedback) | `admin issues`, `admin issue N`, `admin issue-update N`, `admin override VCODE`, `admin recheck VCODE` |
| Audit log | `admin audit` |
| Devices in the picker | `api POST /admin/targets/TARGET --body '{"listed":true}'` |

## Anything else

`api GET|POST PATH` calls any endpoint (`reference/api.md`); `ops` lists every operation with its JSON schema
(the admin ones too, which the public `reference/api.md` and `/openapi.json` leave out).
