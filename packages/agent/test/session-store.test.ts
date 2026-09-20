/**
 * Reading a session file that is not whole.
 *
 * The file is append-only and written as the conversation happens, so a line can
 * be lost to a full disk or a killed process — and it can be lost from the
 * *middle*, not only from the end. What the reader does with that line decides
 * whether the session is resumable at all: the two failures this file exists to
 * prevent are one damaged line costing every message written after it, and one
 * damaged line hiding every message written before it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { newEntryId, SessionStore } from "../src/session-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
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

/** A session in a throwaway project dir and home — never the real one. */
function newStore(messages: AgentMessage[] = []): SessionStore {
	const store = SessionStore.startNew(tmpDir("lbb-store-cwd-"), tmpDir("lbb-store-home-"));
	for (const message of messages) store.appendMessage(message);
	return store;
}

function texts(messages: AgentMessage[]): string[] {
	return messages.map((message) => {
		if (typeof message.content === "string") return message.content;
		return message.content
			.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? block.name : ""))
			.join("");
	});
}

/** Replace one line of a file with half an entry, the way a partial append would. */
function damageLine(path: string, lineNumber: number): void {
	const lines = readFileSync(path, "utf8").split("\n");
	lines[lineNumber - 1] = '{"id":"half-written","paren';
	writeFileSync(path, lines.join("\n"), "utf8");
}

function appendRaw(path: string, lines: string[]): void {
	writeFileSync(path, `${readFileSync(path, "utf8")}${lines.join("\n")}\n`, "utf8");
}

describe("a session file with a damaged line", () => {
	test("a line lost from the middle costs its own entry and nothing else", () => {
		const store = newStore([user("first"), assistant("first answer"), user("second"), assistant("second answer")]);
		damageLine(store.path, 4); // the line holding user("second")

		const loaded = SessionStore.load(store.path);

		expect(loaded.skippedLines).toBe(1);
		// The messages written after the damage are still here …
		expect(texts(loaded.messages())).toEqual(["first", "first answer", "second answer"]);
		// … and so are the ones written before it, which is what the walk's
		// fallback is for: the orphan's parent id names the damaged entry, so
		// following the link as written would end the chain at the orphan and
		// drop the header and both messages above it.
		expect(loaded.linearEntries()[0]?.type).toBe("header");
	});

	test("the next turn continues from the last entry the file still holds", () => {
		const store = newStore([user("first"), assistant("first answer"), user("second"), assistant("second answer")]);
		damageLine(store.path, 4);

		const loaded = SessionStore.load(store.path);
		loaded.appendMessage(user("third"));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.skippedLines).toBe(1);
		expect(texts(reloaded.messages())).toEqual(["first", "first answer", "second answer", "third"]);
		expect(reloaded.linearEntries()[0]?.type).toBe("header");
	});

	test("a line that is not an entry is skipped like a damaged one", () => {
		const store = newStore([user("kept"), assistant("kept answer")]);
		// JSON that parses is not the same as an entry: no id to point at, an id
		// with a type this build cannot interpret, or not an object at all.
		appendRaw(store.path, ["{}", '{"foo":1}', "[]", '{"id":"x","type":"from-a-newer-build","parentId":null}']);

		const loaded = SessionStore.load(store.path);

		expect(loaded.skippedLines).toBe(4);
		expect(texts(loaded.messages())).toEqual(["kept", "kept answer"]);
	});

	test("a file whose links were edited by hand still walks, and stops", () => {
		const path = join(tmpDir("lbb-store-hand-"), "hand-edited.jsonl");
		const at = (id: string, parentId: string, text: string) =>
			JSON.stringify({ id, parentId, type: "message", timestamp: 1, message: user(text) });
		// Two entries pointing at each other: the walk has to notice it has been
		// here before rather than follow the ring forever.
		writeFileSync(path, `${[at("a", "b", "A"), at("b", "a", "B")].join("\n")}\n`, "utf8");
		expect(texts(SessionStore.load(path).messages())).toEqual(["A", "B"]);

		// A link that names itself is the smallest ring there is.
		writeFileSync(path, `${at("self", "self", "alone")}\n`, "utf8");
		expect(texts(SessionStore.load(path).messages())).toEqual(["alone"]);

		// And a link to an entry the file never held is the end of the chain, not
		// a crash: there is no earlier entry to fall back to, so the entry itself
		// is what remains.
		writeFileSync(path, `${at("only", "ghost", "orphan")}\n`, "utf8");
		expect(texts(SessionStore.load(path).messages())).toEqual(["orphan"]);
	});
});

describe("reading only the head of a session file", () => {
	test("a read that stops at the cap says the file was longer", () => {
		const store = newStore([user("fix the parser"), assistant("y".repeat(400_000))]);

		const capped = SessionStore.load(store.path, { maxBytes: 64 * 1024 });

		expect(capped.truncated).toBe(true);
		expect(texts(capped.messages())).toEqual(["fix the parser"]);
		// The fragment the cap cut through is where the read stopped, not damage.
		expect(capped.skippedLines).toBe(0);
		// Reading without a cap is the whole file, and says so.
		const whole = SessionStore.load(store.path);
		expect(whole.truncated).toBe(false);
		expect(whole.skippedLines).toBe(0);
		expect(whole.messages()).toHaveLength(2);
	});

	test("a file that fits inside the cap is read whole and not called truncated", () => {
		const store = newStore([user("a"), assistant("b")]);
		const size = statSync(store.path).size;

		const exact = SessionStore.load(store.path, { maxBytes: size });
		expect(exact.truncated).toBe(false);
		expect(texts(exact.messages())).toEqual(["a", "b"]);
		expect(exact.skippedLines).toBe(0);

		const oneByteShort = SessionStore.load(store.path, { maxBytes: size - 1 });
		expect(oneByteShort.truncated).toBe(true);
	});

	test("a cap too small to hold even one line reads as an empty file", () => {
		const store = newStore([user("a")]);

		const capped = SessionStore.load(store.path, { maxBytes: 8 });

		expect(capped.truncated).toBe(true);
		expect(capped.entries).toEqual([]);
		expect(capped.skippedLines).toBe(0);
	});
});

describe("the chain the store hands back", () => {
	/**
	 * The walk is rebuilt when the tree changes and handed back as it stands when
	 * it has not. Identity is the assertion because it is the optimization: a
	 * store that rebuilds on every read still returns an equal array every time,
	 * so anything content-shaped would pass either way.
	 */
	test("an unchanged tree is walked once", () => {
		const store = newStore([user("first"), assistant("an answer")]);

		const first = store.linearEntries();

		expect(store.linearEntries()).toBe(first);
		expect(store.linearEntries()).toHaveLength(3);
	});

	test("an append is a new chain, and the array handed out before is untouched", () => {
		const store = newStore([user("first")]);
		const before = store.linearEntries();

		const appended = store.appendMessage(assistant("an answer"));
		const after = store.linearEntries();

		expect(after).not.toBe(before);
		expect(after.at(-1)).toBe(appended);
		// The first array was a snapshot of the session as it stood, not a view
		// that grew under the caller holding it.
		expect(before).toHaveLength(2);
		expect(after).toHaveLength(3);
	});

	test("a branch moves the chain even though it writes nothing", () => {
		const store = newStore([user("first"), assistant("answer A"), user("second")]);
		const full = store.linearEntries();
		const answerId = full[2]?.id;
		if (!answerId) throw new Error("expected the chain to hold the assistant answer");
		// Walked already, so the branch below has a cached chain to invalidate —
		// which is the only way this case can come out wrong.
		expect(store.linearEntries()).toBe(full);

		expect(store.branch(answerId)).toBe(true);
		const branched = store.linearEntries();

		expect(branched).not.toBe(full);
		expect(branched).toHaveLength(3);
		expect(branched.at(-1)?.id).toBe(answerId);
		expect(texts(store.messages())).toEqual(["first", "answer A"]);
	});

	/** A session of `count` messages, written in one go — 20,000 appends would be
	 * 20,000 file writes, and these tests are about reading what is there. */
	function longSession(count: number): SessionStore {
		const path = join(tmpDir("lbb-store-long-"), "long.jsonl");
		const lines = [
			JSON.stringify({
				id: "h",
				parentId: null,
				type: "header",
				version: 1,
				sessionId: "long",
				cwd: "G:/long",
				createdAt: 0,
			}),
		];
		for (let i = 0; i < count; i++) {
			lines.push(
				JSON.stringify({
					id: `m${i}`,
					parentId: i === 0 ? "h" : `m${i - 1}`,
					type: "message",
					timestamp: i,
					message: user(`message ${i}`),
				}),
			);
		}
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return SessionStore.load(path);
	}

	/** Best of three, so a scheduling hiccup on one round does not decide it. */
	function fastest(rounds: number, fn: () => void): number {
		fn();
		let best = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 3; round++) {
			const start = performance.now();
			for (let i = 0; i < rounds; i++) fn();
			best = Math.min(best, performance.now() - start);
		}
		return best;
	}

	test("a hundred reads cost less than one walk", () => {
		// What the cache is for. `readTaskSnapshot` walks the chain on every task
		// change, and the session it walks is whatever the person has been doing
		// for hours — so the reads have to be free, not merely fast.
		const store = longSession(20_000);
		const leaf = store.linearEntries().at(-1)?.id ?? "";
		const walk = () => {
			store.branch(leaf);
			store.linearEntries();
		};
		const oneWalk = fastest(1, walk);
		const hundredReads = fastest(1, () => {
			for (let i = 0; i < 100; i++) store.linearEntries();
		});

		expect(hundredReads).toBeLessThan(oneWalk / 10);
	});

	test("the walk costs its length, not its square", () => {
		// The walk is what `readTaskSnapshot` pays on every task change, so its
		// shape is what decides whether a long session gets slower as it grows. It
		// did: the chain was built a step at a time with `unshift` — which moves the
		// whole chain on every step — and answered from a map of every entry built
		// the same way. Four times the entries measured fourteen times the time.
		const walkCost = (count: number): number => {
			const store = longSession(count);
			const leaf = store.linearEntries().at(-1)?.id ?? "";
			const walk = () => {
				store.branch(leaf);
				store.linearEntries();
			};
			// `branch` is a scan of the entries in its own right, linear, and it is
			// part of the walk measurement — taking it out leaves the walk.
			return fastest(20, walk) - fastest(20, () => void store.branch(leaf));
		};

		const small = walkCost(5_000);
		const large = walkCost(20_000);

		// Four times the entries is four times the work; four times the *steps* of
		// the walk would be sixteen. The bound sits between, with room for a noisy
		// machine: it is 5 on the code below and was 14 on the code above.
		expect(large / small).toBeLessThan(8);
	});
});

describe("a session file that is not there", () => {
	test("loading a path that does not exist is an empty store, not an error", () => {
		const path = join(tmpDir("lbb-store-missing-"), "nope.jsonl");
		const store = SessionStore.load(path);
		expect(store.sessionId).toBeNull();
		expect(store.messages()).toEqual([]);
		expect(store.truncated).toBe(false);
		expect(store.skippedLines).toBe(0);
	});

	test("entry ids are unique enough to keep a chain straight", () => {
		const ids = new Set(Array.from({ length: 2000 }, () => newEntryId()));
		expect(ids.size).toBe(2000);
	});
});
