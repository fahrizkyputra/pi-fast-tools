/**
 * Wiring test: drives the extension entry point with a fake ExtensionAPI and
 * checks every handler against the settings it reads.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fastTools from "../extensions/fast-tools.ts";
import { RULES_SECTION } from "../src/rules.ts";

type Handler = (event: any, ctx?: any) => unknown;

// /fast-tools writes the user settings file: point pi's agent dir at a scratch
// directory so tests can never touch the real ~/.pi/agent/settings.json.
const scratch = mkdtempSync(join(tmpdir(), "pi-fast-tools-wiring-"));
const agentDir = join(scratch, "agent");
const workDir = join(scratch, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const userSettings = join(agentDir, "settings.json");
after(() => rmSync(scratch, { recursive: true, force: true }));
const readUser = () => JSON.parse(readFileSync(userSettings, "utf8"));

function harness(settings: unknown, opts: { activeTools?: string[]; allTools?: string[] } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	let active = opts.activeTools ?? ["read", "bash", "edit", "write"];
	const all = opts.allTools ?? [...active, "codemode"];
	const notes: string[] = [];
	const pi = {
		on: (name: string, fn: Handler) => {
			handlers.set(name, fn);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		getSettings: () => settings,
		getActiveTools: () => [...active],
		getAllTools: () => all.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	fastTools(pi);
	const ctx = { hasUI: true, cwd: workDir, ui: { notify: (m: string) => notes.push(m) } };
	return {
		handlers,
		commands,
		notes,
		ctx,
		active: () => active,
		bash: async (command: string, timeout?: number) => {
			const event = { toolName: "bash", input: timeout === undefined ? { command } : { command, timeout } };
			const result = await handlers.get("tool_call")!(event, ctx);
			return { input: event.input as { command: string; timeout?: number }, result };
		},
		prompt: (selectedTools: string[], sections: Record<string, string> = {}) => {
			const event = { systemPromptOptions: { selectedTools, sections } };
			handlers.get("before_agent_start")!(event, ctx);
			return sections;
		},
	};
}

test("registers its handlers and the /fast-tools command", () => {
	const h = harness({});
	for (const name of ["tool_call", "before_agent_start", "session_start"]) assert.ok(h.handlers.has(name), name);
	assert.ok(h.commands.has("fast-tools"));
});

test("tool_call mutates bash input in place and never blocks", async () => {
	const h = harness({});
	const { input, result } = await h.bash("grep -rn foo src && bun test");
	assert.equal(result, undefined);
	assert.ok(input.command.includes("--exclude-dir=node_modules"));
	assert.equal(input.timeout, 600);
});

test("tool_call ignores other tools", async () => {
	const h = harness({});
	const event = { toolName: "grep", input: { pattern: "x" } };
	await h.handlers.get("tool_call")!(event, h.ctx);
	assert.deepEqual(event.input, { pattern: "x" });
});

test("guard: false leaves bash untouched", async () => {
	const h = harness({ fastTools: { guard: false } });
	const { input } = await h.bash("grep -rn foo . && bun test");
	assert.deepEqual(input, { command: "grep -rn foo . && bun test" });
});

test("settings are re-read on every call (no restart after editing settings)", async () => {
	const settings: { fastTools: { guard: boolean } } = { fastTools: { guard: true } };
	const h = harness(settings);
	assert.ok((await h.bash("grep -rn x .")).input.command.includes("--exclude-dir"));
	settings.fastTools.guard = false;
	assert.equal((await h.bash("grep -rn x .")).input.command, "grep -rn x .");
});

test("before_agent_start adds the rules section and keeps other sections", () => {
	const h = harness({});
	const sections = h.prompt(["read", "bash"], { other: "keep" });
	assert.equal(sections.other, "keep");
	assert.match(sections[RULES_SECTION]!, /Batch independent calls/);
	assert.match(sections[RULES_SECTION]!, /`rg` \/ `fd`/);
});

test("rules: false removes the section", () => {
	const h = harness({ fastTools: { rules: false } });
	const sections = h.prompt(["bash"], { [RULES_SECTION]: "stale" });
	assert.equal(sections[RULES_SECTION], undefined);
});

test("codemode stays off by default", async () => {
	const h = harness({});
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.ok(!h.active().includes("codemode"));
});

test("codemode: true activates codemode and keeps the other tools", async () => {
	const h = harness({ fastTools: { codemode: true } });
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "codemode"]);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.equal(h.active().filter((t) => t === "codemode").length, 1);
});

test("codemode: true warns instead of failing when codemode is unavailable", async () => {
	const h = harness({ fastTools: { codemode: true } }, { allTools: ["read", "bash"] , activeTools: ["read", "bash"] });
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.deepEqual(h.active(), ["read", "bash"]);
	assert.match(h.notes.join("\n"), /codemode is not available/);
});

test("/fast-tools and /fast-tools status print the effective config", async () => {
	const h = harness({ fastTools: { timeoutSeconds: 0 } });
	await h.commands.get("fast-tools")!.handler("", h.ctx);
	await h.commands.get("fast-tools")!.handler("status", h.ctx);
	assert.equal(h.notes.length, 2);
	assert.match(h.notes[0]!, /guard: on/);
	assert.match(h.notes[0]!, /timeoutSeconds: off/);
	assert.match(h.notes[0]!, /excludeDirs: node_modules/);
	assert.match(h.notes[0]!, /Toggle: \/fast-tools/);
});

test("codemode-on activates codemode now and saves it", async () => {
	rmSync(userSettings, { force: true });
	const h = harness({});
	await h.commands.get("fast-tools")!.handler("codemode-on", h.ctx);
	assert.ok(h.active().includes("codemode"));
	assert.equal(readUser().fastTools.codemode, true);
	assert.match(h.notes.at(-1)!, /codemode on \(now, saved to settings\)/);
});

test("codemode-off deactivates codemode now, saves it, and keeps other settings", async () => {
	writeFileSync(userSettings, JSON.stringify({ theme: "dark", fastTools: { codemode: true, timeoutSeconds: 900 } }));
	const h = harness({ fastTools: { codemode: true } }, { activeTools: ["read", "bash", "codemode"] });
	await h.commands.get("fast-tools")!.handler("codemode-off", h.ctx);
	assert.deepEqual(h.active(), ["read", "bash"]);
	assert.deepEqual(readUser(), { theme: "dark", fastTools: { codemode: false, timeoutSeconds: 900 } });
});

test("codemode-off warns when defaultTools re-enables codemode in new sessions", async () => {
	writeFileSync(userSettings, JSON.stringify({ defaultTools: ["+codemode"] }));
	const h = harness({}, { activeTools: ["read", "codemode"] });
	await h.commands.get("fast-tools")!.handler("codemode-off", h.ctx);
	assert.match(h.notes.at(-1)!, /defaultTools.*\+codemode.*turns codemode back on/);
	assert.deepEqual(readUser().defaultTools, ["+codemode"]);
});

test("codemode-on fails cleanly when codemode is unavailable and saves nothing", async () => {
	rmSync(userSettings, { force: true });
	const h = harness({}, { activeTools: ["read"], allTools: ["read"] });
	await h.commands.get("fast-tools")!.handler("codemode-on", h.ctx);
	assert.deepEqual(h.active(), ["read"]);
	assert.ok(!existsSync(userSettings));
	assert.match(h.notes.at(-1)!, /not available.*nothing changed/);
});

test("guard-off applies to the very next bash call without a reload", async () => {
	rmSync(userSettings, { force: true });
	const h = harness({});
	assert.ok((await h.bash("grep -rn x .")).input.command.includes("--exclude-dir"));
	await h.commands.get("fast-tools")!.handler("guard-off", h.ctx);
	assert.equal((await h.bash("grep -rn x .")).input.command, "grep -rn x .");
	assert.equal(readUser().fastTools.guard, false);
	await h.commands.get("fast-tools")!.handler("guard-on", h.ctx);
	assert.ok((await h.bash("grep -rn x .")).input.command.includes("--exclude-dir"));
});

test("rules-off removes the section on the next prompt; rules-on restores it", async () => {
	const h = harness({});
	await h.commands.get("fast-tools")!.handler("rules-off", h.ctx);
	assert.equal(h.prompt(["bash"])[RULES_SECTION], undefined);
	await h.commands.get("fast-tools")!.handler("rules-on", h.ctx);
	assert.match(h.prompt(["bash"])[RULES_SECTION]!, /Batch independent calls/);
	assert.equal(readUser().fastTools.rules, true);
});

test("a conflicting project setting is reported", async () => {
	mkdirSync(join(workDir, ".pi"), { recursive: true });
	writeFileSync(join(workDir, ".pi", "settings.json"), JSON.stringify({ fastTools: { guard: true } }));
	const h = harness({});
	await h.commands.get("fast-tools")!.handler("guard-off", h.ctx);
	assert.match(h.notes.at(-1)!, /\.pi\/settings\.json sets fastTools\.guard: true, which wins/);
	rmSync(join(workDir, ".pi"), { recursive: true, force: true });
});

test("a broken settings file is never overwritten; the toggle still applies in-session", async () => {
	writeFileSync(userSettings, "{ not json");
	const h = harness({});
	await h.commands.get("fast-tools")!.handler("guard-off", h.ctx);
	assert.equal(readFileSync(userSettings, "utf8"), "{ not json");
	assert.match(h.notes.at(-1)!, /not saved: .*not valid JSON/);
	assert.equal((await h.bash("grep -rn x .")).input.command, "grep -rn x .");
	rmSync(userSettings, { force: true });
});

test("unknown arguments are rejected without side effects", async () => {
	rmSync(userSettings, { force: true });
	const h = harness({});
	for (const arg of ["codemode", "codemode-maybe", "turbo-on", "on"]) {
		await h.commands.get("fast-tools")!.handler(arg, h.ctx);
		assert.match(h.notes.at(-1)!, /unknown argument/, arg);
	}
	assert.ok(!existsSync(userSettings));
});

test("argument completion lists status and every toggle, filtered by prefix", async () => {
	const h = harness({});
	const complete = (h.commands.get("fast-tools") as unknown as { getArgumentCompletions: (p: string) => { value: string }[] | null }).getArgumentCompletions;
	assert.deepEqual(
		complete("")!.map((i) => i.value),
		["status", "guard-on", "guard-off", "rules-on", "rules-off", "codemode-on", "codemode-off"],
	);
	assert.deepEqual(complete("code")!.map((i) => i.value), ["codemode-on", "codemode-off"]);
	assert.equal(complete("zzz"), null);
});
