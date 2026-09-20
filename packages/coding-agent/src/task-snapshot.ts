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
	taskStore.subscribe(() => {
		const session = currentSession();
		if (!session) return;
		const tasks = taskStore.snapshot();
		// Compared as text: both sides come from `list()`, so the order is the
		// same, and a list that did not change is not worth a line in the file.
		// A session that never held a list and one whose list is now empty are the
		// same state, so both sides are lists rather than one of them being absent.
		if (JSON.stringify(readTaskSnapshot(session) ?? []) === JSON.stringify(tasks)) return;
		writeTaskSnapshot(session, tasks);
	});
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
 * Read off the active chain, so a list abandoned by a branch or by a compaction
 * is not resurrected — `appendCompaction` hangs its boundary off the root, and
 * the snapshots above it are history like everything else there.
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

/**
 * A snapshot is data read back from a file, so it is checked rather than trusted.
 *
 * The status especially: it is a key into the label tables, and a status this
 * build does not know would render as `undefined` in the strip and in
 * `TaskList` — a task list that lies about its own state.
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
			candidate.blockedBy.every((id) => typeof id === "string")
		);
	});
}
