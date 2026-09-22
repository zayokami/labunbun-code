/**
 * Watching a prefix across requests, so a rewind cannot happen quietly.
 *
 * The hit-rate number alone cannot say *why* a cache missed. A request that
 * reads nothing may be a cold start (nobody had written the prefix yet), a TTL
 * that expired, a genuine prefix rewind (the bytes changed somewhere in the
 * middle, so everything after that point was charged at full price), or a
 * different conversation entirely — a subagent, a compaction summary, a model
 * fallback. This module answers that question by remembering the wire-visible
 * bytes of each request and comparing the next one against them.
 *
 * It is a `StreamFn` wrapper rather than part of the agent session, and that is
 * deliberate: the session sees only its own loop, while compaction and subagent
 * requests are issued through the same `StreamFn` the app hands out. A tracker
 * living inside the session would report those requests as missing and, worse,
 * would compare them against the main loop's transcript and call every one of
 * them a rewind.
 *
 * **Families.** Two requests are comparable only when they share a cache
 * namespace *and* a prefix: same model, same tools, same system prompt. A
 * subagent has its own system prompt and a filtered tool list, so its request
 * is a new family — first request in a family is a cold start by definition,
 * never a rewind. A model switch (or a fallback) is a new family for the same
 * reason: caches are scoped per model, so the new model has nothing to read no
 * matter how stable our bytes were.
 *
 * **What is hashed.** Only the bytes the adapters actually put on the wire —
 * role, text, block kinds, tool ids and arguments — never `timestamp`, `usage`
 * or anything else that moves on every turn without being sent. Hashing the
 * whole neutral message would report rewinds that the provider never sees.
 * Conversely the neutral transcript is compared, not the post-merge wire array:
 * the Anthropic adapter merges consecutive tool results into one user turn,
 * which is a stable transform, so a divergence in the neutral list appears at
 * or before its wire position. Indices below are therefore *message* indices,
 * which is the unit a person can look up in the transcript.
 */

import { type CacheNotice, hash64, prefixIdentity } from "./cache.ts";
import type { AgentMessage, Context, Model, StreamFn, StreamOptions } from "./types.ts";

/**
 * How many families to remember. One per model-plus-prompt shape in play: the
 * main loop, a compaction summary, and a handful of subagent flavours is the
 * realistic ceiling, and a family that falls out of the window simply starts
 * over (its next request is a cold start, which is what it would have been).
 */
const MAX_FAMILIES = 8;

/**
 * How many requests to keep. A long session issues thousands, and every one of
 * them is a few hashes and some counters, so this bound is about the report
 * staying readable rather than about memory: `/cache` summarises all of it and
 * lists the tail.
 */
const MAX_RECORDS = 500;

/** Which part of the request diverged. */
export type DivergenceScope = "tools" | "system" | "messages";

export interface CacheDivergence {
	scope: DivergenceScope;
	/** Set when `scope` is "messages": the index of the first changed message. */
	messageIndex?: number;
}

/** One request, as it looked from here. */
export interface CacheRequestRecord {
	family: string;
	/** Human-readable family name, e.g. "anthropic/claude-sonnet-5". */
	familyLabel: string;
	/** 1-based index of this request within its family. */
	turn: number;
	at: number;
	/** Milliseconds since the previous request in the same family. */
	gapMs?: number;
	/**
	 * What this request was, relative to the one before it in its family.
	 *
	 * "reask" is the same prefix presented again: a retry after a failure, or a
	 * second attempt with a different output cap. Both ask the provider to read
	 * the same bytes, so neither is a wasted cache opportunity and neither grows
	 * the conversation — which is exactly why they are not "extensions".
	 *
	 * A family's first request is a cold start by definition: it is the one
	 * request that could not have read anything.
	 */
	kind: "first" | "extension" | "rewind" | "reask";
	divergence?: CacheDivergence;
	/** Causes registered before this request, e.g. "compaction". */
	causes: string[];
	promptTotal?: number;
	cacheRead: number;
	cacheWrite: number;
	/** Write tokens by TTL bucket, where the provider reports it. */
	cacheWriteTtl?: { "5m": number; "1h": number };
	input: number;
	output: number;
	/** Whether usage came back at all. */
	reported: boolean;
	/**
	 * What ended the request. "cancelled" covers both an aborted turn and a
	 * consumer that stopped reading; "failed" a throw from the client before any
	 * event arrived. Neither is a prefix problem, so neither is a `cause`: a
	 * rewrite nobody registered must stay visible as one.
	 */
	outcome: "reported" | "cancelled" | "failed";
}

/** Everything a report needs, without reaching back into the stream. */
export interface CacheTracker {
	/** Register a deliberate rewrite, consumed by the next request recorded. */
	note(cause: string): void;
	/** All records, oldest first. */
	records(): readonly CacheRequestRecord[];
	/** Families in most-recently-used order. */
	families(): Array<{ key: string; label: string; requests: number }>;
	/**
	 * What providers have said about the cache settings themselves.
	 *
	 * Separate from `records` because it is not about a request: a refused TTL
	 * changes every later request, and a report that folded it into one turn's
	 * numbers would show the symptom without the cause.
	 */
	notices(): readonly CacheNotice[];
	/** Forget everything. Used when a session is replaced (resume, /clear). */
	reset(): void;
}

export interface CacheTrackerOptions {
	/**
	 * A list this tracker reads its notices from, filled by whoever owns the
	 * transport.
	 *
	 * The direction is unusual — the tracker is handed something rather than
	 * producing it — because the notices come from *inside* the adapter and the
	 * adapter is built before this wrapper can exist. Handing over the array
	 * instead of a setter keeps the transport the only writer.
	 */
	notices?: CacheNotice[];
}

/**
 * One message, reduced to the bytes an adapter sends.
 *
 * The thinking block's signature is included because Anthropic sends it back
 * and rejects a transcript whose signature does not match; the tool call's
 * arguments are included because they are the model's own output being replayed.
 */
function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return `u\x00${message.content}`;
		return `u\x00${message.content.map((block) => (block.type === "text" ? `t${block.text}` : `i${block.mimeType}`)).join("\x01")}`;
	}
	if (message.role === "assistant") {
		const parts = message.content.map((block) => {
			if (block.type === "text") return `t${block.text}`;
			if (block.type === "thinking") return `k${block.thinking}${block.signature ?? ""}`;
			return `c${block.id}\x02${block.name}\x02${block.arguments}`;
		});
		return `a\x00${parts.join("\x01")}`;
	}
	const parts = message.content.map((block) => (block.type === "text" ? block.text : `i${block.mimeType}`));
	return `r\x00${message.toolCallId}\x00${parts.join("\x01")}`;
}

/**
 * The request as a list of comparable units: tools, system prompt, then one per
 * message.
 *
 * Tools and system are units 0 and 1 rather than being folded into one key,
 * because a divergence there has a different fix from a divergence in the
 * transcript — the tool list is frozen for the session and a change to it means
 * something appended tools mid-conversation (`/mcp approve`), which invalidates
 * every tier below it.
 *
 * Empty system prompts and absent tool lists hash to a constant, so a request
 * without them still compares cleanly against another without them.
 */
export function contextFingerprints(context: Context): string[] {
	const units: string[] = [];
	units.push(hash64(`tools\x00${context.tools?.length ? JSON.stringify(context.tools) : ""}`));
	units.push(hash64(`system\x00${context.systemPrompt}`));
	for (const message of context.messages) units.push(hash64(messageText(message)));
	return units;
}

/** The index whose meaning is the tools block, then the system prompt. */
const FIRST_MESSAGE_UNIT = 2;

/**
 * Where `next` stopped extending `prev`, or undefined when it extends it.
 *
 * A longer list that starts with the old one is the healthy case — the
 * conversation grew. Anything else is a rewind: the bytes at `index` changed,
 * so every token after it is a fresh write. A *shorter* list that the old one
 * starts with (a truncation) also lands here, and it is a rewind for the same
 * reason.
 */
export function firstDivergence(prev: readonly string[], next: readonly string[]): CacheDivergence | undefined {
	const shared = Math.min(prev.length, next.length);
	for (let i = 0; i < shared; i++) {
		if (prev[i] !== next[i]) {
			if (i === 0) return { scope: "tools" };
			if (i === 1) return { scope: "system" };
			return { scope: "messages", messageIndex: i - FIRST_MESSAGE_UNIT };
		}
	}
	if (next.length >= prev.length) return undefined;
	// The new request is shorter and the old one started with it: history was cut.
	return { scope: "messages", messageIndex: shared - FIRST_MESSAGE_UNIT };
}

function familyKeyOf(model: Model, context: Context): string {
	return hash64(prefixIdentity(model, context));
}

interface FamilyState {
	label: string;
	units: string[];
	requests: number;
	at: number;
}

/**
 * Wrap a `StreamFn` so every request it makes is recorded.
 *
 * It wraps the stream function it is given and observes logical requests: a
 * failed attempt that the retry policy retries away is the retry policy's
 * business, and the attempt that succeeds is recorded as `reask` — the same
 * prefix asked again — because that is what the cache sees.
 *
 * Usage is read from the terminal `done`/`error` event; a stream abandoned
 * before it (cancelled, or an error thrown by the client) still produces a
 * record, with `reported: false`, because a request that reached the provider
 * and got nothing back is exactly the kind of thing a cache report should not
 * hide. The wrapper never throws on its own account: bookkeeping must not be the
 * reason a turn fails.
 */
export function withCacheTracker(
	inner: StreamFn,
	options: CacheTrackerOptions = {},
): { streamFn: StreamFn; tracker: CacheTracker } {
	const familyStates = new Map<string, FamilyState>();
	const records: CacheRequestRecord[] = [];
	const pendingCauses: string[] = [];
	const notices = options.notices ?? [];

	const tracker: CacheTracker = {
		note(cause) {
			pendingCauses.push(cause);
		},
		records() {
			return records;
		},
		families() {
			return [...familyStates.entries()].map(([key, state]) => ({
				key,
				label: state.label,
				requests: state.requests,
			}));
		},
		notices() {
			return notices;
		},
		reset() {
			familyStates.clear();
			records.length = 0;
			pendingCauses.length = 0;
		},
	};

	const streamFn: StreamFn = async function* tracked(model, context: Context, options?: StreamOptions) {
		const key = familyKeyOf(model, context);
		const label = `${model.provider}/${model.id}`;
		const units = contextFingerprints(context);
		const prev = familyStates.get(key);
		const now = Date.now();

		const divergence = prev ? firstDivergence(prev.units, units) : undefined;
		const record: CacheRequestRecord = {
			family: key,
			familyLabel: label,
			turn: (prev?.requests ?? 0) + 1,
			at: now,
			gapMs: prev ? now - prev.at : undefined,
			// No divergence and no growth can only mean the same bytes twice: a
			// truncation, or any other change, is caught by `firstDivergence`.
			kind:
				prev === undefined ? "first" : divergence ? "rewind" : extendsPrev(prev.units, units) ? "extension" : "reask",
			divergence,
			causes: pendingCauses.splice(0, pendingCauses.length),
			cacheRead: 0,
			cacheWrite: 0,
			input: 0,
			output: 0,
			reported: false,
			outcome: "cancelled",
		};

		// The family is updated before the request goes out: if the stream throws,
		// the next request must still compare against what was actually sent, not
		// against a stale prefix that this attempt already replaced.
		familyStates.delete(key);
		familyStates.set(key, { label, units, requests: record.turn, at: now });
		while (familyStates.size > MAX_FAMILIES) {
			const oldest = familyStates.keys().next().value;
			if (oldest === undefined) break;
			familyStates.delete(oldest);
		}
		records.push(record);
		if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

		try {
			for await (const event of inner(model, context, options)) {
				if (event.type === "done" || event.type === "error") {
					record.promptTotal = event.message.usage.promptTotal;
					record.cacheRead = event.message.usage.cacheRead;
					record.cacheWrite = event.message.usage.cacheWrite;
					record.cacheWriteTtl = event.message.usage.cacheWriteTtl;
					record.input = event.message.usage.input;
					record.output = event.message.usage.output;
					record.reported = true;
					record.outcome = "reported";
				}
				yield event;
			}
		} catch (error) {
			// A client that threw before producing anything (a network failure, a
			// pre-flight rejection). Recorded, then rethrown: this wrapper observes
			// the stream, it does not own what happens to it.
			record.outcome = record.reported ? "reported" : "failed";
			throw error;
		}
		// No `finally`: the default `outcome` is "cancelled", which is what is left
		// when the loop above neither finished nor threw — the consumer stopped
		// reading, as an aborted turn does.
	};

	return { streamFn, tracker };
}

/** Whether `next` is strictly longer than `prev` and starts with it. */
function extendsPrev(prev: readonly string[], next: readonly string[]): boolean {
	if (next.length <= prev.length) return false;
	for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
	return true;
}
