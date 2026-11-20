# 203c is renamed 203cli

**203c 已改名为 203cli，203c 不再更新也不再支持。请运行：**

```sh
npm install -g 203cli && 203cli skill install
npm uninstall -g 203c        # 然后可以卸载 203c
```

**203c is renamed 203cli; 203c gets no more updates or support. Run:**

```sh
npm install -g 203cli && 203cli skill install
npm uninstall -g 203c        # then you can remove 203c
```

[`203cli`](https://www.npmjs.com/package/203cli) is the 203 Systems firmware community's CLI and its Agent Skill
(source: [203-Systems/203-CLI](https://github.com/203-Systems/203-CLI)). Its commands, flags, JSON answers and exit codes
are 203c's: replace `203c` with `203cli` in scripts and CI.

This last version of `203c` exists so that nothing that still runs `203c` breaks: it installs `203cli` with it and runs
it with the same arguments, after printing the notice above on stderr (a `--json` answer on stdout stays JSON; in
GitHub Actions the notice is also a warning on the run). The exit code is 203cli's, or 1 when 203cli cannot be found.
