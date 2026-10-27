/**
 * `jcode-fast-tools <install|uninstall|status|guard-on|guard-off|rules-on|rules-off>`
 *
 * Runs from the copy in `~/.jcode/plugins/pi-fast-tools/` (bin/jcode.mjs puts it there).
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	configPath,
	editConfig,
	hasOverlayBlock,
	installShim,
	overlayPath,
	readHookCommands,
	removeShim,
	shimCommand,
	withHookCommand,
	writeHookScript,
	writeOverlayBlock,
} from "./kit.ts";
import { buildJcodeRules, OVERLAY_BLOCK } from "./rules.ts";
import { loadSettings, saveSetting, settingsPath } from "./settings.ts";

export const PACKAGE = "pi-fast-tools";
export const SHIM = "jcode-fast-tools";
const HOOK_KEY = "pre_tool_transform";
const MARKER = `/plugins/${PACKAGE}/`;

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);

function syncOverlay(): void {
	const config = loadSettings();
	writeOverlayBlock(OVERLAY_BLOCK, config.rules ? buildJcodeRules(config.timeoutSeconds) : undefined);
}

function install(): string[] {
	const hook = writeHookScript(join(pluginRoot, "hooks", "transform.sh"), join(here, "transform.ts"), '[ "$JCODE_HOOK_TOOL_NAME" = bash ] || exit 0');
	editConfig(PACKAGE, (toml) => withHookCommand(toml, HOOK_KEY, MARKER, hook));
	syncOverlay();
	const shim = installShim(SHIM, join(here, "cli.ts"));
	return [
		`${PACKAGE} installed for jcode`,
		`- hook: [hooks] ${HOOK_KEY} in ${configPath()} (live within seconds; jcode reloads config.toml)`,
		`- rules: "Tool speed" block in ${overlayPath()} (new sessions)`,
		`- settings: ${settingsPath()}`,
		`- command: ${shim} status | guard-on|off | rules-on|off | uninstall`,
	];
}

function uninstall(): string[] {
	editConfig(PACKAGE, (toml) => withHookCommand(toml, HOOK_KEY, MARKER, undefined));
	writeOverlayBlock(OVERLAY_BLOCK, undefined);
	removeShim(SHIM);
	rmSync(pluginRoot, { recursive: true, force: true });
	return [`${PACKAGE} removed from jcode (hook, overlay block, command, ${pluginRoot}). ${settingsPath()} is kept.`];
}

async function status(): Promise<string[]> {
	const { readFileSync, existsSync } = await import("node:fs");
	const toml = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : "";
	const hooked = readHookCommands(toml, HOOK_KEY).some((command) => command.includes(MARKER));
	const config = loadSettings();
	return [
		PACKAGE,
		`hook (${HOOK_KEY}): ${hooked ? "installed" : "missing — run install"}`,
		`guard: ${config.guard ? "on" : "off"}  (grep --exclude-dir, tsc heap)`,
		`rules: ${config.rules ? "on" : "off"}  (overlay block ${hasOverlayBlock(OVERLAY_BLOCK) ? "present" : "absent"})`,
		`tscHeapMb: ${config.tscHeapMb || "off"}`,
		`excludeDirs: ${config.excludeDirs.join(", ") || "(none)"}`,
		`command: ${shimCommand(SHIM)}`,
	];
}

export async function run(args: readonly string[]): Promise<{ code: number; lines: string[] }> {
	const command = (args[0] ?? "status").toLowerCase();
	switch (command) {
		case "install":
			return { code: 0, lines: install() };
		case "uninstall":
			return { code: 0, lines: uninstall() };
		case "status":
			return { code: 0, lines: await status() };
		case "guard-on":
		case "guard-off":
		case "rules-on":
		case "rules-off": {
			const [key, state] = command.split("-") as ["guard" | "rules", "on" | "off"];
			saveSetting(key, state === "on");
			if (key === "rules") syncOverlay();
			const when = key === "guard" ? "next bash call" : "new sessions";
			return { code: 0, lines: [`${PACKAGE}: ${key} ${state} (applies to ${when})`] };
		}
		default:
			return { code: 2, lines: [`unknown command "${command}". Use install, uninstall, status, guard-on|off, rules-on|off.`] };
	}
}

if (import.meta.main) {
	try {
		const { code, lines } = await run(process.argv.slice(2));
		(code === 0 ? console.log : console.error)(lines.join("\n"));
		process.exitCode = code;
	} catch (error) {
		console.error(`${PACKAGE}: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
