/**
 * YOLO is a session posture, not a permission mode, and this file is what
 * keeps it one.
 *
 * The three tests below pin the state machine: only `enableYolo` turns it on,
 * it refuses the three combinations the design rules out, and any mode change
 * turns it off. The structural half — that no settings key, CLI flag, policy
 * snapshot or picker row can carry it — is in `mode-enum.test.ts` beside the
 * existing single-source walks.
 */
import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { AgentSession, type AgentSessionOptions } from "../src/index.ts";

function makeSession(options: Omit<Partial<AgentSessionOptions>, "model" | "deps"> = {}) {
	// No provider call is made by any case here: the flag is session state, and
	// building the session does not stream.
	const faux = fauxProvider([{ text: "unused" }]);
	return new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn }, ...options });
}

describe("the YOLO flag", () => {
	test("starts off, and only enableYolo turns it on", () => {
		const session = makeSession();
		expect(session.yolo).toBe(false);
		expect(session.enableYolo()).toEqual({ ok: true });
		expect(session.yolo).toBe(true);
	});

	test("a session can be asked to leave it at any time", () => {
		const session = makeSession();
		session.enableYolo();
		session.disableYolo();
		expect(session.yolo).toBe(false);
	});

	/**
	 * The plan promise is that mutations are denied; a standing allow on every
	 * tool would contradict it, and the plan gate would win above YOLO anyway.
	 */
	test("plan mode refuses it, naming the door out", () => {
		const session = makeSession({ permissionMode: "plan", sandbox: "workspace-write" });
		const result = session.enableYolo();
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain("plan mode");
		expect(session.yolo).toBe(false);
	});

	/**
	 * YOLO's whole distinction from Codex's posture is that the sandbox stays.
	 * A session whose sandbox is already off has nothing for it to keep, so the
	 * answer is to move to a confined mode first.
	 */
	test("danger-full-access refuses it, naming the confined row", () => {
		const session = makeSession({ permissionMode: "agent", sandbox: "danger-full-access" });
		const result = session.enableYolo();
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain("sandbox");
		expect(session.yolo).toBe(false);
	});

	/**
	 * The flag is read per call, so flipping it mid-run would change decisions
	 * whose consequences are already in flight. The refusal is the session's,
	 * not the command's, so it holds for every caller.
	 */
	test("a running turn refuses it", async () => {
		// The delay only has to outlive the `enableYolo` call below. Keeping it
		// short matters: aborting this stream still awaits its timer on a backend
		// that does not observe the signal, and the default per-test timeout is 5s.
		const faux = fauxProvider([{ text: "late", delayMs: 2_000 }]);
		const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
		const run = session.prompt("go");
		for (let i = 0; i < 100 && !session.isRunning; i++) await new Promise((r) => setTimeout(r, 5));
		expect(session.isRunning).toBe(true);

		const result = session.enableYolo();
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain("running");
		expect(session.yolo).toBe(false);
		session.abort();
		await run.catch(() => {});
	}, 15_000);

	/**
	 * `setMode` is the single owner of the transition: `/mode`, the picker,
	 * Shift+Tab and the model's own plan entry all go through it, so clearing
	 * here is what makes "the two postures never coexist" true for every caller
	 * rather than for the ones that remember.
	 */
	test("any mode change clears it, including one that keeps the same axes", () => {
		const session = makeSession({ permissionMode: "agent", sandbox: "workspace-write" });
		session.enableYolo();
		session.setMode("agent", "workspace-write");
		expect(session.yolo).toBe(false);
	});
});
