import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The directory Step Code keeps its state in when `$STEPCODE_CONFIG_DIR` names none. */
export const STEPCODE_DEFAULT_DIR = ".stepcode";

/**
 * {@link STEPCODE_DEFAULT_DIR} under the name this package's other sources use.
 *
 * One constant, two spellings. Every source here names its fallback directory
 * `<PRODUCT>_DEFAULT_DIR` — `GROK_DEFAULT_DIR`, `DSH_DEFAULT_DIR`,
 * `KIMI_CODE_DEFAULT_DIR` — and the settings half of this one named it after
 * Step's own variable, `STEPCODE_CONFIG_DIR`. Both names are exported because
 * both are imported; a second literal would be a second rule, and the two would
 * be free to drift apart.
 */
export const STEP_DEFAULT_DIR = STEPCODE_DEFAULT_DIR;

/**
 * The directory Step Code used before the rename, still read where the newer
 * tree has nothing.
 *
 * Step's own `LEGACY_RENAMED_CONFIG_DIR` (`step/environment.ts`). Step reads it
 * in two narrow places and never as a live root: `step/auth.ts` imports a
 * credential out of `<retired>/agent/auth.json` or `<retired>/auth.json`, and
 * `step/session.ts` recognizes a session path under it as legacy and *copies*
 * the file into the canonical tree before opening it. So a user who never
 * launched the renamed build keeps everything under `.step-harness`, where no
 * Step reader looks — which is exactly the case this fallback exists for.
 */
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

/**
 * Where Step Code's user-level files live: `<home>/<config dir>` normally, and
 * the *parent* of `$STEP_CODING_AGENT_DIR` when that is set.
 *
 * Ported from `resolveStepConfigRoot`, including the two details that read like
 * accidents and are not:
 *
 *   - the override is `resolve()`d first. Step's comment says why: appending
 *     `".."` to a relative path is textual, so a relative
 *     `$STEP_CODING_AGENT_DIR` would put credentials beside the process's
 *     working directory. `resolve` here resolves against *this* process's
 *     working directory, which is what Step does too — the one place where a
 *     relative override is legitimately ambiguous, and both sides read it the
 *     same way because both are processes with a cwd.
 *   - a filesystem root has no parent to be the config root, so it keeps the
 *     files inside the agent directory itself rather than writing outside the
 *     namespace the user named.
 *
 * This is where `config.toml`, `auth.json` and `.credentials.json` sit. It is
 * deliberately **not** {@link stepAgentDir}, which is a child of it — the
 * comment on Step's own `resolveStepConfigRoot` says the files "sit next to the
 * agent directory, not inside it", and a reader that joined them onto the agent
 * directory would look for `config.toml` one level too deep.
 */
export function stepConfigRoot(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName());
	const agentDir = resolve(override);
	const parent = dirname(agentDir);
	return parent === agentDir ? agentDir : parent;
}

/**
 * `$STEP_CODING_AGENT_DIR` trimmed and used **verbatim**, else `<root>/agent`.
 *
 * Verbatim is Step's own session-side spelling (`resolveStepAgentDir`), which
 * does not expand a leading `~`: `$STEP_CODING_AGENT_DIR=~/elsewhere` names a
 * directory literally called `~` under the working directory. Expanding it here
 * would read a tree that does not exist and report the user's real one as
 * absent.
 *
 * Step itself has a second spelling of this same setting — `config.ts`'s
 * `getAgentDir()`, which *does* expand `~` — and the two disagree only for a
 * `~`-prefixed value, because the readers that matter split along the same line:
 * the session machinery calls `resolveStepAgentDir` while the settings, skills,
 * prompts, extensions and `models.json` all go through `getAgentDir()`. The
 * migrator keeps both spellings rather than picking one and being wrong for half
 * the tree: this is the session one, and {@link stepAssetDir} is the other.
 */
export function stepAgentDir(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName(), "agent");
	return override;
}

/**
 * {@link stepAgentDir} as the *settings and assets* side of Step spells it:
 * `getAgentDir()`, which tilde-expands the override and falls back to
 * `<home>/<config dir>/agent`.
 *
 * The expansion is against the home this module was handed rather than
 * `os.homedir()`, which is the only difference from Step and is not observable
 * on a machine where the two agree — and where they disagree (a `$HOME` that is
 * not the OS home), reading the home the migrator was told to read is the whole
 * point of passing one in. `models.json`, `settings.json` and the `themes/`,
 * `prompts/`, `skills/` and `tools/` directories under it are all reached
 * through this spelling.
 */
export function stepAssetDir(home: string): string {
	const override = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (override === undefined || override === "") return join(home, stepConfigDirName(), "agent");
	return expandTilde(home, override);
}

/** `<root>/agent/sessions` — where sessions sit unless a session root is configured. */
export function stepSessionsDir(root: string): string {
	return join(root, "agent", "sessions");
}

/**
 * The session root the history importer reads: the environment override, else
 * the `sessionDir` setting, else `<root>/agent/sessions`.
 *
 * That is Step's own order where a reader can stand. Its startup path folds the
 * three inputs into one `??` chain — the `--session-dir` flag first, then
 * `$STEP_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting
 * (`main.ts:1018-1021`) — which is this order with a flag a migration has no
 * argv for. The function that *looks* like it disagrees only tests a value that
 * chain has already produced: `resolveConfiguredSessionDir` tries its
 * `sessionDir` parameter before the variable (`step/session.ts:153`), and that
 * parameter *is* the folded answer, while the flag its help text names as the
 * winner is the argv one (`cli/args.ts:675`). The setting itself is read from
 * `settings.json` by the settings half (`getSessionDir`, which tests it for
 * truthiness rather than for blankness, `core/settings-manager.ts:723-725`) and
 * arrives here as an argument. So the two orders agree, and the one case they
 * were thought to disagree in — both set — reads the environment's directory,
 * which is the one the user set for this process; `test/step-home.test.ts:174-182`
 * pins that, and the report names the directory it read either way rather than
 * implying the read was complete.
 *
 * Both overrides are tilde-expanded and then used as they stand. Step resolves a
 * *relative* one against the working directory of the session being opened
 * (`resolveConfiguredSessionDir` resolves a relative value against its `cwd`),
 * which is per-session knowledge a reader of finished sessions cannot have; a
 * relative value is therefore resolved against the source home and the report
 * names that, because guessing a cwd would look for the tree under a project
 * directory while the sessions sit somewhere else entirely.
 */
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

/**
 * The tree to read: the canonical one, or `.step-harness` when the canonical
 * one has nothing and no environment variable moved it elsewhere.
 *
 * The fallback is guarded by the overrides on purpose. A user who set
 * `$STEPCODE_CONFIG_DIR` or `$STEP_CODING_AGENT_DIR` has already said where
 * their tree is, and reading a directory they did not name — the one Step's
 * *previous* release used — would import a tree they may have deliberately
 * abandoned. Without an override there is nothing the canonical path could be
 * but `~/.stepcode`, so an empty one plus a populated `.step-harness` has
 * exactly one explanation.
 *
 * "Has content" is the same test detection applies to whatever this returns
 * (`sourceHasContent` lists the directory), so the two cannot disagree about
 * whether the source is present.
 */
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

/**
 * Step's own tilde rule, against a given home: `~` alone is the home, `~/` and
 * (on Windows) `~\` prefix it, and a `~` anywhere else is an ordinary character.
 *
 * Both of Step's copies of the rule agree with this one:
 * `packages/coding-agent/src/utils/paths.ts:89-90` and
 * `packages/agent-core/src/harness/env/nodejs.ts:53-55`.
 */
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

/**
 * The suffix a session file carries, matched the way Step matches it.
 *
 * Step reads back exactly `f.endsWith(".jsonl")` and writes exactly that
 * (`core/session-manager.ts:641`, `:825`, `:1686`, and the
 * `${fileTimestamp}_${sessionId}.jsonl` name at `:954`). Case-sensitive, because
 * Step's is: this reader must not present a `.JSONL` file as a session when Step
 * itself would never show it — and must not hide one Step does show.
 */
const SESSION_FILE_SUFFIX = ".jsonl";

/**
 * How much of a session file the walk reads to place it.
 *
 * One bounded read of the head, never the file: a session is read end to end
 * only by the reader that imports it, so listing a home with a hundred sessions
 * costs a hundred heads rather than a hundred conversations. Step's own header
 * scan gives the first line 4096 bytes and then keeps reading up to 1 MiB for
 * oversized metadata (`SESSION_HEADER_READ_BUFFER_SIZE` and
 * `MAX_SESSION_HEADER_SCAN_BYTES`, `core/session-manager.ts:491-494`); 64 KiB
 * covers the same line in a single read, and a header line longer than that is
 * one neither tool would parse.
 */
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

/**
 * A session file with what its header states.
 *
 * Every field here comes from the header line. Nothing is recovered from the
 * path, and that is a decision rather than an omission:
 *
 *   - **the id** is the header's, which is the id Step uses (`SessionHeader.id`,
 *     `core/session-manager.ts:32-39`). The file name carries the same id as a
 *     suffix — `${fileTimestamp}_${id}.jsonl` (`:954`) — but reading it back
 *     would be pattern-matching on a name Step never promises to keep, and a
 *     session whose header states no id is one Step itself refuses to open
 *     (`loadEntriesFromFile` returns no entries at all unless the first entry is
 *     a `session` **with a string `id`**, `:551-553`). Those are skipped with a
 *     reason by {@link stepSessionScan} rather than given a made-up one.
 *   - **the cwd** is the header's too, and the directory name cannot replace it.
 *     The bucket name is `--<cwd>--` with the leading separator stripped and
 *     every `/`, `\` and `:` mapped to `-`
 *     (`getDefaultSessionDirPath`, `core/session-manager.ts:476-481`, spelled
 *     again at `step/session.ts:105-110`) — a lossy encoding, since a directory
 *     whose own name holds a `-` is indistinguishable from a deeper path. There
 *     is no decoder anywhere in Step: every reader takes the cwd from the header
 *     (`getSessionHeaderCwd`, `:626-629`) and the selector matches on it
 *     (`sessionCwdMatches`, `:631-633`). A `cwd` of `""` is not a directory
 *     either: that test treats it as absent, so it is reported as `null` here.
 *   - **`startedAt`** is the header's `timestamp` in epoch ms, 0 when the header
 *     states none it can parse — the same reading `buildSessionInfo` gives it
 *     (`:743`).
 *   - **`version`** is `null` for a v1 session, which is what "v1 sessions don't
 *     have this" (`:34`) leaves behind. The reader, not this listing, is what
 *     turns that into the entry list of a v1 file.
 */
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

/**
 * Every directory a Step session may live in, most authoritative first.
 *
 * Step's own resolution names one directory — `$STEP_CODING_AGENT_SESSION_DIR`
 * when set, else `<agent dir>/sessions` (`resolveStepSessionDir`,
 * `step/environment.ts:60-62`) — and the *trees* are two. This list is the
 * session root of each tree this source reads, in the order they are read:
 *
 *   - the tree {@link stepRoot} chose. Step writes sessions under
 *     `<agent dir>/sessions`, into a `--<cwd>--` bucket per working directory
 *     (`getDefaultSessionDirPath`, `core/session-manager.ts:476-481`) — except
 *     when a session directory is configured, in which case the file lands
 *     directly in it (`SessionManager.create`, `:1521-1524`, and the flat read at
 *     `listSessionsFromDir`, `:812-826`). Both layouts are read from every entry
 *     below, because the same directory can be either.
 *   - the pre-rename `.step-harness` tree, last. Step reads it too: a session
 *     path under it is recognized as legacy and *copied* into the canonical tree
 *     before it is opened (`isLegacyPiSessionPath` and `relocateLegacyPiSession`,
 *     `step/session.ts:168-172`, `:191-220`). So a user who has not launched the
 *     renamed build has real sessions there, and one who has may still have them
 *     beside the new ones. They are second in the order, so a session present in
 *     both trees is read once, from the canonical copy — a tree that was copied
 *     keeps its session ids, which is what {@link stepSessionScan} de-duplicates
 *     on.
 *
 * Two cases collapse the list to one entry, both mirroring {@link stepRoot}: an
 * environment variable has already said where the tree is, and the retired tree
 * *is* the chosen tree.
 *
 * What this cannot honour is the `sessionDir` setting (`settings.json`,
 * `core/settings-manager.ts:140`), which the CLI's `--session-dir` flag shares:
 * it belongs to the settings reader, which is handed the value with the rest of
 * the planner's work. A user who set it has their sessions read from the default
 * location instead, and the report says so by naming the directory it read.
 */
export function stepSessionDirs(home: string): string[] {
	const chosen = stepRoot(home);
	const sessions = stepSessionsRoot(chosen, home);
	if (chosen === stepLegacyRoot(home)) return [sessions];
	if (hasAgentDirOverride()) return [sessions];
	const retired = stepSessionsRoot(stepLegacyRoot(home), home);
	return retired === sessions ? [sessions] : [sessions, retired];
}

/**
 * Every session file under {@link stepSessionDirs}, with what its header states.
 *
 * The walk is the one Step's own `listAll` makes (`core/session-manager.ts:1657-
 * 1716`): each session directory is read, every `.jsonl` file directly inside it
 * is a session, and every subdirectory is a `--<cwd>--` project whose `.jsonl`
 * files are sessions. Nothing else is a session, and a name that is not a
 * `.jsonl` file is passed over in silence: Step reads no other name as one, so a
 * note about it would be a note about a file the user never had as a session.
 *
 * Everything a session-shaped thing *failed* to be is reported instead, each
 * with its own reason — a file whose head holds no JSON, a file whose first entry
 * is not a session header, a file that could not be opened, a header with no id
 * Step could resume by, a directory with no session file in it (an ordinary state
 * rather than a broken one: Step creates the bucket before the first turn is
 * saved, `getDefaultSessionDir`, `:483-489`), and a session already read from an
 * earlier directory in the priority order.
 *
 * `stepSessions` is this listing's sessions, for a caller that wants the files
 * and not the accounting.
 */
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

/**
 * The first parsed entry of a session file's head.
 *
 * A blank or malformed line is stepped over rather than disqualifying the file:
 * Step's own header scan does the same (`parseSessionHeaderCandidate` returns
 * "keep scanning" for both, `core/session-manager.ts:564-570`), so a file whose
 * first line is damaged but whose next line is a header is a session to Step and
 * to this reader. The two failures are kept apart because the report says which
 * one happened: `none` is a head with no JSON at all, `other` is a head whose
 * first JSON line is something that is not a session header.
 */
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
