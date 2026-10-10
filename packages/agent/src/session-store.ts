// Append-only JSONL session tree. Entries link by id, and a bad line costs only itself.
// Long-form design notes: docs/dev/session-store.md
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
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
			/**
			 * The user message that stands in for everything above it. It lives on
			 * this entry rather than as a `message` entry of its own so the boundary
			 * and the record of it are written together — a torn pair would resume
			 * from a summary whose context was already gone.
			 */
			message: AgentMessage;
			summary: string;
			preservedFiles: string[];
			preTokens: number;
			postTokens: number;
			/** Which model wrote the summary. */
			model: string;
			trigger: CompactionTrigger;
	  }
	| { id: string; parentId: string; type: "custom"; timestamp: number; kind: string; data: unknown };

// Long-form design notes: docs/dev/session-store.md
/** What set a compaction off: the threshold, `/compact`, or a size refusal from the provider. */
export type CompactionTrigger = "auto" | "manual" | "overflow";

/** What a compaction leaves behind. */
export interface CompactionRecord {
	/** The boundary message that replaces everything above the suffix. */
	boundary: AgentMessage;
	/** Messages kept verbatim below it, in order. */
	suffix: AgentMessage[];
	summary: string;
	preservedFiles: string[];
	preTokens: number;
	postTokens: number;
	model: string;
	trigger: CompactionTrigger;
}

function isMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message";
}

// Long-form design notes: docs/dev/session-store.md
/** Whether the live message is the one the file holds, as far as can be told. */
function sameMessage(stored: AgentMessage | undefined, live: AgentMessage | undefined): boolean {
	if (stored === live) return true;
	return (
		stored?.role === "toolResult" &&
		live?.role === "toolResult" &&
		stored.toolCallId === live.toolCallId &&
		stored.toolName === live.toolName &&
		stored.isError === live.isError
	);
}

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
	/**
	 * Every entry, in the order the file holds them. Only this class appends: the
	 * cached walk below is invalidated by those appends, not by watching the array.
	 */
	readonly entries: SessionEntry[] = [];
	#leafId: string | null = null;
	#skippedLines = 0;
	#truncated = false;
	/** The walk `linearEntries` last returned, until the tree it described changed. */
	#linear: SessionEntry[] | null = null;

	constructor(path: string) {
		this.path = path;
	}

	get sessionId(): string | null {
		const header = this.entries.find((e): e is Extract<SessionEntry, { type: "header" }> => e.type === "header");
		return header?.sessionId ?? null;
	}

	// Long-form design notes: docs/dev/session-store.md
	/** Lines this store could not read: not an entry, or not JSON. */
	get skippedLines(): number {
		return this.#skippedLines;
	}

	/** True when the file was longer than the caller let this store read. */
	get truncated(): boolean {
		return this.#truncated;
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

	// Long-form design notes: docs/dev/session-store.md
	/** Load an existing session file, one line at a time. */
	static load(path: string, options: { maxBytes?: number } = {}): SessionStore {
		const store = new SessionStore(path);
		if (!existsSync(path)) return store;
		let text = options.maxBytes === undefined ? readFileSync(path, "utf8") : readHead(path, options.maxBytes);
		if (options.maxBytes !== undefined) {
			// The size, not the read: a file that is exactly the cap was read whole.
			store.#truncated = statSync(path).size > options.maxBytes;
			if (store.#truncated) {
				// A byte prefix ends mid-line, and that fragment is not damage — it is
				// where the caller's cap fell. Dropping it here keeps `skippedLines`
				// meaning damage, so a capped read cannot report a loss it did not find.
				const lastBreak = text.lastIndexOf("\n");
				text = lastBreak === -1 ? "" : text.slice(0, lastBreak);
			}
		}
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				store.#skippedLines++;
				continue;
			}
			// Parsed JSON is not yet an entry: `{}` parses, and an entry with no id
			// would join the chain as a node nothing can point at.
			if (!isEntryShaped(entry)) {
				store.#skippedLines++;
				continue;
			}
			store.entries.push(entry);
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
		this.#linear = null;
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

	// Long-form design notes: docs/dev/session-store.md
	/** Linear view: header → active leaf, cached until the tree changes. */
	linearEntries(): readonly SessionEntry[] {
		if (this.#linear) return this.#linear;
		const chain: SessionEntry[] = [];
		if (this.entries.length > 0) {
			// A loop rather than `Map` over a mapped array: the short form builds a
			// two-element array per entry to throw it away, which was a fifth of what
			// the map cost at 20,000 entries.
			const byId = new Map<string, SessionEntry>();
			for (const entry of this.entries) byId.set(entry.id, entry);
			const leaf = (this.#leafId && byId.get(this.#leafId)) || this.entries[this.entries.length - 1];
			// Only the fallback below needs an entry's position, and it runs when a
			// link is broken — rare enough that the second map is built on the walk
			// that needs it rather than on every walk.
			let position: Map<string, number> | null = null;
			const seen = new Set<string>();
			let cursor: SessionEntry | undefined = leaf;
			while (cursor && !seen.has(cursor.id)) {
				seen.add(cursor.id);
				// Collected leaf-ward and reversed once at the end: `unshift` on every
				// step moves the whole chain each time, which is the other half of why
				// this walk was quadratic.
				chain.push(cursor);
				if (!cursor.parentId) break;
				const parent = byId.get(cursor.parentId);
				if (parent) {
					cursor = parent;
					continue;
				}
				// Annotated because the walk closes a loop over this variable: the
				// narrowed type of `cursor` on the line below is computed from the
				// assignment that uses `index`, so letting `index` be inferred from the
				// lookup would ask for both types at once.
				if (!position) {
					position = new Map<string, number>();
					for (const [i, entry] of this.entries.entries()) position.set(entry.id, i);
				}
				const index: number = position.get(cursor.id) ?? 0;
				cursor = index > 0 ? this.entries[index - 1] : undefined;
			}
			chain.reverse();
		}
		this.#linear = chain;
		return chain;
	}

	/** Messages in the linear view (header/compaction/custom filtered). */
	messages(): AgentMessage[] {
		return this.linearEntries()
			.filter(isMessageEntry)
			.map((e) => e.message);
	}

	// Long-form design notes: docs/dev/session-store.md
	/** Every compaction on the active path, oldest first. At most one, since each re-roots the chain. */
	compactions(): Extract<SessionEntry, { type: "compaction" }>[] {
		return this.linearEntries().filter(
			(e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction",
		);
	}

	// Long-form design notes: docs/dev/session-store.md
	/** How many summaries this session has paid for, counted in the file, not along the chain. */
	compactionCount(): number {
		let count = 0;
		for (const entry of this.entries) if (entry.type === "compaction") count++;
		return count;
	}

	// Long-form design notes: docs/dev/session-store.md
	/** What the model is sent on resume: the last compaction boundary, then everything after it. */
	contextMessages(): AgentMessage[] {
		const linear = this.linearEntries();
		let start = 0;
		for (let i = linear.length - 1; i >= 0; i--) {
			if (linear[i]?.type === "compaction") {
				start = i;
				break;
			}
		}
		const out: AgentMessage[] = [];
		for (let i = start; i < linear.length; i++) {
			const entry = linear[i];
			if (!entry) continue;
			if (entry.type === "message") out.push(entry.message);
			else if (entry.type === "compaction") out.push(entry.message);
		}
		return out;
	}

	// Long-form design notes: docs/dev/session-store.md
	/** Record a compaction: `boundary` replaces everything above `suffix`. Null when the trailing entries are not the kept messages. */
	appendCompaction(record: CompactionRecord): SessionEntry | null {
		const linear = this.linearEntries();
		const messageEntries = linear.filter(isMessageEntry);
		// `slice(-0)` is `slice(0)`, so an empty suffix needs its own path.
		const kept = record.suffix.length > 0 ? messageEntries.slice(-record.suffix.length) : [];
		if (
			kept.length !== record.suffix.length ||
			!kept.every((entry, i) => sameMessage(entry.message, record.suffix[i]))
		) {
			return null;
		}

		const entry: SessionEntry = {
			id: newEntryId(),
			// The chain's root: the header for a session this store started, or
			// whatever the loaded file's chain begins at.
			parentId: linear[0]?.id ?? "",
			type: "compaction",
			timestamp: Date.now(),
			message: record.boundary,
			summary: record.summary,
			preservedFiles: record.preservedFiles,
			preTokens: record.preTokens,
			postTokens: record.postTokens,
			model: record.model,
			trigger: record.trigger,
		};
		this.append(entry);
		for (const message of record.suffix) this.appendMessage(message);
		return entry;
	}

	/**
	 * Branch from an existing entry: the active leaf moves there, so the next
	 * append becomes a child of it. Entries on the abandoned branch stay in
	 * the file — history is never rewritten.
	 */
	branch(entryId: string): boolean {
		const target = this.entries.find((e) => e.id === entryId || e.id.startsWith(entryId));
		if (!target || target.type === "header") return false;
		this.#leafId = target.id;
		// The leaf moved, so the chain to it is a different one — and a branch that
		// wrote nothing is exactly the case the cached walk would get wrong.
		this.#linear = null;
		return true;
	}

	/** All branch points: entries with more than one child. */
	branchPoints(): SessionEntry[] {
		const childCounts = new Map<string, number>();
		for (const entry of this.entries) {
			if (!entry.parentId) continue;
			childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
		}
		return this.entries.filter((e) => (childCounts.get(e.id) ?? 0) > 1);
	}

	/** Compact tree description for /tree: one line per entry, active path marked. */
	describeTree(): string {
		const activeIds = new Set(this.linearEntries().map((e) => e.id));
		const lines: string[] = [];
		for (const entry of this.entries) {
			if (entry.type === "header") continue;
			const marker = activeIds.has(entry.id) ? "*" : " ";
			if (entry.type === "message") {
				const m = entry.message;
				let label = m.role;
				if (m.role === "user") {
					label += `: ${textPreview(typeof m.content === "string" ? m.content : "[blocks]")}`;
				} else if (m.role === "assistant") {
					const text = m.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join(" ");
					label += `: ${textPreview(text)}`;
				} else {
					label += `: ${m.toolName}`;
				}
				lines.push(`${marker} ${entry.id.slice(0, 8)} ${label}`);
			} else if (entry.type === "compaction") {
				lines.push(`${marker} ${entry.id.slice(0, 8)} [compaction]`);
			} else if (entry.type === "custom") {
				lines.push(`${marker} ${entry.id.slice(0, 8)} [${entry.kind}]`);
			}
		}
		return lines.join("\n") || "(empty session)";
	}

	#recomputeLeaf(): void {
		this.#leafId = this.entries[this.entries.length - 1]?.id ?? null;
		this.#linear = null;
	}
}

/** The first `maxBytes` bytes of a file, decoded as UTF-8. */
function readHead(path: string, maxBytes: number): string {
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const read = readSync(descriptor, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Whether a parsed line is an entry this build can hold: an id the chain can
 * point at, and a type it knows. `{"foo": 1}` parses and is not an entry; a
 * type written by a newer version is one this build cannot interpret, and
 * keeping it would put a node in the chain whose meaning is unknown.
 */
function isEntryShaped(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as { id?: unknown; type?: unknown };
	if (typeof entry.id !== "string" || entry.id.length === 0) return false;
	return entry.type === "header" || entry.type === "message" || entry.type === "compaction" || entry.type === "custom";
}

function textPreview(text: string, max = 60): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 3)}...` : single;
}
