/**
 * Prompt history: one global append-only JSONL powering ↑ recall.
 * Entries are tagged with project cwd so recall can be filtered per project.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryEntry {
	text: string;
	cwd: string;
	timestamp: number;
}

export function historyFilePath(home = homedir()): string {
	return join(home, ".labunbun", "history.jsonl");
}

export function appendHistory(text: string, cwd: string, home?: string): void {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("/")) return;
	const path = historyFilePath(home);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const entry: HistoryEntry = { text: trimmed, cwd, timestamp: Date.now() };
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// best-effort
	}
}

/** The history file as it stands, for a writer that has to merge into it. */
export interface HistoryFile {
	/** Non-empty lines, oldest first, exactly as they are on disk. */
	lines: string[];
	/** The entries those lines define; a line that does not parse defines none. */
	entries: HistoryEntry[];
}

/**
 * Read the history file whole.
 *
 * Lines come back as they were rather than re-serialised: the file is appended
 * to by whatever REPL is running while a migration happens, and a line this
 * build cannot parse is still the user's data — a merge that re-emitted only
 * what it understood would be a way to lose it.
 */
export function readHistoryFile(home?: string): HistoryFile {
	const path = historyFilePath(home);
	const lines: string[] = [];
	const entries: HistoryEntry[] = [];
	try {
		if (!existsSync(path)) return { lines, entries };
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			lines.push(line);
			try {
				const parsed = JSON.parse(line) as HistoryEntry;
				if (typeof parsed?.text === "string" && typeof parsed.cwd === "string") entries.push(parsed);
			} catch {
				// kept as a line; contributes no entry
			}
		}
	} catch {
		return { lines, entries };
	}
	return { lines, entries };
}

/** Most recent entries, newest last. Optionally filter by project cwd. */
export function loadHistory(cwd?: string, limit = 100, home?: string): string[] {
	const path = historyFilePath(home);
	if (!existsSync(path)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as HistoryEntry;
				if (cwd && entry.cwd !== cwd) continue;
				if (!seen.has(entry.text)) {
					seen.add(entry.text);
					out.push(entry.text);
				}
			} catch {}
		}
	} catch {
		return [];
	}
	return out.reverse();
}
