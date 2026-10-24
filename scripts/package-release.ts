#!/usr/bin/env bun
/**
 * Build the cross-platform release artifacts.
 *
 * Usage: bun run release:package
 *
 * Produces dist/release containing:
 *   - labunbun_<version>~alpha1_amd64.deb
 *   - labunbun_<version>~alpha1_arm64.deb
 *   - labunbun-<version>-alpha1.x86_64.rpm
 *   - labunbun-<version>-alpha1.aarch64.rpm
 *   - LaBunbun-Code-<version>-alpha-x86_64.AppImage
 *   - LaBunbun-Code-<version>-alpha-aarch64.AppImage
 *   - labunbun-<version>-alpha-darwin-arm64.zip
 *   - labunbun-<version>-alpha-darwin-x64.zip
 *
 * The Windows installer is produced separately by `bun run installer:build`;
 * this script copies it into dist/release when it is present. The AppImage
 * runtimes are downloaded from AppImageKit and pinned by SHA-256; set
 * LABUNBUN_APPIMAGE_RUNTIME_X86_64 or LABUNBUN_APPIMAGE_RUNTIME_AARCH64 to a
 * local file to use a different runtime.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAppImage, buildDeb, buildRpm, buildZip, type DebFile, type SquashfsEntry } from "./release-archives.ts";

const REPO = resolve(import.meta.dir, "..");
const DIST = join(REPO, "dist");
const WORK = join(DIST, "work");
const RELEASE = join(DIST, "release");

const HOMEPAGE = "https://github.com/zayokami/labunbun-code";
const MAINTAINER = "zayokami <labunbun@zayoka.com>";
const README = readFileSync(join(REPO, "README.md"));
const LICENSE = readFileSync(join(REPO, "LICENSE"));

const version = readVersion();
const debVersion = `${version}~alpha1`;
const mtime = sourceDateEpoch();

function readVersion(): string {
	const source = readFileSync(join(REPO, "packages", "coding-agent", "src", "cli-constants.ts"), "utf8");
	const match = source.match(/CODING_AGENT_VERSION = "([^"]+)"/);
	if (!match) throw new Error("CODING_AGENT_VERSION was not found in cli-constants.ts");
	return match[1];
}

function sourceDateEpoch(): number {
	const raw = process.env.SOURCE_DATE_EPOCH;
	const value = raw ? Number(raw) : Math.floor(Date.now() / 1000);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`SOURCE_DATE_EPOCH is not a timestamp: ${raw}`);
	return value;
}

function build(bunTarget: string, name: string): string {
	const outfile = join(WORK, name);
	console.log(`\nBuilding ${bunTarget}`);
	const result = spawnSync(
		process.execPath,
		[
			"build",
			"--compile",
			"--minify",
			`--target=${bunTarget}`,
			"packages/coding-agent/src/main.ts",
			"--outfile",
			outfile,
		],
		{ cwd: REPO, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`bun build failed for ${bunTarget} with status ${result.status}`);
	return outfile;
}

function docs(): DebFile[] {
	return [
		{ path: "usr/share/doc/labunbun/README.md", mode: 0o644, data: README },
		{ path: "usr/share/doc/labunbun/copyright", mode: 0o644, data: LICENSE },
	];
}

const APPIMAGE_RUNTIMES = {
	x86_64: {
		url: "https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64",
		sha256: "66f5b22f035022b8bdebb54c066aa6edc7b5db282fe6cdb372e7965f80772557",
	},
	aarch64: {
		url: "https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-aarch64",
		sha256: "a9c09a26acb16590370e1ad0310c6f49b2677b0cecc9037fa74bdd53ec5e891f",
	},
} as const;

async function appImageRuntime(architecture: keyof typeof APPIMAGE_RUNTIMES): Promise<Buffer> {
	const override = process.env[`LABUNBUN_APPIMAGE_RUNTIME_${architecture.toUpperCase()}`];
	if (override) return readFileSync(override);
	const cache = join(WORK, "appimage-runtime");
	const target = join(cache, `runtime-${architecture}`);
	if (existsSync(target)) {
		const cached = readFileSync(target);
		const digest = createHash("sha256").update(cached).digest("hex");
		if (digest === APPIMAGE_RUNTIMES[architecture].sha256) return cached;
		rmSync(target, { force: true });
	}
	const spec = APPIMAGE_RUNTIMES[architecture];
	console.log(`\nDownloading the AppImage ${architecture} runtime`);
	const response = await fetch(spec.url);
	if (!response.ok) throw new Error(`AppImage runtime download failed: ${response.status} ${response.statusText}`);
	const runtime = Buffer.from(await response.arrayBuffer());
	const digest = createHash("sha256").update(runtime).digest("hex");
	if (digest !== spec.sha256)
		throw new Error(`AppImage runtime ${architecture} has SHA-256 ${digest}, expected ${spec.sha256}`);
	mkdirSync(cache, { recursive: true });
	writeFileSync(target, runtime);
	return runtime;
}

const DESKTOP_ENTRY = [
	"[Desktop Entry]",
	"Type=Application",
	"Name=LaBunbun Code",
	"Comment=Terminal coding agent",
	"Exec=labunbun",
	"Icon=utilities-terminal",
	"Terminal=true",
	"Categories=Development;",
	"",
].join("\n");

function writeDeb(architecture: string, binary: Buffer): string {
	const artifact = join(RELEASE, `labunbun_${debVersion}_${architecture}.deb`);
	const data = buildDeb({
		packageName: "labunbun",
		version: debVersion,
		architecture,
		maintainer: MAINTAINER,
		homepage: HOMEPAGE,
		description: [
			"terminal coding agent",
			"LaBunbun Code is a terminal coding agent with sandboxed tool execution,",
			"provider migration, and offline binary inspection.",
		],
		files: [{ path: "usr/bin/labunbun", mode: 0o755, data: binary }, ...docs()],
		mtime,
	});
	writeFileSync(artifact, data);
	return artifact;
}

function writeRpm(architecture: "x86_64" | "aarch64", binary: Buffer): string {
	const artifact = join(RELEASE, `labunbun-${version}-alpha1.${architecture}.rpm`);
	const data = buildRpm({
		packageName: "labunbun",
		version,
		release: "alpha1",
		architecture,
		summary: "terminal coding agent",
		description: [
			"LaBunbun Code is a terminal coding agent with sandboxed tool execution,",
			"provider migration, and offline binary inspection.",
		],
		license: "MIT",
		maintainer: MAINTAINER,
		homepage: HOMEPAGE,
		mtime,
		files: [{ path: "usr/bin/labunbun", mode: 0o755, data: binary }, ...docs()],
	});
	writeFileSync(artifact, data);
	return artifact;
}

function writeAppImage(architecture: "x86_64" | "aarch64", binary: Buffer, runtime: Buffer): string {
	const artifact = join(RELEASE, `LaBunbun-Code-${version}-alpha-${architecture}.AppImage`);
	const entries: SquashfsEntry[] = [
		{ path: "AppRun", mode: 0o755, symlink: "usr/bin/labunbun" },
		{ path: "labunbun.desktop", mode: 0o644, data: Buffer.from(DESKTOP_ENTRY, "utf8") },
		{ path: "usr/bin/labunbun", mode: 0o755, data: binary },
		...docs(),
	];
	writeFileSync(artifact, buildAppImage(runtime, entries, mtime));
	return artifact;
}

function writeZip(architecture: string, binary: Buffer): string {
	const root = `labunbun-${version}-alpha-darwin-${architecture}`;
	const artifact = join(RELEASE, `${root}.zip`);
	const data = buildZip(
		[
			{ name: `${root}/`, mode: 0o755, data: Buffer.alloc(0), directory: true },
			{ name: `${root}/labunbun`, mode: 0o755, data: binary },
			{ name: `${root}/README.md`, mode: 0o644, data: README },
			{ name: `${root}/LICENSE`, mode: 0o644, data: LICENSE },
		],
		new Date(mtime * 1000),
	);
	writeFileSync(artifact, data);
	return artifact;
}

rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });
mkdirSync(WORK, { recursive: true });

for (const target of [
	{ bunTarget: "bun-linux-x64", architecture: "amd64", rpmArchitecture: "x86_64", name: "labunbun-linux-x64" },
	{ bunTarget: "bun-linux-arm64", architecture: "arm64", rpmArchitecture: "aarch64", name: "labunbun-linux-arm64" },
] as const) {
	const binary = readFileSync(build(target.bunTarget, target.name));
	writeDeb(target.architecture, binary);
	writeRpm(target.rpmArchitecture, binary);
	writeAppImage(target.rpmArchitecture, binary, await appImageRuntime(target.rpmArchitecture));
}

for (const target of [
	{ bunTarget: "bun-darwin-arm64", architecture: "arm64", name: "labunbun-darwin-arm64" },
	{ bunTarget: "bun-darwin-x64", architecture: "x64", name: "labunbun-darwin-x64" },
]) {
	writeZip(target.architecture, readFileSync(build(target.bunTarget, target.name)));
}

const setupName = `LaBunbun-Code-${version}-alpha-x64-setup.exe`;
const setup = join(DIST, setupName);
if (existsSync(setup)) {
	copyFileSync(setup, join(RELEASE, setupName));
} else {
	console.log(`\nNo Windows installer at ${setup}; run bun run bin:build and bun run installer:build first.`);
}

console.log("\nRelease artifacts:");
for (const name of readdirSync(RELEASE).sort()) {
	const data = readFileSync(join(RELEASE, name));
	const digest = createHash("sha256").update(data).digest("hex");
	console.log(`  ${digest}  ${name}  (${(data.length / 1048576).toFixed(1)} MiB)`);
}
