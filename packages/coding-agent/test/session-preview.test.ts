/**
 * The `/resume` preview.
 *
 * It reads the end of a file the picker only ever read the head of, so what is
 * pinned here is that the tail is enough: the active chain is walked from the
 * last entry, the rows say what a reader would recognize, and every cap comes
 * with a notice — a preview that quietly shows the middle of a conversation as
 * if it were the whole of it is worse than no preview.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEntryId, SessionStore } from "@labunbun/agent";
import type { AgentMessage, AssistantContent } from "@labunbun/ai";
import {
	createPreviewRequester,
	PREVIEW_LINE_CHARS,
	PREVIEW_MAX_LINES,
	PREVIEW_MAX_MESSAGES,
	readSessionPreview,
} from "../src/session-preview.ts";
import { writeSessionTitle } from "../src/session-title.ts";

const ESC = String.fromCharCode(0x1b);

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(content: AssistantContent[] | string): AgentMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		provider: "faux",
		model: "faux-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, toolName: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	};
}

function tempSession() {
	const home = mkdtempSync(join(tmpdir(), "lbb-preview-"));
	const store = SessionStore.startNew(home, home);
	return { home, store, clean: () => rmSync(home, { recursive: true, force: true }) };
}

describe("readSessionPreview", () => {
	test("shows the conversation's last messages in order", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("hello"));
			h.store.appendMessage(assistant("hi there"));
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toEqual(["You: hello", "Assistant: hi there"]);
			expect(preview?.notice).toBeUndefined();
		} finally {
			h.clean();
		}
	});

	test("tool results are left out, and tool calls name the argument that matters", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("read the file"));
			h.store.appendMessage(
				assistant([
					{
						type: "toolCall",
						id: "c1",
						name: "Read",
						arguments: JSON.stringify({ file_path: "src/a.ts" }),
					},
				]),
			);
			h.store.appendMessage(toolResult("c1", "Read"));
			h.store.appendMessage(assistant("done"));
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toEqual(["You: read the file", "→ Read src/a.ts", "Assistant: done"]);
		} finally {
			h.clean();
		}
	});

	test("an unknown tool still gets its first string argument", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(
				assistant([{ type: "toolCall", id: "c1", name: "Mystery", arguments: JSON.stringify({ mode: "fast" }) }]),
			);
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toEqual(["→ Mystery fast"]);
		} finally {
			h.clean();
		}
	});

	test("a compaction entry is skipped, not shown as a user message", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("before"));
			const parent = h.store.entries.at(-1);
			if (!parent) throw new Error("the compaction needs an entry to follow");
			h.store.append({
				id: newEntryId(),
				parentId: parent.id,
				type: "compaction",
				timestamp: 0,
				message: user("summary stands in for everything above"),
				summary: "summary",
				preservedFiles: [],
				preTokens: 1,
				postTokens: 1,
				model: "faux-1",
				trigger: "manual",
			});
			h.store.appendMessage(assistant("after"));
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toEqual(["You: before", "Assistant: after"]);
		} finally {
			h.clean();
		}
	});

	test("more than six messages are cut with a notice", async () => {
		const h = tempSession();
		try {
			for (let i = 0; i < 8; i++) h.store.appendMessage(user(`message ${i}`));
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines[0]).toBe(`You: message ${8 - PREVIEW_MAX_MESSAGES}`);
			expect(preview?.lines).toHaveLength(PREVIEW_MAX_MESSAGES);
			expect(preview?.notice).toContain(`Showing the last ${PREVIEW_MAX_MESSAGES} messages.`);
		} finally {
			h.clean();
		}
	});

	test("more than twelve rows are cut with a notice of their own", async () => {
		const h = tempSession();
		try {
			for (let i = 0; i < PREVIEW_MAX_MESSAGES; i++) {
				h.store.appendMessage(
					assistant([
						{ type: "toolCall", id: `a${i}`, name: "Read", arguments: JSON.stringify({ file_path: `a${i}.ts` }) },
						{ type: "toolCall", id: `b${i}`, name: "Read", arguments: JSON.stringify({ file_path: `b${i}.ts` }) },
						{ type: "toolCall", id: `c${i}`, name: "Read", arguments: JSON.stringify({ file_path: `c${i}.ts` }) },
					]),
				);
			}
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toHaveLength(PREVIEW_MAX_LINES);
			expect(preview?.lines.at(-1)).toContain("c5.ts");
			expect(preview?.notice).toContain(`Showing the last ${PREVIEW_MAX_LINES} lines.`);
		} finally {
			h.clean();
		}
	});

	test("a long message is one capped line, with escape sequences gone", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user(`${ESC}[31mred${ESC}[0m\n${"x".repeat(500)}`));
			const preview = await readSessionPreview(h.store.path);
			const line = preview?.lines[0] ?? "";
			expect(line.startsWith("You: red ")).toBe(true);
			expect(Array.from(line)).toHaveLength(PREVIEW_LINE_CHARS);
			expect(line).not.toContain(ESC);
			expect(line).not.toContain("\n");
		} finally {
			h.clean();
		}
	});

	test("a tail read that begins mid-line says earlier messages were not loaded", async () => {
		const h = tempSession();
		try {
			// The one message is longer than the tail window, so the read starts in
			// the middle of its line and the line is dropped as a fragment.
			h.store.appendMessage(user("x".repeat(200 * 1024)));
			h.store.appendMessage(user("after the big one"));
			h.store.appendMessage(assistant("and the reply"));
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.lines).toEqual(["You: after the big one", "Assistant: and the reply"]);
			expect(preview?.notice).toContain("Earlier messages not loaded.");
		} finally {
			h.clean();
		}
	});

	test("a damaged line breaks the chain but does not lose the end of it", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("kept"));
			appendFileSync(h.store.path, "{ not an entry\n");
			h.store.appendMessage(assistant("after the damage"));
			const preview = await readSessionPreview(h.store.path);
			// The damaged line is not an entry, and it has no id to be a parent, so
			// the walk crosses it through the real parent links and keeps the
			// messages on either side.
			expect(preview?.lines).toEqual(["You: kept", "Assistant: after the damage"]);
		} finally {
			h.clean();
		}
	});

	test("the session's title travels with the preview", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("hello"));
			writeSessionTitle(h.store.path, "Release notes");
			const preview = await readSessionPreview(h.store.path);
			expect(preview?.title).toBe("Release notes");
		} finally {
			h.clean();
		}
	});

	test("a readable session with no messages has nothing to show, not null", async () => {
		const h = tempSession();
		try {
			const preview = await readSessionPreview(h.store.path);
			expect(preview).not.toBeNull();
			expect(preview?.lines).toEqual([]);
		} finally {
			h.clean();
		}
	});

	test("a file that is not there is null rather than an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-preview-"));
		try {
			expect(await readSessionPreview(join(dir, "missing.jsonl"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createPreviewRequester", () => {
	test("moves faster than the disk: the last row asked for is the one answered", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("first file"));
			const other = SessionStore.startNew(h.home, h.home);
			other.appendMessage(user("second file"));

			const requester = createPreviewRequester({ debounceMs: 10 });
			const first = requester.request(h.store.path);
			const second = requester.request(other.path);
			// The superseded row is answered now, with nothing, rather than left
			// waiting on a debounce that will never fire for it.
			expect(await first).toBeNull();
			expect((await second)?.lines).toEqual(["You: second file"]);
			requester.reset();
		} finally {
			h.clean();
		}
	});

	test("a row seen before is answered from the cache", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("original"));
			const requester = createPreviewRequester({ debounceMs: 1 });
			expect((await requester.request(h.store.path))?.lines).toEqual(["You: original"]);

			// Rewrite the tail; a cached answer must still be the old one.
			writeFileSync(h.store.path, h.store.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
			h.store.appendMessage(user("changed"));
			expect((await requester.request(h.store.path))?.lines).toEqual(["You: original"]);
			requester.reset();
		} finally {
			h.clean();
		}
	});

	test("reset clears the cache and answers anyone still waiting", async () => {
		const h = tempSession();
		try {
			h.store.appendMessage(user("before reset"));
			const requester = createPreviewRequester({ debounceMs: 50 });
			const waiting = requester.request(h.store.path);
			requester.reset();
			expect(await waiting).toBeNull();

			h.store.appendMessage(user("after reset"));
			expect((await requester.request(h.store.path))?.lines).toEqual(["You: before reset", "You: after reset"]);
			requester.reset();
		} finally {
			h.clean();
		}
	});
});
