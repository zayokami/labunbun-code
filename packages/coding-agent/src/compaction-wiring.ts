/**
 * What a conversation does when it runs out of room — one answer, shared.
 *
 * The interactive app, a `-p` run and a subagent each build their own
 * `AgentSession` around a different world — a dialog, a terminal, a parent — but
 * the question the loop asks before every request ("does this need to be made
 * smaller first?") has one correct answer for a given model, store and settings.
 * This module is that answer: the manager, the cheap rung that runs before a
 * summary is paid for, the breaker and its notice, and the cache bookkeeping
 * that tells a rewrite the app meant to make from one nothing declared.
 *
 * It lived inline in `runInteractive` until a `-p` run and a subagent turned out
 * to have no compaction at all: the machinery existed, the wiring was in one
 * function nobody else could reach.
 */
import {
	type AgentDeps,
	COMPACTION_DISABLED_NOTICE,
	CompactionManager,
	type CompactionPhase,
	type SessionStore,
} from "@labunbun/agent";
import type { Model, StreamFn } from "@labunbun/ai";
import { rewriteCause } from "./cache-report.ts";
import { ACCURACY_NOTICE_AFTER_COMPACTIONS, COMPACTION_ACCURACY_NOTICE, formatTokens } from "./context-report.ts";

/**
 * One line for one phase — the default report, and the wording the apps share.
 *
 * A summary is the only thing a session does that can take half a minute and
 * say nothing at all while it does it, so the start is a line even on stderr:
 * a `-p` run that pauses for a summarization with no output reads as a hang.
 * The finished line carries what the user can act on — why it ran, and how much
 * it moved — because that number is the whole reason the pause was worth it.
 */
export function compactionPhaseText(phase: CompactionPhase): string {
	if (phase.kind === "start") return "Compacting context…";
	if (phase.kind === "failed") {
		return `Compaction failed (${phase.trigger}): the summary could not be written. Continuing with the context as it is.`;
	}
	return `Context compacted (${phase.trigger}): ${formatTokens(phase.preTokens)} → ${formatTokens(phase.postTokens)} tokens.`;
}

export interface CompactionWiringOptions {
	/** The model whose window the thresholds come from. `rebuild` may change it. */
	model: Model;
	store: SessionStore | undefined;
	streamFn: StreamFn;
	/** Where what happened to the context is said — a transcript, stderr. */
	report: (text: string) => void;
	/**
	 * `settings.trimOldToolResults`. Unless false, the cheap rung runs first at
	 * the threshold: older tool results become previews, and a summarization is
	 * only paid for if that did not free enough.
	 *
	 * The default is here rather than at the call sites because there are three
	 * of them now, and a default that only two of them apply is a `-p` run that
	 * behaves differently from the session the user just watched.
	 */
	trimOldToolResults?: boolean;
	readFile?: (path: string) => string | null;
	/**
	 * The `PreCompact` hook, when the app has one. A veto defers a pass the
	 * estimate asked for; it cannot defer one the provider already refused — the
	 * next request would be the same request and get the same refusal.
	 */
	preCompact?: () => Promise<{ blocked: boolean; reason?: string }>;
	/** Register a rewrite of the prefix with the cache tracker. */
	noteRewrite?: (cause: string) => void;
	/**
	 * Watch a summarization happen, for an app with somewhere better to put it
	 * than a line — the REPL paints a status row while the call is in flight.
	 * Without one, each phase is reported through `report` as text, which is what
	 * a `-p` run and a subagent want.
	 */
	onPhase?: (phase: CompactionPhase) => void;
}

export interface CompactionWiring {
	checkCompaction: NonNullable<AgentDeps["checkCompaction"]>;
	/** The manager the session commands (`/compact`, `/trim`, `/context`) act through. */
	manager: () => CompactionManager;
	/** Point the manager at another model's window and another store. */
	rebuild: (forModel: Model, forStore: SessionStore | undefined) => void;
}

export function createCompactionWiring(options: CompactionWiringOptions): CompactionWiring {
	/**
	 * Whether the accuracy warning has been said in this app session. Once, not
	 * once per manager: it is a statement about how long the conversation has
	 * been going, and `/model` rebuilding the manager does not make the
	 * conversation young again.
	 */
	let accuracyNoticed = false;

	const build = (forModel: Model, forStore: SessionStore | undefined): CompactionManager => {
		const phase = (event: CompactionPhase): void => {
			if (options.onPhase) options.onPhase(event);
			else options.report(compactionPhaseText(event));
			if (event.kind !== "done") return;
			// Counted after the record went in, so this includes the pass being
			// reported — and counted over the whole file rather than the active
			// chain, which holds at most one. Read from the store rather than
			// tracked here because the store is what survives a resume: a session
			// reopened after three compactions has had three, and should not need
			// three more to be told.
			const count = forStore?.compactionCount() ?? 0;
			if (accuracyNoticed || count < ACCURACY_NOTICE_AFTER_COMPACTIONS) return;
			accuracyNoticed = true;
			options.report(COMPACTION_ACCURACY_NOTICE);
		};
		return new CompactionManager(
			{
				contextWindow: forModel.contextWindow,
				maxOutputTokens: forModel.maxOutputTokens,
				microcompactFirst: options.trimOldToolResults !== false,
			},
			{
				streamFn: options.streamFn,
				store: forStore,
				summarizerModel: forModel,
				readFile: options.readFile,
				onPhase: phase,
			},
		);
	};
	let compaction = build(options.model, options.store);
	// Whether the breaker's notice has been shown for the current trip. Edge-
	// triggered off `isTripped` so a rebuild (which cannot be tripped) resets it,
	// and a manager that trips again is announced again.
	let breakerWarned = false;

	return {
		checkCompaction: async (context, checkOptions) => {
			try {
				const veto = await options.preCompact?.();
				if (veto?.blocked) {
					options.report(`Compaction skipped by PreCompact hook${veto.reason ? `: ${veto.reason}` : ""}`);
					return checkOptions?.force ? { action: "blocked", message: compaction.blockedMessage() } : null;
				}
				const decision = await compaction.check(context, checkOptions);
				// Either action replaces part of the prefix, and the session adopts it
				// itself one line later. Registering the cause here is what the cache
				// report needs to tell a rewrite the app meant to make from one nothing
				// declared — the two look identical from the wire, and only this knows
				// which it was.
				if (decision?.action === "compact" || decision?.action === "reduced") {
					options.noteRewrite?.(rewriteCause(decision.action));
				}
				// The cheap rung is not a compaction, and saying so is the whole
				// report: the user asked for nothing here, and the model is now
				// working from previews of older results. Silence would make that
				// indistinguishable from the transcript having been summarized.
				if (decision?.action === "reduced") {
					options.report(
						`Context trimmed: ${decision.cleared.results} old tool result${decision.cleared.results === 1 ? "" : "s"} replaced by previews ` +
							`(${decision.cleared.chars.toLocaleString()} characters freed, no summarization needed). ` +
							"The full text is still in the session file.",
					);
				}
				// The breaker has no other way to be seen. Silent, it looks like the
				// session simply stopped managing its context — until the run ends with
				// a request that cannot be sent, long after the failures that caused it.
				const tripped = compaction.isTripped;
				if (tripped !== breakerWarned) {
					breakerWarned = tripped;
					if (tripped) options.report(COMPACTION_DISABLED_NOTICE);
				}
				return decision;
			} catch {
				return null; // circuit breaker handles repeated failures
			}
		},
		manager: () => compaction,
		rebuild: (forModel, forStore) => {
			compaction = build(forModel, forStore);
		},
	};
}
