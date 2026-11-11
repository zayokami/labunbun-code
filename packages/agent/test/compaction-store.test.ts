/**
 * What a compaction leaves on disk.
 *
 * The session file is the session: if the boundary it was compacted down to is
 * not in the chain, then resuming replays the transcript the summary replaced —
 * at full price, and only to summarize it again.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { compactionBoundary, microcompact } from "../src/compaction.ts";
import { SessionStore } from "../src/session-store.ts";

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-session-home-"));
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	provider: "faux",
	model: "faux-1",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	stopReason: "stop",
	timestamp: 1,
});

const toolResult = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "Bash",
	content: [{ type: "text", text: "z".repeat(5_000) }],
	isError: false,
	timestamp: 1,
});

function fill(store: SessionStore, messages: AgentMessage[]): void {
	for (const message of messages) store.appendMessage(message);
}

/** A session file in a throwaway project dir and home — never the real one. */
function newStore(): SessionStore {
	const dir = mkdtempSync(join(tmpdir(), "lbb-store-"));
	return SessionStore.startNew(dir, tmpHome());
}

const RECORD = (boundary: AgentMessage, suffix: AgentMessage[]) => ({
	boundary,
	suffix,
	summary: "1. Primary Request: the old work",
	preservedFiles: [],
	preTokens: 90_000,
	postTokens: 1_000,
	model: "faux-1",
	trigger: "auto" as const,
});

describe("appendCompaction", () => {
	test("the boundary replaces the prefix, and the kept tail stays reachable", () => {
		const store = newStore();
		const old = [user("old request"), assistant("old answer")];
		const tail = [user("current request"), assistant("current answer")];
		fill(store, [...old, ...tail]);

		const boundary = compactionBoundary("1. Primary Request: the old work");
		expect(store.appendCompaction(RECORD(boundary, tail))).not.toBeNull();

		// The model-facing view is the boundary and what came after it.
		expect(store.contextMessages()).toEqual([boundary, ...tail]);
		expect(store.contextMessages()).toHaveLength(3);

		// The transcript view is the active chain, which no longer runs through the
		// messages the summary stands in for — so the two views differ by exactly
		// the boundary, and nothing else.
		expect(store.messages()).toEqual(tail);
		expect(store.contextMessages()).toEqual([boundary, ...store.messages()]);

		// The replaced entries are still in the file: history is never rewritten.
		// Four from the abandoned transcript, plus the two kept messages written
		// again under the boundary — the same objects, so the views stay in sync.
		expect(store.entries.filter((e) => e.type === "message")).toHaveLength(6);
		// ...and the chain is the boundary plus the kept tail, rooted at the header.
		expect(store.linearEntries().map((e) => e.type)).toEqual(["header", "compaction", "message", "message"]);
		// So /tree shows the session it actually is rather than one plus its past:
		// the summarized lines are visible history, the three live ones are marked.
		const tree = store.describeTree().split("\n");
		expect(tree.filter((line) => line.startsWith("*"))).toHaveLength(3);
		expect(tree.filter((line) => line.includes("old request"))).toEqual([
			`  ${store.entries[1]?.id.slice(0, 8)} user: old request`,
		]);
	});

	test("survives a reload — the whole point", () => {
		const store = newStore();
		const tail = [user("current request")];
		fill(store, [user("old request"), assistant("old answer"), ...tail]);
		const boundary = compactionBoundary("1. Primary Request: the old work");
		store.appendCompaction(RECORD(boundary, tail));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.contextMessages()).toEqual([boundary, ...tail]);
		// And continuing the session appends below the boundary, not below the
		// transcript it replaced.
		reloaded.appendMessage(assistant("next answer"));
		expect(SessionStore.load(store.path).contextMessages()).toEqual([boundary, ...tail, assistant("next answer")]);
	});

	test("keeps nothing when the compaction replaced the whole conversation", () => {
		const store = newStore();
		fill(store, [user("old request"), assistant("old answer")]);
		const boundary = compactionBoundary("1. Primary Request: everything");
		expect(store.appendCompaction(RECORD(boundary, []))).not.toBeNull();
		expect(store.contextMessages()).toEqual([boundary]);
		expect(store.messages()).toEqual([]);
	});

	test("a tail the cheap rung rewrote is still the tail", () => {
		// Trim first, summarize next turn: the live list holds previews of the older
		// results while the file holds them whole. Identity is the wrong question to
		// ask of those, and asking it refused the record — so the file kept the
		// transcript the summary had just replaced, and resuming paid for the same
		// summary again. The preview is what the session is running on, so it is what
		// the file replays; the full text stays on the branch the compaction leaves.
		const store = newStore();
		const results = [1, 2, 3, 4].map((n) => toolResult(`c${n}`));
		fill(store, [user("old request"), assistant("old answer"), ...results]);
		const previewed = microcompact(results, 2);

		const boundary = compactionBoundary("1. Primary Request: the old work");
		expect(store.appendCompaction(RECORD(boundary, previewed))).not.toBeNull();
		expect(store.contextMessages()).toHaveLength(1 + previewed.length);
		expect(store.contextMessages()[1]).toBe(previewed[0]);
	});

	test("every pass re-roots the chain, so the count is not the chain's", () => {
		// `compactions()` walks the active path, and each boundary hangs off the
		// chain's root instead of off the transcript it replaced — so a session that
		// has compacted three times still shows one there, and a count built on it
		// could never reach two. What a warning about repeated compaction needs is
		// the file's own count, which also has to survive a reload: a resumed
		// session that has already been summarized four times must not need four
		// more to be worth warning about.
		const store = newStore();
		for (let round = 0; round < 3; round++) {
			const tail = [user(`request ${round}`)];
			fill(store, tail);
			expect(store.appendCompaction(RECORD(compactionBoundary("summary"), tail))).not.toBeNull();
		}

		expect(store.compactions()).toHaveLength(1);
		expect(store.compactionCount()).toBe(3);
		expect(SessionStore.load(store.path).compactionCount()).toBe(3);
	});

	test("an uncompacted session has one view, not two", () => {
		const store = newStore();
		const messages = [user("q"), assistant("a"), user("q2")];
		fill(store, messages);
		expect(store.contextMessages()).toEqual(store.messages());
		expect(store.contextMessages()).toEqual(messages);
	});

	test("branching back above the boundary puts the transcript in view again", () => {
		// /tree can still rewind into the summarized past — it is history, not
		// garbage. Once there, the session *is* that conversation again, and the
		// summary it walked away from no longer stands in front of it.
		const store = newStore();
		const old = [user("old request"), assistant("old answer")];
		const tail = [user("current request")];
		fill(store, [...old, ...tail]);
		const oldEntry = store.linearEntries()[1];
		if (!oldEntry) throw new Error("expected the old turn on the chain");
		store.appendCompaction(RECORD(compactionBoundary("summary"), tail));

		expect(store.branch(oldEntry.id)).toBe(true);
		store.appendMessage(assistant("rewound"));
		// Branching forks: the turn continues from the request it was pointed at,
		// not from where the conversation had got to.
		expect(store.contextMessages()).toEqual([old[0], assistant("rewound")]);
	});

	test("refuses a suffix that is not the trailing history", () => {
		// A live array that has diverged from the store must not be guessed at:
		// chaining a boundary above the wrong entry would silently drop real work.
		const store = newStore();
		fill(store, [user("real one"), assistant("real two")]);
		const boundary = compactionBoundary("summary");
		expect(store.appendCompaction(RECORD(boundary, [user("something else")]))).toBeNull();
		expect(store.appendCompaction(RECORD(boundary, [assistant("real two"), user("real one")]))).toBeNull();
		expect(store.contextMessages()).toEqual([user("real one"), assistant("real two")]);
	});
});

/** The entry lines of a session file, without the empty tail after the last newline. */
function fileLines(path: string): string[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function writeFileLines(path: string, lines: string[]): void {
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

/** The line index of the compaction boundary. */
function boundaryLine(lines: string[]): number {
	const index = lines.findIndex((line) => (JSON.parse(line) as { type?: string }).type === "compaction");
	if (index === -1) throw new Error("expected a compaction boundary");
	return index;
}

describe("a compaction torn mid-suffix", () => {
	const old = [user("old request"), assistant("old answer")];
	const tail = [user("current request"), toolResult("call-1")];

	test("a boundary whose suffix never landed resumes on the transcript it replaced", () => {
		// The boundary is written first and the suffix one message at a time. A kill
		// between them used to leave the boundary as the leaf, so resume replayed the
		// summary alone: the request being answered and the result it was waiting on
		// were gone.
		const store = newStore();
		fill(store, [...old, ...tail]);
		expect(store.appendCompaction(RECORD(compactionBoundary("summary"), tail))).not.toBeNull();

		const lines = fileLines(store.path);
		writeFileLines(store.path, lines.slice(0, boundaryLine(lines) + 1));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.recoveredCompactions).toBe(1);
		expect(reloaded.contextMessages()).toEqual([...old, ...tail]);
	});

	test("a boundary with one suffix message written is rolled back the same way", () => {
		const store = newStore();
		fill(store, [...old, ...tail]);
		store.appendCompaction(RECORD(compactionBoundary("summary"), tail));

		const lines = fileLines(store.path);
		writeFileLines(store.path, lines.slice(0, boundaryLine(lines) + 2));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.recoveredCompactions).toBe(1);
		expect(reloaded.contextMessages()).toEqual([...old, ...tail]);
	});

	test("a record without suffix metadata is a complete commit", () => {
		// Files written before the field existed carry no commit record. They are not
		// torn, and nothing may be rolled back on their behalf.
		const store = newStore();
		const kept = [user("current request")];
		fill(store, [user("old request"), assistant("old answer"), ...kept]);
		const boundary = compactionBoundary("summary");
		store.appendCompaction(RECORD(boundary, kept));
		expect(store.compactions()).toHaveLength(1);

		const lines = fileLines(store.path).map((line) => {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type !== "compaction") return line;
			delete entry.suffixIds;
			return JSON.stringify(entry);
		});
		writeFileLines(store.path, lines);

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.recoveredCompactions).toBe(0);
		expect(reloaded.contextMessages()).toEqual([boundary, ...kept]);
	});

	test("a suffix write that fails leaves the live transcript on the old leaf", () => {
		// The disk refuses the second suffix message. The file now ends in a partial
		// commit, but this process is still running on the transcript the summary
		// replaced — the two must not disagree about what is being sent.
		const store = newStore();
		fill(store, [...old, ...tail]);
		const oldLeaf = store.linearEntries().at(-1);
		if (!oldLeaf) throw new Error("expected a pre-compaction leaf");

		const realAppend = store.appendMessage.bind(store);
		let suffixWrites = 0;
		store.appendMessage = (message: AgentMessage, id?: string) => {
			suffixWrites++;
			if (suffixWrites === 2) throw new Error("ENOSPC: no space left on device");
			return realAppend(message, id);
		};

		expect(() => store.appendCompaction(RECORD(compactionBoundary("summary"), tail))).toThrow("ENOSPC");
		expect(store.contextMessages()).toEqual([...old, ...tail]);

		const appended = store.appendMessage(user("after the failure"));
		expect(appended.parentId).toBe(oldLeaf.id);
		expect(store.contextMessages()).toEqual([...old, ...tail, user("after the failure")]);
	});

	test("a branch inside the suffix is not read as a torn commit", () => {
		// Branching to a retained entry and continuing from it writes a chain that
		// is not a prefix of the recorded ids — deliberately different, not cut
		// short. Rolling the leaf back here would throw away the user's branch.
		const store = newStore();
		fill(store, [user("old request"), ...tail]);
		const boundary = compactionBoundary("summary");
		store.appendCompaction(RECORD(boundary, tail));
		const firstSuffix = store.entries.filter((entry) => entry.type === "message").at(-tail.length);
		if (firstSuffix?.type !== "message") throw new Error("expected the first suffix entry");

		expect(store.branch(firstSuffix.id)).toBe(true);
		store.appendMessage(user("a different direction"));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.recoveredCompactions).toBe(0);
		expect(reloaded.contextMessages()).toEqual([boundary, tail[0], user("a different direction")]);
	});
});
