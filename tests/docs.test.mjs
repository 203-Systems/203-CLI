// The skill and the documents: SKILL.md says what it is and when to use it and points at every product's page; every
// relative link in the Markdown resolves; package.json's files are what install.sh copies; and nothing in the
// repository is a secret, a private address or someone's e-mail (this repository is public).
// Run: node --test tests/docs.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ROOT} from "./fixtures.mjs";

const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const PRODUCTS = ["cardenza", "nullperator", "mystrix"];

// The repository's files (git's list when this is a checkout, else a walk without .git and node_modules).
function repositoryFiles() {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {cwd: ROOT, encoding: "utf8"});
  if (listed.status === 0 && listed.stdout.trim()) return listed.stdout.trim().split("\n").filter(file => fs.existsSync(path.join(ROOT, file)));
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk(".");
  return out.map(file => path.normalize(file));
}

test("SKILL.md names the skill, says when to use it and sends to each product's page", () => {
  const text = read("SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "YAML frontmatter");
  assert.match(front[1], /^name: 203-community$/m);
  const description = /^description: (.+)$/m.exec(front[1])[1];
  assert.ok(description.length < 1024, "a description under 1024 characters");
  for (const word of ["publish", "fork", "works", "models", "requests", "tracker", "check", "appeal", "device", "admin", "Cardenza", "NullPerator", "Mystrix"]) {
    assert.ok(description.includes(word), word);
  }
  for (const must of ["Always add `--json`", "doctor", "--dry-run", "Never guess a code", "next[0]", "| exit | meaning | do |", "fork CODE DIR",
    "203.json", "203c rules", "reference/parity.md", "## Products: what to read first"]) {
    assert.ok(text.includes(must), must);
  }
  for (const product of PRODUCTS) assert.ok(text.includes(`products/${product}/README.md`), product);
});

test("every product has its page, with the same parts", () => {
  for (const product of PRODUCTS) {
    const page = read(`products/${product}/README.md`);
    for (const part of ["## Publish", "## Hardware reference", "## Links", "203c publish", "--dry-run"]) assert.ok(page.includes(part), `${product}: ${part}`);
    assert.match(page, /\| \*\*`[a-z0-9]+`\*\*|Community device id: \*\*`[a-z0-9]+`\*\*/, `${product}: its community device id`);
  }
  const index = read("products/README.md");
  for (const product of PRODUCTS) assert.ok(index.includes(`(${product}/README.md)`), product);
});

test("relative links in the Markdown resolve", () => {
  const markdown = repositoryFiles().filter(file => file.endsWith(".md"));
  assert.ok(markdown.length >= 8);
  for (const file of markdown) {
    // Code (fenced or inline) is not a link; image:<id> names a firmware's own picture on the community.
    const text = read(file).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|image:|#)/.test(target)) continue;
      const resolved = path.join(ROOT, path.dirname(file), target.split("#")[0]);
      assert.ok(fs.existsSync(resolved), `${file}: ${target}`);
    }
  }
});

test("package.json's files are what is shipped, and install.sh installs them with a 203c command", {skip: process.platform === "win32" && "install.sh is a POSIX shell script (Windows: npm)"}, async () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(pkg.files, ["SKILL.md", "LICENSE", "scripts/", "reference/", "products/"]);
  assert.equal(pkg.bin["203c"], "scripts/203c.mjs");
  for (const item of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, item)), item);
  assert.match(read("install.sh"), /for item in SKILL\.md LICENSE scripts reference products; do/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "203c-install-"));
  const skills = path.join(home, "skills"), bin = path.join(home, "bin");
  const done = await new Promise(resolve => {
    const child = spawn("sh", [path.join(ROOT, "install.sh")], {env: {...process.env, CLAUDE_SKILLS_DIR: skills, COMMUNITY_BIN_DIR: bin}});
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    child.on("close", status => resolve({status, stderr}));
  });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(fs.existsSync(path.join(skills, "203-community/products/cardenza/README.md")));
  assert.ok(!fs.existsSync(path.join(skills, "203-community/tests")), "tests stay in the repository");
  assert.match(fs.readFileSync(path.join(bin, "203c"), "utf8"), /^#!\/bin\/sh\nexec node ".*203-community\/scripts\/203c\.mjs" "\$@"\n$/);
  assert.equal(spawnSync(path.join(bin, "203c"), ["--version"], {encoding: "utf8"}).stdout.trim(), pkg.version);
  fs.rmSync(home, {recursive: true, force: true});
});

// Secrets and private addresses: none, anywhere in the repository. Tests make stand-in tokens at run time, never as
// literals; the rules name token prefixes (ghp_, …) only as words.
test("no secrets, private addresses or e-mail addresses", () => {
  const patterns = [
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"], [/github_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
    [/\bcct_[0-9a-f]{64}\b/, "a community token"], [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key id"], [/\bsk-[A-Za-z0-9]{32,}/, "an API key"],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"], [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
    [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "a Tailscale address"],
    [/\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?:\d+/, "a LAN address"], [/\/home\/[a-z]+\//, "a home folder"], [/\/Users\/[a-z]+\//, "a home folder"],
    [/[A-Za-z0-9._%+-]+@(?!github\.com\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, "an e-mail address"],
  ];
  for (const file of repositoryFiles()) {
    if (/\.(png|jpe?g|webp|zip|bin|uf2)$/i.test(file)) continue;
    const text = read(file);
    for (const [pattern, what] of patterns) {
      const found = pattern.exec(text);
      assert.equal(found, null, `${file}: ${what} (${found?.[0]})`);
    }
    // Only public hosts: every web address, and every 203.io name, is one of these (loopback for 203c's own
    // sign-in and local servers; *.test in tests).
    for (const [, host] of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) {
      assert.ok(PUBLIC_HOSTS.has(host.toLowerCase()) || /\.test$/.test(host), `${file}: ${host} is not a known public host (add it to PUBLIC_HOSTS if it is one)`);
    }
    for (const [host] of text.matchAll(/\b[a-z0-9-]+\.203\.io\b/gi)) assert.ok(PUBLIC_HOSTS.has(host.toLowerCase()), `${file}: ${host}`);
  }
});

const PUBLIC_HOSTS = new Set(["203.io", "cardenza.203.io", "apps.203.io", "community.203.io", "matrix.203.io", "np-wiki.203.io", "dev.203.io",
  "github.com", "raw.githubusercontent.com", "docs.espressif.com", "dl.espressif.com", "emscripten.org", "nodejs.org",
  "matrix-os-keymap-editor.vercel.app", "www.npmjs.com", "registry.npmjs.org", "claude.ai", "code.claude.com", "127.0.0.1", "localhost"]);
