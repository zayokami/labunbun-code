/**
 * The one answer to "does this context need to be made smaller first?", as the
 * three entry points (REPL, `-p`, subagent) all get it.
 *
 * Tested here rather than through any of them because the wiring *is* the shared
 * part: the rung order, the cache registration and the notices are decisions
 * this module makes once, and a test that reached them through the REPL would be
 * asserting the REPL as well.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_DISABLED_NOTICE, type CompactionPhase, SessionStore } from "@labunbun/agent";
import {
	type AgentMessage,
	FAUX_MODEL,
	fauxProvider,
	type Model,
	type StreamFn,
	textContent,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import { compactionPhaseText, createCompactionWiring } from "../src/compaction-wiring.ts";
import { ACCURACY_NOTICE_AFTER_COMPACTIONS, COMPACTION_ACCURACY_NOTICE } from "../src/context-report.ts";

/** A window small enough to reach the threshold with a handful of tool results. */
const MODEL: Model = { ...FAUX_MODEL, contextWindow: 40_000, maxOutputTokens: 8_000 };
/**
 * 40k − 8k − 13k is 19k, which is under 60% of this window, so the floor applies
 * and the threshold is 24k. At this size the reserves are most of the window,
 * and the formula's own answer would fire on a conversation that has barely
 * started.
 */
const THRESHOLD = 24_000;

/** Five old tool results of 5k tokens each: 25k, over the threshold, and trimmable. */
function overThreshold(): AgentMessage[] {
	const messages: AgentMessage[] = [userMessage("read those files")];
	for (let i = 0; i < 5; i++) {
		messages.push(toolResultMessage(`call_${i}`, "Read", [textContent("x".repeat(20_000))]));
	}
	return messages;
}

/** A summarizer that cannot be reached at all. */
function failingStream(): StreamFn {
	return fauxProvider([{ throwError: new Error("provider down") }]).streamFn;
}

interface Harness {
	check: (
		context: { systemPrompt: string; messages: AgentMessage[] },
		options?: { force?: boolean },
	) => Promise<{ action: string } | null>;
	summaries: () => number;
	reports: string[];
	causes: string[];
}

function wiring(
	options: {
		trimOldToolResults?: boolean;
		streamFn?: StreamFn;
		preCompact?: () => Promise<{ blocked: boolean; reason?: string }>;
		store?: SessionStore;
		phases?: CompactionPhase[];
	} = {},
): Harness {
	let summaries = 0;
	const counting: StreamFn = async function* (model, context, streamOptions) {
		summaries++;
		if (options.streamFn) {
			yield* options.streamFn(model, context, streamOptions);
			return;
		}
		yield* fauxProvider([{ text: "<summary>1. Request: the files</summary>" }]).streamFn(model, context, streamOptions);
	};
	const reports: string[] = [];
	const causes: string[] = [];
	const created = createCompactionWiring({
		model: MODEL,
		store: options.store,
		streamFn: counting,
		report: (text) => reports.push(text),
		trimOldToolResults: options.trimOldToolResults,
		preCompact: options.preCompact,
		noteRewrite: (cause) => causes.push(cause),
		onPhase: options.phases ? (phase) => options.phases?.push(phase) : undefined,
	});
	return {
		check: created.checkCompaction as Harness["check"],
		summaries: () => summaries,
		reports,
		causes,
	};
}

/** A session file in a throwaway project directory and home — never the real one. */
function newStore(): SessionStore {
	return SessionStore.startNew(
		mkdtempSync(join(tmpdir(), "lbb-wiring-")),
		mkdtempSync(join(tmpdir(), "lbb-wiring-home-")),
	);
}

/** A store whose file already holds `count` compactions, as a resumed one would. */
function storeWithCompactions(count: number): SessionStore {
	const store = newStore();
	for (let round = 0; round < count; round++) {
		const tail = [userMessage(`earlier request ${round}`)];
		for (const message of tail) store.appendMessage(message);
		store.appendCompaction({
			boundary: userMessage(`[boundary ${round}]`),
			suffix: tail,
			summary: "1. Request: something earlier",
			preservedFiles: [],
			preTokens: 50_000,
			postTokens: 5_000,
			model: "faux-1",
			trigger: "auto",
		});
	}
	return store;
}

describe("which rung runs at the threshold", () => {
	test("previews first, by default, and no model call to get them", async () => {
		// The rung only ever runs where the alternative is a summarization, so the
		// default is that it runs: one is a rewrite of text the model has already
		// read, the other is a full-price request that may fail.
		const harness = wiring();

		const decision = await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(decision?.action).toBe("reduced");
		expect(harness.summaries()).toBe(0);
		expect(harness.reports.join("\n")).toContain("old tool results replaced by previews");
	});

	test("a settings value of false goes straight to the summary", async () => {
		// The other side of the same default, so the option is known to be read
		// rather than ignored: someone who wants their tool results left alone gets
		// the summary instead of previews.
		const harness = wiring({ trimOldToolResults: false });

		const decision = await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(decision?.action).toBe("compact");
		expect(harness.summaries()).toBe(1);
	});

	test("the rung that runs is the one registered with the cache report", async () => {
		// Both replace part of the prefix, and from the wire they are the same
		// rewrite. Only the wiring knows which happened, so an unregistered one is
		// reported as a rewrite nothing declared — the shape of a bug.
		const trimmed = wiring();
		await trimmed.check({ systemPrompt: "", messages: overThreshold() });
		expect(trimmed.causes).toEqual(["trim"]);

		const summarized = wiring({ trimOldToolResults: false });
		await summarized.check({ systemPrompt: "", messages: overThreshold() });
		expect(summarized.causes).toEqual(["compaction"]);
	});

	test("nothing over the threshold registers nothing", async () => {
		const harness = wiring();

		expect(await harness.check({ systemPrompt: "", messages: [userMessage("short")] })).toBeNull();
		expect(harness.causes).toEqual([]);
		expect(harness.reports).toEqual([]);
	});
});

describe("what the wiring says", () => {
	test("the breaker announces itself once, not once per turn", async () => {
		// Silent, a tripped breaker looks like a session that stopped managing its
		// context. Repeated every turn, it is noise the user learns to skip past —
		// and the notice has to be read once, when it happens.
		const harness = wiring({
			trimOldToolResults: false,
			streamFn: failingStream(),
		});
		const context = { systemPrompt: "", messages: overThreshold() };

		for (let i = 0; i < 3; i++) await harness.check(context);
		expect(harness.reports.filter((text) => text === COMPACTION_DISABLED_NOTICE)).toHaveLength(1);
		await harness.check(context);
		expect(harness.reports.filter((text) => text === COMPACTION_DISABLED_NOTICE)).toHaveLength(1);
	});

	test("a summarizer that cannot be sent is not the session's problem", async () => {
		// `check` is consulted before every request. A rejection here would end the
		// turn with the summarizer's own error, which says nothing about whether the
		// request fits — it may well.
		const harness = wiring({ trimOldToolResults: false, streamFn: failingStream() });

		expect(await harness.check({ systemPrompt: "", messages: overThreshold() })).toBeNull();
	});

	test("a PreCompact veto defers an estimate, never a refusal", async () => {
		// A hook may say "not this turn" about a threshold the estimate computed. It
		// may not defer a pass the provider already refused: the next request would
		// be the same request, and sending it unchanged is the failure.
		const harness = wiring({ preCompact: async () => ({ blocked: true, reason: "mid-edit" }) });
		const context = { systemPrompt: "", messages: overThreshold() };

		expect(await harness.check(context)).toBeNull();
		expect(harness.reports.join("\n")).toContain("Compaction skipped by PreCompact hook: mid-edit");

		const forced = await harness.check(context, { force: true });
		expect(forced?.action).toBe("blocked");
		expect(harness.summaries()).toBe(0);
	});
});

describe("what a compaction says while it runs", () => {
	test("two lines, in the order the wait takes: the call, then what it bought", async () => {
		// A summary is a full-prefix request that can take half a minute. On stderr
		// the first line is what keeps a `-p` run's silence from reading as a hang;
		// the second is the number that says whether the pause was worth it.
		const harness = wiring({ trimOldToolResults: false });

		await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(harness.reports[0]).toBe(compactionPhaseText({ kind: "start" }));
		expect(harness.reports[1]).toMatch(/^Context compacted \(auto\): [\d.]+k → [\d.]+k tokens\.$/);
		// And in the order the phrase means — what it was, then what it became. The
		// fixture compacts a context of old tool results into a summary, so it got
		// smaller; a line that read "21.0k → 25.0k" would be reporting a compaction
		// that made the context bigger, at the one moment the user is deciding
		// whether the pause bought anything.
		const [before, after] = [...(harness.reports[1] ?? "").matchAll(/([\d.]+)k/g)].map((match) => Number(match[1]));
		expect(before).toBeGreaterThan(after ?? Number.POSITIVE_INFINITY);
	});

	test("a summary that cannot be written says so, rather than leaving the wait hanging", async () => {
		// The breaker is the other place this failure could be heard, and it speaks
		// two failures later — by which time the start line has been on screen for
		// a while with nothing after it.
		const harness = wiring({ trimOldToolResults: false, streamFn: failingStream() });

		expect(await harness.check({ systemPrompt: "", messages: overThreshold() })).toBeNull();

		expect(harness.reports).toEqual([
			compactionPhaseText({ kind: "start" }),
			compactionPhaseText({ kind: "failed", trigger: "auto" }),
		]);
	});

	test("an app with its own place for them gets the phases instead of the text", async () => {
		// The REPL paints a status row rather than pushing two lines into the
		// transcript, and the same event must not be reported twice when it does.
		const phases: CompactionPhase[] = [];
		const harness = wiring({ trimOldToolResults: false, phases });

		await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(phases.map((phase) => phase.kind)).toEqual(["start", "done"]);
		expect(harness.reports).toEqual([]);
	});
});

describe("the warning about compacting too often", () => {
	test("waits for the third compaction, not the tenth", () => {
		// Every other assertion about this warning is relative to the constant — it
		// seeds one less and checks the next pass — so a threshold that drifted to
		// ten would pass all of them and warn nobody. Three comes from the reference
		// implementation, and two is a session that has compacted once and is fine.
		expect(ACCURACY_NOTICE_AFTER_COMPACTIONS).toBe(3);
	});

	test("arrives on the pass that reaches the number, and not before it", async () => {
		// Two summaries the file already holds, then one more: the third is where a
		// conversation has stopped being a conversation. Warned one pass earlier it
		// would fire on healthy sessions; never, and the advice arrives only when
		// the user has already lost the thread.
		const store = storeWithCompactions(ACCURACY_NOTICE_AFTER_COMPACTIONS - 1);
		const harness = wiring({ trimOldToolResults: false, store });
		let live: AgentMessage[] = [...store.contextMessages()];
		const notices = () => harness.reports.filter((text) => text === COMPACTION_ACCURACY_NOTICE).length;

		for (let round = 0; round < 2; round++) {
			const turn = overThreshold();
			for (const message of turn) store.appendMessage(message);
			live = [...live, ...turn];
			expect((await harness.check({ systemPrompt: "", messages: live }))?.action).toBe("compact");
			live = [...store.contextMessages()];
			// On the first pass — the third summary — and never again: the warning is
			// about a session that has reached this point, not about each pass.
			expect(notices()).toBe(1);
		}
	});

	test("a session with no store to count is not warned", async () => {
		// A subagent has no session file, so it has no history to be warned about —
		// and a count of zero is not a count that reached three. What it still gets
		// is the report of what happened, which is the part it does have.
		const harness = wiring({ trimOldToolResults: false });

		await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(harness.reports).not.toContain(COMPACTION_ACCURACY_NOTICE);
		expect(harness.reports).toHaveLength(2);
	});
});

describe("the threshold the wiring acts on", () => {
	test("is the manager's own number, from the model it was built for", () => {
		const created = createCompactionWiring({
			model: MODEL,
			store: undefined,
			streamFn: fauxProvider([{ text: "x" }]).streamFn,
			report: () => {},
		});

		expect(created.manager().limits()).toMatchObject({ contextWindow: 40_000, threshold: THRESHOLD });
	});

	test("follows the model when the session changes models", () => {
		// `/model` swaps the window mid-session. A manager left on the old one
		// compacts at the wrong size — too early for a bigger window, and never for
		// a smaller one.
		const created = createCompactionWiring({
			model: MODEL,
			store: undefined,
			streamFn: fauxProvider([{ text: "x" }]).streamFn,
			report: () => {},
		});

		created.rebuild({ ...FAUX_MODEL, contextWindow: 200_000, maxOutputTokens: 8_192 }, undefined);

		expect(created.manager().limits()).toMatchObject({ contextWindow: 200_000, threshold: 178_808 });
	});
});
