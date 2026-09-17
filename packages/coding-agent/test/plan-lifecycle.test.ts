import { describe, expect, test } from "bun:test";
import {
	AgentSession,
	buildTool,
	evaluatePermissions,
	type PermissionMode,
	type PermissionRule,
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
		permissionMode: options.mode ?? "default",
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
				return evaluatePermissions(name, input, { mode: ctx.mode, cwd: ctx.cwd, rules: options.rules ?? [allowAll] });
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
	for (const mode of ["default", "acceptEdits", "dontAsk", "bypassPermissions"] as const) {
		test(`${mode}: enter twice, approve, then mutate using restored mode`, async () => {
			const h = harness({
				mode,
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
			expect(h.session.permissionMode).toBe(mode);
			expect(h.writes).toBe(1);
			expect(h.dialogs).toEqual([{ name: "ExitPlanMode", input: { plan: "Implement the agreed change" } }]);
			expect(h.modes).toEqual([
				{ tool: "EnterPlanMode", mode },
				{ tool: "EnterPlanMode", mode: "plan" },
				{ tool: "Write", mode: "plan" },
				{ tool: "ExitPlanMode", mode: "plan" },
				{ tool: "Write", mode },
			]);
			const results = h.session.messages.filter((m) => m.role === "toolResult");
			expect(results.map((m) => m.isError)).toEqual([false, false, true, false, false]);
		});
	}

	test("startup plan mode approves into default without bypassing a Write deny", async () => {
		const h = harness({
			mode: "plan",
			rules: [allowAll, { toolName: "Write", behavior: "deny", source: "policy" }],
			steps: [call("ExitPlanMode", { plan: "proposal" }), call("Write"), { text: "done" }],
		});
		expect(await h.session.prompt("go")).toBe("completed");
		expect(h.session.permissionMode).toBe("default");
		expect(h.dialogs).toHaveLength(1);
		expect(h.writes).toBe(0);
		expect(h.session.messages.filter((m) => m.role === "toolResult").at(-1)?.isError).toBe(true);
	});

	test("rejection preserves plan restrictions; revised approval restores original mode", async () => {
		let attempts = 0;
		const h = harness({
			mode: "acceptEdits",
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
		expect(h.modes.filter((m) => m.tool === "Write").map((m) => m.mode)).toEqual(["plan", "acceptEdits"]);
		expect(h.session.permissionMode).toBe("acceptEdits");
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
			mode: "acceptEdits",
			approval: async () => {
				if (++attempts === 1) throw new Error("UI unavailable");
				return true;
			},
		});
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("proposal")).toMatchObject({ approved: false });
		expect(h.session.permissionMode).toBe("plan");
		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("acceptEdits");
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

	test("pending approval cannot change a swapped or detached session", async () => {
		for (const detach of [false, true]) {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const h = harness({
				mode: "acceptEdits",
				approval: () => {
					entered.resolve();
					return release.promise;
				},
			});
			h.callbacks.enterPlanMode();
			const pending = h.callbacks.requestPlanApproval("proposal");
			const replacement = new AgentSession({
				model: FAUX_MODEL,
				permissionMode: "dontAsk",
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
			expect(replacement.permissionMode).toBe("dontAsk");
		}
	});

	test("mode bookkeeping is per session and per entry, not a single captured startup mode", async () => {
		const h = harness({ mode: "acceptEdits" });
		h.callbacks.enterPlanMode();
		const next = new AgentSession({
			model: FAUX_MODEL,
			permissionMode: "dontAsk",
			deps: { streamFn: h.faux.streamFn },
		});
		h.swap(next);
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("next")).toEqual({ approved: true });
		expect(next.permissionMode).toBe("dontAsk");
		h.swap(h.session);
		expect(await h.callbacks.requestPlanApproval("original")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("acceptEdits");
		h.session.setPermissionMode("default");
		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("new cycle")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("default");
	});
});
