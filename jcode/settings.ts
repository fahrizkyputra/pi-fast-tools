/**
 * jcode-side settings: `~/.jcode/pi-fast-tools.json`, same keys as the Pi
 * `fastTools` block (guard, rules, excludeDirs, extraExcludeDirs, tscHeapMb).
 * The hook reads it on every call, so a guard toggle applies at once.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FastToolsConfig, resolveConfig } from "../src/config.ts";
import { jcodeHome } from "./kit.ts";

export const settingsPath = (): string => join(jcodeHome(), "pi-fast-tools.json");

function readRaw(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function loadSettings(path: string = settingsPath()): FastToolsConfig {
	return resolveConfig({ fastTools: readRaw(path) });
}

export function saveSetting(key: "guard" | "rules", value: boolean, path: string = settingsPath()): void {
	const raw = readRaw(path);
	raw[key] = value;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
