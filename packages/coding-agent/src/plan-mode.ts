/**
 * Plan mode tools: EnterPlanMode switches the session to read-only planning;
 * ExitPlanMode presents the plan for user approval before mutations resume.
 */

import {
	type AgentSession,
	type AnyTool,
	buildTool,
	DEFAULT_MODE_CHOICE,
	type PermissionMode,
	type SandboxMode,
} from "@labunbun/agent";
import { type Model, textContent } from "@labunbun/ai";
import type { TaskStore } from "@labunbun/tools";
import { type PermissionReply, replyAllowed } from "@labunbun/tui";
import { z } from "zod";
import { sameModel } from "./model-roles.ts";
import { formatPlanAttachment, type PlanSnapshot, type PlanStep } from "./plan-snapshot.ts";

export interface PlanModeCallbacks {
	enterPlanMode(): void;
	/**
	 * Present the plan; resolves when the user approves or rejects.
	 *
	 * `signal` is the calling run's abort. The dialog is a wait on a human, and
	 * the run can be aborted while it is up — without the signal the tool call
	 * stays awaited by a turn that is already over, and the dialog outlives the
	 * session it was asking about.
	 */
	requestPlanApproval(plan: string, signal?: AbortSignal): Promise<{ approved: boolean; feedback?: string }>;
	/**
	 * Remember the pair the session is about to leave for plan mode, so an
	 * approval can put it back.
	 *
	 * The model-driven door (`EnterPlanMode`) records its own entry. The
	 * user-driven doors — `/mode plan`, Shift+Tab — set the mode without going
	 * through this object, so the host tells it. The optional `previous` pair is
	 * for the Shift+Tab path, where the session has already moved by the time the
	 * host hears about it and the old pair can no longer be read off the session.
	 *
	 * Optional because callback objects built by hand (tests, embedders) predate
	 * the method and have no user-driven door to report.
	 */
	recordPlanEntry?(previous?: { mode: PermissionMode; sandbox: SandboxMode }): void;
	/**
	 * Persist a plan snapshot, and read the newest one back.
	 *
	 * Optional together with the lifecycle argument that supplies them: a host
	 * with no session file has nowhere to keep a plan, and the tools then behave
	 * as they did before the bridge existed.
	 */
	recordPlanSnapshot?(snapshot: PlanSnapshot): void;
	readPlanSnapshot?(): PlanSnapshot | null;
	/**
	 * Create the approved plan's steps on the task board, and answer the number
	 * actually created. `undefined` means the host has no board behind it.
	 *
	 * The host owns de-duplication: re-approving a plan must not double the
	 * board, and only the host can see what is already on it.
	 */
	createTasksFromSteps?(steps: PlanStep[]): number | undefined;
	/** Whether the session is in plan mode at the call. */
	isPlanMode?(): boolean;
}

/**
 * The optional fifth argument: where a plan and its steps outlive the turn.
 *
 * Every member is optional so hand-built callback objects and hosts without a
 * session file keep compiling and keep their old behaviour.
 */
export interface PlanLifecycle {
	/** Persist the plan snapshot (best effort, like the task list). */
	record?(snapshot: PlanSnapshot): void;
	/** The newest plan this session holds, for a re-entry to inject. */
	read?(): PlanSnapshot | null;
	/** Create the approved steps; the count created, or undefined with no board. */
	createTasks?(steps: PlanStep[]): number | undefined;
}

export interface PlanApprovalUi {
	/**
	 * Present a permission dialog; resolves to a denial when refused or
	 * canceled. The object form is a denial that carries a sentence, which this
	 * fallback has no way to use — the plan was answered, not explained — so it
	 * reads only the decision.
	 */
	requestPermission(toolName: string, input: unknown, signal?: AbortSignal): Promise<PermissionReply>;
	/**
	 * Present the plan review surface, when the host has one.
	 *
	 * Resolves with the reviewer's answer, or null when the review was canceled
	 * (Esc, abort, replacement). Absent on hosts that only have a permission
	 * dialog; those fall back to the boolean question below, which cannot carry
	 * feedback.
	 */
	requestPlanReview?(plan: string, signal?: AbortSignal): Promise<{ approved: boolean; feedback?: string } | null>;
}

/**
 * The plan seat, when the host has one: the model plan mode runs on.
 *
 * `planModel` reads the resolved `roles.plan` model at the call; an undefined
 * answer means the seat is unconfigured and the session keeps its model, which
 * is what every host did before roles existed. `onModelSwapped` fires after the
 * session's model moves — on entry and again on restore — so the host can
 * rebuild whatever binds to a model (the compaction wiring, the threshold, the
 * status row) the way a `/model` switch does, minus the persistence: entering
 * plan mode is not the user choosing a model, so nothing is written to their
 * settings. One surface deliberately does not swap: `/mode plan` typed at the
 * prompt sets the mode without planning a task, and it keeps the session's
 * model — the seat is for the planning cycle the tools drive.
 */
export interface PlanModelSwap {
	planModel: () => Model | undefined;
	onModelSwapped?: (next: Model) => void;
}

/**
 * Wire plan-mode tools to a live session and REPL handle.
 *
 * Mode bookkeeping is deliberately session-captured at call time: the approval
 * dialog is async, and an in-app /resume can swap the running session while it
 * is open — the saved mode then belongs to the session that asked, not to
 * whichever session is current when the user answers.
 *
 * Both axes are saved, not just the mode. The map used to hold one
 * `PermissionMode` and restore it with `setPermissionMode`, which left the
 * sandbox at whatever the session happened to be in when the plan was
 * approved — so a `/mode agentNoSandbox` before EnterPlanMode came back from
 * ExitPlanMode as a sandboxed `agent`, and nothing said so. Entering plan mode
 * does not change the sandbox, so restoring the pair is what "put it back how
 * you found it" actually means.
 *
 * The model is saved beside the pair when a plan seat exists and actually
 * moved, and restored on approval with the two axes: plan mode that switched
 * models on entry and kept the plan model after approval would leave the
 * session running on the planner, one prompt after the user said go.
 */
export function createPlanModeCallbacks(
	getSession: () => AgentSession | null,
	getUi: () => PlanApprovalUi | null,
	swap?: PlanModelSwap,
	/**
	 * Fired once the session's mode pair has actually moved under the tools'
	 * feet: after a model-driven entry, and after an approval puts the pair back.
	 * The host uses it to publish the badge and persist the policy, which no
	 * session event can do (`setMode` is a setter). Optional so every existing
	 * caller keeps compiling and a host without a badge pays nothing.
	 */
	onModeChanged?: () => void,
	/**
	 * Where the plan and its steps go after the dialog: the session snapshot the
	 * next turn can read, and the task board the approval fills. Optional as a
	 * whole; each member is optional too, so a host can keep a plan without a
	 * board or a board without a plan file.
	 */
	lifecycle?: PlanLifecycle,
): PlanModeCallbacks {
	const previousModes = new WeakMap<AgentSession, { mode: PermissionMode; sandbox: SandboxMode; model: Model }>();
	/**
	 * Save the pair an entry into plan mode is leaving.
	 *
	 * `explicit` is true when the caller named the pair itself — Shift+Tab, whose
	 * session has already moved by the time the host hears about it. Without one,
	 * a pair that is already `plan` is a redundant record (a second EnterPlanMode
	 * in a row, or a repeated record while the session is in plan mode): there is
	 * no "before plan" to save, and the cycle's own snapshot stays.
	 *
	 * Any record taken from outside plan mode replaces an existing snapshot. The
	 * guard used to be "the first snapshot wins, period", which assumed every
	 * cycle ended in an approval — approval deletes the entry. A user can leave
	 * plan mode by hand (`/mode`, Shift+Tab) with no approval to delete it, and
	 * the next cycle would then find the old entry and restore the *first*
	 * cycle's pair instead of the one it actually left.
	 */
	const remember = (
		session: AgentSession,
		pair: { mode: PermissionMode; sandbox: SandboxMode },
		explicit: boolean,
	): void => {
		if (!explicit && pair.mode === "plan") return;
		previousModes.set(session, { ...pair, model: session.model });
	};
	return {
		recordPlanSnapshot: (snapshot) => lifecycle?.record?.(snapshot),
		readPlanSnapshot: () => lifecycle?.read?.() ?? null,
		createTasksFromSteps: (steps) => lifecycle?.createTasks?.(steps),
		// Read from the live session, not captured: a `/resume` swaps it, and the
		// question is about the session the tool call is running in.
		isPlanMode: () => getSession()?.permissionMode === "plan",
		enterPlanMode: () => {
			const session = getSession();
			if (!session) return;
			remember(session, { mode: session.permissionMode, sandbox: session.sandbox }, false);
			session.setMode("plan");
			const planModel = swap?.planModel();
			if (planModel && !sameModel(planModel, session.model)) {
				session.setModel(planModel);
				swap?.onModelSwapped?.(planModel);
			}
			onModeChanged?.();
		},
		recordPlanEntry: (previous) => {
			const session = getSession();
			if (!session) return;
			// Entering plan mode from a user-driven door: the pair is either the one
			// the session is still in (the caller recorded before moving it) or the
			// one the caller named after the move. Either way the model does not
			// move here — this records, it does not enter.
			const pair = previous ?? { mode: session.permissionMode, sandbox: session.sandbox };
			// `plan` is never a legitimate "before plan" pair, whoever named it. The
			// hosts guard this at their call sites, but the contract this method
			// states is about the pair that was left, and a snapshot of `plan` would
			// make an approval restore the mode the session is already in.
			if (pair.mode === "plan") return;
			remember(session, pair, previous !== undefined);
		},
		requestPlanApproval: async (plan, signal) => {
			// Capture everything before the await: the session that entered plan
			// mode and the pair it had before. A swap must leave the newcomer's
			// mode untouched.
			const session = getSession();
			const ui = getUi();
			if (!session || !ui) {
				return { approved: false, feedback: "No interactive session to approve the plan" };
			}
			const previous: { mode: PermissionMode; sandbox: SandboxMode; model?: Model } =
				session.permissionMode === "plan"
					? (previousModes.get(session) ?? { ...DEFAULT_MODE_CHOICE })
					: { mode: session.permissionMode, sandbox: session.sandbox };
			let decision: { approved: boolean; feedback?: string } | null;
			try {
				// The review surface carries a rejection's feedback, so it is preferred
				// wherever the host has one. A host without it keeps the old boolean
				// permission dialog — the same question, minus the sentence.
				decision = ui.requestPlanReview
					? await ui.requestPlanReview(plan, signal)
					: replyAllowed(await ui.requestPermission("ExitPlanMode", { plan }, signal))
						? { approved: true }
						: { approved: false };
			} catch {
				return { approved: false, feedback: "Plan approval dialog failed" };
			}
			// Null is the dialog being taken away — canceled, aborted, or replaced —
			// rather than the user saying no. Report the cancellation so the model
			// does not treat a review nobody finished as a verdict on the plan.
			if (decision === null) {
				return { approved: false, feedback: "Plan approval canceled" };
			}
			if (!decision.approved) {
				return decision.feedback ? { approved: false, feedback: decision.feedback } : { approved: false };
			}
			// An interrupt that raced the dialog (Esc while it was up) counts as
			// canceled, not approved: leave the plan-mode gate exactly as it was.
			// The signal is the same statement one level up, and it is checked here
			// as well as at the UI: a dialog that answered "approved" without racing
			// its own signal must still not lift plan mode for an aborted run.
			if (session.isInterrupted || signal?.aborted) {
				return { approved: false, feedback: "Plan approval canceled" };
			}
			if (getSession() !== session) {
				// The session was swapped mid-dialog; the new session is not plan
				// mode and must not inherit a lift granted to its predecessor.
				return { approved: false, feedback: "Session changed during approval" };
			}
			// Keep the saved pair across rejection/retry; consume it only on approval.
			session.setMode(previous.mode, previous.sandbox);
			previousModes.delete(session);
			// The plan seat goes back with the pair, but only when the seat is what
			// is in effect: a `/model` swapped mid-plan is the user's own choice and
			// outranks the restore, which is why the session model is compared
			// against the plan model rather than assumed.
			const planModel = swap?.planModel();
			if (
				swap &&
				previous.model &&
				planModel &&
				sameModel(session.model, planModel) &&
				!sameModel(previous.model, session.model)
			) {
				session.setModel(previous.model);
				swap.onModelSwapped?.(previous.model);
			}
			// The mode moved without a session event; the host's badge and stored
			// policy learn about it here.
			onModeChanged?.();
			return { approved: true };
		},
	};
}

/**
 * Add an approved plan's steps to the task board.
 *
 * Steps are created in order and start `pending`, which is what the approval
 * result tells the model. A step whose subject already names an unfinished task
 * is skipped: re-approving the same plan (a retry, a repeated `ExitPlanMode`)
 * must not double the board, and a completed task with that subject is history
 * rather than an obstacle. The number returned is what was actually created —
 * `0` when the board already held every step, `undefined` when the host has no
 * board at all. The approval result promises only what this number says.
 */
export function createPlanTasks(taskStore: TaskStore | undefined, steps: PlanStep[]): number | undefined {
	if (!taskStore) return undefined;
	const known = new Set(
		taskStore
			.list()
			.filter((task) => task.status !== "completed")
			.map((task) => task.subject),
	);
	let created = 0;
	for (const step of steps) {
		if (step.subject.trim().length === 0 || known.has(step.subject)) continue;
		taskStore.create(step.subject, step.description ?? step.subject);
		// Within one approval too: a plan that names the same step twice gets one
		// task, because the second would be the duplicate the next approval skips.
		known.add(step.subject);
		created += 1;
	}
	return created;
}

/**
 * What an approved plan tells the model.
 *
 * The archive sentence is unconditional — the snapshot was recorded before
 * this result, so the plan is readable again either way. What follows it is
 * only what actually happened to the board: the number the host created, the
 * honest "nothing new" of a deduplicated approval, or a request to build the
 * board with `TaskCreate` when the plan named no steps. A host with no board
 * gets no task sentence at all; the tool must not promise what it cannot see.
 */
function planApprovedText(created: number | undefined, stepCount: number): string {
	const archived =
		"Plan approved. Plan mode restrictions lifted — you may now implement. The plan has been archived in this session.";
	if (stepCount === 0) {
		return `${archived} No steps were attached to the plan; create the task board with TaskCreate before you start implementing.`;
	}
	if (created !== undefined && created > 0) {
		return `${archived} ${created} task${created === 1 ? "" : "s"} added to the task board and pending.`;
	}
	if (created === 0) {
		return `${archived} No new tasks were added to the task board.`;
	}
	return archived;
}

export function createPlanModeTools(callbacks: PlanModeCallbacks): AnyTool[] {
	const enter = buildTool({
		name: "EnterPlanMode",
		description:
			"Switch to plan mode: research and design without making changes. Use for non-trivial " +
			"implementation tasks where the approach needs user sign-off first.",
		inputSchema: z.object({}),
		prompt: "- Call EnterPlanMode before designing multi-file or architectural changes.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async () => {
			callbacks.enterPlanMode();
			const activation =
				"Plan mode is active: only read-only tools are allowed. Writes, shell commands, " +
				"and subagent tools are denied. Use AskUserQuestion for decisions only the user " +
				"can make. When the approach is ready, call ExitPlanMode with the plan.";
			const saved = callbacks.readPlanSnapshot?.();
			if (!saved) return { content: [textContent(activation)] };
			// The plan is model output read back from a file, so it is attached as
			// data under a sentence that says what to do with it — not as an
			// instruction to reinstate it. A plan approved last cycle is still the
			// user's plan, and a plan left proposed is not a decision.
			return {
				content: [
					textContent(
						`${activation}\n\nA plan from earlier in this session is available below. Read it, revise it as ` +
							`needed, and call ExitPlanMode with the complete plan to replace it.\n\n${formatPlanAttachment(saved)}`,
					),
				],
			};
		},
	});

	const exit = buildTool({
		name: "ExitPlanMode",
		description:
			"Present your implementation plan for user approval. Blocks until the user approves " +
			"or provides feedback. Only call after researching in plan mode.",
		inputSchema: z.object({
			plan: z.string().describe("The complete implementation plan for review"),
			steps: z
				.array(
					z.object({
						subject: z.string().min(1).describe("Brief imperative title, e.g. 'Run tests'"),
						description: z.string().optional().describe("What needs to be done, with enough context to act on"),
					}),
				)
				.optional()
				.describe("Ordered steps to create as pending tasks when the plan is approved"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		call: async (input, toolCtx) => {
			// Read at the call, before the dialog: approval itself restores the
			// pre-plan pair, so a check made after it would always say "not plan
			// mode" and the bridge would never fire on the one path that needs it.
			const inPlanMode = callbacks.isPlanMode?.() ?? true;
			if (inPlanMode) {
				callbacks.recordPlanSnapshot?.({
					plan: input.plan,
					steps: input.steps,
					approved: false,
					at: new Date().toISOString(),
				});
			}
			const decision = await callbacks.requestPlanApproval(input.plan, toolCtx.signal);
			if (decision.approved) {
				// An `ExitPlanMode` called outside plan mode is an abnormal path: the
				// approval still answers (and restores the pair, as it always has), but
				// there was no proposal to archive and there are no steps to add.
				if (!inPlanMode) {
					return {
						content: [textContent("Plan approved. Plan mode restrictions lifted — you may now implement.")],
						details: { approved: true },
					};
				}
				callbacks.recordPlanSnapshot?.({
					plan: input.plan,
					steps: input.steps,
					approved: true,
					at: new Date().toISOString(),
				});
				const created = callbacks.createTasksFromSteps?.(input.steps ?? []);
				return {
					content: [textContent(planApprovedText(created, input.steps?.length ?? 0))],
					details: created === undefined ? { approved: true } : { approved: true, tasksCreated: created },
				};
			}
			return {
				content: [
					textContent(
						`Plan rejected by the user.${decision.feedback ? ` Feedback: ${decision.feedback}` : ""} Revise the plan and call ExitPlanMode again.`,
					),
				],
				details: { approved: false },
			};
		},
	});

	return [enter, exit];
}
