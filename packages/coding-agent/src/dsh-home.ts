import { join, resolve } from "node:path";

/** The directory a DeepSeek Harness install uses when `$DSH_HOME` names none. */
export const DSH_DEFAULT_DIR = ".dsh";

/**
 * Where dsh keeps its state: `$DSH_HOME` when set, else `~/.dsh`.
 *
 * A blank env var is not a path — the harness reads a whitespace-only
 * `$DSH_HOME` as unset, and detection that took it literally would look in a
 * directory the harness itself never writes to.
 *
 * The value is expanded and resolved the way the harness resolves it: a leading
 * `~` means home, and a relative value is relative to the working directory.
 * Both halves have to agree, or the importer would read one tree and report it
 * as another. A padded value is one of them: the harness tests the raw value for
 * blankness but then uses it verbatim, so `$DSH_HOME="~/dsh "` names a directory
 * whose name ends in a space. Trimming here would look somewhere the harness
 * never writes — which is the whole failure this rule exists to avoid, arriving
 * by a different door.
 *
 * Defined once rather than in each reader. The plan asks this root for the
 * settings, the skills and the patches, and the history importer asks it for the
 * sessions; a user's `$DSH_HOME` has to mean the same tree to both, and two
 * copies of the rule is how it stops meaning that — the second copy was the one
 * that grew up without the expansion, so a `$DSH_HOME=~/elsewhere` user got
 * their settings imported and their sessions silently reported as none.
 */
export function dshRoot(home: string): string {
	const configured = process.env.DSH_HOME;
	if (configured === undefined || configured.trim() === "") return join(home, DSH_DEFAULT_DIR);
	const expanded =
		configured === "~"
			? home
			: configured.startsWith("~/") || configured.startsWith("~\\")
				? join(home, configured.slice(2))
				: configured;
	return resolve(expanded);
}
