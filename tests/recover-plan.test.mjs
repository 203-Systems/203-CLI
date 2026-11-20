// The recovery flash's plan (scripts/recover-plan.mjs, also the website's file): the exact offsets, images and erases; the partition
// table and the NVS image byte for byte as ESP-IDF's own tools write them (references made with
// gen_esp32part.py and nvs_partition_gen.py of ESP-IDF; the NVS ones again with 5.3.5 for this test's app id); the refusals. The plan
// was also booted in QEMU by the community's own tools. The website runs the same module.
// Run: node --test tests/recover-plan.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {recoveryPlan, assembleFlash, describePlan, buildPartitionTable, parsePartitionTable, nvsImage, md5Hex, crc32, sha256Hex,
  nextAppLabel, readMergedLauncher, registryRecord, RecoveryError} from "../scripts/recover-plan.mjs";
import {image, merged, CARDENZA} from "./fixtures.mjs";

const enc = s => new TextEncoder().encode(s);
const hexOf = b => Buffer.from(b).toString("hex");

const SYNTH = "5ca1ab1e-0203-4c1e-8d0e-000000000001";
const itemOf = async (bytes, extra = {}) => ({app_id: SYNTH, name: "Cardenza Synth", version: "0.2.0", build: 1, target: "cardenza",
  size: bytes.length, sha256: await sha256Hex(bytes), description: "鸣片的官方 groovebox 固件", ...extra});
let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;

test("checksums: MD5 and CRC-32 test vectors", () => {
  assert.equal(md5Hex(new Uint8Array(0)), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex(enc("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5Hex(enc("a".repeat(1000))), "cabe45dcc9ae5b66ba86600cca6b8ba8");
  assert.equal(crc32(enc("123456789")).toString(16), "cbf43926");
  assert.equal(crc32(enc("123456789"), 0xffffffff), 3523400311, "zlib.crc32(data, 0xFFFFFFFF), as ESP-IDF's NVS");
});

test("the partition table is gen_esp32part.py's, MD5 entry included", () => {
  const table = buildPartitionTable([...CARDENZA, {label: "carden", type: 0, subtype: 0x10, offset: 0x170000, size: 0x20000}]);
  assert.equal(hexOf(table.subarray(0, 192)),
    "aa50010200900000005000006e76730000000000000000000000000000000000aa50010000e00000002000006f74616461746100000000000000000000000000" +
    "aa50002000000100000015006170703000000000000000000000000000000000aa5001030000160000000100636f726564756d70000000000000000000000000" +
    "aa500010000017000000020063617264656e0000000000000000000000000000ebebfffffffffffffffffffffffffffff56ecb8b7174e61abc1cfc3031d4c17e");
  assert.ok(table.subarray(192).every(b => b === 0xff));
  assert.deepEqual(parsePartitionTable(table).entries.map(e => e.label), ["nvs", "otadata", "app0", "coredump", "carden"]);
  const broken = table.slice();
  broken[40] ^= 1;
  assert.throws(() => parsePartitionTable(broken), e => e.code === "table_md5");
});

test("the NVS image is nvs_partition_gen.py's (one page, and entries over two pages)", async () => {
  const record = JSON.stringify({schema: 2, id: SYNTH, target: "cardenza", name: "Cardenza Synth", description: "鸣片的官方 groovebox 固件",
    version: "0.2.0", build: 1, source: "catalog", image_sha256: "a".repeat(64), offset: 1507328, image_size: 1850768,
    backup_key: "00000000-0000-4000-8000-000000000001", spiffs: "", fat: []});
  assert.equal(await sha256Hex(nvsImage(0x5000, {l_apps_v2: {carden: record, mpe000: record.replace("carden", "x")}})),
    "654779e13d24232bf10f18ef8700218ea2676b58f031fcbbc58a85c4620ae1c7");
  const many = Object.fromEntries(Array.from({length: 10}, (_, i) => ["app" + i, record]));
  assert.equal(await sha256Hex(nvsImage(0x5000, {l_apps_v2: many, l_other: {short: "x"}})),
    "d90127beb3e3b80f827f532cfd840df7e7d603c7061ef49aeafeb13618c624f8");
  const more = Object.fromEntries(Array.from({length: 20}, (_, i) => ["app" + i, record]));
  assert.throws(() => nvsImage(0x3000, {l_apps_v2: more}), e => e.code === "nvs_full", "one page always stays free");
  assert.throws(() => nvsImage(0x5000, {l_apps_v2: {"a-label-too-long": "x"}}), e => e.code === "nvs_key");
});

test("Cardenza: erase everything, the Launcher at 0 with the new table and registry, the official firmware in its slot", async () => {
  const launcher = await merged();
  const app = await image({project: "CardenzaSynthFirmware", version: "0.2.0", size: 70000});
  const plan = recoveryPlan({target: "cardenza", launcher: {bytes: launcher, item: {name: "203 Launcher", version: "0.2.0", size: launcher.length}},
    apps: [{bytes: app, item: await itemOf(app)}], uuid: () => "00000000-0000-4000-8000-000000000001"});
  assert.equal(plan.erase, "all");
  assert.equal(plan.flashSize, 8 * 1024 * 1024);
  assert.deepEqual(plan.writes.map(w => [w.address, w.size, w.what]), [[0, launcher.length, "launcher"], [0x170000, app.length, "firmware"]]);
  assert.deepEqual(plan.partitions.map(p => [p.label, p.type, p.subtype, p.offset, p.size]), [
    ["nvs", 1, 2, 0x9000, 0x5000], ["otadata", 1, 0, 0xe000, 0x2000], ["app0", 0, 0x20, 0x10000, 0x150000],
    ["coredump", 1, 3, 0x160000, 0x10000], ["carden", 0, 0x10, 0x170000, 0x20000]]);
  assert.deepEqual(plan.apps, [{name: "Cardenza Synth", version: "0.2.0", app_id: SYNTH, label: "carden", offset: 0x170000, slot: 0x20000,
    size: app.length, registered: true}]);
  // The Launcher's own bytes are untouched outside the table and NVS; the firmware is written as downloaded.
  const base = plan.writes[0].data;
  assert.deepEqual(base.subarray(0, 0x8000), launcher.subarray(0, 0x8000));
  assert.deepEqual(base.subarray(0xe000), launcher.subarray(0xe000));
  assert.deepEqual(base.subarray(0x8000, 0x9000), buildPartitionTable(plan.partitions));
  assert.equal(plan.writes[1].data, app);
  // The registry: one record, as a catalog install writes it.
  const record = plan.registry[0].record;
  assert.equal(plan.registry[0].label, "carden");
  assert.deepEqual(Object.keys(record), ["schema", "id", "target", "name", "description", "version", "build", "source", "image_sha256", "offset",
    "image_size", "backup_key", "spiffs", "fat"]);
  assert.equal(record.source, "catalog");
  assert.equal(record.image_sha256, await sha256Hex(app));
  assert.equal(record.offset, 0x170000);
  assert.deepEqual(base.subarray(0x9000, 0xe000), nvsImage(0x5000, {l_apps_v2: {carden: JSON.stringify(record)}}));
  // The whole flash, as QEMU boots it.
  const flash = assembleFlash(plan);
  assert.equal(flash.length, 8 * 1024 * 1024);
  assert.deepEqual(flash.subarray(0x170000, 0x170000 + app.length), app);
  assert.ok(flash.subarray(0x170000 + app.length).every(b => b === 0xff));
  assert.deepEqual(describePlan(plan).slice(0, 3), ["erase: the whole flash (8 MB)",
    `write 0x000000 ${launcher.length} bytes: 203 Launcher 0.2.0`, `write 0x170000 ${app.length} bytes: Cardenza Synth 0.2.0 (partition carden)`]);
});

test("several official firmware: one slot after another, labels as the Launcher picks them", async () => {
  const launcher = await merged();
  const a = await image({project: "A", size: 70000});
  const b = await image({project: "B", size: 140000, fill: 9});
  const plan = recoveryPlan({target: "cardenza", launcher: {bytes: launcher, item: {}}, uuid,
    apps: [{bytes: a, item: await itemOf(a)}, {bytes: b, item: await itemOf(b, {name: "Cardenza MPE", app_id: "11111111-2222-4333-8444-555555555555"})}]});
  assert.deepEqual(plan.apps.map(x => [x.label, x.offset, x.slot]), [["carden", 0x170000, 0x20000], ["carde1", 0x190000, 0x30000]]);
  assert.deepEqual(plan.partitions.filter(p => p.type === 0 && p.subtype !== 0x20).map(p => p.subtype), [0x10, 0x11]);
  assert.equal(plan.registry.length, 2);
  assert.equal(nextAppLabel([], "!!!"), "app000");
  assert.equal(nextAppLabel([{label: "ab0000"}], "AB"), "ab0001");
});

test("Cardenza: a Launcher built for its 16 MB (after 0.3.3) gives the whole 16 MB, the layout unchanged", async () => {
  const launcher = await merged({flash: 0x4f});
  assert.equal(readMergedLauncher(launcher, "cardenza").flashMb, 16);
  const app = await image({size: 70000});
  const plan = recoveryPlan({target: "cardenza", launcher: {bytes: launcher, item: {}}, uuid, apps: [{bytes: app, item: await itemOf(app)}]});
  assert.equal(plan.flashSize, 16 * 1024 * 1024);
  assert.deepEqual(plan.apps.map(x => [x.label, x.offset]), [["carden", 0x170000]]);
  assert.equal(describePlan(plan)[0], "erase: the whole flash (16 MB)");
  assert.equal(assembleFlash(plan).length, 16 * 1024 * 1024);
});

test("NullPerator: its own layout from its Launcher's table, 16 MB", async () => {
  const table = [...CARDENZA.slice(0, 2), {label: "app0", type: 0, subtype: 0x20, offset: 0x10000, size: 0x180000},
    {label: "coredump", type: 1, subtype: 3, offset: 0x190000, size: 0x10000}];
  const launcher = await merged({board: "nullperator", table, flash: 0x4f});
  const app = await image({size: 5000});
  const plan = recoveryPlan({target: "nullperator", launcher: {bytes: launcher, item: {}}, uuid, apps: [{bytes: app, item: await itemOf(app, {target: "nullperator"})}]});
  assert.equal(plan.flashSize, 16 * 1024 * 1024);
  assert.equal(plan.apps[0].offset, 0x1a0000);
  assert.equal(plan.apps[0].registered, true);
  // Without official firmware: the Launcher alone, its table as it came.
  const alone = recoveryPlan({target: "nullperator", launcher: {bytes: launcher, item: {}}, uuid, apps: []});
  assert.deepEqual(alone.writes.map(w => w.address), [0]);
  assert.deepEqual(alone.writes[0].data, launcher);
});

test("refusals: another device's Launcher, not a merged image, sizes, no room, not an app", async () => {
  const launcher = await merged();
  const app = await image({size: 70000});
  const item = await itemOf(app);
  const plan = (o) => recoveryPlan({target: "cardenza", uuid, launcher: {bytes: launcher, item: {}}, apps: [{bytes: app, item}], ...o});
  const code = (fn, c) => assert.throws(fn, e => e instanceof RecoveryError && e.code === c, c);
  code(() => plan({target: "nullperator"}), "launcher_board");
  code(() => plan({launcher: {bytes: app, item: {}}}), "launcher_not_merged");
  code(() => plan({launcher: {bytes: launcher, item: {size: launcher.length + 1}}}), "size_differs");
  code(() => plan({apps: [{bytes: app, item: {...item, size: app.length - 1}}]}), "size_differs");
  code(() => plan({apps: [{bytes: app.subarray(0, 1000), item: {...item, size: 1000}}]}), "app_image");
  const launcherImage = await image({project: "launcher203", size: 4000});
  code(() => plan({apps: [{bytes: launcherImage, item: {...item, size: launcherImage.length}}]}), "app_is_launcher");
  const big = await image({size: 7 * 1024 * 1024});
  code(() => plan({apps: [{bytes: big, item: {...item, size: big.length}}]}), "no_space");
  assert.throws(() => readMergedLauncher(launcher, "nullperator"), e => e.code === "launcher_board");
});

test("a firmware the Launcher's catalog would not take is installed but not registered", async () => {
  const launcher = await merged();
  const app = await image({size: 70000});
  const plan = recoveryPlan({target: "cardenza", uuid, launcher: {bytes: launcher, item: {}}, apps: [{bytes: app, item: await itemOf(app, {build: 0})}]});
  assert.equal(plan.apps[0].registered, false);
  assert.equal(plan.registry.length, 0);
  assert.ok(plan.writes[0].data.subarray(0x9000, 0xe000).every(b => b === 0xff), "NVS left erased");
  // Long descriptions are cut to the Launcher's 160 bytes on a character boundary.
  const record = JSON.parse(registryRecord({...(await itemOf(app)), description: "音".repeat(100)}, {offset: 0x170000}, "cardenza", uuid()));
  assert.equal(record.description, "音".repeat(53));
});
