/**
 * The tool-speed rules for jcode's system prompt (written to
 * `~/.jcode/prompt-overlay.md`). Same intent as the Pi `<tool_speed>` section,
 * phrased for jcode's tools: `batch` instead of parallel calls in one message,
 * `agentgrep`, `read` with `start_line`/`limit`, and bash `timeout` in
 * milliseconds with `run_in_background`.
 */

export const OVERLAY_BLOCK = "pi-fast-tools";

export function buildJcodeRules(timeoutSeconds: number): string {
	const timeoutMs = (timeoutSeconds > 0 ? timeoutSeconds : 600) * 1000;
	return [
		"## Tool speed",
		"",
		"Each model turn costs several seconds; fewer turns beat faster commands.",
		"These are generic defaults. Project instructions (AGENTS.md, CLAUDE.md, and files they reference) take precedence: if the project forbids running or creating tests without permission, requires build/lint/format/typecheck to go through a specific subagent or command, or restricts how searches are done, follow the project and skip the conflicting rule below.",
		"",
		"- Batch independent calls: put reads, searches, and listings with no dependency into one `batch` call (up to 10). Never one search per turn when the next query is already known.",
		"- When `codemode` is available, use it for exploration fan-out (many searches/reads, filtering large output) and return only the filtered summary.",
		"- Search with `agentgrep`, or `rg` / `fd` in bash, instead of `grep -r` / `find`: they skip `node_modules`, build output, and worktrees and are often 10x+ faster on large repos. Scope to a directory and limit output with `-l`, `-c`, or `--max-count`.",
		"- Read files with `read` plus `start_line`/`limit` instead of repeated `sed -n` / `cat` calls. Read the needed range once; do not re-read files already in context.",
		"- Tests, builds, typechecks:",
		"  - Run only what the change touches (`vitest related <changed files> --run`, `bun test <file>`, `pytest <file>`), not the whole suite unless asked.",
		`  - Set bash \`timeout\` (milliseconds, e.g. ${timeoutMs}) on runs that could hang.`,
		"  - Pipe through `tail -n 40` or `rg 'fail|error|✗|×'` so only failures reach context.",
		"  - A full-project typecheck on a large repo can take minutes: run it once at the end, not after every edit.",
		"- Long-lived processes (dev servers, watchers) go in the background with `run_in_background: true`, then read their output. Delegate heavy verify or lint passes to a subagent or swarm worker when one is available, and keep working.",
	].join("\n");
}
