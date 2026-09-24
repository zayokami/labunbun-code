import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The directory grok uses when `$GROK_HOME` names none. */
export const GROK_DEFAULT_DIR = ".grok";

/**
 * Where Grok Build keeps its state: `$GROK_HOME` when set, else `~/.grok`.
 *
 * Deliberately **not** {@link dshRoot} with the names changed. The harness and
 * grok resolve their homes alike in shape and differently in three details, and
 * each difference is a directory the other tool would never write to:
 *
 *   - grok does not expand a leading `~`. `$GROK_HOME=~/elsewhere` names a
 *     directory literally called `~` under the working directory, so expanding
 *     it here would read a tree that does not exist and report the user's real
 *     one as absent.
 *   - grok does not resolve the value against the working directory. A relative
 *     `$GROK_HOME` stays relative, and absolutizing it would name a different
 *     place than the one grok writes.
 *   - grok treats a *whitespace-only* value as set. Only a truly empty string
 *     falls through to the default (`resolve_grok_home_from` in
 *     `crates/codegen/xai-dirs/src/lib.rs` filters on `is_empty`, not `trim`).
 *     So `$GROK_HOME=" "` is a directory named a single space, and reading it as
 *     unset would import `~/.grok` while grok itself is writing somewhere else.
 *
 * The default's own spelling differs the same way: grok derives it from
 * `dunce::canonicalize(home)`, which on Windows yields a `\\?\`-prefixed path.
 * That is the same directory as `join(home, ".grok")` and the reader below only
 * ever joins names onto it, so the un-canonicalized form is used — a report that
 * printed `\\?\G:\Users\…\.grok` would be accurate and unreadable.
 *
 * Defined once, like {@link dshRoot}, because the plan asks this root for the
 * settings, the skills and the rules while the history importer asks it for the
 * sessions: two copies of the rule is how a user's `$GROK_HOME` stops meaning
 * the same tree to both.
 */
export function grokRoot(home: string): string {
	const configured = process.env.GROK_HOME;
	if (configured === undefined || configured === "") return join(home, GROK_DEFAULT_DIR);
	return configured;
}

/** `$GROK_HOME/sessions` — one directory per working directory that has sessions. */
export function grokSessionsRoot(root: string): string {
	return join(root, "sessions");
}

/**
 * The working directory a `sessions/<name>` directory stands for.
 *
 * grok names these two ways (`encode_cwd_dirname`): a URL-encoded absolute path
 * while it fits in 255 bytes, and `{slug}-{blake3_hex16}` past that, with the
 * real path in a `.cwd` sidecar. Reproducing the encoded form is not needed and
 * not wanted — the hash half would mean reimplementing BLAKE3 — because the
 * decode is what identifies the directory and it works on either spelling:
 * `decode_cwd_from_dirname` URL-decodes first and accepts the result only when
 * it looks absolute (a leading `/`, or a drive letter on Windows), then falls
 * back to the sidecar. A slug-hash name decodes to itself, does not look
 * absolute, and so reads its `.cwd`.
 *
 * Returns `null` for a directory that names no working directory — grok would
 * return `None` too, and a guessed path is worse than a missing one here: this
 * value is what the history importer matches a session against, so a wrong guess
 * puts one project's prompts under another's.
 */
export function decodeGrokCwdDir(dir: string): string | null {
	const name = basename(dir);
	try {
		const decoded = decodeURIComponent(name);
		// The absolute-path test is grok's own discriminator between the two
		// encodings, and it is the whole reason this cannot just be a decode.
		if (decoded.startsWith("/") || decoded[1] === ":") return decoded;
	} catch {
		// Not percent-encoding at all (a stray `%`, say). Rust's decoder tolerates
		// that and still reaches the sidecar; so does this.
	}
	return readTextOrNull(join(dir, ".cwd"))?.trim() || null;
}

/** `readFileSync` that answers `null` for anything it cannot read. */
function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** One session directory: grok counts a session as present only with its `summary.json`. */
export interface GrokSessionDir {
	/** The session id, which is the directory's name. */
	id: string;
	dir: string;
	/**
	 * `<sessions>/<encoded cwd>` — the project directory this session belongs to.
	 *
	 * Carried rather than derived because the encoding is the project's identity
	 * here: a caller that took `dirname(dir)` would be re-deriving it, and a caller
	 * that decoded `dir` itself would be decoding the session id, which decodes to
	 * itself and names no project at all.
	 */
	cwdDir: string;
	/** `<dir>/summary.json` — present by construction. */
	summaryPath: string;
	/** `<dir>/updates.jsonl` — the transcript; absent when the session never took a turn. */
	updatesPath: string;
}

/**
 * Every session under `$GROK_HOME/sessions`, sorted by id for a stable listing.
 *
 * The `summary.json` requirement is grok's own (`resolve_session_dir`, written
 * last as the commit marker), and it earns its place here: `x.ai/session/import`
 * recreates a directory whose import was interrupted precisely because the
 * marker is missing, so a reader that accepted the directory instead would
 * report a half-copied session as one worth importing.
 *
 * `updatesPath` is recorded whether or not it exists, so the caller that needs
 * the transcript can tell "no transcript" (session created, nothing said) from
 * "not a session" without a second `existsSync`.
 */
export function grokSessions(root: string): GrokSessionDir[] {
	const sessionsRoot = grokSessionsRoot(root);
	const out: GrokSessionDir[] = [];
	let cwdDirs: string[];
	try {
		if (!existsSync(sessionsRoot)) return out;
		cwdDirs = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// An unreadable sessions root contributes nothing rather than aborting the run.
		return out;
	}
	for (const cwdDir of cwdDirs.sort()) {
		const dir = join(sessionsRoot, cwdDir);
		let ids: string[];
		try {
			ids = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const id of ids.sort()) {
			const sessionDir = join(dir, id);
			const summaryPath = join(sessionDir, "summary.json");
			if (!existsSync(summaryPath)) continue;
			out.push({ id, dir: sessionDir, cwdDir: dir, summaryPath, updatesPath: join(sessionDir, "updates.jsonl") });
		}
	}
	return out;
}
