// 203c flash: install a firmware on a device over a USB cable through its 203 Launcher (线刷), as the website's
// 用 USB 线安装 does. No account, no binding and nothing to switch on (the user, 2026-11-18: "没有登录的情况下，可以使用
// 线刷模式。登录了之后，就可以使用WiFi控制、烧录等等"): the Launcher's console runs from power-on.
//   flash CODE        a firmware (its newest build for the device on --channel) or a version, by its code: the BIN
//                     downloaded (POST /versions/<VCODE>/download, counted; anyone may), checked against its SHA-256,
//                     with the community's signature after it, so the Launcher registers it as installed from the
//                     community and updates it later (COMMUNITY.md "Signed builds")
//   flash --bin FILE  a local application image (build/<project>.bin), checked as publish checks it
// The console (203-launcher src/serial_console.cpp) through launcher-usb.mjs, the site's launcher-usb.js (the same
// file: tests/cli-flash.test.mjs): `nav EscPress` and `version` until the Launcher answers (Esc stops its boot
// countdown), `account` for the device (an older Launcher: its version's suffix), then `flash firmware <name> <size>`,
// READY, 2 KB chunks each acknowledged, OK flashed (it restarts into the firmware).
// The port: --port, else the one USB serial port there is (/dev/ttyACM* on Linux, /dev/cu.usbmodem* on macOS). A device
// running a firmware on CardenzaHAL has none: it is restarted into its Launcher first (restart.mjs: its MIDI or HID; the
// user, 2026-11-18) and the port it comes back on is taken, held against the countdown of a HAL that restarts plainly
// (hold()); lost to that countdown, it is restarted once more. Node has no serial port API and 203c no dependencies: the
// tty is put in raw mode with stty and read and written as a file, so macOS and Linux only (Windows: the website).
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {LauncherConsole, LauncherError} from "./launcher-usb.mjs";
import {findFirmware, restartFirmware, waitForPort, HAL_COMMAND} from "./restart.mjs";
import {inspectBin, DEFAULT_TARGET} from "./checks.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {siteOf} from "./sim.mjs";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WEBSITE = "the firmware's page on the website, 用 USB 线安装 (Chrome or Edge on a computer)";

/** The name the Launcher keeps (ASCII letters, digits, . _ -; at most 48), as the site's installName. */
export const installName = (name, fallback = "firmware") =>
  String(name || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || fallback;

/** The device's target from a Launcher version such as 0.2.0-cardenza, or null. */
export const targetOfVersion = version => (/-(cardenza|nullperator|controller)$/i.exec(String(version || "")) || [])[1]?.toLowerCase() ?? null;

/** USB serial ports a 203 device shows up as (its native USB): /dev/ttyACM* on Linux, /dev/cu.usbmodem* on macOS. (C203_DEV:
 *  another /dev, for the tests.) */
export function listPorts(platform = process.platform, dev = process.env.C203_DEV || "/dev") {
  const pick = (dir, re) => { try { return fs.readdirSync(dir).filter(n => re.test(n)).sort().map(n => path.join(dir, n)); } catch { return []; } };
  if (platform === "darwin") return pick(dev, /^cu\.usbmodem/);
  if (platform === "linux") return pick(dev, /^ttyACM\d+$/);
  return [];
}

/**
 * A serial port as Web Serial has it ({readable, writable, close}) for LauncherConsole: the tty in raw mode (stty on
 * our own descriptor, so the setting holds while it is open), read through a non-blocking tty stream, written with
 * plain writes (retried while the device's buffer is full).
 */
export function openSerial(file) {
  const {O_RDWR, O_NOCTTY, O_NONBLOCK} = fs.constants;
  let out;
  try { out = fs.openSync(file, O_RDWR | O_NOCTTY | O_NONBLOCK); } catch (error) {
    throw new CliError("port_unavailable", `The port ${file} cannot be opened: ${error.code || error.message}`, {exit: EXIT.refused, field: "port",
      hint: error.code === "EACCES" ? "No permission: on Linux add yourself to the dialout group (sudo usermod -aG dialout $USER, then log in again)"
        : error.code === "EBUSY" ? "Another program has it open (a serial monitor, idf.py monitor, the website): close it" : "Plug the device in and check the port (203c flash --port …)"});
  }
  if (!tty.isatty(out)) { fs.closeSync(out); throw new CliError("port_unavailable", `${file} is not a serial port`, {exit: EXIT.refused, field: "port"}); }
  const raw = spawnSync("stty", ["raw", "-echo", "clocal"], {stdio: [out, "ignore", "pipe"], encoding: "utf8"});
  if (raw.status !== 0) {
    fs.closeSync(out);
    throw new CliError("port_unavailable", `The port ${file} cannot be set up (stty: ${String(raw.stderr || raw.error?.message || raw.status).trim()})`, {exit: EXIT.refused, field: "port"});
  }
  const input = new tty.ReadStream(fs.openSync(file, O_RDWR | O_NOCTTY | O_NONBLOCK));
  let closed = false;
  const readable = new ReadableStream({
    start(controller) {
      input.on("data", chunk => { if (!closed) controller.enqueue(new Uint8Array(chunk)); });
      const end = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* closed */ } } };
      input.on("end", end);
      input.on("error", end);   // the device restarted (EIO) or went away
    },
    cancel() { closed = true; input.destroy(); },
  });
  const writable = new WritableStream({
    async write(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      for (let at = 0; at < bytes.length;) {
        try { at += fs.writeSync(out, bytes, at, bytes.length - at); }
        catch (error) { if (error.code !== "EAGAIN") throw error; await sleep(2); }
      }
    },
  });
  return {
    readable, writable, path: file,
    async open() {},
    async close() { closed = true; input.destroy(); try { fs.closeSync(out); } catch { /* closed */ } },
  };
}

/** What went wrong over the cable, as a CliError with what to do. */
function cableError(error, ctx, port) {
  if (error instanceof CliError) return error;
  if (error instanceof LauncherError) {
    const again = [ctx.cmd()];
    if (error.code === "nolauncher") {
      return new CliError("no_launcher", `No 203 Launcher answered on ${port}`, {exit: EXIT.refused, next: again,
        hint: "Another device's port, or the device is in the Launcher's USB Drive mode: leave it (its home screen), or give the right --port; then run it again"});
    }
    if (error.code === "busy") return new CliError("launcher_busy", "The Launcher is busy in a menu", {exit: EXIT.later, next: again, hint: "Go back to its home screen, then run it again"});
    if (error.code === "timeout") return new CliError("device_timeout", "The device stopped answering", {exit: EXIT.later, next: again, hint: "Plug the USB cable in again, stay in the Launcher, then run it again"});
    if (error.code === "unsupported") return new CliError("launcher_old", "This Launcher cannot install over USB", {exit: EXIT.refused, hint: "Update the Launcher first (its home screen: Update Launcher)"});
    if (error.code === "full") {
      return new CliError("launcher_full", `No room on the device: ${error.detail}`, {exit: EXIT.refused, next: again,
        hint: "Delete what it names on the device (the Launcher's list of installed software) or other software you no longer use, then run it again"});
    }
    if (error.code === "invalid" && /launcher image/i.test(error.detail || "")) {
      return new CliError("launcher_image", "That is a 203 Launcher image, not a firmware: the Launcher is not installed this way", {exit: EXIT.refused, field: "bin",
        hint: "Give the firmware's own application image (build/<project>.bin); the Launcher updates itself (its home screen: Update Launcher)"});
    }
    return new CliError("install_refused", `The Launcher refused it: ${error.detail || error.code}`, {exit: EXIT.refused, next: again});
  }
  // The port itself (unplugged, or gone while it was written): what the system said.
  if (error && typeof error.code === "string" && /^E[A-Z]+$/.test(error.code) && error.syscall) {
    return new CliError("port_failed", `The serial port failed: ${error.code}`, {exit: EXIT.later, next: [ctx.cmd()],
      hint: "Plug the USB cable in again and run it again; or use " + WEBSITE});
  }
  return error;   // the API's refusal (ApiError) and anything else, as they are
}

// How a person puts the device in its Launcher by hand: a press of HOME opens the HAL's system menu (CardenzaHAL from
// 2026-11-18: a press, no hold; Cardenza Synth 0.2.1 and newer), whose Back to Launcher restarts into the Launcher's home
// screen; a firmware without that menu (released before it): FN held while plugging in keeps the Launcher in its menus.
const BY_HAND = "press HOME (the key left of the screen) and choose Back to Launcher (a firmware without that menu: hold FN while plugging it in)";

/**
 * A firmware running on the device (no Launcher port): restarted into its Launcher (or, `command` download, the ROM's
 * download mode) and the port it comes back on, or null when no such firmware is on USB. `want`: the port given.
 */
export async function restartToPort(ctx, {want = null, command = HAL_COMMAND.launcher, found = findFirmware()} = {}) {
  if (!found) return null;
  const into = command === HAL_COMMAND.download ? "the ROM's download mode" : "its Launcher";
  if (!found.candidates.length) {
    throw new CliError("firmware_unreachable", `${found.name} is running a firmware, and 203c finds neither its MIDI nor its HID`, {exit: EXIT.refused,
      hint: `Put it in its Launcher yourself: ${BY_HAND}; then run it again`});
  }
  const before = listPorts();
  ctx.say(`${found.name} is running a firmware: restarting it into ${into}…`);
  let sent;
  try { sent = await restartFirmware(found, command); } catch (error) {
    const tried = (error.tried || []).map(w => `${w.via}${w.path ? " " + w.path : ""}: ${w.error}`).join("; ");
    const denied = (error.tried || []).some(w => /EACCES|EPERM/.test(String(w.error)));
    throw new CliError("firmware_unreachable", `${found.name} is running a firmware and cannot be asked to restart (${tried || "no way to reach it"})`, {exit: EXIT.refused,
      hint: process.platform === "darwin" ? `203c needs python3 for CoreMIDI (xcode-select --install); or put it in its Launcher yourself: ${BY_HAND}`
        : denied ? `No permission for its MIDI or HID: add yourself to the audio group (sudo usermod -aG audio $USER, then log in again); or put it in its Launcher yourself: ${BY_HAND}`
          : `Close programs that hold its MIDI (a DAW); or put it in its Launcher yourself: ${BY_HAND}`,
      data: {tried: error.tried || []}});
  }
  if (sent.via !== "coremidi") ctx.say(`Sent over ${sent.via} (${sent.path})${sent.answered ? ": it is restarting" : ""}`);
  const port = await waitForPort(before, listPorts, {want});
  if (!port) {
    throw new CliError("no_launcher_port", `${found.name} was asked to restart, and no serial port came up`, {exit: EXIT.later, next: [ctx.cmd()],
      hint: sent.answered ? "Unplug the cable and plug it in again, then run it again" : `This firmware may not take the command: put the device in its Launcher yourself (${BY_HAND}), then run it again`});
  }
  return {port, name: found.name, via: sent.via};
}

/** Opens the port a restarted device came back on: the system may need a moment to give it its permissions. */
async function openSoon(port, ms = 3000) {
  for (const end = Date.now() + ms; ;) {
    try { return openSerial(port); } catch (error) {
      if (Date.now() >= end || !/EACCES|EBUSY|ENOENT|ENXIO/.test(String(error.message))) throw error;
      await sleep(100);
    }
  }
}

/** The community's build for the device: by a firmware's code (on the channel) or a version's code. */
async function communityImage(ctx, code, target, channel) {
  const what = await ctx.op("code", {code});
  const firmware = await ctx.op("firmware_show", {code: what.firmware || code});
  if (firmware.kind === "launcher") {
    throw new CliError("launcher_image", `${firmware.name} is a launcher: launchers are not installed through the Launcher`, {exit: EXIT.refused,
      hint: "The official 203 Launcher comes back with the recovery flash", next: [ctx.run(["devices", "recover", "--dry-run"])]});
  }
  let ref;
  if (what.kind === "version" && what.version) {
    const v = await ctx.op("version_show", {version_code: what.version});
    const file = (v.targets || []).find(x => x.target === target);
    if (!file) {
      throw new CliError("not_for_target", `${firmware.name} ${v.version} has no BIN for ${target}`, {exit: EXIT.refused, field: "target",
        hint: `It has: ${(v.targets || []).map(x => x.target).join(", ") || "none"}`});
    }
    if (file.format === "uf2") throw new CliError("download_only", `${target} takes a UF2 file, copied onto the device: there is no Launcher to install it`, {exit: EXIT.refused});
    ref = {code: v.code, version: v.version, channel: v.channel, size: file.size, sha256: file.sha256};
  } else {
    const builds = (firmware.builds || []).filter(b => b.target === target);
    const build = builds.find(b => b.channel === channel);
    if (!build) {
      throw new CliError("not_for_target", builds.length ? `${firmware.name} has no ${channel} build for ${target}` : `${firmware.name} has no build for ${target}`, {exit: EXIT.refused,
        field: builds.length ? "channel" : "target", hint: builds.length ? `Its lines for ${target}: ${builds.map(b => b.channel).join(", ")}` : `Its devices: ${[...new Set((firmware.builds || []).map(b => b.target))].join(", ") || "none"}`,
        next: builds.map(b => ctx.cmd({set: {channel: b.channel}}))});
    }
    if (build.format === "uf2") throw new CliError("download_only", `${target} takes a UF2 file, copied onto the device: there is no Launcher to install it`, {exit: EXIT.refused});
    ref = {code: build.version.code, version: build.version.version, channel: build.channel, size: build.size, sha256: build.sha256};
  }
  return {firmware, ref};
}

/** The bytes of a community build: downloaded, checked, with its signature trailer after the image. */
async function download(ctx, link, label) {
  ctx.say(`Downloading ${label} (${link.size} bytes)…`);
  const url = new URL(link.url, ctx.api + "/").href;
  const response = await ctx.client.fetch(url);
  if (!response.ok) throw new CliError("download_failed", `The download failed (HTTP ${response.status})`, {exit: EXIT.later, next: [ctx.cmd()]});
  const image = new Uint8Array(await response.arrayBuffer());
  if (link.sha256 && sha256(image) !== link.sha256) {
    throw new CliError("sha_mismatch", "The download is not the file the API describes (its SHA-256)", {exit: EXIT.later, hint: "A broken download or mirror: run it again", next: [ctx.cmd()]});
  }
  const trailer = link.trailer ? Buffer.from(link.trailer, "base64") : null;
  return trailer ? Buffer.concat([image, trailer]) : Buffer.from(image);
}

export async function flashDevice(ctx) {
  const o = ctx.flags;
  const code = ctx.args.CODE;
  if (!code === !o.bin) {
    throw ctx.usage(code ? "A code or --bin: one of them" : "What to install: a firmware's or version's code, or --bin FILE", {field: "bin",
      next: [ctx.run(["flash", "<CODE>"]), ctx.run(["flash", "--bin", "build/<project>.bin"])]});
  }
  const channel = o.channel || "stable";
  // The port: given (and there), else a running firmware restarted into its Launcher, else the one there is. A dry run
  // only says which it would be.
  let port = o.port ? String(o.port) : null;
  let restarted = null;
  const supported = ["linux", "darwin"].includes(process.platform);
  const firmware = (!port || !fs.existsSync(port)) && supported ? findFirmware() : null;
  if (!o.dry_run) {
    // Windows: Node has no serial port API (no native modules here), a COM port included: the website does it.
    if (!supported) {
      throw new CliError("unsupported_platform", "203c flash talks to the serial port on macOS and Linux", {exit: EXIT.refused,
        hint: o.bin ? `On Windows the website does it in Chrome or Edge: ${siteOf(ctx.api)}/firmware › Flash a local file (烧录本地固件), and choose ${o.bin}`
          : "On Windows use " + WEBSITE, data: {url: siteOf(ctx.api) + (o.bin ? "/firmware" : "/" + code)}});
    }
    if (firmware) {
      restarted = await restartToPort(ctx, {want: port, found: firmware});
      port = restarted.port;
    } else if (!port) {
      const ports = listPorts();
      if (ports.length !== 1) {
        throw new CliError(ports.length ? "port_ambiguous" : "port_not_found", ports.length ? `Several USB serial ports: ${ports.join(", ")}` : "No USB serial port and no device running a firmware: is the device plugged in and on?",
          {exit: EXIT.refused, field: "port", hint: ports.length ? "Say which with --port" : "Plug it in with a data cable (not a charging-only one) and turn it on (in its Launcher or running a firmware); then run it again or give --port",
            next: ports.length ? ports.map(p => ctx.cmd({set: {port: p}})) : [ctx.cmd()]});
      }
      port = ports[0];
    }
  }

  // The device: its Launcher answers first (so a community build is the one for that device).
  let dev = null;
  let launcher = null;
  let target = o.target || null;
  const lines = [];
  const close = async () => { if (dev) { const d = dev; dev = null; await d.close(); } };
  try {
    if (!o.dry_run) {
      ctx.say(`Looking for the 203 Launcher on ${port}…`);
      for (let attempt = 0; ; attempt++) {
        try {
          dev = new LauncherConsole(restarted ? await openSoon(port) : openSerial(port), line => lines.push(line));
          launcher = await dev.find();
          // Restarted plainly (a HAL from before 2026-11-18), the Launcher counts down to the firmware: Esc keeps it.
          if (restarted) await dev.hold();
          break;
        } catch (error) {
          await close();
          const lost = error instanceof LauncherError ? ["timeout", "nolauncher"].includes(error.code) : /EIO|ENXIO|ENODEV|ENOENT/.test(String(error.code || error.message));
          if (!restarted || !lost) throw error;
          // Lost to the countdown: once more when the firmware is back, then the person (HOME's menu, or FN held).
          let again = null;
          for (const end = Date.now() + 12000; !again && Date.now() < end;) { again = findFirmware(); if (!again) await sleep(200); }
          if (!again) throw error;   // no firmware came back: what the port or the Launcher said
          if (attempt > 0) {
            throw new CliError("launcher_countdown", `${restarted.name} restarted into its Launcher, which started the firmware again before 203c reached it`, {exit: EXIT.later, next: [ctx.cmd()],
              hint: "Put it in its Launcher yourself: press HOME (the key left of the screen) and choose Back to Launcher, then run it again. A firmware without that menu: hold FN, run it again, and let go of FN once the Launcher's menu shows (FN held while it restarts keeps the Launcher in its menus)"});
          }
          restarted = await restartToPort(ctx, {want: o.port ? String(o.port) : null, found: again});
          port = restarted.port;
        }
      }
      let found = null;
      try { found = await dev.account(); } catch (error) { if (!(error instanceof LauncherError) || !["unsupported", "busy"].includes(error.code)) throw error; }
      const says = (found && found.target) || targetOfVersion(launcher);
      if (target && says && says !== target) {
        throw new CliError("wrong_device", `The device on ${port} is a ${says}, not a ${target}`, {exit: EXIT.refused, field: "target", next: [ctx.cmd({remove: ["target"]})]});
      }
      target = target || says;
      ctx.say(`Launcher ${launcher}${target ? ` (${target})` : ""}`);
    }
    if (!target) {
      target = DEFAULT_TARGET;
      if (!o.dry_run) ctx.note(`the Launcher did not say which device it is: ${target} (--target says otherwise)`);
    }

    // What to write.
    let bytes = null, info;
    if (o.bin) {
      const file = ctx.path("bin");
      bytes = fs.readFileSync(file);
      const report = inspectBin(bytes, {target, file});
      if (report.kind !== "app") {
        const p = report.problems[0] || {message: `${path.basename(file)} is not an application image (${report.kind})`, hint: "Give build/<project>.bin"};
        throw new CliError("not_an_app", p.message, {exit: EXIT.refused, field: "bin", hint: p.hint});
      }
      const name = installName(o.name || report.project || path.basename(file).replace(/\.bin$/i, ""));
      info = {source: "file", file, name, size: bytes.length, sha256: sha256(bytes), project: report.project, version: report.version, signed: false};
    } else {
      const {firmware, ref: {size, sha256: sha, ...ref}} = await communityImage(ctx, code, target, channel);
      info = {source: "community", firmware: {code: firmware.code, name: firmware.name}, version: ref, name: installName(o.name || firmware.name, firmware.code),
        size, sha256: sha};
      // Downloaded (and counted) only to be written: the image, then the community's signature.
      if (!o.dry_run) {
        const link = await ctx.op("version_download", {version_code: ref.code, target});
        bytes = await download(ctx, link, `${firmware.name} ${ref.version}`);
        Object.assign(info, {size: link.size, sha256: link.sha256, signed: !!link.trailer, file_size: bytes.length});
      }
    }
    const what = info.source === "file" ? `${path.basename(info.file)}${info.version ? " " + info.version : ""}` : `${info.firmware.name} ${info.version.version} (${info.version.channel})`;
    if (o.dry_run) {
      return {json: {dry_run: true, target, port, ...(firmware ? {running: firmware.name, restart: true} : {}), ...info, next: [ctx.cmd({remove: ["dry-run"]})]},
        text: `Would install ${what} for ${target} as "${info.name}" (${info.size} bytes) over USB${port ? " on " + port : ""}. ` +
          (firmware ? `${firmware.name} is running a firmware: 203c restarts it into its Launcher first. ` : "") +
          "No account needed: the device only has to be on (in its Launcher or running a firmware) and on a USB cable."};
    }

    // Written: 2 KB at a time, each acknowledged; the Launcher installs it and restarts into it.
    let shown = -10;
    await dev.flash(info.name, bytes, (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct >= shown + 10 || sent === total) { shown = pct; ctx.say(`Writing ${pct}%`); }
    });
    // What the Launcher did with it (Launchers from 2026-11-18): replaced the installed copy of it, or into free space.
    const done = dev.installed;
    await close();
    const how = !done ? "" : done.replaced
      ? ` Replaced ${[done.old, done.old_version].filter(Boolean).join(" ")} → ${done.version || "?"}.`
      : " Installed into free space.";
    return {json: {status: "installed", target, port, launcher, ...(restarted ? {restarted: restarted.name} : {}), ...info,
        ...(done ? {installed: {how: done.replaced ? "replaced" : "free", name: done.name, version: done.version,
          ...(done.replaced ? {old: done.old, old_version: done.old_version} : {})}} : {})},
      text: `Installed ${what} on the ${target} on ${port}: the device restarts into it.${how}`};
  } catch (error) {
    const e = cableError(error, ctx, port);
    if (e instanceof CliError && lines.length && !e.data.console) e.data = {...e.data, console: lines.slice(-12).join("\n")};
    throw e;
  } finally {
    await close();
  }
}
