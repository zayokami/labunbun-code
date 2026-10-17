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
import {
	COMPACTION_DISABLED_NOTICE,
	COMPACTION_REFILLING_NOTICE,
	type CompactionPhase,
	type CompactionTrigger,
	SessionStore,
	SUMMARY_SECTIONS,
} from "@labunbun/agent";
import {
	type AgentMessage,
	clearCustomModels,
	FAUX_MODEL,
	fauxProvider,
	type Model,
	registerOpenAICompatibleProvider,
	type StreamFn,
	textContent,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import {
	type CompactionTuning,
	compactionPhaseText,
	createCompactionWiring,
	resolveCompactionSummarizer,
} from "../src/compaction-wiring.ts";
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
	runPreCompact: (
		trigger: CompactionTrigger,
		customInstructions?: string,
	) => Promise<{ blocked: boolean; reason?: string }>;
	summaries: () => number;
	reducedClears: () => number;
	reports: string[];
	causes: string[];
}

function wiring(
	options: {
		model?: Model;
		trimOldToolResults?: boolean;
		streamFn?: StreamFn;
		preCompact?: (
			trigger: CompactionTrigger,
			customInstructions?: string,
		) => Promise<{ blocked: boolean; reason?: string }>;
		tuning?: CompactionTuning;
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
	let reducedClears = 0;
	const created = createCompactionWiring({
		model: options.model ?? MODEL,
		store: options.store,
		streamFn: counting,
		report: (text) => reports.push(text),
		trimOldToolResults: options.trimOldToolResults,
		preCompact: options.preCompact,
		tuning: options.tuning,
		noteRewrite: (cause) => causes.push(cause),
		onContextReduced: () => reducedClears++,
		onPhase: options.phases ? (phase) => options.phases?.push(phase) : undefined,
	});
	return {
		check: created.checkCompaction as Harness["check"],
		runPreCompact: created.runPreCompact,
		summaries: () => summaries,
		reducedClears: () => reducedClears,
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
		// Two declarations, because a summarized pass sends two kinds of request
		// that replace part of the prefix: the summary's own (declared before each
		// attempt, since mid-turn it arrives over a pulled-back prefix) and the one
		// after the rewrite. Each is consumed by the request it was made for.
		expect(summarized.causes).toEqual(["compaction", "compaction"]);
	});

	test("nothing over the threshold registers nothing", async () => {
		const harness = wiring();

		expect(await harness.check({ systemPrompt: "", messages: [userMessage("short")] })).toBeNull();
		expect(harness.causes).toEqual([]);
		expect(harness.reports).toEqual([]);
	});

	test("only the previews invalidate the read evidence; a summary and nothing do not", async () => {
		// The cheap rung replaces bytes the model was shown with previews, so what
		// Read recorded is no longer in its context. A full compaction is the other
		// event, but its clear belongs to each entry point's `done` phase: calling
		// this door there as well would clear twice and say nothing extra.
		const reduced = wiring();
		expect((await reduced.check({ systemPrompt: "", messages: overThreshold() }))?.action).toBe("reduced");
		expect(reduced.reducedClears()).toBe(1);

		const summarized = wiring({ trimOldToolResults: false });
		expect((await summarized.check({ systemPrompt: "", messages: overThreshold() }))?.action).toBe("compact");
		expect(summarized.reducedClears()).toBe(0);

		const untouched = wiring();
		expect(await untouched.check({ systemPrompt: "", messages: [userMessage("short")] })).toBeNull();
		expect(untouched.reducedClears()).toBe(0);
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

	test("a refill trip announces itself in the refill's own words", async () => {
		// The two trips look identical from outside — autocompact quietly stops —
		// and the notices must not share words: "failed 3 times" about three
		// summaries that worked is a false report, and the news is different (the
		// conversation, not the mechanism).
		const harness = wiring({ trimOldToolResults: false });

		// Each check brings a context that has filled back up: the shape a single
		// oversized read leaves behind, and the fourth such compaction trips it.
		for (let i = 0; i < 4; i++) await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(harness.summaries()).toBe(4);
		expect(harness.reports.filter((text) => text === COMPACTION_REFILLING_NOTICE)).toHaveLength(1);
		expect(harness.reports).not.toContain(COMPACTION_DISABLED_NOTICE);
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

		expect(harness.reports[0]).toBe(compactionPhaseText({ kind: "preparing" }));
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
			compactionPhaseText({ kind: "preparing" }),
			compactionPhaseText({ kind: "failed", trigger: "auto" }),
		]);
	});

	test("a summary that had to shrink before it fit says so, once per descent", async () => {
		// The descent rewrites the bytes the previous request left in the cache
		// and spends another full request, so it is the one mid-flight event worth
		// a line of its own: the wait got longer and the bill got bigger, and
		// neither is visible from the two lines that bracket the pass.
		let attempts = 0;
		const harness = wiring({
			trimOldToolResults: false,
			streamFn: (model, context, streamOptions) => {
				attempts++;
				if (attempts === 1) {
					return fauxProvider([
						{ stopReason: "error", errorMessage: "too long", errorKind: "context_overflow" },
					]).streamFn(model, context, streamOptions);
				}
				return fauxProvider([{ text: "<summary>1. Request: the files</summary>" }]).streamFn(
					model,
					context,
					streamOptions,
				);
			},
		});

		// Two rounds of old tool results with a second request between them, and a
		// final request that `keepSuffix` retains: the ladder's last rung drops
		// the oldest round, so the prefix has to hold one older than the round
		// that survives. Over the threshold either way.
		const messages: AgentMessage[] = [userMessage("read those files")];
		for (let i = 0; i < 3; i++) {
			messages.push(toolResultMessage(`call_a${i}`, "Read", [textContent("x".repeat(20_000))]));
		}
		messages.push(userMessage("and check these too"));
		for (let i = 0; i < 2; i++) {
			messages.push(toolResultMessage(`call_b${i}`, "Read", [textContent("x".repeat(20_000))]));
		}
		messages.push(userMessage("now summarize the findings"));

		await harness.check({ systemPrompt: "", messages });

		// Exactly one line per descent — the second attempt's own request phase —
		// between the opening line and the one that closes the pass.
		expect(harness.reports.slice(0, 2)).toEqual([
			compactionPhaseText({ kind: "preparing" }),
			compactionPhaseText({ kind: "summarizing", attempt: 2, mode: "requesting" }),
		]);
		// Four, not three: the fixture's reply carries a single header of the
		// eleven, so the pass ends with its ending line and the one warning the
		// receipt contributes to a stream.
		expect(harness.reports).toHaveLength(4);
		// The closing line's own shape is pinned by the test above; here it only
		// has to be the ending. It comes out small enough to lose the `k` suffix
		// — the oldest round is gone and the rest of the prefix was summarized —
		// which is why this pattern makes the suffix optional.
		expect(harness.reports[2]).toMatch(/^Context compacted \(auto\): [\d.]+k → [\d.]+k? tokens\.$/);
		expect(harness.reports[3]).toContain("Warning: the summary is missing");
	});

	test("a clean pass stays two lines; a reply missing its sections is news on the stream", async () => {
		// The receipt's counts belong to a transcript a REPL paints — here the
		// two-line shape is the contract. Its warnings are the exception: a `-p`
		// run that depended on a summary which quietly dropped the decisions or
		// the pending work should hear it while the run can still react, not
		// discover it in the next summary's account of this one.
		const complete = `<summary>${SUMMARY_SECTIONS.map((header) => `${header}:\n[content]`).join("\n")}</summary>`;
		const clean = wiring({
			trimOldToolResults: false,
			streamFn: fauxProvider([{ text: complete }]).streamFn,
		});
		await clean.check({ systemPrompt: "", messages: overThreshold() });
		expect(clean.reports).toHaveLength(2);
		expect(clean.reports[1]).toMatch(/^Context compacted \(auto\): [\d.]+k → [\d.]+k? tokens\.$/);

		const lossy = wiring({ trimOldToolResults: false });
		await lossy.check({ systemPrompt: "", messages: overThreshold() });
		expect(lossy.reports).toHaveLength(3);
		expect(lossy.reports[2]).toContain("Warning: the summary is missing 11 of 11 sections");
	});

	test("an app with its own place for them gets the phases instead of the text", async () => {
		// The REPL paints a status row rather than pushing two lines into the
		// transcript, and the same event must not be reported twice when it does.
		const phases: CompactionPhase[] = [];
		const harness = wiring({ trimOldToolResults: false, phases });

		await harness.check({ systemPrompt: "", messages: overThreshold() });

		expect(phases.map((phase) => phase.kind)).toEqual([
			"preparing",
			"summarizing",
			"summarizing",
			"validating",
			"resuming",
			"done",
		]);
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
		// The report of what happened, and nothing about a count: the two lines
		// of the pass, plus the fixture reply's missing-sections warning — which
		// is the kind of news even a storeless run is owed.
		expect(harness.reports).toHaveLength(3);
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

describe("the compaction tuning", () => {
	test("a configured percent is the trigger line the manager acts on", () => {
		// The default on this window is the 60% floor — 24k — because the reserves
		// outweigh it. The configured line replaces that arithmetic, and the number
		// read here is the manager's own: `/context` asks it rather than
		// recomputing, so this is the line the user will see there.
		const created = createCompactionWiring({
			model: MODEL,
			store: undefined,
			streamFn: fauxProvider([{ text: "x" }]).streamFn,
			report: () => {},
			tuning: { thresholdPercent: 50 },
		});

		expect(created.manager().limits().threshold).toBe(20_000);
	});

	test("a configured reserve replaces the default in the formula", () => {
		// 40k − 8k − 5k is 27k — above the floor, where the default 13k reserve
		// would have left the floor in charge at 24k.
		const created = createCompactionWiring({
			model: MODEL,
			store: undefined,
			streamFn: fauxProvider([{ text: "x" }]).streamFn,
			report: () => {},
			tuning: { reserveTokens: 5_000 },
		});

		expect(created.manager().limits().threshold).toBe(27_000);
	});

	test("a configured summarizer writes the summary, and a rebuild cannot move it", async () => {
		// Who answers and who summarizes come apart: `/model` rebuilding the wiring
		// is a change of the former, and the user's choice of summarizer outlives
		// it.
		const seen: string[] = [];
		const summarizer: Model = { ...FAUX_MODEL, id: "faux-summarizer" };
		const streamFn: StreamFn = async function* (model, context, streamOptions) {
			seen.push(model.id);
			yield* fauxProvider([{ text: "<summary>1. Request: the files</summary>" }]).streamFn(
				model,
				context,
				streamOptions,
			);
		};
		const created = createCompactionWiring({
			model: MODEL,
			store: undefined,
			streamFn,
			report: () => {},
			trimOldToolResults: false,
			tuning: { summarizerModel: summarizer },
		});
		created.rebuild({ ...MODEL, id: "faux-after-swap" }, undefined);

		await created.checkCompaction({ systemPrompt: "", messages: overThreshold() });

		expect(seen).toEqual(["faux-summarizer"]);
	});
});

describe("resolveCompactionSummarizer", () => {
	test("no ref is nothing to resolve, and nothing to say", async () => {
		let refreshes = 0;
		const result = await resolveCompactionSummarizer(undefined, async () => {
			refreshes++;
		});

		expect(result).toEqual({});
		expect(refreshes).toBe(0);
	});

	test("an unknown ref asks for one refresh, then falls back with a line", async () => {
		// The refresh is the host's second look — a ref the table does not know may
		// be one a provider is about to name — and one look is enough: a listing
		// that did not name it a moment ago will not name it now.
		let refreshes = 0;
		const result = await resolveCompactionSummarizer("no-such/provider-model", async () => {
			refreshes++;
		});

		expect(refreshes).toBe(1);
		expect(result.model).toBeUndefined();
		expect(result.warning).toContain('unknown compaction model "no-such/provider-model"');
	});

	test("the second look's answer is used, not the first miss", async () => {
		// What the callback is for: a ref only a provider's answer can name — the
		// local daemon's loadout — resolves on the retry after the refresh. The
		// provider appears during the refresh, which is the ordering the daemon has.
		const before = process.env.LBB_TUNING_LATE_KEY;
		process.env.LBB_TUNING_LATE_KEY = "test-key";
		try {
			const result = await resolveCompactionSummarizer("tuning-late/m1", async () => {
				registerOpenAICompatibleProvider({
					id: "tuning-late",
					baseUrl: "https://tuning-late.invalid/v1",
					apiKeyEnv: "LBB_TUNING_LATE_KEY",
					models: [{ id: "m1", contextWindow: 128_000, maxOutputTokens: 8_192 }],
				});
			});

			expect(result.model?.id).toBe("m1");
			expect(result.warning).toBeUndefined();
		} finally {
			if (before === undefined) delete process.env.LBB_TUNING_LATE_KEY;
			else process.env.LBB_TUNING_LATE_KEY = before;
			clearCustomModels();
		}
	});

	test("a model whose key is missing falls back naming the key", async () => {
		// Registered under a variable nothing sets: the closest reachable stand-in
		// for a machine that configured a cloud summarizer and did not export its
		// key — on a developer machine, the catalog's real variables may be set.
		registerOpenAICompatibleProvider({
			id: "tuning-missing",
			baseUrl: "https://tuning-missing.invalid/v1",
			apiKeyEnv: "LBB_TUNING_TEST_MISSING_KEY",
			models: [{ id: "m1", contextWindow: 128_000, maxOutputTokens: 8_192 }],
		});
		try {
			const result = await resolveCompactionSummarizer("tuning-missing/m1", async () => {});

			expect(result.model).toBeUndefined();
			expect(result.warning).toContain("LBB_TUNING_TEST_MISSING_KEY");
		} finally {
			clearCustomModels();
		}
	});
});

describe("the doors the session opens itself", () => {
	test("the manual ask is the same hook, one door out, with the focus argument", async () => {
		// `/compact` runs its summary through the manager directly, so the veto the
		// automatic pass honors inside `checkCompaction` has to be askable from
		// outside — one hook, one payload shape, and the focus argument the
		// automatic passes never have.
		const seen: Array<[string, string | undefined]> = [];
		const harness = wiring({
			preCompact: async (trigger, customInstructions) => {
				seen.push([trigger, customInstructions]);
				return { blocked: true, reason: "mid-edit" };
			},
		});

		const veto = await harness.runPreCompact("manual", "keep the migration details");

		expect(veto).toEqual({ blocked: true, reason: "mid-edit" });
		expect(seen).toEqual([["manual", "keep the migration details"]]);
		// A session with no hook at all is an open door, not a closed one.
		expect(await wiring().runPreCompact("manual")).toEqual({ blocked: false });
	});

	test("the switch reaches the manager this wiring builds, and only the automatic side hears it", async () => {
		// The setting has to land in the config `build` makes — this wiring is where
		// the host hands it over — and only the passes the app starts itself may
		// stop: a refused request still has to be recoverable, so a forced pass
		// runs with the switch off. The cheap rung is off so the forced pass's one
		// remaining answer is the summary; with it on, the trim would legitimately
		// answer first and this test would be about the rung order instead.
		const harness = wiring({ trimOldToolResults: false, tuning: { enabled: false } });

		expect(await harness.check({ systemPrompt: "", messages: overThreshold() })).toBeNull();
		expect(harness.summaries()).toBe(0);

		const forced = await harness.check({ systemPrompt: "", messages: overThreshold() }, { force: true });
		expect(forced?.action).toBe("compact");
		expect(harness.summaries()).toBe(1);
	});
});

/** A window big enough that idle-trimmable old results sit far below the threshold. */
const BIG_MODEL: Model = { ...FAUX_MODEL, contextWindow: 400_000, maxOutputTokens: 32_000 };

/** Eight old results at 30k characters: ~60k tokens, and the oldest three over the idle floor. */
function idleContext(): AgentMessage[] {
	const messages: AgentMessage[] = [userMessage("read those files")];
	for (let i = 0; i < 8; i++) messages.push(toolResultMessage(`call_${i}`, "Read", [textContent("x".repeat(30_000))]));
	return messages;
}

describe("the idle rung's clock", () => {
	test("an hour between checks turns old results into previews, without a model call", async () => {
		// The clock is the wiring's, not the manager's — the manager only receives
		// the number — so it is faked here: what is under test is what the wiring
		// does with a gap. The gap's own threshold is a manager constant, pinned in
		// the manager's tests, where an hour is a number rather than a wait.
		const realNow = Date.now;
		let fake = 1_800_000_000_000;
		Date.now = () => fake;
		try {
			const harness = wiring({ model: BIG_MODEL, trimOldToolResults: true });
			const context = { systemPrompt: "", messages: idleContext() };

			// A fresh session is not idle, however old its tool results are.
			expect(await harness.check(context)).toBeNull();

			fake += 3_600_000;
			const decision = await harness.check(context);

			expect(decision?.action).toBe("reduced");
			expect(harness.summaries()).toBe(0);
			expect(harness.reports.join("\n")).toContain("Context trimmed");
		} finally {
			Date.now = realNow;
		}
	});
});
