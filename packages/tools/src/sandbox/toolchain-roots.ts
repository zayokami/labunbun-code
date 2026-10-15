/**
 * Which directories a toolchain occupies, and which of them a confined child
 * may be granted read+execute on.
 *
 * Pure string and file questions, split out of `operations.ts` so the sandbox
 * layers can ask them without importing the tool layer that imports the
 * sandbox — the cycle `operations → sandbox/index → toolchain-roots` would
 * otherwise exist. The Windows path semantics are implemented literally
 * (`[\\/]` splitting, case-insensitive comparison) so every row runs on every
 * platform instead of following `node:path`'s host.
 *
 * The rules are the grant boundary the AppContainer backend rests on: an
 * install root gets read+execute, and a root that is a drive, a share, or the
 * user profile (or an ancestor of it) is never granted at all.
 */
import { statSync } from "node:fs";

/** A path that exists and is a file — a directory named `bash.exe` is not one. */
export function isFileSync(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Every PATH directory that could hold an executable by that name, in order.
 *
 * Windows PATH syntax, literally: `;` separators, optional quotes, and a
 * drive-letter prefix — so a POSIX PATH yields no candidates anywhere.
 */
export function* pathCandidates(name: string, pathValue: string = process.env.PATH ?? ""): Generator<string> {
	for (const entry of pathValue.split(";")) {
		const dir = entry
			.trim()
			.replace(/^"|"$/g, "")
			.replace(/[\\/]+$/, "");
		if (!/^[A-Za-z]:[\\/]/.test(dir)) continue;
		yield `${dir.replace(/\//g, "\\")}\\${name}`;
	}
}

/** Directory names that hold executables inside an install, not the install itself. */
const BIN_CLASS_COMPONENTS = new Set(["bin", "cmd", "sbin", "mingw64", "mingw32", "libexec"]);

function windowsPath(path: string): string {
	return path.replace(/\//g, "\\");
}

/** The parent of an already-normalised Windows path; `C:\a` → `C:\`. */
function parentOf(path: string): string {
	const last = path.lastIndexOf("\\");
	if (last < 0) return "";
	const parent = path.slice(0, last);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function lastComponent(path: string): string {
	const trimmed = path.replace(/\\+$/, "");
	const last = trimmed.lastIndexOf("\\");
	return last < 0 ? trimmed : trimmed.slice(last + 1);
}

/**
 * The install root a program lives in: the directory a grant should name, or
 * null when the path cannot be one (null, relative, or a bare program name).
 *
 * The climb walks up only through directory names that hold executables
 * inside an install (`bin`, `cmd`, `mingw64`, …) and stops at the first
 * ordinary directory. `D:\Program Files\Git\mingw64\bin\git.exe` lands on
 * `D:\Program Files\Git` — one root that also covers the sibling `usr\bin`
 * the MSYS runtime lives in — while `C:\Users\x\projects\thing.exe` stays
 * where it is. Monotone on purpose: every further step is a wider grant.
 */
export function installRootOf(program: string | null | undefined): string | null {
	if (program === null || program === undefined) return null;
	const normalized = windowsPath(program.trim());
	if (!/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) return null;
	let dir = parentOf(normalized);
	if (dir === "") return null;
	while (BIN_CLASS_COMPONENTS.has(lastComponent(dir).toLowerCase())) {
		const parent = parentOf(dir);
		if (parent === "" || parent === dir) break;
		dir = parent;
	}
	return dir;
}

export interface ToolchainRootOptions {
	/** The user profile directory: its own path, and every ancestor of it, is never granted. */
	home?: string;
}

/**
 * The grantable roots for a set of programs: one per install (deduplicated,
 * first spelling wins), with the too-wide answers dropped.
 *
 * Refused: a drive root, a share root, the user profile itself, any ancestor
 * of it, and everything `installRootOf` rejects. The refusal is silent — the
 * caller proves reachability by running the program in the container, which
 * is the only evidence there is; a wrong root here is a grant wider than the
 * toolchain, so this function drops, never widens.
 */
export function toolchainRootsFor(
	programs: ReadonlyArray<string | null | undefined>,
	options: ToolchainRootOptions = {},
): string[] {
	const home = windowsPath(options.home ?? process.env.USERPROFILE ?? "")
		.replace(/\\+$/, "")
		.toLowerCase();
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const program of programs) {
		const root = installRootOf(program);
		if (root === null) continue;
		const key = root.toLowerCase();
		if (/^[a-z]:\\$/.test(key)) continue;
		if (key.startsWith("\\\\") && key.split("\\").filter(Boolean).length <= 2) continue;
		if (home !== "" && (key === home || home.startsWith(`${key}\\`))) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(root);
	}
	return roots;
}

/** The programs whose absence from a container would break a session's toolchain. */
const TOOLCHAIN_PROGRAMS = ["git.exe", "node.exe", "bun.exe"] as const;

/**
 * The toolchain roots a confined session needs: the shell's install root,
 * those of the toolchain programs that resolve (one PATH scan), and the known
 * `~\.bun\bin` fallback. `System32` is dropped — it is the one directory
 * every container child runs from without a grant.
 */
export function detectExecutableRoots(
	shellCommand: string | null | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
	const programs: Array<string | null> = [shellCommand ?? null];
	const pathValue = env.PATH ?? env.Path ?? "";
	for (const name of TOOLCHAIN_PROGRAMS) {
		let found: string | null = null;
		for (const candidate of pathCandidates(name, pathValue)) {
			if (isFileSync(candidate)) {
				found = candidate;
				break;
			}
		}
		programs.push(found);
	}
	const home = env.USERPROFILE ?? "";
	if (home !== "") {
		const bun = `${windowsPath(home).replace(/\\+$/, "")}\\.bun\\bin\\bun.exe`;
		if (isFileSync(bun)) programs.push(bun);
	}
	const systemRoot = windowsPath(env.SystemRoot ?? env.windir ?? "C:\\Windows").replace(/\\+$/, "");
	const system32 = `${systemRoot}\\system32`.toLowerCase();
	return toolchainRootsFor(programs, { home }).filter((root) => root.toLowerCase() !== system32);
}
