#!/usr/bin/env node
// The last 203c (the user, 2026-11-20): 203c is renamed 203cli, the 203 community's only CLI. Whatever runs `203c …` keeps
// working (scripts, CI, an old firmware's pipeline): the notice on stderr (and in GitHub Actions a warning), then 203cli
// itself, in this process, with the same arguments, environment, output and exit code; the commands it prints say
// `203c …` (C203_RUN_AS), which is what is installed here. 203cli comes with this package (its dependency); without it,
// the notice and exit 1.
import {pathToFileURL} from "node:url";
import {MISSING_EN, MISSING_ZH, findCli, sayRenamed} from "./lib.mjs";

sayRenamed();
const found = findCli();
if (!found) {
  process.stderr.write(`${MISSING_ZH}\n${MISSING_EN}\n`);
  process.exitCode = 1;
} else {
  process.env.C203_RUN_AS = "203c";
  await import(pathToFileURL(found.file).href);
}
