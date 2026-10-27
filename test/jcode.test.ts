import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { parseStringList, readHookCommands, upsertBlock, withHookCommand } from "../jcode/kit.ts";
import { buildJcodeRules } from "../jcode/rules.ts";
import { transformInput } from "../jcode/transform.ts";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------- config.toml editing

const SAMPLE = `[features]
memory = true

[hooks]
pre_tool_timeout_ms = 5000
turn_end = "~/bin/notify"

[ambient]
enabled = false
`;

test("adds the command to an existing [hooks] table and leaves everything else alone", () => {
	const out = withHookCommand(SAMPLE, "pre_tool_transform", "/plugins/pi-fast-tools/", "node /x/plugins/pi-fast-tools/t.ts");
	assert.equal(readHookCommands(out, "pre_tool_transform")[0], "node /x/plugins/pi-fast-tools/t.ts");
	assert.equal(out.replace(/^pre_tool_transform = .*\n/m, ""), SAMPLE);
});

test("re-install replaces only its own command and keeps foreign ones in order", () => {
	const toml = `[hooks]\npre_tool_transform = ["~/.jcode/plugins/rtk-transform", "node /old/plugins/pi-fast-tools/t.ts"]\n`;
	const out = withHookCommand(toml, "pre_tool_transform", "/plugins/pi-fast-tools/", "node /new/plugins/pi-fast-tools/t.ts");
	assert.deepEqual(readHookCommands(out, "pre_tool_transform"), ["~/.jcode/plugins/rtk-transform", "node /new/plugins/pi-fast-tools/t.ts"]);
});

test("uninstall drops its command; the key disappears when nothing is left", () => {
	const mixed = `[hooks]\npre_tool = ["a", "node /p/plugins/pi-modes/gate.ts"]\n`;
	assert.deepEqual(readHookCommands(withHookCommand(mixed, "pre_tool", "/plugins/pi-modes/", undefined), "pre_tool"), ["a"]);
	const alone = `[hooks]\npre_tool = "node /p/plugins/pi-modes/gate.ts"\nx = 1\n`;
	assert.equal(withHookCommand(alone, "pre_tool", "/plugins/pi-modes/", undefined), "[hooks]\nx = 1\n");
});

test("a scalar value and a multi-line array with comments are both read and rewritten", () => {
	assert.deepEqual(readHookCommands(`[hooks]\nturn_end = 'a b'\n`, "turn_end"), ["a b"]);
	const multi = `[hooks]\npre_tool = [\n  "a", # first\n  "b",\n]\nnext = 1\n[x]\n`;
	assert.deepEqual(readHookCommands(multi, "pre_tool"), ["a", "b"]);
	const out = withHookCommand(multi, "pre_tool", "zzz", "c");
	assert.equal(out, `[hooks]\npre_tool = ["a", "b", "c"]\nnext = 1\n[x]\n`);
});

test("creates the [hooks] table when the file has none, or is empty", () => {
	assert.equal(withHookCommand("", "pre_tool", "m", "cmd"), `[hooks]\npre_tool = "cmd"\n`);
	assert.equal(withHookCommand("[a]\nb = 1", "pre_tool", "m", "cmd"), `[a]\nb = 1\n\n[hooks]\npre_tool = "cmd"\n`);
});

test("a key with the same name in another table is not touched", () => {
	const toml = `[other]\npre_tool = "keep"\n\n[hooks]\nturn_end = "t"\n`;
	const out = withHookCommand(toml, "pre_tool", "m", "cmd");
	assert.ok(out.includes(`[other]\npre_tool = "keep"`));
	assert.deepEqual(readHookCommands(out, "pre_tool"), ["cmd"]);
});

test("quotes and backslashes survive the round trip", () => {
	const command = `node "/Users/a b/plugins/pi-fast-tools/t.ts" --x=\\y`;
	const out = withHookCommand("[hooks]\n", "pre_tool_transform", "/plugins/pi-fast-tools/", command);
	assert.deepEqual(readHookCommands(out, "pre_tool_transform"), [command]);
});

test("a value form it cannot parse is refused instead of being rewritten", () => {
	assert.throws(() => withHookCommand(`[hooks]\npre_tool = { a = 1 }\n`, "pre_tool", "m", "c"), /by hand/);
	assert.throws(() => parseStringList("42"));
});

// ---------------------------------------------------------------- overlay

test("overlay block is added, replaced in place, and removed without touching user text", () => {
	const user = "# my notes\nkeep this\n";
	const one = upsertBlock(user, "pi-fast-tools", "rules v1");
	assert.equal(one, `${user}\n<!-- pi-fast-tools:start -->\nrules v1\n<!-- pi-fast-tools:end -->\n`);
	const two = upsertBlock(`${one}tail\n`, "pi-fast-tools", "rules v2");
	assert.ok(two.includes("rules v2") && !two.includes("rules v1") && two.endsWith("tail\n"));
	assert.equal(upsertBlock(one, "pi-fast-tools", undefined), user);
	assert.equal(upsertBlock("", "b", "x"), "<!-- b:start -->\nx\n<!-- b:end -->\n");
});

// ---------------------------------------------------------------- transform + rules

test("transform rewrites recursive grep and tsc in bash, and nothing else", () => {
	const out = transformInput("bash", { command: "grep -rn foo src && npx tsc --noEmit", intent: "x" }, DEFAULT_CONFIG);
	assert.ok(out);
	assert.ok(String(out.command).includes("--exclude-dir=node_modules"));
	assert.ok(String(out.command).startsWith('export NODE_OPTIONS="--max-old-space-size=8192"'));
	assert.equal(out.intent, "x");
	assert.equal(transformInput("bash", { command: "ls -la" }, DEFAULT_CONFIG), undefined);
	assert.equal(transformInput("read", { command: "grep -r x ." }, DEFAULT_CONFIG), undefined);
	assert.equal(transformInput("bash", { command: "grep -r x ." }, { ...DEFAULT_CONFIG, guard: false }), undefined);
	assert.equal(transformInput("bash", "nope", DEFAULT_CONFIG), undefined);
});

test("jcode rules name jcode's own tools and give the timeout in milliseconds", () => {
	const rules = buildJcodeRules(600);
	for (const word of ["`batch`", "`agentgrep`", "`start_line`", "600000", "run_in_background", "AGENTS.md"]) {
		assert.ok(rules.includes(word), word);
	}
});

// ---------------------------------------------------------------- installer, end to end on a scratch home

function scratch() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "fast-tools-jcode-")));
	const jcodeHome = join(home, ".jcode");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	mkdirSync(jcodeHome, { recursive: true });
	writeFileSync(join(jcodeHome, "config.toml"), SAMPLE);
	writeFileSync(join(jcodeHome, "prompt-overlay.md"), "# mine\n");
	const env = { ...process.env, HOME: home, JCODE_HOME: jcodeHome, PATH: `${join(home, ".local", "bin")}:${process.env.PATH}` };
	const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "bin", "jcode.mjs"), ...args], { env, encoding: "utf8" });
	return { home, jcodeHome, env, run };
}

test("install wires hook, overlay, and command; the hook really rewrites; uninstall restores the files", () => {
	const { home, jcodeHome, env, run } = scratch();
	const installed = run("jcode", "install");
	assert.equal(installed.status, 0, installed.stderr);

	const toml = readFileSync(join(jcodeHome, "config.toml"), "utf8");
	const [hook] = readHookCommands(toml, "pre_tool_transform");
	assert.equal(hook, join(jcodeHome, "plugins", "pi-fast-tools", "hooks", "transform.sh"));
	assert.ok(readFileSync(join(jcodeHome, "prompt-overlay.md"), "utf8").includes("## Tool speed"));
	assert.ok(lstatSync(join(home, ".local", "bin", "jcode-fast-tools")).isSymbolicLink());

	// Run the hook exactly as jcode would: exec the configured path, input on stdin.
	const fire = (tool: string, input: string) =>
		spawnSync(hook ?? "", [], { env: { ...env, JCODE_HOOK_TOOL_NAME: tool }, input, encoding: "utf8" });
	const fired = fire("bash", JSON.stringify({ command: "grep -rn x ." }));
	assert.equal(fired.status, 0, fired.stderr);
	assert.ok(JSON.parse(fired.stdout).command.includes("--exclude-dir=node_modules"));
	// Other tools exit at the shell guard, before Node starts.
	assert.equal(fire("read", JSON.stringify({ command: "grep -rn x ." })).stdout, "");

	// guard-off is read by the very next hook call.
	assert.equal(spawnSync(join(home, ".local", "bin", "jcode-fast-tools"), ["guard-off"], { env, encoding: "utf8" }).status, 0);
	assert.equal(fire("bash", JSON.stringify({ command: "grep -rn x ." })).stdout, "");

	// Bad stdin fails open: no output, exit 0.
	const bad = fire("bash", "not json");
	assert.equal(bad.status, 0);
	assert.equal(bad.stdout, "");

	assert.equal(run("jcode", "uninstall").status, 0);
	assert.equal(readFileSync(join(jcodeHome, "config.toml"), "utf8"), SAMPLE);
	assert.equal(readFileSync(join(jcodeHome, "prompt-overlay.md"), "utf8"), "# mine\n");
	assert.ok(!existsSync(join(home, ".local", "bin", "jcode-fast-tools")));
	assert.ok(!existsSync(join(jcodeHome, "plugins", "pi-fast-tools")));
});

test("running the bin without the jcode scope explains both installs and exits non-zero", () => {
	const { run } = scratch();
	const out = run();
	assert.equal(out.status, 2);
	assert.match(out.stderr, /pi install npm:@fahrizkyputra\/pi-fast-tools/);
	assert.match(out.stderr, /jcode install/);
});
