/**
 * Where a session's repository map lives.
 *
 * One service per session, shared by the RepoMap tool, the `/map` commands and
 * the startup prompt section: each of those scans the same checkout, and three
 * caches over one tree would pay three cold scans. The cache is per project
 * rather than per session — a second `labunbun` in the same checkout starts
 * hot — and lives beside the sessions so it ages out with the project state.
 *
 * The prompt section is best effort by design. A scan that fails is a reason to
 * leave the section out, not a reason a session cannot start; the RepoMap tool
 * will report the same failure if the user asks for the map directly.
 */
import { join } from "node:path";
import { sanitizeCwd, sessionsRoot } from "@labunbun/agent";
import { type Operations, RepoMapService, watchRepoMap } from "@labunbun/tools";

/** The project's persistent map cache, shared by every session in this checkout. */
export function repoMapCachePath(cwd: string, home?: string): string {
	return join(sessionsRoot(home), sanitizeCwd(cwd), "repomap.sqlite");
}

export function createRepoMapService(cwd: string, ops: Operations, home?: string): RepoMapService {
	return new RepoMapService({ root: cwd, ops, cachePath: repoMapCachePath(cwd, home) });
}

/** The body of the `# Repository map` section, or undefined when the repository is too large. */
export async function repoMapPromptSection(service: RepoMapService): Promise<string | undefined> {
	try {
		const section = await service.promptSection();
		return section?.text;
	} catch {
		return undefined;
	}
}

/** A host's handle on the section's freshness; see `watchRepoMapPromptSection`. */
export interface RepoMapPromptRefresher {
	/**
	 * Rebuild the section if a save since the last call marked it stale. A no-op
	 * otherwise, so a host may await it on every turn.
	 */
	refreshIfStale(): Promise<void>;
	/** Forget a pending report — for a host that just read the tree itself. */
	reset(): void;
	/** Stop watching the tree; part of the session's shutdown. */
	close(): void;
}

export interface RepoMapPromptRefresherOptions {
	/** Workspace root to watch. */
	root: string;
	service: RepoMapService;
	/** The section the live prompt currently carries, for the no-change check. */
	current(): string | undefined;
	/**
	 * Replace the section, and rebuild whatever prompt carries it. Called only
	 * when the text changed; the host must make `current()` answer with `text`
	 * afterwards.
	 */
	apply(text: string | undefined): void;
	/**
	 * Called once when a watch that started has stopped — an inotify limit, an
	 * unmounted share, a removed root. The section then stays as it was last
	 * built until the host rebuilds it by other means (`/map-refresh` in the
	 * REPL, a new session in ACP).
	 */
	onWatchError?(error: unknown): void;
}

/**
 * One line a host says when a watch that started has stopped.
 *
 * Only the first line of an Error's message is used — a message can carry
 * newlines, and a notice is one line — with `String(error)` for anything else.
 * No stack: the reason the freshness ended is the fact, not where it was thrown.
 */
export function repoMapWatchFailureNotice(error: unknown): string {
	const detail = error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? "") : String(error);
	return `Repository map: watching for changes stopped (${detail}).`;
}

/**
 * Keep a host's prompt section in step with the tree.
 *
 * The watcher only marks the section stale; the rebuild happens when the host
 * calls `refreshIfStale`, which both the REPL and ACP do at the start of a
 * turn. That boundary is the point: a request already in flight cannot change
 * its system prompt, a burst of saves costs one walk, and a rebuild whose text
 * equals the current section swaps nothing — so an edit that does not move what
 * the map shows leaves the prompt (and its cached prefix) alone.
 *
 * The section is built through the service directly rather than through
 * `repoMapPromptSection`: a failed scan must leave the section as it is, while
 * an undefined result — the repository no longer fits — is the legitimate
 * answer that removes it. A host whose repository was declined *for size* gets
 * no watcher: there is nothing to keep fresh, and the tree that was declined is
 * exactly the one a recursive watch costs the most to follow.
 */
export function watchRepoMapPromptSection(options: RepoMapPromptRefresherOptions): RepoMapPromptRefresher {
	let stale = false;
	let inflight: Promise<void> | undefined;
	// A repository declined for size has nothing to keep fresh: that is the large
	// checkout, the tree a recursive watch costs the most to follow, and a rebuild
	// can only ever answer the same decline. The small trees are watched even when
	// they started without a section — a repository that has no definitions yet,
	// or whose map the budget cannot finish, is exactly where a save can make the
	// section answerable.
	const watch =
		options.current() === undefined && options.service.promptSectionDecline === "too-large"
			? null
			: watchRepoMap({
					root: options.root,
					onChange: () => {
						stale = true;
					},
					onError: options.onWatchError,
				});
	return {
		async refreshIfStale() {
			if (!stale) return;
			if (inflight) return inflight;
			// Cleared before the scan: a change that lands while it runs marks the
			// section stale again, and the next turn asks for another look.
			stale = false;
			inflight = (async () => {
				try {
					const next = (await options.service.promptSection())?.text;
					if (next === options.current()) return;
					options.apply(next);
				} catch {
					// The next save — or the next turn — tries again.
					stale = true;
				} finally {
					inflight = undefined;
				}
			})();
			return inflight;
		},
		reset() {
			stale = false;
		},
		close() {
			watch?.close();
		},
	};
}
