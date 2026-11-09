/**
 * The task list, kept in the session file.
 *
 * Tasks are the agent's plan for work that outlives a turn, and the session file
 * is the only thing on this path that outlives the process — so the plan goes
 * there, as a `custom` entry on the active chain. A restart (a `--continue`, an
 * in-app `/resume`) then starts from the list the last run left behind instead
 * of from an empty strip and a model that has to be told again what it was doing.
 *
 * Snapshots rather than a log of edits: the list is small, the newest snapshot
 * is the list, and a file whose last line was lost mid-append resumes from the
 * snapshot before it rather than from half an update.
 */
import type { SessionStore } from "@labunbun/agent";
import type { AgentTask, TaskStore } from "@labunbun/tools";

/** The `custom` entry kind the list is saved under. On disk, so it is fixed. */
export const TASK_SNAPSHOT_KIND = "tasks";

/**
 * Adopt the list a session holds, and record every change after that.
 *
 * `currentSession` is read rather than captured because `/resume` swaps the
 * conversation under a running app: a store bound to the session it started with
 * would go on saving the list into the file of the session the user left.
 */
export function bindTaskStore(taskStore: TaskStore, currentSession: () => SessionStore | undefined): void {
	restoreTasks(taskStore, currentSession());
	taskStore.subscribe(() => saveTasks(taskStore, currentSession()));
}

/**
 * Make the session's active chain end holding the list as it stands.
 *
 * Every change goes through here, and so does the end of a compaction — the one
 * other moment the chain stops running through the snapshots above: a boundary
 * is hung off the chain's root, so a list the pass did not re-save is a list the
 * next run resumes without. A branch is different and stays different: it walks
 * away from a conversation on purpose, and its snapshots go with it.
 *
 * Best effort throughout, like the writes themselves: a list that cannot be
 * compared or saved costs the next run an empty strip, never the current turn.
 */
export function saveTasks(taskStore: TaskStore, session: SessionStore | undefined): void {
	if (!session) return;
	const tasks = taskStore.snapshot();
	// Compared as text: both sides come from `list()`, so the order is the
	// same, and a list that did not change is not worth a line in the file.
	// A session that never held a list and one whose list is now empty are the
	// same state, so both sides are lists rather than one of them being absent.
	if (JSON.stringify(readTaskSnapshot(session) ?? []) === JSON.stringify(tasks)) return;
	writeTaskSnapshot(session, tasks);
}

/**
 * Replace the store's list with the one `session` holds — an empty list when it
 * holds none, which is what makes this the right call for `/resume`: adopting a
 * session that has no tasks must clear the ones the strip is showing.
 */
export function restoreTasks(taskStore: TaskStore, session: SessionStore | undefined): void {
	if (!session) return;
	taskStore.restore(readTaskSnapshot(session) ?? []);
}

/**
 * The list the session last held, or undefined when it never held one.
 *
 * Read off the active chain, so a list abandoned by a branch is not
 * resurrected. A compaction is not read back this way and cannot be: it hangs
 * its boundary off the chain's root, which takes the snapshots above it out of
 * the walk. The list survives because the app puts it back — `saveTasks` runs
 * when a pass ends, so the chain the session continues on holds it.
 */
export function readTaskSnapshot(session: SessionStore): AgentTask[] | undefined {
	const entries = session.linearEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.kind !== TASK_SNAPSHOT_KIND) continue;
		if (isTaskList(entry.data)) return entry.data;
	}
	return undefined;
}

/**
 * Record the list as it stands.
 *
 * Best effort, like the file checkpoints: a session file that cannot be appended
 * to must not fail the task the agent just created, which is the work it is
 * doing. The cost of a lost snapshot is a list that starts empty next time.
 */
export function writeTaskSnapshot(session: SessionStore, tasks: AgentTask[]): void {
	try {
		session.appendCustom(TASK_SNAPSHOT_KIND, tasks);
	} catch {
		// Nothing to do about it: the task list is not what the user asked for.
	}
}

const TASK_STATUSES = ["pending", "in_progress", "completed"];
const TASK_KINDS = ["plan", "implement", "verify", "build", "research", "fix", "escalate", "report"];
const TASK_VERDICTS = ["passed", "failed"];

/** Optional string fields: absent is fine, present must be a string. */
function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/** A recorded run is the one place a file could carry more than a task's own text. */
function isTaskRun(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Record<string, unknown>;
	return (
		typeof run.command === "string" &&
		(run.exitCode === null || typeof run.exitCode === "number") &&
		typeof run.summary === "string" &&
		typeof run.at === "number" &&
		optionalString(run.by)
	);
}

/**
 * A snapshot is data read back from a file, so it is checked rather than trusted.
 *
 * The status especially: it is a key into the label tables, and a status this
 * build does not know would render as `undefined` in the strip and in
 * `TaskList` — a task list that lies about its own state. The blackboard fields
 * are checked the same way, and a malformed one refuses the snapshot rather
 * than restoring a task whose `kind` or `verdict` would be read as a routing or
 * completion fact it never was. A field this build does not know is left alone:
 * snapshots outlive builds.
 */
function isTaskList(value: unknown): value is AgentTask[] {
	if (!Array.isArray(value)) return false;
	return value.every((task) => {
		if (typeof task !== "object" || task === null) return false;
		const candidate = task as Partial<AgentTask>;
		return (
			typeof candidate.id === "string" &&
			typeof candidate.subject === "string" &&
			typeof candidate.description === "string" &&
			typeof candidate.createdAt === "number" &&
			typeof candidate.status === "string" &&
			TASK_STATUSES.includes(candidate.status) &&
			Array.isArray(candidate.blockedBy) &&
			candidate.blockedBy.every((id) => typeof id === "string") &&
			(candidate.kind === undefined || TASK_KINDS.includes(candidate.kind)) &&
			(candidate.verdict === undefined || TASK_VERDICTS.includes(candidate.verdict)) &&
			optionalString(candidate.acceptance) &&
			optionalString(candidate.errorSummary) &&
			optionalString(candidate.fixes) &&
			optionalString(candidate.fixedBy) &&
			optionalString(candidate.parent) &&
			optionalString(candidate.createdBy) &&
			optionalStringArray(candidate.files) &&
			optionalStringArray(candidate.commands) &&
			(candidate.runs === undefined || (Array.isArray(candidate.runs) && candidate.runs.every(isTaskRun))) &&
			(candidate.attempts === undefined || typeof candidate.attempts === "number") &&
			(candidate.rev === undefined || typeof candidate.rev === "number") &&
			(candidate.updatedAt === undefined || typeof candidate.updatedAt === "number")
		);
	});
}
