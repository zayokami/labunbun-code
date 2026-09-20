/**
 * What a compaction leaves on disk.
 *
 * The session file is the session: if the boundary it was compacted down to is
 * not in the chain, then resuming replays the transcript the summary replaced —
 * at full price, and only to summarize it again.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { compactionBoundary } from "../src/compaction.ts";
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
