import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readDefaultTools, readFastToolsSetting, writeFastToolsSetting } from "../src/settings-file.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-fast-tools-settings-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `s${n++}`, "settings.json");

test("creates the file and parent directory when missing", () => {
	const f = file();
	writeFastToolsSetting(f, "codemode", true);
	assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { fastTools: { codemode: true } });
});

test("changes only fastTools.<key> and keeps every other key and order", () => {
	const f = file();
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, JSON.stringify({ a: 1, fastTools: { timeoutSeconds: 900, guard: true }, z: [1, 2] }, null, 2));
	writeFastToolsSetting(f, "guard", false);
	const out = JSON.parse(readFileSync(f, "utf8"));
	assert.deepEqual(out, { a: 1, fastTools: { timeoutSeconds: 900, guard: false }, z: [1, 2] });
	assert.deepEqual(Object.keys(out), ["a", "fastTools", "z"]);
});

test("handles a BOM and an empty file", () => {
	const f = file();
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, '\uFEFF{"x":true}');
	writeFastToolsSetting(f, "rules", false);
	assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { x: true, fastTools: { rules: false } });
	writeFileSync(f, "");
	writeFastToolsSetting(f, "rules", true);
	assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { fastTools: { rules: true } });
});

test("replaces a non-object fastTools value", () => {
	const f = file();
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, JSON.stringify({ fastTools: "oops" }));
	writeFastToolsSetting(f, "guard", true);
	assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { fastTools: { guard: true } });
});

test("refuses invalid JSON and non-object JSON, leaving the file untouched", () => {
	for (const content of ["{ broken", "[1,2]", "42"]) {
		const f = file();
		mkdirSync(join(f, ".."), { recursive: true });
		writeFileSync(f, content);
		assert.throws(() => writeFastToolsSetting(f, "guard", false), /not modified/);
		assert.equal(readFileSync(f, "utf8"), content);
	}
});

test("releases the lock and leaves no temp files", () => {
	const f = file();
	writeFastToolsSetting(f, "guard", true);
	writeFastToolsSetting(f, "guard", false);
	assert.ok(!existsSync(`${f}.lock`));
	assert.deepEqual(readdirSync(join(f, "..")), ["settings.json"]);
});

test("waits for a held lock, then fails loudly instead of writing", () => {
	const f = file();
	writeFastToolsSetting(f, "guard", true);
	mkdirSync(`${f}.lock`);
	assert.throws(() => writeFastToolsSetting(f, "guard", false), /locked/);
	assert.equal(JSON.parse(readFileSync(f, "utf8")).fastTools.guard, true);
	rmSync(`${f}.lock`, { recursive: true });
});

test("takes over a stale lock", () => {
	const f = file();
	writeFastToolsSetting(f, "guard", true);
	mkdirSync(`${f}.lock`);
	const old = new Date(Date.now() - 60_000);
	utimesSync(`${f}.lock`, old, old);
	writeFastToolsSetting(f, "guard", false);
	assert.equal(JSON.parse(readFileSync(f, "utf8")).fastTools.guard, false);
	assert.ok(!existsSync(`${f}.lock`));
});

test("readers tolerate missing and broken files", () => {
	const f = file();
	assert.equal(readFastToolsSetting(f, "guard"), undefined);
	assert.deepEqual(readDefaultTools(f), []);
	writeFastToolsSetting(f, "codemode", false);
	assert.equal(readFastToolsSetting(f, "codemode"), false);
	writeFileSync(f, JSON.stringify({ defaultTools: ["+codemode", 3] }));
	assert.deepEqual(readDefaultTools(f), ["+codemode"]);
});
