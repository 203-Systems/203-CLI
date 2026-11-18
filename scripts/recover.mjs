// 203c devices recover: the website's recovery flash (恢复刷机, /recover) from a computer. The official
// 203 Launcher and the device's official firmware (GET /recovery), downloaded (POST /versions/<VCODE>/download,
// counted) and checked against the SHA-256 the API gives, laid out by recover-plan.mjs (the site's
// recover-plan.js, the same file: tests/recover-plan.test.mjs), then
//   --out DIR      saved: the images to write, plan.json and the esptool commands (flash.sh), nothing written;
//   --port PORT    written over USB with Espressif's esptool (Python: `python3 -m esptool`; Node has no serial
//                  port): erase the whole flash, write each image (esptool verifies each one's MD5), hard reset.
//                  It erases everything in the device's internal flash: --yes. A port that is not there while a
//                  firmware on CardenzaHAL runs (it has none): that firmware is restarted into the ROM's download mode
//                  first (restart.mjs, the HAL's command 0x42, as the website's /recover does over Web MIDI).
//   --dry-run      the plan only.
// Part of the Agent Skill skill/203-community.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {recoveryPlan, sha256Hex, describePlan, RecoveryError} from "./recover-plan.mjs";
import {CliError, EXIT} from "./guide.mjs";
import {restartToPort} from "./flash.mjs";
import {HAL_COMMAND} from "./restart.mjs";

const hexAddr = n => "0x" + n.toString(16);

/** The Python that has esptool (ESPTOOL_PYTHON, else python3, else python), or null. */
export function findEsptool(env = process.env) {
  for (const py of [env.ESPTOOL_PYTHON, "python3", "python"].filter(Boolean)) {
    const probe = spawnSync(py, ["-m", "esptool", "version"], {encoding: "utf8"});
    if (probe.status === 0) return {python: py, version: (probe.stdout.match(/\d+\.\d+(\.\d+)?/) || [""])[0]};
  }
  return null;
}

/**
 * The esptool command that writes a plan whose images are saved as `files` (one per write, in order): one
 * session, the whole chip erased first (--erase-all), the images' headers kept as they are, each image's
 * MD5 verified after writing (esptool does that by itself), then a hard reset into the Launcher.
 */
export function esptoolCommands(plan, files, port = "PORT") {
  return [["-m", "esptool", "--chip", "esp32s3", "--port", port, "--baud", "921600", "--before", "default_reset", "--after", "hard_reset",
    "write_flash", "--erase-all", "--flash_mode", "keep", "--flash_freq", "keep", "--flash_size", "keep",
    ...plan.writes.flatMap((w, i) => [hexAddr(w.address), files[i]])]];
}

export async function recoverDevice(ctx) {
  const o = ctx.flags;
  const target = o.target || "cardenza";
  if (o.port && o.out) throw ctx.usage("--port writes the device and --out saves the files: one of them", {field: "port"});
  const answer = await ctx.op("recovery", {});
  const item = (answer.items || []).find(x => x.target === target);
  if (!item) {
    throw new CliError("not_for_target", `No official Launcher for "${target}"`, {exit: EXIT.refused, field: "target",
      hint: `Devices with one: ${(answer.items || []).map(x => x.target).join(", ") || "none yet"}`,
      next: (answer.items || []).map(x => ctx.cmd({set: {target: x.target}}))});
  }
  const firmware = o.launcher_only ? [] : item.firmware;
  const download = async image => {
    ctx.say(`Downloading ${image.name} ${image.version} (${image.size} bytes)…`);
    const link = await ctx.op("version_download", {version_code: image.code, target});
    const response = await ctx.client.fetch(link.url);
    if (!response.ok) throw new CliError("download_failed", `The download of ${image.name} failed (HTTP ${response.status})`, {exit: EXIT.later, next: [ctx.cmd()]});
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha = await sha256Hex(bytes);
    if (sha !== image.sha256 || bytes.length !== image.size || (link.sha256 && link.sha256 !== sha)) {
      throw new CliError("sha_mismatch", `The downloaded ${image.name} is not the file the API describes (SHA-256 ${sha.slice(0, 12)}…, expected ${image.sha256.slice(0, 12)}…)`,
        {exit: EXIT.later, hint: "A broken download or mirror: run it again", next: [ctx.cmd()]});
    }
    return {image, bytes, sha};
  };
  const launcher = await download(item.launcher);
  const apps = [];
  for (const f of firmware) apps.push(await download(f));
  let plan;
  try {
    plan = recoveryPlan({target, launcher: {bytes: launcher.bytes, item: launcher.image}, apps: apps.map(a => ({bytes: a.bytes, item: a.image})),
      uuid: () => crypto.randomUUID()});
  } catch (error) {
    if (error instanceof RecoveryError) throw new CliError("recovery_plan", `These images cannot be laid out: ${error.code} ${error.message}`, {exit: EXIT.refused, data: {code: error.code, params: error.params}});
    throw error;
  }
  const summary = {
    target, flash_size: plan.flashSize, erase: "all",
    launcher: {name: item.launcher.name, version: item.launcher.version, code: item.launcher.code, sha256: launcher.sha, size: launcher.bytes.length},
    firmware: plan.apps.map((a, i) => ({name: a.name, version: a.version, code: firmware[i].code, app_id: a.app_id, partition: a.label, offset: a.offset, size: a.size,
      sha256: apps[i].sha, registered: a.registered})),
    writes: plan.writes.map(w => ({address: w.address, size: w.size, what: w.what, name: w.name, version: w.version})),
    partitions: plan.partitions.map(p => ({label: p.label, type: p.type, subtype: p.subtype, offset: p.offset, size: p.size})),
  };
  const lines = describePlan(plan);
  const warning = "This erases everything in the device's internal flash (installed firmware, Launcher settings, Wi-Fi, its sign-in); the SD card is not touched.";

  if (o.dry_run || (!o.port && !o.out)) {
    return {json: {...summary, dry_run: true, next: [ctx.cmd({add: {out: "recover"}, remove: ["dry-run"]}), ctx.cmd({add: {port: "PORT", yes: true}, remove: ["dry-run"]})]},
      text: [...lines, "", "Nothing written. Save the files with --out DIR, or write the device with --port PORT --yes (" + warning + ")"].join("\n")};
  }

  if (o.out) {
    const dir = path.resolve(ctx.cwd, String(o.out));
    fs.mkdirSync(dir, {recursive: true});
    const files = plan.writes.map((w, i) => (i === 0 ? `0x0-launcher-${item.launcher.version}-${target}.bin` : `${hexAddr(w.address)}-${w.label}-${w.version}.bin`));
    plan.writes.forEach((w, i) => fs.writeFileSync(path.join(dir, files[i]), w.data));
    const commands = esptoolCommands(plan, files).map(args => "python3 " + args.join(" "));
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({...summary, files}, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "flash.sh"), ["#!/bin/sh", "# 203 recovery flash: " + warning, "# Usage: sh flash.sh /dev/ttyACM0  (the device in download mode)", "set -e",
      'PORT="${1:?the serial port, e.g. /dev/ttyACM0 or COM5}"', 'cd "$(dirname "$0")"', ...commands.map(c => c.replace("--port PORT", '--port "$PORT"')), ""].join("\n"), {mode: 0o755});
    return {json: {...summary, out: dir, files, commands},
      text: [...lines, "", `Saved in ${dir}: ${files.join(", ")}, plan.json, flash.sh`, "Write them (" + warning + "):", ...commands.map(c => "  " + c)].join("\n")};
  }

  // --port: written now, with esptool.
  if (!o.yes) {
    throw new CliError("needs_confirmation", `devices recover --port ${o.port}: ${warning}`, {exit: EXIT.confirm, hint: "Add --yes only if the user asked for it",
      next: [ctx.cmd({add: {yes: true}})], data: summary});
  }
  const tool = findEsptool();
  if (!tool) {
    throw new CliError("esptool_missing", "esptool (Python) is not installed: it writes the device", {exit: EXIT.refused,
      hint: "pip install esptool (or set ESPTOOL_PYTHON to a Python that has it); or save the files with --out DIR and flash them another way",
      next: [ctx.cmd({remove: ["port", "yes"], add: {out: "recover"}})]});
  }
  // No such port while a firmware runs: restarted into the ROM's download mode, and the port it comes back on.
  let port = String(o.port);
  if (["linux", "darwin"].includes(process.platform) && port.startsWith("/") && !fs.existsSync(port)) {
    const back = await restartToPort(ctx, {want: port, command: HAL_COMMAND.download});
    if (back && back.port !== port) ctx.say(`The device came back on ${back.port}`);
    if (back) port = back.port;
  }
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "203c-recover-"));
  try {
    const files = plan.writes.map((w, i) => { const f = path.join(tmp, `${i}.bin`); fs.writeFileSync(f, w.data); return f; });
    for (const args of esptoolCommands(plan, files, port)) {
      ctx.say(`${tool.python} ${args.join(" ")}`);
      const run = spawnSync(tool.python, args, {stdio: ctx.json ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8"});
      if (run.status !== 0) {
        const tail = String((run.stderr || "") + (run.stdout || "")).trim().split("\n").slice(-6).join("\n");
        throw new CliError("flash_failed", `esptool stopped (${run.status ?? run.signal}): the device is not restored`, {exit: EXIT.refused,
          hint: "Put the device in download mode (in its Launcher esptool does it; a running CardenzaHAL firmware is restarted into it by 203c; else, Cardenza: hold HOME while plugging the USB cable in), check the cable and the port, then run it again. A device can always be restored again.",
          next: [ctx.cmd()], data: {log_tail: tail}});
      }
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  return {json: {...summary, port, restored: true},
    text: [...lines, "", `Restored: the device starts the official Launcher${plan.apps.length ? ` with ${plan.apps.map(a => a.name).join(", ")} installed` : ""}.`].join("\n")};
}
