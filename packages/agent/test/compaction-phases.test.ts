/**
 * What a summarization says while it runs, and how it ends.
 *
 * A compaction is the one thing a session does that a user cannot see: a
 * full-prefix model call that takes as long as a turn, followed by a transcript
 * whose shape has changed with nothing on screen saying why. The phase callback
 * is what the app around it paints — the status row while the call is in
 * flight, the line that outlives it, and the failure that would otherwise only
 * be visible once the breaker had counted to three.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Context, Model, StreamFn } from "@labunbun/ai";
import { assistantMessage, FAUX_MODEL, fauxProvider, userMessage } from "@labunbun/ai";
import { CompactionManager, type CompactionPhase, estimateContextUsage } from "../src/compaction.ts";
import { SessionStore } from "../src/session-store.ts";

const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

/** A real registry entry with a credential, as the summarizer must be. */
const SUMMARIZER: Model = { ...FAUX_MODEL, id: "summarizer-1", apiKeyEnv: "FAUX_API_KEY" };

/** A conversation over the threshold, in the shape the estimator anchors on. */
function bigContext(): Context {
	const messages: AgentMessage[] = [
		userMessage("do the thing"),
		assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		// Ending on a user turn, and it still matters: the estimator anchors on the
		// last usage record, so keeping that record inside the prefix the summary
		// replaces is the shortest way to make the size before and the size after
		// two different numbers. (A conversation that ends on the assistant turn
		// keeps the record inside the retained suffix instead — the estimator
		// passes such records over, and that shape has its own test below rather
		// than being smuggled into this fixture.)
		userMessage("and now this"),
	];
	return { systemPrompt: "", messages };
}

function newStore(): SessionStore {
	return SessionStore.startNew(
		mkdtempSync(join(tmpdir(), "lbb-phase-")),
		mkdtempSync(join(tmpdir(), "lbb-phase-home-")),
	);
}

/** The line the default double writes, as the summary that gets adopted. */
const SUMMARY_TEXT = "1. Request: the thing";

/** A manager that writes its phases down as they arrive. */
function watcher(options: { streamFn?: StreamFn; store?: SessionStore } = {}) {
	const phases: CompactionPhase[] = [];
	const store = options.store;
	const streamFn =
		options.streamFn ?? fauxProvider([{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } }]).streamFn;
	return {
		phases,
		store,
		manager: new CompactionManager(CONFIG, {
			streamFn,
			summarizerModel: SUMMARIZER,
			store,
			onPhase: (phase) => {
				phases.push(phase);
			},
		}),
	};
}

describe("the phases of a summarization", () => {
	test("the opening phases are said before the summary request is made, not after it returns", async () => {
		// The whole reason they exist: the call is the wait. Said afterwards they
		// would announce a wait that is already over, on the next frame.
		const seen: number[] = [];
		const harness = watcher({
			streamFn: ((model, context, streamOptions) => {
				seen.push(harness.phases.length);
				return fauxProvider([{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } }]).streamFn(
					model,
					context,
					streamOptions,
				);
			}) as StreamFn,
		});

		await harness.manager.compact(bigContext());

		// Preparing the pass, and the attempt about to go out: both said, and
		// nothing that could only be known after the call came back.
		expect(seen).toEqual([2]);
		expect(harness.phases[0]).toEqual({ kind: "preparing" });
		expect(harness.phases[1]).toEqual({ kind: "summarizing", attempt: 1, mode: "requesting" });
	});

	test("a reply that comes back walks the rest of the lifecycle, in order", async () => {
		// The sequence is the state machine a status row paints: the attempt flips
		// from requesting to responding on its first bytes, the reply is announced
		// as the summary that would be kept, and the pass says it is rebuilding
		// the transcript before it ends. The wait breaks into its two halves —
		// accepted request, streaming reply — and a caller sees which half it is in.
		const harness = watcher();

		await harness.manager.compact(bigContext());

		expect(harness.phases.map((phase) => phase.kind)).toEqual([
			"preparing",
			"summarizing",
			"summarizing",
			"validating",
			"resuming",
			"done",
		]);
		expect(harness.phases[2]).toEqual({ kind: "summarizing", attempt: 1, mode: "responding" });
		expect(harness.phases[3]).toEqual({ kind: "validating", summaryChars: SUMMARY_TEXT.length });
	});

	test("each attempt on the ladder is numbered, and only the failed one skips its flip", async () => {
		// The provider refusing the full transcript for size is the one refusal the
		// summary request is built to survive: the ladder sends less. The phase
		// carries which rung is in flight, because a retry is otherwise
		// indistinguishable from the first attempt at the moment it goes out — and
		// a retry is the expensive one: the bytes changed, so the cache is gone.
		const harness = watcher({
			streamFn: fauxProvider([
				{ stopReason: "error", errorMessage: "too long", errorKind: "context_overflow" },
				{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } },
			]).streamFn,
		});
		// Two rounds above the retained suffix, because the ladder's last rung
		// drops one: a refused first attempt over a single round would have
		// nothing older to give up, and the summary would fail for that reason
		// instead of descending. (The suffix `keepSuffix` retains is the last
		// user message; the two rounds before it are the ladder's to spend.)
		const messages: AgentMessage[] = [
			userMessage("do the thing"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("keep going"),
			assistantMessage({ usage: { input: 95_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("and now this"),
		];

		await harness.manager.compact({ systemPrompt: "", messages });

		// The refused attempt said requesting and nothing else — there were no
		// reply bytes to flip it — and the second attempt flipped.
		expect(harness.phases.filter((phase) => phase.kind === "summarizing")).toEqual([
			{ kind: "summarizing", attempt: 1, mode: "requesting" },
			{ kind: "summarizing", attempt: 2, mode: "requesting" },
			{ kind: "summarizing", attempt: 2, mode: "responding" },
		]);
		expect(harness.phases.at(-1)).toMatchObject({ kind: "done" });
	});

	test("done carries the sizes it moved the context between, and the reason", async () => {
		const store = newStore();
		const harness = watcher({ store });
		const context = bigContext();
		const before = estimateContextUsage(context);
		// The store is the session's transcript, so the live messages have to be in
		// it — `appendCompaction` refuses a suffix that is not its trailing history.
		for (const message of context.messages) store.appendMessage(message);

		await harness.manager.compact(context);

		expect(harness.phases.map((phase) => phase.kind)).toEqual([
			"preparing",
			"summarizing",
			"summarizing",
			"validating",
			"resuming",
			"done",
		]);
		const done = harness.phases.at(-1);
		if (done?.kind !== "done") throw new Error("expected a done phase");
		expect(done.preTokens).toBe(before);
		// The numbers have to be able to differ, or the check below says nothing:
		// this fixture is built so the anchor the estimator uses is part of the
		// prefix the summary replaces. Asserted here rather than left to the shape
		// of the array, because a fixture that quietly stopped distinguishing them
		// would leave a green test that compares a number to itself.
		expect(done.preTokens).toBeGreaterThan(done.postTokens ?? Number.POSITIVE_INFINITY);
		// The number reported is the number recorded: a card and a session file
		// that disagree about how big the context was are both wrong.
		expect(done.postTokens).toBe(store.compactions()[0]?.postTokens);
		expect(done.trigger).toBe("auto");
	});

	test("a retained anchor does not erase the reduction the done phase reports", async () => {
		// The assistant-tail shape: the transcript ends on the reply, so keepSuffix
		// retains it — and the usage record it carries — below the new boundary.
		// That record measured the request that carried the whole old conversation,
		// and an estimate fixing on it reports ninety-five thousand tokens for a
		// transcript that is now a summary and two messages: pre and post come out
		// equal, and the phase says a summarization moved nothing.
		const store = newStore();
		const harness = watcher({ store });
		const messages: AgentMessage[] = [
			userMessage("do the thing"),
			assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("and now this"),
			assistantMessage({ usage: { input: 95_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];
		for (const message of messages) store.appendMessage(message);

		await harness.manager.compact({ systemPrompt: "", messages });

		const done = harness.phases.at(-1);
		if (done?.kind !== "done") throw new Error("expected a done phase");
		expect(done.preTokens).toBeGreaterThan(done.postTokens ?? Number.POSITIVE_INFINITY);
	});

	/**
	 * The three callers, named in the record and in the report.
	 *
	 * `overflow` is the one worth pinning: it is derived from `force`, which has
	 * exactly one production producer — the provider answering `context_overflow`
	 * — and a session file that called that "auto" would not say why the
	 * transcript changed shape in the middle of a turn.
	 */
	test("the threshold says auto, /compact says manual, a refusal says overflow", async () => {
		const auto = watcher();
		await auto.manager.compact(bigContext());
		expect(auto.phases.at(-1)).toMatchObject({ kind: "done", trigger: "auto" });

		const manual = watcher();
		await manual.manager.compact(bigContext(), { trigger: "manual" });
		expect(manual.phases.at(-1)).toMatchObject({ kind: "done", trigger: "manual" });

		const forced = watcher();
		await forced.manager.check(bigContext(), { force: true });
		expect(forced.phases.at(-1)).toMatchObject({ kind: "done", trigger: "overflow" });
	});

	test("a summary that cannot be written ends the phase it started", async () => {
		// A status row that says "Compacting context…" for the rest of the session
		// is worse than no status row: the failure is the ending that has to
		// arrive, and the breaker that would otherwise be the only word on it
		// speaks two failures later.
		const harness = watcher({ streamFn: fauxProvider([{ throwError: new Error("provider down") }]).streamFn });

		await expect(harness.manager.compact(bigContext(), { trigger: "manual" })).rejects.toThrow("provider down");

		// The attempt had gone out before it failed — the phase says so — and the
		// ending still arrives: the row's word ends here, not at the next restart.
		expect(harness.phases).toEqual([
			{ kind: "preparing" },
			{ kind: "summarizing", attempt: 1, mode: "requesting" },
			{ kind: "failed", trigger: "manual" },
		]);
	});

	test("a reply that came back empty is validated as nothing, and then fails", async () => {
		// The one failure that arrives without an error: the model answered, the
		// stream ended, and the answer cannot replace a transcript. The validating
		// phase is where that reply is announced — with nothing to keep, which is
		// what the failure is about — so a watcher can tell "the reply was empty"
		// apart from "the reply never came". Even here the ending arrives; a row
		// left saying "Summarizing…" is the one thing this reporting must not do.
		const harness = watcher({ streamFn: fauxProvider([{ text: "", usage: { input: 10, output: 1 } }]).streamFn });

		await expect(harness.manager.compact(bigContext())).rejects.toThrow("empty summary");

		expect(harness.phases).toEqual([
			{ kind: "preparing" },
			{ kind: "summarizing", attempt: 1, mode: "requesting" },
			{ kind: "validating", summaryChars: 0 },
			{ kind: "failed", trigger: "auto" },
		]);
	});

	test("a check that decides nothing says nothing", async () => {
		// Asked before every request, and usually the answer is "not yet". A phase
		// per check would be a status row that blinks on every turn.
		const harness = watcher();

		expect(await harness.manager.check({ systemPrompt: "", messages: [userMessage("short")] })).toBeNull();
		expect(harness.phases).toEqual([]);
	});
});
