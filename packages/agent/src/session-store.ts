/**
 * Append-only JSONL session tree: every entry links to its parent by id, so
 * branching and forking are structural rather than bolted on.
 *
 * Every entry links to its parent by id, so branching/forking is structural.
 * The linear conversation view walks header → active leaf. Appends are
 * crash-safe: a torn final line is ignored on load.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";

export type SessionEntry =
	| {
			id: string;
			parentId: string | null;
			type: "header";
			version: 1;
			sessionId: string;
			cwd: string;
			createdAt: number;
	  }
	| { id: string; parentId: string; type: "message"; timestamp: number; message: AgentMessage }
	| {
			id: string;
			parentId: string;
			type: "compaction";
			timestamp: number;
			summary: string;
			preservedFiles: string[];
			preTokens: number;
	  }
	| { id: string; parentId: string; type: "custom"; timestamp: number; kind: string; data: unknown };

/** Sanitize a cwd into a filesystem-safe project directory name. */
export function sanitizeCwd(cwd: string): string {
	return cwd.replace(/[:\\/]/g, "-");
}

export function sessionsRoot(home = homedir()): string {
	return join(home, ".labunbun", "projects");
}

export function sessionFilePath(cwd: string, sessionId: string, home = homedir()): string {
	return join(sessionsRoot(home), sanitizeCwd(cwd), `${sessionId}.jsonl`);
}

let idCounter = 0;

/** Generate an entry id: monotonic counter + random suffix. */
export function newEntryId(): string {
	idCounter = (idCounter + 1) % 0xffff;
	return `${Date.now().toString(36)}${idCounter.toString(36).padStart(4, "0")}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
}

export class SessionStore {
	readonly path: string;
	readonly entries: SessionEntry[] = [];
	#leafId: string | null = null;

	constructor(path: string) {
		this.path = path;
	}

	get sessionId(): string | null {
		const header = this.entries.find((e): e is Extract<SessionEntry, { type: "header" }> => e.type === "header");
		return header?.sessionId ?? null;
	}

	static startNew(cwd: string, home?: string): SessionStore {
		const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
		const path = sessionFilePath(cwd, sessionId, home);
		mkdirSync(dirname(path), { recursive: true });
		const store = new SessionStore(path);
		store.append({
			id: newEntryId(),
			parentId: null,
			type: "header",
			version: 1,
			sessionId,
			cwd,
			createdAt: Date.now(),
		});
		return store;
	}

	/** Load an existing session file; torn trailing lines are skipped. */
	static load(path: string): SessionStore {
		const store = new SessionStore(path);
		if (!existsSync(path)) return store;
		const text = readFileSync(path, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				store.entries.push(JSON.parse(trimmed) as SessionEntry);
			} catch {
				break; // torn write at the tail — stop there
			}
		}
		store.#recomputeLeaf();
		return store;
	}

	static listSessions(cwd?: string, home = homedir()): Array<{ path: string; sessionId: string; mtimeMs: number }> {
		const root = cwd ? join(sessionsRoot(home), sanitizeCwd(cwd)) : sessionsRoot(home);
		if (!existsSync(root)) return [];
		const out: Array<{ path: string; sessionId: string; mtimeMs: number }> = [];
		for (const dir of [root]) {
			try {
				for (const name of readdirSync(dir)) {
					if (!name.endsWith(".jsonl")) continue;
					const full = join(dir, name);
					const stat = statSync(full);
					out.push({ path: full, sessionId: name.replace(/\.jsonl$/, ""), mtimeMs: stat.mtimeMs });
				}
			} catch {}
		}
		return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	}

	append(entry: SessionEntry): void {
		this.entries.push(entry);
		this.#leafId = entry.id;
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	appendMessage(message: AgentMessage): SessionEntry {
		const entry: SessionEntry = {
			id: newEntryId(),
			parentId: this.#leafId ?? this.entries[this.entries.length - 1]?.id ?? "",
			type: "message",
			timestamp: Date.now(),
			message,
		};
		this.append(entry);
		return entry;
	}

	appendCustom(kind: string, data: unknown): SessionEntry {
		const entry: SessionEntry = {
			id: newEntryId(),
			parentId: this.#leafId ?? this.entries[this.entries.length - 1]?.id ?? "",
			type: "custom",
			timestamp: Date.now(),
			kind,
			data,
		};
		this.append(entry);
		return entry;
	}

	/** Linear view: header → active leaf. */
	linearEntries(): SessionEntry[] {
		if (this.entries.length === 0) return [];
		const byId = new Map(this.entries.map((e) => [e.id, e]));
		const leaf = (this.#leafId && byId.get(this.#leafId)) || this.entries[this.entries.length - 1];
		const chain: SessionEntry[] = [];
		let cursor: SessionEntry | undefined = leaf;
		while (cursor) {
			chain.unshift(cursor);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		return chain;
	}

	/** Messages in the linear view (header/compaction/custom filtered). */
	messages(): AgentMessage[] {
		return this.linearEntries()
			.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
			.map((e) => e.message);
	}

	#recomputeLeaf(): void {
		this.#leafId = this.entries[this.entries.length - 1]?.id ?? null;
	}
}
