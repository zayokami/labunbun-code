// Persistent repository-map cache. P0 kept definitions in a Map that died with
// the process; scanning a large checkout on every start is exactly the cost the
// map is supposed to avoid. The payload column is opaque JSON, so the same table
// serves P0's definitions and P1's tags. A schema change bumps the table name.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RepoMapCache } from "./repomap.ts";

// v2 stores tags without their repeated file path; the shape change is why the
// table was renamed, so an older binary cannot read rows it would misread.
const TABLE = "repo_map_cache_v2";

interface CacheRow {
	mtime_ms: number;
	size: number;
	data: string;
}

interface CountRow {
	count: number;
}

/**
 * `RepoMapCache` backed by `bun:sqlite`. Use `:memory:` for a durable-shaped
 * cache that still dies with the process, or a file path for one shared by
 * every start. The key is the absolute path; mtime and size are validated on
 * read exactly as the in-memory cache does.
 */
export class SqliteRepoMapCache<T> implements RepoMapCache<T> {
	readonly #db: Database;
	readonly #get: ReturnType<Database["query"]>;
	readonly #set: ReturnType<Database["query"]>;
	readonly #count: ReturnType<Database["query"]>;
	/**
	 * Writes wait here until `flush`. Autocommitting each file costs an fsync per
	 * row — on a twenty-thousand-file tree that is seconds spent on the disk, not
	 * on the scan. `get` reads the buffer first so a scan that is filling the
	 * cache still sees what it just wrote.
	 */
	readonly #pending = new Map<string, { mtimeMs: number; size: number; data: string }>();

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true });
		this.#db.run("PRAGMA journal_mode = WAL");
		// WAL's recommended durability level: a crash can lose the newest commits
		// but not corrupt the database, and the cache can be rebuilt from disk
		// anyway. FULL makes every autocommit fsync.
		this.#db.run("PRAGMA synchronous = NORMAL");
		// Several sessions in one checkout share this file; without a timeout a
		// concurrent write fails the whole map instead of waiting its turn.
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS ${TABLE} (
				path TEXT PRIMARY KEY,
				mtime_ms REAL NOT NULL,
				size INTEGER NOT NULL,
				data TEXT NOT NULL
			)`,
		);
		this.#get = this.#db.query(`SELECT mtime_ms, size, data FROM ${TABLE} WHERE path = ?`);
		this.#set = this.#db.query(
			`INSERT INTO ${TABLE} (path, mtime_ms, size, data) VALUES (?, ?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, data = excluded.data`,
		);
		this.#count = this.#db.query(`SELECT COUNT(*) AS count FROM ${TABLE}`);
	}

	get(path: string, mtimeMs: number, size: number): T | undefined {
		const pending = this.#pending.get(path);
		if (pending) {
			if (pending.mtimeMs !== mtimeMs || pending.size !== size) return undefined;
			try {
				return JSON.parse(pending.data) as T;
			} catch {
				return undefined;
			}
		}
		const row = this.#get.get(path) as CacheRow | null;
		if (!row || row.mtime_ms !== mtimeMs || row.size !== size) return undefined;
		try {
			return JSON.parse(row.data) as T;
		} catch {
			// A corrupted row is a cache miss, not a scan failure; the set below
			// overwrites it.
			return undefined;
		}
	}

	set(path: string, mtimeMs: number, size: number, data: T): void {
		this.#pending.set(path, { mtimeMs, size, data: JSON.stringify(data) });
	}

	/** Write every buffered row in one transaction. */
	flush(): void {
		if (this.#pending.size === 0) return;
		const rows = [...this.#pending];
		this.#db.transaction(() => {
			for (const [path, row] of rows) this.#set.run(path, row.mtimeMs, row.size, row.data);
		})();
		this.#pending.clear();
	}

	get size(): number {
		return (this.#count.get() as CountRow).count + this.#pending.size;
	}

	clear(): void {
		this.#pending.clear();
		this.#db.run(`DELETE FROM ${TABLE}`);
	}

	close(): void {
		this.flush();
		this.#db.close();
	}
}
