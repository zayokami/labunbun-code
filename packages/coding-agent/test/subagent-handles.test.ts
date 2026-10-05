/**
 * Subagent handles: what SendMessage and TaskStop make of an id.
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
