import { describe, expect, test } from "bun:test";
import {
	AgentSession,
	buildTool,
	DEFAULT_MODE_CHOICE,
	evaluatePermissions,
	MODE_CHOICES,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
} from "@labunbun/agent";
import { FAUX_MODEL, type FauxStep, fauxProvider } from "@labunbun/ai";
import { z } from "zod";
import { createPlanModeCallbacks, createPlanModeTools } from "../src/plan-mode.ts";

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
