import { join } from "node:path";

/** The directory Codex uses when `$CODEX_HOME` names none. */
export const CODEX_DEFAULT_DIR = ".codex";

/**
 * Where Codex keeps its state: `$CODEX_HOME` when set, else `~/.codex`.
 *
 * Deliberately **not** {@link dshRoot} or {@link grokRoot} with the names
 * changed. Codex sits between the two on every detail, and each one is a
 * directory a reader can get wrong:
 *
 *   - Like grok and unlike the harness, a whitespace-only value is a value:
 *     `find_codex_home` filters on `is_empty`, not `trim`, so
 *     `$CODEX_HOME=" "` names a single-space directory. Reading it as unset
 *     would import `~/.codex` while Codex itself is writing elsewhere.
 *   - Like grok on `~` and unlike the harness, there is no expansion and no
 *     resolution against the working directory: the value is a path as written.
 *   - Unlike grok, Codex **requires** the value to name an existing directory
 *     and fails outright when it does not (`utils/home-dir/src/lib.rs`). That
 *     error is Codex's own; for this reader the consequence is the same shape
 *     as any other absent root — `existsSync` is false, nothing is read, and
 *     nothing is reported, because there is no tree here to report about.
 *
 * Codex canonicalizes the value after checking it, where grok uses it verbatim.
 * The difference only shows in a path that went through `..` or a symlink, and
 * canonicalizing here would mean printing the `\\?\`-prefixed form on Windows,
 * so the value is used as written for the same reason {@link grokRoot} does.
 *
 * Defined once because three callers need the same answer: detection, the
 * settings/skills/rules reader, and the history side, which reads
 * `$CODEX_HOME/sessions` and `$CODEX_HOME/history.jsonl`. Two copies of this
 * rule is how a `$CODEX_HOME` user ends up with their config imported and their
 * transcripts reported as none.
 */
export function codexRoot(home: string): string {
	const configured = process.env.CODEX_HOME;
	if (configured === undefined || configured === "") return join(home, CODEX_DEFAULT_DIR);
	return configured;
}
