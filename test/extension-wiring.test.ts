/**
 * Wiring test: drives the extension entry point with a fake ExtensionAPI and
 * checks every handler against the settings it reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fastTools from "../extensions/fast-tools.ts";
import { RULES_SECTION } from "../src/rules.ts";

type Handler = (event: any, ctx?: any) => unknown;

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
	const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
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

test("/fast-tools prints the effective config", async () => {
	const h = harness({ fastTools: { timeoutSeconds: 0 } });
	await h.commands.get("fast-tools")!.handler("", h.ctx);
	const text = h.notes.join("\n");
	assert.match(text, /guard: on/);
	assert.match(text, /timeoutSeconds: off/);
	assert.match(text, /excludeDirs: node_modules/);
});
