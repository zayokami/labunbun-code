/**
 * Agent task list: a shared in-memory store plus the four task tools
 * (TaskCreate/TaskList/TaskGet/TaskUpdate). The agent uses these to plan and
 * track multi-step work; the UI subscribes to the store for the progress strip.
 */

import { type AnyTool, buildTool, cutText } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export type TaskStatus = "pending" | "in_progress" | "completed";

/** What a task is for. The blackboard's dispatcher routes by kind when no owner is named. */
export type TaskKind = "plan" | "implement" | "verify" | "build" | "research" | "fix" | "escalate" | "report";

/** The outcome a build/verify task leaves behind. `failed` is terminal but not satisfied. */
export type TaskVerdict = "passed" | "failed";

/**
 * One command's outcome: the environment's trace, not a member's account of it.
 *
 * `summary` is a `cutText` result, so it keeps the spill pointer and both ends
 * of the output. The full text lives behind that pointer; copying it onto the
 * board would make every later wake pay for it.
 */
export interface TaskRun {
	command: string;
	/** Null when the result carried no exit code (a non-Bash tool, a killed run). */
	exitCode: number | null;
	summary: string;
	at: number;
	by?: string;
}

/** What a creator may add to a task beyond subject, description and the original fields. */
export interface TaskExtras {
	kind?: TaskKind;
	acceptance?: string;
	files?: string[];
	commands?: string[];
	createdBy?: string;
	/** The task this one was derived from; `attempts` is inherited from it. */
	parent?: string;
	/** System-set for a fix task: the failing task's count plus one. */
	attempts?: number;
}

export interface AgentTask {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	/** Present-continuous label shown in the UI while in progress. */
	activeForm?: string;
	/** Who is on the hook — a band member's name in band use. Free-form. */
	owner?: string;
	blockedBy: string[];
	createdAt: number;
	// -- The blackboard fields. All optional so a snapshot written before them still reads.
	kind?: TaskKind;
	/** What "done" means, in terms a verifier can check. */
	acceptance?: string;
	/** The files or areas the task touches; the dispatcher's conflict key. */
	files?: string[];
	/** Commands a build/verify task declares; only these become evidence. */
	commands?: string[];
	/** Bounded environment traces, newest last. */
	runs?: TaskRun[];
	errorSummary?: string;
	verdict?: TaskVerdict;
	/** Repair rounds spent on this task. */
	attempts?: number;
	/** On a fix task, the task it repairs. */
	fixes?: string;
	/** Set when a fix task repaired this one. */
	fixedBy?: string;
	/** On a worker-derived task, the task it came from. */
	parent?: string;
	createdBy?: string;
	/** Bumped by every store write; the dispatcher's wake key. */
	rev?: number;
	updatedAt?: number;
}

/** What a `subscribe` listener is told. A listener written before this existed ignores the argument. */
export type TaskChange =
	| { type: "create"; task: AgentTask }
	| { type: "update"; task: AgentTask; previous: AgentTask }
	| { type: "restore" };

/** A copy deep enough that a listener cannot reach the store's arrays. */
function cloneTask(task: AgentTask): AgentTask {
	return {
		...task,
		blockedBy: [...task.blockedBy],
		files: task.files ? [...task.files] : undefined,
		commands: task.commands ? [...task.commands] : undefined,
		runs: task.runs?.map((run) => ({ ...run })),
	};
}

export class TaskStore {
	readonly #tasks = new Map<string, AgentTask>();
	readonly #listeners = new Set<(change: TaskChange) => void>();
	#counter = 0;

	/**
	 * `listener` receives the change that woke it. A zero-argument callback is
	 * still assignable, which is what keeps the strip's subscription as it was.
	 */
	subscribe(listener: (change: TaskChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(change: TaskChange): void {
		for (const listener of this.#listeners) listener(change);
	}

	create(
		subject: string,
		description: string,
		activeForm?: string,
		owner?: string,
		blockedBy: string[] = [],
		extras: TaskExtras = {},
	): AgentTask {
		this.#counter += 1;
		const now = Date.now();
		// A worker-derived task continues the count of the task it came from: a
		// repair chain must not restart the ceiling by writing a new task.
		const inherited = extras.parent === undefined ? undefined : this.#tasks.get(extras.parent)?.attempts;
		const task: AgentTask = {
			id: String(this.#counter),
			subject,
			description,
			status: "pending",
			activeForm,
			owner,
			blockedBy: [...new Set(blockedBy)],
			createdAt: now,
			kind: extras.kind,
			acceptance: extras.acceptance,
			files: extras.files ? [...extras.files] : undefined,
			commands: extras.commands ? [...extras.commands] : undefined,
			attempts: extras.attempts ?? inherited ?? 0,
			parent: extras.parent,
			createdBy: extras.createdBy,
			rev: 0,
			updatedAt: now,
		};
		this.#tasks.set(task.id, task);
		this.#notify({ type: "create", task });
		return task;
	}

	get(id: string): AgentTask | undefined {
		return this.#tasks.get(id);
	}

	list(): AgentTask[] {
		return [...this.#tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
	}

	update(
		id: string,
		patch: Partial<
			Pick<
				AgentTask,
				| "subject"
				| "description"
				| "status"
				| "activeForm"
				| "owner"
				| "kind"
				| "acceptance"
				| "files"
				| "commands"
				| "runs"
				| "errorSummary"
				| "attempts"
				| "fixes"
				| "fixedBy"
				| "parent"
				| "createdBy"
			>
		> & {
			addBlockedBy?: string[];
			removeBlockedBy?: string[];
			/**
			 * `null` clears the verdict — the failing state was consumed by a fix
			 * or an escalation and the next run has not decided yet.
			 */
			verdict?: TaskVerdict | null;
		},
	): AgentTask | undefined {
		const task = this.#tasks.get(id);
		if (!task) return undefined;
		// The change record carries the task as it was, so a listener can name
		// what moved without keeping its own copy of the board.
		const previous = cloneTask(task);
		if (patch.subject !== undefined) task.subject = patch.subject;
		if (patch.description !== undefined) task.description = patch.description;
		if (patch.status !== undefined) task.status = patch.status;
		if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
		if (patch.owner !== undefined) task.owner = patch.owner;
		if (patch.kind !== undefined) task.kind = patch.kind;
		if (patch.acceptance !== undefined) task.acceptance = patch.acceptance;
		if (patch.files !== undefined) task.files = [...patch.files];
		if (patch.commands !== undefined) task.commands = [...patch.commands];
		if (patch.runs !== undefined) task.runs = patch.runs.map((run) => ({ ...run }));
		if (patch.errorSummary !== undefined) task.errorSummary = patch.errorSummary;
		if (patch.verdict === null) delete task.verdict;
		else if (patch.verdict !== undefined) task.verdict = patch.verdict;
		if (patch.attempts !== undefined) task.attempts = patch.attempts;
		if (patch.fixes !== undefined) task.fixes = patch.fixes;
		if (patch.fixedBy !== undefined) task.fixedBy = patch.fixedBy;
		if (patch.parent !== undefined) task.parent = patch.parent;
		if (patch.createdBy !== undefined) task.createdBy = patch.createdBy;
		// Removal runs before addition, so an id named in both lists ends present.
		if (patch.removeBlockedBy) {
			const remove = new Set(patch.removeBlockedBy);
			task.blockedBy = task.blockedBy.filter((dep) => !remove.has(dep));
		}
		if (patch.addBlockedBy) {
			for (const dep of patch.addBlockedBy) {
				if (!task.blockedBy.includes(dep)) task.blockedBy.push(dep);
			}
		}
		task.rev = (task.rev ?? 0) + 1;
		task.updatedAt = Date.now();
		this.#notify({ type: "update", task, previous });
		return task;
	}

	/** Snapshot for the UI strip. */
	summary(): Array<{ id: string; subject: string; status: TaskStatus; activeForm?: string; owner?: string }> {
		return this.list().map((t) => ({
			id: t.id,
			subject: t.subject,
			status: t.status,
			activeForm: t.activeForm,
			owner: t.owner,
		}));
	}

	// Long-form design notes: docs/dev/tools.md
	/**
	 * Replace the whole list with a list that was saved somewhere.
	 *
	 * The blackboard fields are defaulted rather than trusted: a snapshot
	 * written before they existed has none, and a task with an undefined `rev`
	 * would make the dispatcher's wake dedupe compare against nothing.
	 */
	restore(tasks: AgentTask[]): void {
		this.#tasks.clear();
		for (const task of tasks) {
			this.#tasks.set(task.id, {
				...cloneTask(task),
				attempts: task.attempts ?? 0,
				rev: task.rev ?? 0,
				updatedAt: task.updatedAt ?? task.createdAt,
			});
		}
		this.#counter = tasks.reduce((highest, task) => Math.max(highest, Number(task.id) || 0), 0);
		this.#notify({ type: "restore" });
	}

	/** Every field of every task, as a copy, for saving. `summary` is for display. */
	snapshot(): AgentTask[] {
		return this.list().map(cloneTask);
	}
}

const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
};

/**
 * The board's text form: what the task is, what done means, and the
 * environment's last word on it. The error cut is bounded here as well as at
 * record time, so one oversized entry cannot make every later `TaskList` pay
 * for it.
 */
function formatTask(task: AgentTask): string {
	const owner = task.owner ? ` (${task.owner})` : "";
	const deps = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : "";
	const lines = [
		`#${task.id} [${STATUS_LABEL[task.status]}]${owner} ${task.subject}${deps}`,
		`    ${task.description}`,
	];
	const facts: string[] = [];
	if (task.kind) facts.push(task.kind);
	if (task.verdict) facts.push(`verdict: ${task.verdict}`);
	if (task.attempts) facts.push(`attempts: ${task.attempts}`);
	if (task.fixes) facts.push(`fixes #${task.fixes}`);
	if (task.fixedBy) facts.push(`fixed by #${task.fixedBy}`);
	if (facts.length > 0) lines.push(`    [${facts.join(" · ")}]`);
	if (task.acceptance) lines.push(`    acceptance: ${task.acceptance}`);
	if (task.files?.length) lines.push(`    files: ${task.files.join(", ")}`);
	if (task.commands?.length) lines.push(`    commands: ${task.commands.join(", ")}`);
	if (task.errorSummary) lines.push(`    last failure: ${cutText(task.errorSummary, 600)}`);
	return lines.join("\n");
}

/** The four board tools' names, in one place — the band filters tool tables by them. */
export const TASK_BOARD_TOOL_NAMES: readonly string[] = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];

/**
 * The note appended to a successful TaskUpdate, never a refusal: moving a
 * blocked task to in_progress is allowed, but the answer names the open
 * dependencies. A dependency id with no task behind it counts as open on
 * purpose — the note is then also the first sign of a typo.
 */
function blockedHint(store: TaskStore, task: AgentTask): string {
	if (task.status !== "in_progress") return "";
	const open = task.blockedBy.filter((dep) => store.get(dep)?.status !== "completed");
	if (open.length === 0) return "";
	return `\nNote: blocked by ${open.map((dep) => `#${dep}`).join(", ")} — not completed. Marked in_progress anyway; dependencies are flags, not gates.`;
}

/** The four task tools sharing one store. */
export function createTaskTools(store: TaskStore): AnyTool[] {
	const create = buildTool({
		name: "TaskCreate",
		description:
			"Create a task on the shared task list. Use for multi-step work: break the goal into " +
			"concrete, verifiable tasks before starting.",
		inputSchema: z.object({
			subject: z.string().describe("Brief imperative title, e.g. 'Run tests'"),
			description: z.string().describe("What needs to be done, with enough context to act on"),
			activeForm: z.string().optional().describe("Present-continuous form shown while running, e.g. 'Running tests'"),
			owner: z.string().optional().describe("Who is on the hook for this task, e.g. a band member's name"),
			blockedBy: z.array(z.string()).optional().describe("Task ids that must complete before this one"),
			kind: z
				.enum(["plan", "implement", "verify", "build", "research", "fix", "escalate", "report"])
				.optional()
				.describe("What the task is for; the dispatcher routes by it"),
			acceptance: z.string().optional().describe("What done looks like, in terms a verifier can check"),
			files: z
				.array(z.string())
				.optional()
				.describe("Files or areas this task touches; overlapping tasks are not run together"),
			commands: z
				.array(z.string())
				.optional()
				.describe("On a verify/build task, the commands whose exit codes decide the verdict"),
			createdBy: z.string().optional().describe("Who wrote this task"),
			parent: z.string().optional().describe("On a derived task, the task it came from"),
		}),
		prompt:
			"- Create tasks BEFORE starting multi-step work; keep exactly one task in_progress while work is underway;\n" +
			"  mark a task completed IMMEDIATELY after finishing, and only when the work is actually done and verified.",
		isConcurrencySafe: () => false,
		call: async (input) => {
			const task = store.create(input.subject, input.description, input.activeForm, input.owner, input.blockedBy, {
				kind: input.kind,
				acceptance: input.acceptance,
				files: input.files,
				commands: input.commands,
				createdBy: input.createdBy,
				parent: input.parent,
			});
			return { content: [textContent(`Created task #${task.id}: ${task.subject}`)] };
		},
	});

	const list = buildTool({
		name: "TaskList",
		description: "List all tasks on the shared task list with their statuses.",
		inputSchema: z.object({}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async () => {
			const tasks = store.list();
			if (tasks.length === 0) return { content: [textContent("(no tasks yet)")] };
			return { content: [textContent(tasks.map(formatTask).join("\n"))] };
		},
	});

	const get = buildTool({
		name: "TaskGet",
		description: "Get one task's full details by id.",
		inputSchema: z.object({ taskId: z.string().describe("The task id, e.g. '3'") }),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const task = store.get(input.taskId);
			if (!task) {
				return { content: [textContent(`Task #${input.taskId} not found`)], isError: true };
			}
			return { content: [textContent(formatTask(task))] };
		},
	});

	const update = buildTool({
		name: "TaskUpdate",
		description:
			"Update a task: change status (pending/in_progress/completed), retitle, set the active form or " +
			"owner, or change dependencies. Mark tasks completed as soon as they are done — do not batch.",
		inputSchema: z.object({
			taskId: z.string(),
			status: z.enum(["pending", "in_progress", "completed"]).optional(),
			subject: z.string().optional(),
			description: z.string().optional(),
			activeForm: z.string().optional().describe("Present-continuous form shown while running, e.g. 'Running tests'"),
			owner: z.string().optional().describe("Reassign the task to this owner"),
			addBlockedBy: z.array(z.string()).optional().describe("Task ids that must complete before this one"),
			removeBlockedBy: z.array(z.string()).optional().describe("Task ids to remove from this task's dependencies"),
			kind: z
				.enum(["plan", "implement", "verify", "build", "research", "fix", "escalate", "report"])
				.optional()
				.describe("What the task is for"),
			acceptance: z.string().optional().describe("What done looks like, in terms a verifier can check"),
			files: z.array(z.string()).optional().describe("Files or areas this task touches"),
			commands: z
				.array(z.string())
				.optional()
				.describe("On a verify/build task, the commands whose exit codes decide the verdict"),
			errorSummary: z
				.string()
				.optional()
				.describe("The failing run's bounded output, when the recorder could not capture it"),
			verdict: z.enum(["passed", "failed"]).optional().describe("On a verify/build task, the outcome you reached"),
		}),
		prompt:
			"- Update the board as you go; never mark a task completed with failing tests, partial work,\n" +
			"  or unresolved issues.",
		isConcurrencySafe: () => false,
		call: async (input) => {
			const { taskId, addBlockedBy, removeBlockedBy, ...patch } = input;
			const task = store.update(taskId, { ...patch, addBlockedBy, removeBlockedBy });
			if (!task) {
				return { content: [textContent(`Task #${taskId} not found`)], isError: true };
			}
			return {
				content: [
					textContent(`Updated #${taskId}: [${STATUS_LABEL[task.status]}] ${task.subject}${blockedHint(store, task)}`),
				],
			};
		},
	});

	return [create, get, list, update];
}
