# pi-fast-tools

Fewer and faster tool calls for [Pi](https://pi.dev).

In long coding sessions most of the wall time goes to two things: the model taking one small step per turn (one grep, one read, one test), and slow or hung shell commands. This extension attacks both.

## What it does

### 1. Guards model-issued `bash` calls

| Command | Rewrite | Why |
|---|---|---|
| `grep -r` / `-R` / `egrep -r` / `command grep -r` | adds `--exclude-dir=` for `node_modules`, `.git`, `.next`, `.turbo`, `.worktrees`, `dist`, `build`, `out`, `coverage`, `storybook-static`, `.venv`, `__pycache__` | same results without walking dependencies and build output (4.5 s → 0.8 s on a large Next.js repo) |
| `vitest`, `jest`, `bun test`, `tsc`, `eslint`, `pytest`, `playwright test`, `next build`, `npm/pnpm/yarn/bun run build\|test\|lint\|typecheck`, `verify*.mjs` | sets bash `timeout` to 600 s | a hung test run cannot block the session |
| `tsc` / `tsgo` | prefixes `NODE_OPTIONS=--max-old-space-size=8192` | large projects abort on the default heap |

Your explicit choices always win: an existing `timeout`, `NODE_OPTIONS`, or `--exclude-dir` is never overridden. A grep that targets an excluded directory on purpose (`grep -r x node_modules/next`) is left alone. Dev servers and watchers (`nohup`, `next dev`, `vite`, `--watch`, `-w`, trailing `&`) never get a timeout.

`grep` is deliberately **not** rewritten to `rg`. Their flags differ (`-r`, `-E`, `--include`), and a silent mistranslation would return wrong results.

### 2. Adds tool-speed rules to the system prompt

A `<tool_speed>` section tells the model to:

- batch independent reads and searches in one message (parallel tool calls)
- use `codemode` for fan-out when it is active
- search with `rg` / `fd` instead of `grep -r` / `find`
- read with `read` + `offset`/`limit` instead of repeated `sed -n` / `cat`
- run only the tests the change touches, with a timeout and filtered output
- run full typechecks once at the end, and long-lived processes in the background

Lines that name a tool only appear when that tool is active.

The section opens by deferring to project instructions: when a repo's `AGENTS.md` / `CLAUDE.md` forbids running tests without permission, or requires build/lint/typecheck through a specific subagent or command, the model follows the project instead of these generic rules.

### 3. Optionally enables `codemode`

Pi's built-in [`codemode`](https://pi.dev) tool lets the model run many tool calls from one script in parallel and return only a filtered result. Turn it on with `fastTools.codemode: true`, or natively with `"defaultTools": ["+codemode"]`.

## Install

```bash
pi install npm:@fahrizkyputra/pi-fast-tools
```

Then `/reload` in a running session, or start a new one. Guard and rules are on right away; codemode is off until you turn it on.

## Commands

```
/fast-tools                 show the effective configuration
/fast-tools status          same
/fast-tools codemode-on     activate codemode now and save fastTools.codemode: true
/fast-tools codemode-off    deactivate codemode now and save fastTools.codemode: false
/fast-tools guard-on|off    bash rewrites (grep excludes, timeout, tsc heap)
/fast-tools rules-on|off    the <tool_speed> prompt section
```

Toggles apply to the next tool call or model request without a reload, and are saved to the user settings file (`~/.pi/agent/settings.json`) so new sessions start the same way. Only `fastTools.<key>` is written; every other setting is kept. Tab completes the arguments.

Two things can still override a saved toggle in new sessions, and the command tells you when it sees them:

- a project `.pi/settings.json` with its own `fastTools` value;
- `"defaultTools": ["+codemode"]`, which turns codemode on regardless of `fastTools.codemode`. Remove it if you want `codemode-off` to stick.

## Configure

All keys are optional. Put them in `~/.pi/agent/settings.json`, or in a project's `.pi/settings.json` to override them for that project.

```json
{
  "fastTools": {
    "guard": true,
    "rules": true,
    "codemode": false,
    "timeoutSeconds": 600,
    "tscHeapMb": 8192,
    "extraExcludeDirs": ["vendor"]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `guard` | `true` | rewrite bash calls (section 1) |
| `rules` | `true` | add the `<tool_speed>` prompt section |
| `codemode` | `false` | activate `codemode` at session start |
| `timeoutSeconds` | `600` | automatic timeout; `0` disables it |
| `tscHeapMb` | `8192` | `tsc` heap; `0` disables it |
| `excludeDirs` | list above | replaces the exclude list |
| `extraExcludeDirs` | `[]` | appended to the exclude list |

Settings are read on every call, so edits apply without a restart.

## More speed, outside this package

- **Thinking level.** Each turn at `xhigh` is much slower than at `high`. Use `high` as `defaultThinkingLevel` and raise it only for hard problems.
- **Project-specific notes** (which test command is right, how long the full typecheck takes) belong in that repo's `AGENTS.md`.

## Develop

```bash
npm install
npm test             # unit + wiring tests
npm run typecheck
npm run test:e2e     # real pi process with a scripted faux model, no API key
node scripts/e2e-rpc.mjs --without-extension      # must fail: proves the e2e bites
node scripts/e2e-toggle.mjs --without-extension   # must fail too
```

## License

MIT
