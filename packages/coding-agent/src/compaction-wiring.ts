/**
 * What a conversation does when it runs out of room — one answer, shared.
 *
 * The interactive app, a `-p` run and a subagent each build their own
 * `AgentSession` around a different world — a dialog, a terminal, a parent — but
 * the question the loop asks before every request ("does this need to be made
 * smaller first?") has one correct answer for a given model, store and settings.
 * This module is that answer: the manager, the cheap rung that runs before a
 * summary is paid for, the breakers and their notices, and the cache
 * bookkeeping that tells a rewrite the app meant to make from one nothing
 * declared.
 *
 * It lived inline in `runInteractive` until a `-p` run and a subagent turned out
 * to have no compaction at all: the machinery existed, the wiring was in one
 * function nobody else could reach.
 */
import {
	type AgentDeps,
	CompactionManager,
	type CompactionPhase,
	type CompactionTrigger,
	type CompactionVerification,
	type SessionStore,
	SUMMARY_SECTIONS,
} from "@labunbun/agent";
import { type Model, missingApiKey, resolveModel, type StreamFn } from "@labunbun/ai";
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
 *
 * A phase whose news is only worth an in-place repaint — the reply arriving,
 * the two adoption steps — returns "", and a caller that writes to an
 * append-only stream skips it: for a stream, an empty line is a different
 * report, not a shorter one. The ladder's descent does get words, because it
 * rewrites the bytes the cache was just read from and starts another full
 * request — length news wherever the wait is being watched.
 */
export function compactionPhaseText(phase: CompactionPhase): string {
	switch (phase.kind) {
		case "preparing":
			return "Compacting context…";
		case "summarizing":
			return phase.mode === "requesting" && phase.attempt > 1
				? `The summary request did not fit; retrying on a smaller context (attempt ${phase.attempt})…`
				: "";
		case "validating":
		case "resuming":
			return "";
		case "failed":
			return `Compaction failed (${phase.trigger}): the summary could not be written. Continuing with the context as it is.`;
		case "done":
			return `Context compacted (${phase.trigger}): ${formatTokens(phase.preTokens)} → ${formatTokens(phase.postTokens)} tokens.`;
	}
}

/**
 * The receipt under the finished line: what the pass can prove about itself.
 *
 * A compaction is the one rewrite of the transcript the user cannot inspect
 * afterwards — the replaced half is gone — so the report names what the
 * account actually carries: how much of the conversation was summarized
 * against how much survives verbatim, whether every section the prompt asks
 * for is in the reply, whether the touched files got fingerprints to compare
 * against later, and whether the session file took the record at all. The
 * warnings at the end are the reason this exists: a summary that quietly lost
 * its decisions section, or a record the session file refused, is news at the
 * exact moment the user is looking for what changed.
 */
export function compactionReceiptLines(verification: CompactionVerification): string[] {
	const lines: string[] = [];
	const messages = (count: number) => (count === 1 ? "message" : "messages");
	lines.push(
		verification.summarized === 0
			? `Nothing fell outside the kept turn; ${keptVerbatim(verification.kept, true)}.`
			: `Summarized ${verification.summarized} ${messages(verification.summarized)}; ${keptVerbatim(verification.kept, false)}.`,
	);
	const totalFiles = verification.filesReadable + verification.filesUnreadable;
	if (totalFiles > 0) {
		const files = totalFiles === 1 ? "file" : "files";
		lines.push(
			verification.filesUnreadable === 0
				? `Fingerprinted ${totalFiles} ${files}, so /context can say later whether ${totalFiles === 1 ? "it has" : "they have"} changed.`
				: verification.filesReadable === 0
					? `No fingerprints: none of the ${totalFiles} touched ${files} could be read at compaction time.`
					: `Fingerprinted ${verification.filesReadable} of ${totalFiles} ${files}; ` +
						`${verification.filesUnreadable} could not be read at compaction time and got none.`,
		);
	}
	const sections = missingSectionsWarning(verification);
	lines.push(sections ?? `All ${SUMMARY_SECTIONS.length} summary sections are present.`);
	const record = recordWarning(verification);
	if (record) lines.push(record);
	return lines;
}

/**
 * "the last 3 survive verbatim", with the singular spelled out — `all` says
 * whether the kept messages are the whole turn, since "the last 2" would claim
 * a cut that did not happen.
 */
function keptVerbatim(kept: number, all: boolean): string {
	if (kept === 0) return "nothing survives verbatim";
	if (kept === 1) return all ? "the message survives verbatim" : "the last message survives verbatim";
	return all ? `all ${kept} survive verbatim` : `the last ${kept} survive verbatim`;
}

/**
 * The warnings alone, for a surface that wants news and not numbers.
 *
 * The receipt's counts are for a transcript a person is reading; a `-p` run's
 * stream gets two lines per pass and should keep them — but a missing section
 * or a refused record is news on every surface, whoever is watching.
 */
export function compactionWarnings(verification: CompactionVerification): string[] {
	return [missingSectionsWarning(verification), recordWarning(verification)].filter(
		(warning): warning is string => warning !== undefined,
	);
}

function missingSectionsWarning(verification: CompactionVerification): string | undefined {
	if (verification.missingSections.length === 0) return undefined;
	// Three names then a count: the message has to stay one line, and the first
	// few headers are enough to tell the user which state went missing.
	const named = verification.missingSections.slice(0, 3).join(", ");
	const more = verification.missingSections.length > 3 ? ` and ${verification.missingSections.length - 3} more` : "";
	return (
		`Warning: the summary is missing ${verification.missingSections.length} of ${SUMMARY_SECTIONS.length} sections ` +
		`(${named}${more}) — the continuation may not carry what they hold.`
	);
}

function recordWarning(verification: CompactionVerification): string | undefined {
	if (verification.recorded !== false) return undefined;
	return "Warning: the session file did not record this compaction — a resume will replay the conversation without this summary.";
}

/**
 * The status row's word for a phase, or nothing once the pass is over.
 *
 * The same lifecycle `compactionPhaseText` tells, said for a position instead
 * of a stream: a row is repainted in place, so it can afford a word for every
 * state the pass moves through. The seconds between "the request is out" and
 * "a reply is coming back" are the whole wait, and the phases with nothing
 * worth a stderr line are exactly the ones the row exists to show.
 */
export function compactionActivityText(phase: CompactionPhase): string | undefined {
	switch (phase.kind) {
		case "preparing":
			return "Compacting context…";
		case "summarizing":
			return "Summarizing context…";
		case "validating":
			return "Validating summary…";
		case "resuming":
			return "Rebuilding context…";
		case "done":
		case "failed":
			return undefined;
	}
}

/**
 * `settings.compaction`, resolved by the host that owns the settings.
 *
 * A struct rather than three more flat options because it travels two hops —
 * through the subagent tool context and the beetle band options — and three
 * fields threaded twice is three places for one of them to be dropped. The
 * summarizer is the resolved model rather than a ref for the same reason: the
 * one step that can wait on a provider's catalog belongs at startup, once, not
 * inside a wiring that `/model` rebuilds.
 */
export interface CompactionTuning {
	/** The model summaries are written with; the session's model when undefined. */
	summarizerModel?: Model;
	/** `settings.compaction.reserveTokens`, into the threshold arithmetic. */
	reserveTokens?: number;
	/** `settings.compaction.thresholdPercent`, when the line is named outright. */
	thresholdPercent?: number;
	/**
	 * `settings.compaction.enabled`. False turns off the two passes the app
	 * starts by itself — the automatic summary and the cheap trim ahead of it —
	 * while the passes a person starts and the provider-refusal recovery stay.
	 * The manager reads it from the config `build` makes, so `/autocompact`
	 * flips this field and asks for a rebuild rather than waiting for a restart.
	 */
	enabled?: boolean;
}

/**
 * `settings.compaction.model`, resolved once at startup.
 *
 * Resolution is a host's job because only the host knows how to wait for a
 * catalog — the REPL's background refresh, a `-p` run's targeted one — so the
 * second look is a callback: a ref nothing matched yet may be one a provider is
 * about to name. A ref that still resolves to nothing, or to a model whose key
 * is missing, comes back as a warning rather than an error, where the host
 * decides: an unknown summarizer degrades context management, while an unknown
 * session model means no first request at all, and only the second of those
 * stops the app.
 */
export async function resolveCompactionSummarizer(
	ref: string | undefined,
	refreshCatalog: () => Promise<unknown> | undefined,
): Promise<{ model?: Model; warning?: string }> {
	if (!ref) return {};
	let model = resolveModel(ref);
	if (!model) {
		await refreshCatalog();
		model = resolveModel(ref);
	}
	if (!model) {
		return { warning: `Warning: unknown compaction model "${ref}" — the session's model will write summaries.` };
	}
	// Checked here rather than left to the first summarization: a pass that dies
	// on a missing key trips the breaker, and the user would find out from an
	// unmanaged context instead of a line at startup.
	const missing = missingApiKey(model);
	if (missing) {
		return {
			warning:
				`Warning: ${missing.message} — the session's model will write summaries.\n` +
				`Example: export ${missing.envNames[0]}=sk-...`,
		};
	}
	return { model };
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
	/**
	 * `settings.compaction`, when the file carries one. The summarizer outlives
	 * a `/model` rebuild: the user chose who writes summaries, and the session
	 * model is just what answers.
	 */
	tuning?: CompactionTuning;
	readFile?: (path: string) => string | null;
	/**
	 * The `PreCompact` hook, when the app has one. A veto defers a pass the
	 * estimate asked for; it cannot defer one the provider already refused — the
	 * next request would be the same request and get the same refusal. The
	 * trigger is handed through so the hook knows which of the three it was asked
	 * about, without this layer interpreting the answer differently per value,
	 * and `customInstructions` carries a manual pass's focus argument, which no
	 * automatic pass has.
	 */
	preCompact?: (
		trigger: CompactionTrigger,
		customInstructions?: string,
	) => Promise<{ blocked: boolean; reason?: string }>;
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
	/**
	 * The same `PreCompact` hook, askable from outside. `checkCompaction` consults
	 * it for the passes it handles; `/compact` runs its summary through
	 * `manager()` directly, so its veto is this door — one hook, one payload
	 * shape, the trigger naming the caller.
	 */
	runPreCompact: (
		trigger: CompactionTrigger,
		customInstructions?: string,
	) => Promise<{ blocked: boolean; reason?: string }>;
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
			if (options.onPhase) {
				options.onPhase(event);
			} else {
				const text = compactionPhaseText(event);
				if (text) options.report(text);
				// The receipt's numbers are for a transcript a REPL paints, and its
				// two-line shape here is pinned by tests; its warnings are news on
				// every surface, a `-p` run's stream included. On a clean pass this
				// adds nothing, so the common shape stays two lines.
				if (event.kind === "done") {
					for (const warning of compactionWarnings(event.verification)) options.report(warning);
				}
			}
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
				reserveTokens: options.tuning?.reserveTokens,
				thresholdPercent: options.tuning?.thresholdPercent,
				enabled: options.tuning?.enabled,
			},
			{
				streamFn: options.streamFn,
				store: forStore,
				summarizerModel: options.tuning?.summarizerModel ?? forModel,
				readFile: options.readFile,
				onPhase: phase,
				// The summary goes out over the session's own prefix, so the cache
				// report reads it as a step of that conversation — but a pass that ran
				// mid-turn pulled its prefix back, and the report would otherwise show
				// that as a rewind nothing declared. Declared per attempt, because each
				// attempt is its own request and the tracker consumes one cause per
				// request. The note after `check` returns stays where it is: that one
				// covers the request that follows the rewrite, not the summary's own.
				onSummarizeRequest: () => options.noteRewrite?.(rewriteCause("compact")),
			},
		);
	};
	let compaction = build(options.model, options.store);
	// Whether the breaker's notice has been shown for the current trip. Edge-
	// triggered off `isTripped` so a rebuild (which cannot be tripped) resets it,
	// and a manager that trips again is announced again.
	let breakerWarned = false;
	/**
	 * The idle rung's clock, kept here because the manager keeps none: the gap
	 * between two checks is the time the session spent not making requests. A
	 * person who walked away leaves one, and so does one very long tool call —
	 * both leave the provider's cache as cold as the other, which is what makes
	 * either the free moment to shrink the prefix.
	 */
	let lastCheckAt = Date.now();

	return {
		checkCompaction: async (context, checkOptions) => {
			try {
				const veto = await options.preCompact?.(checkOptions?.force ? "overflow" : "auto");
				if (veto?.blocked) {
					options.report(`Compaction skipped by PreCompact hook${veto.reason ? `: ${veto.reason}` : ""}`);
					return checkOptions?.force ? { action: "blocked", message: compaction.blockedMessage() } : null;
				}
				// The clock advances only when the manager is actually consulted:
				// a check a veto sent home early must not eat the idle window the
				// veto's own deferral was asked to keep for later.
				const now = Date.now();
				const idleMs = now - lastCheckAt;
				lastCheckAt = now;
				const decision = await compaction.check(context, { ...checkOptions, idleMs });
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
					if (tripped) options.report(compaction.disabledNotice());
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
		runPreCompact: async (trigger, customInstructions) =>
			(await options.preCompact?.(trigger, customInstructions)) ?? { blocked: false },
	};
}
