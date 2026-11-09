/**
 * The blackboard dispatcher: a deterministic state machine over the shared
 * `TaskStore` that wakes the member a task belongs to.
 *
 * It renders strings and moves tasks; it never calls a model. A wake costs only
 * the woken member's own turn, and that turn starts from the task card rather
 * than from a transcript of everything the band has said. The rules it enforces
 * are the invariants `docs/dev/blackboard.md` records — a task is claimable only
 * when its dependencies are completed, one `in_progress` task per seat, one
 * wake per `(seat, task, rev)`, and two tasks whose files intersect never run
 * together.
 *
 * Beyond routing it repairs: a failed `build`/`verify` run gets one fix task
 * (or, past the attempt ceiling, one escalation to John), a completed fix marks
 * the task it repaired, and a completed `implement` task with no verifier gets
 * one. All of it is board writes — the dispatcher never asks a member anything.
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

/** Repair rounds a task gets before the dispatcher escalates it to John. */
export const DEFAULT_MAX_FIX_ROUNDS = 3;

/** The seat a fix goes to when the failing task names no implementer. */
export const DEFAULT_FIXER = "paul";

/** The seat the automatic verifier goes to. */
export const DEFAULT_VERIFIER = "george";

/**
 * What the dispatcher did, for `/beetle status`'s handoff line. `wakes` counts
 * every model-free handoff — a first claim and each re-wake after a board edit.
 * The relay this replaced spent a peer message and a receipt turn per handoff,
 * so the status line's saving is `wakes * 2`; it is an estimate and says so.
 */
export interface BoardReport {
	wakes: number;
	claims: number;
	fixes: number;
	verifications: number;
	escalations: number;
}

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

/** One path in the form the conflict check compares: separated, without a trailing slash. */
function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Two paths conflict when they are equal, or one contains the other. */
export function pathsConflict(a: string, b: string): boolean {
	const left = normalizePath(a);
	const right = normalizePath(b);
	if (left === "" || right === "") return false;
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * True when the two tasks touch any of the same files. The workspace is one, so
 * a claim is serialised across owners too: two seats editing the same tree at
 * the same time is a merge conflict the board can simply refuse to cause. A
 * task that names no files conflicts with nothing — the rule can only be as
 * precise as the writer was.
 */
export function filesConflict(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (!a?.length || !b?.length) return false;
	return a.some((left) => b.some((right) => pathsConflict(left, right)));
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
	if (task.fixedBy) lines.push(`Repaired by #${task.fixedBy} — run the acceptance again.`);
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
	/** Repair rounds per task before an escalation; defaults to {@link DEFAULT_MAX_FIX_ROUNDS}. */
	maxAttempts?: number;
	/**
	 * Create a fix (or, at the ceiling, an escalation) for a failed build/verify
	 * run. False leaves the failure open with its verdict for John to route;
	 * the automatic verifier is a separate rule and still runs.
	 */
	autoFix?: boolean;
	/** The seat a fix goes to when the failing task names no implementer. */
	fixer?: string;
	/** The seat the automatic verifier goes to. */
	verifier?: string;
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
	/** Tasks whose continuation budget is spent; the notice fires once. */
	readonly #exhausted = new Set<string>();
	/** Failures already reported as left to John; keyed by revision so the next one speaks again. */
	readonly #leftToJohn = new Set<string>();
	readonly #report: BoardReport = { wakes: 0, claims: 0, fixes: 0, verifications: 0, escalations: 0 };
	readonly #unsubscribe: () => void;
	#scheduled = false;
	#stopped = false;

	constructor(options: BlackboardDispatcherOptions) {
		this.#options = options;
		this.#unsubscribe = options.store.subscribe((change: TaskChange) => {
			// A restore replaces the board wholesale; the claim table refers to ids
			// that may no longer exist. Clearing it lets the pass below re-seat an
			// in-progress task instead of trusting a stale wake.
			if (change.type === "restore") {
				this.#claims.clear();
				this.#exhausted.clear();
				this.#leftToJohn.clear();
			}
			this.kick();
		});
		// A board can already hold work when the dispatcher is built — a restored
		// snapshot, or tasks a previous band left and its successor recovered. The
		// first pass claims them instead of waiting for a write that may not come.
		this.kick();
	}

	/** The claim a seat currently holds, for status and tests. */
	claimFor(seat: string): { taskId: string; rev: number } | undefined {
		const claim = this.#claims.get(seat);
		return claim ? { ...claim } : undefined;
	}

	/** What the dispatcher has done so far; a copy, so a caller cannot corrupt it. */
	report(): BoardReport {
		return { ...this.#report };
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
		const { store, isBusy } = this.#options;

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

		// 2. The board's own repair work — fix bookkeeping, repairs and
		//    escalations, the automatic verifier — lands before anyone is woken,
		//    so the claim pass sees the tasks it wrote.
		this.#maintainBoard();

		// 3. An in_progress task whose owner has not been told about this revision
		//    is a continuation: the board changed under the worker (John edited
		//    the task), or the band restarted onto a board a previous run left.
		this.#continueOpen(store.list(), isBusy);

		// 4. Claim the lowest-id ready task per idle seat.
		this.#claimReady(store.list(), isBusy);
	}

	/**
	 * The board's repair bookkeeping, run every pass. Each branch is
	 * idempotent — the next pass sees the fact it wrote and does nothing — so a
	 * burst of store writes cannot multiply fixes, verifiers or escalations.
	 */
	#maintainBoard(): void {
		const { store } = this.#options;
		const tasks = store.list();
		const maxAttempts = this.#options.maxAttempts ?? DEFAULT_MAX_FIX_ROUNDS;

		// A completed fix is the repaired task's receipt. The failing task was
		// re-armed under the fix; `fixedBy` says who repaired it.
		for (const task of tasks) {
			if (task.kind !== "fix" || task.status !== "completed" || task.fixes === undefined) continue;
			const repaired = store.get(task.fixes);
			if (repaired && repaired.fixedBy !== task.id) store.update(repaired.id, { fixedBy: task.id });
		}

		// A failed build/verify gets exactly one repair or one escalation, and
		// only one of either per failing episode: the dispatcher clears the
		// verdict when it acts, so the next pass has nothing left to answer.
		// `autoFix: false` turns this rule off; the failure stays open, verdict
		// and all, and says so once per revision.
		const autoFix = this.#options.autoFix !== false;
		for (const task of tasks) {
			if (task.verdict !== "failed" || task.status === "completed") continue;
			if (task.kind !== "build" && task.kind !== "verify") continue;
			if (!autoFix) {
				const key = `${task.id}:${task.rev ?? 0}`;
				if (this.#leftToJohn.has(key)) continue;
				this.#leftToJohn.add(key);
				this.#options.notice?.(
					`[blackboard] #${task.id} failed — autoFix is off; the failure stays on the board for John.`,
				);
				continue;
			}
			const active = tasks.some((other) => other.fixes === task.id && other.status !== "completed");
			if (active) continue;
			const attempts = task.attempts ?? 0;
			if (attempts >= maxAttempts) this.#escalate(task, attempts);
			else this.#spawnFix(task, attempts, tasks);
		}

		// "Done" without evidence is not a state the board leaves reachable.
		for (const task of tasks) {
			if (task.kind !== "implement" || task.status !== "completed") continue;
			const covered = tasks.some(
				(other) => (other.kind === "verify" || other.kind === "build") && other.blockedBy.includes(task.id),
			);
			if (!covered) this.#spawnVerifier(task);
		}
	}

	/** One fix task for a failed build/verify, owned by whoever should repair it. */
	#spawnFix(task: AgentTask, attempts: number, tasks: readonly AgentTask[]): void {
		const { store } = this.#options;
		const fixer = this.#implementerOf(task, tasks) ?? this.#options.fixer ?? DEFAULT_FIXER;
		const fix = store.create(
			`fix: ${task.subject}`,
			`Repair #${task.id} (${task.kind}). The failing run is recorded on the board; once this completes, #${task.id} runs its declared commands again.`,
			undefined,
			fixer,
			[],
			{ kind: "fix", acceptance: task.acceptance, files: task.files, createdBy: "dispatcher" },
		);
		// The fix carries the failing task's count plus one, so a chain of fixes
		// cannot restart the ceiling by writing a new task.
		store.update(fix.id, { fixes: task.id, attempts: attempts + 1, errorSummary: task.errorSummary });
		// Re-arm the failure under its repair: pending with no verdict, so the
		// next claim is a fresh run and the failed state is not answered twice.
		store.update(task.id, { status: "pending", verdict: null, attempts: attempts + 1, addBlockedBy: [fix.id] });
		this.#report.fixes += 1;
		this.#options.notice?.(
			`[blackboard] #${task.id} failed at attempt ${attempts + 1} — fix #${fix.id} created for ${displaySeat(fixer)}.`,
		);
	}

	/** The ceiling: one escalation for John, and no further repair attempts. */
	#escalate(task: AgentTask, attempts: number): void {
		const { store } = this.#options;
		const escalation = store.create(
			`escalate: ${task.subject}`,
			`#${task.id} (${task.kind}) is still failing after ${attempts} repair round(s) — the ceiling. Decide the next move: change what done means, take it yourself, or stop the band. Its failure is recorded on the board.`,
			undefined,
			"john",
			[],
			{ kind: "escalate", acceptance: task.acceptance, files: task.files, parent: task.id, createdBy: "dispatcher" },
		);
		store.update(task.id, { status: "pending", verdict: null, addBlockedBy: [escalation.id] });
		this.#report.escalations += 1;
		this.#options.notice?.(
			`[blackboard] #${task.id} still failing after ${attempts} round(s) — escalation #${escalation.id} is John's.`,
		);
	}

	/** The seat that should repair a failure: the implementer it was built on, when named. */
	#implementerOf(task: AgentTask, tasks: readonly AgentTask[]): string | undefined {
		const { seats } = this.#options;
		const implementer = tasks.find(
			(other) =>
				other.kind === "implement" &&
				task.blockedBy.includes(other.id) &&
				other.owner !== undefined &&
				seats.includes(other.owner),
		)?.owner;
		return implementer;
	}

	/** An implement task completed with no verifier gets one, once. */
	#spawnVerifier(task: AgentTask): void {
		const { store } = this.#options;
		const verifier = this.#options.verifier ?? DEFAULT_VERIFIER;
		const verify = store.create(
			`verify: ${task.subject}`,
			`#${task.id} was marked completed with no verifier. Check the acceptance against the live workspace and, when commands are declared, run them — the exit codes decide.`,
			undefined,
			verifier,
			[task.id],
			{
				kind: "verify",
				acceptance: task.acceptance,
				files: task.files,
				commands: task.commands,
				parent: task.id,
				createdBy: "dispatcher",
			},
		);
		this.#report.verifications += 1;
		this.#options.notice?.(
			`[blackboard] #${task.id} completed unverified — verify #${verify.id} created for ${displaySeat(verifier)}.`,
		);
	}

	/**
	 * Wake the owner of an `in_progress` task whose revision it has not seen.
	 * The continuation is an attempt: past the ceiling the task is left open
	 * with one notice, never silently completed.
	 */
	#continueOpen(tasks: readonly AgentTask[], isBusy: (seat: string) => boolean): void {
		const { store, seats } = this.#options;
		const maxAttempts = this.#options.maxAttempts ?? DEFAULT_MAX_FIX_ROUNDS;
		const busy = new Set<string>();
		for (const seat of seats) {
			if (isBusy(seat)) busy.add(seat);
		}
		for (const task of tasks) {
			if (task.status !== "in_progress" || task.owner === undefined) continue;
			if (!seats.includes(task.owner)) continue;
			// autoFix off: a failed build/verify belongs to John. Waking its owner
			// again would be the repair the switch turned off.
			if (
				this.#options.autoFix === false &&
				task.verdict === "failed" &&
				(task.kind === "build" || task.kind === "verify")
			) {
				continue;
			}
			// An in_progress task occupies its seat whether or not this pass wakes
			// it: invariant four is a claim rule, and the seat already has work.
			if (busy.has(task.owner)) continue;
			busy.add(task.owner);
			const claim = this.#claims.get(task.owner);
			const rev = task.rev ?? 0;
			if (claim?.taskId === task.id && claim.rev === rev) continue;
			const resumed = claim?.taskId === task.id;
			const attempts = task.attempts ?? 0;
			if (attempts >= maxAttempts) {
				// Record the revision so the notice fires once and the next pass
				// stays quiet; the task is left open for John to look at.
				this.#claims.set(task.owner, { taskId: task.id, rev });
				if (!this.#exhausted.has(task.id)) {
					this.#exhausted.add(task.id);
					this.#options.notice?.(
						`[blackboard] #${task.id} ${task.subject} has used ${attempts} attempt(s) — left open, not woken again. John can edit it.`,
					);
				}
				continue;
			}
			const continued = store.update(task.id, { attempts: attempts + 1 });
			if (!continued) continue;
			this.#claims.set(task.owner, { taskId: continued.id, rev: continued.rev ?? 0 });
			this.#report.wakes += 1;
			this.#wake(task.owner, continued, resumed ? "continued" : "resumed");
		}
	}

	/**
	 * Claim the lowest-id ready task per idle seat. `busy` grows as claims land,
	 * and `running` with them, so a second ready task for the same seat waits
	 * its turn and a task that shares files with anything already running waits
	 * for that to finish.
	 */
	#claimReady(tasks: readonly AgentTask[], isBusy: (seat: string) => boolean): void {
		const { store, seats } = this.#options;
		const busy = new Set<string>();
		for (const seat of seats) {
			if (isBusy(seat)) busy.add(seat);
		}
		const running = tasks.filter((task) => task.status === "in_progress");
		for (const task of running) {
			if (task.owner !== undefined) busy.add(task.owner);
		}
		for (const task of tasks) {
			if (!isReady(task, store, seats)) continue;
			const seat = task.owner as string;
			if (busy.has(seat)) continue;
			if (running.some((other) => filesConflict(other.files, task.files))) continue;
			const claimed = store.update(task.id, { status: "in_progress" });
			if (!claimed) continue;
			busy.add(seat);
			running.push(claimed);
			this.#claims.set(seat, { taskId: claimed.id, rev: claimed.rev ?? 0 });
			this.#report.wakes += 1;
			this.#report.claims += 1;
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
