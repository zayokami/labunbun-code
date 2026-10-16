/**
 * `inspect-sqlite.ts` — the report, and the promise under it: the source file
 * is only ever read as bytes.
 *
 * Every database here is synthesized on the spot with `bun:sqlite`; no binary
 * fixture enters the repository. The WAL case is built by keeping a writer
 * open, because a cleanly closed WAL database checkpoints its log away — the
 * interesting state is the one a live session has, where the newest rows exist
 * only in the `-wal` sidecar and a copy of the main file alone would describe
 * a different database. The read-only claim is measured, not asserted: the
 * source's bytes before the call are held against the bytes after it, and
 * nothing new may sit beside the file when the call returns.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInspectSqliteTool } from "../src/inspect-sqlite.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-inspect-sqlite-"));
	roots.push(dir);
	return dir;
}

const ctx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("InspectSqlite reports a database", () => {
	test("journal mode, tables, schema, counts and preview rows", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "app.sqlite");
		const db = new Database(dbPath);
		db.exec(
			"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n" +
				"INSERT INTO users (name) VALUES ('ada'), ('bob'), ('cyd');\n" +
				"CREATE TABLE notes (body TEXT);\n",
		);
		db.close();

		const result = await createInspectSqliteTool(dir).call({ path: "app.sqlite" }, ctx(dir));
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("InspectSqlite report for app.sqlite");
		// The printed hash is the file's, so a reader can hash it themselves and
		// get this line back.
		expect(text).toContain(`source sha256: ${sha256(readFileSync(dbPath))}`);
		expect(text).toContain("journal mode: delete");
		expect(text).toContain("2 table(s)");
		expect(text).toContain('table "notes": 1 column(s), 0 row(s)');
		expect(text).toContain("CREATE TABLE notes (body TEXT)");
		expect(text).toContain("(no rows)");
		expect(text).toContain('table "users": 2 column(s), 3 row(s)');
		expect(text).toContain("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
		expect(text).toContain('{"id": 1, "name": "ada"}');
		expect(text).toContain('{"id": 3, "name": "cyd"}');
	});

	test("the preview stops at five rows and counts the rest", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "seven.sqlite");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE numbers (n INTEGER);\nINSERT INTO numbers (n) VALUES (1), (2), (3), (4), (5), (6), (7);\n");
		db.close();

		const text = textOf(await createInspectSqliteTool(dir).call({ path: "seven.sqlite" }, ctx(dir)));

		expect(text).toContain('table "numbers": 1 column(s), 7 row(s)');
		expect(text).toContain('{"n": 5}');
		expect(text).not.toContain('{"n": 6}');
		expect(text).toContain("... and 2 more row(s)");
	});

	test("a live WAL database is read through its sidecars, from the copy", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "live.db");
		const db = new Database(dbPath);
		db.exec("PRAGMA journal_mode=WAL;\nCREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT);\n");
		db.exec("INSERT INTO events (label) VALUES ('first'), ('second');\n");
		// Still open: the -wal file is where the newest rows live, so copying only
		// the main file would have produced a report about a different database.
		expect(existsSync(`${dbPath}-wal`)).toBe(true);
		const before = readFileSync(dbPath);

		const result = await createInspectSqliteTool(dir).call({ path: "live.db" }, ctx(dir));
		const text = textOf(result);
		// The writer's own close is the only thing allowed to rewrite the file
		// afterwards (a checkpoint), so "after" is read while it is still open.
		const after = readFileSync(dbPath);
		db.close();

		expect(result.isError).toBeFalsy();
		expect(text).toContain("journal mode: wal");
		expect(text).toContain("-wal write-ahead log sat beside the source");
		expect(text).toContain('table "events": 2 column(s), 2 row(s)');
		expect(text).toContain('{"id": 2, "label": "second"}');
		expect(after.equals(before)).toBe(true);
	});

	test("the source is byte-identical after the inspection, and no litter sits beside it", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "stable.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE t (v INTEGER);\nINSERT INTO t VALUES (1);\n");
		db.close();
		const before = readFileSync(dbPath);

		const result = await createInspectSqliteTool(dir).call({ path: "stable.db" }, ctx(dir));

		expect(result.isError).toBeFalsy();
		expect(readFileSync(dbPath).equals(before)).toBe(true);
		// The copy is the tool's to clean up; the source directory sees nothing new.
		expect(readdirSync(dir)).toEqual(["stable.db"]);
	});

	test("a file that is not a database is refused with its own message", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "not.sqlite"), "this is text, not a database");

		const result = await createInspectSqliteTool(dir).call({ path: "not.sqlite" }, ctx(dir));

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not a SQLite database");
	});

	test("a missing path and a directory are each refused before any copy", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "a-dir"));
		const tool = createInspectSqliteTool(dir);

		const missing = await tool.call({ path: "gone.sqlite" }, ctx(dir));
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("Path not found: gone.sqlite");

		const asDir = await tool.call({ path: "a-dir" }, ctx(dir));
		expect(asDir.isError).toBe(true);
		expect(textOf(asDir)).toContain("is a directory, not a SQLite file");
	});

	test("a report past the cap is cut with an explicit marker", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "many.sqlite");
		const db = new Database(dbPath);
		const statements: string[] = [];
		for (let i = 0; i < 600; i++) {
			statements.push(`CREATE TABLE t${i} (v INTEGER);\nINSERT INTO t${i} VALUES (${i});`);
		}
		db.exec(`${statements.join("\n")}\n`);
		db.close();

		const text = textOf(await createInspectSqliteTool(dir).call({ path: "many.sqlite" }, ctx(dir)));

		expect(text).toContain("600 table(s)");
		// The head survives, the missing tail is counted, and the fact that
		// something was cut is not left for the reader to notice by counting.
		expect(text).toMatch(/\.\.\. \[truncated \d+ chars of output\]$/);
		expect(text.length).toBeLessThan(21_000);
	});
});
