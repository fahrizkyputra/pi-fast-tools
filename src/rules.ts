/**
 * Tool-speed rules added to the system prompt as a `<tool_speed>` section.
 * Lines that name a tool only appear when that tool is active, so the model is
 * never told to use something it cannot call.
 */

export const RULES_SECTION = "tool_speed";

export function buildRules(activeTools: readonly string[], timeoutSeconds: number): string {
	const has = (name: string) => activeTools.includes(name);
	const lines: string[] = [
		"Each model turn costs several seconds (often ~7 s); fewer turns beat faster commands.",
		"These are generic defaults. Project instructions (AGENTS.md, CLAUDE.md, and files they reference) take precedence: if the project forbids running or creating tests without permission, requires build/lint/format/typecheck to go through a specific subagent or command, or restricts how searches are done, follow the project and skip the conflicting rule below.",
		"",
		"- Batch independent calls: several reads/searches/listings with no dependency go in ONE assistant message as parallel tool calls. Never one search per turn when the next query is already known.",
	];

	if (has("codemode")) {
		lines.push(
			"- Use `codemode` for exploration fan-out (many searches/reads, filtering large output) and for running several checks at once with `Promise.allSettled`; return only the filtered summary.",
		);
	}

	if (has("bash")) {
		lines.push(
			"- Search with `rg` / `fd` instead of `grep -r` / `find`: they respect `.gitignore` (skip `node_modules`, build output, worktrees) and are often 10x+ faster on large repos. Scope to a directory (`rg -n foo src/components`) and limit output with `-l`, `-c`, or `--max-count`.",
		);
	}

	if (has("read")) {
		lines.push(
			"- Read files with `read` plus `offset`/`limit` instead of repeated `sed -n` / `cat` calls. Read the needed range once; do not re-read files already in context.",
		);
	}

	if (has("bash")) {
		const timeout = timeoutSeconds > 0 ? timeoutSeconds : 300;
		lines.push(
			"- Tests, builds, typechecks:",
			"  - Run only what the change touches (`vitest related <changed files> --run`, `bun test <file>`, `pytest <file>`), not the whole suite unless asked.",
			`  - Pass a bash \`timeout\` (e.g. ${timeout}) so a hung run cannot block the session.`,
			"  - Pipe through `tail -n 40` or `rg 'fail|error|✗|×'` so only failures reach context.",
			"  - A full-project typecheck on a large repo can take minutes: run it once at the end, not after every edit.",
			"- Long-lived processes (dev servers, watchers) go in the background: `nohup <cmd> > /tmp/<name>.log 2>&1 &`, then read the log. Delegate heavy verify or lint passes to an async subagent when one is available, and keep working.",
		);
	}

	return lines.join("\n");
}
