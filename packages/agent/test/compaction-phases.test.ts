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
		// Ending on a user turn, and it matters: the estimator anchors on the last
		// usage record, so a conversation that ends on the assistant turn keeps its
		// anchor inside the suffix a compaction retains — and then the size before
		// and the size after are the same number, whichever one the manager reports.
		// That shape is worth testing for its own sake, but not here: what this
		// fixture is for is telling the two apart.
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

/** A manager that writes its phases down as they arrive. */
function watcher(options: { streamFn?: StreamFn; store?: SessionStore } = {}) {
	const phases: CompactionPhase[] = [];
	const store = options.store;
	const streamFn =
		options.streamFn ?? fauxProvider([{ text: "1. Request: the thing", usage: { input: 10, output: 10 } }]).streamFn;
	return {
		phases,
		store,
		manager: new CompactionManager(CONFIG, {
			streamFn,
			summarizerModel: SUMMARIZER,
			store,
			onPhase: (phase) => phases.push(phase),
		}),
	};
}

describe("the three phases of a summarization", () => {
	test("start is said before the summary request is made, not after it returns", () => {
		// The whole reason the start exists: the call is the wait. Said afterwards
		// it would announce a wait that is already over, on the next frame.
		const seen: number[] = [];
		const harness = watcher({
			streamFn: ((model, context, streamOptions) => {
				seen.push(harness.phases.length);
				return fauxProvider([{ text: "1. Request: the thing", usage: { input: 10, output: 10 } }]).streamFn(
					model,
					context,
					streamOptions,
				);
			}) as StreamFn,
		});

		return harness.manager.compact(bigContext()).then(() => {
			expect(seen).toEqual([1]);
			expect(harness.phases[0]).toEqual({ kind: "start" });
		});
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

		expect(harness.phases.map((phase) => phase.kind)).toEqual(["start", "done"]);
		const done = harness.phases[1];
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
		expect(auto.phases[1]).toMatchObject({ kind: "done", trigger: "auto" });

		const manual = watcher();
		await manual.manager.compact(bigContext(), { trigger: "manual" });
		expect(manual.phases[1]).toMatchObject({ kind: "done", trigger: "manual" });

		const forced = watcher();
		await forced.manager.check(bigContext(), { force: true });
		expect(forced.phases[1]).toMatchObject({ kind: "done", trigger: "overflow" });
	});

	test("a summary that cannot be written ends the phase it started", async () => {
		// A status row that says "Compacting context…" for the rest of the session
		// is worse than no status row: the failure is the ending that has to
		// arrive, and the breaker that would otherwise be the only word on it
		// speaks two failures later.
		const harness = watcher({ streamFn: fauxProvider([{ throwError: new Error("provider down") }]).streamFn });

		await expect(harness.manager.compact(bigContext(), { trigger: "manual" })).rejects.toThrow("provider down");

		expect(harness.phases).toEqual([{ kind: "start" }, { kind: "failed", trigger: "manual" }]);
	});

	test("a check that decides nothing says nothing", async () => {
		// Asked before every request, and usually the answer is "not yet". A phase
		// per check would be a status row that blinks on every turn.
		const harness = watcher();

		expect(await harness.manager.check({ systemPrompt: "", messages: [userMessage("short")] })).toBeNull();
		expect(harness.phases).toEqual([]);
	});
});
