// 203cli's local checks (scripts/checks.mjs), made before anything is sent, the way the community's server and checker
// make them: codes, version labels, channels, tags, summaries, placeholders; BINs (the application image and every
// wrong file named for what it is; UF2 files for the download-only devices); covers, media and changelog entries.
// Run: node --test tests/checks.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import * as checks from "../scripts/checks.mjs";
import {encodePng} from "../scripts/stl.mjs";
import {appImage, mergedImage, uf2File} from "./fixtures.mjs";

test("codes, version labels, channels, tags, summaries, placeholders", () => {
  assert.deepEqual(checks.normalizeCode("k7m2-qx"), {code: "K7M2QX", changed: true});
  const zero = checks.normalizeCode("K0M2QX");
  assert.match(zero.hint, /never 0, 1, I or O/);
  assert.equal(checks.normalizeCode("CardenzaSynth").looksLikeName, true);
  assert.deepEqual(checks.versionLabel("v1.4.0"), {label: "1.4.0", notes: ["version v1.4.0 is published as 1.4.0 (labels have no leading v)"]});
  assert.equal(checks.versionLabel("1.4 beta").suggestion, "1.4-beta");
  assert.equal(checks.normalizeChannel("release").suggestion, "stable");
  assert.equal(checks.normalizeChannel("Nightly").suggestion, "dev");
  assert.equal(checks.normalizeChannel("rc").suggestion, "beta");
  assert.equal(checks.normalizeChannel("DEV").channel, "dev");
  assert.equal(checks.compareVersions("0.2.0", "0.10.0"), -1);
  assert.equal(checks.compareVersions("1.0.0", "1.0.0-rc1"), 1);
  assert.equal(checks.compareVersions("dev.3", "1.0"), null);
  assert.equal(checks.nextVersion("1.4.9"), "1.4.10");
  assert.equal(checks.versionsDisagree("1.4.0", "v1.4.0-3-gabc"), false);
  assert.equal(checks.versionsDisagree("1.5.0", "1.4.0"), true);
  assert.deepEqual(checks.normalizeTags("Groovebox, synth", 8).tags, ["groovebox", "synth"]);
  assert.match(checks.normalizeTags("official", 8).error, /admins/);
  assert.deepEqual(checks.normalizeTags("a,b,c,d,e,f", 5).fixed, ["a", "b", "c", "d", "e"]);
  const long = "The Cardenza groovebox: four tracks (drums, Juno, DX7, sampler), a 256-step sequencer, chords and arpeggiators per track";
  const short = checks.shorten(long, 100);
  assert.ok(short.length <= 100 && long.startsWith(short) && short.endsWith("sequencer"), short);
  assert.equal(checks.summaryRepeatsName("CardenzaSynth firmware", "CardenzaSynth"), true);
  assert.equal(checks.summaryRepeatsName("Cardenza Synth", "CardenzaSynth"), true);
  assert.equal(checks.summaryRepeatsName("Four-track groovebox", "CardenzaSynth"), false);
  for (const text of ["<one line: what it does>", "TODO", "…", "<https link to the source>"]) assert.equal(checks.isPlaceholder(text), true, text);
  assert.equal(checks.isPlaceholder("Fixes the arpeggiator"), false);
  assert.equal(checks.nearest("chanel", ["channel", "version"]), "channel");
  assert.equal(checks.nearest("zzzzzz", ["channel", "version"]), null);
});

test("BINs: the app image, and every wrong file named for what it is", async () => {
  const app = checks.inspectBin(await appImage({text: "CardenzaHAL/0.4.1+3f9c2ab"}), {file: "build/app.bin"});
  assert.equal(app.ok, true, JSON.stringify(app.problems));
  assert.deepEqual([app.kind, app.chip, app.version, app.hal.version], ["app", "esp32s3", "1.2.3", "0.4.1"]);
  assert.ok(app.budget.percent < 1);
  assert.deepEqual(checks.inspectBin(await appImage({text: "CardenzaHAL/0.4.1+unknown"})).hal, {version: "0.4.1", commit: "unknown"});
  assert.deepEqual(checks.inspectBin(await appImage({text: "x\0CardenzaHAL\0"})).hal, {version: null, commit: null});
  assert.equal(checks.inspectBin(await appImage()).warnings[0].code, "bin.no_hal");
  const code = bytes => checks.inspectBin(bytes).problems[0]?.code;
  assert.equal(code(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new Uint8Array(400)])), "bin.elf");
  assert.equal(code(new Uint8Array([0xaa, 0x50, ...new Uint8Array(3000)])), "bin.partition_table");
  const boot = new Uint8Array(20000); boot.set([0xe9, 3, 2, 0x20]); boot[12] = 9; boot[32] = 0x50;
  assert.equal(code(boot), "bin.bootloader");
  assert.equal(code(await mergedImage()), "bin.merged");
  assert.equal(checks.inspectBin(await mergedImage(), {firmwareKind: "launcher"}).ok, true);
  assert.equal(code(await appImage({digest: false, name: "x"}).then(b => { b[12] = 5; return b; })), "bin.wrong_chip");
  const broken = await appImage(); broken[100] ^= 1;
  assert.equal(code(broken), "bin.corrupt");
  assert.equal(code(new TextEncoder().encode("hello, not firmware at all ".repeat(20))), "bin.not_esp_image");
  assert.equal(code(await appImage({name: "launcher203"})), "bin.is_launcher");
  const huge = checks.inspectBin(await appImage({segment: 7 * 1024 * 1024}), {target: "cardenza"});
  assert.ok(huge.problems.some(p => p.code === "bin.too_large_for_device"));
  assert.equal(checks.inspectBin(await appImage({segment: 7 * 1024 * 1024}), {target: "nullperator"}).ok, true);
  // A download-only device (Mystrix): its UF2 file, and a .uf2 for the Cardenza named for what it is.
  const matrixOs = uf2File(await appImage({name: "MatrixOS"}));
  const mystrix = checks.inspectBin(matrixOs, {target: "mystrix", file: "MatrixOS.uf2"});
  assert.equal(mystrix.ok, true, JSON.stringify(mystrix.problems));
  assert.deepEqual([mystrix.kind, mystrix.chip, mystrix.project, mystrix.uf2.family_id], ["uf2", "esp32s3", "MatrixOS", "0xc47e5767"]);
  const viaTargets = {format: "uf2", name: "Mystrix", uf2: {family_id: "0xc47e5767", max_size: 4194304}};
  assert.equal(checks.inspectBin(matrixOs, {target: "mystrix", device: viaTargets}).ok, true);
  const uf2Code = (bytes, extra = {}) => checks.inspectBin(bytes, {target: "mystrix", ...extra}).problems[0]?.code;
  assert.equal(uf2Code(await appImage()), "bin.not_uf2");
  assert.equal(uf2Code(uf2File(await appImage(), {family: 0xbfdd4eee})), "bin.uf2_family");
  assert.equal(uf2Code(uf2File(await appImage(), {base: 0x10000})), "bin.uf2_no_app");
  assert.equal(uf2Code(matrixOs.subarray(0, 512)), "bin.uf2_broken");
  assert.equal(uf2Code(matrixOs, {firmwareKind: "launcher"}), "bin.launcher_uf2");
  assert.equal(uf2Code(matrixOs, {device: {...viaTargets, uf2: {...viaTargets.uf2, max_size: 256}}}), "bin.too_large_for_device");
  assert.equal(code(matrixOs), "bin.uf2");
  // Mystrix and Mystrix 2 (two devices): the other one's MatrixOS is named, with the flag that fits it.
  const forMystrix1 = uf2File(await appImage({name: "MatrixOS-Mystrix1"}));
  const swapped = checks.inspectBin(forMystrix1, {target: "mystrix2", file: "MatrixOS-Mystrix1.uf2"}).problems[0];
  assert.equal(swapped.code, "bin.uf2_other_device");
  assert.match(swapped.hint, /--bin mystrix=MatrixOS-Mystrix1\.uf2/);
  assert.equal(checks.inspectBin(forMystrix1, {target: "mystrix"}).ok, true);
});

test("covers and media from their first bytes; changelog entries", () => {
  const cover = checks.inspectCover(encodePng(1280, 720, new Uint8Array(1280 * 720 * 3)), "cover.png");
  assert.deepEqual([cover.ok, cover.mime, cover.width, cover.height, cover.warnings.length], [true, "image/png", 1280, 720, 0]);
  const square = checks.inspectCover(encodePng(300, 300, new Uint8Array(300 * 300 * 3)), "square.png");
  assert.deepEqual(square.warnings.map(w => w.code), ["cover.ratio", "cover.small"]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 2, 208, 5, 0, 3, 1, 0x22, 0]);
  assert.deepEqual(checks.imageInfo(jpeg), {mime: "image/jpeg", width: 1280, height: 720});
  assert.equal(checks.inspectCover(new TextEncoder().encode("<svg></svg>")).problems[0].code, "cover.type");
  assert.equal(checks.inspectWork(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "), "a.wav").ok, true);
  assert.equal(checks.inspectWork(new TextEncoder().encode("hello"), "a.mp3").problems[0].code, "work.content");
  const log = "# Changelog\n\n## [1.4.0] - 2026-11-14\n\n- Swing\n\n## 1.3.0\n\n- Older\n";
  assert.equal(checks.changelogEntry(log, "1.4.0"), "- Swing");
  assert.equal(checks.changelogEntry(log, "v1.3.0"), "- Older");
  assert.equal(checks.changelogEntry(log, "1.4"), null);
});
