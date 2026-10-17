/**
 * Task-board reminders for the interactive host.
 *
 * The agent loop has no opinion about the board; the host does. This module is
 * the small state machine the host pumps from session events: one startup
 * announcement, a nudge when the board has gone stale, a nudge when plan mode
 * has run long, and one completion follow-up per run while work is still marked
 * in progress. All of it is plain counters over a `TaskStore`, so the rules are
 * testable without a session, a clock, or a provider.
 *
 * Reminders are delivered through `steer` while a run is alive and `followUp`
 * after it ends — the same two queues the host already uses. `agent_end` with
 * any reason other than `completed` is left alone: an abort or a failure is not
 * a moment to ask for more work.
 */
import type { AgentEndReason } from "@labunbun/agent";
import { TASK_BOARD_TOOL_NAMES, type TaskStore } from "@labunbun/tools";

/** Turns of silence that make the board, or plan mode, worth one reminder. */
export const TASK_NUDGE_THRESHOLD = 10;

/**
 * Completion follow-ups one attached session may send before it accepts a
 * natural end. Without a ceiling, a run that always ends with the same task
 * still in_progress would buy itself another run every time — the reminder
 * would be the loop.
 */
export const MAX_COMPLETION_NUDGES = 3;

export interface TaskNudgeDeps {
	/** Live plan-mode state of the session this controller is attached to. */
	isPlanMode(): boolean;
	taskStore: TaskStore;
	steer(text: string): void;
	followUp(text: string): void;
	/**
	 * Injected for tests. Production reads `process.env` once, at construction:
	 * `LBB_TASK_REMINDER=off` turns every reminder off for the attached session.
	 */
	env?: { LBB_TASK_REMINDER?: string | undefined };
	/**
	 * Reserved for callers that want a clock. The rules here count events, not
	 * time, so no call is made to it.
	 */
	now?: () => number;
}

export interface TaskNudges {
	/** A run began. Resets the per-run gates and announces the board once. */
	onAgentStart(): void;
	/** One completed turn. Advances the stale-board and plan-mode counters. */
	onTurnEnd(): void;
	/** A tool finished. A board tool restarts the write counter and marks the run. */
	onToolExecutionEnd(toolName: string): void;
	/** A run ended. Only `completed` may ask the model to close out the board. */
	onAgentEnd(reason: AgentEndReason): void;
	/** The Stop hook resumed this run, so its completion reminder is skipped. */
	onStopHookContinued(): void;
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

function startupText(open: number): string {
	return (
		`The task board has ${open} unfinished ${plural(open, "task", "tasks")}. ` +
		"Keep working through them and update their status as you go; TaskList shows the current board."
	);
}

function staleBoardText(open: number): string {
	return (
		`The task board has not changed in ${TASK_NUDGE_THRESHOLD} turns, and ` +
		`${open} unfinished ${plural(open, "task", "tasks")} remain. ` +
		"Re-read it with TaskList, then continue or update their status."
	);
}

function planModeText(): string {
	return (
		`Plan mode has been active for ${TASK_NUDGE_THRESHOLD} consecutive turns. ` +
		"If the plan is ready, ExitPlanMode hands it over; otherwise keep refining it."
	);
}

function completionText(active: number): string {
	return (
		`The run ended with ${active} ${plural(active, "task", "tasks")} still in_progress. ` +
		"Close them out or update their status before stopping."
	);
}

/**
 * Build one controller for one attached session.
 *
 * Counters live here and nowhere else: a hot swap attaches a new controller to
 * the incoming conversation, so a half-finished count never crosses sessions.
 */
export function createTaskNudges(deps: TaskNudgeDeps): TaskNudges {
	const env = deps.env ?? process.env;
	const disabled = env.LBB_TASK_REMINDER?.trim().toLowerCase() === "off";

	let announcementDone = false;
	/** Turns since the last task-board tool call. */
	let boardWriteTurns = 0;
	/** Turns since the last stale-board reminder. */
	let reminderTurns = 0;
	/** Consecutive `turn_end` events observed while plan mode was on. */
	let planTurns = 0;
	/** At most one completion follow-up per run. */
	let completionNudged = false;
	/** Completion follow-ups this attached session has already sent. */
	let completionNudges = 0;
	/** Whether any board tool ran during the current run. */
	let boardTouchedThisRun = false;
	/** Set by the host when the Stop hook already resumed this run. */
	let stopHookContinued = false;

	const openTasks = (): number => deps.taskStore.list().filter((task) => task.status !== "completed").length;
	const inProgressTasks = (): number => deps.taskStore.list().filter((task) => task.status === "in_progress").length;

	return {
		onAgentStart(): void {
			if (disabled) return;
			// A new run gets its own completion gate; an announcement belongs to
			// the attached session and is said at most once.
			completionNudged = false;
			stopHookContinued = false;
			boardTouchedThisRun = false;
			if (announcementDone) return;
			announcementDone = true;
			const open = openTasks();
			if (open > 0) deps.steer(startupText(open));
		},

		onTurnEnd(): void {
			if (disabled) return;
			boardWriteTurns++;
			reminderTurns++;
			if (deps.isPlanMode()) planTurns++;
			else planTurns = 0;

			// Both counters describe the same silence: no board write and no
			// reminder for a full threshold of turns. Firing restarts both, so the
			// next turn cannot repeat it immediately.
			if (boardWriteTurns >= TASK_NUDGE_THRESHOLD && reminderTurns >= TASK_NUDGE_THRESHOLD) {
				const open = openTasks();
				if (open > 0) {
					deps.steer(staleBoardText(open));
					boardWriteTurns = 0;
					reminderTurns = 0;
				}
			}

			// Independent of the board: a long planning stretch gets its own
			// idea — leave plan mode when the plan is ready. It may land on the
			// same turn as a stale-board reminder; each is short, and each resets
			// its own counter so neither repeats on the next turn.
			if (planTurns >= TASK_NUDGE_THRESHOLD) {
				deps.steer(planModeText());
				planTurns = 0;
			}
		},

		onToolExecutionEnd(toolName: string): void {
			if (disabled) return;
			if (!TASK_BOARD_TOOL_NAMES.includes(toolName)) return;
			// Every board tool restarts the write counter, reads included: a model
			// that keeps consulting the board has not forgotten it.
			boardWriteTurns = 0;
			boardTouchedThisRun = true;
		},

		onAgentEnd(reason: AgentEndReason): void {
			if (disabled || reason !== "completed") return;
			// The Stop hook's continuation is the host's own reason to keep going;
			// adding a second one in the same breath would talk over it.
			if (completionNudged || stopHookContinued) return;
			// A run that never touched the board — a plain question answered in
			// text — is not the work a stale in_progress row describes, so it must
			// not restart the session for it.
			if (!boardTouchedThisRun) return;
			// The ceiling is what keeps a model that never closes a task from
			// paying for a new run on every natural end.
			if (completionNudges >= MAX_COMPLETION_NUDGES) return;
			const active = inProgressTasks();
			if (active === 0) return;
			completionNudged = true;
			completionNudges++;
			deps.followUp(completionText(active));
		},

		onStopHookContinued(): void {
			if (disabled) return;
			stopHookContinued = true;
		},
	};
}
