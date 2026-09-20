import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Context, Model, StreamFn } from "@labunbun/ai";
import { assistantMessage, FAUX_MODEL, fauxProvider, textContent, toolResultMessage, userMessage } from "@labunbun/ai";
import {
	CompactionManager,
	compactionThreshold,
	contextBreakdown,
	dropOldestRound,
	estimateContextTokens,
	estimateContextUsage,
	extractRecentFiles,
	hardContextLimit,
	microcompact,
	SUMMARY_PROMPT,
	stripAnalysis,
} from "../src/compaction.ts";
import { SessionStore } from "../src/session-store.ts";

const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

/** Stands in for the session's model — a real registry entry with a credential. */
const SUMMARIZER: Model = { ...FAUX_MODEL, id: "summarizer-1", apiKeyEnv: "FAUX_API_KEY" };

describe("thresholds", () => {
	test("threshold formula: window − min(maxOut, 20k) − 13k", () => {
		expect(compactionThreshold(CONFIG)).toBe(100_000 - 20_000 - 13_000);
		expect(compactionThreshold({ contextWindow: 100_000, maxOutputTokens: 8_000 })).toBe(100_000 - 8_000 - 13_000);
		expect(hardContextLimit(CONFIG)).toBe(100_000 - 3_000);
	});

	test("a window smaller than the reserves compacts proportionally, not always", () => {
		// The reserves (output + 13k) exceed a small window, and the formula then
		// computes a negative number: a threshold every request is already past, so
		// compaction runs on the first turn and after every turn, at a full
		// summarization call each time.
		const small = { contextWindow: 16_000, maxOutputTokens: 8_192 };
		expect(compactionThreshold(small)).toBe(9_600); // 60% of the window
		expect(compactionThreshold(small)).toBeGreaterThan(0);
		// Small enough that even 60% is past the hard limit: compact just before the
		// limit rather than at it.
		const tiny = { contextWindow: 6_000, maxOutputTokens: 1_000 };
		expect(compactionThreshold(tiny)).toBeLessThan(hardContextLimit(tiny));
		expect(compactionThreshold({ contextWindow: 200_000, maxOutputTokens: 8_192 })).toBe(200_000 - 8_192 - 13_000);
		// Below the hard-limit reserve itself there is no threshold to give, but it
		// is never negative — every request is past the limit anyway.
		expect(compactionThreshold({ contextWindow: 3_000, maxOutputTokens: 1_000 })).toBe(0);
	});

	test("a threshold above the hard limit is impossible, whatever the reserves", () => {
		// A tiny output cap makes the reserves small enough that the raw formula
		// lands past the hard limit — where the only request the compactor is
		// consulted about is one that can no longer be sent.
		const config = { contextWindow: 20_000, maxOutputTokens: 100, reserveTokens: 100 };
		expect(compactionThreshold(config)).toBeLessThan(hardContextLimit(config));
	});
});

describe("estimateContextTokens", () => {
	test("anchors on last assistant usage plus char estimate for the tail", () => {
		const messages: AgentMessage[] = [
			userMessage("hello"),
			assistantMessage({ usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("x".repeat(400)), // ~100 tokens
		];
		const estimate = estimateContextTokens(messages);
		expect(estimate).toBeGreaterThanOrEqual(1_100);
		expect(estimate).toBeLessThan(1_300);
	});

	test("falls back to pure char estimate without usage anchors", () => {
		const messages: AgentMessage[] = [userMessage("y".repeat(800))];
		expect(estimateContextTokens(messages)).toBe(200);
	});

	test("counts the cached prefix, so a cache-heavy session is not read as empty", () => {
		// `input` is the uncached remainder. A long warm-cache session reports a
		// few hundred there and, anchored on that alone, looks like it has just
		// started — the threshold never trips and nothing ever compacts it.
		const cached = assistantMessage({
			usage: { input: 300, output: 200, cacheRead: 80_000, cacheWrite: 0, promptTotal: 80_300 },
		});
		expect(estimateContextTokens([userMessage("x"), cached])).toBe(80_500);
	});

	test("old messages without promptTotal estimate from every channel", () => {
		// Sessions recorded before adapters reported `promptTotal` still load. On
		// the Anthropic reading the sum is exact; on the old OpenAI reading it
		// over-counts, which only compacts sooner.
		const legacy = assistantMessage({ usage: { input: 300, output: 200, cacheRead: 80_000, cacheWrite: 0 } });
		expect(estimateContextTokens([legacy])).toBe(80_500);
	});
});

describe("estimateContextUsage", () => {
	const TOOLS: Context["tools"] = [
		{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: {} } } },
	];

	test("adds what the request carries outside the transcript", () => {
		// The system prompt and the tool schemas are re-sent on every call, so a
		// session can be over its window while `messages` still looks small.
		const messages: AgentMessage[] = [userMessage("short")];
		const transcriptOnly = estimateContextUsage({ systemPrompt: "", messages });
		expect(transcriptOnly).toBe(estimateContextTokens(messages));
		expect(estimateContextUsage({ systemPrompt: "s".repeat(40_000), messages })).toBe(transcriptOnly + 10_000);
		expect(estimateContextUsage({ systemPrompt: "", messages, tools: TOOLS })).toBeGreaterThan(transcriptOnly);
	});
});

describe("contextBreakdown", () => {
	const TOOLS: Context["tools"] = [
		{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: {} } } },
	];
	const RESULTS = 3;
	const RESULT_CHARS = 40_000;

	/** A conversation whose bulk is tool output, which is the case the card is for. */
	function conversation(toolResults = RESULTS): AgentMessage[] {
		const messages: AgentMessage[] = [userMessage("read the thing")];
		for (let i = 0; i < toolResults; i++) {
			messages.push(assistantMessage({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
			messages.push(toolResultMessage(`call_${i}`, "Bash", [textContent("x".repeat(RESULT_CHARS))]));
		}
		return messages;
	}

	test("the parts add up to the number the threshold is compared against", () => {
		// The card is read next to a bar drawn from `usedTokens`; a row that does
		// not belong to that total is a row the reader has to reconcile by hand.
		const context: Context = { systemPrompt: "s".repeat(20_000), messages: conversation(), tools: TOOLS };
		const breakdown = contextBreakdown(context);
		expect(breakdown.usedTokens).toBe(estimateContextUsage(context));
		expect(breakdown.systemPromptTokens + breakdown.toolSchemaTokens + breakdown.messageTokens).toBe(
			breakdown.usedTokens,
		);
		expect(breakdown.messageTokens).toBe(estimateContextTokens(context.messages));
		expect(breakdown.systemPromptTokens).toBe(5_000);
	});

	test("names the tool results, which are the part a session can give back", () => {
		const context: Context = { systemPrompt: "", messages: conversation(), tools: TOOLS };
		const breakdown = contextBreakdown(context);
		expect(breakdown.toolResultCount).toBe(RESULTS);
		expect(breakdown.toolResultTokens).toBe((RESULTS * RESULT_CHARS) / 4);
		// A share of the transcript, not a slice of a differently-derived total:
		// it is the same characters, estimated the same way.
		expect(breakdown.toolResultTokens).toBeLessThan(breakdown.messageTokens);
	});

	test("a conversation with no tools reports no schema row", () => {
		const breakdown = contextBreakdown({ systemPrompt: "system", messages: conversation(0) });
		expect(breakdown.toolSchemaTokens).toBe(0);
		expect(breakdown.toolResultCount).toBe(0);
		expect(breakdown.toolResultTokens).toBe(0);
	});
});

describe("CompactionManager limits", () => {
	test("reports the numbers it acts on, not a recomputation of them", () => {
		const config = { contextWindow: 40_000, maxOutputTokens: 4_000 };
		const manager = new CompactionManager(config, {
			streamFn: fauxProvider([{ text: "unused" }]).streamFn,
			summarizerModel: SUMMARIZER,
		});
		expect(manager.limits()).toEqual({
			contextWindow: 40_000,
			threshold: compactionThreshold(config),
			hardLimit: hardContextLimit(config),
		});
	});
});

describe("extractRecentFiles", () => {
	test("collects file paths from tool calls, newest first", () => {
		const messages: AgentMessage[] = [
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Read", arguments: JSON.stringify({ file_path: "/old.ts" }) }],
			}),
			assistantMessage({
				content: [
					{ type: "toolCall", id: "2", name: "Edit", arguments: JSON.stringify({ file_path: "/new.ts" }) },
					{ type: "toolCall", id: "3", name: "Write", arguments: JSON.stringify({ file_path: "/newer.ts" }) },
				],
			}),
		];
		expect(extractRecentFiles(messages)).toEqual(["/new.ts", "/newer.ts", "/old.ts"]);
	});
});

describe("microcompact", () => {
	test("truncates oldest tool results, keeps last N intact", () => {
		const big = (id: string) => toolResultMessage(id, "Bash", [{ type: "text", text: "z".repeat(5_000) }]);
		const messages: AgentMessage[] = [big("t1"), big("t2"), big("t3"), big("t4"), userMessage("next")];
		const compacted = microcompact(messages, 2);
		const t1 = compacted.find((m) => m.role === "toolResult" && m.toolCallId === "t1") as any;
		const t3 = compacted.find((m) => m.role === "toolResult" && m.toolCallId === "t3") as any;
		expect(t1.content[0].text).toContain("truncated by microcompact");
		expect(t1.content[0].text.length).toBeLessThan(3_000);
		expect(t3.content[0].text.length).toBe(5_000); // within keep-last-N
	});

	test("a preview is at most the budget, and cutting one again changes nothing", () => {
		// The marker counts against the budget rather than being appended past it,
		// so the number a caller budgets against is a bound on the preview itself.
		// The second pass is what would notice if that stopped being true: a marker
		// outside the budget is text the next cut can reach into.
		const big = (id: string) => toolResultMessage(id, "Bash", [{ type: "text", text: "z".repeat(5_000) }]);
		const messages: AgentMessage[] = [big("t1"), big("t2"), big("t3"), big("t4")];
		const textOf = (msgs: AgentMessage[], id: string) =>
			(msgs.find((m) => m.role === "toolResult" && m.toolCallId === id) as any).content[0].text as string;

		const once = microcompact(messages, 2);
		const twice = microcompact(once, 2);

		expect(textOf(once, "t1")).toContain("truncated by microcompact");
		expect(textOf(once, "t1").length).toBeLessThanOrEqual(2_000);
		expect(textOf(twice, "t1")).toBe(textOf(once, "t1"));
		expect(textOf(twice, "t3")).toBe(textOf(once, "t3"));
	});
});

describe("dropOldestRound", () => {
	test("cuts on a user-turn boundary, keeping the list well-formed", () => {
		// A tool result without the call that asked for it is not a conversation,
		// and a request that does not start with a user turn is not a valid one.
		const messages: AgentMessage[] = [
			userMessage("first"),
			assistantMessage({ content: [{ type: "toolCall", id: "c1", name: "Bash", arguments: "{}" }] }),
			toolResultMessage("c1", "Bash", [{ type: "text", text: "out" }]),
			userMessage("second"),
			assistantMessage({ content: [{ type: "text", text: "answer" }] }),
		];
		const dropped = dropOldestRound(messages);
		expect(dropped?.[0]).toBe(messages[3]);
		expect(dropped).toHaveLength(2);
	});

	test("returns null when only one round is left", () => {
		// Nothing older to give up: the caller must stop rather than send the same
		// request again, or spin.
		expect(dropOldestRound([userMessage("only"), assistantMessage({})])).toBeNull();
		expect(dropOldestRound([])).toBeNull();
		expect(dropOldestRound([assistantMessage({})])).toBeNull();
	});
});

describe("CompactionManager", () => {
	function makeManager(summaryText: string, deps?: Partial<ConstructorParameters<typeof CompactionManager>[1]>) {
		const faux = fauxProvider([{ text: summaryText, usage: { input: 10, output: 10 } }]);
		return new CompactionManager(CONFIG, {
			streamFn: faux.streamFn,
			summarizerModel: SUMMARIZER,
			readFile: (path) => (path === "/active.ts" ? "const active = true;" : null),
			...deps,
		});
	}

	test("maybeCompact skips below threshold", async () => {
		const manager = makeManager("summary");
		const context = { systemPrompt: "", messages: [userMessage("short")] };
		expect(await manager.maybeCompact(context)).toBeNull();
	});

	test("compacts when the system prompt alone crosses the threshold", async () => {
		const manager = makeManager("<summary>1. Request: x</summary>");
		const context = { systemPrompt: "s".repeat(300_000), messages: [userMessage("short")] };
		expect(await manager.maybeCompact(context)).not.toBeNull();
	});

	test("compacts at threshold with summary + re-injected files", async () => {
		const summary =
			"<analysis>thinking</analysis>\n<summary>\n1. Primary Request: build thing\n9. Next Step: run tests\n</summary>";
		const manager = makeManager(summary);
		const messages: AgentMessage[] = [
			userMessage("the earlier request"),
			assistantMessage({
				content: [{ type: "toolCall", id: "0", name: "Edit", arguments: JSON.stringify({ file_path: "/active.ts" }) }],
				usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			}),
			userMessage("work on /active.ts"),
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Bash", arguments: JSON.stringify({ command: "ls" }) }],
			}),
		];
		const result = await manager.maybeCompact({ systemPrompt: "sys", messages });
		expect(result).not.toBeNull();
		if (!result) throw new Error("expected compaction result");
		// The boundary stands in for everything up to the current turn, and the
		// current turn survives verbatim — the request being answered right now is
		// not something to hand back as a paraphrase.
		expect(result.messages).toHaveLength(3);
		expect(result.messages[1]).toBe(messages[2]);
		expect(result.messages[2]).toBe(messages[3]);
		const boundary = result.messages[0];
		if (boundary.role !== "user") throw new Error("expected user boundary message");
		const text = typeof boundary.content === "string" ? boundary.content : "";
		expect(text).toContain("[Conversation compacted");
		expect(text).toContain("Next Step: run tests"); // analysis stripped
		expect(text).not.toContain("<analysis>");
		expect(text).toContain("/active.ts"); // re-injected file
		expect(text).toContain("const active = true;");
	});

	test("a low-yield compaction is not repeated for a context that has barely moved", async () => {
		// Each pass costs a full summarization call. When the last one left the
		// context still over the threshold — the summary was long, or the turn it had
		// to keep was — running it again on nearly the same transcript buys nearly
		// the same nothing.
		let summaries = 0;
		const counting: StreamFn = async function* (model, context, options) {
			summaries++;
			// A long summary: 70k tokens, still over the 67k threshold, still under
			// the 97k hard limit.
			const faux = fauxProvider([{ text: "x".repeat(280_000) }]);
			yield* faux.streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: counting, summarizerModel: SUMMARIZER });
		const messages: AgentMessage[] = [
			userMessage("a"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];

		const compacted = await manager.maybeCompact({ systemPrompt: "", messages });
		expect(compacted).not.toBeNull();
		expect(summaries).toBe(1);
		if (!compacted) throw new Error("expected a compaction result");
		// The session adopts this, so it is what the next check is consulted about.
		expect(estimateContextUsage(compacted)).toBeGreaterThan(compactionThreshold(CONFIG));

		expect(await manager.maybeCompact(compacted)).toBeNull();
		expect(summaries).toBe(1);
		// Growth is what makes it worth trying again — a turn the summary has not
		// already accounted for.
		const grown = { ...compacted, messages: [...compacted.messages, userMessage("y".repeat(40_000))] };
		expect(await manager.maybeCompact(grown)).not.toBeNull();
		expect(summaries).toBe(2);
	});

	test("a successful manual compaction clears the breaker", async () => {
		// The breaker's stated unblocking condition is the context dropping back
		// under the threshold, which needs a compaction to happen — so if a
		// successful /compact did not clear it, nothing ever would.
		let calls = 0;
		const flickering: StreamFn = async function* (model, context, options) {
			calls++;
			if (calls <= 3) throw new Error("provider down");
			const ok = fauxProvider([{ text: "<summary>1. Request: x</summary>" }]);
			yield* ok.streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: flickering, summarizerModel: SUMMARIZER });
		const context = { systemPrompt: "", messages: [userMessage("short")] };
		for (let i = 0; i < 3; i++) await expect(manager.compact(context)).rejects.toThrow();
		expect(manager.isTripped).toBe(true);

		await manager.compact(context, { trigger: "manual" });
		expect(manager.isTripped).toBe(false);
	});

	test("a turn too large to carry verbatim is compacted away with the rest", async () => {
		// Keeping it would leave the summary replacing almost nothing: a whole
		// summarization call to free a few tokens.
		const manager = makeManager("<summary>1. Request: x</summary>");
		const messages: AgentMessage[] = [
			userMessage("old request"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("current request"),
			assistantMessage({
				content: [{ type: "text", text: "x".repeat(200_000) }], // ~50k tokens
			}),
		];
		const result = await manager.maybeCompact({ systemPrompt: "sys", messages });
		expect(result?.messages).toHaveLength(1);
	});

	test("force compacts below the threshold — the estimate does not get a vote after a refusal", async () => {
		// The provider already refused this request for size, so the estimate is
		// known to be wrong about this session. Consulting it again is how a
		// session stays bricked: every later turn fails identically.
		const manager = makeManager("<summary>1. Request: x</summary>");
		const context = { systemPrompt: "", messages: [userMessage("short")] };

		expect(await manager.maybeCompact(context)).toBeNull();
		expect(await manager.maybeCompact(context, { force: true })).not.toBeNull();
	});

	test("force is not stopped by the circuit breaker either", async () => {
		// The breaker is a guess about future attempts, not a fact about this one.
		// With it in the way, a refused session could only ever end: the breaker
		// would refuse the recovery, and its own unblocking condition ("the
		// context drops back under the threshold") needs a compaction to happen.
		let calls = 0;
		const flickering: StreamFn = async function* (model, context, options) {
			calls++;
			if (calls <= 3) throw new Error("provider down");
			const ok = fauxProvider([{ text: "<summary>1. Request: x</summary>" }]);
			yield* ok.streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: flickering, summarizerModel: SUMMARIZER });
		const context = { systemPrompt: "s".repeat(300_000), messages: [userMessage("short")] };

		for (let i = 0; i < 3; i++) await expect(manager.compact(context)).rejects.toThrow("provider down");
		expect(manager.isTripped).toBe(true);
		expect(await manager.maybeCompact(context)).toBeNull(); // over the threshold, refused by the breaker
		expect(await manager.maybeCompact(context, { force: true })).not.toBeNull();
	});

	test("a forced check that cannot free space blocks the request instead of sending it", async () => {
		// Nothing will be sent: with the refusal already on record, sending the
		// same oversized context again is the failure, not the attempt to recover.
		const failing = fauxProvider([{ throwError: new Error("provider down") }]);
		const manager = new CompactionManager(CONFIG, { streamFn: failing.streamFn, summarizerModel: SUMMARIZER });
		const decision = await manager.check({ systemPrompt: "", messages: [userMessage("x")] }, { force: true });
		expect(decision?.action).toBe("blocked");
		if (decision?.action !== "blocked") throw new Error("expected a blocked decision");
		expect(decision.message).toContain("/compact");
	});

	test("an unforced check below the hard limit still sends, as it always did", async () => {
		// Regression guard on the other side: force must be what blocks, not the
		// mere existence of a failing compactor.
		const failing = fauxProvider([{ throwError: new Error("provider down") }]);
		const manager = new CompactionManager(CONFIG, { streamFn: failing.streamFn, summarizerModel: SUMMARIZER });
		expect(await manager.check({ systemPrompt: "", messages: [userMessage("x")] })).toBeNull();
	});

	test("circuit breaker trips after 3 consecutive failures", async () => {
		const failing = fauxProvider([{ throwError: new Error("provider down") }]);
		const manager = new CompactionManager(CONFIG, { streamFn: failing.streamFn, summarizerModel: SUMMARIZER });
		const context = { systemPrompt: "", messages: [userMessage("x")] };

		for (let i = 0; i < 3; i++) {
			await expect(manager.compact(context)).rejects.toThrow("provider down");
		}
		expect(manager.isTripped).toBe(true);
		await expect(manager.compact(context)).rejects.toThrow();
	});

	test("summarizes with the session's own model, and says who answered", async () => {
		// The summary request is sent over the network like any other, and its
		// credential and endpoint are resolved from the model. The manager used to
		// synthesize one — empty apiKeyEnv, empty baseUrl — which is a request that
		// can never be sent, so compaction failed 3× and went permanently silent.
		const faux = fauxProvider([{ text: "<summary>\n1. Request: x\n</summary>", usage: { input: 10, output: 10 } }]);
		const seen: string[] = [];
		const streamFn: StreamFn = async function* (model, context, options) {
			seen.push(`${model.id} ${model.apiKeyEnv} ${model.baseUrl}`);
			yield* faux.streamFn(model, context, options);
		};

		const dir = mkdtempSync(join(tmpdir(), "lbb-compact-"));
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-compact-home-")));
		const summarizer: Model = {
			...FAUX_MODEL,
			id: "deepseek-chat",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			apiKeyEnv: "DEEPSEEK_API_KEY",
		};
		const manager = new CompactionManager(CONFIG, { streamFn, summarizerModel: summarizer, store });

		const messages: AgentMessage[] = [
			userMessage("work"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];
		await manager.maybeCompact({ systemPrompt: "sys", messages });

		expect(seen).toEqual(["deepseek-chat DEEPSEEK_API_KEY https://api.deepseek.com/v1"]);
		// And the record names the writer: a summary no one can attribute is a
		// summary no one can audit.
		const marker = store.entries.find((e) => e.type === "compaction");
		expect(marker?.type === "compaction" ? marker.model : undefined).toBe("deepseek-chat");
	});

	test("the summary request itself shrinks instead of failing when it is too large", async () => {
		// The summary request is the conversation it is summarizing: the one call
		// that is too big by construction, and the only way out of that state. It
		// may not fail for the reason it exists to fix. Two protections, in order:
		// the old tool results are previews before the first send, and a refusal
		// after that drops the oldest whole round.
		const sent: AgentMessage[][] = [];
		let calls = 0;
		const overflowingThenOk: StreamFn = async function* (model, context, options) {
			sent.push([...context.messages]);
			calls++;
			if (calls === 1) {
				// First attempt: the provider refuses it for size.
				yield* fauxProvider([
					{ stopReason: "error", errorMessage: "prompt is too long", errorKind: "context_overflow" },
				]).streamFn(model, context, options);
				return;
			}
			yield* fauxProvider([{ text: "<summary>1. Request: x</summary>" }]).streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: overflowingThenOk, summarizerModel: SUMMARIZER });
		const big = (id: string) => toolResultMessage(id, "Bash", [{ type: "text", text: "z".repeat(50_000) }]);
		const messages: AgentMessage[] = [
			userMessage("oldest request"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("second request"),
			big("t1"),
			big("t2"),
			big("t3"),
			big("t4"),
			userMessage("current request"),
		];

		const result = await manager.compact({ systemPrompt: "sys", messages }, { trigger: "manual" });
		expect(calls).toBe(2);
		expect(result.messages[0].role).toBe("user");

		// The first attempt already carried previews instead of the old tool output.
		const first = JSON.stringify(sent[0]);
		expect(first).toContain("truncated by microcompact");
		expect(first).toContain("oldest request");
		// The retry carried less still: the oldest round is gone, and what is left
		// is still a conversation — it starts on a user turn.
		const second = JSON.stringify(sent[1] as AgentMessage[]);
		expect(second.length).toBeLessThan(first.length);
		expect(second).not.toContain("oldest request");
		expect((sent[1] as AgentMessage[])[0]?.role).toBe("user");
		expect(second).toContain("second request");
	});

	test("a summary request that stays too large drops rounds, then gives up out loud", async () => {
		// Losing the oldest rounds costs information, so it is bounded, and the
		// bound is reported: a summary of a conversation the model could not read
		// would be worse than saying so.
		const sent: number[] = [];
		const always: StreamFn = async function* (model, context, options) {
			sent.push(context.messages.length);
			yield* fauxProvider([
				{ stopReason: "error", errorMessage: "prompt is too long", errorKind: "context_overflow" },
			]).streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: always, summarizerModel: SUMMARIZER });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(userMessage(`request ${i}`));
			messages.push(assistantMessage({ content: [{ type: "text", text: `answer ${i}` }] }));
		}

		await expect(manager.compact({ systemPrompt: "", messages })).rejects.toThrow(/too large to summarize/);
		// One initial attempt plus the bounded retries, each carrying strictly less.
		expect(sent).toHaveLength(4);
		for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeLessThan(sent[i - 1] as number);
	});

	test("stripAnalysis handles summaries without tags", () => {
		expect(stripAnalysis("plain summary")).toBe("plain summary");
		expect(stripAnalysis(SUMMARY_PROMPT.slice(0, 50))).toBeDefined();
	});
});

describe("the cheap rung", () => {
	const RESULTS = 6;
	const RESULT_CHARS = 60_000;

	/** Over the 67k threshold, under the 97k hard limit, and mostly old tool output. */
	function longSession(): Context {
		const messages: AgentMessage[] = [userMessage("start")];
		for (let i = 0; i < RESULTS; i++) {
			messages.push(assistantMessage({ content: [{ type: "toolCall", id: `c${i}`, name: "Bash", arguments: "{}" }] }));
			messages.push(toolResultMessage(`c${i}`, "Bash", [{ type: "text", text: "x".repeat(RESULT_CHARS) }]));
		}
		messages.push(userMessage("what happened?"));
		return { systemPrompt: "sys", messages };
	}

	function countingManager(config: Partial<ConstructorParameters<typeof CompactionManager>[0]> = {}) {
		const calls: number[] = [];
		const faux = fauxProvider([{ text: "<summary>\n1. Request: x\n</summary>" }]);
		const manager = new CompactionManager(
			{ ...CONFIG, ...config },
			{
				streamFn: async function* (model, context, options) {
					calls.push(context.messages.length);
					yield* faux.streamFn(model, context, options);
				},
				summarizerModel: SUMMARIZER,
			},
		);
		return { manager, calls };
	}

	test("answers with previews instead of a summary when it can, without a model call", async () => {
		const { manager, calls } = countingManager({ microcompactFirst: true });
		const decision = await manager.check(longSession());

		expect(decision?.action).toBe("reduced");
		if (decision?.action !== "reduced") throw new Error("expected a reduced decision");
		expect(decision.cleared.results).toBe(RESULTS - 3);
		expect(decision.cleared.chars).toBe((RESULTS - 3) * (RESULT_CHARS - 2_000));
		expect(calls).toEqual([]); // the whole point of a cheap rung

		// The three newest results are the turn's working set, and they are whole.
		const kept = decision.context.messages.filter((m) => m.role === "toolResult").slice(-3);
		for (const message of kept) expect((message as any).content[0].text).toHaveLength(RESULT_CHARS);
	});

	test("is off unless it is switched on", async () => {
		// Default off is the whole reason the setting exists: the same context, the
		// same threshold, and the answer is a summarization call.
		const { manager, calls } = countingManager();
		expect((await manager.check(longSession()))?.action).toBe("compact");
		expect(calls).toHaveLength(1);
	});

	test("a trim that does not get under the threshold is not the answer", async () => {
		// Here the system prompt alone holds the context over the line, so previews
		// cannot bring it under — and a pass that leaves the context over the
		// threshold has not answered the question the threshold asked.
		const { manager } = countingManager({ microcompactFirst: true });
		const context = { ...longSession(), systemPrompt: "s".repeat(300_000) };
		expect((await manager.check(context))?.action).toBe("compact");
	});

	test("the rung still answers with the breaker tripped", async () => {
		// Every summary is failing, so the expensive rung is out of service — which
		// is exactly when a lever that cannot fail is worth having. It also costs
		// nothing to be sure: no request is sent to find out.
		let calls = 0;
		// A silent model: what it streams is not a summary, so every attempt fails
		// the way a broken summarizer fails.
		const silent = fauxProvider([{ text: "" }]);
		const manager = new CompactionManager(
			{ ...CONFIG, microcompactFirst: true },
			{
				streamFn: async function* (model, context, options) {
					calls++;
					yield* silent.streamFn(model, context, options);
				},
				summarizerModel: SUMMARIZER,
			},
		);
		const context = longSession();
		for (let i = 0; i < 3; i++) await expect(manager.compact(context)).rejects.toThrow("empty summary");
		expect(manager.isTripped).toBe(true);
		expect(calls).toBe(3);

		expect((await manager.check(context))?.action).toBe("reduced");
		expect(calls).toBe(3);
	});

	test("the previews are not cut twice", async () => {
		// The session adopts what the pass returned, so the next pass is handed the
		// previews themselves and finds nothing left to cut. Otherwise every turn
		// would report freeing the same characters over and over.
		const { manager } = countingManager({ microcompactFirst: true });
		const context = longSession();
		const first = await manager.check(context);
		if (first?.action !== "reduced") throw new Error("expected a reduced decision");

		expect(manager.trim(first.context)).toBeNull();
	});

	test("trim says what it removed, and reports nothing when there was nothing to remove", () => {
		const { manager } = countingManager({ microcompactFirst: true });
		const trimmed = manager.trim(longSession());
		expect(trimmed?.cleared.results).toBe(RESULTS - 3);
		expect(trimmed?.cleared.chars).toBe((RESULTS - 3) * (RESULT_CHARS - 2_000));
		expect(trimmed?.context.messages).toHaveLength(RESULTS * 2 + 2);

		// Five small results: past the keep-last-three line, and none of them over
		// the per-result budget. Cutting them would free nothing worth the loss.
		const small = (id: string) => toolResultMessage(id, "Bash", [{ type: "text", text: "ok" }]);
		const quiet = { systemPrompt: "sys", messages: ["a", "b", "c", "d", "e"].map(small) };
		expect(manager.trim(quiet)).toBeNull();
	});
});
