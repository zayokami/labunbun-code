/**
 * Agent task list: a shared in-memory store plus the four task tools
 * (TaskCreate/TaskList/TaskGet/TaskUpdate). The agent uses these to plan and
 * track multi-step work; the UI subscribes to the store for the progress strip.
 */

import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface AgentTask {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	/** Present-continuous label shown in the UI while in progress. */
	activeForm?: string;
	blockedBy: string[];
	createdAt: number;
}

export class TaskStore {
	readonly #tasks = new Map<string, AgentTask>();
	readonly #listeners = new Set<() => void>();
	#counter = 0;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	create(subject: string, description: string, activeForm?: string): AgentTask {
		this.#counter += 1;
		const task: AgentTask = {
			id: String(this.#counter),
			subject,
			description,
			status: "pending",
			activeForm,
			blockedBy: [],
			createdAt: Date.now(),
		};
		this.#tasks.set(task.id, task);
		this.#notify();
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
		patch: Partial<Pick<AgentTask, "subject" | "description" | "status" | "activeForm">> & { addBlockedBy?: string[] },
	): AgentTask | undefined {
		const task = this.#tasks.get(id);
		if (!task) return undefined;
		if (patch.subject !== undefined) task.subject = patch.subject;
		if (patch.description !== undefined) task.description = patch.description;
		if (patch.status !== undefined) task.status = patch.status;
		if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
		if (patch.addBlockedBy) {
			for (const dep of patch.addBlockedBy) {
				if (!task.blockedBy.includes(dep)) task.blockedBy.push(dep);
			}
		}
		this.#notify();
		return task;
	}

	/** Snapshot for the UI strip. */
	summary(): Array<{ id: string; subject: string; status: TaskStatus; activeForm?: string }> {
		return this.list().map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm }));
	}
}

const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
};

function formatTask(task: AgentTask): string {
	const deps = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : "";
	return `#${task.id} [${STATUS_LABEL[task.status]}] ${task.subject}${deps}\n    ${task.description}`;
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
		}),
		prompt:
			"- Create tasks BEFORE starting multi-step work; mark in_progress BEFORE each task;\n" +
			"  mark completed IMMEDIATELY after finishing it. Only one task in_progress at a time.",
		isConcurrencySafe: () => false,
		call: async (input) => {
			const task = store.create(input.subject, input.description, input.activeForm);
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
			"Update a task: change status (pending/in_progress/completed), retitle, or add dependencies. " +
			"Mark tasks completed as soon as they are done — do not batch.",
		inputSchema: z.object({
			taskId: z.string(),
			status: z.enum(["pending", "in_progress", "completed"]).optional(),
			subject: z.string().optional(),
			description: z.string().optional(),
			addBlockedBy: z.array(z.string()).optional().describe("Task ids that must complete before this one"),
		}),
		isConcurrencySafe: () => false,
		call: async (input) => {
			const { taskId, addBlockedBy, ...patch } = input;
			const task = store.update(taskId, { ...patch, addBlockedBy });
			if (!task) {
				return { content: [textContent(`Task #${taskId} not found`)], isError: true };
			}
			return { content: [textContent(`Updated #${taskId}: [${STATUS_LABEL[task.status]}] ${task.subject}`)] };
		},
	});

	return [create, get, list, update];
}
