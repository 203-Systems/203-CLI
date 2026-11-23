# The 203 community API (reference)

Generated from the API's route table (`tools/openapi.mjs`); the full schemas are at `https://community.203.io/api/openapi.json`.
Base: `https://community.203.io/api`. JSON in and out; errors `{"error", "code"}` (+ `field`, `attempts_left`, `retry_after`).
Lists answer `{total, page, page_size, items}` (24 a page, `?page=`); the section lists (answer `Section<…>`) also take `?cursor=`
(the previous answer's `next_cursor`, null at the end) and `?limit=` (1-60). Auth column: the scope a token needs (empty: anyone).

## General

| | | auth | answer |
|---|---|---|---|
| `GET /` | What the API is: version, sign-in providers, limits |  | Info |
| `GET /openapi.json` | This API as OpenAPI 3.1 |  | OpenApi |
| `GET /targets` | Every device: the 203 Launcher's (the hub's) and download-only ones (Mystrix: UF2); listed ones are offered in the firmware section's picker |  | Targets |
| `GET /signing-keys` | The community's public keys (Ed25519) whose build signatures are valid, the one signing now first: what a Launcher embeds |  | SigningKeys |
| `GET /tags?kind&section` | The 40 most used tags of public firmware, posts, works, models, sounds or projects |  | Tags |
| `GET /codes/{code}` | What a firmware or version code names |  | CodeAnswer |
| `GET /sections?target&forks` | The six sections, in order, with their labels, whether they are open, and counts (firmware: one device's) |  | Sections |
| `GET /sections/{id}?target&forks` | A section's tree of categories (parents and children, labels, counts), its other tags and its 60 most used tags |  | Section |
| `GET /search?q` | Search firmware, posts, works, models, sounds, projects and people (6 of each); a code is looked up as one |  | SearchAnswer |

## Signing in

| | | auth | answer |
|---|---|---|---|
| `GET /auth/providers` | Sign-in providers |  | Providers |
| `POST /auth/wechat/start` | Start a WeChat QR sign-in (sets the cookie __Host-community_login; site origin only) |  | WeChatStart |
| `GET /auth/wechat/status?login_id` | Poll a WeChat sign-in (with its cookie); done comes once and sets the session cookie |  | WeChatStatus |
| `GET /wechat` | WeChat's server URL verification (not for clients) | WeChat | Text |
| `POST /wechat` | WeChat's event push (not for clients) | WeChat | Text |
| `GET /auth/github/login?next` | GitHub sign-in (only when configured) |  | redirect |
| `GET /auth/github/callback` | GitHub's redirect back (only when configured) |  | redirect |
| `POST /auth/logout` | Sign out (clears the session cookie) |  | Status |
| `POST /auth/device/start` | Start a device authorization (203cli: client cli; a Launcher: client device); approved on /activate — body: client?, name?, device_id?, target?, launcher_version? |  | DeviceStart |
| `POST /auth/device/poll` | Poll a device authorization: 428 until approved, then the credential once — body: request_id |  | DeviceToken |
| `GET /auth/device/{user_code}` | What a sign-in code asks for (the /activate page) | website only | DeviceRequest |
| `POST /auth/device/approve` | Approve (scopes, a name) or refuse a sign-in — body: user_code, approve, scopes?, name? | website only | DeviceApproved |
| `GET /auth/authorize?response_type&client_id&redirect_uri&code_challenge&code_challenge_method&state&scope&name` | 203cli's browser sign-in: check an authorization request (PKCE S256, loopback redirect); answers the site's /authorize page to open |  | AuthorizeCheck |
| `POST /auth/authorize` | Approve (scopes) or refuse a browser sign-in (the /authorize page); answers where to send the browser — body: response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope?, name?, approve, scopes? | website only | Authorized |
| `POST /auth/token` | Exchange an authorization code and its verifier for a cli credential (once, within 60 seconds) — body: grant_type, code, code_verifier, redirect_uri, client_id |  | DeviceToken |
| `POST /auth/oidc/github` | Trusted publishing: a GitHub Actions run's OIDC token (audience: this API's base) for a ci credential that publishes one firmware's versions for 15 minutes, when a trusted publisher of it matches the run; 401 oidc_invalid, 403 oidc_untrusted or oidc_channel — body: token, firmware |  | OidcToken |

## The account

| | | auth | answer |
|---|---|---|---|
| `GET /me` | The signed-in account (a token or device: which credential; nothing personal) | token or device | Me |
| `POST /me` | Change name, avatar (a preset or a drawn one) or bio — body: name?, avatar?, avatar_pixels?, bio? | write | Me |
| `POST /me/delete` | Close the account (注销); needs a sign-in from the last 24 hours — body: confirm | website, recent sign-in | Status |
| `GET /me/notifications` | Notifications, newest first, with the unread count | read | List&lt;Notification&gt; |
| `POST /me/notifications/read` | Mark notifications read (all when ids is absent) — body: ids? | write | Unread |
| `GET /me/favorites?kind` | Favourites of one kind | read | List&lt;FirmwareSummary or PostSummary or Work or ModelSummary or SoundSummary or ProjectSummary&gt; |
| `GET /me/firmware` | Own firmware, private and hidden ones too | read | List&lt;FirmwareSummary&gt; |
| `GET /me/works` | Own works | read | List&lt;Work&gt; |
| `GET /me/posts` | Own posts | read | List&lt;PostSummary&gt; |
| `GET /me/models` | Own models | read | List&lt;ModelSummary&gt; |
| `GET /me/sounds` | Own sound packs (uploading and hidden ones too) | read | List&lt;SoundSummary&gt; |
| `GET /me/projects` | Own projects (uploading and hidden ones too) | read | List&lt;ProjectSummary&gt; |
| `GET /me/credentials` | Every credential of the account (web, cli, ci, device); the site does not list them (personal tokens: /me/tokens, devices: /me/devices) | website only | Credentials |
| `POST /me/credentials/{id}/revoke` | Revoke one (w<n>, t<n>, d<n>); the current session: signed out | website only | Revoked |
| `POST /me/credentials/revoke-all` | Revoke every credential (keep_current: this browser stays signed in, default) — body: keep_current? | website only | Revoked |
| `GET /me/quotas` | What is left of every limit (per account, per day) | read | Quotas |
| `GET /me/tokens` | Personal tokens: 203cli's sign-ins (cli) and the ones made on the site (ci) | website only | TokenList |
| `POST /me/tokens` | Make a personal token (ci; shown once; no end unless expires_in_days; at most 20) — body: name, scopes, expires_in_days? | website only | 201 NewToken |
| `POST /me/tokens/{id}/delete` | Delete a personal token (it stops working at once) | website only | Status |
| `GET /me/devices` | Bound devices (online, where, what each has installed) and, for the website, the current bind code | read | Devices |
| `POST /me/devices/code` | A new bind code (the old one stops working) | website only | BindCode |
| `POST /me/devices/usb` | Bind the device on this computer's USB cable (the website writes the answer into it with the Launcher's `account bind`): the device flow's credential, its limits; another account's device only with rebind: true (409 device_bound before) — body: device_id, target, launcher_version?, name?, rebind? | website only | 201 UsbBound |
| `POST /me/devices/{id}` | Rename a device — body: name | website only | Device |
| `POST /me/devices/{id}/delete` | Unbind a device (its token stops working) | website only | Status |

## Devices

| | | auth | answer |
|---|---|---|---|
| `POST /me/devices/{id}/commands` | Send a firmware to a bound, online device (install, or install and start), or its newest 203 Launcher (update_launcher); offline: 409 device_offline — body: action, code?, channel?, target? | write | 201 Command |
| `GET /me/devices/{id}/commands/{cid}` | A command's progress (ask every 2 s) | read | Command |
| `POST /me/devices/{id}/commands/{cid}/cancel` | Cancel a command not finished yet: it ends at once, failed with cancelled true (a device that is downloading it may still finish or fail by itself); a finished one is answered as it is | write | Command |
| `POST /me/devices/{id}/installed` | The website installed a build on this device over a USB cable: its signed statement (checked) is recorded as the device's build, verified — body: signed | website only | MyDevice |

## Experience, badges, titles

| | | auth | answer |
|---|---|---|---|
| `GET /levels` | Levels and the XP rules |  | Levels |
| `GET /badges` | Every badge and how it is earned |  | BadgeList |
| `GET /me/xp` | The account's XP history | read | XpHistory |
| `GET /me/badges` | Owned badges and the worn ones | read | MyBadges |
| `POST /me/badges` | Wear 0-3 owned badges, in display order — body: worn | write | MyBadges |
| `GET /me/titles` | Owned titles and the worn one | read | MyTitles |
| `POST /me/title` | Wear a title (null: none; admins then show 管理员) — body: title | write | MyTitles |

## Users

| | | auth | answer |
|---|---|---|---|
| `GET /users/{id}` | A person (AdminUser for an admin viewer); 410 for a closed account |  | User |
| `GET /users/{id}/firmware` | A person's public firmware |  | List&lt;FirmwareSummary&gt; |
| `GET /users/{id}/works` | A person's works |  | List&lt;Work&gt; |
| `GET /users/{id}/posts` | A person's posts |  | List&lt;PostSummary&gt; |
| `GET /users/{id}/models` | A person's models |  | List&lt;ModelSummary&gt; |
| `GET /users/{id}/sounds` | A person's sound packs |  | List&lt;SoundSummary&gt; |
| `GET /users/{id}/projects` | A person's projects |  | List&lt;ProjectSummary&gt; |
| `GET /users/{id}/badges` | A person's badges |  | UserBadges |
| `GET /users/{id}/avatar.svg?v` | A drawn avatar as an SVG (24 x 24 cells of the fixed palette; immutable for its revision) |  | Svg |

## Firmware

| | | auth | answer |
|---|---|---|---|
| `GET /firmware?kind&section&official&q&tag&target&forks&family&sort&featured&tags` | Public firmware of one device, forks only with forks=1; official ones first (endless: cursor) |  | Section&lt;FirmwareSummary&gt; |
| `POST /firmware?dry_run` | Make a firmware (or a fork: forked_from); at most 50 per account; ?dry_run=1 checks only — body: name, summary, description?, tags?, source_url?, clone_url?, license?, visibility, password?, channels?, forked_from?, kind? | write | 201 Firmware |
| `GET /firmware/lookup?name` | Firmware with exactly this name (ignoring case): yours first, any device, forks too; up to 20 |  | FirmwareLookup |
| `GET /firmware/{code}` | A firmware (401 password_required: private, not unlocked) |  | Firmware |
| `POST /firmware/{code}/unlock` | Open a private firmware with its password (10 tries per 10 minutes per IP) — body: password |  | Unlocked |
| `POST /firmware/{code}/edit?dry_run` | Change a firmware (owner, admin), its licence and what it is based on (forked_from); ?dry_run=1 checks only — body: name?, summary?, description?, tags?, source_url?, clone_url?, license?, visibility?, password?, channels?, forked_from? | write | Firmware |
| `POST /firmware/{code}/cover` | A signed upload for a new cover (PNG, JPEG or WebP, up to 2 MB; owner, admin) — body: mime, size | write | CoverUpload |
| `POST /firmware/{code}/cover/done` | The cover is uploaded: check it, it replaces the one shown | write | Firmware |
| `POST /firmware/{code}/cover/delete` | Remove the cover (a fork then shows its original's, else the screen after boot, else the grey default) | write | Firmware |
| `POST /firmware/{code}/images` | A signed upload for a new picture (PNG, JPEG or WebP, up to 2 MB; place gallery, at most 9, or description, at most 20; owner, admin) — body: mime, size, caption?, place? | write | ImageUpload |
| `POST /firmware/{code}/images/order` | The gallery in a new order (every gallery picture's id once) — body: ids | write | Firmware |
| `POST /firmware/{code}/images/{id}/done` | The picture is uploaded: check it, it is shown after the others of its place | write | Firmware |
| `POST /firmware/{code}/images/{id}/edit` | A picture's caption (up to 60 characters; empty: none) or place (gallery or description) — body: caption?, place? | write | Firmware |
| `POST /firmware/{code}/images/{id}/delete` | Remove a picture (also one still being uploaded) | write | Firmware |
| `POST /firmware/{code}/delete` | Delete a firmware (owner, admin); its forks stay — body: confirm | write | Status |
| `GET /firmware/{code}/publishers` | Trusted publishers: the GitHub repositories whose Actions runs may publish its versions (owner, admin) | read | PublisherList |
| `POST /firmware/{code}/publishers` | Link a trusted publisher: a GitHub repository, its workflow file and environment, the channels (owner, admin; at most 5) — body: provider?, repository, workflow?, environment?, channels? | write | 201 Publisher |
| `POST /firmware/{code}/publishers/{id}/delete` | Remove a trusted publisher (its credentials stop working at once) | write | PublisherDeleted |
| `POST /firmware/{code}/like` | Like or unlike — body: on | write | Reaction |
| `POST /firmware/{code}/favorite` | Favourite or not — body: on | write | Reaction |
| `GET /firmware/{code}/tree` | The fork tree around a firmware |  | Tree |

## Versions

| | | auth | answer |
|---|---|---|---|
| `POST /builds/identify` | What builds are: each a signed statement (signed, or a BIN's trailer) checked here, or the sha256 of a file / image_digest of a partition matched by the community's record (1-20) — body: builds |  | Identified |
| `GET /firmware/{code}/versions?channel&target` | Versions, newest first (drafts too for the owner); target: one device's line |  | List&lt;Version&gt; |
| `GET /firmware/{code}/versions/{label}` | A version by its label (1.4.0) |  | Version |
| `POST /firmware/{code}/versions?dry_run` | A draft version with one upload ticket per device (owner); the same label again gives new tickets; ?dry_run=1 checks only — body: channel, version, notes?, source_commit?, source_url?, targets | write or publish | 201 NewVersion |
| `POST /firmware/{code}/versions/{vcode}/source` | A ticket to upload the version's source archive (.tar.gz, up to 16 MB; checked for secrets) — body: size, sha256 | write or publish | 201 SourceUpload |
| `POST /firmware/{code}/versions/{vcode}/source/delete` | Remove the version's source archive | write | Version |
| `POST /firmware/{code}/versions/{vcode}/publish` | Publish a draft once every device's BIN is uploaded (a stable one needs a cover, else 409 cover_required) — body: without_cover? | write or publish | Version |
| `POST /firmware/{code}/versions/{vcode}/simulator` | A web build's files (index.html and what it loads): one upload ticket each — body: files | write or publish | 201 SimulatorUploads |
| `POST /firmware/{code}/versions/{vcode}/simulator/check` | Report whether the web build booted in this browser, or unchecked: the checker checks it again (owner or admin) — body: status | write or publish | Version |
| `POST /upload` | Upload with a ticket: a device's BIN (multipart image, notices; diagnosed; a download-only device's UF2 file), a web build's file (field file) or a source archive (field source) — body: image?, notices?, file?, source? | upload ticket | 201 Uploaded |
| `GET /versions/{vcode}` | A version and its firmware |  | VersionAnswer |
| `POST /versions/{vcode}/edit` | Change a version's notes (owner, admin) — body: notes | write or publish | Version |
| `POST /versions/{vcode}/delete` | Delete a version (owner, admin) — body: confirm | write | Status |
| `POST /versions/{vcode}/download` | A device's BIN to download (counted); a third-party launcher needs accept_risk — body: target, accept_risk? |  | VersionDownload |
| `GET /recovery` | A recovery flash (恢复刷机): per device, the official Launcher's newest stable build and the official firmware's (no links: download each with POST /versions/{vcode}/download) |  | Recovery |

## Checks and appeals

| | | auth | answer |
|---|---|---|---|
| `POST /versions/{vcode}/appeal` | Appeal a version sent back by the checks (its owner; one open appeal) — body: message | write | 201 Issue |

## Requests

| | | auth | answer |
|---|---|---|---|
| `GET /firmware/{code}/requests?sort&status` | Requests under a firmware |  | List&lt;Request&gt; |
| `POST /firmware/{code}/requests` | Ask for something; 10 a day (a bot 200) — body: title, body?, attachments? | write | 201 Request |
| `GET /firmware/{code}/requests/{n}` | A request |  | Request |
| `POST /firmware/{code}/requests/{n}/edit` | Change a request (author) — body: title?, body?, attachments? | write | Request |
| `POST /firmware/{code}/requests/{n}/delete` | Delete a request (author, the firmware's owner, admin) | write | Status |
| `POST /firmware/{code}/requests/{n}/vote` | Vote up (1), down (-1) or take the vote back (0) — body: vote | write | Votes |

## Trackers (internal)

| | | auth | answer |
|---|---|---|---|
| `GET /dev/requests?firmware&status&sort&author` | Internal: requests of your firmware with their tracker (admins: all) | read | List&lt;DevRequest&gt; |
| `GET /dev/requests/{code}/{n}` | Internal: a request with its tracker and whole discussion (the specification) | read | DevRequestFull |
| `POST /dev/requests/{code}/{n}` | Internal: set status, progress, labels; add a note or a link (never notifies) — body: status?, progress?, labels?, note?, link? | write | DevRequest |

## Merge requests

| | | auth | answer |
|---|---|---|---|
| `GET /firmware/{code}/merges?status` | Merge requests aimed at a firmware |  | List&lt;MergeRequest&gt; |
| `POST /firmware/{code}/merges` | Open a merge request from your fork — body: from, from_version?, title, body?, github_url? | write | 201 MergeRequest |
| `GET /firmware/{code}/merges/{n}` | A merge request |  | MergeRequest |
| `POST /firmware/{code}/merges/{n}/status` | Merge, close or reopen — body: status, merged_version? | write | MergeRequest |

## Tutorials

| | | auth | answer |
|---|---|---|---|
| `GET /firmware/{code}/tutorials` | A firmware's tutorials: its owner's first (official), then the others, newest updated first |  | List&lt;TutorialSummary&gt; |
| `POST /firmware/{code}/tutorials?dry_run` | Add a tutorial: {document} (the file's text, checked: errors with line and column) or {title, url} (a link); one guide and 5 links each; 20 a day — body: document?, title?, url? | write | 201 Tutorial |
| `GET /firmware/{code}/tutorials/{id}` | A tutorial (a guide's document; its source for its author) |  | Tutorial |
| `POST /firmware/{code}/tutorials/{id}/edit?dry_run` | Change a tutorial (its author): a guide's whole file, a link's title or address — body: document?, title?, url? | write | Tutorial |
| `POST /firmware/{code}/tutorials/{id}/delete` | Delete a tutorial (its author, an admin); a guide's pictures go with it | write | Status |
| `POST /firmware/{code}/tutorials/{id}/hide` | Hide a tutorial or show it again (the firmware's owner, an admin; its author is told) — body: on, reason? | write | Tutorial |
| `GET /firmware/{code}/tutorial-images` | Your pictures for your tutorial of a firmware (image:<id> in its file) | read | TutorialImages |
| `POST /firmware/{code}/tutorial-images` | A signed upload for a tutorial's picture (PNG, JPEG or WebP, up to 2 MB; 60 a firmware) — body: mime, size | write | ImageUpload |
| `POST /firmware/{code}/tutorial-images/{id}/done` | The picture is uploaded: check it | write | TutorialImage |
| `POST /firmware/{code}/tutorial-images/{id}/delete` | Remove a picture no tutorial of yours shows | write | Status |
| `GET /tutorials?target&q` | Firmware with tutorials, the most downloaded first: each with its count and first 3 (the official first) |  | List&lt;FirmwareTutorials&gt; |

## Works

| | | auth | answer |
|---|---|---|---|
| `GET /firmware/{code}/works?version` | Works made with a firmware |  | List&lt;Work&gt; |
| `GET /works?q&tag&firmware&sort&featured&tags` | Works (endless: cursor) |  | Section&lt;Work&gt; |
| `POST /works` | A work (uploading) and its signed upload; 20 a day — body: title, description?, kind, mime, size, duration_ms?, tags?, firmware, version?, version_label? | write | 201 NewWork |
| `POST /works/{id}/done` | The file is uploaded: check it, the work is ready | write | Work |
| `GET /works/{id}` | A work |  | Work |
| `POST /works/{id}/edit` | Change a work — body: title?, description?, tags?, version? | write | Work |
| `POST /works/{id}/delete` | Delete a work | write | Status |
| `POST /works/{id}/approve` | Publish a work your device sent (held until then) | write | Work |
| `POST /works/{id}/like` | Like or unlike — body: on | write | Reaction |
| `POST /works/{id}/favorite` | Favourite or not — body: on | write | Reaction |
| `POST /works/{id}/play` | Count a play (once a day per viewer) |  | Plays |

## Models

| | | auth | answer |
|---|---|---|---|
| `GET /models?q&tag&target&firmware&sort&featured&tags` | Models (3D files) (endless: cursor) |  | Section&lt;ModelSummary&gt; |
| `POST /models` | A model (uploading) and a signed upload per slot (files, preview, thumbnail); 20 a day — body: title, description?, tags?, target?, firmware?, license, remix_of?, print?, files, preview, thumbnail | write | 201 NewModel |
| `POST /models/{id}/done` | Every slot is uploaded: check them, the model is ready | write | Model |
| `GET /models/{id}` | A model |  | Model |
| `POST /models/{id}/edit` | Change a model — body: title?, description?, tags?, target?, firmware?, license?, print? | write | Model |
| `POST /models/{id}/delete` | Delete a model | write | Status |
| `POST /models/{id}/like` | Like or unlike — body: on | write | Reaction |
| `POST /models/{id}/favorite` | Favourite or not — body: on | write | Reaction |
| `POST /models/{id}/download` | A file's download link (counted once a day per viewer) — body: file? |  | Download |
| `GET /models/{id}/remixes` | Remixes of a model |  | List&lt;ModelSummary&gt; |

## Sound packs

| | | auth | answer |
|---|---|---|---|
| `GET /sounds?q&tag&engine&firmware&sort&featured&tags` | Sound packs for official firmware (endless: cursor) |  | Section&lt;SoundSummary&gt; |
| `POST /sounds` | Share a sound pack (uploading) for an official firmware: a signed upload per file; 20 a day — body: title, description?, tags?, engine, firmware, version?, files | write | 201 NewSound |
| `POST /sounds/{id}/done` | Every file is uploaded: check them (sizes, first bytes, the banks' engine), ready | write | Sound |
| `GET /sounds/{id}` | A sound pack |  | Sound |
| `POST /sounds/{id}/edit` | Change a sound pack (author, admin) — body: title?, description?, tags?, engine? | write | Sound |
| `POST /sounds/{id}/delete` | Delete a sound pack (author, admin) | write | Status |
| `POST /sounds/{id}/like` | Like or unlike — body: on | write | Reaction |
| `POST /sounds/{id}/favorite` | Favourite or not — body: on | write | Reaction |
| `POST /sounds/{id}/download` | A file's download link, or without file every file's (counted once a day per viewer) — body: file? |  | PackDownload |

## Projects

| | | auth | answer |
|---|---|---|---|
| `GET /projects?q&tag&firmware&sort&featured&tags` | Projects for official firmware (endless: cursor) |  | Section&lt;ProjectSummary&gt; |
| `POST /projects` | Share a project (uploading) for an official firmware: a signed upload per file; 20 a day — body: title, description?, tags?, bpm?, firmware, version?, files | write | 201 NewProject |
| `POST /projects/{id}/done` | Every file is uploaded: check them (sizes, first bytes, the format), ready | write | Project |
| `GET /projects/{id}` | A project |  | Project |
| `POST /projects/{id}/edit` | Change a project (author, admin) — body: title?, description?, tags?, bpm? | write | Project |
| `POST /projects/{id}/delete` | Delete a project (author, admin) | write | Status |
| `POST /projects/{id}/like` | Like or unlike — body: on | write | Reaction |
| `POST /projects/{id}/favorite` | Favourite or not — body: on | write | Reaction |
| `POST /projects/{id}/download` | A file's download link, or without file every file's (counted once a day per viewer) — body: file? |  | PackDownload |

## Posts

| | | auth | answer |
|---|---|---|---|
| `GET /posts?q&tag&firmware&sort&featured&tags` | Posts, pinned first (endless: cursor) |  | Section&lt;PostSummary&gt; |
| `POST /posts` | Write a post; 20 a day (a bot 200) — body: title, body, tags?, firmware?, attachments? | write | 201 Post |
| `GET /posts/{id}` | A post |  | Post |
| `POST /posts/{id}/edit` | Change a post (author, admin) — body: title?, body?, tags?, firmware?, attachments? | write | Post |
| `POST /posts/{id}/delete` | Delete a post (author, admin) | write | Status |
| `POST /posts/{id}/like` | Like or unlike — body: on | write | Reaction |
| `POST /posts/{id}/favorite` | Favourite or not — body: on | write | Reaction |

## Comments

| | | auth | answer |
|---|---|---|---|
| `GET /firmware/{code}/requests/{n}/comments` | Discussion of a request |  | List&lt;Comment&gt; |
| `POST /firmware/{code}/requests/{n}/comments` | Comment on a request — body: body, parent?, attachments? | write | 201 Comment |
| `GET /firmware/{code}/comments` | Comments on a firmware |  | List&lt;Comment&gt; |
| `POST /firmware/{code}/comments` | Comment on a firmware — body: body, parent?, attachments? | write | 201 Comment |
| `GET /firmware/{code}/merges/{n}/comments` | Comments on a merge request |  | List&lt;Comment&gt; |
| `POST /firmware/{code}/merges/{n}/comments` | Comment on a merge request — body: body, parent?, attachments? | write | 201 Comment |
| `GET /works/{id}/comments` | Comments on a work |  | List&lt;Comment&gt; |
| `POST /works/{id}/comments` | Comment on a work — body: body, parent?, attachments? | write | 201 Comment |
| `GET /models/{id}/comments` | Comments on a model |  | List&lt;Comment&gt; |
| `POST /models/{id}/comments` | Comment on a model — body: body, parent?, attachments? | write | 201 Comment |
| `GET /sounds/{id}/comments` | Comments on a sound pack |  | List&lt;Comment&gt; |
| `POST /sounds/{id}/comments` | Comment on a sound pack — body: body, parent?, attachments? | write | 201 Comment |
| `GET /projects/{id}/comments` | Comments on a project |  | List&lt;Comment&gt; |
| `POST /projects/{id}/comments` | Comment on a project — body: body, parent?, attachments? | write | 201 Comment |
| `GET /posts/{id}/comments` | Comments on a post |  | List&lt;Comment&gt; |
| `POST /posts/{id}/comments` | Comment on a post (refused when locked) — body: body, parent?, attachments? | write | 201 Comment |
| `GET /comments/{id}/replies` | Replies to a comment, oldest first |  | List&lt;Comment&gt; |
| `POST /attachments` | A signed upload for an attachment (a picture up to 10 MB, a video up to 95 MB, another file up to 20 MB); bots too — body: name, size, type?, kind? | write | AttachmentUpload |
| `POST /attachments/{id}/done` | The attachment is uploaded: check it (size; a picture's or video's type from its first bytes) | write | Attachment |
| `POST /attachments/{id}/delete` | Remove an attachment of yours that is on nothing (one on something goes with an edit of it) | write | Status |
| `POST /comments/{id}/edit` | Change a comment (author) — body: body?, attachments? | write | Comment |
| `POST /comments/{id}/delete` | Delete a comment (author, the thing's owner, admin) | write | Status |
| `POST /comments/{id}/like` | Like or unlike — body: on | write | Reaction |

## Reports

| | | auth | answer |
|---|---|---|---|
| `POST /reports` | Report something; 20 a day — body: kind, ref, reason, detail? | write | 201 ReportMade |

## Feedback

| | | auth | answer |
|---|---|---|---|
| `POST /feedback` | Feedback about the community itself (a bug or an idea) — body: kind, title, message, page?, attachments? | write | 201 Issue |
| `GET /me/feedback` | Your appeals and feedback, with their status and our reply | read | List&lt;Issue&gt; |

## Launcher and devices

| | | auth | answer |
|---|---|---|---|
| `POST /launcher/bind` | Bind a device with an account's bind code (15 tries per 10 minutes per device and per IP) — body: code, device_id, target, name?, launcher_version? |  | Bound |
| `GET /launcher/me` | The device's account | device token | LauncherMe |
| `POST /launcher/rotate` | A new device credential replaces this one (the old stops working; rotate daily) | device token | Rotated |
| `POST /launcher/unbind` | Unbind this device | device token | Unbound |
| `GET /launcher/inbox?from` | The device's presence and its new commands (each once, with the Item to install) | device token | Inbox |
| `POST /launcher/running` | The Launcher is about to start an app: what it is (shown to the device's owner as what it runs, and whether that firmware can be online); 6 a minute — body: target, app_id?, code?, name, version?, build?, image_digest, signed? | device token | Running |
| `GET /launcher/commands/{id}` | A command this device took (with its Item while not finished): the Launcher carries on after a handover | device token | LauncherCommand |
| `POST /launcher/commands/{id}` | Report a command's step (handover from a firmware, then the Launcher's), progress or failure — body: status, progress?, error? | device token | Command |
| `GET /launcher/code/{code}?target` | A code's newest version per channel (or one version) for a device | device token optional | LauncherCode |
| `GET /launcher/featured?target&q&category` | The Launcher's store (it browses only featured firmware): featured firmware with a build for the device, newest featured first, 10 a page (each with the version its code installs and when it was published, its cover and its name labels); q= and category= are its Search and Filter, and a code typed in q comes first on page 1 (found: firmware or version; a private one without its password only {code, found, locked}) | device token optional | LauncherFeatured |
| `GET /launcher/categories?target` | The categories of the store's Filter: the top categories with featured firmware for the device, in order, each with its name and count | device token optional | LauncherCategories |
| `GET /launcher/notes/{vcode}?w&px&lang` | A version's release notes as a 1-bit picture in the Launcher's own look, laid out at w: width, height (at most 2048), line step, line count (uint16 LE each), then the rows, ceil(width/8) bytes each, MSB = left pixel, 1 = ink | device token optional | Binary |
| `GET /launcher/label/{code}?what&px&w&v` | A firmware's name or author as a 1-bit picture in the Launcher's own look (for names it has no glyphs for): width, height, baseline (uint16 LE each), then the rows, ceil(width/8) bytes each, MSB = left pixel, 1 = ink | device token optional | Binary |
| `GET /launcher/cover/{code}?w&h&c&v` | A firmware's cover as the Launcher draws it (any firmware it may show): w*h/2 bytes of 4-bit grey (two pixels a byte, the left one high; 0 black, 15 white), or with c=16 a palette of 16 colours (32 bytes: RGB565, uint16 LE each) then w*h/2 bytes of 4-bit palette indices | device token optional | Binary |
| `GET /launcher/self?target&version&channel` | The 203 Launcher's own update: the newest Launcher for the device on its channel (stable when that one has none), its notes, and whether it is newer than the running one; with the device token also the device's Launcher version | device token optional | LauncherSelf |
| `GET /launcher/self/download?code&target` | A 203 Launcher release's Launcher image for the device, counted: a redirect to the file (its size and SHA-256 are the release's; Range works) | device token optional | redirect |
| `POST /launcher/details` | The Launcher's installed list in the store's format: for each installed app (at most 16) its firmware's code, name, author, cover, name labels and when the version the device has was published; null for one it may not show (records nothing) — body: target, apps | device token optional | LauncherDetails |
| `POST /launcher/updates` | Updates for installed firmware, each on its channel; with the device token also what the device has installed (for its owner); a record may be the build's signed statement — body: target, installed | device token optional | Updates |
| `POST /launcher/installed` | Count a download (once per device and version); with the device token also that firmware's installed build on the device (verified with its signed statement) — body: app_id, code, signed? | device token optional | 204 none |
| `POST /device/works` | A device's work (audio/wav); the firmware is found from what it runs — body: title, description?, tags?, kind, mime, size, duration_ms?, version_label?, firmware_match | device token | 201 NewWork |
| `POST /device/works/{id}/done` | The device's file is uploaded | device token | DeviceWorkDone |
