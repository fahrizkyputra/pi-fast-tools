/**
 * pi-fast-tools: fewer and faster tool calls.
 *
 * - `tool_call`: rewrites model-issued bash calls (see src/guard.ts).
 * - `before_agent_start`: adds the `<tool_speed>` rules section to the system prompt.
 * - `session_start`: optionally activates pi's built-in `codemode` tool.
 * - `/fast-tools [status | <feature>-on | <feature>-off]`: show or toggle features.
 *   Toggles apply immediately and are saved to the user settings file.
 *
 * Settings live under `fastTools` in pi settings; see README.
 */

import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type FastToolsConfig, resolveConfig } from "../src/config.ts";
import { type BashInput, guardBashInput } from "../src/guard.ts";
import { buildRules, RULES_SECTION } from "../src/rules.ts";
import { readDefaultTools, readFastToolsSetting, type ToggleKey, writeFastToolsSetting } from "../src/settings-file.ts";

const TOGGLES: readonly ToggleKey[] = ["guard", "rules", "codemode"];
const DESCRIPTIONS: Record<ToggleKey, string> = {
	guard: "bash rewrites: grep excludes, test/build timeout, tsc heap",
	rules: "<tool_speed> section in the system prompt",
	codemode: "pi's codemode tool (scripts that batch tool calls)",
};

export function parseToggle(args: string): { key: ToggleKey; value: boolean } | "status" | undefined {
	const arg = args.trim().toLowerCase();
	if (arg === "" || arg === "status") return "status";
	const match = /^(guard|rules|codemode)[-_ ](on|off)$/.exec(arg);
	if (!match) return undefined;
	return { key: match[1] as ToggleKey, value: match[2] === "on" };
}

export default function fastTools(pi: ExtensionAPI) {
	// pi.getSettings() is the snapshot loaded at startup or /reload. Toggles made
	// with /fast-tools are kept here so they apply at once, before any reload.
	const overrides: Partial<Record<ToggleKey, boolean>> = {};
	const config = (): FastToolsConfig => ({ ...resolveConfig(pi.getSettings()), ...overrides });

	const hasCodemode = () => pi.getAllTools().some((tool) => tool.name === "codemode");
	const enableCodemode = (): boolean => {
		if (!hasCodemode()) return false;
		const active = pi.getActiveTools();
		if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
		return true;
	};
	const disableCodemode = () => {
		const active = pi.getActiveTools();
		if (active.includes("codemode")) pi.setActiveTools(active.filter((t) => t !== "codemode"));
	};

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cfg = config();
		if (!cfg.guard) return undefined;
		guardBashInput(event.input as BashInput, cfg);
		return undefined;
	});

	pi.on("before_agent_start", (event) => {
		const cfg = config();
		const sections = event.systemPromptOptions.sections;
		if (!cfg.rules) {
			delete sections[RULES_SECTION];
			return;
		}
		sections[RULES_SECTION] = buildRules(event.systemPromptOptions.selectedTools, cfg.timeoutSeconds);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!config().codemode) return;
		if (!enableCodemode() && ctx.hasUI) {
			ctx.ui.notify("pi-fast-tools: codemode is not available (builtin:codemode disabled?)", "warning");
		}
	});

	const statusText = (): string => {
		const cfg = config();
		const codemodeActive = pi.getActiveTools().includes("codemode");
		return [
			"pi-fast-tools",
			`guard: ${cfg.guard ? "on" : "off"}`,
			`rules: ${cfg.rules ? "on" : "off"}`,
			`codemode: ${cfg.codemode ? "on" : "off"} (active now: ${codemodeActive ? "yes" : "no"})`,
			`timeoutSeconds: ${cfg.timeoutSeconds || "off"}`,
			`tscHeapMb: ${cfg.tscHeapMb || "off"}`,
			`excludeDirs: ${cfg.excludeDirs.join(", ") || "(none)"}`,
			"",
			"Toggle: /fast-tools <guard|rules|codemode>-<on|off>",
		].join("\n");
	};

	pi.registerCommand("fast-tools", {
		description: "Show pi-fast-tools status, or toggle: guard-on|off, rules-on|off, codemode-on|off",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "show current configuration" },
				...TOGGLES.flatMap((key) =>
					(["on", "off"] as const).map((state) => ({
						value: `${key}-${state}`,
						label: `${key}-${state}`,
						description: `${state === "on" ? "enable" : "disable"} ${DESCRIPTIONS[key]}`,
					})),
				),
			];
			const p = prefix.trim().toLowerCase();
			const matches = items.filter((item) => item.value.startsWith(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseToggle(args);
			if (parsed === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (!parsed) {
				ctx.ui.notify(
					`pi-fast-tools: unknown argument "${args.trim()}". Use status, or <guard|rules|codemode>-<on|off>.`,
					"error",
				);
				return;
			}

			const { key, value } = parsed;
			const notes: string[] = [];

			if (key === "codemode") {
				if (value && !enableCodemode()) {
					ctx.ui.notify("pi-fast-tools: codemode is not available (builtin:codemode disabled?); nothing changed", "error");
					return;
				}
				if (!value) disableCodemode();
			}
			overrides[key] = value;

			const userFile = join(getAgentDir(), "settings.json");
			try {
				writeFastToolsSetting(userFile, key, value);
			} catch (error) {
				notes.push(`not saved: ${(error as Error).message}. Applies to this session only.`);
			}

			const projectFile = join(ctx.cwd, ".pi", "settings.json");
			const projectValue = readFastToolsSetting(projectFile, key);
			if (projectValue !== undefined && projectValue !== value) {
				notes.push(`${projectFile} sets fastTools.${key}: ${projectValue}, which wins in new sessions of this project.`);
			}
			if (key === "codemode" && !value) {
				const sources = [userFile, projectFile].filter((f) => readDefaultTools(f).includes("+codemode"));
				if (sources.length > 0) {
					notes.push(`"defaultTools": ["+codemode"] in ${sources.join(", ")} turns codemode back on in new sessions; remove it there to keep it off.`);
				}
			}

			const summary = `pi-fast-tools: ${key} ${value ? "on" : "off"} (now${notes.some((n) => n.startsWith("not saved")) ? "" : ", saved to settings"})`;
			ctx.ui.notify([summary, ...notes].join("\n"), notes.length > 0 ? "warning" : "info");
		},
	});
}
