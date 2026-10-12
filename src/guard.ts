/**
 * Pure rewrite of a model-issued bash call. No pi imports, so it is testable
 * without a runtime.
 *
 * 1. Recursive grep (`grep -r`, `-R`, `egrep -r`, `command grep -r`) gets
 *    `--exclude-dir` for heavy directories. Same flags and semantics, it only
 *    skips junk. Not rewritten to `rg`: grep and rg flags differ (`-r`, `-E`,
 *    `--include`), and a silent mistranslation would return wrong results.
 *    A grep that deliberately targets an excluded directory is left alone.
 * 2. Test, build, typecheck, and lint commands without a timeout get one, so a
 *    hung `bun test` or `vitest` cannot block the session. Long-lived processes
 *    (dev servers, watchers, `nohup`, trailing `&`) are left alone.
 * 3. `tsc` / `tsgo` without `NODE_OPTIONS` gets a larger heap; large projects
 *    abort on the default heap ("Abort trap: 6").
 *
 * Explicit choices win: an existing timeout, `NODE_OPTIONS`,
 * `max-old-space-size`, or `--exclude-dir` is never overridden.
 */

export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
	"node_modules",
	".git",
	".next",
	".turbo",
	".worktrees",
	"dist",
	"build",
	"out",
	"coverage",
	"storybook-static",
	".venv",
	"__pycache__",
];

export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_TSC_HEAP_MB = 8192;

export interface GuardOptions {
	excludeDirs: readonly string[];
	/** Seconds; 0 disables the automatic timeout. */
	timeoutSeconds: number;
	/** Megabytes; 0 disables the tsc heap bump. */
	tscHeapMb: number;
}

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
	excludeDirs: DEFAULT_EXCLUDE_DIRS,
	timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	tscHeapMb: DEFAULT_TSC_HEAP_MB,
};

export interface BashInput {
	command: string;
	timeout?: number;
}

// `grep` / `egrep` / `command grep` followed by a flag cluster containing r or R,
// plus the rest of that pipeline segment (to see which paths it targets).
const RECURSIVE_GREP =
	/(^|[\s;&|(`]|\$\()((?:command\s+)?e?grep)(\s+-[a-zA-Z]*[rR][a-zA-Z]*)(?=\s)([^|;&\n]*)/g;

const LONG_RUNNING =
	/\b(vitest|jest|bun\s+test|tsc|tsgo|next\s+build|vite\s+build|docusaurus\s+build|playwright\s+test|pytest|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck)|eslint|verify[\w.-]*\.mjs)\b/;

// Long-lived processes started on purpose; a timeout would kill them.
const LONG_LIVED =
	/\b(nohup|next\s+dev|docusaurus\s+start|storybook\s+dev)\b|\bvite(?!\s+build)(\s|$)|(^|\s)(--watch|-w)(\s|=|$)|[^&]&\s*$/m;

const TSC = /(^|[\s;&|(])((?:\S*\/)?(?:tsc|tsgo))(\s|$)/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function excludedNamePattern(dirs: readonly string[]): RegExp | undefined {
	if (dirs.length === 0) return undefined;
	return new RegExp(`(^|[\\s/'"])(${dirs.map(escapeRegExp).join("|")})(/|\\s|$|['"])`);
}

export function addGrepExcludes(command: string, dirs: readonly string[]): string {
	if (dirs.length === 0 || command.includes("--exclude-dir")) return command;
	const flags = dirs.map((d) => `--exclude-dir=${d}`).join(" ");
	const targetsExcluded = excludedNamePattern(dirs);
	return command.replace(RECURSIVE_GREP, (match, pre, bin, opts, rest) =>
		targetsExcluded?.test(rest) ? match : `${pre}${bin}${opts} ${flags}${rest}`,
	);
}

export function addTscHeap(command: string, heapMb: number): string {
	if (heapMb <= 0) return command;
	if (!TSC.test(command) || command.includes("NODE_OPTIONS") || command.includes("max-old-space-size")) {
		return command;
	}
	return `export NODE_OPTIONS="--max-old-space-size=${heapMb}"\n${command}`;
}

export function isLongRunning(command: string): boolean {
	return LONG_RUNNING.test(command) && !LONG_LIVED.test(command);
}

/** Mutates `input` in place, as pi's `tool_call` contract requires. Returns true if anything changed. */
export function guardBashInput(input: BashInput, options: GuardOptions = DEFAULT_GUARD_OPTIONS): boolean {
	const original = input.command;
	if (typeof original !== "string") return false;

	let command = addGrepExcludes(original, options.excludeDirs);
	command = addTscHeap(command, options.tscHeapMb);
	let changed = command !== original;
	input.command = command;

	if (input.timeout === undefined && options.timeoutSeconds > 0 && isLongRunning(command)) {
		input.timeout = options.timeoutSeconds;
		changed = true;
	}
	return changed;
}
