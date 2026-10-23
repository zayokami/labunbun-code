#!/usr/bin/env bun
/**
 * Build the Windows installer with Inno Setup 6.
 *
 * Usage: bun run installer:build
 *
 * ISCC.exe is located from the ISCC environment variable, PATH, the Inno
 * Setup uninstall registry key, or the default install directories, in that
 * order. Nothing here assumes a particular drive or user profile.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "installer", "labunbun.iss");
const BINARY = join(REPO, "dist", "labunbun-x64.exe");

const REGISTRY_KEYS = [
	"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1",
	"HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1",
	"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1",
];

function fromPath(): string | undefined {
	const found = spawnSync("where", ["ISCC.exe"], { encoding: "utf8", windowsHide: true });
	if (found.status !== 0) return undefined;
	return found.stdout
		.split(/\r?\n/)
		.map((row) => row.trim())
		.find((row) => row.length > 0 && existsSync(row));
}

function fromRegistry(): string | undefined {
	for (const key of REGISTRY_KEYS) {
		const found = spawnSync("reg", ["query", key, "/v", "InstallLocation"], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (found.status !== 0) continue;
		const match = found.stdout.match(/REG_SZ\s+(.+)/);
		if (!match) continue;
		const candidate = join(match[1].trim(), "ISCC.exe");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function fromDefaultDirectories(): string | undefined {
	const roots = [
		process.env["ProgramFiles(x86)"],
		process.env.ProgramFiles,
		"C:\\Program Files (x86)",
		"C:\\Program Files",
	];
	for (const root of roots) {
		if (!root) continue;
		const candidate = join(root, "Inno Setup 6", "ISCC.exe");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function findIscc(): string | undefined {
	const explicit = process.env.ISCC;
	if (explicit && existsSync(explicit)) return explicit;
	return fromPath() ?? fromRegistry() ?? fromDefaultDirectories();
}

if (process.platform !== "win32") {
	console.error("The Windows installer can only be built on Windows.");
	process.exit(1);
}

const iscc = findIscc();
if (!iscc) {
	console.error("ISCC.exe was not found. Install Inno Setup 6, add it to PATH, or set ISCC to its full path.");
	process.exit(1);
}

if (!existsSync(BINARY)) {
	console.error(`The release binary is missing: ${BINARY}\nRun \`bun run bin:build\` first.`);
	process.exit(1);
}

console.log(`Using ${iscc}`);
const compiled = spawnSync(iscc, [SCRIPT], { cwd: REPO, stdio: "inherit", windowsHide: true });
if (compiled.error) {
	console.error(compiled.error.message);
	process.exit(1);
}
process.exit(compiled.status ?? 1);
