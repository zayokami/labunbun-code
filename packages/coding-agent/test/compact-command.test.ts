/**
 * `/compact`, the command that is supposed to save a conversation that has run
 * out of room.
 *
 * It used to discard what the compaction returned: a full summarization call,
 * a success message, and a session that was exactly as long as before. What is
 * under test here is that the command actually adopts the result — in the live
 * session *and* in the session file, so the next `--continue` resumes from the
 * summary rather than from the transcript it replaced.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, CompactionManager, SessionStore } from "@labunbun/agent";
import {
	type AgentMessage,
	assistantMessage,
	type Context,
	FAUX_MODEL,
	fauxProvider,
	type StreamFn,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import { builtInCommands, type LocalCommand, type LocalCommandContext } from "../src/commands.ts";
import { type AppCommandContext, handleCommandDispatch } from "../src/interactive.ts";

const CONFIG = { contextWindow: 200_000, maxOutputTokens: 8_192 };

/** A conversation with enough history to summarize. */
function bigSession(): AgentSession {
	const session = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt: "you are a coding agent",
		deps: { streamFn: async function* () {} },
	});
	session.messages = [
		userMessage("the original request"),
		{
			role: "assistant",
			content: [{ type: "text", text: "working on it" }],
			provider: "faux",
			model: FAUX_MODEL.id,
			usage: { input: 90_000, output: 200, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 1,
		},
		userMessage("and now this"),
	];
	return session;
}

const compactCommand = (): LocalCommand => {
	const command = builtInCommands().find((c): c is LocalCommand => c.name === "compact" && c.type === "local");
	if (!command) throw new Error("no /compact command");
	return command;
};

function makeHarness(summaryText: string) {
	const infos: string[] = [];
	const prompted: string[] = [];
	const faux = fauxProvider([{ text: summaryText, usage: { input: 10, output: 10 } }]);
	const streamFn: StreamFn = async function* (model, context, options) {
		prompted.push(JSON.stringify(context.messages.at(-1)?.content));
		yield* faux.streamFn(model, context, options);
	};
	const dir = mkdtempSync(join(tmpdir(), "lbb-compact-cmd-"));
	const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-compact-home-")));
	const session = bigSession();
	// The live history is the store's history: /compact must leave both agreeing.
	for (const message of session.messages) store.appendMessage(message);

	const compaction = new CompactionManager(CONFIG, { streamFn, summarizerModel: FAUX_MODEL, store });
	const ctx = {
		session,
		compaction,
		cwd: dir,
		pushInfo: (info: string) => infos.push(info),
	} as LocalCommandContext;

	return { ctx, session, store, infos, prompted, command: compactCommand() };
}

describe("/compact", () => {
	test("adopts the summary in the session and in the session file", async () => {
		const h = makeHarness("<summary>\n1. Primary Request: the original request\n</summary>");

		const result = await h.command.call(h.ctx, "");

		// The live history is now [boundary, current turn] — not the transcript.
		expect(h.session.messages).toHaveLength(2);
		expect(h.session.messages[0]).toMatchObject({ role: "user" });
		expect((h.session.messages[0] as { content: string }).content).toContain("the original request");
		expect(JSON.stringify(h.session.messages[1])).toContain("and now this");

		// And so is the file, which is what `--continue` reads.
		const reloaded = SessionStore.load(h.store.path);
		expect(reloaded.contextMessages()).toEqual(h.session.messages);

		// The report is about what actually happened.
		expect(result).toMatch(/^Conversation compacted: ~[\d,]+ tokens freed \([\d,]+ → [\d,]+\)\.$/);
		expect(h.infos).toEqual(["Compacting conversation…"]);
	});

	test("passes focus instructions to the summarizer", async () => {
		const h = makeHarness("<summary>\n1. Primary Request: x\n</summary>");
		await h.command.call(h.ctx, "keep the migration details");
		expect(h.prompted.join("\n")).toContain("Focus especially on: keep the migration details");
	});

	test("records the compaction so the summary can be audited", async () => {
		const h = makeHarness("<summary>\n1. Primary Request: x\n</summary>");
		await h.command.call(h.ctx, "");
		const entry = h.store.entries.find((e) => e.type === "compaction");
		expect(entry?.type === "compaction" ? { trigger: entry.trigger, model: entry.model } : {}).toEqual({
			trigger: "manual",
			model: FAUX_MODEL.id,
		});
	});

	test("is the way out of a tripped breaker", async () => {
		// The breaker says autocompact has failed too often to keep trying. A manual
		// pass that works contradicts that — and if it did not clear the count, the
		// command the breaker's own message points at would be the one thing that
		// could not bring it back.
		let failing = true;
		const faux = fauxProvider([
			{ text: "<summary>\n1. Primary Request: x\n</summary>", usage: { input: 10, output: 10 } },
		]);
		const streamFn: StreamFn = async function* (model, context, options) {
			if (failing) throw new Error("provider is down");
			yield* faux.streamFn(model, context, options);
		};
		const dir = mkdtempSync(join(tmpdir(), "lbb-compact-cmd-"));
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-compact-home-")));
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "you are a coding agent",
			deps: { streamFn: async function* () {} },
		});
		session.messages = [
			userMessage("the original request"),
			{
				role: "assistant",
				content: [{ type: "text", text: "working on it" }],
				provider: "faux",
				model: FAUX_MODEL.id,
				usage: { input: 185_000, output: 200, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			},
			userMessage("and now this"),
		];
		const compaction = new CompactionManager(CONFIG, { streamFn, summarizerModel: FAUX_MODEL, store });
		const context = session.currentContext();

		for (let i = 0; i < 3; i++) expect(await compaction.check(context)).toBeNull();
		expect(compaction.isTripped).toBe(true);
		expect(await compaction.check(context)).toBeNull(); // and now it is off

		failing = false;
		await compactCommand().call({ session, compaction, cwd: dir, pushInfo: () => {} } as LocalCommandContext, "");

		expect(compaction.isTripped).toBe(false);
	});
});

describe("/trim", () => {
	const trimCommand = (): LocalCommand => {
		const command = builtInCommands().find((c): c is LocalCommand => c.name === "trim" && c.type === "local");
		if (!command) throw new Error("no /trim command");
		return command;
	};

	/** Plenty of old tool output, and a turn that is still using the newest of it. */
	function harness() {
		const dir = mkdtempSync(join(tmpdir(), "lbb-trim-cmd-"));
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-trim-home-")));
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "you are a coding agent",
			deps: { streamFn: async function* () {} },
		});
		const messages: AgentMessage[] = [userMessage("the original request")];
		for (let i = 0; i < 5; i++) {
			messages.push(assistantMessage({ content: [{ type: "toolCall", id: `c${i}`, name: "Bash", arguments: "{}" }] }));
			messages.push(toolResultMessage(`c${i}`, "Bash", [{ type: "text", text: "x".repeat(40_000) }]));
		}
		messages.push(userMessage("and now this"));
		session.messages = messages;
		for (const message of messages) store.appendMessage(message);

		const compaction = new CompactionManager(CONFIG, {
			streamFn: async function* () {},
			summarizerModel: FAUX_MODEL,
			store,
		});
		const ctx = { session, compaction, cwd: dir, pushInfo: () => {} } as LocalCommandContext;
		return { ctx, session, store, command: trimCommand() };
	}

	const resultText = (message: AgentMessage | undefined) =>
		message?.role === "toolResult" ? (message.content[0] as { text: string }).text : "";

	test("cuts the old results in the live session and reports what it freed", async () => {
		const h = harness();
		const before = h.session.messages;
		const report = await h.command.call(h.ctx, "");

		expect(report).toMatch(/^Replaced 2 old tool results with previews: ~[\d,]+ tokens freed \([\d,]+ → [\d,]+\)\./);
		// The session is what changed, and the two oldest results are now previews.
		expect(h.session.messages).not.toBe(before);
		expect(resultText(h.session.messages[2])).toContain("truncated by microcompact");
		expect(resultText(h.session.messages[2]).length).toBeLessThan(3_000);
		// The turn's working set is untouched — the newest three are whole, and so is
		// everything that is not a tool result.
		expect(resultText(h.session.messages.at(-2))).toHaveLength(40_000);
		expect(h.session.messages.at(-1)?.role).toBe("user");
	});

	test("leaves the record of what was actually said alone", async () => {
		// A trim is a smaller view of the conversation, not a rewrite of it. The
		// session file keeps the full results, `--continue` reloads them, and the
		// next trim cuts them again — which is what makes an in-memory-only trim
		// safe to do without a store entry to explain it.
		const h = harness();
		await h.command.call(h.ctx, "");
		const reloaded = SessionStore.load(h.store.path).contextMessages();
		expect(resultText(reloaded[2])).toHaveLength(40_000);
	});

	test("says there is nothing to do when nothing is large enough", async () => {
		const h = harness();
		const quiet = [userMessage("short"), userMessage("and now this")];
		h.session.messages = quiet;
		expect(await h.command.call(h.ctx, "")).toContain("Nothing to trim");
		// Nothing was replaced: a command that could not do anything says so rather
		// than reporting a saving of zero.
		expect(h.session.messages).toBe(quiet);
	});
});

describe("command dispatch", () => {
	test("a command that throws says so instead of failing silently", async () => {
		// Fire-and-forget is not the same as no error handling: without this the
		// rejection is unhandled and the user is left looking at a prompt that did
		// nothing. The report goes to the transcript, which is the store.
		const info: string[] = [];
		const ctx = {
			commands: [
				{
					name: "boom",
					description: "always fails",
					type: "local" as const,
					call: async () => {
						throw new Error("provider is down");
					},
				},
			],
			getSession: () => new AgentSession({ model: FAUX_MODEL, deps: { streamFn: async function* () {} } }),
			compaction: () => ({}) as CompactionManager,
			handle: {
				store: {
					set: (update: (state: { entries: Array<{ text?: string }> }) => { entries: Array<{ text?: string }> }) => {
						const next = update({ entries: [] });
						info.push(...next.entries.map((entry) => entry.text ?? ""));
					},
				},
			},
		} as unknown as AppCommandContext;

		expect(handleCommandDispatch("/boom", ctx)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(info.join("\n")).toContain("/boom failed: provider is down");
	});
});

test("the harness keeps the live messages and the store in step", async () => {
	// Guards the fixture above: if these could drift, the first test would be
	// asserting about a file the session never wrote.
	const h = makeHarness("<summary>\n1. Primary Request: x\n</summary>");
	expect(SessionStore.load(h.store.path).contextMessages()).toEqual(h.session.messages);
	const _context: Context | undefined = h.session.currentContext();
	expect(_context?.systemPrompt).toBe("you are a coding agent");
});
