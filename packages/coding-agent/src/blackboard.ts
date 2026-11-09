/**
 * The blackboard dispatcher: a deterministic state machine over the shared
 * `TaskStore` that wakes the member a task belongs to.
 *
 * It renders strings and moves tasks; it never calls a model. A wake costs only
 * the woken member's own turn, and that turn starts from the task card rather
 * than from a transcript of everything the band has said. The rules it enforces
 * are the invariants `docs/dev/blackboard.md` records — a task is claimable only
 * when its dependencies are completed, one `in_progress` task per seat, and one
 * wake per `(seat, task, rev)`.
 *
 * Written as pure functions plus a small controller, the way `task-nudges.ts`
 * is, so every rule is testable without a provider.
 */
import { cutText } from "@labunbun/agent";
import type { AgentTask, TaskChange, TaskStore } from "@labunbun/tools";

/** The wake payload's bound, before the card is cut. */
export const DEFAULT_TASK_CARD_CHARS = 4000;

/** The pheromone bound inside a card. */
export const DEFAULT_ERROR_SUMMARY_CHARS = 1200;

/** What a card may read off the board. Narrowed so a fake store can serve tests. */
export type CardSource = Pick<TaskStore, "get">;

/** Every id in `blockedBy` names a task whose status is completed. */
export function depsMet(task: AgentTask, store: CardSource): boolean {
	return task.blockedBy.every((id) => store.get(id)?.status === "completed");
}

/**
 * Claimable: pending, owned by a seat, and every dependency completed. A failed
 * dependency is terminal but not satisfied, so its dependents stay blocked
 * until the failure is repaired.
 */
export function isReady(task: AgentTask, store: CardSource, seats: readonly string[]): boolean {
	return task.status === "pending" && task.owner !== undefined && seats.includes(task.owner) && depsMet(task, store);
}

/** The ready tasks in id order, which is the order they are claimed in. */
export function readyTasks(store: Pick<TaskStore, "list"> & CardSource, seats: readonly string[]): AgentTask[] {
	return store.list().filter((task) => isReady(task, store, seats));
}

/**
 * The wake payload. It carries exactly what the task needs and nothing that
 * happened in another conversation: the task, what done looks like, the files
 * and commands, the dependencies that unblocked it, and a bounded cut of the
 * last failing run. The whole card is cut to `charBudget` as a last resort.
 */
export function renderTaskCard(
	task: AgentTask,
	store: CardSource,
	options: { charBudget?: number; errorChars?: number } = {},
): string {
	const charBudget = options.charBudget ?? DEFAULT_TASK_CARD_CHARS;
	const errorChars = options.errorChars ?? DEFAULT_ERROR_SUMMARY_CHARS;
	const lines: string[] = [
		`[blackboard] Task #${task.id} — ${task.kind ?? "task"}: ${task.subject} (owner: ${task.owner ?? "unowned"})`,
		"",
		task.description.trim(),
	];
	if (task.acceptance) lines.push("", `What done looks like: ${task.acceptance}`);
	if (task.files?.length) lines.push(`Files: ${task.files.join(", ")}`);
	if (task.commands?.length) lines.push(`Commands: ${task.commands.join(", ")}`);
	const deps = task.blockedBy.map((id) => store.get(id)).filter((dep): dep is AgentTask => dep !== undefined);
	if (deps.length > 0) lines.push(`Blocked by: ${deps.map((dep) => `#${dep.id} ${dep.status}`).join(", ")}`);
	if (task.fixes) lines.push(`Repairs task #${task.fixes}; its failure is the record above.`);
	if (task.errorSummary) lines.push("", `Last failure: ${cutText(task.errorSummary, errorChars)}`);
	lines.push(
		"",
		`Board: TaskList shows every task; TaskGet #${task.id} reads this one. Mark this task completed with ` +
			`TaskUpdate #${task.id} when the work is done and verified — dependencies are flags, not gates.`,
	);
	return cutText(lines.join("\n"), charBudget);
}

export interface BlackboardDispatcherOptions {
	store: TaskStore;
	/** The named seats; an owner outside this list is never woken. */
	seats: readonly string[];
	/** True while the seat has a run in progress; it cannot take another task. */
	isBusy: (seat: string) => boolean;
	/** Start (or continue) the seat's conversation with a rendered card. */
	wake: (seat: string, card: string, task: AgentTask) => void;
	/**
	 * The seat's task reached a terminal state. The band uses this to destroy a
	 * task-scoped session; a caller with long-lived sessions can ignore it.
	 */
	release?: (seat: string, task: AgentTask) => void;
	/** One line for the transcript: claims, continuations, refused wakes. */
	notice?: (line: string) => void;
	charBudget?: number;
	errorChars?: number;
}

interface Claim {
	taskId: string;
	/** The revision the seat was last woken at; a later board write wakes again. */
	rev: number;
}

const DISPLAY: Record<string, string> = {
	john: "John",
	paul: "Paul",
	george: "George",
	ringo: "Ringo",
};

function displaySeat(seat: string): string {
	return DISPLAY[seat] ?? seat;
}

/**
 * One reconciliation pass per microtask, however many store writes land.
 *
 * Writes the dispatcher itself makes during a pass set a dirty bit and schedule
 * a second pass instead of recursing through `#notify`; the second pass finds
 * the claim it just recorded and does nothing.
 */
export class BlackboardDispatcher {
	readonly #options: BlackboardDispatcherOptions;
	readonly #claims = new Map<string, Claim>();
	readonly #unsubscribe: () => void;
	#scheduled = false;
	#stopped = false;

	constructor(options: BlackboardDispatcherOptions) {
		this.#options = options;
		this.#unsubscribe = options.store.subscribe((change: TaskChange) => {
			// A restore replaces the board wholesale; the claim table refers to ids
			// that may no longer exist. Clearing it lets the pass below re-seat an
			// in-progress task instead of trusting a stale wake.
			if (change.type === "restore") this.#claims.clear();
			this.kick();
		});
	}

	/** The claim a seat currently holds, for status and tests. */
	claimFor(seat: string): { taskId: string; rev: number } | undefined {
		const claim = this.#claims.get(seat);
		return claim ? { ...claim } : undefined;
	}

	/** Queue one reconciliation pass. */
	kick(): void {
		if (this.#stopped || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.reconcile();
		});
	}

	/** One pass, synchronously. Exposed so a test need not guess at timer order. */
	reconcile(): void {
		if (this.#stopped) return;
		const { store, seats, isBusy } = this.#options;
		const tasks = store.list();

		// 1. A claim whose task reached a terminal state releases its seat.
		for (const [seat, claim] of [...this.#claims]) {
			const task = store.get(claim.taskId);
			if (!task) {
				this.#claims.delete(seat);
				continue;
			}
			if (task.status === "completed") {
				this.#claims.delete(seat);
				this.#options.release?.(seat, task);
			}
		}

		// 2. An in_progress task whose owner has not been told about this revision
		//    is a continuation: the board changed under the worker (John edited
		//    the task), or the band restarted onto a board a previous run left.
		const busy = new Set<string>();
		for (const seat of seats) {
			if (isBusy(seat)) busy.add(seat);
		}
		for (const task of tasks) {
			if (task.status !== "in_progress" || task.owner === undefined) continue;
			if (!seats.includes(task.owner)) continue;
			// An in_progress task occupies its seat whether or not this pass wakes
			// it: invariant four is a claim rule, and the seat already has work.
			if (busy.has(task.owner)) continue;
			busy.add(task.owner);
			const claim = this.#claims.get(task.owner);
			const rev = task.rev ?? 0;
			if (claim?.taskId === task.id && claim.rev === rev) continue;
			this.#wake(task.owner, task, claim?.taskId === task.id ? "continued" : "resumed");
			this.#claims.set(task.owner, { taskId: task.id, rev });
		}

		// 3. Claim the lowest-id ready task per idle seat. `busy` is updated in
		//    the loop, so a second ready task for the same seat waits its turn.
		for (const task of tasks) {
			if (!isReady(task, store, seats)) continue;
			const seat = task.owner as string;
			if (busy.has(seat)) continue;
			const claimed = store.update(task.id, { status: "in_progress" });
			if (!claimed) continue;
			busy.add(seat);
			this.#claims.set(seat, { taskId: claimed.id, rev: claimed.rev ?? 0 });
			this.#options.notice?.(`[blackboard] ${displaySeat(seat)} claimed #${claimed.id} ${claimed.subject}`);
			this.#wake(seat, claimed, "claimed");
		}
	}

	/** Stop listening. A disbanded band's board is someone else's board. */
	dispose(): void {
		this.#stopped = true;
		this.#unsubscribe();
		this.#claims.clear();
	}

	#wake(seat: string, task: AgentTask, reason: "claimed" | "continued" | "resumed"): void {
		const card = renderTaskCard(task, this.#options.store, {
			charBudget: this.#options.charBudget,
			errorChars: this.#options.errorChars,
		});
		try {
			this.#options.wake(seat, card, task);
			if (reason !== "claimed") {
				this.#options.notice?.(
					`[blackboard] ${displaySeat(seat)} woken again on #${task.id} — the board changed (rev ${task.rev ?? 0}).`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#options.notice?.(`[blackboard] could not wake ${displaySeat(seat)} on #${task.id}: ${message}`);
		}
	}
}
