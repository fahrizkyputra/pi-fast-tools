/**
 * Persists one `fastTools.<key>` value into a pi settings.json file.
 *
 * - Takes the same lock directory pi uses (`<file>.lock`, created with mkdir by
 *   proper-lockfile), so a concurrent pi settings write cannot interleave.
 * - Writes through a temp file + rename, so a crash never leaves half a file.
 * - Refuses to touch a file that is not valid JSON instead of overwriting it.
 * - Only `fastTools.<key>` changes; every other key is kept as-is.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ToggleKey = "guard" | "rules" | "codemode";

const LOCK_ATTEMPTS = 25;
const LOCK_DELAY_MS = 20;
/** proper-lockfile treats a lock older than this as stale. */
const STALE_LOCK_MS = 10_000;

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// short synchronous wait, same approach pi uses for its own settings lock
	}
}

function withLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`;
	for (let attempt = 1; ; attempt++) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
			} catch {
				continue; // lock vanished between mkdir and stat: retry now
			}
			if (stale) {
				try {
					rmdirSync(lock);
				} catch {}
				continue;
			}
			if (attempt >= LOCK_ATTEMPTS) throw new Error(`settings file is locked: ${lock}`);
			sleepSync(LOCK_DELAY_MS);
		}
	}
	try {
		return fn();
	} finally {
		try {
			rmdirSync(lock);
		} catch {}
	}
}

export function writeFastToolsSetting(file: string, key: ToggleKey, value: boolean): void {
	mkdirSync(dirname(file), { recursive: true });
	withLock(file, () => {
		let settings: Record<string, unknown> = {};
		if (existsSync(file)) {
			const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
			if (text.trim() !== "") {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					throw new Error(`${file} is not valid JSON; not modified`);
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error(`${file} does not contain a JSON object; not modified`);
				}
				settings = parsed as Record<string, unknown>;
			}
		}
		const current = settings.fastTools;
		const block = typeof current === "object" && current !== null && !Array.isArray(current) ? { ...current } : {};
		settings.fastTools = { ...block, [key]: value };

		const tmp = `${file}.fast-tools-${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
		renameSync(tmp, file);
	});
}

/** Reads `fastTools.<key>` from a settings file, or undefined if absent/unreadable. */
export function readFastToolsSetting(file: string, key: ToggleKey): boolean | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { fastTools?: Record<string, unknown> };
		const value = parsed?.fastTools?.[key];
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Reads the raw `defaultTools` array from a settings file. */
export function readDefaultTools(file: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { defaultTools?: unknown };
		return Array.isArray(parsed?.defaultTools) ? parsed.defaultTools.filter((t): t is string => typeof t === "string") : [];
	} catch {
		return [];
	}
}
