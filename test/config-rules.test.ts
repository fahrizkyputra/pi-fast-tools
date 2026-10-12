import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";
import { DEFAULT_EXCLUDE_DIRS } from "../src/guard.ts";
import { buildRules } from "../src/rules.ts";

test("missing or malformed settings give defaults", () => {
	for (const s of [undefined, null, {}, { fastTools: "yes" }, { fastTools: [] }, 7]) {
		assert.deepEqual(resolveConfig(s), DEFAULT_CONFIG);
	}
});

test("defaults: guard and rules on, codemode off", () => {
	assert.equal(DEFAULT_CONFIG.guard, true);
	assert.equal(DEFAULT_CONFIG.rules, true);
	assert.equal(DEFAULT_CONFIG.codemode, false);
	assert.equal(DEFAULT_CONFIG.timeoutSeconds, 600);
	assert.equal(DEFAULT_CONFIG.tscHeapMb, 8192);
	assert.deepEqual(DEFAULT_CONFIG.excludeDirs, DEFAULT_EXCLUDE_DIRS);
});

test("valid values are applied", () => {
	const cfg = resolveConfig({
		fastTools: { guard: false, rules: false, codemode: true, timeoutSeconds: 120, tscHeapMb: 0 },
	});
	assert.equal(cfg.guard, false);
	assert.equal(cfg.rules, false);
	assert.equal(cfg.codemode, true);
	assert.equal(cfg.timeoutSeconds, 120);
	assert.equal(cfg.tscHeapMb, 0);
});

test("invalid values fall back per field", () => {
	const cfg = resolveConfig({ fastTools: { guard: "no", timeoutSeconds: -5, tscHeapMb: Number.NaN } });
	assert.equal(cfg.guard, true);
	assert.equal(cfg.timeoutSeconds, 600);
	assert.equal(cfg.tscHeapMb, 8192);
});

test("excludeDirs replaces, extraExcludeDirs appends without duplicates", () => {
	assert.deepEqual(resolveConfig({ fastTools: { excludeDirs: ["vendor", "", 3] } }).excludeDirs, ["vendor"]);
	const extra = resolveConfig({ fastTools: { extraExcludeDirs: ["vendor", "node_modules"] } }).excludeDirs;
	assert.deepEqual(extra, [...DEFAULT_EXCLUDE_DIRS, "vendor"]);
});

test("rules mention only active tools", () => {
	const minimal = buildRules([], 600);
	assert.match(minimal, /Batch independent calls/);
	assert.doesNotMatch(minimal, /codemode|rg|offset/);

	const full = buildRules(["read", "bash", "edit", "write", "codemode"], 600);
	assert.match(full, /`codemode`/);
	assert.match(full, /`rg` \/ `fd`/);
	assert.match(full, /`offset`\/`limit`/);
	assert.match(full, /timeout` \(e\.g\. 600\)/);
});

test("rules fall back to a 300 s timeout hint when the auto timeout is off", () => {
	assert.match(buildRules(["bash"], 0), /e\.g\. 300/);
});
