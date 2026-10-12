/**
 * Subagent lifecycle, as data the host can read.
 *
 * A subagent's handle lives where its conversation lives -- in this process,
 * owned by the tool closure that spawned it -- but "is it still running?" is a
 * question the host asks from outside that closure: a `/subagents` listing, a
 * status line, anything that has to say what the session is doing right now.
 * This registry is that outside. The tools record here, the host reads here,
 * and both sides agree here about what the states are and how they are
 * derived, so the display cannot drift from the lifecycle it displays.
 *
 * The handle is defined here whole, conversation and all, because the host
 * ends up needing the same object the tools do: continuing a subagent, reading
 * its transcript, and listing it are three questions about one thing.
 */
import type { AgentEndReason, AgentSession } from "@labunbun/agent";

/**
 * How many finished subagents a session keeps addressable.
 *
 * A finished handle holds a whole nested conversation in memory -- that is the
 * point, since continuing it is what SendMessage is for -- so the registry is
 * capped. The number is memory first and aging second: a run that finished
 * eight subagents ago is history in every sense.
 */
export const MAX_RETAINED_SUBAGENTS = 8;

/** Where a subagent is in its life: running, ready to continue, or cancelled. */
export type SubagentState = "live" | "finished" | "stopped";

/**
 * The lifecycle as the user reads it: the state of the work, not of the
 * handle. `finished` is three outcomes at once -- completed, failed, and cut
 * short -- and `stopped` is anchored work that is no longer addressable; both
 * flatten into the same vocabulary so a listing can mean one thing per word.
 * `waiting` is the one sub-state of running worth its own word: the run is
 * alive but blocked on a human's answer to a permission ask, and calling that
 * "running" would claim progress the user is the one withholding.
 */
export type SubagentStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

/** What a status needs from the handle it describes. */
export interface SubagentProgress {
	state: SubagentState;
	endReason?: AgentEndReason;
	/**
	 * Asks a human is looking at right now, when the record keeps count.
	 * Optional so a caller that only narrates an outcome ("this finished as
	 * error") can say that with nothing else; a handle that never recorded an
	 * ask has none pending, which is the safe reading of absence.
	 */
	pendingAsks?: number;
}

/**
 * The display status for one handle.
 *
 * `stopped` outranks nothing: a subagent the user stopped after it finished
 * *did* finish, and a listing that retroactively turns its completed work
 * into cancelled work would be editing history to match a button. Stopping
 * only means "cannot be continued"; the work keeps the outcome it reached.
 */
export function subagentStatus(handle: SubagentProgress): SubagentStatus {
	if (handle.state === "live") return (handle.pendingAsks ?? 0) > 0 ? "waiting" : "running";
	if (handle.state === "stopped") return handle.endReason === "completed" ? "completed" : "cancelled";
	if (handle.endReason === "completed") return "completed";
	if (handle.endReason === "aborted") return "cancelled";
	// error, max_turns, and any finish that never recorded a reason: an
	// unlabelled ending is a failure until something says otherwise, the same
	// direction every unknown in this codebase fails in.
	return "failed";
}

/** The handle, whole: the registry's record plus the conversation behind it. */
export interface SubagentHandle extends SubagentProgress {
	sidechainId: string;
	agentType: string;
	/** A short label from the Task call, for listings and pickers. */
	title: string;
	/** When the spawn happened; the age of a running subagent is now minus this. */
	startedAt: number;
	/** When the last run ended, however it ended. Absent while running. */
	finishedAt?: number;
	/** Finish order, for eviction; larger ended later. 0 while live. */
	endedAt: number;
	/**
	 * Asks from this run sitting in the session's permission queue. A live
	 * handle with a nonzero count displays as `waiting` — the listing reads it
	 * off this same object while the dialog is up. A count rather than a flag
	 * because a turn runs its concurrency-safe tools in parallel: one run can
	 * honestly have two questions open at once.
	 */
	pendingAsks: number;
	/**
	 * The nested session, kept alive after its first run so that a continuation
	 * continues the same conversation. That is the whole difference between
	 * SendMessage and a second Task call, so the session must outlive the call
	 * that spawned it.
	 */
	session: AgentSession;
	/** What its own context management did, accumulated across runs. */
	notes: string[];
}

/**
 * The shared table of subagent handles: one per `createSubagentTools` closure
 * by default, or the host's own when it wants to observe.
 *
 * Eviction lives here rather than in the tools because it is a property of
 * the table, not of any tool: the cap exists to bound what the table holds,
 * and a live handle is exactly what must survive a sweep -- it is the one
 * thing still generating the conversation the cap is counting.
 */
export class SubagentRegistry {
	readonly #handles = new Map<string, SubagentHandle>();
	#endSeq = 0;

	/** Record a spawn. The caller keeps owning the handle; the table just sees it. */
	register(handle: SubagentHandle): void {
		this.#handles.set(handle.sidechainId, handle);
	}

	get(sidechainId: string): SubagentHandle | undefined {
		return this.#handles.get(sidechainId);
	}

	/** Every retained handle, in spawn order. Ordering for display is the display's job. */
	list(): SubagentHandle[] {
		return [...this.#handles.values()];
	}

	/**
	 * The run on this handle ended with `reason`.
	 *
	 * A stop already in flight wins: `TaskStop` marks the handle before abort
	 * lands, and that verdict -- never resumed -- outranks the run simply
	 * ending, which is why the state only moves here from `live`. The end
	 * time is stamped either way, because the run did end either way.
	 */
	finish(handle: SubagentHandle, reason: AgentEndReason): void {
		handle.finishedAt = Date.now();
		if (handle.state !== "live") return;
		handle.state = "finished";
		handle.endReason = reason;
		handle.endedAt = ++this.#endSeq;
		this.#evictOldest();
	}

	/** The user's verdict: this handle is never continued. Terminal for runs. */
	stop(handle: SubagentHandle): void {
		handle.state = "stopped";
		handle.endedAt = ++this.#endSeq;
		this.#evictOldest();
	}

	/**
	 * An ask from this handle reached the session's queue: while it sits there
	 * the handle displays as `waiting`, which is not running — it is blocked on
	 * a human, and the listing should say so for exactly that long.
	 */
	askStarted(handle: SubagentHandle): void {
		handle.pendingAsks += 1;
	}

	/**
	 * The answer landed (or the ask was withdrawn, which aborts included): back
	 * to running. Floored at zero because an end without a matching start would
	 * otherwise leave a negative count for the next derivation to trip over.
	 */
	askEnded(handle: SubagentHandle): void {
		handle.pendingAsks = Math.max(0, handle.pendingAsks - 1);
	}

	/** Drop the oldest non-live handles down to the cap; never a live one. */
	#evictOldest(): void {
		const ended = [...this.#handles.values()].filter((handle) => handle.state !== "live");
		if (ended.length <= MAX_RETAINED_SUBAGENTS) return;
		ended.sort((a, b) => a.endedAt - b.endedAt);
		for (const handle of ended.slice(0, ended.length - MAX_RETAINED_SUBAGENTS)) {
			this.#handles.delete(handle.sidechainId);
		}
	}
}
