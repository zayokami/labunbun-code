// Watching the tree behind the repository map.
//
// The cache already notices a changed file through its mtime and size, so the
// watcher is not what keeps a map *correct* — a scan is. What it keeps fresh is
// the prompt: the repository section is built once at startup, and without a
// watcher only `/map-refresh` pulls an edit made in another window into the
// next request. The watcher turns "saved in the editor" into a signal, and the
// host decides when rebuilding the section is worth the prompt-cache prefix it
// costs. `docs/dev/repomap.md` has the rest.
import { type FSWatcher, statSync, watch } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { GLOB_SKIP_DIRS } from "./glob.ts";
import { REPO_MAP_CODE_FILES } from "./repomap.ts";

/** Quiet window a burst of saves is collected over before it is reported. */
export const REPO_MAP_WATCH_DEBOUNCE_MS = 400;

/**
 * Most paths one report carries. A burst past this — a `git checkout` of a
 * generated tree — reports the first ones; the host only needs to know that
 * something it maps changed.
 */
const MAX_REPORTED_PATHS = 4_096;

export interface RepoMapWatchOptions {
	/** Workspace root. Events are resolved against it and never reported outside it. */
	root: string;
	/** Only paths this glob matches are reported. Default: `REPO_MAP_CODE_FILES`. */
	pattern?: Bun.Glob;
	/**
	 * Directory names no event below which is reported. Default: `GLOB_SKIP_DIRS`,
	 * the same set the walk skips — a file under `node_modules` never reaches a
	 * map, so it is not a reason to rebuild one.
	 */
	ignoreDirectories?: readonly string[];
	/**
	 * Longest a burst waits before it is reported. Events inside one window are
	 * one call. Default: `REPO_MAP_WATCH_DEBOUNCE_MS`.
	 */
	debounceMs?: number;
	/** Called once per window with the changed absolute paths, sorted. */
	onChange(paths: string[]): void;
	/** A watch that failed after it started, e.g. an inotify limit or a deleted root. */
	onError?(error: unknown): void;
}

export interface RepoMapWatchHandle {
	/**
	 * Whether the platform accepted a recursive watch. False means nothing is
	 * being observed and `/map-refresh` remains the only pull, which is exactly
	 * what a build without the watcher does.
	 */
	readonly watching: boolean;
	close(): void;
}

/**
 * Whether an event's path names a directory rather than a file.
 *
 * `fs.watch` reports a directory rename or move by the directory's own name,
 * which a code-file glob can never match: `git mv src lib` would leave the
 * section naming `src/…` until some file below the tree is saved. Only an
 * extensionless name is a candidate — the files the walk skips and the temp
 * files an editor writes around a save all carry a dot, so they cost no stat
 * and never wake the host. A name with no dot that is a directory now, or that
 * has gone away (the shape of a directory leaving), can take every file below
 * it with it and is a reason to rebuild. A dotted directory moving out is the
 * one miss; a code save or `/map-refresh` still heals the section.
 */
function namesDirectory(full: string): boolean {
	const name = full.slice(Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")) + 1);
	if (name.lastIndexOf(".") !== -1) return false;
	try {
		return statSync(full).isDirectory();
	} catch {
		// Gone: a delete or a rename away. Being wrong here costs one rebuild that
		// finds nothing changed, and the text-equality check swaps no prompt.
		return true;
	}
}

/**
 * Observe the files a repository map would read, and report changes in batches.
 *
 * Recursive `fs.watch` is one handle on macOS and Windows. A platform (or a
 * filesystem) that refuses it leaves `watching` false rather than walking the
 * tree itself: a per-directory fallback would be a second walker that can drift
 * from the first, and the map is still correct without it — only the prompt
 * section waits for `/map-refresh` as before.
 *
 * The watcher does not honour `.gitignore`: an ignored file that changes wakes
 * the host once and is then rejected by the walk, which costs one rebuild and
 * changes nothing. Teaching the watcher the ignore chain would mean reading
 * every `.gitignore` on the way to every event — the walk already does that
 * correctly.
 */
export function watchRepoMap(options: RepoMapWatchOptions): RepoMapWatchHandle {
	const root = resolve(options.root);
	const pattern = options.pattern ?? REPO_MAP_CODE_FILES;
	const debounceMs = options.debounceMs ?? REPO_MAP_WATCH_DEBOUNCE_MS;
	// Compared exactly as the walk compares them (`glob.ts`): a directory whose
	// name only differs in case is a directory the walk reads, so a save in it is
	// a save the map saw, and folding case here would leave that save unreported.
	const ignored = new Set<string>(options.ignoreDirectories ?? GLOB_SKIP_DIRS);
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	let closed = false;

	const stop = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		pending.clear();
		watcher?.close();
		watcher = undefined;
	};

	const flush = (): void => {
		timer = undefined;
		if (closed || pending.size === 0) return;
		const paths = [...pending].sort();
		pending.clear();
		try {
			options.onChange(paths);
		} catch {
			// A host callback that throws is the host's failure, not the watch's:
			// the tree is still being observed and the next save can report again.
		}
	};

	const note = (filename: string | Buffer | null): void => {
		if (closed || filename === null) return;
		const full = resolve(root, filename.toString());
		const rel = relative(root, full);
		// `relative` returns an absolute path across Windows drives, so the empty
		// and `..` checks alone would let one through.
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
		const segments = rel.split(/[\\/]/);
		if (segments.some((segment) => ignored.has(segment))) return;
		// The map's own set of files. A README and anything else the walk would
		// skip are not reasons to rebuild its section; a directory is, because its
		// name never matches the glob and moving one moves every file below it.
		if (!pattern.match(segments.join("/")) && !namesDirectory(full)) return;
		if (pending.size < MAX_REPORTED_PATHS) pending.add(full);
		if (timer === undefined) timer = setTimeout(flush, debounceMs);
	};

	try {
		watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => note(filename));
	} catch {
		return { watching: false, close() {} };
	}
	watcher.on("error", (error) => {
		// An inotify limit, an unmounted share, a removed root: the observation is
		// over. The host hears once so it can say why freshness stopped, and the
		// handle stays safe to close. A host callback that throws must not keep a
		// dead watcher alive — `stop` runs either way, the same rule `flush` uses.
		try {
			options.onError?.(error);
		} catch {
			// The failure being reported is the event; the report is not.
		} finally {
			stop();
		}
	});
	return {
		// Read when asked, not frozen at creation: `stop` and an error both end the
		// observation, and a host that checks after either should hear the truth.
		get watching() {
			return !closed;
		},
		close: stop,
	};
}
