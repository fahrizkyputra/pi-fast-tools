/**
 * jcode `pre_tool_transform` hook: stdin is the tool input JSON, stdout is the
 * replacement (empty stdout = unchanged). Only `bash` is touched: recursive
 * grep gets `--exclude-dir` flags and `tsc`/`tsgo` a bigger heap.
 *
 * No timeout rewrite here: jcode already bounds every bash call (120 s default,
 * 600 s max) and moves an overrun to a background task instead of hanging.
 *
 * Any failure prints nothing, so jcode runs the call as the model wrote it.
 */

import { addGrepExcludes, addTscHeap } from "../src/guard.ts";
import type { FastToolsConfig } from "../src/config.ts";
import { loadSettings } from "./settings.ts";

export function transformInput(toolName: string | undefined, input: unknown, config: FastToolsConfig): Record<string, unknown> | undefined {
	if (toolName !== "bash" || !config.guard) return undefined;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.command !== "string") return undefined;
	const command = addTscHeap(addGrepExcludes(record.command, config.excludeDirs), config.tscHeapMb);
	return command === record.command ? undefined : { ...record, command };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
	try {
		const input: unknown = JSON.parse(await readStdin());
		const out = transformInput(process.env.JCODE_HOOK_TOOL_NAME, input, loadSettings());
		if (out) process.stdout.write(JSON.stringify(out));
	} catch {
		// fail open: no output
	}
}
