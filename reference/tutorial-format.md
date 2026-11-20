# Tutorials (教程): the format

Every firmware on the 203 community can have **tutorials**: how to use it, on the device, step by step. They are written in one format, the one of the Cardenza's own guide (https://cardenza.203.io/guide/): **lessons of short steps**, each step a sentence or two, the keys it asks for lit on a drawing of the board, and what the screen shows. The community shows a tutorial that way on the firmware's page (its 教程 / Tutorials tab), in Chinese, English or both. Its API refuses a tutorial that does not follow this page, and `203c tutorial check` says where, line by line.

A tutorial is either

- **written here** (a guide): a JSON file in the format below, uploaded on the site (the tab's 写教程 / Write a tutorial, an editor that checks while you type and shows the result) or with `203c tutorial publish`; or
- **a link** to a tutorial elsewhere (a video, a blog, a wiki): a title and an `https://` address. People who open it first see a page that says they are leaving the community and where to.

The firmware's owner's tutorials are its **official** ones and come first; anyone signed in may add theirs (one guide and up to 5 links each per firmware). The owner and the community's admins may hide one; its author edits or deletes it.

**Description or tutorial?** A firmware's description (简介) says in a few lines what it is and why one would want it, with pictures (how to write one: reference/description-guide.md, on the site /guide/description). How to use it (key tables, menus, every setting) is a tutorial: the description links to the tutorials tab rather than holding a manual.

## The file

UTF-8 JSON, at most 200 KB. Comments and trailing commas are errors (JSON has none). A whole small tutorial:

```json
{
  "format": "203-tutorial/1",
  "firmware": "WTFSZE",
  "languages": ["zh", "en"],
  "title": {"zh": "OmniCtrl 上手", "en": "Getting started with OmniCtrl"},
  "summary": {"zh": "五分钟学会换模式、调参数、存预设。", "en": "Switch modes, change values and save presets in five minutes."},
  "lessons": [
    {
      "title": {"zh": "换模式", "en": "Switching modes"},
      "lead": {"zh": "一个键换到下一个模式。", "en": "One key goes to the next mode."},
      "steps": [
        {
          "say": {"zh": "按 {{key:tab}}：下一个模式，名字在屏幕最上面。", "en": "Press {{key:tab}}: the next mode; its name is at the top of the screen."},
          "keys": ["tab"],
          "image": "shots/mode.png"
        },
        {
          "say": {"zh": "按住 {{key:fn}} 再按 {{key:s}}：存成预设。", "en": "Hold {{key:fn}} and press {{key:s}}: saved as a preset."},
          "keys": ["fn+s"]
        }
      ]
    }
  ]
}
```

One language is shorter: `"languages": ["en"]`, and every text may then be a plain string (`"title": "Getting started"`).

### Fields

| Field | | |
|---|---|---|
| `format` | required | `"203-tutorial/1"` |
| `firmware` | optional | the firmware's six-character code; when given, the tutorial can only be published there |
| `languages` | required | `["zh"]`, `["en"]` or `["zh", "en"]`: every text is written in each of them |
| `title` | required | text, 2–60 wide |
| `summary` | optional | text, at most 200 wide: what one learns (shown in the list) |
| `lessons` | required | 1–30 lessons |
| lesson `title` | required | text, 1–60 wide |
| lesson `lead` | optional | text with markup, at most 200 wide: the lesson's one-line introduction |
| lesson `steps` | required | 1–30 steps (300 in the whole tutorial) |
| step `say` | required | text with markup, 1–280 wide: what to do and what happens |
| step `keys` | optional | up to 8 keys or key groups to light on the board: `["fn+s", "ok"]` |
| step `image` | optional | one picture of the screen (or of the device): see Pictures |

No other field is allowed (a misspelt one is an error, not ignored).

**Texts.** A text is `{"zh": "…", "en": "…"}` with exactly the tutorial's `languages`, each non-empty (a plain string when there is one language). Readers see their language, else the tutorial's first. **Width**: a Chinese, Japanese or Korean character (or a full-width sign) counts 2, anything else 1, counted on the words as shown (a link's address and the markup's signs are not counted): 280 is 140 Chinese characters or 280 English letters. Keep steps short: one action and what it does, like the Cardenza guide (half its steps are under 60 Chinese characters or 80 English letters); more to say is another step.

**Markup** (a step's `say`, a lesson's `lead`; titles and the summary are plain text):

| Write | Shows |
|---|---|
| `{{key:fn}}`, `{{key:fn+s}}` | the key cap(s), as on the device |
| `**bold**`, `*italic*` | emphasis |
| a word between backquotes | code |
| `[words](https://…)`, a bare `https://…` | a link (opens in a new tab) |

Nothing else: no HTML (`<tags>`, `&entities;`), no pictures in the words, no headings, lists, quotes, tables or code blocks, no line breaks (one paragraph a step), links only `https://`, `{{…}}` only `{{key:NAME}}`.

### Keys

The Cardenza's key caps, named as CardenzaHAL's `keyboard/legends.h` (and `203c board press`) names them, in lower case:

| Row | Keys |
|---|---|
| 1 | `esc` `1` `2` `3` `4` `5` `6` `7` `8` `9` `0` `-` `=` `del` |
| 2 | `tab` `q` `w` `e` `r` `t` `y` `u` `i` `o` `p` `[` `]` `\` |
| 3 | `fn` `shift` `a` `s` `d` `f` `g` `h` `j` `k` `l` `;` `'` `ok` |
| 4 | `ctrl` `opt` `alt` `z` `x` `c` `v` `b` `n` `m` `,` `.` `/` `space` |
| side | `home` (the side key left of the screen) |

Also: `enter` (= `ok`), and the yellow arrows `up` `down` `left` `right` (= `;` `.` `,` `/`). Case does not matter. Keys pressed together are joined with `+`: `fn+s`, `shift+tab` (at most 4). In JSON the backslash key is written `"\\"`. A step's `keys` are lit on the board, the others faded; a step that names `home` shows the whole board.

### Pictures

A step's `image` is one picture: a screenshot of the device's screen (shown in the board's display, enlarged pixel for pixel; the Cardenza's is 240 x 135) or a photo. PNG, JPEG or WebP, at most 2 MB; at most 60 different pictures in a tutorial. A step without one keeps the lesson's last picture on the screen.

- In the file on your computer, `image` is the picture's path relative to the file: `"shots/mode.png"` (forward slashes, no `..`). `203c tutorial publish` uploads each one (once: by its SHA-256) and publishes the file with `image:<id>` in its place; your file stays as it is.
- On the site, add the pictures in the editor's 图片 / Pictures panel: a reference to a file of the same name becomes its `image:<id>`.
- What the community stores has only `image:<id>`: pictures its author uploaded for that firmware (pictures elsewhere, `https://…`, are refused: the site loads pictures from the community only).

## Link tutorials

`{"title": "…", "url": "https://…"}`: a title of 2–60 wide (plain text) and an `https://` address (at most 500 characters, no user name or password in it). The site shows the title, the address's host and who added it; opening it shows the leaving page first.

## Checking and publishing

```sh
203c tutorial new                     # docs/tutorial.json to start from (the firmware from 203.json)
203c tutorial check docs/tutorial.json   # every error, with its line and column; exit 0 when it passes
203c tutorial publish docs/tutorial.json # check, upload the pictures, publish (again: changes what changed)
203c tutorial link CODE https://… --title "…"
203c tutorial list CODE
```

An error names where it is and what is wrong, for example

```text
docs/tutorial.json:14:22 lessons[0].steps[2].say.en: Too long: 312 of at most 280 (a Chinese character counts 2) (lesson 1, step 3)
docs/tutorial.json:21:17 lessons[1].steps[0].keys[1]: Unknown key "fnn". Keys: esc 1-0 - = del, … (lesson 2, step 1)
```

The API answers the same errors: a refused tutorial is 400 `invalid` with `field` `document` and `errors`, each `{line, column, path, code, params, message}` (`path` with dots: `lessons.0.steps.2.say.en`; `message` in the request's language). The codes: `syntax`, `syntax_comment`, `duplicate_field`, `too_big`, `not_object`, `format`, `unknown_field`, `required`, `type`, `languages`, `language_missing`, `language_extra`, `empty`, `too_long`, `too_short`, `count`, `all_steps`, `control`, `newline`, `html`, `picture_in_text`, `block`, `markup`, `key_unknown`, `key_twice`, `combo`, `link`, `picture_path`, `picture_remote`, `picture_not_uploaded`, `picture_unknown`, `too_many_pictures`, `firmware`, `firmware_code`.

The checks are one module, `scripts/tutorial-format.mjs` of 203-CLI (MIT): the community's API and its editor run the same code.
