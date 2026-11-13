// Cindy's Electron userData roots, the per-owner database inside them, and the
// home-relative directories it shares. Read `cindy-read.ts` next for what is
// opened; every path claim is quoted here.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The environment block a root is resolved from; injectable so tests need no `process.env`. */
export type CindyEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `~/.cindy` — the home-relative directory Cindy keeps beside its Electron
 * userData root: local themes, auth-boundary lock files. It is the one root
 * every platform spells the same way, so it is also the label `SOURCE_ROOTS`
 * carries; `sourceRoot` resolves the real userData tree.
 */
export const CINDY_DEFAULT_DIR = ".cindy";

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.xdmaker`, the pre-rename spelling of {@link CINDY_DEFAULT_DIR}. Read for local themes; never written. */
export const CINDY_LEGACY_DIR = ".xdmaker";

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Electron `userData` directory names, in read order: the default Global build,
 * the China build, the dev build, and the pre-rename shared name. They are four
 * independent installs that may coexist on one machine, and a user's data can
 * be in any of them. `CindyGlobal` is first because it is the default region's
 * name, not because it is more likely to hold the user's account.
 */
export const CINDY_USER_DATA_DIR_NAMES: readonly string[] = ["CindyGlobal", "Cindy", "CindyDev", "xdt-maker"];

/** The default region's userData directory name, used when no candidate exists yet. */
export const CINDY_DEFAULT_USER_DATA_DIR = "CindyGlobal";

// Long-form design notes: docs/dev/migration-sources.md
/** Database filename prefixes: `<prefix>-<ownerId>.db`. `xdt-maker` is the pre-rename spelling. */
export const CINDY_DB_PREFIXES: readonly string[] = ["cindy", "xdt-maker"];

/** A database filename this importer will open: one of the prefixes, and no sidecar suffix. */
const CINDY_DB_FILE = /^(?:cindy|xdt-maker)-.+\.db$/i;

// Long-form design notes: docs/dev/migration-sources.md
/** `APPDATA`, trimmed, or `undefined`. No `process.platform` test, so a fixture works on every CI job. */
export function cindyAppData(env: CindyEnv = process.env): string | undefined {
	const value = env.APPDATA;
	return value === undefined || value.trim() === "" ? undefined : value;
}

/** `$XDG_CONFIG_HOME`, trimmed, or the Linux default `~/.config`. */
function cindyConfigBase(home: string, env: CindyEnv): string {
	const value = env.XDG_CONFIG_HOME;
	return value === undefined || value.trim() === "" ? join(home, ".config") : value;
}

/**
 * Every base directory an Electron `userData` directory has sat under on some
 * platform: `%APPDATA%` and its home-relative default, macOS's Application
 * Support, and the XDG configuration base. All four are returned everywhere —
 * a path that does not exist contributes nothing, and a fixture on Windows can
 * therefore exercise the macOS and Linux spellings without a platform test.
 */
export function cindyUserDataBases(home: string, env: CindyEnv = process.env): string[] {
	const bases: string[] = [];
	const appData = cindyAppData(env);
	if (appData !== undefined) bases.push(appData);
	bases.push(join(home, "AppData", "Roaming"));
	bases.push(join(home, "Library", "Application Support"));
	bases.push(cindyConfigBase(home, env));
	const seen = new Set<string>();
	return bases.filter((base) => {
		if (seen.has(base)) return false;
		seen.add(base);
		return true;
	});
}

/** Every `userData` directory this importer will consider, whether or not it exists. */
export function cindyUserDataDirs(home: string, env: CindyEnv = process.env): string[] {
	const dirs: string[] = [];
	for (const base of cindyUserDataBases(home, env)) {
		for (const name of CINDY_USER_DATA_DIR_NAMES) dirs.push(join(base, name));
	}
	return dirs;
}

/** Whether a directory exists and holds something, as detection reads it. */
export function cindyTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Every root whose being non-empty means "Cindy has run on this machine": the
 * four userData trees plus the two home-relative directories. A build that has
 * been installed but never signed in has a userData tree with cache and logs in
 * it, which is still the right answer: the source exists, and the reader says
 * no database was found rather than the source disappearing.
 */
export function cindyDetectionRoots(home: string, env: CindyEnv = process.env): string[] {
	return [...cindyUserDataDirs(home, env), join(home, CINDY_DEFAULT_DIR), join(home, CINDY_LEGACY_DIR)];
}

/** The first userData directory that holds something, or `null`. */
export function cindyFirstUserDataDir(home: string, env: CindyEnv = process.env): string | null {
	for (const dir of cindyUserDataDirs(home, env)) {
		if (cindyTreeHasContent(dir)) return dir;
	}
	return null;
}

/** Local theme directories, current spelling first: `~/.cindy/themes`, then `~/.xdmaker/themes`. */
export function cindyThemeDirs(home: string): string[] {
	return [join(home, CINDY_DEFAULT_DIR, "themes"), join(home, CINDY_LEGACY_DIR, "themes")];
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

/** One `<userData>/<prefix>-<ownerId>.db` file this importer found. */
export interface CindyDatabaseFile {
	/** Absolute path to the main database file. The `-wal` and `-shm` sidecars are not listed. */
	path: string;
	/** The userData directory the file sits in. */
	userDataDir: string;
	/** `cindy` or `xdt-maker`. */
	prefix: string;
	/** Last write time in epoch ms, 0 when the file's metadata could not be read. */
	mtimeMs: number;
}

/**
 * Every owner database on disk, most recently written first.
 *
 * Cindy slices its local database per signed-in owner: `<userData>/cindy-<ownerId>.db`
 * (`ownerDatabasePath`, `modelDefaultsProfile.ts:10-12`), and a machine that
 * has signed in with two accounts has two files. This importer reads exactly
 * one — the newest — because merging two accounts' MCP servers and providers
 * would hand the user configuration that was deliberately isolated, and because
 * a session listing that mixed accounts could not be filed under one identity.
 * The others are counted and named in the report.
 */
export function cindyOwnerDatabases(home: string, env: CindyEnv = process.env): CindyDatabaseFile[] {
	const found: CindyDatabaseFile[] = [];
	const seen = new Set<string>();
	for (const dir of cindyUserDataDirs(home, env)) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!CINDY_DB_FILE.test(name)) continue;
			const path = join(dir, name);
			if (seen.has(path)) continue;
			seen.add(path);
			let mtimeMs = 0;
			try {
				const stat = statSync(path);
				if (!stat.isFile()) continue;
				mtimeMs = stat.mtimeMs;
			} catch {
				continue;
			}
			const prefix = name.toLowerCase().startsWith("xdt-maker-") ? "xdt-maker" : "cindy";
			found.push({ path, userDataDir: dir, prefix, mtimeMs });
		}
	}
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}
