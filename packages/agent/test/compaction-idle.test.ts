/**
 * The pass a quiet session may buy before its prompt cache expires.
 *
 * The manager owns the two halves of that decision this file can see: whether
 * the context is large enough to be worth the summary, and what a pass with the
 * `idle` trigger does to the bookkeeping the automatic side runs on. The clock
 * and the cache reading belong to the host, which is why nothing here waits.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Context, Model } from "@labunbun/ai";
import { assistantMessage, FAUX_MODEL, fauxProvider, userMessage } from "@labunbun/ai";
import {
	CompactionManager,
	compactionThreshold,
	IDLE_SUMMARY_MIN_TOKENS,
	idleSummaryFloor,
} from "../src/compaction.ts";
import { SessionStore } from "../src/session-store.ts";

const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

const SUMMARIZER: Model = { ...FAUX_MODEL, id: "summarizer-1", apiKeyEnv: "FAUX_API_KEY" };

const SUMMARY_TEXT = "<summary>1. Request: x</summary>";

/** A conversation big enough for the floor: the estimator anchors on the usage. */
function largeContext(): Context {
	const messages: AgentMessage[] = [
		userMessage("do the thing"),
		assistantMessage({ usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		userMessage("and now this"),
	];
	return { systemPrompt: "", messages };
}

function makeManager(deps: Partial<ConstructorParameters<typeof CompactionManager>[1]> = {}): CompactionManager {
	const faux = fauxProvider([{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } }]);
	return new CompactionManager(CONFIG, { streamFn: faux.streamFn, summarizerModel: SUMMARIZER, ...deps });
}

describe("the floor an idle summary has to clear", () => {
	test("an ordinary window uses its own threshold", () => {
		// 100k window, 32k output (capped at 20k when reserved), 13k reserve: the
		// threshold is 67k, well under the absolute floor, so the line the session
		// would compact at is the line.
		expect(compactionThreshold(CONFIG)).toBe(67_000);
		expect(idleSummaryFloor(CONFIG)).toBe(67_000);
	});

	test("a very large window is floored at the absolute minimum", () => {
		// 1M window: the threshold sits near 955k, but a prefix of 250k is already
		// expensive on every cold request, and paying for it until the threshold is
		// reached is the cost this pass exists to avoid.
		const huge = { contextWindow: 1_000_000, maxOutputTokens: 32_000 };
		expect(compactionThreshold(huge)).toBeGreaterThan(IDLE_SUMMARY_MIN_TOKENS);
		expect(idleSummaryFloor(huge)).toBe(IDLE_SUMMARY_MIN_TOKENS);
	});
});

describe("whether an idle summary is worth buying", () => {
	test("a context under the floor is left alone", () => {
		const manager = makeManager();
		const small = { systemPrompt: "", messages: [userMessage("short")] };
		expect(manager.idleSummaryWorthwhile(small)).toBe(false);
	});

	test("a context at the floor is offered", () => {
		expect(makeManager().idleSummaryWorthwhile(largeContext())).toBe(true);
	});

	test("the automatic switch turns it off with the rest of the automatic side", () => {
		const manager = makeManager({});
		expect(manager.idleSummaryWorthwhile(largeContext())).toBe(true);
		const disabled = new CompactionManager(
			{ ...CONFIG, enabled: false },
			{
				streamFn: fauxProvider([{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } }]).streamFn,
				summarizerModel: SUMMARIZER,
			},
		);
		expect(disabled.idleSummaryWorthwhile(largeContext())).toBe(false);
	});

	test("its own switch turns it off without touching the others", () => {
		const off = new CompactionManager(
			{ ...CONFIG, idleSummary: false },
			{
				streamFn: fauxProvider([{ text: SUMMARY_TEXT, usage: { input: 10, output: 10 } }]).streamFn,
				summarizerModel: SUMMARIZER,
			},
		);
		expect(off.idleSummaryWorthwhile(largeContext())).toBe(false);
		expect(off.isDisabled).toBe(false);
	});

	test("a tripped breaker offers nothing, for the same reason automatic passes stop", async () => {
		const failing = new CompactionManager(CONFIG, {
			streamFn: fauxProvider([{ throwError: new Error("provider down") }]).streamFn,
			summarizerModel: SUMMARIZER,
		});
		for (let i = 0; i < 3; i++) {
			await expect(failing.compact({ systemPrompt: "", messages: [userMessage("x")] })).rejects.toThrow();
		}
		expect(failing.isTripped).toBe(true);
		expect(failing.idleSummaryWorthwhile(largeContext())).toBe(false);
	});
});

describe("an idle compaction's place in the refill bookkeeping", () => {
	async function checked(manager: CompactionManager, context: Context): Promise<void> {
		await manager.check(context);
	}

	/** A context that has walked back over the last summary, as the trip detects. */
	function refilledContext(): Context {
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

	test("an idle pass clears the run instead of counting as a refill", async () => {
		// The pass was bought to make the next request cheap, not to answer a
		// threshold the last summary failed to clear. Counting it would let a
		// session that merely sat quiet long enough switch its own automatic
		// compaction off — the opposite of what the pass is for.
		const manager = makeManager();
		// Four, not three: the first compaction after a manager is built is free —
		// the distance to any earlier pass is unknown, so only refills it watched
		// count.
		for (let i = 0; i < 4; i++) await checked(manager, refilledContext());
		expect(manager.isTripped).toBe(true);

		await manager.compact(refilledContext(), { trigger: "idle" });
		expect(manager.isTripped).toBe(false);
		expect(await manager.check(refilledContext())).not.toBeNull();
	});

	test("the session file records the trigger as idle", async () => {
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-idle-")),
			mkdtempSync(join(tmpdir(), "lbb-idle-home-")),
		);
		const manager = makeManager({ store });
		const context = largeContext();
		// Through the store, as a real turn is: the record names the tail it
		// stands in front of, and a tail the file has never seen is refused.
		for (const message of context.messages) store.appendMessage(message);

		await manager.compact(context, { trigger: "idle" });

		const marker = SessionStore.load(store.path).entries.find((entry) => entry.type === "compaction");
		if (marker?.type !== "compaction") throw new Error("expected a compaction record");
		expect(marker.trigger).toBe("idle");
	});
});
