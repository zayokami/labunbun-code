// Persistent repository-map cache. P0 kept definitions in a Map that died with
// the process; scanning a large checkout on every start is exactly the cost the
// map is supposed to avoid. The payload column is opaque JSON, so the same table
// serves P0's definitions and P1's tags. A schema change bumps the table name.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RepoMapCache } from "./repomap.ts";

const TABLE = "repo_map_cache_v1";

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

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true });
		this.#db.run("PRAGMA journal_mode = WAL");
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
		this.#set.run(path, mtimeMs, size, JSON.stringify(data));
	}

	get size(): number {
		return (this.#count.get() as CountRow).count;
	}

	clear(): void {
		this.#db.run(`DELETE FROM ${TABLE}`);
	}

	close(): void {
		this.#db.close();
	}
}
