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
		rules?: PermissionRule[];
	} = {},
) {
	let current: AgentSession | null = null;
	let writes = 0;
	const dialogs: unknown[] = [];
	const modes: Array<{ tool: string; mode: PermissionMode }> = [];
	const callbacks = createPlanModeCallbacks(
		() => current,
		() => ({
			requestPermission: async (name, input) => {
				dialogs.push({ name, input });
				return options.approval ? options.approval() : true;
			},
		}),
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
		modes,
		faux,
		get writes() {
			return writes;
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
