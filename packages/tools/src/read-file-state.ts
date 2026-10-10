// Long-form design notes: docs/dev/tools.md
/** What the model was actually shown by a Read, kept per session so an edit tool can refuse a file nobody read. */

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
	// Long-form design notes: docs/dev/tools.md
	/** The file's own modification time when it was read, when the recorder could stat it. */
	readonly mtime?: number;
	/** Neither `offset` nor `limit` was passed: the read was not asked to be a page. */
	readonly fullRead: boolean;
	// Long-form design notes: docs/dev/tools.md
	/** The model did not receive the file's bytes — the injection guard. */
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

// Long-form design notes: docs/dev/tools.md
/** The map key for a path: separators normalised, case folded on case-insensitive filesystems. */
function keyFor(path: string): string {
	const normalized = normalizePathSeparators(path);
	return caseInsensitivePaths ? normalized.toLowerCase() : normalized;
}

/** One session's reads. Not shared, not global — see the header. */
export class ReadFileState {
	readonly #reads = new Map<string, Tracked>();

	// Long-form design notes: docs/dev/tools.md
	/** Record what the model has been shown for `path`, replacing any earlier entry rather than accumulating one. */
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

	// Long-form design notes: docs/dev/tools.md
	/** Forget everything. */
	clear(): void {
		this.#reads.clear();
	}

	/** How many files this session has read. */
	get size(): number {
		return this.#reads.size;
	}
}
