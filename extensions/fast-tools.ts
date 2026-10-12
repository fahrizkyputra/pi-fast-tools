/**
 * pi-fast-tools: fewer and faster tool calls.
 *
 * - `tool_call`: rewrites model-issued bash calls (see src/guard.ts).
 * - `before_agent_start`: adds the `<tool_speed>` rules section to the system prompt.
 * - `session_start`: optionally activates pi's built-in `codemode` tool.
 * - `/fast-tools`: shows the effective configuration.
 *
 * Settings live under `fastTools` in pi settings; see README.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FastToolsConfig, resolveConfig } from "../src/config.ts";
import { type BashInput, guardBashInput } from "../src/guard.ts";
import { buildRules, RULES_SECTION } from "../src/rules.ts";

export default function fastTools(pi: ExtensionAPI) {
	const config = (): FastToolsConfig => resolveConfig(pi.getSettings());

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
		const active = pi.getActiveTools();
		if (active.includes("codemode")) return;
		if (!pi.getAllTools().some((tool) => tool.name === "codemode")) {
			if (ctx.hasUI) ctx.ui.notify("pi-fast-tools: codemode is not available (builtin:codemode disabled?)", "warning");
			return;
		}
		pi.setActiveTools([...active, "codemode"]);
	});

	pi.registerCommand("fast-tools", {
		description: "Show pi-fast-tools configuration",
		handler: async (_args, ctx) => {
			const cfg = config();
			const lines = [
				`guard: ${cfg.guard ? "on" : "off"}`,
				`rules: ${cfg.rules ? "on" : "off"}`,
				`codemode: ${cfg.codemode ? "auto-enable" : "off"} (active: ${pi.getActiveTools().includes("codemode") ? "yes" : "no"})`,
				`timeoutSeconds: ${cfg.timeoutSeconds || "off"}`,
				`tscHeapMb: ${cfg.tscHeapMb || "off"}`,
				`excludeDirs: ${cfg.excludeDirs.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(`pi-fast-tools\n${lines.join("\n")}`, "info");
		},
	});
}
