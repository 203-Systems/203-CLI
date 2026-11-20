#!/usr/bin/env node
// The old name's script, kept so that nothing that runs it breaks: 203c is renamed 203cli (rename.mjs). Scripts, CI steps
// and agents that run `node …/203-community/scripts/203c.mjs` (CardenzaHAL's community-publish action at older commits,
// the 203c command an older install.sh wrote, CardenzaHAL's build check) get the notice on stderr, then 203cli itself, in
// this process: the same arguments, environment, output and exit code. New ones run scripts/203cli.mjs.
import {sayRenamed} from "./rename.mjs";

sayRenamed();
await import("./203cli.mjs");
