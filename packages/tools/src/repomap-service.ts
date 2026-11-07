// P2: one repository-map service shared by the RepoMap tool, the `/map`
// commands and the system-prompt section. Everything below the service — the
// walk, tag extraction, PageRank and rendering — is P1; this module is where a
// host holds the cache so the tool and the prompt do not each pay for a cold
// scan, and where the "is this repository small enough to put in the prompt?"
// judgement lives.
//
// Long-form design notes: docs/dev/repomap.md (P2).
import { guardPathContainment, resolveCanonical } from "./containment.ts";
import { walkProjectFiles } from "./glob.ts";
import { InMemoryRepoMapCache, REPO_MAP_CODE_FILES, type RepoMapCache, type RepoMapOps } from "./repomap.ts";
import { rankRepoMap } from "./repomap-rank.ts";
import { renderRepoMap } from "./repomap-render.ts";
import { SqliteRepoMapCache } from "./repomap-sqlite.ts";
import { buildRepoMapTags, type RepoMapFileTags } from "./repomap-tags.ts";
import { defaultRepoMapParseWorkers } from "./repomap-worker-pool.ts";

/** Smallest and largest map a caller may ask for. */
export const REPO_MAP_MIN_TOKENS = 128;
export const REPO_MAP_MAX_TOKENS = 16_384;
export const REPO_MAP_DEFAULT_TOKENS = 1024;

/** A repository above either bound is too large to inject into the system prompt. */
export const REPO_MAP_PROMPT_MAX_FILES = 200;
export const REPO_MAP_PROMPT_MAX_BYTES = 512 * 1024;

/**
 * Files one map will scan. The walker's own default is 5,000, which a
 * million-line checkout reaches; a map may look further because it reports what
 * it stopped at rather than presenting a prefix of the tree as the whole.
 */
export const REPO_MAP_SCAN_MAX_FILES = 20_000;

export interface RepoMapServiceOptions {
	/** Workspace root. Every map path is resolved and contained against this. */
	root: string;
	ops: RepoMapOps;
	/**
	 * Where the cache lives. A path opens a SQLite cache (created lazily on the
	 * first map); absent leaves the cache in memory. A file that cannot be
	 * opened falls back to memory rather than failing the map.
	 */
	cachePath?: string;
	/** Share a cache the caller owns. Takes precedence over `cachePath`. */
	cache?: RepoMapCache<RepoMapFileTags>;
	pattern?: Bun.Glob;
	respectGitignore?: boolean;
	/** Files above this size are skipped without being read. */
	maxFileBytes?: number;
	onUnreadableDirectory?: (path: string) => void;
	/** Files one map scans before it reports a truncated tree. Default: `REPO_MAP_SCAN_MAX_FILES`. */
	maxFiles?: number;
	/**
	 * Worker threads for uncached parses. Default: `defaultRepoMapParseWorkers()`,
	 * which is 0 on a single-core machine and `cores - 1` capped at four
	 * otherwise. A scan starts the pool only after enough files miss the cache,
	 * so maps of small repositories still parse on the calling thread.
	 */
	parseWorkers?: number;
}

export interface RepoMapRequest {
	/** Directory to map, relative to the workspace root. Default: the root itself. */
	path?: string;
	/** Token budget. Clamped to `REPO_MAP_MIN_TOKENS`–`REPO_MAP_MAX_TOKENS`; default 1024. */
	maxTokens?: number;
	/** Drop the cache before scanning, so every file is read again. */
	refresh?: boolean;
	/** Cancels the walk and the scan; the map rejects with the signal's reason. */
	signal?: AbortSignal;
	chatFiles?: readonly string[];
	mentionedFiles?: readonly string[];
	mentionedIdents?: readonly string[];
}

export interface RepoMapSummary {
	/** The canonical directory the map covers. */
	root: string;
	text: string;
	tokens: number;
	/** Definitions the budget allowed into `text`. */
	definitions: number;
	files: number;
	/** Definitions the scan found, including the ones the budget left out. */
	totalDefinitions: number;
	totalFiles: number;
	/** Whether the budget cut the map short. */
	partial: boolean;
	/**
	 * Whether the walk stopped at the scan ceiling before it had seen the whole
	 * tree. A truncated map still ranks what it read; it just cannot claim the
	 * repository has nothing else in it.
	 */
	truncated: boolean;
	/**
	 * Files the scan found but could not read, or skipped for being over
	 * `maxFileBytes`. They are absent from the map, so a footer that only counts
	 * what was read would present a hole as empty space.
	 */
	skipped: number;
	/** Directories the walk could not list; everything below each is unindexed. */
	unreadableDirectories: number;
	elapsedMs: number;
}

/** The small-repository answer offered to the system prompt. */
export interface RepoMapPromptSection {
	text: string;
	tokens: number;
	definitions: number;
	files: number;
}

export interface RepoMapPromptOptions {
	/** File-count ceiling. Default: `REPO_MAP_PROMPT_MAX_FILES`. */
	maxFiles?: number;
	/** Total-bytes ceiling. Default: `REPO_MAP_PROMPT_MAX_BYTES`. */
	maxBytes?: number;
	/** Budget the section is rendered under. Default: 1024. */
	maxTokens?: number;
}

function clampTokens(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return REPO_MAP_DEFAULT_TOKENS;
	return Math.min(REPO_MAP_MAX_TOKENS, Math.max(REPO_MAP_MIN_TOKENS, Math.floor(value)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A repository map over one workspace.
 *
 * One instance per session: the cache is the expensive part, and a tool call,
 * a `/map-refresh` and the startup prompt section that each built their own
 * would scan the same files three times. The service is safe to call
 * concurrently — the cache is synchronous and each map's scan is independent —
 * which is what makes the tool's `isConcurrencySafe` true.
 */
export class RepoMapService {
	readonly root: string;
	readonly #ops: RepoMapOps;
	readonly #pattern: Bun.Glob;
	readonly #respectGitignore: boolean;
	readonly #maxFileBytes: number | undefined;
	readonly #onUnreadableDirectory: ((path: string) => void) | undefined;
	readonly #maxFiles: number;
	readonly #parseWorkers: number;
	readonly #cachePath: string | undefined;
	#explicitCache: RepoMapCache<RepoMapFileTags> | undefined;
	#cache: RepoMapCache<RepoMapFileTags> | undefined;
	#inflight = 0;

	constructor(options: RepoMapServiceOptions) {
		this.root = options.root;
		this.#ops = options.ops;
		this.#pattern = options.pattern ?? REPO_MAP_CODE_FILES;
		this.#respectGitignore = options.respectGitignore ?? true;
		this.#maxFileBytes = options.maxFileBytes;
		this.#onUnreadableDirectory = options.onUnreadableDirectory;
		this.#maxFiles = options.maxFiles ?? REPO_MAP_SCAN_MAX_FILES;
		this.#parseWorkers = options.parseWorkers ?? defaultRepoMapParseWorkers();
		this.#cachePath = options.cachePath;
		this.#explicitCache = options.cache;
	}

	/** The cache in use, created on first need so a session that never maps opens no file. */
	#getCache(): RepoMapCache<RepoMapFileTags> {
		if (this.#explicitCache) return this.#explicitCache;
		if (this.#cache) return this.#cache;
		if (this.#cachePath) {
			try {
				this.#cache = new SqliteRepoMapCache<RepoMapFileTags>(this.#cachePath);
			} catch {
				// A read-only home or a locked file is no reason to lose the map;
				// the in-memory cache is the same map without the persistence.
				this.#cache = new InMemoryRepoMapCache<RepoMapFileTags>();
			}
		} else {
			this.#cache = new InMemoryRepoMapCache<RepoMapFileTags>();
		}
		return this.#cache;
	}

	#resetCache(): void {
		const cache = this.#getCache() as RepoMapCache<RepoMapFileTags> & { clear?: () => void };
		if (typeof cache.clear === "function") {
			cache.clear();
			return;
		}
		// A caller's cache without a clear contract: drop it and let the next map
		// build one this service can refresh.
		this.#explicitCache = undefined;
		this.#cache = undefined;
	}

	/**
	 * Run one map against the session cache, and close the SQLite handle this
	 * service opened once no other map is using it.
	 *
	 * The rows stay on disk, so the next call — or the next session — reopens
	 * into the same cache. What does not stay is an open database file: on
	 * Windows its WAL sidecar keeps the directory from being removed, and a
	 * long-running session has no reason to hold it between maps. A
	 * caller-supplied cache is never closed here; the caller owns it.
	 *
	 * The counter is what keeps concurrent maps safe: the first one to finish
	 * does not close the handle the second is still reading through.
	 */
	async #withCache<T>(body: (cache: RepoMapCache<RepoMapFileTags>) => Promise<T>): Promise<T> {
		this.#inflight++;
		try {
			return await body(this.#getCache());
		} finally {
			this.#inflight--;
			if (this.#inflight === 0 && this.#cache instanceof SqliteRepoMapCache) {
				this.#cache.close();
				this.#cache = undefined;
			}
		}
	}

	/** The canonical directory a request names, refusing anything outside the workspace. */
	#resolveRoot(path: string | undefined): string {
		return path ? guardPathContainment(path, this.root, "RepoMap") : resolveCanonical(this.root, this.root);
	}

	/** Render a map and report how much of the repository the budget left out. */
	async map(request: RepoMapRequest = {}): Promise<RepoMapSummary> {
		const started = performance.now();
		const root = this.#resolveRoot(request.path);
		try {
			await this.#ops.readdir(root);
		} catch (error) {
			throw new Error(`RepoMap: cannot read ${root}: ${errorMessage(error)}`);
		}
		if (request.refresh) this.#resetCache();
		let truncated = false;
		let unreadableDirectories = 0;
		const scan = await this.#withCache((cache) =>
			buildRepoMapTags(root, this.#ops, {
				cache,
				pattern: this.#pattern,
				respectGitignore: this.#respectGitignore,
				maxFileBytes: this.#maxFileBytes,
				onUnreadableDirectory: (path) => {
					unreadableDirectories++;
					this.#onUnreadableDirectory?.(path);
				},
				maxFiles: this.#maxFiles,
				parseWorkers: this.#parseWorkers,
				onTruncated: () => {
					truncated = true;
				},
				signal: request.signal,
			}),
		);
		const entries = rankRepoMap(scan.files, {
			chatFiles: request.chatFiles,
			mentionedFiles: request.mentionedFiles,
			mentionedIdents: request.mentionedIdents,
		});
		const rendered = renderRepoMap(entries, { tokenBudget: clampTokens(request.maxTokens) });
		return {
			root,
			text: rendered.text,
			tokens: rendered.tokens,
			definitions: rendered.definitions,
			files: rendered.files,
			totalDefinitions: scan.stats.definitions,
			totalFiles: scan.stats.files,
			partial: rendered.definitions < scan.stats.definitions,
			truncated,
			skipped: scan.stats.skipped,
			unreadableDirectories,
			elapsedMs: performance.now() - started,
		};
	}

	/**
	 * The map to put in the system prompt, or `undefined` when the repository is
	 * too large for that to be honest.
	 *
	 * Three conditions, and each one is a way the section could do harm rather
	 * than help: the walk (not the scan) has to fit the file and byte ceilings,
	 * because a cold scan of a huge checkout delays startup; the scan has to find
	 * at least one definition, because a heading over an empty section is bytes
	 * the model is told to read and finds nothing in; and every definition has to
	 * fit the budget, because a truncated map presented as *the* map says the
	 * files it left out have nothing in them. A large repository gets the
	 * RepoMap tool instead, where the budget is visible and adjustable.
	 */
	async promptSection(options: RepoMapPromptOptions = {}): Promise<RepoMapPromptSection | undefined> {
		const root = resolveCanonical(this.root, this.root);
		const maxFiles = options.maxFiles ?? REPO_MAP_PROMPT_MAX_FILES;
		const maxBytes = options.maxBytes ?? REPO_MAP_PROMPT_MAX_BYTES;
		const paths = await walkProjectFiles(root, this.#ops, {
			pattern: this.#pattern,
			respectGitignore: this.#respectGitignore,
			onUnreadableDirectory: this.#onUnreadableDirectory,
			// One past the ceiling is all the answer needs: a repository with 201
			// files is already too large, and walking five thousand to learn that
			// delays every startup.
			maxFiles: maxFiles + 1,
			// The byte pass below stats every path; a mtime order nobody reads
			// would stat them all once more.
			sortByMtime: false,
		});
		if (paths.length === 0 || paths.length > maxFiles) return undefined;
		let bytes = 0;
		for (const path of paths) {
			const stat = await this.#ops.stat(path).catch(() => null);
			if (!stat) continue;
			bytes += stat.size;
			if (bytes > maxBytes) return undefined;
		}
		const summary = await this.map({ maxTokens: options.maxTokens ?? REPO_MAP_DEFAULT_TOKENS });
		if (summary.totalDefinitions === 0) return undefined;
		if (summary.definitions !== summary.totalDefinitions) return undefined;
		return {
			text: summary.text,
			tokens: summary.tokens,
			definitions: summary.definitions,
			files: summary.files,
		};
	}

	/**
	 * Release a SQLite handle that is open right now, if any. Normally there is
	 * none: each map closes the one it opened once it is the last one running.
	 */
	close(): void {
		if (this.#cache instanceof SqliteRepoMapCache) this.#cache.close();
		this.#cache = undefined;
	}
}
