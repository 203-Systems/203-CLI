// The 203 Launcher's USB console as 203c and the website speak it (scripts/launcher-usb.mjs; binding and sending over a
// USB cable): `account` read, `account bind` written with its fields percent-encoded, `flash firmware` in acknowledged
// 2 KB chunks, refusals as codes; against the demo Launcher on a fake port (what ?usb=demo uses on the pages).
// Run: node --test tests/launcher-usb.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {LauncherConsole, LauncherError, demoPort, parseAccount, parseInstalled, pct, unpct} from "../scripts/launcher-usb.mjs";

const open = async (options = {}) => {
  const port = demoPort({pace: 50, ...options});
  await port.open({baudRate: 115200});
  const seen = [];
  return {port, seen, dev: new LauncherConsole(port, (line) => seen.push(line))};
};

// A file as the website sends it: an image (its first byte 0xE9) and the community's trailer after it.
function signedFile(statement, imageSize = 5000) {
  const image = new Uint8Array(imageSize).fill(7);
  image[0] = 0xe9;
  const text = new TextEncoder().encode(JSON.stringify(statement));
  const total = Math.ceil((88 + text.length + 16) / 16) * 16;
  const trailer = new Uint8Array(total);
  const view = new DataView(trailer.buffer);
  const magic = new TextEncoder().encode("203SIGN1");
  trailer.set(magic, 0); view.setUint32(8, total, true); view.setUint16(12, text.length, true); trailer[14] = 1;
  trailer.set(text, 88);
  view.setUint32(total - 16, total, true); trailer.set(magic, total - 8);
  const file = new Uint8Array(image.length + total);
  file.set(image); file.set(trailer, image.length);
  return file;
}

test("the account line: bound or not, its fields percent-decoded, - for what it has not", () => {
  assert.deepEqual(parseAccount("ACCOUNT bound=0 device_id=A0B1C2D3E4F5 target=cardenza version=0.3.0-cardenza user_id=- user_name=- api=-"),
    {bound: false, device_id: "a0b1c2d3e4f5", target: "cardenza", version: "0.3.0-cardenza", user_id: null, user_name: null, api: null});
  assert.deepEqual(parseAccount("ACCOUNT bound=1 device_id=a0b1c2d3e4f5 target=cardenza version=0.3.0 user_id=b3nwu7xk user_name=%E9%B8%A3%E7%89%87%20fan api=https%3A//community.203.io/api"),
    {bound: true, device_id: "a0b1c2d3e4f5", target: "cardenza", version: "0.3.0", user_id: "b3nwu7xk", user_name: "鸣片 fan", api: "https://community.203.io/api"});
  assert.equal(parseAccount("ACCOUNT bound=1 device_id=xyz"), null);
  assert.equal(parseAccount("Launcher 0.3.0"), null);
  assert.equal(pct("Ann Lee/鸣片 (2)"), "Ann%20Lee/%E9%B8%A3%E7%89%87%20%282%29");
  assert.equal(unpct(pct("https://cardenza.203.io/community/api")), "https://cardenza.203.io/community/api");
  assert.equal(unpct("%E9%B8"), null);
});

test("find, account, bind: what the website writes is what the device then says", async () => {
  const {dev, seen, port} = await open({id: "a0b1c2d3e4f5"});
  assert.equal(await dev.find(), "0.3.0-cardenza");
  assert.deepEqual(await dev.account(), {bound: false, device_id: "a0b1c2d3e4f5", target: "cardenza", version: "0.3.0-cardenza",
    user_id: null, user_name: null, api: null});
  const token = "ccd_" + "ab".repeat(32);
  await dev.bind({token, user_id: "p8cf59e5", user_name: "Mika Lee", api: "https://cardenza.203.io/community/api"});
  // The fields percent-encoded; the token goes to the device but never into the log.
  assert.ok(seen.includes("> account bind ccd_… p8cf59e5 Mika%20Lee https%3A//cardenza.203.io/community/api"), seen.join("\n"));
  assert.ok(!seen.some((line) => line.includes(token)));
  const after = await dev.account();
  assert.deepEqual([after.bound, after.user_id, after.user_name, after.api], [true, "p8cf59e5", "Mika Lee", "https://cardenza.203.io/community/api"]);
  // Fields the Launcher refuses: ERR invalid, as a code.
  await assert.rejects(dev.bind({token: "ccd_short", user_id: "p8cf59e5", user_name: "x", api: "https://a.test/api"}),
    (e) => e instanceof LauncherError && e.code === "invalid" && /token/.test(e.detail));
  await assert.rejects(dev.bind({token, user_id: "NOPE", user_name: "x", api: "https://a.test/api"}), (e) => e.code === "invalid");
  await dev.unbind();
  assert.equal((await dev.account()).bound, false);
  assert.equal(port.state.device_id, "a0b1c2d3e4f5");
  await dev.close();
});

test("flash firmware: acknowledged chunks, progress, and a signed file registered as a community install", async () => {
  const {dev, port} = await open();
  await dev.find();
  const file = signedFile({type: "203.build", v: 1, kind: "app", target: "cardenza", name: "Cardenza Synth", version: "0.2.0", code: "Q2W7EA"}, 9000);
  const seen = [];
  const end = await dev.flash("Cardenza_Synth", file, (sent, total) => seen.push([sent, total]));
  assert.equal(end, "OK flashed, rebooting");
  const want = [];
  for (let sent = 2048; sent < file.length; sent += 2048) want.push(sent);
  assert.deepEqual(seen, [...want, file.length].map((sent) => [sent, file.length]), "one ACK a 2 KB chunk");
  assert.deepEqual(port.state.apps.at(-1), {name: "Cardenza_Synth", size: file.length, community: true, code: "Q2W7EA", claim: null, version: "0.2.0"},
    "no app ID or firmware code in its statement: no claim");
  assert.deepEqual(dev.installed, {replaced: false, name: "Cardenza_Synth", version: "0.2.0", old: null, old_version: null}, "INSTALLED free");
  // Without a trailer: an import.
  const plain = new Uint8Array(3000).fill(1); plain[0] = 0xe9;
  await dev.flash("Plain", plain);
  assert.equal(port.state.apps.at(-1).community, false);
  // Not an image: refused after the bytes.
  await assert.rejects(dev.flash("Junk", new Uint8Array(100)), (e) => e.code === "refused" && /image/.test(e.detail));
  await dev.close();
});

test("flash firmware: the trailer's app ID claims the firmware, its installed copy is replaced (INSTALLED), no room is ERR full", async () => {
  const {dev, port, seen} = await open();
  await dev.find();
  const v1 = signedFile({type: "203.build", v: 1, kind: "app", target: "cardenza", name: "Glide", version: "0.1.0", firmware: "G1D2E3",
    app_id: "5b0c6a8e-2f1d-4c3b-9a7e-1d2c3b4a5f60"}, 4000);
  await dev.flash("Glide", v1);
  assert.ok(seen.includes(`> flash firmware Glide ${v1.length} 5b0c6a8e-2f1d-4c3b-9a7e-1d2c3b4a5f60`), seen.join("\n"));
  const v2 = signedFile({type: "203.build", v: 1, kind: "app", target: "cardenza", name: "Glide", version: "0.2.0", code: "G1D2E4",
    app_id: "5b0c6a8e-2f1d-4c3b-9a7e-1d2c3b4a5f60"}, 4000);
  assert.equal(await dev.flash("Glide_2", v2), "OK flashed, rebooting");
  assert.deepEqual(dev.installed, {replaced: true, name: "Glide_2", version: "0.2.0", old: "Glide", old_version: "0.1.0"});
  assert.deepEqual(port.state.apps.map((a) => a.version), ["0.2.0"], "one copy");
  // A plain image: no claim (the Launcher matches the name and the project).
  const plain = new Uint8Array(3000).fill(1); plain[0] = 0xe9;
  await dev.flash("Plain", plain);
  assert.ok(seen.includes("> flash firmware Plain 3000"));
  await dev.close();

  const full = await open({mode: "full"});
  await full.dev.find();
  await assert.rejects(full.dev.flash("Big", v1), (e) => e instanceof LauncherError && e.code === "full" && /Delete Old Synth 0\.1\.0/.test(e.detail));
  await full.dev.close();
  assert.equal(parseInstalled("INSTALLED free name=Pocket%20Metronome version=0.1.0").name, "Pocket Metronome");
  assert.equal(parseInstalled("OK flashed, rebooting"), null);
});

test("a Launcher slow to answer: asked again, and what is left over from that is no command's answer", async () => {
  const {dev, port, seen} = await open({slow: 1500});
  assert.equal(await dev.find(), "0.3.0-cardenza");
  assert.equal(seen.filter((l) => l === "> version").length, 2, "asked twice");
  // Left over: the second `OK nav EscPress` and `Launcher …`; account and flash still read their own answers.
  assert.equal((await dev.account()).device_id, port.state.device_id);
  const file = new Uint8Array(3000).fill(2); file[0] = 0xe9;
  assert.equal(await dev.flash("Slow", file), "OK flashed, rebooting");
  await dev.close();
});

test("away from the home screen, and a Launcher without the account commands", async () => {
  const busy = await open({mode: "busy"});
  await busy.dev.find();
  await assert.rejects(busy.dev.account(), (e) => e.code === "busy");
  await assert.rejects(busy.dev.flash("x", new Uint8Array([0xe9, 1, 2])), (e) => e.code === "busy");
  await busy.dev.close();
  const old = await open({mode: "old"});
  await old.dev.find();
  await assert.rejects(old.dev.account(), (e) => e.code === "unsupported");
  await old.dev.close();
  const other = await open({mode: "other"});
  const account = await other.dev.account();
  assert.deepEqual([account.bound, account.user_name], [true, "Ben Wu"]);
  await other.dev.close();
});
