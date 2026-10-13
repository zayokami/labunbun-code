/**
 * Subagent handles: what SendMessage and TaskStop make of an id, and the
 * user-side control that stops and retries through the same mechanics.
 *
 * Task used to be one-shot — spawn, report, gone — so a follow-up meant a
 * fresh subagent that had none of the first one's context. The handle, the id
 * line every Task result now ends with, is the way back to the conversation,
 * and each state of it has a different answer: a finished subagent continues,
 * a running one is steered, a stopped one is refused, and an evicted one is
 * gone for good — refused rather than pretended about, because nothing about
 * its conversation was written down anywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, buildTool, type PermissionMode, SessionStore, type ToolResult } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { z } from "zod";
import { type SubagentHandle, SubagentRegistry, subagentStatus } from "../src/subagent-registry.ts";
import { createSubagentTools } from "../src/subagents.ts";

function echoTool(): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: any) => ({ content: [{ type: "text", text: input.text }] }),
	});
}

/**
 * Blocks until the test releases it or the session aborts — stands in for a
 * slow subagent step, so the handle can be observed while it is live. An
 * abort has to settle it, exactly as a real tool would: a fixture that only
 * releases on demand turns any abort path into a hang.
 */
function gatedTool(onEnter: () => void, release: Promise<void>): AnyTool {
	return buildTool({
		name: "gate",
		description: "waits for the test, or for an abort",
		inputSchema: z.object({}),
		call: async (_input, ctx) => {
			onEnter();
			await Promise.race([
				release,
				new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })),
			]);
			return { content: [{ type: "text", text: ctx.signal.aborted ? "gate aborted" : "gate released" }] };
		},
	});
}

function callCtx() {
	return {
		callId: "t1",
		signal: new AbortController().signal,
		cwd: process.cwd(),
		sandbox: "workspace-write" as const,
		network: { access: "enabled" as const, domains: [] },
		onUpdate: () => {},
	};
}

/**
 * Await, but give up after `ms`: a run that never happened fails the test
 * instead of hanging it — a gate waiting on a stop that failed to abort is
 * exactly the shape, and a hung test would take the whole file with it.
 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function text(result: ToolResult): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The id line's payload: how the parent model gets a handle to pass back. */
function idOf(result: ToolResult): string {
	const joined = text(result);
	const match = /\[subagent id: (sidechain-[^\]]+)\]/.exec(joined);
	if (!match) throw new Error(`no id line in: ${joined}`);
	return match[1] ?? "";
}

/**
 * The id of a subagent whose Task call has not returned yet — read from the
 * start entry the spawn wrote into the parent's session file, which is the
 * only record of a run that is still going.
 */
function liveIdOf(store: SessionStore): string {
	const started = store
		.linearEntries()
		.filter((e) => e.type === "custom" && (e as { kind?: string }).kind === "subagent_start");
	const first = started[0] as unknown as { data: { sidechainId: string } } | undefined;
	if (!first) throw new Error("no subagent_start entry yet");
	return first.data.sidechainId;
}

describe("subagent handles", () => {
	test("a continuation runs on the same conversation, not a fresh one", async () => {
		// The whole point of the handle: "what did I tell you to remember?" has
		// an answer only if the second prompt travels on the first run's session.
		// A second Task call — the only shape before this — would see nothing.
		const faux = fauxProvider([{ text: "FIRST REPORT" }, { text: "SECOND REPORT" }]);
		const [task, sendMessage] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
		});

		const first = await task.call({ description: "x", prompt: "remember that the answer is 41" }, callCtx());
		expect(text(first)).toContain("FIRST REPORT");
		const id = idOf(first);

		const second = await sendMessage.call({ sidechain_id: id, message: "what is the answer?" }, callCtx());
		expect(text(second)).toContain("SECOND REPORT");
		expect(text(second)).toContain("[subagent id:");

		// The second request carried the first run's whole conversation: the
		// original task, the report, and the follow-up as the newest turn.
		const messages = JSON.stringify(faux.receivedContexts[1]?.messages);
		expect(messages).toContain("remember that the answer is 41");
		expect(messages).toContain("FIRST REPORT");
		expect(messages).toContain("what is the answer?");
	});

	test("a stopped subagent is refused, and the refusal does not run it anyway", async () => {
		// "Treat its work as cancelled" has to mean the model request is never
		// made — a refusal that still prompted the subagent would be the stop
		// being cosmetic.
		const faux = fauxProvider([{ text: "REPORT" }]);
		const [task, sendMessage, taskStop] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
		});

		const first = await task.call({ description: "x", prompt: "do it" }, callCtx());
		const id = idOf(first);

		const stopped = await taskStop.call({ sidechain_id: id }, callCtx());
		expect(text(stopped)).toContain("had already finished");
		expect(text(stopped)).toContain("will not be continued");

		const refused = await sendMessage.call({ sidechain_id: id, message: "keep going" }, callCtx());
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain("was stopped");
		expect(text(refused)).toContain("cancelled");
		// No second model request: the conversation was not touched.
		expect(faux.receivedContexts).toHaveLength(1);
	});

	test("TaskStop on a running subagent aborts it, and it stays stopped", async () => {
		// A live handle is addressable before its Task call returns — that is
		// what makes stopping possible at all — and this test reads the id the
		// way anything watching the parent's session file would: from the start
		// entry, the moment the run began.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-handles-")),
			mkdtempSync(join(tmpdir(), "lbb-handles-home-")),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const faux = fauxProvider([{ toolCalls: [{ name: "gate", arguments: {} }] }, { text: "never reached" }]);
		const [task, sendMessage, taskStop] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [gatedTool(() => entered.resolve(), release.promise)],
			definitions: () => [],
			store: () => store,
		});

		const call = task.call({ description: "x", prompt: "block" }, callCtx());
		await entered.promise;
		const liveId = liveIdOf(store);

		const stopped = await taskStop.call({ sidechain_id: liveId }, callCtx());
		expect(text(stopped)).toContain("was stopped");

		const result = await call;
		expect(text(result)).toContain("[subagent ended: aborted]");
		expect(text(result)).toContain("[subagent id:");
		// The abort ended the run inside the first model call; the script's
		// second entry was never requested.
		expect(faux.receivedContexts).toHaveLength(1);

		const refused = await sendMessage.call({ sidechain_id: liveId, message: "go on" }, callCtx());
		expect(refused.isError).toBe(true);
		expect(faux.receivedContexts).toHaveLength(1);
	});

	test("a message to a running subagent is queued for its next turn", async () => {
		// A live target cannot take a second prompt — prompt() refuses to start
		// twice — so the message rides the running loop's steering queue and is
		// read ahead of its next request. The assertion is on that next request:
		// a "queued" answer whose message never arrived would read as delivered.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-queued-")),
			mkdtempSync(join(tmpdir(), "lbb-queued-home-")),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const faux = fauxProvider([{ toolCalls: [{ name: "gate", arguments: {} }] }, { text: "FINAL" }]);
		const [task, sendMessage] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [gatedTool(() => entered.resolve(), release.promise)],
			definitions: () => [],
			store: () => store,
		});

		const call = task.call({ description: "x", prompt: "start" }, callCtx());
		await entered.promise;

		const queued = await sendMessage.call({ sidechain_id: liveIdOf(store), message: "steer this in" }, callCtx());
		expect(queued.isError).toBeFalsy();
		expect(text(queued)).toContain("still running");
		expect(text(queued)).toContain("queued");

		release.resolve();
		await call;
		expect(JSON.stringify(faux.receivedContexts[1]?.messages)).toContain("steer this in");
	});

	test("a continuation re-reads the permission axes, so a mode change reaches it", async () => {
		// Spawn in `agent` (auto-allow), then move the session to `ask` with no
		// allow rules: the same echo call must run in the first continuation and
		// be refused in the second. The pair is the point — a fixture that only
		// ran one of them would not say whether the call was ever permitted.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-axes-")),
			mkdtempSync(join(tmpdir(), "lbb-axes-home-")),
		);
		let mode: PermissionMode = "agent";
		const faux = fauxProvider([
			{ text: "R1" },
			{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] },
			{ text: "R2" },
			{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] },
			{ text: "R3" },
		]);
		const [task, sendMessage] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			store: () => store,
			permissionMode: () => mode,
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
		});

		const first = await task.call({ description: "x", prompt: "go" }, callCtx());
		const id = idOf(first);
		await sendMessage.call({ sidechain_id: id, message: "again" }, callCtx());

		mode = "ask";
		await sendMessage.call({ sidechain_id: id, message: "yet again" }, callCtx());

		// What each run's tools did, from the parent's own record: the mode the
		// session moved into is the mode the continuation ran under.
		const ends = store
			.linearEntries()
			.filter((e) => e.type === "custom" && (e as { kind?: string }).kind === "subagent_end")
			.map((e) => (e as unknown as { data: { toolCalls: string[] } }).data.toolCalls);
		expect(ends).toEqual([[], ["echo: ok"], ["echo: error"]]);
	});

	test("only the last eight finished subagents stay addressable", async () => {
		// Each retained handle holds a whole conversation in memory, so the
		// registry is capped and evicts oldest-first. The evicted id gets the
		// honest error — no revival is promised, because none is possible —
		// while the second-oldest still answers: with nine finished, exactly
		// the oldest is gone, which is where the cap sits rather than the
		// registry having simply broken.
		const reports = Array.from({ length: 9 }, (_, i) => ({ text: `REPORT ${i}` }));
		const faux = fauxProvider([...reports, { text: "SECOND OLDEST" }, { text: "REVIVED" }]);
		const [task, sendMessage] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
		});

		const ids: string[] = [];
		for (let i = 0; i < 9; i++) {
			const result = await task.call({ description: "x", prompt: `task ${i}` }, callCtx());
			ids.push(idOf(result));
		}

		const evicted = await sendMessage.call({ sidechain_id: ids[0] ?? "", message: "still there?" }, callCtx());
		expect(evicted.isError).toBe(true);
		expect(text(evicted)).toContain("Unknown or expired subagent");
		expect(text(evicted)).toContain("start a new Task");

		const secondOldest = await sendMessage.call({ sidechain_id: ids[1] ?? "", message: "and you?" }, callCtx());
		expect(text(secondOldest)).toContain("SECOND OLDEST");

		const newest = await sendMessage.call({ sidechain_id: ids[8] ?? "", message: "again" }, callCtx());
		expect(text(newest)).toContain("REVIVED");
	});

	test("TaskStop during a continuation aborts it too", async () => {
		// The stop has to reach whichever run is live, not just the first: a
		// handle whose state was never turned back to live for its second run
		// would answer a stop with a mark — and keep running underneath it.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-restop-")),
			mkdtempSync(join(tmpdir(), "lbb-restop-home-")),
		);
		// Resolved with a value, not void: the timeout path yields undefined,
		// so a void resolve here would make "arrived" and "timed out" the same
		// observation.
		const entered = Promise.withResolvers<"entered">();
		const release = Promise.withResolvers<void>();
		const faux = fauxProvider([
			{ text: "R1" },
			{ toolCalls: [{ name: "gate", arguments: {} }] },
			{ text: "never reached" },
		]);
		const [task, sendMessage, taskStop] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [gatedTool(() => entered.resolve("entered"), release.promise)],
			definitions: () => [],
			store: () => store,
		});

		const first = await task.call({ description: "x", prompt: "go" }, callCtx());
		const id = idOf(first);

		const call = sendMessage.call({ sidechain_id: id, message: "keep going" }, callCtx());
		expect(await within(entered.promise, 2000)).toBe("entered");

		const stopped = await taskStop.call({ sidechain_id: id }, callCtx());
		expect(text(stopped)).toContain("was stopped");
		// The abort settles the gate on its own; this release is a fallback so
		// that a stop failing to abort shows up as a failed assertion rather
		// than as a test that never finishes.
		release.resolve();
		const result = await call;
		expect(text(result)).toContain("[subagent ended: aborted]");
		expect(faux.receivedContexts).toHaveLength(2);
	});
});

/**
 * The registry the host reads: the same run the tests above drive, seen from
 * outside the tool closure. The end-to-end path matters here — a record that
 * never gets a finish, or a title that never gets taken from the call, is
 * invisible to tests that only exercise the registry directly.
 */
describe("the lifecycle record", () => {
	test("a finished spawn is observable: title, state, and both timestamps", async () => {
		const registry = new SubagentRegistry();
		const faux = fauxProvider([{ text: "REPORT" }]);
		const [task] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
			registry,
		});

		const before = Date.now();
		const result = await task.call({ description: "fix the flaky test", prompt: "go" }, callCtx());
		const listed = registry.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.sidechainId).toBe(idOf(result));
		expect(listed[0]?.title).toBe("fix the flaky test");
		expect(listed[0]?.startedAt).toBeGreaterThanOrEqual(before);
		expect(listed[0]?.finishedAt).toBeGreaterThanOrEqual(listed[0]?.startedAt ?? Number.POSITIVE_INFINITY);
		expect(subagentStatus(listed[0] ?? { state: "live" })).toBe("completed");
	});

	test("a stop while running reads as cancelled, not completed", async () => {
		const registry = new SubagentRegistry();
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-record-")),
			mkdtempSync(join(tmpdir(), "lbb-record-home-")),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const faux = fauxProvider([{ toolCalls: [{ name: "gate", arguments: {} }] }, { text: "never reached" }]);
		const [task, , taskStop] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [gatedTool(() => entered.resolve(), release.promise)],
			definitions: () => [],
			store: () => store,
			registry,
		});

		const call = task.call({ description: "x", prompt: "block" }, callCtx());
		await entered.promise;

		// While it runs, the record says so.
		const live = registry.list()[0];
		expect(subagentStatus(live ?? { state: "finished" })).toBe("running");

		await taskStop.call({ sidechain_id: liveIdOf(store) }, callCtx());
		release.resolve();
		await call;

		const [listed] = registry.list();
		expect(subagentStatus(listed ?? { state: "live" })).toBe("cancelled");
		// The run did end, however it ended, so the end time is stamped.
		expect(listed?.finishedAt).toBeGreaterThan(0);
	});
});

/**
 * What a subagent's "ask" is: before the funnel, a denial with an
 * explanation; with one, a question in the session's own dialog, labeled with
 * the subagent that raised it, with the record reading `waiting` while the
 * person thinks. These tests drive the seam the host wires
 * (`requestPermission` on the tool context) with stubs — what the queue does
 * with the ask (showing it, answering it, withdrawing it on abort) is the
 * queue's business and is covered where it lives.
 *
 * A note on failure shape: every assertion that can go red lives after every
 * await has settled. An assertion throwing mid-flight would abandon a
 * subagent run still awaiting its answer, and a pending promise outlives the
 * test that abandoned it.
 */
describe("the ask funnel", () => {
	test("a yes runs the tool, and the ask names the subagent that raised it", async () => {
		const asked: Array<{ tool: string; source: string }> = [];
		// The tool answers with a marker that only execution produces. The call's
		// own arguments sit in the same next request the result does, so a tool
		// that echoes its input would let a denial satisfy the "it ran" line.
		const markedEcho = buildTool({
			name: "echo",
			description: "echo",
			inputSchema: z.object({ text: z.string() }),
			call: async () => ({ content: [{ type: "text", text: "TOOL-EXECUTED-7c1e" }] }),
		});
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "in" } }] }, { text: "REPORT" }]);
		const [task] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [markedEcho],
			definitions: () => [],
			permissionMode: () => "ask",
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
			requestPermission: async (toolName, _input, source) => {
				asked.push({ tool: toolName, source });
				return true;
			},
		});

		const result = await task.call({ description: "fix the flaky test", prompt: "go" }, callCtx());
		expect(text(result)).toContain("REPORT");
		// The yes was honoured: the approved call actually ran, and its result
		// reached the model's next request.
		expect(JSON.stringify(faux.receivedContexts[1]?.messages)).toContain("TOOL-EXECUTED-7c1e");
		// The label carries what an answer needs: what the subagent is doing,
		// and the id that addresses it — the same pair a /subagents row shows.
		expect(asked).toEqual([{ tool: "echo", source: `subagent "fix the flaky test" (${idOf(result)})` }]);
	});

	test("a no denies the call with the session's own words", async () => {
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] }, { text: "REPORT" }]);
		const [task] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "ask",
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
			requestPermission: async () => false,
		});

		const result = await task.call({ description: "x", prompt: "go" }, callCtx());
		expect(text(result)).toContain("REPORT");
		// The model read the denial in the second request: the same sentence a
		// denied call in the main session receives, so a denial reads the same
		// wherever it was decided.
		expect(JSON.stringify(faux.receivedContexts[1]?.messages)).toContain("User denied permission");
	});

	test("without a host funnel the ask still fails closed, with the old words", async () => {
		// A `-p` run has no dialog to reach, and neither does a test that wires
		// no funnel: the ask must stay a denial rather than a hang or a pass.
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] }, { text: "REPORT" }]);
		const [task] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "ask",
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
		});

		const result = await task.call({ description: "x", prompt: "go" }, callCtx());
		expect(text(result)).toContain("REPORT");
		expect(JSON.stringify(faux.receivedContexts[1]?.messages)).toContain("subagents cannot prompt interactively");
	});

	test("while the answer is pending the record says waiting, and the run's signal rides along", async () => {
		const registry = new SubagentRegistry();
		const entered = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<boolean>();
		let seenSignal: AbortSignal | undefined;
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] }, { text: "REPORT" }]);
		const [task] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "ask",
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
			registry,
			requestPermission: async (_tool, _input, _source, signal) => {
				seenSignal = signal;
				entered.resolve();
				return answered.promise;
			},
		});

		const call = task.call({ description: "x", prompt: "go" }, callCtx());
		// Give up on a funnel that never fires rather than hanging the file; the
		// red lands below, after the run has been released either way.
		await within(entered.promise, 2000);
		const statusWhilePending = subagentStatus(registry.list()[0] ?? { state: "finished" });
		const signalAbortedWhilePending = seenSignal?.aborted;

		answered.resolve(true);
		const result = await within(call, 2000);

		expect(statusWhilePending).toBe("waiting");
		// The subagent's own run signal, not the parent's: the queue needs it to
		// withdraw a stopped subagent's ask.
		expect(signalAbortedWhilePending).toBe(false);
		expect(result && text(result)).toContain("REPORT");
		// The ask ended with the answer: the record is done, not still waiting.
		expect(subagentStatus(registry.list()[0] ?? { state: "live" })).toBe("completed");
		// ...and the count went back down with the answer: a pendingAsks left
		// standing would keep the next listing reading waiting for a run that is
		// already moving again.
		expect(registry.list()[0]?.pendingAsks).toBe(0);
	});

	test("a stop while the ask is pending aborts the signal the queue holds", async () => {
		const registry = new SubagentRegistry();
		const entered = Promise.withResolvers<void>();
		const fallback = Promise.withResolvers<void>();
		let seenSignal: AbortSignal | undefined;
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] }, { text: "REPORT" }]);
		const [task, , taskStop] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "ask",
			sandbox: () => "workspace-write",
			getPermissionRules: () => [],
			registry,
			// Stands in for the session's queue: settles when the run's signal
			// aborts, which is how the real one withdraws a stopped ask.
			requestPermission: (_tool, _input, _source, signal) => {
				seenSignal = signal;
				entered.resolve();
				return new Promise<boolean>((resolve) => {
					signal?.addEventListener("abort", () => resolve(false), { once: true });
					void fallback.promise.then(() => resolve(false));
				});
			},
		});

		const call = task.call({ description: "x", prompt: "go" }, callCtx());
		await within(entered.promise, 2000);

		const stopped = await taskStop.call({ sidechain_id: registry.list()[0]?.sidechainId ?? "" }, callCtx());
		// The abort settles the stub on its own; this release is a fallback so a
		// stop failing to abort shows up as a failed assertion rather than as a
		// test that never finishes.
		fallback.resolve();
		const result = await call;

		expect(text(stopped)).toContain("was stopped");
		expect(seenSignal?.aborted).toBe(true);
		expect(text(result)).toContain("[subagent ended: aborted]");
	});
});

/**
 * The user-side controls: the same mechanics the tools use, reached by a
 * person instead of the model. A stop must be the TaskStop abort, and a retry
 * must be the Task spawn — a stop that only marked a record while the run
 * kept streaming would read as working while doing nothing.
 */
describe("the control surface", () => {
	test("control.retry re-runs the original task as a fresh subagent, on the same terms", async () => {
		const faux = fauxProvider([{ text: "FIRST REPORT" }, { text: "SECOND REPORT" }]);
		const registry = new SubagentRegistry();
		const [task, , , control] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
			registry,
		});

		await task.call({ description: "x", prompt: "reproduce the flake", max_turns: 3 }, callCtx());
		const original = registry.list()[0];
		if (!original) throw new Error("no handle registered");
		expect(original.prompt).toBe("reproduce the flake");
		expect(original.maxTurns).toBe(3);

		let spawned: SubagentHandle | undefined;
		const done = control.retry(original, { cwd: process.cwd() }, (handle) => {
			spawned = handle;
		});
		// The new id is readable before the run ends — the moment the transcript
		// note "Retrying … as <id>" is printed from.
		expect(spawned?.sidechainId).toBeDefined();
		expect(spawned?.sidechainId).not.toBe(original.sidechainId);
		expect(spawned?.prompt).toBe("reproduce the flake");
		expect(spawned?.maxTurns).toBe(3);

		const result = await within(done, 5000);
		expect(result).toBeDefined();
		expect(text(result as ToolResult)).toContain("SECOND REPORT");

		// A fresh conversation: the retry request carries the original prompt and
		// none of the first run's report — retry re-asks the task, it does not
		// continue it (that is SendMessage's job).
		const second = JSON.stringify(faux.receivedContexts[1]?.messages);
		expect(second).toContain("reproduce the flake");
		expect(second).not.toContain("FIRST REPORT");
		expect(registry.list()).toHaveLength(2);
		expect(registry.list()[1]?.state).toBe("finished");
	});

	test("control.stop aborts a live run — the same abort TaskStop sends", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const faux = fauxProvider([{ toolCalls: [{ name: "gate", arguments: {} }] }, { text: "never reached" }]);
		const registry = new SubagentRegistry();
		const [task, sendMessage, , control] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [gatedTool(() => entered.resolve(), release.promise)],
			definitions: () => [],
			registry,
		});

		const call = task.call({ description: "x", prompt: "block" }, callCtx());
		await entered.promise;
		const live = registry.list()[0];
		if (!live) throw new Error("no handle registered");
		expect(subagentStatus(live)).toBe("running");

		expect(control.stop(live)).toBe(true);
		const result = await within(call, 5000);
		expect(result).toBeDefined();
		expect(text(result as ToolResult)).toContain("[subagent ended: aborted]");
		expect(live.state).toBe("stopped");

		// The same verdict TaskStop leaves: not continued, and the refusal does
		// not run the subagent anyway.
		const refused = await sendMessage.call({ sidechain_id: live.sidechainId, message: "go on" }, callCtx());
		expect(refused.isError).toBe(true);
		expect(faux.receivedContexts).toHaveLength(1);
	});

	test("control.stop on a finished handle only marks it never-resumed", async () => {
		const faux = fauxProvider([{ text: "REPORT" }]);
		const registry = new SubagentRegistry();
		const [task, sendMessage, , control] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
			registry,
		});

		await task.call({ description: "x", prompt: "do it" }, callCtx());
		const done = registry.list()[0];
		if (!done) throw new Error("no handle registered");
		expect(control.stop(done)).toBe(false);
		expect(done.state).toBe("stopped");
		// The outcome the run reached survives the stop — it did finish.
		expect(subagentStatus(done)).toBe("completed");

		const refused = await sendMessage.call({ sidechain_id: done.sidechainId, message: "more" }, callCtx());
		expect(refused.isError).toBe(true);
	});
});

/**
 * The ledger's pairing contract: every `subagent_start` gets a `subagent_end`,
 * a run that dies by exception included.
 *
 * A throw out of prompt() used to skip the end write entirely, leaving a start
 * that any later reader — a resume, a task tree — can only interpret as a run
 * that never ended. The throw is injected at the session because the seam
 * under test is exactly "whatever comes out of runPrompt": the ledger write
 * has to sit on the way out, throw or no throw. The rejected promise is the
 * real abnormal-end shape too — prompt() rejects before its own loop for
 * everything outside its try, the "already running" guard included.
 */
describe("a subagent run that dies by exception", () => {
	test("a spawn that throws still writes its end — the start is never left unpaired", async () => {
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-throw-")),
			mkdtempSync(join(tmpdir(), "lbb-throw-home-")),
		);
		const faux = fauxProvider([{ text: "FIRST REPORT" }]);
		const registry = new SubagentRegistry();
		const [task, , , control] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
			store: () => store,
			registry,
		});

		await task.call({ description: "x", prompt: "do it" }, callCtx());
		const original = registry.list()[0];
		if (!original) throw new Error("no handle registered");

		const done = control.retry(original, { cwd: process.cwd() }, (spawned) => {
			spawned.session.prompt = async () => {
				throw new Error("subagent run exploded (test)");
			};
		});
		await expect(done).rejects.toThrow("subagent run exploded (test)");

		const ledger = store.linearEntries().filter((e) => e.type === "custom") as unknown as Array<{
			kind: string;
			data: { sidechainId: string; reason?: string };
		}>;
		const starts = ledger.filter((e) => e.kind === "subagent_start");
		const ends = ledger.filter((e) => e.kind === "subagent_end");
		// One end per start, in order: the first run paired the ordinary way,
		// the second threw and paired anyway.
		expect(starts.map((e) => e.data.sidechainId)).toHaveLength(2);
		expect(ends.map((e) => e.data.sidechainId)).toEqual(starts.map((e) => e.data.sidechainId));
		// And the thrown run's end says how it ended — "error", not a polite
		// default a run that simply finished would carry.
		expect(ends[1]?.data.reason).toBe("error");
	});

	test("a continuation that throws records its end too", async () => {
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-throw-cont-")),
			mkdtempSync(join(tmpdir(), "lbb-throw-cont-home-")),
		);
		const faux = fauxProvider([{ text: "FIRST REPORT" }]);
		const registry = new SubagentRegistry();
		const [task, sendMessage] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [],
			store: () => store,
			registry,
		});

		const first = await task.call({ description: "x", prompt: "do it" }, callCtx());
		const handle = registry.list()[0];
		if (!handle) throw new Error("no handle registered");
		handle.session.prompt = async () => {
			throw new Error("continuation exploded (test)");
		};

		const call = sendMessage.call({ sidechain_id: idOf(first), message: "more" }, callCtx());
		await expect(call).rejects.toThrow("continuation exploded (test)");

		const ends = store
			.linearEntries()
			.filter((e) => e.type === "custom" && (e as { kind?: string }).kind === "subagent_end")
			.map((e) => (e as unknown as { data: { reason: string } }).data.reason);
		expect(ends).toEqual(["completed", "error"]);
	});
});
