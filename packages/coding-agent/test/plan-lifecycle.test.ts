import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	buildTool,
	DEFAULT_MODE_CHOICE,
	evaluatePermissions,
	MODE_CHOICES,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
	SessionStore,
} from "@labunbun/agent";
import { FAUX_MODEL, type FauxStep, fauxProvider } from "@labunbun/ai";
import { TaskStore } from "@labunbun/tools";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { z } from "zod";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { createPlanModeCallbacks, createPlanModeTools, createPlanTasks, type PlanLifecycle } from "../src/plan-mode.ts";
import { MAX_INJECTED_PLAN_CHARS, type PlanSnapshot, writePlanSnapshot } from "../src/plan-snapshot.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const call = (name: string, args: Record<string, unknown> = {}): FauxStep => ({
	toolCalls: [{ name, arguments: args }],
});
const allowAll: PermissionRule = { toolName: "*", behavior: "allow", source: "session" };

function harness(
	options: {
		mode?: PermissionMode;
		/**
		 * The other axis. Defaults to the confined value, which is what every
		 * `MODE_CHOICES` row but one uses, and the tests below that care about the
		 * pair set it explicitly.
		 */
		sandbox?: SandboxMode;
		steps?: FauxStep[];
		approval?: () => Promise<boolean>;
		/** The review surface. Absent = a host with only the permission dialog. */
		review?: (plan: string, signal?: AbortSignal) => Promise<{ approved: boolean; feedback?: string } | null>;
		rules?: PermissionRule[];
		/** The snapshot/board bridge a host can hand the callbacks. */
		lifecycle?: PlanLifecycle;
	} = {},
) {
	let current: AgentSession | null = null;
	let writes = 0;
	const dialogs: unknown[] = [];
	const reviews: Array<{ plan: string; signal?: AbortSignal }> = [];
	const modes: Array<{ tool: string; mode: PermissionMode }> = [];
	let modeChanges = 0;
	const callbacks = createPlanModeCallbacks(
		() => current,
		() => ({
			requestPermission: async (name, input) => {
				dialogs.push({ name, input });
				return options.approval ? options.approval() : true;
			},
			// Offered only when the test asks for it, so the fallback tests below are
			// the same harness with the surface genuinely absent rather than stubbed
			// to decline.
			requestPlanReview: options.review
				? async (plan, signal) => {
						reviews.push({ plan, signal });
						return options.review?.(plan, signal) ?? null;
					}
				: undefined,
		}),
		undefined,
		() => {
			modeChanges++;
		},
		options.lifecycle,
	);
	const faux = fauxProvider(options.steps ?? [{ text: "done" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		permissionMode: options.mode ?? DEFAULT_MODE_CHOICE.mode,
		sandbox: options.sandbox ?? DEFAULT_MODE_CHOICE.sandbox,
		maxTurns: 12,
		tools: [
			...createPlanModeTools(callbacks),
			buildTool({
				name: "Write",
				description: "in-memory write counter",
				inputSchema: z.object({}),
				call: async () => {
					writes++;
					return { content: [{ type: "text", text: "written" }] };
				},
			}),
		],
		deps: {
			streamFn: faux.streamFn,
			canUseTool: async (name, input, ctx) => {
				modes.push({ tool: name, mode: ctx.mode });
				return evaluatePermissions(name, input, {
					mode: ctx.mode,
					sandbox: ctx.sandbox,
					cwd: ctx.cwd,
					rules: options.rules ?? [allowAll],
				});
			},
		},
	});
	current = session;
	return {
		session,
		callbacks,
		dialogs,
		reviews,
		modes,
		faux,
		get writes() {
			return writes;
		},
		get modeChanges() {
			return modeChanges;
		},
		swap(next: AgentSession | null) {
			current = next;
		},
	};
}

describe("plan mode full lifecycle", () => {
	// The walk is over the *pairs* the picker offers, not over mode names. Two of
	// the four rows share a mode and differ only in the sandbox, and a walk over
	// modes would run that pair twice and prove nothing about the axis that
	// actually differs — which is the one ExitPlanMode has to put back.
	//
	// The `plan` row is the one row this walk leaves out, and not because it is
	// untested: a session that *starts* in plan mode has no pair to restore, so
	// approval lands on the default instead. That is its own case, with its own
	// assertions, below — folding it into this walk would mean the expected
	// "restored" value is the starting value for three rows and something else
	// for the fourth, and the walk would stop saying what it says.
	for (const choice of MODE_CHOICES.filter((c) => c.mode !== "plan")) {
		test(`${choice.id}: enter twice, approve, then mutate under the restored pair`, async () => {
			const h = harness({
				mode: choice.mode,
				sandbox: choice.sandbox,
				steps: [
					call("EnterPlanMode"),
					call("EnterPlanMode"),
					call("Write"),
					call("ExitPlanMode", { plan: "Implement the agreed change" }),
					call("Write"),
					{ text: "done" },
				],
			});
			expect(await h.session.prompt("go")).toBe("completed");
			expect(h.session.permissionMode).toBe(choice.mode);
			expect(h.session.sandbox).toBe(choice.sandbox);
			expect(h.writes).toBe(1);
			expect(h.dialogs).toEqual([{ name: "ExitPlanMode", input: { plan: "Implement the agreed change" } }]);
			expect(h.modes).toEqual([
				{ tool: "EnterPlanMode", mode: choice.mode },
				{ tool: "EnterPlanMode", mode: "plan" },
				{ tool: "Write", mode: "plan" },
				{ tool: "ExitPlanMode", mode: "plan" },
				{ tool: "Write", mode: choice.mode },
			]);
			const results = h.session.messages.filter((m) => m.role === "toolResult");
			expect(results.map((m) => m.isError)).toEqual([false, false, true, false, false]);
		});
	}

	test("startup plan mode approves into the default pair without bypassing a Write deny", async () => {
		const h = harness({
			mode: "plan",
			rules: [allowAll, { toolName: "Write", behavior: "deny", source: "policy" }],
			steps: [call("ExitPlanMode", { plan: "proposal" }), call("Write"), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.session.permissionMode).toBe(DEFAULT_MODE_CHOICE.mode);
		expect(h.session.sandbox).toBe(DEFAULT_MODE_CHOICE.sandbox);
		expect(h.dialogs).toHaveLength(1);
		expect(h.writes).toBe(0);
		expect(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.isError).toBe(true);
	});

	test("rejection preserves plan restrictions; revised approval restores the original pair", async () => {
		let attempts = 0;
		const h = harness({
			mode: "agent",
			sandbox: "danger-full-access",
			approval: async () => ++attempts === 2,
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", { plan: "first" }),
				call("Write"),
				call("ExitPlanMode", { plan: "revised" }),
				call("Write"),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.dialogs).toHaveLength(2);
		expect(h.writes).toBe(1);
		expect(h.modes.filter((m) => m.tool === "Write").map((m) => m.mode)).toEqual(["plan", "agent"]);
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");
	});

	test.each([false, true])("explicit ExitPlanMode deny wins regardless of rule order: reversed=%s", async (reverse) => {
		const rules: PermissionRule[] = [allowAll, { toolName: "ExitPlanMode", behavior: "deny", source: "policy" }];
		const h = harness({
			mode: "plan",
			rules: reverse ? rules.reverse() : rules,
			steps: [call("ExitPlanMode", { plan: "proposal" }), call("Write"), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.dialogs).toEqual([]);
		expect(h.writes).toBe(0);
		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.messages.filter((m) => m.role === "toolResult").every((m) => m.isError)).toBe(true);
	});

	test("dialog rejection by exception fails closed and can be retried", async () => {
		let attempts = 0;
		const h = harness({
			mode: "agent",
			sandbox: "danger-full-access",
			approval: async () => {
				if (++attempts === 1) throw new Error("UI unavailable");
				return true;
			},
		});
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("proposal")).toMatchObject({ approved: false });
		expect(h.session.permissionMode).toBe("plan");
		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");
	});

	test("abort while real ExitPlanMode is awaiting UI cannot approve or execute the following Write", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const h = harness({
			mode: "plan",
			approval: () => {
				entered.resolve();
				return release.promise;
			},
			steps: [
				{
					toolCalls: [
						{ name: "ExitPlanMode", arguments: { plan: "proposal" } },
						{ name: "Write", arguments: {} },
					],
				},
			],
		});
		const run = h.session.prompt("go");
		try {
			await entered.promise;
			expect(h.session.isRunning).toBe(true);
			expect(h.session.permissionMode).toBe("plan");
			expect(h.writes).toBe(0);
			h.session.abort();
		} finally {
			release.resolve(true);
		}
		expect(await run).toBe("aborted");
		expect(h.session.permissionMode).toBe("plan");
		expect(h.writes).toBe(0);
		expect(h.faux.receivedContexts).toHaveLength(1);
		const results = h.session.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0].content).toEqual([{ type: "text", text: expect.stringContaining("canceled") }]);
		expect(results[1].isError).toBe(true);
	});

	test("an approval that lands after the abort does not lift plan mode", async () => {
		// The race the signal is for: the user answers the dialog at the same moment
		// the run is aborted — Enter and Ctrl+C a few milliseconds apart. The answer
		// is real, and it is about a run that is over, so it must not count. This
		// session is never `abort()`ed, which is what makes the check under test the
		// signal's rather than the session's interrupt latch.
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const h = harness({
			mode: "plan",
			approval: () => {
				entered.resolve();
				return release.promise;
			},
		});
		const controller = new AbortController();
		h.callbacks.enterPlanMode();
		const pending = h.callbacks.requestPlanApproval("proposal", controller.signal);
		await entered.promise;

		controller.abort();
		release.resolve(true);

		expect(await pending).toEqual({ approved: false, feedback: "Plan approval canceled" });
		expect(h.session.permissionMode).toBe("plan");
	});

	test("pending approval cannot change a swapped or detached session", async () => {
		for (const detach of [false, true]) {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const h = harness({
				mode: "agent",
				sandbox: "danger-full-access",
				approval: () => {
					entered.resolve();
					return release.promise;
				},
			});
			h.callbacks.enterPlanMode();
			const pending = h.callbacks.requestPlanApproval("proposal");
			const replacement = new AgentSession({
				model: FAUX_MODEL,
				permissionMode: "ask",
				deps: { streamFn: h.faux.streamFn },
			});
			try {
				await entered.promise;
				h.swap(detach ? null : replacement);
			} finally {
				release.resolve(true);
			}
			expect(await pending).toMatchObject({ approved: false });
			expect(h.session.permissionMode).toBe("plan");
			expect(replacement.permissionMode).toBe("ask");
		}
	});

	test("the review surface answers instead of the permission dialog, and its sentence reaches the retry", async () => {
		let attempts = 0;
		const h = harness({
			mode: "agent",
			sandbox: "danger-full-access",
			review: async () =>
				++attempts === 1 ? { approved: false, feedback: "Keep the old loader behind a flag" } : { approved: true },
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", { plan: "first" }),
				call("Write"),
				call("ExitPlanMode", { plan: "first, behind a flag" }),
				call("Write"),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		// The review is the question that was asked; the boolean permission dialog
		// would be the same question twice, without the sentence that is the answer.
		expect(h.reviews.map((entry) => entry.plan)).toEqual(["first", "first, behind a flag"]);
		expect(h.dialogs).toEqual([]);
		expect(h.writes).toBe(1);
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");

		const results = h.session.messages.filter((m) => m.role === "toolResult");
		// The rejection the model reads carries what the reviewer typed, which is
		// the whole reason the review surface exists.
		expect(JSON.stringify(results[1]?.content)).toContain("Feedback: Keep the old loader behind a flag");
		expect(results[2]?.isError).toBe(true);
	});

	test("a review rejection without a sentence is a plain keep-planning answer", async () => {
		const h = harness({
			mode: "plan",
			review: async () => ({ approved: false }),
			steps: [call("ExitPlanMode", { plan: "proposal" }), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.dialogs).toEqual([]);
		expect(h.session.permissionMode).toBe("plan");
		const results = h.session.messages.filter((m) => m.role === "toolResult");
		const text = JSON.stringify(results[0]?.content);
		expect(text).toContain("Plan rejected by the user.");
		expect(text).not.toContain("Feedback:");
	});

	test("null from the review surface is reported as canceled, not as a verdict", async () => {
		const h = harness({
			mode: "plan",
			review: async () => null,
			steps: [call("ExitPlanMode", { plan: "proposal" }), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.session.permissionMode).toBe("plan");
		const results = h.session.messages.filter((m) => m.role === "toolResult");
		expect(JSON.stringify(results[0]?.content)).toContain("Plan approval canceled");
	});

	test("a host with no review surface keeps the permission dialog", async () => {
		const h = harness({ mode: "agent", sandbox: "danger-full-access" });
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.reviews).toEqual([]);
		expect(h.dialogs).toEqual([{ name: "ExitPlanMode", input: { plan: "proposal" } }]);
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");
	});

	test("the run's signal travels to the review surface with the plan", async () => {
		const h = harness({ mode: "agent", review: async () => ({ approved: false }) });
		h.callbacks.enterPlanMode();
		const controller = new AbortController();
		await h.callbacks.requestPlanApproval("proposal", controller.signal);
		expect(h.reviews).toHaveLength(1);
		expect(h.reviews[0]?.signal).toBe(controller.signal);
	});

	test("a /mode entry records the pre-plan pair once, and approval restores it", async () => {
		const h = harness({ mode: "ask", sandbox: "workspace-write", review: async () => ({ approved: true }) });
		// The user-driven door records before moving the session; recording itself
		// does not enter plan mode.
		h.callbacks.recordPlanEntry?.();
		expect(h.session.permissionMode).toBe("ask");
		h.session.setMode("plan");
		// A second record while already in plan mode must not overwrite the pair the
		// cycle started from with `plan` itself.
		h.callbacks.recordPlanEntry?.();
		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("ask");
		expect(h.session.sandbox).toBe("workspace-write");
	});

	test("a Shift+Tab entry hands the pair the session has already left", async () => {
		const h = harness({ mode: "plan", review: async () => ({ approved: true }) });
		// Shift+Tab applies the move before the host hears about it, so the old pair
		// cannot be read off the session; the host passes it explicitly.
		h.callbacks.recordPlanEntry?.({ mode: "agent", sandbox: "danger-full-access" });
		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");
	});

	test("a second cycle after an approval restores the pair it left, not the first cycle's", async () => {
		const h = harness({ mode: "agent", sandbox: "workspace-write", review: async () => ({ approved: true }) });
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("first")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");

		h.session.setMode("ask", "workspace-write");
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("second")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("ask");
		expect(h.session.sandbox).toBe("workspace-write");
	});

	test("a manual /mode exit does not leave the first cycle's pair for the next approval", async () => {
		const h = harness({ mode: "agent", sandbox: "workspace-write", review: async () => ({ approved: true }) });
		h.callbacks.enterPlanMode();
		// Leave plan by hand. No approval runs, so nothing deletes the snapshot the
		// first cycle saved; the next entry has to replace it.
		h.session.setMode("ask", "workspace-write");
		// The `/mode plan` path records the pair before moving the session.
		h.callbacks.recordPlanEntry?.();
		h.session.setMode("plan", "workspace-write");

		expect(await h.callbacks.requestPlanApproval("second")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("ask");
		expect(h.session.sandbox).toBe("workspace-write");
	});

	test("a manual Shift+Tab exit replaces the stale snapshot with the pair it names", async () => {
		const h = harness({ mode: "agent", sandbox: "danger-full-access", review: async () => ({ approved: true }) });
		h.callbacks.enterPlanMode();
		// The same manual exit, through the other door: Shift+Tab moves the session
		// first and then reports the pair it left, so the record must override the
		// stale first-cycle snapshot even though the live session is already `plan`.
		h.session.setMode("ask", "workspace-write");
		h.session.setMode("plan", "workspace-write");
		h.callbacks.recordPlanEntry?.({ mode: "ask", sandbox: "workspace-write" });

		expect(await h.callbacks.requestPlanApproval("second")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("ask");
		expect(h.session.sandbox).toBe("workspace-write");
	});

	test("a record of plan itself is not a snapshot, so approval still restores the prior pair", async () => {
		const h = harness({ mode: "agent", sandbox: "workspace-write", review: async () => ({ approved: true }) });
		h.callbacks.enterPlanMode();
		// `plan` is never a legitimate "pair left for plan mode", whichever door
		// names it. Accepting it would overwrite the entry's snapshot and make the
		// approval put the session back into the mode it is already in.
		h.callbacks.recordPlanEntry?.({ mode: "plan", sandbox: "workspace-write" });

		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("workspace-write");
	});

	test("the mode-change hook fires on a model-driven entry and on the approval that ends it", async () => {
		const h = harness({
			mode: "agent",
			steps: [call("EnterPlanMode"), call("ExitPlanMode", { plan: "proposal" }), { text: "done" }],
		});
		expect(h.modeChanges).toBe(0);
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.modeChanges).toBe(2);

		// The user-driven door reports through recordPlanEntry, which only records:
		// the host's own badge/persist already ran on that path, and a second
		// publish here would be work nobody asked for.
		const user = harness({ mode: "ask" });
		user.callbacks.recordPlanEntry?.();
		user.session.setMode("plan");
		expect(user.modeChanges).toBe(0);
	});

	test("mode bookkeeping is per session and per entry, not a single captured startup mode", async () => {
		const h = harness({ mode: "agent", sandbox: "danger-full-access" });
		h.callbacks.enterPlanMode();
		const next = new AgentSession({
			model: FAUX_MODEL,
			permissionMode: "ask",
			deps: { streamFn: h.faux.streamFn },
		});
		h.swap(next);
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("next")).toEqual({ approved: true });
		expect(next.permissionMode).toBe("ask");
		h.swap(h.session);
		expect(await h.callbacks.requestPlanApproval("original")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");
		// The whole point of the pair: the sandbox has to come back too, or
		// approving a plan silently re-confines a session the user un-confined.
		expect(h.session.sandbox).toBe("danger-full-access");
		h.session.setMode("ask", "workspace-write");
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("new cycle")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("ask");
		expect(h.session.sandbox).toBe("workspace-write");
	});
});

// ---------------------------------------------------------------------------
// The approval's second product: the task board
// ---------------------------------------------------------------------------

/** The text blocks a tool result carries, joined for readable assertions. */
function textOf(result: { content: readonly unknown[] }): string {
	return result.content
		.map((block) =>
			typeof block === "object" && block !== null && "text" in block ? String((block as { text: unknown }).text) : "",
		)
		.join("\n");
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshSessionStore(): SessionStore {
	const store = SessionStore.startNew(
		mkdtempSync(join(tmpdir(), "lbb-plan-life-cwd-")),
		mkdtempSync(join(tmpdir(), "lbb-plan-life-home-")),
	);
	roots.push(store.path);
	return store;
}

/** A lifecycle wired the way the REPL wires it, over in-memory state a test can read. */
function boardLifecycle(tasks: TaskStore, snapshots: PlanSnapshot[]): PlanLifecycle {
	return {
		record: (snapshot) => snapshots.push(snapshot),
		read: () => snapshots.at(-1) ?? null,
		createTasks: (steps) => createPlanTasks(tasks, steps),
	};
}

describe("an approved plan and the task board", () => {
	test("steps become pending tasks in order, and the approval says so", async () => {
		const tasks = new TaskStore();
		const snapshots: PlanSnapshot[] = [];
		const h = harness({
			mode: "agent",
			lifecycle: boardLifecycle(tasks, snapshots),
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", {
					plan: "Two steps",
					steps: [{ subject: "Run tests" }, { subject: "Write up", description: "a summary of what failed" }],
				}),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(tasks.list().map((t) => ({ subject: t.subject, description: t.description, status: t.status }))).toEqual([
			{ subject: "Run tests", description: "Run tests", status: "pending" },
			{ subject: "Write up", description: "a summary of what failed", status: "pending" },
		]);
		// Proposed before the dialog, approved after it: the file keeps both, and
		// the approved one is what a re-entry reads.
		expect(snapshots.map((s) => s.approved)).toEqual([false, true]);
		expect(snapshots.at(-1)?.steps).toEqual([
			{ subject: "Run tests" },
			{ subject: "Write up", description: "a summary of what failed" },
		]);
		const text = JSON.stringify(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.content);
		expect(text).toContain("2 tasks added to the task board");
		expect(text).toContain("pending");
		expect(text).toContain("archived");
	});

	test("a rejected plan creates no tasks and records no approval", async () => {
		const tasks = new TaskStore();
		const snapshots: PlanSnapshot[] = [];
		const h = harness({
			mode: "agent",
			approval: async () => false,
			lifecycle: boardLifecycle(tasks, snapshots),
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", { plan: "Not yet", steps: [{ subject: "Never created" }] }),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(tasks.list()).toEqual([]);
		expect(snapshots.map((s) => s.approved)).toEqual([false]);
		expect(snapshots.at(-1)?.plan).toBe("Not yet");
		expect(JSON.stringify(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.content)).toContain(
			"Plan rejected by the user.",
		);
	});

	test("no steps means the approval asks for a board instead of inventing one", async () => {
		const tasks = new TaskStore();
		const snapshots: PlanSnapshot[] = [];
		const h = harness({
			mode: "agent",
			lifecycle: boardLifecycle(tasks, snapshots),
			steps: [call("EnterPlanMode"), call("ExitPlanMode", { plan: "A plan with no steps" }), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(tasks.list()).toEqual([]);
		const text = JSON.stringify(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.content);
		expect(text).toContain("TaskCreate");
		expect(text).toContain("archived");
		expect(text).not.toContain("added to the task board");
	});

	test("a host with no board approves without promising tasks", async () => {
		const snapshots: PlanSnapshot[] = [];
		const h = harness({
			mode: "agent",
			// No `createTasks`: a host (a test, an embedder) with no board behind it.
			lifecycle: {
				record: (snapshot) => snapshots.push(snapshot),
				read: () => snapshots.at(-1) ?? null,
			},
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", { plan: "Portable plan", steps: [{ subject: "One" }] }),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(snapshots.map((s) => s.approved)).toEqual([false, true]);
		const text = JSON.stringify(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.content);
		expect(text).toContain("archived");
		// No board means no count to report, and a sentence promising tasks the
		// session cannot see would be the one lie this result must not tell.
		expect(text).not.toContain("task board");
	});

	test("approving the same steps twice does not double the board", async () => {
		const tasks = new TaskStore();
		const snapshots: PlanSnapshot[] = [];
		const steps = [{ subject: "Run tests" }, { subject: "Write up" }];
		const h = harness({
			mode: "agent",
			review: async () => ({ approved: true }),
			lifecycle: boardLifecycle(tasks, snapshots),
			steps: [
				call("EnterPlanMode"),
				call("ExitPlanMode", { plan: "same plan", steps }),
				// A second cycle over the same plan: re-entering is how a model would
				// retry an approval, and the board must not grow a duplicate row for it.
				call("EnterPlanMode"),
				call("ExitPlanMode", {
					plan: "same plan",
					steps: [...steps, { subject: "Run tests" }],
				}),
				{ text: "done" },
			],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(tasks.list().map((t) => t.subject)).toEqual(["Run tests", "Write up"]);
		const results = h.session.messages.filter((m) => m.role === "toolResult");
		expect(JSON.stringify(results.at(-1)?.content)).toContain("No new tasks were added to the task board");
	});

	test("only unfinished tasks block a step; completed work is history", () => {
		const tasks = new TaskStore();
		const done = tasks.create("Run tests", "the previous pass");
		tasks.update(done.id, { status: "completed" });

		expect(createPlanTasks(tasks, [{ subject: "Run tests" }, { subject: "Run tests" }])).toBe(1);
		expect(tasks.list().map((t) => t.subject)).toEqual(["Run tests", "Run tests"]);
		expect(createPlanTasks(tasks, [])).toBe(0);
		// A host with no board gets undefined rather than a fabricated count.
		expect(createPlanTasks(undefined, [{ subject: "One" }])).toBeUndefined();
	});

	test("ExitPlanMode outside plan mode keeps today's answer and creates nothing", async () => {
		const tasks = new TaskStore();
		const snapshots: PlanSnapshot[] = [];
		const h = harness({
			mode: "agent",
			lifecycle: boardLifecycle(tasks, snapshots),
			steps: [call("ExitPlanMode", { plan: "Not a planning cycle", steps: [{ subject: "One" }] }), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");

		expect(tasks.list()).toEqual([]);
		expect(snapshots).toEqual([]);
		const text = JSON.stringify(h.session.messages.filter((m) => m.role === "toolResult")[0]?.content);
		expect(text).toBe(
			JSON.stringify([{ type: "text", text: "Plan approved. Plan mode restrictions lifted — you may now implement." }]),
		);
	});
});

describe("re-entering plan mode with a saved plan", () => {
	test("the saved plan, its state, its step count, and the truncation marker are injected", async () => {
		const saved: PlanSnapshot = {
			plan: `${"x".repeat(MAX_INJECTED_PLAN_CHARS)}TAIL`,
			approved: true,
			steps: [{ subject: "One" }, { subject: "Two" }],
			at: "2026-10-17T02:03:04.000Z",
		};
		const h = harness({ mode: "agent", lifecycle: { read: () => saved } });
		const [enter] = createPlanModeTools(h.callbacks);

		const text = textOf(await enter.call({}, {} as never));
		expect(text).toContain("earlier in this session");
		expect(text).toContain("ExitPlanMode");
		expect(text).toContain("approved");
		expect(text).toContain("2 steps");
		expect(text).toContain("2026-10-17T02:03:04.000Z");
		// Bounded: the plan is injected, not the whole of it, and the cut is named.
		expect(text).toContain("[truncated 4 chars]");
		expect(text).not.toContain("TAIL");
		expect(text).toContain("x".repeat(MAX_INJECTED_PLAN_CHARS));
	});

	test("with nothing saved, the entry text is exactly what it always was", async () => {
		const h = harness({ mode: "agent" });
		const [enter] = createPlanModeTools(h.callbacks);

		expect(textOf(await enter.call({}, {} as never))).toBe(
			"Plan mode is active: only read-only tools are allowed. Writes, shell commands, " +
				"and subagent tools are denied. Use AskUserQuestion for decisions only the user " +
				"can make. When the approach is ready, call ExitPlanMode with the plan.",
		);
	});
});

// ---------------------------------------------------------------------------
// /plan and /todo
// ---------------------------------------------------------------------------

function infoTexts(store: { get: () => UiState }): string {
	return store
		.get()
		.entries.filter((entry) => entry.kind === "info")
		.map((entry) => (entry as { text: string }).text)
		.join("\n");
}

function commandCtx(options: { store?: SessionStore; tasks?: TaskStore } = {}) {
	const ui = createStore<UiState>(initialUiState(false));
	let currentStore = options.store;
	const tasks = options.tasks;
	// A real session with a scripted transport: neither command has any business
	// moving its mode or sending it a prompt, and a stubbed-out session would not
	// be able to say whether either happened.
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		permissionMode: "agent",
		sandbox: "workspace-write",
		deps: { streamFn: faux.streamFn },
	});
	const ctx = {
		getSession: () => session,
		handle: { store: ui },
		sessionStore: () => currentStore,
		taskSnapshot: () => tasks?.snapshot(),
		commands: [],
	} as unknown as AppCommandContext;
	return {
		ctx,
		ui,
		session,
		faux,
		text: () => infoTexts(ui),
		reset() {
			ui.set(() => initialUiState(false));
		},
		setStore(next: SessionStore | undefined) {
			currentStore = next;
		},
	};
}

describe("/plan", () => {
	test("with nothing recorded it says so", () => {
		const h = commandCtx();
		expect(handleAppCommand("/plan", h.ctx)).toBe(true);
		expect(h.text()).toBe("No plan has been recorded in this session yet.");
	});

	test("a proposed plan is printed whole, however long", () => {
		const store = freshSessionStore();
		const longPlan = `${"p".repeat(MAX_INJECTED_PLAN_CHARS)} the tail that must survive`;
		writePlanSnapshot(store, {
			plan: longPlan,
			steps: [{ subject: "One" }],
			approved: false,
			at: "2026-10-17T03:04:05.000Z",
		});
		const h = commandCtx({ store });

		handleAppCommand("/plan", h.ctx);

		expect(h.text()).toContain("proposed");
		expect(h.text()).toContain("1 step");
		expect(h.text()).toContain("2026-10-17T03:04:05.000Z");
		// A command's output is the user's to read; the attachment limit is for
		// what goes back into a turn, not for what they asked to see.
		expect(h.text()).toContain(longPlan);
		expect(h.text()).not.toContain("[truncated");
		// Reading is the whole command: no model call, and the mode pair stays put.
		expect(h.session.permissionMode).toBe("agent");
		expect(h.faux.receivedContexts).toHaveLength(0);
	});

	test("an approved plan reports its state and every step", () => {
		const store = freshSessionStore();
		writePlanSnapshot(store, {
			plan: "Ship it",
			steps: [{ subject: "One" }, { subject: "Two" }, { subject: "Three" }],
			approved: true,
			at: "2026-10-17T04:05:06.000Z",
		});
		const h = commandCtx({ store });

		handleAppCommand("/plan", h.ctx);

		expect(h.text()).toContain("approved");
		expect(h.text()).toContain("3 steps");
		expect(h.text()).toContain("2026-10-17T04:05:06.000Z");
		expect(h.text()).toContain("Ship it");
	});

	test("an argument is refused with usage and prints no plan", () => {
		const store = freshSessionStore();
		writePlanSnapshot(store, { plan: "Saved", approved: false, at: "2026-10-17T00:00:00.000Z" });
		const h = commandCtx({ store });

		handleAppCommand("/plan now", h.ctx);

		expect(h.text()).toContain("Usage: /plan");
		expect(h.text()).not.toContain("Saved");
	});

	test("reads the live session store, so /resume is not answered from the old one", () => {
		const first = freshSessionStore();
		writePlanSnapshot(first, { plan: "the first conversation", approved: false, at: "2026-10-17T00:00:00.000Z" });
		const second = freshSessionStore();
		writePlanSnapshot(second, { plan: "the resumed conversation", approved: true, at: "2026-10-17T00:00:01.000Z" });
		const h = commandCtx({ store: first });

		handleAppCommand("/plan", h.ctx);
		expect(h.text()).toContain("the first conversation");

		h.reset();
		h.setStore(second);
		handleAppCommand("/plan", h.ctx);
		expect(h.text()).toContain("the resumed conversation");
		expect(h.text()).toContain("approved");
	});
});

describe("/todo", () => {
	test("an empty board says so", () => {
		const h = commandCtx({ tasks: new TaskStore() });
		expect(handleAppCommand("/todo", h.ctx)).toBe(true);
		expect(h.text()).toBe("The task board is empty.");
	});

	test("every task is printed with every field", () => {
		const tasks = new TaskStore();
		const first = tasks.create("Run tests", "bun test in packages/coding-agent", "Running tests", "alice");
		const second = tasks.create("Write up", "summarize the failures", "Writing up", "bob", [first.id]);
		tasks.create("Ship it", "tag the release");
		tasks.update(first.id, { status: "in_progress" });
		tasks.update(second.id, { status: "completed" });
		const h = commandCtx({ tasks });

		handleAppCommand("/todo", h.ctx);

		const text = h.text();
		expect(text).toContain("#1 [in_progress] Run tests");
		expect(text).toContain("owner: alice");
		expect(text).toContain("activeForm: Running tests");
		expect(text).toContain("description: bun test in packages/coding-agent");
		expect(text).toContain("#2 [completed] Write up");
		expect(text).toContain("owner: bob");
		expect(text).toContain("activeForm: Writing up");
		expect(text).toContain("blockedBy: 1");
		expect(text).toContain("description: summarize the failures");
		expect(text).toContain("#3 [pending] Ship it");
		expect(text).toContain("description: tag the release");
		// The board is in memory, so printing it must not wake the model either.
		expect(h.session.permissionMode).toBe("agent");
		expect(h.faux.receivedContexts).toHaveLength(0);
	});

	test("reads the live board, so a swap or a task created later is seen", () => {
		const tasks = new TaskStore();
		const h = commandCtx({ tasks });

		handleAppCommand("/todo", h.ctx);
		expect(h.text()).toBe("The task board is empty.");

		tasks.create("Created after the first read", "still shown");
		h.reset();
		handleAppCommand("/todo", h.ctx);
		expect(h.text()).toContain("#1 [pending] Created after the first read");
	});
});
