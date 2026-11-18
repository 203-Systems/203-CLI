// reference/firmware-project.md is CardenzaHAL's docs/FIRMWARE-PROJECT.md, the one source of the firmware project
// rules (203c rules prints this copy, offline). This copies it in when the HAL's file changes:
//   node tools/sync-rules.mjs                 from GitHub (CardenzaHAL's main)
//   node tools/sync-rules.mjs --hal DIR       from a CardenzaHAL checkout (its working tree)
//   node tools/sync-rules.mjs --check         exit 1 when the copy differs from GitHub's (CI runs it)
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPY = path.join(ROOT, "reference/firmware-project.md");
const RULES = "docs/FIRMWARE-PROJECT.md";
const URL_MAIN = `https://raw.githubusercontent.com/203-Systems/CardenzaHAL/main/${RULES}`;

async function source(args) {
  const at = args.indexOf("--hal");
  if (at >= 0) {
    const file = path.resolve(args[at + 1] ?? "", RULES);
    if (!fs.existsSync(file)) throw new Error(`No ${RULES} in ${args[at + 1]}`);
    return {text: fs.readFileSync(file, "utf8"), from: file};
  }
  const response = await fetch(URL_MAIN);
  if (!response.ok) throw new Error(`${URL_MAIN}: HTTP ${response.status}`);
  return {text: await response.text(), from: URL_MAIN};
}

const args = process.argv.slice(2);
try {
  const {text, from} = await source(args);
  if (!/^# /.test(text)) throw new Error(`${from} is not the rules file`);
  const current = fs.existsSync(COPY) ? fs.readFileSync(COPY, "utf8") : "";
  if (args.includes("--check")) {
    if (current !== text) {
      console.error(`reference/firmware-project.md differs from ${from}: run node tools/sync-rules.mjs, commit, and pin the new commit in the community`);
      process.exit(1);
    }
    console.log(`reference/firmware-project.md is ${from}`);
  } else if (current === text) {
    console.log(`reference/firmware-project.md is already ${from}`);
  } else {
    fs.writeFileSync(COPY, text);
    console.log(`copied ${from} (${text.length} bytes) to reference/firmware-project.md`);
  }
} catch (error) {
  console.error("sync-rules: " + error.message);
  process.exit(2);
}
