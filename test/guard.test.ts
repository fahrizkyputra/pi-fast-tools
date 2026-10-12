import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addGrepExcludes,
	addTscHeap,
	type BashInput,
	DEFAULT_EXCLUDE_DIRS,
	DEFAULT_GUARD_OPTIONS,
	guardBashInput,
	isLongRunning,
} from "../src/guard.ts";

const DIRS = DEFAULT_EXCLUDE_DIRS;
const FLAGS = DIRS.map((d) => `--exclude-dir=${d}`).join(" ");

const run = (command: string, timeout?: number) => {
	const input: BashInput = timeout === undefined ? { command } : { command, timeout };
	guardBashInput(input, DEFAULT_GUARD_OPTIONS);
	return input;
};

test("recursive grep gets every exclude-dir flag right after its options", () => {
	assert.equal(addGrepExcludes("grep -rn foo src", DIRS), `grep -rn ${FLAGS} foo src`);
});

test("recursive grep variants are all covered", () => {
	for (const cmd of ["grep -R foo .", "grep -rln foo .", "grep -nr foo .", "egrep -r foo .", "command grep -rn foo .", "grep -rnE 'a|b' ."]) {
		assert.ok(addGrepExcludes(cmd, DIRS).includes("--exclude-dir=node_modules"), cmd);
	}
});

test("grep inside pipelines, chains, and subshells is rewritten", () => {
	assert.ok(addGrepExcludes("cd x && grep -rln q . | head", DIRS).startsWith(`cd x && grep -rln ${FLAGS} q . | head`));
	assert.ok(addGrepExcludes("echo hi | grep -rn x .", DIRS).includes("--exclude-dir"));
	assert.ok(addGrepExcludes("n=$(grep -rl x . | wc -l)", DIRS).includes("--exclude-dir"));
	assert.ok(addGrepExcludes("a; grep -rn x .", DIRS).includes("--exclude-dir"));
});

test("only the recursive grep segment is touched; the rest of the command is preserved", () => {
	const out = addGrepExcludes("grep -rn foo src | grep -v test | head -5", DIRS);
	assert.equal(out, `grep -rn ${FLAGS} foo src | grep -v test | head -5`);
});

test("multiple recursive greps in one command are each rewritten", () => {
	const out = addGrepExcludes("grep -rn a src; grep -rl b lib", DIRS);
	assert.equal(out.split("--exclude-dir=node_modules").length - 1, 2);
});

test("non-recursive grep is untouched", () => {
	for (const cmd of ["grep -n foo file.ts", "command grep -E '^ fail' log", "ps aux | grep node", "grep -rn"]) {
		assert.equal(addGrepExcludes(cmd, DIRS), cmd);
	}
});

test("words that merely contain grep are untouched", () => {
	for (const cmd of ["ripgrep -r x", "pgrep -r node", "git grep -n foo", "rg -n foo src"]) {
		assert.equal(addGrepExcludes(cmd, DIRS), cmd, cmd);
	}
});

test("grep that targets an excluded directory on purpose is untouched", () => {
	for (const cmd of [
		"grep -rn foo node_modules/next/dist",
		"grep -rn x .next/server",
		"grep -rn x ./dist",
		"grep -rn x 'node_modules/react'",
		"grep -rn x src/__pycache__",
	]) {
		assert.equal(addGrepExcludes(cmd, DIRS), cmd, cmd);
	}
});

test("directory names inside patterns or other paths do not count as targeting", () => {
	assert.ok(addGrepExcludes('grep -rn "distance" src', DIRS).includes("--exclude-dir"));
	assert.ok(addGrepExcludes("grep -rn outbound src/routes", DIRS).includes("--exclude-dir"));
	assert.ok(addGrepExcludes("grep -rn x src/builder", DIRS).includes("--exclude-dir"));
});

test("an existing --exclude-dir disables the rewrite", () => {
	const cmd = "grep -rn --exclude-dir=vendor foo .";
	assert.equal(addGrepExcludes(cmd, DIRS), cmd);
});

test("empty exclude list disables the rewrite", () => {
	assert.equal(addGrepExcludes("grep -rn foo .", []), "grep -rn foo .");
});

test("custom exclude dirs with regex characters are escaped", () => {
	const out = addGrepExcludes("grep -rn x a+b", ["a+b"]);
	assert.equal(out, "grep -rn x a+b");
	assert.equal(addGrepExcludes("grep -rn x aab", ["a+b"]), "grep -rn --exclude-dir=a+b x aab");
});

test("tsc gets a larger heap", () => {
	assert.equal(addTscHeap("node_modules/.bin/tsc --noEmit", 8192), 'export NODE_OPTIONS="--max-old-space-size=8192"\nnode_modules/.bin/tsc --noEmit');
	assert.ok(addTscHeap("cd web && npx tsc -p .", 4096).startsWith('export NODE_OPTIONS="--max-old-space-size=4096"'));
	assert.ok(addTscHeap("tsgo --noEmit", 8192).includes("max-old-space-size"));
});

test("tsc heap respects explicit NODE_OPTIONS and the off switch", () => {
	const explicit = "NODE_OPTIONS=--max-old-space-size=2048 tsc --noEmit";
	assert.equal(addTscHeap(explicit, 8192), explicit);
	assert.equal(addTscHeap("tsc --noEmit", 0), "tsc --noEmit");
	assert.equal(addTscHeap("echo tscope", 8192), "echo tscope");
	assert.equal(addTscHeap("cat tsconfig.json", 8192), "cat tsconfig.json");
});

test("long-running commands are detected", () => {
	for (const cmd of [
		"node_modules/.bin/vitest run src/a",
		"bun test src/x 2>&1 | tail",
		"npx jest",
		"npm run build",
		"pnpm test",
		"yarn lint",
		"bun run typecheck",
		"node verify.mjs",
		"node scripts/verify-workspace-routing.mjs",
		"npx eslint src",
		"pytest tests/",
		"npx playwright test",
		"next build",
		"npx vite build",
		"bun test a && bun test b",
	]) {
		assert.ok(isLongRunning(cmd), cmd);
	}
});

test("short and long-lived commands are not treated as long-running", () => {
	for (const cmd of [
		"ls -la",
		"git status",
		"nohup next dev -p 3010 > /tmp/l &",
		"vitest --watch",
		"tsc -w -p .",
		"npx vite --port 5173",
		"npm run dev &",
		"bun test src/x &",
		"npx storybook dev -p 6006",
		"docusaurus start --port 3333",
	]) {
		assert.ok(!isLongRunning(cmd), cmd);
	}
});

test("guard adds a timeout only when none is set", () => {
	assert.equal(run("bun test src/x").timeout, 600);
	assert.equal(run("bun test src/x", 30).timeout, 30);
	assert.equal(run("ls").timeout, undefined);
	assert.equal(run("nohup next dev > /tmp/x &").timeout, undefined);
});

test("guard combines all rewrites on one command", () => {
	const input = run("grep -rln foo src && node_modules/.bin/tsc --noEmit");
	assert.ok(input.command.startsWith('export NODE_OPTIONS="--max-old-space-size=8192"\n'));
	assert.ok(input.command.includes("--exclude-dir=node_modules"));
	assert.equal(input.timeout, 600);
});

test("guard reports whether it changed anything", () => {
	assert.equal(guardBashInput({ command: "ls" }), false);
	assert.equal(guardBashInput({ command: "grep -rn x ." }), true);
	assert.equal(guardBashInput({ command: "bun test" }), true);
});

test("guard options can switch each rewrite off", () => {
	const input: BashInput = { command: "grep -rn x . && tsc && bun test" };
	guardBashInput(input, { excludeDirs: [], timeoutSeconds: 0, tscHeapMb: 0 });
	assert.deepEqual(input, { command: "grep -rn x . && tsc && bun test" });
});

test("non-string commands are ignored", () => {
	const input = { command: 42 } as unknown as BashInput;
	assert.equal(guardBashInput(input), false);
	assert.equal(input.command as unknown, 42);
});
