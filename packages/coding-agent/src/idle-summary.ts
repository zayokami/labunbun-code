/**
 * The summary a session buys while the user is away.
 *
 * Leaving a conversation alone does not make it cheap: the provider's prompt
 * cache expires, and the next request pays full price for every token the
 * transcript has accumulated. The existing idle trim answers the moment *after*
 * that expiry with free previews of old tool results. This answers the moment
 * *before* it, with the expensive tool the trim cannot use: a summary, sent
 * while the prefix is still a cache read, replacing hundreds of thousands of
 * tokens with a boundary the next request can be built on.
 *
 * The difference matters because a summary cannot be had for free. Its request
 * is the whole prefix, so it is worth paying only when the prefix is large and
 * the cache is still readable — the two conditions this module exists to test.
 * A provider whose entry lifetime it does not report gives this app no expiry
 * to fire ahead of, so the pass simply does not exist there; a summarizer on a
 * different model shares no cache with the session, so its request would pay
 * full price and is likewise not offered.
 *
 * Everything the decision reads is injected: the clock, the timer, the cache
 * records, the switches, and the manager. That is what makes arm, fire and
 * cancel testable without waiting an hour for a cache to go cold.
 */

import type { CompactionManager } from "@labunbun/agent";
import {
	CACHE_TTL_MS,
	type CacheNotice,
	type CachePolicy,
	type CacheRequestRecord,
	type Context,
	cacheCapability,
	cacheFamilyState,
	effectiveCacheTtl,
	type Model,
	prefixIdentity,
} from "@labunbun/ai";

/**
 * How often a quiet session looks. The window this is aiming at is minutes
 * wide, so a minute of tick is precision enough — and a tick that finds nothing
 * is a couple of hash lookups and an arithmetic comparison.
 */
export const IDLE_SUMMARY_TICK_MS = 30_000;

/**
 * How far ahead of the entry's expiry the summary is fired.
 *
 * The request itself is a full-prefix call and can take half a minute; firing
 * at the last possible instant would let the entry expire while it is being
 * read, which is exactly the full-price request this pass exists to avoid. A
 * minute of lead covers a slow summarization, and is capped at half a short
 * tier so a five-minute cache still has a meaningful window in which to act.
 */
export const IDLE_SUMMARY_LEAD_MS = 120_000;

export interface IdleSummaryDeps {
	/** The manager the pass runs through. Read per pass: `/model` rebuilds it. */
	manager(): CompactionManager;
	/** The model the next session request would go to. */
	model(): Model;
	/** The model that writes summaries — the role, not the session's seat. */
	summarizer(): Model;
	policy(): CachePolicy | undefined;
	notices(): readonly CacheNotice[];
	records(): readonly CacheRequestRecord[];
	/** The context the next request would carry; undefined before a session exists. */
	context(): Context | undefined;
	/** Whether a turn is running. A summary never starts beside one. */
	isRunning(): boolean;
	/** The spending gate the loop uses; false leaves the summary unaffordable. */
	canSpend(): boolean;
	/**
	 * The `PreCompact` veto, asked before the pass with the `idle` trigger. The
	 * automatic threshold pass asks it too; a hook that defers a summary must
	 * not learn that the quiet hours are a way around it.
	 */
	preCompact(): Promise<{ blocked: boolean; reason?: string }>;
	/** Say a request went out, so the host's idle clock starts again. */
	noteRequest(at: number): void;
	/** Declare the prefix rewrite before adopting it, for the cache report. */
	noteRewrite(cause: string): void;
	/** Adopt the rebuilt context. */
	apply(context: Context): void;
	/** A line for the transcript — the veto's own words, and nothing else. */
	report(text: string): void;
	/** Clock, and the recurring timer. `schedule` returns its own cancel. */
	now(): number;
	schedule(tick: () => void, ms: number): () => void;
}

export interface IdleSummary {
	/**
	 * One due check, at `at` or the injected clock. Exposed so a test does not
	 * need a timer, and so a host may ask once for itself.
	 */
	check(at?: number): Promise<void>;
	/** Stop a pass in flight — a turn is about to replace the prefix it reads. */
	abort(): void;
	/** Stop the timer and any pass in flight. */
	stop(): void;
	/** Whether a pass is in flight. */
	get running(): boolean;
}

export function createIdleSummary(deps: IdleSummaryDeps): IdleSummary {
	let inFlight: AbortController | undefined;
	let stopped = false;

	const check = async (at?: number): Promise<void> => {
		if (stopped || inFlight) return;
		// A turn owns the context while it runs, and its request is the one the
		// cache records describe. Reading a half-finished turn is not a smaller
		// version of this decision; it is a different one.
		if (deps.isRunning()) return;
		const now = at ?? deps.now();
		const manager = deps.manager();
		if (manager.isDisabled) return;
		const context = deps.context();
		if (context === undefined) return;
		const model = deps.model();
		const summarizer = deps.summarizer();
		// The summary request is built from this same context, so it reads this
		// family's cache only when the two model identities produce the same
		// prefix key. A different summarizer would pay full price for a prefix
		// the session had just paid to keep warm.
		if (prefixIdentity(model, context) !== prefixIdentity(summarizer, context)) return;
		const ttl = effectiveCacheTtl(deps.policy(), cacheCapability(model), deps.notices());
		if (ttl === undefined) return;
		const state = cacheFamilyState(deps.records(), model, context, now, CACHE_TTL_MS[ttl]);
		// No record in this family means nothing here has been sent — there is no
		// entry to expire, and nothing to save.
		if (state === undefined) return;
		// After the entry is gone, the free idle trim owns the moment: previews
		// cost no model call, and firing a summary here would pay full price for
		// exactly the cold prefix the trim exists to avoid sending.
		if (!state.warm) return;
		const lead = Math.min(IDLE_SUMMARY_LEAD_MS, Math.floor(state.ttlMs / 2));
		if (now < state.expiresAt - lead) return;
		if (!manager.idleSummaryWorthwhile(context)) return;
		if (!deps.canSpend()) return;
		const veto = await deps.preCompact();
		if (stopped) return;
		if (veto.blocked) {
			deps.report(`Idle compaction skipped by PreCompact hook${veto.reason ? `: ${veto.reason}` : ""}`);
			return;
		}
		// A turn may have started while the veto was being asked.
		if (deps.isRunning()) return;
		const controller = new AbortController();
		inFlight = controller;
		// The summary's own request is activity: the host's idle clock has to
		// start again from it, or the next turn would believe the session had
		// been quiet since before the pass and rewrite the prefix it just warmed.
		deps.noteRequest(now);
		try {
			const compacted = await manager.compact(context, { trigger: "idle", signal: controller.signal });
			// The turn that aborted this one may already own the context — the
			// session marks itself running before its start event is emitted — so
			// adopting here would replace a transcript that has a new user message
			// in it. The file already holds the record; memory catches up on the
			// next resume rather than losing the message.
			if (controller.signal.aborted || deps.isRunning()) return;
			deps.noteRewrite("compaction");
			deps.apply(compacted);
		} catch {
			// An abort is a turn arriving, not a failure worth a line. A real
			// failure was already reported by the manager's `failed` phase.
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	};

	const cancel = deps.schedule(() => {
		void check();
	}, IDLE_SUMMARY_TICK_MS);

	return {
		check,
		abort() {
			inFlight?.abort();
		},
		stop() {
			stopped = true;
			cancel();
			inFlight?.abort();
		},
		get running() {
			return inFlight !== undefined;
		},
	};
}
