// 203cli devices recover (the website's recovery flash from a computer) against a small stand-in API that
// answers GET /recovery and the downloads with real-shaped images, and a stand-in for Python's esptool that
// records what it was asked to write: the plan only (--dry-run), the files and the command (--out), the
// device written (--port, only with --yes), a download that is not the described file.
// Run: node --test tests/recover.test.mjs
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {ROOT, NO_UPDATES} from "./fixtures.mjs";
import {image, merged} from "./fixtures.mjs";

const CLI = path.join(ROOT, "scripts/203cli.mjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
let server, api, dir, launcher, app, corrupt = false, downloads = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "203cli-recover-"));
  launcher = Buffer.from(await merged());
  app = Buffer.from(await image({project: "CardenzaSynthFirmware", version: "0.2.0", size: 70000}));
  const item = (code, fw, name, bytes, extra = {}) => ({code, firmware_code: fw, name, version: "0.2.0", build: 1, target: "cardenza", channel: "stable",
    app_id: "5ca1ab1e-0203-4c1e-8d0e-000000000001", size: bytes.length, sha256: sha(bytes), description: "The groovebox", author: "203 Systems",
    published: "2026-11-14T10:00:00Z", ...extra});
  server = http.createServer((req, res) => {
    const send = (status, body, type = "application/json") => { res.writeHead(status, {"content-type": type}); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    if (req.url === "/api/recovery") {
      return send(200, {items: [{target: "cardenza", name: "Cardenza", launcher: item("6YNC8F", "8Y7KHP", "203 Launcher", launcher, {app_id: "5ca1ab1e-0203-4c1e-8d0e-000000000002"}),
        firmware: [item("H7DQ2Z", "V6QK28", "Cardenza Synth", app)]}]});
    }
    const m = /^\/api\/versions\/([A-Z0-9]+)\/download$/.exec(req.url);
    if (m && req.method === "POST") {
      downloads.push(m[1]);
      const bytes = m[1] === "H7DQ2Z" ? app : launcher;
      return send(200, {url: `${api.replace(/\/api$/, "")}/files/${m[1]}.bin`, sha256: sha(bytes), size: bytes.length, target: "cardenza"});
    }
    const f = /^\/files\/([A-Z0-9]+)\.bin$/.exec(req.url);
    if (f) {
      const bytes = Buffer.from(f[1] === "H7DQ2Z" ? app : launcher);
      if (corrupt && f[1] === "H7DQ2Z") bytes[500] ^= 1;
      return send(200, bytes, "application/octet-stream");
    }
    send(404, {error: "Not found", code: "not_found"});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });

function cli(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, "--api", api, ...args], {cwd: dir, env: {...process.env, ...NO_UPDATES, XDG_CONFIG_HOME: dir,
      COMMUNITY_TOKEN: "cct_" + "1".repeat(64), COMMUNITY_API: "", LANG: "en_US.UTF-8", ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => { let json = null; try { json = JSON.parse(stdout); } catch { json = null; } resolve({code, stdout, stderr, json}); });
  });
}

test("devices recover --dry-run: the plan, nothing written", async () => {
  const r = await cli(["devices", "recover", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.erase, "all");
  assert.deepEqual(r.json.writes.map(w => [w.address, w.size, w.what]), [[0, launcher.length, "launcher"], [0x170000, app.length, "firmware"]]);
  assert.deepEqual(r.json.firmware.map(f => [f.partition, f.offset, f.registered, f.sha256]), [["carden", 0x170000, true, sha(app)]]);
  assert.deepEqual(downloads, ["6YNC8F", "H7DQ2Z"], "the downloads go through the counted endpoint");
});

test("devices recover --out: the images, plan.json and the esptool command", async () => {
  const r = await cli(["devices", "recover", "--out", "saved", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const out = path.join(dir, "saved");
  assert.deepEqual(r.json.files, ["0x0-launcher-0.2.0-cardenza.bin", "0x170000-carden-0.2.0.bin"]);
  const base = fs.readFileSync(path.join(out, r.json.files[0]));
  assert.equal(base.length, launcher.length);
  assert.ok(base.subarray(0, 0x8000).equals(launcher.subarray(0, 0x8000)), "the bootloader as it came");
  assert.ok(!base.subarray(0x8000, 0x9000).equals(launcher.subarray(0x8000, 0x9000)), "the table with the firmware's partition");
  assert.ok(fs.readFileSync(path.join(out, r.json.files[1])).equals(app));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "plan.json"), "utf8")).partitions.at(-1).label, "carden");
  const script = fs.readFileSync(path.join(out, "flash.sh"), "utf8");
  assert.match(script, /write_flash --erase-all --flash_mode keep --flash_freq keep --flash_size keep 0x0 0x0-launcher-0\.2\.0-cardenza\.bin 0x170000 0x170000-carden-0\.2\.0\.bin/);
  assert.match(script, /--port "\$PORT"/);
});

test("devices recover --port: needs --yes; then esptool erases, writes and resets in one session", {skip: process.platform === "win32" && "a sh script stands in for Python"}, async () => {
  const record = path.join(dir, "esptool-args.txt");
  const fake = path.join(dir, "fake-python");
  fs.writeFileSync(fake, `#!/bin/sh
if [ "$3" = "version" ]; then echo "esptool v4.8.1"; exit 0; fi
echo "$@" > "${record}"
for a in "$@"; do case "$a" in *.bin) wc -c < "$a" >> "${record}";; esac; done
`, {mode: 0o755});
  const refused = await cli(["devices", "recover", "--port", "/dev/ttyACM9", "--json"], {ESPTOOL_PYTHON: fake});
  assert.equal(refused.code, 6, refused.stderr);
  assert.equal(JSON.parse(refused.stderr.trim().split("\n").at(-1)).code, "needs_confirmation");
  assert.ok(!fs.existsSync(record), "nothing written without --yes");
  const r = await cli(["devices", "recover", "--port", "/dev/ttyACM9", "--yes", "--json"], {ESPTOOL_PYTHON: fake});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.restored, true);
  const [args, ...sizes] = fs.readFileSync(record, "utf8").trim().split("\n");
  assert.match(args, /^-m esptool --chip esp32s3 --port \/dev\/ttyACM9 --baud 921600 --before default_reset --after hard_reset write_flash --erase-all --flash_mode keep --flash_freq keep --flash_size keep 0x0 \S+0\.bin 0x170000 \S+1\.bin$/);
  assert.deepEqual(sizes.map(Number), [launcher.length, app.length]);
  const missing = await cli(["devices", "recover", "--port", "/dev/ttyACM9", "--yes", "--json"], {ESPTOOL_PYTHON: path.join(dir, "no-such-python"), PATH: "/nonexistent"});
  assert.equal(JSON.parse(missing.stderr.trim().split("\n").at(-1)).code, "esptool_missing");
});

test("devices recover: a download that is not the described file stops before anything", async () => {
  corrupt = true;
  try {
    const r = await cli(["devices", "recover", "--out", "bad", "--json"]);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").at(-1)).code, "sha_mismatch");
    assert.ok(!fs.existsSync(path.join(dir, "bad")));
  } finally { corrupt = false; }
  const other = await cli(["devices", "recover", "--target", "nullperator", "--json"]);
  assert.equal(JSON.parse(other.stderr.trim().split("\n").at(-1)).code, "not_for_target");
});
