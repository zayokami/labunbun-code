import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Context, Model, StreamFn } from "@labunbun/ai";
import {
	assistantMessage,
	FAUX_MODEL,
	fauxProvider,
	INTERRUPTED_TOOL_RESULT_TEXT,
	MessageBuilder,
	repairToolPairing,
	textContent,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import {
	COMPACTION_BOUNDARY_LEAD,
	COMPACTION_DISABLED_NOTICE,
	COMPACTION_REFILLING_NOTICE,
	CompactionManager,
	type CompactionPhase,
	compactionBoundary,
	compactionThreshold,
	contextBreakdown,
	dropOldestRound,
	estimateContextTokens,
	estimateContextUsage,
	extractRecentFiles,
	hardContextLimit,
	IDLE_TRIM_GAP_MS,
	IDLE_TRIM_KEEP_RESULTS,
	IDLE_TRIM_MIN_SAVINGS_TOKENS,
	isCompactionBoundary,
	keepSuffix,
	LENGTH_RECOVERY_MESSAGE,
	microcompact,
	missingSummarySections,
	retainedRequests,
	SUMMARY_PROMPT,
	SUMMARY_SECTIONS,
	stripAnalysis,
} from "../src/compaction.ts";
import { SessionStore } from "../src/session-store.ts";

const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

/** Stands in for the session's model — a real registry entry with a credential. */
const SUMMARIZER: Model = { ...FAUX_MODEL, id: "summarizer-1", apiKeyEnv: "FAUX_API_KEY" };

/** The first text block of a message, for the tests that read what a cut left behind. */
function firstText(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

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

	test("a configured percent is the trigger line, not an input to the arithmetic", () => {
		// 80% of a roomy window is just that number — the reserves play no part.
		expect(compactionThreshold({ contextWindow: 200_000, maxOutputTokens: 8_192, thresholdPercent: 80 })).toBe(160_000);
		// On a small window the named share stays the named share rather than being
		// raised to the 60% floor: a user who names a percent named a percent.
		expect(compactionThreshold({ contextWindow: 16_000, maxOutputTokens: 8_192, thresholdPercent: 10 })).toBe(1_600);
		// Still clamped under the hard limit, where a pass could no longer run —
		// the same ceiling the reserve arithmetic is held to.
		const hot = { contextWindow: 200_000, maxOutputTokens: 8_192, thresholdPercent: 99 };
		expect(compactionThreshold(hot)).toBe(hardContextLimit(hot) - 1);
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

	test("a record the newest boundary predates is passed over, not anchored on", () => {
		// The shape a mid-turn compaction leaves behind: the retained suffix holds
		// the last usage record, and that record measured the prefix the summary
		// just replaced. Anchoring on it reports the old size for the new
		// transcript — the sizes before and after the rewrite come out equal — and
		// every reader of that number (the threshold, the cheap rung, the
		// anti-thrash floor) then works from a transcript that is not there. The
		// record written in the boundary's own millisecond is in here too: it
		// cannot be proven to have carried the boundary, so it counts as outlived.
		const compactedAt = 1_000_000;
		const boundary = compactionBoundary("summary of the earlier work", { timestamp: compactedAt });
		const ask = userMessage("and now this", compactedAt + 1_000);
		const stale = assistantMessage({
			usage: { input: 95_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			timestamp: compactedAt - 60_000,
		});
		const sameMs = assistantMessage({
			usage: { input: 94_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			timestamp: compactedAt,
		});
		const boundaryText = typeof boundary.content === "string" ? boundary.content : "";
		// Exactly what the transcript weighs without an anchor: the boundary's own
		// text, the question under it, and the two records' empty content lists.
		expect(estimateContextTokens([boundary, ask, stale, sameMs])).toBe(
			Math.ceil((boundaryText.length + "and now this".length + "[]".length + "[]".length) / 4),
		);
	});

	test("an anchor recorded after the newest boundary still anchors", () => {
		// The record a compaction leaves valid: the first response after it was
		// sent over the boundary, so its usage measures the transcript that
		// stands. The timestamp is what tells the two apart.
		const compactedAt = 1_000_000;
		const boundary = compactionBoundary("summary", { timestamp: compactedAt });
		const answer = assistantMessage({
			usage: { input: 20_000, output: 500, cacheRead: 0, cacheWrite: 0 },
			timestamp: compactedAt + 60_000,
		});
		expect(estimateContextTokens([boundary, userMessage("go on", compactedAt + 30_000), answer])).toBe(20_500);
	});

	test("a record above the newest boundary does not anchor either", () => {
		// A summary replaces everything above it, so a usage record up there
		// measured yet another prefix — the one now folded into the boundary — and
		// its own timestamp is older than the boundary's for the same reason a
		// retained record's is. With none below it the character count answers,
		// over everything the list still carries.
		const compactedAt = 1_000_000;
		const boundary = compactionBoundary("summary", { timestamp: compactedAt });
		const messages: AgentMessage[] = [
			userMessage("old request", compactedAt - 5_000),
			assistantMessage({
				usage: { input: 80_000, output: 100, cacheRead: 0, cacheWrite: 0 },
				timestamp: compactedAt - 60_000,
			}),
			boundary,
			userMessage("new request", compactedAt + 1_000),
		];
		const boundaryText = typeof boundary.content === "string" ? boundary.content : "";
		expect(estimateContextTokens(messages)).toBe(
			Math.ceil((boundaryText.length + "old request".length + "new request".length + "[]".length) / 4),
		);
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

describe("keepSuffix", () => {
	const result = (id: string, chars: number): AgentMessage =>
		toolResultMessage(id, "Read", [{ type: "text", text: `${id}:${"z".repeat(chars)}` }]);
	const textOf = (messages: AgentMessage[], id: string): string =>
		(messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as { content: { text: string }[] }).content[0]
			?.text ?? "";

	test("a turn too big to carry whole is cut down instead of dropped", () => {
		// This used to keep nothing at all, and one large tool result was enough to
		// trigger it: the request being answered left the context that was supposed
		// to continue it, so the model answered around the question.
		const messages: AgentMessage[] = [
			userMessage("old request"),
			assistantMessage({}),
			userMessage("what does this file do?"),
			assistantMessage({ usage: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0 } }),
			result("c1", 200_000), // ~50k tokens on its own
		];
		const tail = keepSuffix(messages);

		expect(tail).toHaveLength(3);
		expect(tail[0]).toBe(messages[2]); // the request, untouched
		expect(textOf(tail, "c1")).toContain("elided to fit the context window");
		expect(textOf(tail, "c1")).toContain("c1:");
		expect(estimateContextTokens(tail)).toBeLessThanOrEqual(20_000);
	});

	test("the cheap rung runs before anything is elided", () => {
		// Previews are the cheaper loss: the result keeps its shape and its first
		// lines, and nothing has to be cut front-and-back to make room.
		const messages: AgentMessage[] = [
			userMessage("older"),
			assistantMessage({}),
			userMessage("what now?"),
			result("c1", 20_000),
			result("c2", 20_000),
			result("c3", 20_000),
			result("c4", 20_000),
			result("c5", 20_000),
			result("c6", 20_000),
		];
		const tail = keepSuffix(messages);

		expect(tail).toHaveLength(7);
		expect(textOf(tail, "c3")).toContain("truncated by microcompact"); // older than the last three
		expect(textOf(tail, "c6")).toBe(textOf(messages, "c6")); // the newest are left alone
		expect(textOf(tail, "c3")).not.toContain("elided");
		expect(estimateContextTokens(tail)).toBeLessThan(20_000);
	});

	test("the request at the front is never cut, even when it is the whole problem", () => {
		// Cutting it would free the most space and lose the turn: a request cut down
		// to its first line is not the request. Handed back over budget, for the
		// overflow path to deal with as what it is.
		const messages: AgentMessage[] = [userMessage("ask:".concat("y".repeat(200_000))), assistantMessage({})];
		const tail = keepSuffix(messages);

		expect(tail).toHaveLength(2);
		expect(tail[0]?.content).toBe(messages[0]?.content);
		expect(estimateContextTokens(tail)).toBeGreaterThan(20_000);
	});

	test("a tail that fits comes back as it is", () => {
		const messages: AgentMessage[] = [
			userMessage("hi"),
			assistantMessage({ content: [{ type: "text", text: "hello" }] }),
		];
		expect(keepSuffix(messages)).toEqual(messages);
	});
});

describe("what a boundary keeps", () => {
	const textOf = (message: AgentMessage): string =>
		typeof message.content === "string" ? message.content : JSON.stringify(message.content);

	test("the user's own words ride along, verbatim", () => {
		const boundary = compactionBoundary("1. Primary Request: to fix the parser", {
			retainedRequests: ["the parser drops the last line", "now make it keep comments"],
		});
		const text = textOf(boundary);

		expect(text).toContain("1. Primary Request: to fix the parser");
		expect(text).toContain("the parser drops the last line");
		expect(text).toContain("now make it keep comments");
		// Oldest first, so the boundary reads chronologically.
		expect(text.indexOf("drops the last line")).toBeLessThan(text.indexOf("keep comments"));
	});

	test("only requests are kept — not a summary, not the harness talking", () => {
		// A boundary is a user message too, and the continuation nudge after a cut-off
		// response is one as well. Quoting either back as something the user asked for
		// puts a lie in the one part of the boundary that is supposed to be verbatim.
		const messages: AgentMessage[] = [
			userMessage("the first ask"),
			assistantMessage({}),
			userMessage("the second ask"),
			compactionBoundary("an older summary"),
			userMessage(LENGTH_RECOVERY_MESSAGE),
			assistantMessage({}),
		];
		expect(retainedRequests(messages)).toEqual(["the first ask", "the second ask"]);
	});

	test("the one that does not fit is truncated, not skipped", () => {
		// The reason for the rule: the budget stops the boundary from
		// becoming a second transcript, and the message that overruns it is older
		// than everything kept — a request cut down still beats an absent one.
		const long = `ask:${"y".repeat(200_000)}`;
		const kept = retainedRequests([userMessage(long), userMessage("the newest ask")], 1_000);

		expect(kept).toHaveLength(2);
		expect(kept[1]).toBe("the newest ask");
		expect(kept[0]).toContain("ask:");
		expect(kept[0]).toContain("elided to fit the context window");
		expect(kept[0]?.length).toBeLessThanOrEqual(1_000 * 4);
	});

	test("a compaction hands the next one the words it kept", async () => {
		// The chain that makes the original request survive: the second summary is
		// taken over a history whose first item is the first boundary, so what that
		// boundary kept verbatim is still in front of the model that writes the
		// second one. Section 1 of the prompt is what carries it from there.
		const faux = fauxProvider([
			{ text: "<summary>a summary</summary>" },
			{ text: "<summary>another summary</summary>" },
		]);
		const manager = new CompactionManager(CONFIG, { streamFn: faux.streamFn, summarizerModel: SUMMARIZER });
		const context: Context = {
			systemPrompt: "sys",
			messages: [
				userMessage("the original ask"),
				assistantMessage({}),
				userMessage("a later ask"),
				assistantMessage({}),
				userMessage("the current ask"),
				assistantMessage({}),
			],
			tools: [],
		};

		const first = await manager.compact(context);
		expect(textOf(first.messages[0] as AgentMessage)).toContain("the original ask");

		const second = await manager.compact({
			...first,
			messages: [...first.messages, userMessage("one more ask"), assistantMessage({})],
		});
		const asked = JSON.stringify(faux.receivedContexts.at(-1)?.messages);
		expect(asked).toContain("the original ask");
		expect(asked).toContain("the current ask");
		expect(textOf(second.messages[0] as AgentMessage)).toContain("the current ask");
	});
});

describe("SUMMARY_PROMPT", () => {
	test("asks for the user's original request by name", () => {
		// The retention rule keeps the newest requests verbatim and says nothing
		// about the first one; the prompt is the only thing that carries that. Its
		// other instructions are weighted toward the recent turns — the closing
		// line points "be exhaustive" at sections 8-11 — so a summary that is not
		// asked for the original request describes the work without saying what it
		// was for, and each further compaction leaves the question a little further
		// behind.
		const asked = SUMMARY_PROMPT.indexOf("ORIGINAL request");
		expect(asked).toBeGreaterThan(-1);
		expect(asked).toBeLessThan(SUMMARY_PROMPT.indexOf("2. Key Technical Concepts"));
	});

	test("asks for the decisions and the files by name, and fences off what a user message is", () => {
		// Three things a later turn cannot reconstruct from the summary alone: why
		// a choice was made (so it is not silently reversed), which files changed
		// (so a stale description is not read as current), and the user's words
		// themselves. The last one needs the fence: tool results and file contents
		// read like prose, and a summarizer that counts one as a user message
		// invents an instruction no one gave.
		expect(SUMMARY_PROMPT).toContain("6. Key Decisions");
		expect(SUMMARY_PROMPT).toContain("7. Files Modified");
		expect(SUMMARY_PROMPT).toContain("A user message is only what the user typed");
		expect(SUMMARY_PROMPT).toContain("Be exhaustive on sections 8-11");
	});

	test("the section list and the prompt cannot drift apart", () => {
		// SUMMARY_SECTIONS is the checklist a reply is verified against, and the
		// prompt is what the model was actually asked for. A header phrased in one
		// and not the other is either a warning about a section nobody requested
		// or a section nothing checks — and the closing line's range has to move
		// with the list, or "be exhaustive" points at headings that no longer end
		// the prompt.
		for (const header of SUMMARY_SECTIONS) expect(SUMMARY_PROMPT).toContain(header);
		expect(SUMMARY_SECTIONS.every((header, index) => header.startsWith(`${index + 1}. `))).toBe(true);
		expect(SUMMARY_PROMPT).toContain(
			`Be exhaustive on sections ${SUMMARY_SECTIONS.length - 3}-${SUMMARY_SECTIONS.length}`,
		);
	});
});

describe("missingSummarySections", () => {
	/** A reply that wrote every header the prompt lists, each with content. */
	const complete = `${SUMMARY_SECTIONS.map((header) => `${header}:\n[content]`).join("\n")}\n`;

	test("a complete reply is missing nothing", () => {
		expect(missingSummarySections(complete)).toEqual([]);
	});

	test("names what a reply left out, by the headers the prompt asked for", () => {
		const reply = complete.replace("6. Key Decisions", "Some choices were made");
		expect(missingSummarySections(reply)).toEqual(["6. Key Decisions"]);
	});

	test("a header that dropped its number still counts as present", () => {
		// The check exists to catch missing state, not missing punctuation: a
		// reply titled "Pending Tasks" plainly carries the section, and a warning
		// about it would teach the user to ignore the warnings.
		expect(missingSummarySections(complete.replace("9. Pending Tasks", "Pending Tasks"))).toEqual([]);
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

	/**
	 * The context a check produced, or null when it produced none.
	 *
	 * A manager used to expose this directly (`maybeCompact`), and production
	 * never called it: the loop asks for the decision, because a summary and a
	 * set of previews are not the same event. Tests that only read the messages
	 * narrow the decision here instead of keeping a second entry point alive for
	 * their sake — and "blocked" narrows to null, because nothing was sent.
	 */
	async function checked(
		manager: CompactionManager,
		context: Context,
		options?: { force?: boolean },
	): Promise<Context | null> {
		const decision = await manager.check(context, options);
		return decision && decision.action !== "blocked" ? decision.context : null;
	}

	test("check skips below threshold", async () => {
		const manager = makeManager("summary");
		const context = { systemPrompt: "", messages: [userMessage("short")] };
		expect(await checked(manager, context)).toBeNull();
	});

	test("compacts when the system prompt alone crosses the threshold", async () => {
		const manager = makeManager("<summary>1. Request: x</summary>");
		const context = { systemPrompt: "s".repeat(300_000), messages: [userMessage("short")] };
		expect(await checked(manager, context)).not.toBeNull();
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
		const result = await checked(manager, { systemPrompt: "sys", messages });
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

		const compacted = await checked(manager, { systemPrompt: "", messages });
		expect(compacted).not.toBeNull();
		expect(summaries).toBe(1);
		if (!compacted) throw new Error("expected a compaction result");
		// The session adopts this, so it is what the next check is consulted about.
		expect(estimateContextUsage(compacted)).toBeGreaterThan(compactionThreshold(CONFIG));

		expect(await checked(manager, compacted)).toBeNull();
		expect(summaries).toBe(1);
		// Growth is what makes it worth trying again — a turn the summary has not
		// already accounted for.
		const grown = { ...compacted, messages: [...compacted.messages, userMessage("y".repeat(40_000))] };
		expect(await checked(manager, grown)).not.toBeNull();
		expect(summaries).toBe(2);
	});

	/** A store holding a conversation that was compacted once, with no suffix kept. */
	function compactedStore(postTokens: number): SessionStore {
		const home = mkdtempSync(join(tmpdir(), "lbb-compact-home-"));
		const store = SessionStore.startNew(mkdtempSync(join(tmpdir(), "lbb-compact-")), home);
		store.appendMessage(userMessage("the earlier request"));
		store.appendCompaction({
			boundary: userMessage("[Conversation compacted to stay within the context window.]"),
			suffix: [],
			summary: "1. Request: the earlier request",
			preservedFiles: [],
			preTokens: 90_000,
			postTokens,
			model: "summarizer-1",
			trigger: "auto",
		});
		return store;
	}

	/** The transcript a session resumed onto that store starts from, plus one turn. */
	function resumedContext(store: SessionStore, usedTokens: number): Context {
		return {
			systemPrompt: "",
			messages: [
				...store.contextMessages(),
				assistantMessage({ usage: { input: usedTokens, output: 100, cacheRead: 0, cacheWrite: 0 } }),
				userMessage("and continue"),
			],
		};
	}

	test("a session resumed onto its own summary is not summarized again for the same transcript", async () => {
		// Anti-thrash lived in memory, and `/resume` is exactly the event that
		// throws that memory away. The transcript a resumed session starts from is
		// the compacted one — still over the threshold, by design — so without
		// reading the record back it pays for the same summary a second time.
		const store = compactedStore(66_000);
		let summaries = 0;
		const counting: StreamFn = async function* (model, context, options) {
			summaries++;
			yield* fauxProvider([{ text: "<summary>1. Request: x</summary>" }]).streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: counting, summarizerModel: SUMMARIZER, store });

		// 68.1k is over the 67k threshold, and within the 5% of 66k that the last
		// pass left behind: the same conversation, not a grown one.
		expect(await checked(manager, resumedContext(store, 68_000))).toBeNull();
		expect(summaries).toBe(0);
	});

	test("an imported compaction, which carries no measurement, suppresses nothing", async () => {
		// `postTokens: 0` is what a compaction copied in from another tool is written
		// with: no pass in this session measured it. What the record is for is the
		// comparison against growth, and a zero must not make the first real pass
		// look like a repeat of one that never happened here.
		const store = compactedStore(0);
		let summaries = 0;
		const counting: StreamFn = async function* (model, context, options) {
			summaries++;
			yield* fauxProvider([{ text: "<summary>1. Request: x</summary>" }]).streamFn(model, context, options);
		};
		const manager = new CompactionManager(CONFIG, { streamFn: counting, summarizerModel: SUMMARIZER, store });

		expect(await checked(manager, resumedContext(store, 90_000))).not.toBeNull();
		expect(summaries).toBe(1);
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

	test("a turn too large to carry verbatim is cut down, and the request kept", async () => {
		// This used to be summarized away with the rest, on the argument that keeping
		// it left the summary replacing almost nothing. The cost of that is the turn
		// itself: the request being answered went into the summary, and the model
		// then answered a description of the question instead of the question.
		const manager = makeManager("<summary>1. Request: x</summary>");
		const messages: AgentMessage[] = [
			userMessage("old request"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("current request"),
			assistantMessage({
				content: [{ type: "text", text: "x".repeat(200_000) }], // ~50k tokens
			}),
		];
		const result = await checked(manager, { systemPrompt: "sys", messages });

		expect(result?.messages).toHaveLength(3);
		expect(result?.messages[1]).toBe(messages[2]); // the request, untouched
		expect(firstText(result?.messages[2])).toContain("elided to fit the context window");
	});

	test("force compacts below the threshold — the estimate does not get a vote after a refusal", async () => {
		// The provider already refused this request for size, so the estimate is
		// known to be wrong about this session. Consulting it again is how a
		// session stays bricked: every later turn fails identically.
		const manager = makeManager("<summary>1. Request: x</summary>");
		const context = { systemPrompt: "", messages: [userMessage("short")] };

		expect(await checked(manager, context)).toBeNull();
		expect(await checked(manager, context, { force: true })).not.toBeNull();
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
		expect(await checked(manager, context)).toBeNull(); // over the threshold, refused by the breaker
		expect(await checked(manager, context, { force: true })).not.toBeNull();
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

	/** An over-threshold context arriving on a later check, freshly measured. */
	function refilledContext(): Context {
		// Timestamps pinned ahead of any boundary this test writes. The estimator
		// trusts a usage record only if it postdates the newest boundary, and one
		// written in the same millisecond cannot be proven newer — a fixture left to
		// the clock would flip this suite between green and red.
		const at = Date.now() + 60_000;
		return {
			systemPrompt: "",
			messages: [
				userMessage("do the thing", at),
				assistantMessage({
					usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
					timestamp: at + 1,
				}),
				userMessage("and now this", at + 2),
			],
		};
	}

	/** A turn that adds nothing: under the threshold, so it is answered "not yet". */
	function quietContext(): Context {
		return { systemPrompt: "", messages: [userMessage("short")] };
	}

	test("three compactions that each refilled within three checks trip the breaker", async () => {
		// The other shape of stuck: every summary works, and the space is gone again
		// before the next few turns are done. Left alone it buys a full
		// summarization call every turn or two, each freeing nearly the same nothing
		// the last one did — and unlike a failing summarizer, nothing in the
		// session looks broken while it happens.
		const manager = makeManager("<summary>1. Request: x</summary>");

		// The first is free: the distance to any compaction recorded before this
		// manager existed is unknown, and only a refill it watched counts.
		expect(await checked(manager, refilledContext())).not.toBeNull();
		// The third check after a compaction is still inside the window, and that
		// boundary is the claim, so it is pinned with quiet checks rather than left
		// to whenever a refill happens to arrive.
		expect(await checked(manager, quietContext())).toBeNull();
		expect(await checked(manager, quietContext())).toBeNull();
		expect(await checked(manager, refilledContext())).not.toBeNull(); // refill 1, at distance 3
		expect(await checked(manager, refilledContext())).not.toBeNull(); // refill 2
		expect(await checked(manager, refilledContext())).not.toBeNull(); // refill 3 — trips
		expect(manager.isTripped).toBe(true);
		// Automatic asks are turned away now; the way out is the user's.
		expect(await checked(manager, refilledContext())).toBeNull();
		// Forced recovery is not stopped, same reasoning as the failure trip: the
		// refusal already on record is a fact about this request, not a guess.
		expect(await checked(manager, refilledContext(), { force: true })).not.toBeNull();
	});

	test("a compaction after a real gap resets the refill run", async () => {
		// Three rapid refills in a row is the trip; the same refills with unbroken
		// stretches between them are compactions doing their job, and the count has
		// to be consecutive or a long session would trip on its third compaction
		// ever.
		const manager = makeManager("<summary>1. Request: x</summary>");
		expect(await checked(manager, refilledContext())).not.toBeNull(); // free
		expect(await checked(manager, refilledContext())).not.toBeNull(); // refill 1
		expect(await checked(manager, refilledContext())).not.toBeNull(); // refill 2
		// Three quiet checks: the next compaction lands on the fourth check after
		// the last one, past the window, so it follows growth rather than the last
		// summary — the other side of the distance-3 boundary above.
		for (let i = 0; i < 3; i++) {
			expect(await checked(manager, quietContext())).toBeNull();
		}
		expect(await checked(manager, refilledContext())).not.toBeNull(); // distance 4 — resets
		// The run starts over: two more refills are not a third.
		expect(await checked(manager, refilledContext())).not.toBeNull();
		expect(await checked(manager, refilledContext())).not.toBeNull();
		expect(manager.isTripped).toBe(false);
	});

	test("a successful manual compaction clears the refill run", async () => {
		// Same reasoning as the failure breaker: /compact is the escape hatch, and a
		// summary the user asked for and got is the contradiction that clears the
		// count — otherwise a tripped refill session could never get its
		// automatic compaction back.
		const manager = makeManager("<summary>1. Request: x</summary>");
		for (let i = 0; i < 4; i++) await checked(manager, refilledContext());
		expect(manager.isTripped).toBe(true);

		await manager.compact(refilledContext(), { trigger: "manual" });
		expect(manager.isTripped).toBe(false);
		// And the automatic path answers again.
		expect(await checked(manager, refilledContext())).not.toBeNull();
	});

	test("a refill trip is told as a conversation problem, not a failed mechanism", async () => {
		// The summaries all worked, so "failed N times" would be a false report —
		// and the advice differs: /compact alone summarizes the same way again,
		// while the cause is the size of something being read into the transcript.
		const manager = makeManager("<summary>1. Request: x</summary>");
		for (let i = 0; i < 4; i++) await checked(manager, refilledContext());
		expect(manager.isTripped).toBe(true);

		const blocked = manager.blockedMessage();
		expect(blocked).toContain("refilled");
		expect(blocked).toContain("reading it in pieces");
		expect(blocked).toContain("/trim");
		expect(blocked).not.toContain("failed");
		expect(manager.disabledNotice()).toBe(COMPACTION_REFILLING_NOTICE);

		// The failure trip still gets its own words.
		const failing = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ throwError: new Error("provider down") }]).streamFn,
			summarizerModel: SUMMARIZER,
		});
		for (let i = 0; i < 3; i++) {
			await expect(failing.compact({ systemPrompt: "", messages: [userMessage("x")] })).rejects.toThrow();
		}
		expect(failing.disabledNotice()).toBe(COMPACTION_DISABLED_NOTICE);
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
			userMessage("earlier"),
			assistantMessage({ content: [{ type: "text", text: "ok" }] }),
			userMessage("work"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];
		// Through the store, as a real turn is: the record names the tail it stands
		// in front of, and a tail the file has never seen is refused.
		for (const message of messages) store.appendMessage(message);
		await checked(manager, { systemPrompt: "sys", messages });

		expect(seen).toEqual(["deepseek-chat DEEPSEEK_API_KEY https://api.deepseek.com/v1"]);
		// And the record names the writer: a summary no one can attribute is a
		// summary no one can audit.
		const marker = store.entries.find((e) => e.type === "compaction");
		expect(marker?.type === "compaction" ? marker.model : undefined).toBe("deepseek-chat");
	});

	test("each preserved file carries a fingerprint of what it held at the boundary", async () => {
		// The record makes a claim — "the summary still describes this file" — and a
		// hash taken at the boundary is what lets a later pass tell a claim still
		// true from one the file has moved past. A file the reader cannot open is
		// recorded without a hash rather than with a made-up one: "unreadable then"
		// and "unchanged since" are different answers, and only one is agreement.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-compact-")),
			mkdtempSync(join(tmpdir(), "lbb-compact-home-")),
		);
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
			store,
			readFile: (path) => (path === "/present.ts" ? "const answer = 42;" : null),
		});
		const messages: AgentMessage[] = [
			userMessage("the earlier request"),
			assistantMessage({
				content: [{ type: "toolCall", id: "0", name: "Edit", arguments: JSON.stringify({ file_path: "/present.ts" }) }],
				usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			}),
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Read", arguments: JSON.stringify({ file_path: "/gone.ts" }) }],
			}),
			userMessage("the current ask"),
		];
		// Through the store, as a real turn is: the record names the tail it stands
		// in front of, and a tail the file has never seen is refused.
		for (const message of messages) store.appendMessage(message);
		await manager.compact({ systemPrompt: "sys", messages }, { trigger: "manual" });

		// Read back from the file rather than the live array: the fingerprint is
		// part of what a later session loads, so that is the copy under test.
		const marker = SessionStore.load(store.path).entries.find((e) => e.type === "compaction");
		if (marker?.type !== "compaction") throw new Error("expected a compaction record");
		expect(marker.preservedFiles).toEqual([
			{ path: "/gone.ts" },
			{ path: "/present.ts", hash: createHash("sha256").update("const answer = 42;").digest("hex") },
		]);
	});

	test("the done phase carries what the pass could check about its own product", async () => {
		// The receipt a caller prints is only as true as this object: how much went
		// into the summary against what survived verbatim, whether the reply
		// carried the sections it was asked for, which files got fingerprints —
		// and whether the session file took the record at all.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-compact-")),
			mkdtempSync(join(tmpdir(), "lbb-compact-home-")),
		);
		const phases: CompactionPhase[] = [];
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
			store,
			readFile: (path) => (path === "/present.ts" ? "const answer = 42;" : null),
			onPhase: (phase) => phases.push(phase),
		});
		const messages: AgentMessage[] = [
			userMessage("the earlier request"),
			assistantMessage({
				content: [{ type: "toolCall", id: "0", name: "Edit", arguments: JSON.stringify({ file_path: "/present.ts" }) }],
				usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			}),
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Read", arguments: JSON.stringify({ file_path: "/gone.ts" }) }],
			}),
			userMessage("the current ask"),
		];
		for (const message of messages) store.appendMessage(message);
		const compacted = await manager.compact({ systemPrompt: "sys", messages }, { trigger: "manual" });

		const done = phases.at(-1);
		if (done?.kind !== "done") throw new Error("expected a done phase");
		// The stub reply carries no header at all, so every section is named — the
		// check is about the reply in hand, not the prompt.
		expect(done.verification).toEqual({
			recorded: true,
			summarized: 3,
			kept: 1,
			missingSections: [...SUMMARY_SECTIONS],
			filesReadable: 1,
			filesUnreadable: 1,
		});
		// Stated against the context that came back, so the two halves of the
		// count cannot both be wrong in the same direction: keepSuffix kept the
		// last user message, and the boundary stands in front of exactly those.
		expect(compacted.messages).toHaveLength(1 + done.verification.kept);
		// And the same object is what `/compact` reads back: a phase listener has
		// no way to hand anything to a command's return value.
		expect(manager.lastVerification()).toEqual(done.verification);
	});

	test("a record the session file refused is said so, not left to look recorded", async () => {
		// appendCompaction refuses when the suffix is not the file's own tail —
		// the store here has never seen the compacted messages. The in-memory
		// context is replaced all the same, and before this the refusal vanished:
		// the next resume replayed the file as if no summary had run.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-compact-")),
			mkdtempSync(join(tmpdir(), "lbb-compact-home-")),
		);
		const phases: CompactionPhase[] = [];
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
			store,
			onPhase: (phase) => phases.push(phase),
		});
		const messages: AgentMessage[] = [userMessage("one"), assistantMessage({}), userMessage("two")];
		// Deliberately not appended to the store: the file's tail is empty.
		await manager.compact({ systemPrompt: "sys", messages });

		const done = phases.at(-1);
		if (done?.kind !== "done") throw new Error("expected a done phase");
		expect(done.verification.recorded).toBe(false);
		expect(manager.lastVerification()?.recorded).toBe(false);
		// And nothing landed in the file — the flag is the only trace, which is
		// exactly why it has to reach the report.
		expect(store.compactions()).toHaveLength(0);
	});

	test("a synthetic result from a resume is kept in memory but never claimed by the file's record", async () => {
		// A resume answers an interrupted call in memory; `appendMessage` cannot
		// insert mid-stream, so the session file has no entry behind the synthetic
		// result. The record names the file's real tail instead: a suffix carrying
		// the synthetic would be refused, and the next resume would replay the old
		// file as if no summary had run.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-compact-")),
			mkdtempSync(join(tmpdir(), "lbb-compact-home-")),
		);
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
			store,
		});
		const earlier = userMessage("the earlier request");
		const settled = assistantMessage({ content: [{ type: "text", text: "ok" }] });
		const request = userMessage("run it");
		const call = assistantMessage({
			content: [{ type: "toolCall", id: "t1", name: "Read", arguments: "{}" }],
			stopReason: "toolUse",
		});
		for (const message of [earlier, settled, request, call]) store.appendMessage(message);
		const synthetic: AgentMessage = {
			...toolResultMessage("t1", "Read", [textContent(INTERRUPTED_TOOL_RESULT_TEXT)], true, call.timestamp),
			synthetic: true,
		};
		const compacted = await manager.compact(
			{ systemPrompt: "sys", messages: [earlier, settled, request, call, synthetic] },
			{ trigger: "manual" },
		);

		expect(manager.lastVerification()?.recorded).toBe(true);
		expect(store.compactions()).toHaveLength(1);
		// The live transcript keeps the answer the provider requires.
		expect(compacted.messages.some((message) => message.role === "toolResult" && message.toolCallId === "t1")).toBe(
			true,
		);
		// The file keeps the messages that existed on disk; the repair answers the
		// call again on the next read, which is what keeps the two copies in step.
		const context = SessionStore.load(store.path).contextMessages();
		expect(context.some((message) => message.role === "toolResult" && message.toolCallId === "t1")).toBe(false);
		const repaired = repairToolPairing(context);
		const answered = repaired.messages.find((message) => message.role === "toolResult" && message.toolCallId === "t1");
		expect(answered?.role === "toolResult" ? answered.isError : false).toBe(true);
		expect(repaired.synthesized).toBe(1);
	});

	test("the summary request itself shrinks instead of failing when it is too large", async () => {
		// The summary request is the conversation it is summarizing: the one call
		// that is too big by construction, and the only way out of that state. It
		// may not fail for the reason it exists to fix. Three protections, in
		// order: the transcript goes over as the session's own request first — the
		// attempt whose unchanged prefix reads the cache back — then, behind a
		// refusal, previews of the old tool results, then dropping the oldest
		// whole round.
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

		// The first attempt is the transcript as the session last sent it — whole
		// tool results and all. That is the attempt that reads the cache back, so
		// it goes first; rewriting bytes the cache is keyed on is a price only a
		// refusal may ask for.
		const first = JSON.stringify(sent[0]);
		expect(first).not.toContain("truncated by microcompact");
		expect(first).toContain("oldest request");
		// The refusal buys the cheap rung: the retry carries previews of the old
		// tool output and is smaller for it — and still a conversation, starting
		// on a user turn.
		const second = JSON.stringify(sent[1] as AgentMessage[]);
		expect(second).toContain("truncated by microcompact");
		expect(second).toContain("oldest request");
		expect(second.length).toBeLessThan(first.length);
		expect((sent[1] as AgentMessage[])[0]?.role).toBe("user");
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

describe("the boundary's transcript pointer", () => {
	function textOf(message: AgentMessage | undefined): string {
		return message?.role === "user" && typeof message.content === "string" ? message.content : "";
	}

	test("a store-backed compaction names the session file, after everything else", async () => {
		// The summary is lossy on purpose; the file it was taken from is not. The
		// pointer is what a model reaches for when it needs a file's exact contents
		// or a request's exact words instead of the retelling — and it rides last,
		// because the lead has to stay the first line the boundary's four readers
		// look for.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-boundary-")),
			mkdtempSync(join(tmpdir(), "lbb-boundary-home-")),
		);
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
			store,
		});
		const messages: AgentMessage[] = [
			userMessage("the earlier ask"),
			assistantMessage({}),
			userMessage("the current ask"),
		];
		for (const message of messages) store.appendMessage(message);

		const compacted = await manager.compact({ systemPrompt: "", messages }, { trigger: "manual" });
		const text = textOf(compacted.messages[0]);

		expect(text.startsWith(COMPACTION_BOUNDARY_LEAD)).toBe(true);
		expect(text).toContain(store.path);
		expect(text.indexOf(store.path)).toBeGreaterThan(text.indexOf("1. Request: x"));
	});

	test("a boundary with no file behind it names none", async () => {
		// A subagent and the beetle band run with no session file, and an imported
		// boundary stands in for a transcript from another tool's world that may
		// hold no local file at all. A pointer to a path nobody wrote would be
		// worse than the silence, so both shapes come out of the same builder with
		// no line.
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn,
			summarizerModel: SUMMARIZER,
		});
		const compacted = await manager.compact({
			systemPrompt: "",
			messages: [userMessage("the earlier ask"), assistantMessage({}), userMessage("the current ask")],
		});
		expect(textOf(compacted.messages[0])).not.toContain("can be read at");
		// And this is what migration writes, through the same builder: the import
		// call site passes no path, and its boundary reads like it always did.
		expect(textOf(compactionBoundary("an imported summary", { timestamp: 1_000 }))).not.toContain("can be read at");
	});

	test("the rules that read a boundary still find one that carries the path", () => {
		// The lead is shared by four co-dependent rules and each has to keep
		// working: retention, and the estimator's answer to which usage records the
		// rewrite outlived (both through the predicate beside this), plus the TUI
		// replay, which reads that same predicate. They all look at the opening,
		// and the paragraph went after everything, so nothing they read has moved.
		const boundary = compactionBoundary("an earlier summary", { transcriptPath: "/sessions/abc.jsonl" });
		expect(isCompactionBoundary(boundary)).toBe(true);
		// Retention: a summary wearing a user's clothes is not one of the user's
		// requests, pointer or not.
		expect(retainedRequests([userMessage("the first ask"), boundary, userMessage("the newest ask")])).toEqual([
			"the first ask",
			"the newest ask",
		]);
		// The estimator: a usage record older than the boundary still cannot anchor
		// through it, even though the boundary now weighs more than the lead alone.
		// The answer is the character count over everything the list still holds.
		const compactedAt = 1_000_000;
		const dated = compactionBoundary("an earlier summary", {
			transcriptPath: "/sessions/abc.jsonl",
			timestamp: compactedAt,
		});
		const stale = assistantMessage({
			usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			timestamp: compactedAt - 1_000,
		});
		expect(estimateContextTokens([stale, dated, userMessage("and now this", compactedAt + 1)])).toBe(
			Math.ceil((textOf(dated).length + "and now this".length + "[]".length) / 4),
		);
	});
});

describe("automatic compaction switched off", () => {
	const OFF = { ...CONFIG, enabled: false };

	/** A manager whose one summary call would be counted, if one were ever made. */
	function offManager(config: Partial<ConstructorParameters<typeof CompactionManager>[0]> = {}) {
		const calls: number[] = [];
		const faux = fauxProvider([{ text: "<summary>\n1. Request: x\n</summary>" }]);
		const manager = new CompactionManager(
			{ ...OFF, ...config },
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

	/** Over the 67k threshold, under the 97k hard limit: what the threshold rung acts on. */
	const over: Context = {
		systemPrompt: "",
		messages: [
			userMessage("do the thing"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		],
	};

	/** Old tool output in bulk: what a live cheap rung would cut first. */
	function heavy(): Context {
		const messages: AgentMessage[] = [userMessage("start")];
		for (let i = 0; i < 6; i++) {
			messages.push(assistantMessage({ content: [{ type: "toolCall", id: `c${i}`, name: "Bash", arguments: "{}" }] }));
			messages.push(toolResultMessage(`c${i}`, "Bash", [{ type: "text", text: "x".repeat(60_000) }]));
		}
		messages.push(userMessage("what happened?"));
		return { systemPrompt: "", messages };
	}

	test("an unforced check answers nothing, however far over the threshold", async () => {
		// Off is off: the threshold does not get to ask, and the context is handed
		// back exactly as it stands — no summary call, no decision.
		const { manager, calls } = offManager();
		expect(await manager.check(over)).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a forced check still compacts — off is not a way to end a run", async () => {
		// `force` is the provider having already refused this request for size. With
		// the automatic path switched off, refusing to compact here would leave a
		// run that can neither send the request nor make room for it: the user's
		// setting would end the session instead of the automation.
		const { manager, calls } = offManager();
		const decision = await manager.check(over, { force: true });
		expect(decision?.action).toBe("compact");
		expect(calls).toHaveLength(1);
	});

	test("the automatic trim stays off with it, at the threshold and on idle", async () => {
		// The setting covers the automatic side, and previews of old tool results
		// are that side. A `reduced` decision here would have rewritten the context
		// the user asked to be left alone — with no model call anywhere in it to
		// show the rewrite happened.
		const { manager } = offManager({ microcompactFirst: true });
		expect(await manager.check(heavy())).toBeNull();
		// The idle trigger does not open a second door into it.
		expect(await manager.check(heavy(), { idleMs: IDLE_TRIM_GAP_MS })).toBeNull();
	});
});

describe("the idle trim", () => {
	const RESULTS = 8;
	const RESULT_CHARS = 30_000;

	/**
	 * Under the threshold and free of usage anchors, so size alone has nothing to
	 * say: the idle trigger is the only thing left, and the old results are big
	 * enough for the saving floor.
	 */
	function idleSession(results = RESULTS, resultChars = RESULT_CHARS): Context {
		const messages: AgentMessage[] = [userMessage("start")];
		for (let i = 0; i < results; i++) {
			messages.push(assistantMessage({ content: [{ type: "toolCall", id: `c${i}`, name: "Bash", arguments: "{}" }] }));
			messages.push(toolResultMessage(`c${i}`, "Bash", [{ type: "text", text: "x".repeat(resultChars) }]));
		}
		messages.push(userMessage("what happened?"));
		return { systemPrompt: "", messages };
	}

	function idleManager(config: Partial<ConstructorParameters<typeof CompactionManager>[0]> = {}) {
		const calls: number[] = [];
		const faux = fauxProvider([{ text: "<summary>\n1. Request: x\n</summary>" }]);
		const manager = new CompactionManager(
			{ ...CONFIG, microcompactFirst: true, ...config },
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

	test("an idle gap turns the old results into previews, keeping the newest five", async () => {
		// The gap is the whole trigger: this context is under the threshold, so a
		// size-driven check sends it as it is — and the rewrite is free anyway,
		// because the prefix it touches has not been read from a warm cache since
		// the gap began.
		const { manager, calls } = idleManager();
		const context = idleSession();
		const before = estimateContextUsage(context);
		expect(before).toBeLessThan(compactionThreshold(CONFIG)); // the fixture's point
		expect(await manager.check(context)).toBeNull(); // size alone: not yet

		const decision = await manager.check(context, { idleMs: IDLE_TRIM_GAP_MS });

		expect(decision?.action).toBe("reduced");
		if (decision?.action !== "reduced") throw new Error("expected a reduced decision");
		expect(decision.cleared.results).toBe(RESULTS - IDLE_TRIM_KEEP_RESULTS);
		expect(decision.cleared.chars).toBe((RESULTS - IDLE_TRIM_KEEP_RESULTS) * (RESULT_CHARS - 2_000));
		expect(calls).toEqual([]); // no model call: the previews are the whole rung
		expect(estimateContextUsage(decision.context)).toBeLessThan(before);

		// The five newest results are the turn's working set, and they survive whole.
		const kept = decision.context.messages.filter((m) => m.role === "toolResult").slice(-IDLE_TRIM_KEEP_RESULTS);
		expect(kept).toHaveLength(IDLE_TRIM_KEEP_RESULTS);
		for (const message of kept) expect((message as any).content[0].text).toHaveLength(RESULT_CHARS);
	});

	test("below the gap, and with no gap to go on, nothing happens", async () => {
		const { manager, calls } = idleManager();
		expect(await manager.check(idleSession(), { idleMs: IDLE_TRIM_GAP_MS - 1 })).toBeNull();
		expect(await manager.check(idleSession())).toBeNull(); // no idleMs: the check the loop has always made
		expect(calls).toEqual([]);
	});

	test("a saving under the floor is not applied at all", async () => {
		// All-or-nothing: one result past the keep-five line frees a rounding error
		// of the window, and previews that buy nothing are detail given away for
		// free — which is not free.
		const { manager } = idleManager();
		const freed = (6 - IDLE_TRIM_KEEP_RESULTS) * (20_000 - 2_000);
		expect(Math.ceil(freed / 4)).toBeLessThan(IDLE_TRIM_MIN_SAVINGS_TOKENS); // the fixture sits under the floor
		expect(await manager.check(idleSession(6, 20_000), { idleMs: IDLE_TRIM_GAP_MS })).toBeNull();
	});

	test("with the cheap rung opted out, an idle gap changes nothing", async () => {
		// The flag is the user's answer to whether previews of old tool results are
		// acceptable for this conversation, and idle is that same rewrite — a
		// trigger that moved is not a permission that widened.
		const { manager } = idleManager({ microcompactFirst: false });
		expect(await manager.check(idleSession(), { idleMs: IDLE_TRIM_GAP_MS })).toBeNull();
	});

	test("one trim per gap: the previews are not cut twice", async () => {
		// The session adopts what the decision returned, so a second check — the
		// gap has not moved — is handed the previews themselves and finds nothing
		// left to cut. Same invariant the threshold rung has, and for the same
		// reason: a preview fits its budget with the marker inside it.
		const { manager } = idleManager();
		const first = await manager.check(idleSession(), { idleMs: IDLE_TRIM_GAP_MS });
		if (first?.action !== "reduced") throw new Error("expected a reduced decision");
		expect(await manager.check(first.context, { idleMs: IDLE_TRIM_GAP_MS })).toBeNull();
		expect(manager.trim(first.context, IDLE_TRIM_KEEP_RESULTS)).toBeNull();
	});

	test("a forced pass wins over an idle trim", async () => {
		// `force` is a request the provider already refused for size: the pass that
		// may not be deferred is the one that makes room for a request that has to
		// go out. The idle trim is an optimization, and an optimization does not
		// get to stand in front of a recovery.
		const { manager, calls } = idleManager();
		const decision = await manager.check(idleSession(), { idleMs: IDLE_TRIM_GAP_MS, force: true });
		expect(decision?.action).toBe("compact");
		expect(calls).toHaveLength(1);
	});
});

describe("an interrupted compaction", () => {
	/** Over the 67k threshold, under the 97k hard limit: what a check may compact. */
	const overThreshold: Context = { systemPrompt: "s".repeat(300_000), messages: [userMessage("short")] };

	test("the run's signal reaches the summary request unchanged", async () => {
		// The cancel has to survive every hop — the loop's controller into the
		// check, the check into the summary request — or Esc during a summary does
		// nothing and the pass runs to completion behind it. Identity, not merely
		// presence: a copy is a signal the abort never fires on.
		const controller = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		const streamFn: StreamFn = async function* (model, context, options) {
			seen.push(options?.signal);
			yield* fauxProvider([{ text: "<summary>1. Request: x</summary>", usage: { input: 10, output: 10 } }]).streamFn(
				model,
				context,
				options,
			);
		};
		const manager = new CompactionManager(CONFIG, { streamFn, summarizerModel: SUMMARIZER });

		expect((await manager.check(overThreshold, { signal: controller.signal }))?.action).toBe("compact");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(controller.signal);
	});

	test("a cancelled summary is not a failure: no breaker trip, no blocked verdict", async () => {
		// Three cancels in a row counted as three failures, which trips the breaker
		// and switches automatic compaction off for the session — the summarizer
		// blamed for the user pressing Esc. And a cancel is not a verdict about the
		// context either: "the conversation no longer fits" is the wrong report for
		// someone who just asked everything to stop.
		const manager = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ text: "<summary>1. Request: x</summary>", abortIfSignaled: true }]).streamFn,
			summarizerModel: SUMMARIZER,
		});

		const cancelled = () => {
			const controller = new AbortController();
			controller.abort();
			return controller.signal;
		};
		for (let i = 0; i < 3; i++) {
			expect(await manager.check(overThreshold, { signal: cancelled() })).toBeNull();
		}
		expect(manager.isTripped).toBe(false);
		// The forced path is where "blocked" would surface — the request the
		// provider already refused may not be deferred — and a cancel is the one
		// thing it still may answer with "not this way".
		expect(await manager.check(overThreshold, { signal: cancelled(), force: true })).toBeNull();
		// No receipt, either: nothing was adopted, so the last verification is not
		// this pass's to claim.
		expect(manager.lastVerification()).toBeUndefined();
	});

	test("a reply cut off by a cancel is not adopted as a summary", async () => {
		// The abort arrived after a text delta: text is in hand, and none of it is
		// a summary — a reply cut mid-sentence describes half a conversation, and
		// adopting it would leave the session with a boundary whose content is a
		// fragment. The pass must end without a boundary and without a record.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-compact-")),
			mkdtempSync(join(tmpdir(), "lbb-compact-home-")),
		);
		const streamFn: StreamFn = async function* (model) {
			const builder = new MessageBuilder(model.provider, model.id);
			yield builder.start();
			yield builder.textStart(0);
			yield builder.textDelta(0, "<summary>half a summary, cut off");
			yield builder.aborted();
		};
		const manager = new CompactionManager(CONFIG, { streamFn, summarizerModel: SUMMARIZER, store });
		const messages: AgentMessage[] = [
			userMessage("do the thing"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];
		for (const message of messages) store.appendMessage(message);
		const controller = new AbortController();
		controller.abort();

		await expect(manager.compact({ systemPrompt: "sys", messages }, { signal: controller.signal })).rejects.toThrow(
			"interrupted",
		);
		expect(store.compactions()).toHaveLength(0);
		expect(manager.lastVerification()).toBeUndefined();
	});
});
