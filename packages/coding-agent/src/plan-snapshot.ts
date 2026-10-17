/**
 * The plan, kept in the session file.
 *
 * Plan mode's product is a plan; once the user approves it, the task board is
 * its durable half. A snapshot of the plan itself is what lets a later
 * `EnterPlanMode` put the proposal back in front of the model instead of asking
 * it to plan from memory, and it is what `/plan` prints.
 *
 * The storage shape is the task list's (`task-snapshot.ts`): a `custom` entry on
 * the active chain, newest wins, best-effort writes and a checked read. The one
 * difference is re-anchoring: a compaction hangs its boundary off the chain's
 * root, so the snapshot above it stops being on the active chain and the pass
 * that ends has to put it back — `reanchorPlanSnapshot` is that put-back.
 */
import type { SessionStore } from "@labunbun/agent";

/** The `custom` entry kind the plan is saved under. On disk, so it is fixed. */
export const PLAN_SNAPSHOT_KIND = "plan";

/**
 * How much of a saved plan is put back into a turn.
 *
 * A plan is model output and plan mode can be entered many times in one
 * session; without a bound, every re-entry would carry every earlier plan. The
 * cut is marked with the exact number of characters dropped, so the model knows
 * it is reading a truncated body rather than a plan that ended there.
 */
export const MAX_INJECTED_PLAN_CHARS = 8000;

/** One step of a plan, in the same shape the task board takes. */
export interface PlanStep {
	subject: string;
	description?: string;
}

export interface PlanSnapshot {
	/** The complete plan text the user was shown. */
	plan: string;
	/** Ordered steps to create on the task board when the plan is approved. */
	steps?: PlanStep[];
	/** False while proposed for review, true once approved. */
	approved: boolean;
	/** ISO timestamp of when this state was recorded. */
	at: string;
}

/**
 * Record the plan as it stands.
 *
 * Best effort: a session file that cannot be appended to must not fail the turn
 * that is trying to save its plan. A snapshot equal to the newest one is
 * skipped — a pass that puts the plan back after a compaction, and a re-entry
 * that reads the same state, should not keep growing the file for a plan
 * nothing changed. An absent session is a no-op, which is the same direction:
 * losing a snapshot costs the next turn its context, never this one's work.
 */
export function writePlanSnapshot(session: SessionStore | undefined, snapshot: PlanSnapshot): void {
	if (!session) return;
	try {
		const latest = readPlanSnapshot(session);
		if (latest && samePlanSnapshot(latest, snapshot)) return;
		session.appendCustom(PLAN_SNAPSHOT_KIND, snapshot);
	} catch {
		// Nothing to do about it: the plan is not the work the user asked for.
	}
}

/**
 * The newest readable snapshot the active chain holds, or null when it holds
 * none.
 *
 * Read off the active chain, so a plan abandoned by a branch is not
 * resurrected. A compaction is not read back this way and cannot be: the
 * boundary hangs off the chain's root, which takes the snapshot above it out of
 * the walk — the wiring reads the plan before the pass and puts it back after.
 */
export function readPlanSnapshot(session: SessionStore | undefined): PlanSnapshot | null {
	if (!session) return null;
	const entries = session.linearEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.kind !== PLAN_SNAPSHOT_KIND) continue;
		if (isPlanSnapshot(entry.data)) return entry.data;
	}
	return null;
}

/**
 * Put a plan back on the chain after a compaction re-rooted it.
 *
 * The caller reads the snapshot before the pass starts, while the chain still
 * runs through it; by the time the pass is `done` the boundary is already in
 * the file and a fresh read would find nothing. A null snapshot — a pass with
 * no plan to carry — writes nothing.
 */
export function reanchorPlanSnapshot(
	session: SessionStore | undefined,
	snapshot: PlanSnapshot | null | undefined,
): void {
	if (!snapshot) return;
	writePlanSnapshot(session, snapshot);
}

/**
 * The plan as a re-entering turn reads it: state, step count, record time, and
 * the text, bounded to `MAX_INJECTED_PLAN_CHARS`.
 */
export function formatPlanAttachment(snapshot: PlanSnapshot): string {
	const steps = snapshot.steps?.length ?? 0;
	const status = snapshot.approved ? "approved" : "proposed";
	const header = `Saved plan (${status}, ${steps} step${steps === 1 ? "" : "s"}), recorded at ${snapshot.at}.`;
	const body =
		snapshot.plan.length > MAX_INJECTED_PLAN_CHARS
			? `${snapshot.plan.slice(0, MAX_INJECTED_PLAN_CHARS)}\n[truncated ${snapshot.plan.length - MAX_INJECTED_PLAN_CHARS} chars]`
			: snapshot.plan;
	return `${header}\n\n${body}`;
}

/** Field-by-field: any move is a new state, including a step's description. */
function samePlanSnapshot(a: PlanSnapshot, b: PlanSnapshot): boolean {
	if (a.plan !== b.plan || a.approved !== b.approved || a.at !== b.at) return false;
	const stepsA = a.steps ?? [];
	const stepsB = b.steps ?? [];
	if (stepsA.length !== stepsB.length) return false;
	return stepsA.every((step, index) => {
		const other = stepsB[index];
		return other !== undefined && step.subject === other.subject && step.description === other.description;
	});
}

/**
 * A snapshot is data read back from a file, so it is checked rather than
 * trusted. The two fields the reader branches on get the strictest checks: a
 * non-boolean `approved` would make a proposal read as a decision, and a blank
 * `plan` would inject a bare header into the next turn.
 */
function isPlanSnapshot(value: unknown): value is PlanSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PlanSnapshot>;
	if (typeof candidate.plan !== "string" || candidate.plan.trim().length === 0) return false;
	if (typeof candidate.approved !== "boolean") return false;
	if (typeof candidate.at !== "string") return false;
	if (candidate.steps !== undefined) {
		if (!Array.isArray(candidate.steps)) return false;
		if (!candidate.steps.every(isPlanStep)) return false;
	}
	return true;
}

function isPlanStep(value: unknown): value is PlanStep {
	if (typeof value !== "object" || value === null) return false;
	const step = value as Partial<PlanStep>;
	if (typeof step.subject !== "string" || step.subject.trim().length === 0) return false;
	return step.description === undefined || typeof step.description === "string";
}
