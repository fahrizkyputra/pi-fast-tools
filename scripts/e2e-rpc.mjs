#!/usr/bin/env node
/**
 * End-to-end check against a real Pi process, no API key needed.
 *
 * A scratch extension registers pi-ai's faux provider. Its scripted model:
 *   turn 1: issues one bash call (recursive grep + tsc marker + verify.mjs)
 *   turn 2: records the system prompt, active tools, and the bash result
 * A second scratch extension (loaded after pi-fast-tools) records the bash
 * input exactly as pi will execute it.
 *
 * Asserts on the world:
 *   - grep skipped node_modules but still found the match in src
 *   - the executed command carried NODE_OPTIONS and a timeout of 600
 *   - the system prompt has the <tool_speed> section
 *   - codemode was activated (fastTools.codemode: true in settings)
 *   - no extension errors
 *
 * Usage:  npm run test:e2e             (requires `pi` on PATH)
 *         node scripts/e2e-rpc.mjs --without-extension   # must FAIL (proves the harness bites)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 90_000;
const withoutExtension = process.argv.includes("--without-extension");
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "fast-tools.ts");

const root = mkdtempSync(join(tmpdir(), "pi-fast-tools-e2e-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const outFile = join(root, "observed.json");
for (const dir of [agentDir, join(workDir, "src"), join(workDir, "node_modules", "pkg")]) mkdirSync(dir, { recursive: true });

const MARKER = "zz_fast_tools_marker";
writeFileSync(join(workDir, "src", "a.txt"), `${MARKER}\n`);
writeFileSync(join(workDir, "node_modules", "pkg", "b.txt"), `${MARKER}\n`);
writeFileSync(join(workDir, "verify.mjs"), "");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fastTools: { codemode: true } }, null, 2));

// The probe must not contain the text "NODE_OPTIONS": an explicit NODE_OPTIONS
// opts out of the heap bump by design.
const COMMAND = `grep -rn ${MARKER} . ; env | grep -o 'max-old-space[^ ]*' ; true tsc ; node verify.mjs ; true`;

const fauxExt = join(root, "faux-model.ts");
writeFileSync(
	fauxExt,
	`import { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
export default function (pi: any) {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: ${JSON.stringify(COMMAND)} }), { stopReason: "toolUse" }),
		(context: any) => {
			const result = context.messages.find((m: any) => m.role === "toolResult");
			const text = (result?.content ?? []).map((c: any) => c.text ?? "").join("");
			const prev = (() => { try { return JSON.parse(readFileSync(${JSON.stringify(outFile)}, "utf8")); } catch { return {}; } })();
			writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
				...prev,
				systemPrompt: getCurrentSystemPrompt(context.messages),
				tools: getCurrentTools(context.messages).map((t: any) => t.name),
				bashOutput: text,
			}));
			return fauxAssistantMessage("done");
		},
	]);
	pi.registerProvider(faux.provider);
}
`,
);

const observerExt = join(root, "observer.ts");
writeFileSync(
	observerExt,
	`import { readFileSync, writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("tool_call", (event: any) => {
		if (event.toolName !== "bash") return;
		let prev = {};
		try { prev = JSON.parse(readFileSync(${JSON.stringify(outFile)}, "utf8")); } catch {}
		writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ ...prev, executed: { ...event.input } }));
	});
}
`,
);

// Load order matters: pi-fast-tools first, the observer last, so it sees the final input.
const extArgs = [...(withoutExtension ? [] : ["-e", extensionPath]), "-e", fauxExt, "-e", observerExt];

const errors = [];
const extensionErrors = [];
let finished = false;
let agentEnded = false;

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--model", "faux/faux-1", ...extArgs], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => errors.push(chunk.toString()));

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (line) handleLine(line);
	}
});

function handleLine(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(String(event.error ?? event.message ?? line));
	if (event.type === "response" && event.success === false) extensionErrors.push(`rpc error: ${line.slice(0, 300)}`);
	if (event.type === "agent_end") {
		agentEnded = true;
		setTimeout(check, 300);
	}
}

const reply = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
	process.exit(code);
}

const failures = [];
const expect = (ok, message) => {
	if (!ok) failures.push(message);
};

function check() {
	expect(agentEnded, "agent never finished");
	expect(extensionErrors.length === 0, `extension errors: ${extensionErrors.join(" | ").slice(0, 400)}`);
	expect(!errors.join("").includes("Extension error"), `stderr: ${errors.join("").slice(0, 400)}`);
	const observed = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
	const out = observed.bashOutput ?? "";
	const cmd = observed.executed?.command ?? "";

	expect(out.includes(`src/a.txt:1:${MARKER}`), `grep lost the src match: ${out.slice(0, 300)}`);
	expect(!out.includes("node_modules/pkg/b.txt"), "grep searched node_modules");
	expect(cmd.includes("--exclude-dir=node_modules"), `executed command has no excludes: ${cmd.slice(0, 200)}`);
	expect(out.includes("max-old-space-size=8192"), "tsc heap was not applied at runtime");
	expect(observed.executed?.timeout === 600, `timeout was ${observed.executed?.timeout}`);
	expect(/<tool_speed>[\s\S]*Batch independent calls/.test(observed.systemPrompt ?? ""), "system prompt has no <tool_speed> section");
	expect((observed.tools ?? []).includes("codemode"), `codemode not active, tools: ${(observed.tools ?? []).join(",")}`);

	if (failures.length) {
		for (const f of failures) console.error(`FAIL: ${f}`);
		if (process.env.E2E_DEBUG) console.error(JSON.stringify({ cmd, out }, null, 1));
		finish(1);
	}
	console.log("e2e ok: grep excludes, tsc heap, timeout, <tool_speed> rules, and codemode verified against a real pi process");
	finish(0);
}

const timer = setTimeout(() => {
	failures.push(`timed out; stderr: ${errors.join("").slice(-400)}`);
	check();
}, TIMEOUT_MS);

setTimeout(() => reply({ id: "p1", type: "prompt", message: "run the check" }), 3000);
