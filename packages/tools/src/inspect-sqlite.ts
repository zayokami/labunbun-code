/**
 * InspectSqlite — what a SQLite file holds, read from a copy, never from the file itself.
 *
 * Why the copy: SQLite's own readers are not passive visitors. A WAL-mode
 * database is opened through its `-wal`/`-shm` sidecars and even a plain read
 * takes locks on the file, so pointing a query engine at a database someone
 * asked to have *looked at* is a tool risking writes to it. Instead the
 * database — and whichever sidecars sit beside it — is copied into a temporary
 * directory, and the copy is opened with `readonly: true`. The original is
 * only ever read as bytes, which also answers "what if the database is
 * live": a copy sees the rows committed at copy time, where a read of the
 * original would contend for locks with whatever else is using it.
 *
 * The promise is made measurable rather than asserted: the source's SHA-256
 * is taken before the copy and again after it, both hashes are compared (a
 * mismatch refuses the report — it would describe a mixture of two file
 * states), and the hash is printed so the reader can hold the same number
 * against a hash of their own. The report is bounded like every other tool's:
 * five preview rows per table, and a whole-report cap that says what it cut.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { hashFile } from "./digest.ts";

/** Rows of a table the report previews before it counts the rest. */
const PREVIEW_ROWS = 5;

/** How much of one cell a preview row shows before it is cut. */
const MAX_CELL_CHARS = 80;

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** Structure and sample rows of one SQLite database file. */
export function createInspectSqliteTool(cwd: string): AnyTool {
	return buildTool({
		name: "InspectSqlite",
		description:
			"Reports what a SQLite database file holds: journal mode, each table's column count, row count, " +
			"CREATE statement and first rows. The database is copied to a temporary directory first and the " +
			"copy is opened read-only, so the original file is never opened by SQLite; the source's SHA-256 " +
			"is printed for the reader to check. Use it to answer questions about a database's structure or " +
			"sample data without touching the file.",
		inputSchema: z.object({
			path: z.string().describe("Path to the SQLite database file (.sqlite/.db, any name)"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "InspectSqlite");
			} catch (error) {
				return { content: [{ type: "text", text: message(error) }], isError: true };
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(source);
			} catch {
				return { content: [{ type: "text", text: `Path not found: ${input.path}` }], isError: true };
			}
			if (info.isDirectory()) {
				return {
					content: [{ type: "text", text: `${input.path} is a directory, not a SQLite file.` }],
					isError: true,
				};
			}
			if (!info.isFile()) {
				return {
					content: [{ type: "text", text: `${input.path} is not a regular file.` }],
					isError: true,
				};
			}

			const before = await hashFile(source);
			const temp = mkdtempSync(join(tmpdir(), "lbb-inspect-sqlite-"));
			let db: Database | null = null;
			try {
				const copyPath = join(temp, basename(source));
				copyFileSync(source, copyPath);
				// The sidecars are part of the state: in WAL mode the rows committed
				// a moment ago live in `-wal` and nothing smaller than all three
				// files is the database.
				const sidecars = ["-wal", "-shm"].filter((suffix) => existsSync(`${source}${suffix}`));
				for (const suffix of sidecars) copyFileSync(`${source}${suffix}`, `${copyPath}${suffix}`);

				const after = await hashFile(source);
				if (after !== before) {
					return {
						content: [
							{
								type: "text",
								text:
									`InspectSqlite: ${input.path}: the source changed while it was being copied ` +
									`(sha256 ${before} → ${after}); nothing was inspected, because the copy could ` +
									`describe a mixture of two file states.`,
							},
						],
						isError: true,
					};
				}

				let report: string;
				try {
					db = new Database(copyPath, { readonly: true });
					report = buildReport(input.path, before, sidecars, db);
				} catch (error) {
					return {
						content: [
							{ type: "text", text: `InspectSqlite: ${input.path}: not a SQLite database (${message(error)})` },
						],
						isError: true,
					};
				}
				return { content: [{ type: "text", text: capReport(report) }] };
			} finally {
				try {
					db?.close();
				} catch {
					// Closing a handle that never opened, or already failed, is best-effort.
				}
				// The read-only handle can outlive `close` by a beat — measured on
				// Windows as an EBUSY on the first removal — so the removal retries,
				// and a directory that still lingers is left for the OS temp cleaner
				// rather than for a caller whose report is already built.
				try {
					rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				} catch {
					// Best effort, as above.
				}
			}
		},
	});
}

/**
 * The report, in the order a reader asks: what was hashed, how the file keeps
 * its journal, which tables exist, then each table's shape and a sample.
 */
function buildReport(displayPath: string, sourceHash: string, sidecars: readonly string[], db: Database): string {
	const lines = [`InspectSqlite report for ${displayPath}`, `source sha256: ${sourceHash}`];
	const journal = (db.query("PRAGMA journal_mode").get() as { journal_mode?: unknown } | null)?.journal_mode;
	const walNote = sidecars.includes("-wal") ? " (a -wal write-ahead log sat beside the source and was copied too)" : "";
	lines.push(`journal mode: ${String(journal ?? "unknown")}${walNote}`);

	const tables = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
		name: string;
		sql: string | null;
	}>;
	lines.push(`${tables.length} table(s)`);
	if (tables.length === 0) lines.push("(no tables)");
	for (const table of tables) {
		lines.push("", ...tableSection(db, table.name, table.sql));
	}
	return lines.join("\n");
}

/** One table's section: its shape, its CREATE statement, and up to `PREVIEW_ROWS` rows. */
function tableSection(db: Database, name: string, sql: string | null): string[] {
	// The name goes into an identifier position, so it is quoted and any quote
	// inside it doubled — `SELECT * FROM` a table whose name came from the file
	// must not be read as a statement the file gets to write.
	const quoted = `"${name.replaceAll('"', '""')}"`;
	const out: string[] = [];
	try {
		const columns = (db.query("SELECT COUNT(*) AS n FROM pragma_table_info(?)").get(name) as { n: number }).n;
		const total = (db.query(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }).n;
		out.push(`table ${quoted}: ${columns} column(s), ${total} row(s)`);
		out.push(`  ${sql ?? "(no CREATE statement recorded)"}`);
		const rows = db.query(`SELECT * FROM ${quoted} LIMIT ${PREVIEW_ROWS}`).all() as Array<Record<string, unknown>>;
		if (rows.length === 0) out.push("  (no rows)");
		for (const row of rows) out.push(`  ${renderRow(row)}`);
		if (total > rows.length) out.push(`  ... and ${total - rows.length} more row(s)`);
	} catch (error) {
		// A table read that fails costs its own section, not the report — the
		// other tables are still answers to the question that was asked.
		out.push(`table ${quoted}: could not be read (${message(error)})`);
	}
	return out;
}

/** One preview row as `{"col": value, ...}` with long values cut to size. */
function renderRow(row: Record<string, unknown>): string {
	const parts = Object.entries(row).map(([key, value]) => `${JSON.stringify(key)}: ${renderCell(value)}`);
	return `{${parts.join(", ")}}`;
}

function renderCell(value: unknown): string {
	if (value === null) return "null";
	// A BLOB is bytes, not text; showing them as a string would corrupt them,
	// and showing them in full would drown every other column.
	if (value instanceof Uint8Array) return `"<${value.byteLength} byte blob>"`;
	if (typeof value === "string") {
		return JSON.stringify(value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value);
	}
	return JSON.stringify(value) ?? String(value);
}

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(report.length - MAX_REPORT_CHARS)}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
