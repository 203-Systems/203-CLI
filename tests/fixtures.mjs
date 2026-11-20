// Test files for 203cli's tests: ESP32-S3 application images, a merged full-flash image, the 203 Launcher's merged
// image as esptool merge_bin makes it, UF2 files as Matrix OS's `make uf2` writes them, a stand-in API server and a
// way to run the CLI. Nothing here talks to the real community.
import {spawn} from "node:child_process";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildPartitionTable} from "../scripts/recover-plan.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "scripts/203cli.mjs");

const enc = s => new TextEncoder().encode(s);

// A valid ESP32-S3 application image (one segment, the checksum, the appended SHA-256 unless digest is false), its
// app description naming `name` and version 1.2.3, built with ESP-IDF v5.3.5; `text` is written into the segment
// (e.g. the CardenzaHAL marker "CardenzaHAL/0.4.1+3f9c2ab").
export async function appImage({segment = 256, digest = true, name = "testapp", fill = 0, text = null} = {}) {
  const end = (32 + segment + 16) & ~15;
  const image = new Uint8Array(end + (digest ? 32 : 0));
  const view = new DataView(image.buffer);
  image[0] = 0xe9; image[1] = 1; image[12] = 9; image[23] = digest ? 1 : 0;
  view.setUint32(28, segment, true); view.setUint32(32, 0xabcd5432, true);
  image.set(enc(name), 80);
  for (let i = 112; i < 32 + segment; i++) image[i] = (i * 7 + fill) & 255;
  image.set(enc("1.2.3"), 48);           // esp_app_desc_t.version
  image.set(enc("v5.3.5"), 144);         // esp_app_desc_t.idf_ver
  for (let i = 48 + 5; i < 80; i++) image[i] = 0;
  for (let i = 150; i < 176; i++) image[i] = 0;
  if (text) image.set(enc(text), 200);
  let checksum = 0xef;
  for (const b of image.subarray(32, 32 + segment)) checksum ^= b;
  image[end - 1] = checksum;
  if (digest) image.set(new Uint8Array(await crypto.subtle.digest("SHA-256", image.slice(0, end))), end);
  return image;
}

// A merged full-flash image (a bootloader image at 0, the partition table at 0x8000, the app at 0x10000): what a
// launcher's upload is, and the wrong file for an application.
export async function mergedImage({fill = 0, text = null} = {}) {
  const app = await appImage({fill, text, segment: 1024});
  const bytes = new Uint8Array(0x10000 + app.length).fill(0xff);
  bytes.set([0xe9, 3, 2, 0x20], 0);                  // bootloader image header, 4 MB flash
  bytes[12] = 9; bytes[13] = 0;                     // chip id: ESP32-S3
  const entry = (at, type, subtype, offset, size, label) => {
    const view = new DataView(bytes.buffer);
    bytes.set([0xaa, 0x50, type, subtype], at);
    view.setUint32(at + 4, offset, true); view.setUint32(at + 8, size, true);
    bytes.fill(0, at + 12, at + 32);
    bytes.set(enc(label), at + 12);
  };
  entry(0x8000, 1, 2, 0x9000, 0x5000, "nvs");
  entry(0x8020, 0, 0, 0x10000, 0x200000, "factory");
  bytes.set(app, 0x10000);
  return bytes;
}

// A UF2 file as Matrix OS's `make uf2` writes one (uf2conv.py -f <family> -b 0x0): 256 bytes of `data` a block.
export function uf2File(data, {family = 0xc47e5767, base = 0, payload = 256, flags = null} = {}) {
  const n = Math.ceil(data.length / payload);
  const out = new Uint8Array(n * 512);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const at = i * 512;
    view.setUint32(at, 0x0a324655, true); view.setUint32(at + 4, 0x9e5d5157, true);
    view.setUint32(at + 8, flags ?? (family === null ? 0 : 0x2000), true);
    view.setUint32(at + 12, base + i * payload, true); view.setUint32(at + 16, payload, true);
    view.setUint32(at + 20, i, true); view.setUint32(at + 24, n, true); view.setUint32(at + 28, family ?? 0, true);
    out.set(data.subarray(i * payload, (i + 1) * payload), at + 32);
    view.setUint32(at + 508, 0x0ab16f30, true);
  }
  return out;
}

// For the recovery flash: a valid ESP32-S3 application image of about `size` bytes (one segment, the checksum, the
// appended SHA-256), with this project name, version and flash byte.
export async function image({project = "testapp", version = "1.0.0", size = 4096, flash = 0x3f, fill = 1} = {}) {
  const segment = Math.max(256, size - 32 - 16 - 32);
  const end = (32 + segment + 16) & ~15;
  const out = new Uint8Array(end + 32);
  const view = new DataView(out.buffer);
  out[0] = 0xe9; out[1] = 1; out[3] = flash; out[12] = 9; out[23] = 1;
  view.setUint32(28, segment, true);
  for (let i = 32; i < 32 + segment; i++) out[i] = (i * 13 + fill) & 255;
  view.setUint32(32, 0xabcd5432, true);
  out.fill(0, 48, 176);
  out.set(enc(version), 48);
  out.set(enc(project), 80);
  out.set(enc("v5.5.1"), 144);
  let checksum = 0xef;
  for (const b of out.subarray(32, 32 + segment)) checksum ^= b;
  out[end - 1] = checksum;
  out.set(new Uint8Array(await crypto.subtle.digest("SHA-256", out.slice(0, end))), end);
  return out;
}

// The 203 Launcher's partition table on a Cardenza (the HAL's board/partitions.csv keeps the same regions).
export const CARDENZA = [
  {label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x5000},
  {label: "otadata", type: 1, subtype: 0, offset: 0xe000, size: 0x2000},
  {label: "app0", type: 0, subtype: 0x20, offset: 0x10000, size: 0x150000},
  {label: "coredump", type: 1, subtype: 3, offset: 0x160000, size: 0x10000},
];

// The official Launcher's merged image as esptool merge_bin makes it: the bootloader (8 MB in its header),
// the table, otadata (erased), the Launcher (its descriptor names the board).
export async function merged({board = "cardenza", table = CARDENZA, flash = 0x3f} = {}) {
  const boot = await image({project: "", version: "", size: 20000, flash});
  boot.fill(0, 32, 36);   // the bootloader has no app descriptor
  const launcher = await image({project: "launcher203", version: "0.2.0-" + board, size: 300000, fill: 5});
  const out = new Uint8Array(0x10000 + launcher.length).fill(0xff);
  out.set(boot, 0);
  out.set(buildPartitionTable(table), 0x8000);
  out.set(launcher, 0x10000);
  return out;
}

// A stand-in API on 127.0.0.1: `routes(req, send, body)` answers or returns false (then 404 not_found, as the API
// answers). Resolves to {api, requests, close}; `api` is the base 203cli takes with --api.
export async function standInApi(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({method: req.method, url: req.url, auth: req.headers.authorization || null, body});
      const send = (status, data, type = "application/json") => {
        res.writeHead(status, {"content-type": type});
        res.end(type === "application/json" ? JSON.stringify(data) : data);
      };
      if (await routes(req, send, body, Buffer.concat(chunks)) === false) send(404, {error: "Not found", code: "not_found"});
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {api: `http://127.0.0.1:${server.address().port}/api`, requests, close: () => new Promise(resolve => server.close(resolve))};
}

// The update notices off (C203_NO_UPDATE_CHECK) and, should a test turn them on, never asking npm or GitHub: for every
// 203cli a test runs (updates.test.mjs turns them on with stand-ins).
export const NO_UPDATES = {C203_NO_UPDATE_CHECK: "1", NO_UPDATE_NOTIFIER: "", C203_NPM_REGISTRY: "http://127.0.0.1:9", C203_GITHUB_API: "http://127.0.0.1:9"};

// Runs 203cli with these arguments: {code, stdout, stderr, json (stdout parsed), error (stderr's last line parsed)}.
export function run(args, {cwd = ROOT, env = {}} = {}) {
  return new Promise(resolve => {
    // Not in an agent's sandbox unless a test says so (203cli reads these to explain a blocked network).
    const child = spawn(process.execPath, [CLI, ...args], {cwd, env: {...process.env, COMMUNITY_TOKEN: "", COMMUNITY_API: "", COMMUNITY_LANG: "",
      LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8", CLAUDE_CODE_REMOTE: "", CODEX_SANDBOX_NETWORK_DISABLED: "", ...NO_UPDATES, ...env}});
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => {
      let json = null, error = null;
      try { json = JSON.parse(stdout); } catch { /* text */ }
      try { error = JSON.parse(stderr.trim().split("\n").pop()); } catch { /* text */ }
      resolve({code, stdout, stderr, json, error});
    });
  });
}
