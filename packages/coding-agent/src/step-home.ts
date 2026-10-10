import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The directory Step Code keeps its state in when `$STEPCODE_CONFIG_DIR` names none. */
export const STEPCODE_DEFAULT_DIR = ".stepcode";

// Long-form design notes: docs/dev/migration-sources.md
/** {@link STEPCODE_DEFAULT_DIR} under the name this package's other sources use. */
export const STEP_DEFAULT_DIR = STEPCODE_DEFAULT_DIR;

// Long-form design notes: docs/dev/migration-sources.md
/** The directory Step Code used before the rename, read only as a fallback. */
export const STEPCODE_LEGACY_DIR = ".step-harness";

/**
 * `$STEPCODE_CONFIG_DIR` trimmed, else `.stepcode`.
 *
 * Blank means unset: Step reads it as `env.STEPCODE_CONFIG_DIR?.trim() ||
 * STEPCODE_CONFIG_DIR`, so a whitespace-only value is not a directory name and
 * treating it as one would read a tree Step never writes to.
 */
export function stepConfigDirName(): string {
	const configured = process.env.STEPCODE_CONFIG_DIR?.trim();
	return configured === undefined || configured === "" ? STEPCODE_DEFAULT_DIR : configured;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Where Step Code's `config.toml`, `auth.json` and `.credentials.json` live. */
export function stepConfigRoot(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName());
	const agentDir = resolve(override);
	const parent = dirname(agentDir);
	return parent === agentDir ? agentDir : parent;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `$STEP_CODING_AGENT_DIR` used verbatim, else `<root>/agent` — the session-side spelling. */
export function stepAgentDir(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName(), "agent");
	return override;
}

// Long-form design notes: docs/dev/migration-sources.md
/** {@link stepAgentDir} as the settings side spells it: tilde-expanded, falling back to `<root>/agent`. */
export function stepAssetDir(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName(), "agent");
	return expandTilde(home, override);
}

/** `<root>/agent/sessions` — where sessions sit unless a session root is configured. */
export function stepSessionsDir(root: string): string {
	return join(root, "agent", "sessions");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The session root the history importer reads: the environment override, else the setting, else `<root>/agent/sessions`. */
export function stepSessionsRoot(root: string, home: string, settingsSessionDir?: string): string {
	const override = process.env.STEP_CODING_AGENT_SESSION_DIR?.trim();
	if (override !== undefined && override !== "") return resolveAgainst(home, override);
	// Step tests the settings value for truthiness, not for blankness, so a
	// whitespace-only `sessionDir` is a (very odd) directory name rather than an
	// absent setting. Only the absent case falls through.
	if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
		return resolveAgainst(home, settingsSessionDir);
	}
	return stepSessionsDir(root);
}

/** `<home>/.step-harness` — the pre-rename tree, read only as a fallback. */
export function stepLegacyRoot(home: string): string {
	return join(home, STEPCODE_LEGACY_DIR);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The tree to read: the canonical one, or `.step-harness` when the canonical one has nothing. */
export function stepRoot(home: string): string {
	const canonical = stepConfigRoot(home);
	if (treeHasContent(canonical)) return canonical;
	if (hasAgentDirOverride()) return canonical;
	const legacy = stepLegacyRoot(home);
	return treeHasContent(legacy) ? legacy : canonical;
}

/** Whether either environment variable that moves the tree has been set. */
function hasAgentDirOverride(): boolean {
	const configDir = process.env.STEPCODE_CONFIG_DIR?.trim();
	if (configDir !== undefined && configDir !== "") return true;
	const agentDir = process.env.STEP_CODING_AGENT_DIR?.trim();
	return agentDir !== undefined && agentDir !== "";
}

/** Whether a directory exists and holds something, as `sourceHasContent` reads it. */
function treeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Step's own tilde rule, against a given home. */
function expandTilde(home: string, path: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(home, path.slice(2));
	}
	return path;
}

/** {@link expandTilde} followed by Step's absolutization: absolute stays, relative joins the home. */
function resolveAgainst(home: string, path: string): string {
	const expanded = expandTilde(home, path);
	return resolve(home, expanded);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The suffix a session file carries, matched the way Step matches it. */
const SESSION_FILE_SUFFIX = ".jsonl";

// Long-form design notes: docs/dev/migration-sources.md
/** How much of a session file the walk reads to place it. */
const SESSION_HEAD_BYTES = 64 * 1024;

/** One candidate session file, before its header is read. */
export interface StepSessionPath {
	/** The `.jsonl` file itself. */
	path: string;
	/**
	 * The directory the file sits in: a `--<cwd>--` bucket under a session root,
	 * or the session root itself when the file was written flat.
	 */
	dir: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** A session file, with every field taken from its header line. */
export interface StepSessionDir extends StepSessionPath {
	/** The header's `id`, which is the id Step resumes the session by. */
	id: string;
	/** The header's `cwd` when it names a directory, `null` when it states none. */
	cwd: string | null;
	/** The header's `timestamp` in epoch ms, 0 when it states none it can parse. */
	startedAt: number;
	/** The header's `version`, `null` when the file states none (a v1 session). */
	version: number | null;
}

/** One thing a walk passed over, and why it could not become a session. */
export interface StepSkippedEntry {
	/** The entry's own name — a file name or a directory name, never a path. */
	name: string;
	/** What it was, in the words the report prints. */
	reason: string;
}

/** Everything the walk found, and everything it passed over. */
export interface StepSessionScan {
	/** Readable sessions, in priority order: see {@link stepSessionDirs}. */
	sessions: StepSessionDir[];
	/** What was seen and left behind, each with the reason it was. */
	skipped: StepSkippedEntry[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every directory a Step session may live in, most authoritative first. */
export function stepSessionDirs(home: string): string[] {
	const chosen = stepRoot(home);
	const sessions = stepSessionsRoot(chosen, home);
	if (chosen === stepLegacyRoot(home)) return [sessions];
	if (hasAgentDirOverride()) return [sessions];
	const retired = stepSessionsRoot(stepLegacyRoot(home), home);
	return retired === sessions ? [sessions] : [sessions, retired];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every session file under {@link stepSessionDirs}, with what its header states. */
export function stepSessionScan(home: string): StepSessionScan {
	const skipped: StepSkippedEntry[] = [];
	const candidates: StepSessionPath[] = [];
	for (const root of stepSessionDirs(home)) {
		for (const entry of directoryEntries(root)) {
			const dir = join(root, entry.name);
			if (entry.isDirectory) {
				const files = sessionFileNames(dir);
				if (files.length === 0) {
					skipped.push({ name: entry.name, reason: "directory holding no session file" });
					continue;
				}
				for (const name of files) candidates.push({ path: join(dir, name), dir });
				continue;
			}
			if (entry.name.endsWith(SESSION_FILE_SUFFIX)) candidates.push({ path: dir, dir: root });
		}
	}

	const sessions: StepSessionDir[] = [];
	const byId = new Map<string, string>();
	for (const candidate of candidates) {
		const name = basename(candidate.path);
		const head = readHead(candidate.path, SESSION_HEAD_BYTES);
		if (head === null) {
			skipped.push({ name, reason: "session file could not be read" });
			continue;
		}
		const found = firstEntry(head);
		if (found.kind === "none") {
			skipped.push({ name, reason: "no JSON line in the file's head" });
			continue;
		}
		if (found.kind === "other") {
			skipped.push({ name, reason: "first entry is not a session header" });
			continue;
		}
		const id = asText(found.entry.id);
		if (id === "") {
			skipped.push({ name, reason: "session header with no id" });
			continue;
		}
		const earlier = byId.get(id);
		if (earlier !== undefined) {
			skipped.push({ name, reason: `a copy of the session already found at ${earlier}` });
			continue;
		}
		byId.set(id, candidate.path);
		sessions.push({
			path: candidate.path,
			dir: candidate.dir,
			id,
			cwd: asText(found.entry.cwd) || null,
			startedAt: headerTime(found.entry.timestamp),
			version: typeof found.entry.version === "number" ? found.entry.version : null,
		});
	}
	return { sessions, skipped };
}

/** {@link stepSessionScan}'s sessions: every session file, without the accounting. */
export function stepSessions(home: string): StepSessionDir[] {
	return stepSessionScan(home).sessions;
}

/** A directory's entries, name-sorted so the listing does not depend on readdir; unreadable means none. */
function directoryEntries(dir: string): Array<{ name: string; isDirectory: boolean }> {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch {
		// A session directory that is not there, or cannot be read, contributes
		// nothing rather than aborting the walk over the ones that are.
		return [];
	}
}

/** The names of the session files directly inside one directory, name-sorted. */
function sessionFileNames(dir: string): string[] {
	return directoryEntries(dir)
		.filter((entry) => !entry.isDirectory && entry.name.endsWith(SESSION_FILE_SUFFIX))
		.map((entry) => entry.name);
}

/** What a session file's head holds: its header, something else, or nothing that parses. */
type StepHead = { kind: "session"; entry: Record<string, unknown> } | { kind: "other" } | { kind: "none" };

// Long-form design notes: docs/dev/migration-sources.md
/** The first parsed entry of a session file's head. */
function firstEntry(head: string): StepHead {
	for (const line of head.split("\n")) {
		const parsed = parseJsonLine(line);
		if (parsed === null) continue;
		return parsed.type === "session" ? { kind: "session", entry: parsed } : { kind: "other" };
	}
	return { kind: "none" };
}

/** Up to `limit` bytes of a file as text, or `null` when it cannot be opened. */
function readHead(path: string, limit: number): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(limit);
		const read = readSync(fd, buffer, 0, limit, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		// A file that went away, a directory that looked like one, a permission
		// denied: the caller reports it and the walk goes on.
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The header's ISO `timestamp` in epoch ms, 0 when it states nothing readable. */
function headerTime(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
