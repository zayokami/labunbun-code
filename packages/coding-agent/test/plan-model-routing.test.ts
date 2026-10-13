/**
 * The plan seat: `roles.plan` moving the session's model for the length of a
 * planning cycle.
 *
 * Plan mode is a mode of the conversation, and which model answers is part of
 * how it runs — a planning seat that never moves the session is a setting with
 * no effect. `EnterPlanMode` swaps onto the plan model; approving the plan puts
 * the previous model back together with the mode and the sandbox, so the
 * implementation the user just approved is carried out on the model they were
 * using. Rejection keeps the plan model, because the cycle is still open. The
 * swap is deliberately not a `/model` switch: nothing is persisted to settings,
 * and a session the user moves mid-plan is their own choice, so the restore
 * only fires while the plan model is still the one in effect.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type Model } from "@labunbun/ai";
import { createPlanModeCallbacks, type PlanModelSwap } from "../src/plan-mode.ts";

const SESSION_MODEL: Model = { ...FAUX_MODEL, id: "session-model" };
const PLAN_MODEL: Model = { ...FAUX_MODEL, id: "plan-model" };
const USER_MODEL: Model = { ...FAUX_MODEL, id: "user-model" };

function harness(options: { planModel?: () => Model | undefined; approval?: () => Promise<boolean> } = {}) {
	let current: AgentSession | null = null;
	const swaps: string[] = [];
	const swap: PlanModelSwap = {
		planModel: options.planModel ?? (() => undefined),
		onModelSwapped: (next) => swaps.push(`${next.provider}/${next.id}`),
	};
	const callbacks = createPlanModeCallbacks(
		() => current,
		() => ({ requestPermission: async () => (options.approval ? options.approval() : true) }),
		swap,
	);
	const session = new AgentSession({
		model: SESSION_MODEL,
		permissionMode: "agent",
		sandbox: "workspace-write",
		// Never run: these tests drive the callbacks directly, and the stream is
		// here only because a session without a transport is not a session.
		deps: { streamFn: fauxProvider([{ text: "unused" }]).streamFn },
	});
	current = session;
	return { session, callbacks, swaps };
}

describe("the plan model seat", () => {
	test("EnterPlanMode swaps to the plan seat and approval puts the session model back", async () => {
		const h = harness({ planModel: () => PLAN_MODEL });

		h.callbacks.enterPlanMode();

		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.model).toBe(PLAN_MODEL);
		// Fired when the model actually moves, so the host can rebuild what binds
		// to a model — the compaction wiring above all.
		expect(h.swaps).toEqual(["faux/plan-model"]);

		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.model).toBe(SESSION_MODEL);
		// And again on the way back, or the status row would keep naming the
		// planner after the session stopped using it.
		expect(h.swaps).toEqual(["faux/plan-model", "faux/session-model"]);
	});

	test("a rejected plan keeps the plan seat, and the revised approval still restores", async () => {
		let attempts = 0;
		const h = harness({ planModel: () => PLAN_MODEL, approval: async () => ++attempts === 2 });

		h.callbacks.enterPlanMode();
		expect(await h.callbacks.requestPlanApproval("first")).toEqual({ approved: false });
		// The cycle is still open: the model that will revise the plan is the one
		// that designed it.
		expect(h.session.model).toBe(PLAN_MODEL);
		expect(h.session.permissionMode).toBe("plan");
		expect(h.swaps).toEqual(["faux/plan-model"]);

		expect(await h.callbacks.requestPlanApproval("revised")).toEqual({ approved: true });
		expect(h.session.model).toBe(SESSION_MODEL);
		expect(h.session.permissionMode).toBe("agent");
	});

	test("no plan seat means no swap at all — the pre-roles behaviour, unchanged", async () => {
		const h = harness({ planModel: () => undefined });

		h.callbacks.enterPlanMode();
		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.model).toBe(SESSION_MODEL);
		expect(h.swaps).toEqual([]);

		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.model).toBe(SESSION_MODEL);
		expect(h.swaps).toEqual([]);
	});

	test("a plan seat equal to the session model is not a swap", async () => {
		const h = harness({ planModel: () => SESSION_MODEL });

		h.callbacks.enterPlanMode();

		// Same model: switching would be a no-op the host would still pay a
		// compaction rebuild for, so it is not a swap and nothing is reported.
		expect(h.session.model).toBe(SESSION_MODEL);
		expect(h.swaps).toEqual([]);
	});

	test("the same id on another provider is a different seat", async () => {
		// The identity `resolveModel` guarantees is provider plus id: a gateway
		// serving the same id it also serves directly is a different row with a
		// different wire, and skipping the swap on the id alone would run plan
		// mode on the provider the user's seat did not name.
		const other: Model = { ...FAUX_MODEL, provider: "other", id: SESSION_MODEL.id };
		const h = harness({ planModel: () => other });

		h.callbacks.enterPlanMode();

		expect(h.session.model).toBe(other);
		expect(h.swaps).toEqual(["other/session-model"]);
	});

	test("a session the user moves mid-plan outranks the restore", async () => {
		const h = harness({ planModel: () => PLAN_MODEL });

		h.callbacks.enterPlanMode();
		// `/model` while the plan dialog is up. Restoring the pre-plan model would
		// silently undo the user's own choice one prompt after they made it.
		h.session.setModel(USER_MODEL);

		expect(await h.callbacks.requestPlanApproval("proposal")).toEqual({ approved: true });
		expect(h.session.model).toBe(USER_MODEL);
		expect(h.swaps).toEqual(["faux/plan-model"]);
	});
});
