/**
 * Shared jcode plumbing for the pi-* packages (the same file ships in each one).
 *
 * jcode has no in-process extension API. A package reaches it through:
 * - hooks in `~/.jcode/config.toml` (`[hooks]` table): external commands that
 *   rewrite (`pre_tool_transform`), gate (`pre_tool`), or annotate
 *   (`post_tool_feedback`) tool calls, or observe turns (`turn_start`);
 * - `~/.jcode/prompt-overlay.md`, appended to the system prompt of new sessions;
 * - skills in `~/.jcode/skills/<name>/SKILL.md`, each also a `/name` command.
 *
 * Everything here edits only what the package owns: one command per hook key
 * (found by a marker in its path), one marked block in the overlay, its own
 * skill links and shim. Anything else in those files is left byte-for-byte.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export function jcodeHome(): string {
	const fromEnv = process.env.JCODE_HOME?.trim();
	return fromEnv ? fromEnv : join(homedir(), ".jcode");
}

export const configPath = (): string => join(jcodeHome(), "config.toml");
export const overlayPath = (): string => join(jcodeHome(), "prompt-overlay.md");
export const pluginsDir = (): string => join(jcodeHome(), "plugins");
export const shimDir = (): string => join(pluginsDir(), "bin");
export const skillsDir = (): string => join(jcodeHome(), "skills");

// ---------------------------------------------------------------- config.toml

const TABLE_HEADER = /^\s*\[{1,2}[^\]]+\]{1,2}\s*(?:#.*)?$/;
const HOOKS_HEADER = /^\s*\[hooks\]\s*(?:#.*)?$/;

interface HookEntry {
	/** First and last line index of `key = value` (a multi-line array spans several). */
	first: number;
	last: number;
	values: string[];
}

function keyPattern(key: string): RegExp {
	return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=(.*)$`);
}

/** Strings of a TOML string or array-of-strings value; throws on anything else. */
export function parseStringList(value: string): string[] {
	const text = value.trim();
	const out: string[] = [];
	const single = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(text);
	if (single?.[1]) return [unquote(single[1])];
	if (!text.startsWith("[")) throw new Error(`unsupported value: ${text}`);

	let rest = text.slice(1);
	const token = /^\s*(?:#[^\n]*\n\s*)*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#[^\n]*\n\s*)*(,|\])/;
	for (;;) {
		const closing = /^\s*(?:#[^\n]*\n\s*)*\]\s*(?:#.*)?$/.exec(rest);
		if (closing) return out;
		const match = token.exec(rest);
		if (!match?.[1]) throw new Error(`unsupported array: ${text}`);
		out.push(unquote(match[1]));
		rest = rest.slice(match[0].length);
		if (match[2] === "]") {
			if (!/^\s*(?:#.*)?$/.test(rest)) throw new Error(`unsupported array: ${text}`);
			return out;
		}
	}
}

function unquote(token: string): string {
	return token.startsWith("'") ? token.slice(1, -1) : (JSON.parse(token) as string);
}

function bracketsOpen(text: string): number {
	let depth = 0;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === "\\" && quote === '"') i++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "#") {
			const newline = text.indexOf("\n", i);
			if (newline < 0) break;
			i = newline;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "[") depth++;
		else if (char === "]") depth--;
	}
	return depth;
}

function hooksRange(lines: readonly string[]): { header: number; end: number } | undefined {
	const header = lines.findIndex((line) => HOOKS_HEADER.test(line));
	if (header < 0) return undefined;
	let end = lines.length;
	for (let i = header + 1; i < lines.length; i++) {
		if (TABLE_HEADER.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	return { header, end };
}

function findHook(lines: readonly string[], key: string): HookEntry | undefined {
	const range = hooksRange(lines);
	if (!range) return undefined;
	const pattern = keyPattern(key);
	for (let i = range.header + 1; i < range.end; i++) {
		const match = pattern.exec(lines[i] ?? "");
		if (!match) continue;
		let value = match[1] ?? "";
		let last = i;
		while (value.trim().startsWith("[") && bracketsOpen(value) > 0 && last + 1 < range.end) {
			last++;
			value += `\n${lines[last]}`;
		}
		try {
			return { first: i, last, values: parseStringList(value) };
		} catch (error) {
			throw new Error(`[hooks] ${key} in config.toml has a form this installer does not edit (${(error as Error).message}); change it by hand`);
		}
	}
	return undefined;
}

export function readHookCommands(toml: string, key: string): string[] {
	return findHook(toml.split("\n"), key)?.values ?? [];
}

/**
 * Remove every command of `key` that contains `marker`, then add `command`
 * (unless undefined). Other commands keep their order. Returns the new text.
 */
export function withHookCommand(toml: string, key: string, marker: string, command: string | undefined): string {
	const lines = toml.split("\n");
	const entry = findHook(lines, key);
	const kept = (entry?.values ?? []).filter((value) => !value.includes(marker));
	const values = command === undefined ? kept : [...kept, command];
	// One command is written as a plain string, the form jcode docs and users use most.
	const rendered = values.length === 1 ? JSON.stringify(values[0]) : `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
	const line = values.length > 0 ? `${key} = ${rendered}` : undefined;

	if (entry) {
		lines.splice(entry.first, entry.last - entry.first + 1, ...(line ? [line] : []));
		return lines.join("\n");
	}
	if (!line) return toml;
	const range = hooksRange(lines);
	if (range) {
		lines.splice(range.header + 1, 0, line);
		return lines.join("\n");
	}
	const base = toml.length === 0 || toml.endsWith("\n") ? toml : `${toml}\n`;
	return `${base}${base.length > 0 ? "\n" : ""}[hooks]\n${line}\n`;
}

/** Apply `edit` to config.toml, keeping one backup of the pre-edit file per package. */
export function editConfig(packageName: string, edit: (toml: string) => string): boolean {
	const path = configPath();
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const after = edit(before);
	if (after === before) return false;
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) copyFileSync(path, `${path}.${packageName}.bak`);
	writeFileSync(path, after);
	return true;
}

// ---------------------------------------------------------------- overlay

export function upsertBlock(text: string, name: string, body: string | undefined): string {
	const start = `<!-- ${name}:start -->`;
	const end = `<!-- ${name}:end -->`;
	const from = text.indexOf(start);
	const to = from >= 0 ? text.indexOf(end, from) : -1;
	const block = body === undefined ? "" : `${start}\n${body.trim()}\n${end}\n`;
	if (from >= 0 && to >= 0) {
		let after = text.slice(to + end.length);
		if (after.startsWith("\n")) after = after.slice(1);
		let before = text.slice(0, from);
		if (block === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
		return `${before}${block}${after}`;
	}
	if (block === "") return text;
	if (text.length === 0) return block;
	return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

export function writeOverlayBlock(name: string, body: string | undefined): void {
	const path = overlayPath();
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const after = upsertBlock(before, name, body);
	if (after === before) return;
	if (after.trim().length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, after);
}

export function hasOverlayBlock(name: string): boolean {
	const path = overlayPath();
	return existsSync(path) && readFileSync(path, "utf8").includes(`<!-- ${name}:start -->`);
}

// ---------------------------------------------------------------- commands on disk

/** Quote one argument for jcode's shell-style hook parser and for sh. */
export function quoteArg(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function nodeCommand(script: string, args: readonly string[]): string {
	return [process.execPath, "--no-warnings", script, ...args].map(quoteArg).join(" ");
}

/**
 * Write an executable sh script that runs `script` with this Node, after an
 * optional `guard` line that exits early (`[ ... ] || exit 0`). jcode spawns a
 * hook per tool call, and Node with TypeScript takes ~140 ms to start, so the
 * guard keeps calls the hook ignores at shell speed. Returns the hook command.
 */
export function writeHookScript(path: string, script: string, guard?: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${guard ? `${guard}\n` : ""}exec ${nodeCommand(script, [])}\n`, { mode: 0o755 });
	return quoteArg(path);
}

function isLinkTo(path: string, target: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
	} catch {
		return false;
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** A PATH directory under the home folder where a link to the shim can live (`~/.local/bin`). */
function userBinDir(): string | undefined {
	const candidate = join(homedir(), ".local", "bin");
	const onPath = (process.env.PATH ?? "").split(delimiter).includes(candidate);
	return onPath && existsSync(candidate) ? candidate : undefined;
}

/**
 * Write `<plugins>/bin/<name>` running `script`, and link it into `~/.local/bin`
 * when that is on PATH and the name is free. Returns how a user types it.
 */
export function installShim(name: string, script: string): string {
	const shim = join(shimDir(), name);
	mkdirSync(shimDir(), { recursive: true });
	writeFileSync(shim, `#!/bin/sh\nexec ${nodeCommand(script, [])} "$@"\n`, { mode: 0o755 });
	const bin = userBinDir();
	if (!bin) return shim;
	const link = join(bin, name);
	if (isLinkTo(link, shim)) return name;
	if (exists(link)) return shim;
	symlinkSync(shim, link);
	return name;
}

export function removeShim(name: string): void {
	const shim = join(shimDir(), name);
	const bin = userBinDir() ?? join(homedir(), ".local", "bin");
	const link = join(bin, name);
	if (isLinkTo(link, shim)) rmSync(link, { force: true });
	rmSync(shim, { force: true });
}

/** How the user types the shim right now (bare name when linked on PATH). */
export function shimCommand(name: string): string {
	const shim = join(shimDir(), name);
	const bin = userBinDir();
	return bin && isLinkTo(join(bin, name), shim) ? name : shim;
}

export function linkSkill(source: string, name: string): "linked" | "taken" {
	const link = join(skillsDir(), name);
	if (isLinkTo(link, source)) return "linked";
	if (exists(link)) return "taken";
	mkdirSync(skillsDir(), { recursive: true });
	symlinkSync(source, link);
	return "linked";
}

export function unlinkSkill(source: string, name: string): void {
	const link = join(skillsDir(), name);
	if (isLinkTo(link, source)) rmSync(link, { force: true });
}
