#!/usr/bin/env node
/**
 * End-to-end check for `/fast-tools <feature>-on|off` against a real Pi process.
 *
 * Starts with codemode off, then over RPC:
 *   /fast-tools codemode-on   -> next model request must declare `codemode`
 *   /fast-tools codemode-off  -> next model request must NOT declare it
 *   /fast-tools rules-off     -> next system prompt must lack <tool_speed>
 * and checks the isolated settings.json after each toggle. A faux provider
 * records the tools and system prompt of every model request; no API key needed.
 *
 * Usage:  node scripts/e2e-toggle.mjs                      (requires `pi` on PATH)
 *         node scripts/e2e-toggle.mjs --without-extension  # must FAIL
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const withoutExtension = process.argv.includes("--without-extension");
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "fast-tools.ts");

const root = mkdtempSync(join(tmpdir(), "pi-fast-tools-toggle-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const logFile = join(root, "requests.jsonl");
for (const dir of [agentDir, workDir]) mkdirSync(dir, { recursive: true });
const settingsFile = join(agentDir, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ theme: "dark" }, null, 2));

const fauxExt = join(root, "faux-model.ts");
writeFileSync(
	fauxExt,
	`import { fauxProvider, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
export default function (pi: any) {
	const faux = fauxProvider();
	const record = (context: any) => {
		appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
			tools: getCurrentTools(context.messages).map((t: any) => t.name),
			hasRules: getCurrentSystemPrompt(context.messages).includes("<tool_speed>"),
		}) + "\\n");
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([record, record, record, record]);
	pi.registerProvider(faux.provider);
}
`,
);

const extArgs = [...(withoutExtension ? [] : ["-e", extensionPath]), "-e", fauxExt];
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--model", "faux/faux-1", ...extArgs], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	stdio: ["pipe", "pipe", "pipe"],
});

const errors = [];
const extensionErrors = [];
const notifications = [];
const waiters = [];
child.stderr.on("data", (c) => errors.push(c.toString()));

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let i = buffer.indexOf("\n");
	while (i >= 0) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		i = buffer.indexOf("\n");
		if (line) handle(line);
	}
});

function handle(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(String(event.error ?? event.message ?? line));
	if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(String(event.message ?? ""));
	for (const w of [...waiters]) {
		if (w.match(event)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(event);
		}
	}
}

const waitFor = (match, label) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 30_000);
		waiters.push({ match, resolve: (e) => (clearTimeout(t), resolve(e)) });
	});
const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function command(text, id) {
	const done = waitFor((e) => e.type === "response" && e.id === id, `response to ${text}`);
	send({ id, type: "prompt", message: text });
	const res = await done;
	if (res.data?.disposition !== "handled") throw new Error(`${text}: disposition ${res.data?.disposition ?? JSON.stringify(res)}`);
	await sleep(300);
}

async function modelTurn(id) {
	const ended = waitFor((e) => e.type === "agent_end", `agent_end for ${id}`);
	send({ id, type: "prompt", message: "hello" });
	await ended;
	const lines = readFileSync(logFile, "utf8").trim().split("\n");
	return JSON.parse(lines.at(-1));
}

const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"));
const failures = [];
const expect = (ok, msg) => ok || failures.push(msg);

let finished = false;
function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
	process.exit(code);
}
const timer = setTimeout(() => {
	console.error(`FAIL: timed out; stderr: ${errors.join("").slice(-400)}`);
	finish(1);
}, TIMEOUT_MS);

try {
	await sleep(3000);

	const r0 = await modelTurn("t0");
	expect(!r0.tools.includes("codemode"), `codemode active before toggle: ${r0.tools}`);

	await command("/fast-tools codemode-on", "c1");
	const r1 = await modelTurn("t1");
	expect(r1.tools.includes("codemode"), `codemode-on: next request lacks codemode: ${r1.tools}`);
	expect(settings().fastTools?.codemode === true, `codemode-on not saved: ${JSON.stringify(settings())}`);
	expect(settings().theme === "dark", "other settings were lost");

	await command("/fast-tools codemode-off", "c2");
	const r2 = await modelTurn("t2");
	expect(!r2.tools.includes("codemode"), `codemode-off: next request still has codemode: ${r2.tools}`);
	expect(settings().fastTools?.codemode === false, "codemode-off not saved");
	expect(r2.hasRules, "rules section missing before rules-off");

	await command("/fast-tools rules-off", "c3");
	const r3 = await modelTurn("t3");
	expect(!r3.hasRules, "rules-off: <tool_speed> still in the system prompt");
	expect(settings().fastTools?.rules === false, "rules-off not saved");
	expect(!existsSync(`${settingsFile}.lock`), "settings lock left behind");
} catch (error) {
	failures.push(String(error.message ?? error));
}

expect(extensionErrors.length === 0, `extension errors: ${extensionErrors.join(" | ").slice(0, 300)}`);
if (failures.length) {
	for (const f of failures) console.error(`FAIL: ${f}`);
	if (process.env.E2E_DEBUG) console.error(notifications.join("\n---\n"), errors.join("").slice(-800));
	finish(1);
}
console.log("e2e ok: /fast-tools codemode-on/off and rules-off apply to the next model request and persist to settings.json");
finish(0);
