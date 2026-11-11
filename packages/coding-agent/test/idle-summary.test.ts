/**
 * The idle summary's timing: when it arms, when it fires, and what cancels it.
 *
 * Every dependency is injected, so these tests drive the clock by hand and never
 * wait for a real cache tier. What is being proved is the decision — a pass only
 * inside the lead window before an entry the provider actually reported, only
 * when the prefix is worth the call and the caller is allowed to spend — and
 * the two ways it is stopped: a turn arriving, and the session ending.
 */
import { describe, expect, test } from "bun:test";
import type { CompactionManager } from "@labunbun/agent";
import {
	assistantMessage,
	CACHE_TTL_MS,
	type CacheNotice,
	type CachePolicy,
	type CacheRequestRecord,
	type Context,
	hash64,
	type Model,
	prefixIdentity,
	userMessage,
} from "@labunbun/ai";
import {
	createIdleSummary,
	IDLE_SUMMARY_LEAD_MS,
	IDLE_SUMMARY_TICK_MS,
	type IdleSummaryDeps,
} from "../src/idle-summary.ts";

/** A wire that lets the caller pick a TTL, so an expiry can be named. */
const MODEL: Model = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	reasoning: true,
};

/** A wire whose cache is automatic and whose lifetime is not reported. */
const AUTOMATIC_WIRE: Model = {
	...MODEL,
	id: "gpt-5",
	api: "openai-completions",
	provider: "openai",
	apiKeyEnv: "OPENAI_API_KEY",
};

const CONTEXT: Context = {
	systemPrompt: "sys",
	messages: [
		userMessage("hello"),
		assistantMessage({ usage: { input: 150_000, output: 10, cacheRead: 0, cacheWrite: 0 } }),
	],
};

const AT = 1_000_000;
const HOUR = CACHE_TTL_MS["1h"];
/** The first instant inside the lead window for a one-hour entry. */
const FIRE_AT = AT + HOUR - IDLE_SUMMARY_LEAD_MS;

function recordFor(model: Model, context: Context, at: number): CacheRequestRecord {
	return {
		family: hash64(prefixIdentity(model, context)),
		familyLabel: `${model.provider}/${model.id}`,
		turn: 1,
		at,
		kind: "first",
		causes: [],
		cacheRead: 1_000,
		cacheWrite: 1_000,
		cacheWriteTtl: { "5m": 0, "1h": 1_000 },
		input: 0,
		output: 0,
		reported: true,
		outcome: "reported",
	};
}

interface HarnessOptions {
	model?: Model;
	context?: Context;
	summarizer?: Model;
	policy?: CachePolicy;
	notices?: CacheNotice[];
	records?: CacheRequestRecord[];
	now?: number;
	running?: () => boolean;
	worthwhile?: boolean;
	spendable?: boolean;
	veto?: { blocked: boolean; reason?: string } | (() => Promise<{ blocked: boolean; reason?: string }>);
	disabled?: boolean;
	compact?: (context: Context, options: { trigger: string; signal?: AbortSignal }) => Promise<Context>;
}

function makeHarness(options: HarnessOptions = {}) {
	const model = options.model ?? MODEL;
	const context = options.context ?? CONTEXT;
	const calls = {
		compacts: [] as Array<{ trigger: string; signal: AbortSignal | undefined }>,
		applied: [] as Context[],
		rewrites: [] as string[],
		requests: [] as number[],
		reported: [] as string[],
		scheduled: [] as number[],
	};
	let cancelled = false;
	const manager = {
		isDisabled: options.disabled ?? false,
		idleSummaryWorthwhile: () => options.worthwhile ?? true,
		compact: (ctx: Context, opts: { trigger: string; signal?: AbortSignal }) => {
			calls.compacts.push({ trigger: opts.trigger, signal: opts.signal });
			return options.compact?.(ctx, opts) ?? Promise.resolve(ctx);
		},
	} as unknown as CompactionManager;
	const veto = options.veto ?? { blocked: false };
	const deps: IdleSummaryDeps = {
		manager: () => manager,
		model: () => model,
		summarizer: () => options.summarizer ?? model,
		policy: () => options.policy,
		notices: () => options.notices ?? [],
		records: () => options.records ?? [recordFor(model, context, AT)],
		context: () => context,
		isRunning: options.running ?? (() => false),
		canSpend: () => options.spendable ?? true,
		preCompact: typeof veto === "function" ? veto : async () => veto,
		noteRequest: (at) => {
			calls.requests.push(at);
		},
		noteRewrite: (cause) => {
			calls.rewrites.push(cause);
		},
		apply: (next) => {
			calls.applied.push(next);
		},
		report: (text) => {
			calls.reported.push(text);
		},
		now: () => options.now ?? AT,
		schedule: (_tick, ms) => {
			calls.scheduled.push(ms);
			return () => {
				cancelled = true;
			};
		},
	};
	return { deps, calls, context, cancelled: () => cancelled };
}

/** Let pending microtasks and timers run until `done`, failing after a bound. */
async function settle(done: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
	expect(done()).toBe(true);
}

/** A pass that only ends when its signal aborts, as a real request would. */
function hangingCompact(_context: Context, options: { trigger: string; signal?: AbortSignal }): Promise<Context> {
	return new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});
}

describe("the idle summary's timer", () => {
	test("a pass is armed when the session is built", () => {
		const h = makeHarness();
		createIdleSummary(h.deps);
		expect(h.calls.scheduled).toEqual([IDLE_SUMMARY_TICK_MS]);
	});

	test("stop cancels the timer and a pass in flight", async () => {
		const h = makeHarness({ compact: hangingCompact });
		const summary = createIdleSummary(h.deps);
		const pass = summary.check(FIRE_AT);
		await settle(() => h.calls.compacts.length === 1);
		expect(summary.running).toBe(true);

		summary.stop();
		await pass;

		expect(h.cancelled()).toBe(true);
		expect(summary.running).toBe(false);
		expect(h.calls.applied).toHaveLength(0);
	});

	test("abort stops the pass but leaves the timer armed", async () => {
		// What an arriving turn calls: the summary's request would read the prefix
		// the turn is about to replace, but the quiet hours after that turn are
		// still this pass's to watch.
		const h = makeHarness({ compact: hangingCompact });
		const summary = createIdleSummary(h.deps);
		const pass = summary.check(FIRE_AT);
		await settle(() => h.calls.compacts.length === 1);

		summary.abort();
		await pass;

		expect(h.cancelled()).toBe(false);
		expect(summary.running).toBe(false);
		expect(h.calls.applied).toHaveLength(0);
	});
});

describe("when a pass fires", () => {
	test("inside the lead window it compacts, notes the rewrite and adopts the result", async () => {
		const h = makeHarness({ now: FIRE_AT });
		await createIdleSummary(h.deps).check();

		expect(h.calls.compacts.map((call) => call.trigger)).toEqual(["idle"]);
		expect(h.calls.requests).toEqual([FIRE_AT]);
		expect(h.calls.rewrites).toEqual(["compaction"]);
		expect(h.calls.applied).toEqual([h.context]);
	});

	test("a second before the window nothing is bought", async () => {
		const h = makeHarness({ now: FIRE_AT - 1 });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("after the entry expired the free trim owns the moment", async () => {
		// Past expiry the prefix is cold, and a summary then pays full price for
		// exactly what the trim exists to avoid sending.
		const h = makeHarness({ now: AT + HOUR + 1 });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});
});

describe("when a pass stands down", () => {
	test("a running turn is left alone", async () => {
		const h = makeHarness({ running: () => true, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("a summarizer that would not share the prefix is not paid full price", async () => {
		const h = makeHarness({ summarizer: { ...MODEL, id: "claude-haiku-5-5" }, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("a provider that reports no lifetime has no expiry to anticipate", async () => {
		const h = makeHarness({ model: AUTOMATIC_WIRE, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("a context the manager would not compact is left alone", async () => {
		const h = makeHarness({ worthwhile: false, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("an unaffordable pass is not started", async () => {
		const h = makeHarness({ spendable: false, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("the manager being disabled stops it with the rest of the automatic side", async () => {
		const h = makeHarness({ disabled: true, now: FIRE_AT });
		await createIdleSummary(h.deps).check();
		expect(h.calls.compacts).toHaveLength(0);
	});
});

describe("a turn and a summary racing", () => {
	test("a PreCompact veto is reported and its words are kept", async () => {
		const h = makeHarness({ veto: { blocked: true, reason: "user asked to wait" } });
		await createIdleSummary(h.deps).check(FIRE_AT);

		expect(h.calls.reported).toEqual(["Idle compaction skipped by PreCompact hook: user asked to wait"]);
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("a turn that arrives while the veto is asked wins", async () => {
		let running = false;
		const h = makeHarness({
			running: () => running,
			veto: async () => {
				running = true;
				return { blocked: false };
			},
		});
		await createIdleSummary(h.deps).check(FIRE_AT);
		expect(h.calls.compacts).toHaveLength(0);
	});

	test("a turn that starts during the summary keeps its context", async () => {
		// The session marks itself running before its start event is emitted, so
		// adopting the summary here would replace a transcript that already has
		// the new user message. The record stays in the file; memory catches up.
		let running = false;
		const h = makeHarness({
			running: () => running,
			compact: async (ctx) => {
				running = true;
				return ctx;
			},
		});
		await createIdleSummary(h.deps).check(FIRE_AT);

		expect(h.calls.compacts).toHaveLength(1);
		expect(h.calls.rewrites).toHaveLength(0);
		expect(h.calls.applied).toHaveLength(0);
	});

	test("a failed summary is swallowed and leaves the next check free", async () => {
		let failures = 1;
		const h = makeHarness({
			compact: async (ctx) => {
				if (failures-- > 0) throw new Error("provider down");
				return ctx;
			},
		});
		const summary = createIdleSummary(h.deps);

		await expect(summary.check(FIRE_AT)).resolves.toBeUndefined();
		expect(summary.running).toBe(false);

		await summary.check(FIRE_AT);
		expect(h.calls.applied).toHaveLength(1);
	});
});
