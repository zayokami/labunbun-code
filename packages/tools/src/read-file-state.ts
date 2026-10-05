/**
 * What the model was actually shown by a Read, kept per session so an edit tool
 * can refuse a file nobody read.
 *
 * The rule this exists for is one the reference implementation has in code and
 * `edit.ts` has only in prose: the prompt says "Read the file with Read before
 * editing" (`edit.ts:22`) and nothing checks it. A prompt line is a request,
 * and a model — or an injected instruction riding in a file it never opened —
 * can decline one. The mechanism is a recorded read, and this is the record.
 *
 * ## Why an instance rather than a module-level singleton
 *
 * More than one session is alive in a single process: `/resume` builds a second
 * `AgentSession` around the *same* tool array (`interactive.ts:840`), and every
 * test case that wants a tool set builds its own. A module-level `let` would
 * hand the gate content that a *different* conversation was shown, which is
 * exactly the hole the gate is closing. So this is an ordinary object:
 * `createAllTools` makes one per tool set unless the caller passes its own —
 * the app passes its own precisely so the `/resume` swap can call
 * {@link ReadFileState.clear} (`interactive.ts:875`) — and `createReadTool`
 * receives the same instance the Edit tool is given. Nothing here is reachable
 * without a caller passing it in.
 *
 * ## The API an edit tool imports
 *
 * ```ts
 * record(path, { content, offset?, limit?, partialView?, mtime? }): ReadFileStateEntry
 * getState(path): ReadFileStateEntry | undefined
 * forget(path): boolean
 * paths(): string[]
 * clear(): void
 * ```
 *
 * `getState` is the whole gate's input:
 *
 * ```ts
 * const seen = readState.getState(path);        // path = guardWritablePath(input.file_path, ...)
 * if (!seen) return "read it first";             // no read, or one that failed
 * if (!seen.fullRead || seen.partialView) ...    // only a whole, untransformed read counts
 * if (seen.content !== (await ops.readTextFile(path))) ... // changed since it was read
 * ```
 *
 * Keys are normalised (separators, and case on the platforms whose filesystem
 * is case-insensitive), so the path Edit resolves with `guardWritablePath` and
 * the path Read resolved with `guardPathContainment` land on the same entry.
 *
 * After a **successful** edit or write the caller must `record` again with the
 * new content: the recorded text is what a staleness check compares against
 * disk, and without the refresh the second edit in a conversation fails against
 * the first one's own output.
 */

import { caseInsensitivePaths, normalizePathSeparators } from "./containment.ts";

/** One file's record. Frozen — a gate cannot rewrite the evidence it reads. */
export interface ReadFileStateEntry {
	/**
	 * The text the model was shown, without Read's line-number gutter and without
	 * its paging notice. For a ranged read this is the requested lines only, which
	 * is what makes the same string useless as a stand-in for the whole file and
	 * why `fullRead` has to be consulted separately.
	 */
	readonly content: string;
	/** `Date.now()` when the read was recorded, for a staleness rule of the gate's choosing. */
	readonly timestamp: number;
	/**
	 * The file's own modification time when it was read, when the recorder could
	 * stat it. This is the baseline a staleness rule compares against for a read
	 * that cannot be compared by content: the file's clock against itself. The
	 * {@link timestamp} on its own compares two clocks that need not agree — a
	 * file whose mtime runs ahead of this process's clock (checkout from a
	 * machine with skew, coarser filesystem timestamps, a CI runner mid
	 * time-sync) reads as "changed" on a file nothing has touched.
	 */
	readonly mtime?: number;
	/** Neither `offset` nor `limit` was passed: the read was not asked to be a page. */
	readonly fullRead: boolean;
	/**
	 * The model did not receive the file's bytes. Not paging — this is the
	 * injection guard, and it is the difference between "the model read the file"
	 * and "the model read a transformation of it". Set when a line was cut at
	 * Read's per-line cap, when the default 2000-line window cut a longer file
	 * nobody asked to page, and when the result is longer than `maxResultSizeChars`
	 * and the pipeline will cut its middle before the model sees it.
	 *
	 * See {@link ReadFileStateEntry.content}: for the last of those the recorded
	 * string is *longer* than what reached the model, so this flag is the only
	 * thing standing between a gate and an `old_string` from the missing middle.
	 */
	readonly partialView: boolean;
}

/** What a caller has to say about one read. */
export interface RecordReadInput {
	/** The content the model was shown. Not the file on disk — see the entry. */
	content: string;
	/** The `offset` the read was called with, if any. Present means paged. */
	offset?: number;
	/** The `limit` the read was called with, if any. Present means paged. */
	limit?: number;
	/**
	 * Defaults to the previous entry's value for a path already tracked, and to
	 * `false` otherwise. Pass it explicitly to widen a record or to clear one.
	 */
	partialView?: boolean;
	/**
	 * The file's modification time as observed when this content was seen or
	 * written. Defaults to the previous entry's value the same way `partialView`
	 * does; a caller that just wrote the file must pass a fresh one rather than
	 * let the pre-write baseline ride along.
	 */
	mtime?: number;
}

interface Tracked extends ReadFileStateEntry {
	/** The path as recorded, un-folded: what a caller will want back from {@link ReadFileState.paths}. */
	path: string;
}

/**
 * Case folding is a property of the filesystem rather than of this code, and
 * `containment.ts:21` already answers it for the guards that compare paths. The
 * same rule is used here so the entry Read writes and the entry Edit looks up
 * are one entry: on Windows and macOS `Repo/FOO.ts` and `repo/foo.ts` are the
 * same file, and on Linux they are two, so folding there would merge records
 * for files the model never read as one.
 */
function keyFor(path: string): string {
	const normalized = normalizePathSeparators(path);
	return caseInsensitivePaths ? normalized.toLowerCase() : normalized;
}

/** One session's reads. Not shared, not global — see the header. */
export class ReadFileState {
	readonly #reads = new Map<string, Tracked>();

	/**
	 * Record what the model has been shown for `path`, replacing any earlier
	 * entry rather than accumulating one.
	 *
	 * `content` is stored without the gutter and the notice, because a gate asks
	 * `content.includes(old_string)` and a six-column number in front of every
	 * line would answer that question about a file the model has not seen. For a
	 * full read with nothing cut, the stored string is byte-identical to the file
	 * — `read.ts` rebuilds it from the same `split("\n")` the text came from — so
	 * "did it change since?" is an exact comparison rather than a guess.
	 *
	 * A re-record refreshes the content and the timestamp and keeps `fullRead` and
	 * `partialView` unless this call states them. That is the safe direction to be
	 * wrong in: an edit tool re-recording after a successful edit knows the new
	 * content and nothing about what the model has seen of the rest of the file,
	 * so a call carrying only `{ content }` must not hand out a whole-file badge
	 * on top of a ranged read. Pass `offset`/`limit` (which force `fullRead`
	 * false) or an explicit `partialView` to say otherwise.
	 *
	 * Recording over a path that was never read means the model authored the
	 * content — a Write of a new file, which is the one case where a file the
	 * model did not read is still a file whose whole content it knows.
	 */
	record(path: string, view: RecordReadInput): ReadFileStateEntry {
		const key = keyFor(path);
		const previous = this.#reads.get(key);
		const paged = view.offset !== undefined || view.limit !== undefined;
		const tracked: Tracked = {
			path,
			content: view.content,
			timestamp: Date.now(),
			mtime: view.mtime ?? previous?.mtime,
			fullRead: paged ? false : (previous?.fullRead ?? true),
			partialView: view.partialView ?? previous?.partialView ?? false,
		};
		this.#reads.set(key, tracked);
		return Object.freeze({ ...tracked });
	}

	/** The record for `path`, or `undefined` when this session never read it. */
	getState(path: string): ReadFileStateEntry | undefined {
		const tracked = this.#reads.get(keyFor(path));
		return tracked ? Object.freeze({ ...tracked }) : undefined;
	}

	/**
	 * Drop one path's record. The gate reads `undefined` afterwards, which is the
	 * same answer a file that was never read gets.
	 */
	forget(path: string): boolean {
		return this.#reads.delete(keyFor(path));
	}

	/** Every tracked path, as recorded, in insertion order. */
	paths(): string[] {
		return [...this.#reads.values()].map((tracked) => tracked.path);
	}

	/**
	 * Forget everything.
	 *
	 * For a session swap: `/resume` reuses the tool array it already built
	 * (`interactive.ts:840`), so the incoming conversation would otherwise start
	 * able to "recall" reads from the one being left — and its Edit gate would
	 * accept a file *that* conversation was never shown. `hotSwapSession` calls
	 * this next to `restoreTasks` (`interactive.ts:875`), the other piece of
	 * session state that must follow the conversation rather than the process.
	 */
	clear(): void {
		this.#reads.clear();
	}

	/** How many files this session has read. */
	get size(): number {
		return this.#reads.size;
	}
}
