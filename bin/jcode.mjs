#!/usr/bin/env node
/**
 * jcode installer: `npx -y <this package> jcode install`.
 *
 * Node refuses to strip TypeScript types under node_modules, so the jcode
 * side cannot run from the npm cache. This copies `jcode/` and `src/` into
 * `~/.jcode/plugins/<package>/` (replacing an older copy) and runs the
 * installer from there. Every other command goes straight to that copy.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = pkg.name.split("/").pop();
const home = process.env.JCODE_HOME?.trim() || join(homedir(), ".jcode");
const target = join(home, "plugins", name);

const [scope, command = "install", ...rest] = process.argv.slice(2);
if (scope !== "jcode") {
	console.error(
		[
			`${pkg.name} is a Pi package. In Pi: pi install npm:${pkg.name}`,
			`For jcode: npx -y ${pkg.name} jcode install   (then: npx -y ${pkg.name} jcode uninstall to remove)`,
		].join("\n"),
	);
	process.exit(2);
}

if (!process.features?.typescript) {
	console.error(`${name}: needs Node 22.18+ (runs TypeScript directly); this is ${process.version}.`);
	process.exit(1);
}

if (command === "install") {
	rmSync(target, { recursive: true, force: true });
	for (const dir of ["jcode", "src"]) cpSync(join(root, dir), join(target, dir), { recursive: true });
	cpSync(join(root, "package.json"), join(target, "package.json"));
} else if (!existsSync(join(target, "jcode", "cli.ts"))) {
	console.error(`${name} is not installed for jcode. Run: npx -y ${pkg.name} jcode install`);
	process.exit(1);
}

const result = spawnSync(process.execPath, ["--no-warnings", join(target, "jcode", "cli.ts"), command, ...rest], { stdio: "inherit" });
process.exit(result.status ?? 1);
