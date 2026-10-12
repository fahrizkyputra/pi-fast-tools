/**
 * Reads the optional `fastTools` block from pi settings
 * (`~/.pi/agent/settings.json` or a project's `.pi/settings.json`).
 * Invalid values fall back to defaults instead of throwing, so a typo in
 * settings never blocks a tool call.
 */

import { DEFAULT_EXCLUDE_DIRS, DEFAULT_TIMEOUT_SECONDS, DEFAULT_TSC_HEAP_MB, type GuardOptions } from "./guard.ts";

export interface FastToolsConfig extends GuardOptions {
	/** Rewrite model-issued bash calls (grep excludes, timeouts, tsc heap). */
	guard: boolean;
	/** Add the tool-speed rules section to the system prompt. */
	rules: boolean;
	/** Activate pi's built-in `codemode` tool at session start. */
	codemode: boolean;
}

export const DEFAULT_CONFIG: FastToolsConfig = {
	guard: true,
	rules: true,
	codemode: false,
	excludeDirs: DEFAULT_EXCLUDE_DIRS,
	timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	tscHeapMb: DEFAULT_TSC_HEAP_MB,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const nonNegative = (v: unknown, fallback: number) =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

export function resolveConfig(settings: unknown): FastToolsConfig {
	const raw = isRecord(settings) ? settings.fastTools : undefined;
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };

	let excludeDirs = DEFAULT_CONFIG.excludeDirs;
	if (Array.isArray(raw.excludeDirs)) {
		excludeDirs = raw.excludeDirs.filter((d): d is string => typeof d === "string" && d.trim() !== "");
	}
	if (Array.isArray(raw.extraExcludeDirs)) {
		const extra = raw.extraExcludeDirs.filter((d): d is string => typeof d === "string" && d.trim() !== "");
		excludeDirs = [...new Set([...excludeDirs, ...extra])];
	}

	return {
		guard: bool(raw.guard, DEFAULT_CONFIG.guard),
		rules: bool(raw.rules, DEFAULT_CONFIG.rules),
		codemode: bool(raw.codemode, DEFAULT_CONFIG.codemode),
		excludeDirs,
		timeoutSeconds: nonNegative(raw.timeoutSeconds, DEFAULT_CONFIG.timeoutSeconds),
		tscHeapMb: nonNegative(raw.tscHeapMb, DEFAULT_CONFIG.tscHeapMb),
	};
}
