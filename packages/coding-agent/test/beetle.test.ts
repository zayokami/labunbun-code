/**
 * /beetle: the band object, the delivery bus, and the pieces around them.
 *
 * The claims being pinned, in the order the file makes them: a band starts all
 * four members on their configured models (sentinel and fallback included); a
 * delivery to an idle member is a wake-up carrying a provenance envelope, and
 * to a busy one it queues for the turn boundary and no earlier (the same
 * three-request shape the background-shell notices use, because it is the same
 * follow-up queue); refusals are refusals (self-addressing, stop, disband) and
 * never burn a request against the member they refuse; off aborts, drops what
 * was queued, and stays off; and the permission axes are re-read per delivery,
 * failing closed in a member — with the one exception the band cannot live
 * without, the bus itself, which is why the band still runs in `ask` mode and
 * in `plan` mode.
 *
 * Everything runs on scripted faux models routed by model id — the members are
 * separate sessions with separate conversations, and one shared script would
 * interleave their calls. Requests are snapshotted at call time: the session
 * hands the stream its live message array, so a reference read later shows the
 * conversation's final state and every "which request carried what" assertion
 * would be about the end of the run rather than the call in question.
 */
import { describe, expect, test } from "bun:test";
import {
	AgentSession,
	type AnyTool,
	buildTool,
	type PermissionMode,
	type SandboxMode,
	type ToolResult,
} from "@labunbun/agent";
import { FAUX_MODEL, type FauxStep, fauxProvider, type Model, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import {
	BAND_LINE_PREVIEW_CHARS,
	BEETLE_MEMBERS,
	BeetleBand,
	type BeetleMember,
	type BeetleModels,
	type BeetlePickOption,
	bandBriefing,
	bandEnvelope,
	bandLine,
	memberSystemPrompt,
	parseBeetleCommand,
	pickBeetleModels,
	READ_SEAT_TOOL_NAMES,
	routeMention,
	SESSION_MODEL_REF,
} from "../src/beetle.ts";

function testModel(id: string, overrides: Partial<Model> = {}): Model {
	return { ...FAUX_MODEL, id, name: id, ...overrides };
}

interface RoutedFaux {
	streamFn: StreamFn;
	/** Call-time JSON snapshots of the request messages, one list per model id. */
	calls(modelId: string): string[];
}

/**
 * One faux provider per model id, routed by the model the session sends.
 *
 * Steps are consumed per provider, and an exhausted script repeats its last
 * step — so a script must spell out each run's tool steps: a member woken
 * twice with a script of `[tool, text]` answers the second wake with the
 * repeated text step and never calls the tool again. Closing text is the
 * natural last step of every script.
 */
function routedFaux(script: Record<string, FauxStep[]>): RoutedFaux {
	const providers = new Map<string, ReturnType<typeof fauxProvider>>();
	for (const [id, steps] of Object.entries(script)) providers.set(id, fauxProvider(steps));
	const requests = new Map<string, string[]>();
	const streamFn: StreamFn = async function* (model, context, options) {
		const provider = providers.get(model.id);
		if (!provider) throw new Error(`no faux script for model "${model.id}"`);
		const list = requests.get(model.id) ?? [];
		list.push(JSON.stringify(context.messages));
		requests.set(model.id, list);
		yield* provider.streamFn(model, context, options);
	};
	return { streamFn, calls: (id) => requests.get(id) ?? [] };
}

/** `faux/john` → a model with id `john`, for the four member refs. */
function memberRefTable(): Map<string, Model> {
	const table = new Map<string, Model>();
	for (const name of BEETLE_MEMBERS) table.set(`faux/${name}`, testModel(name));
	return table;
}

interface BandFixture {
	band: BeetleBand;
	faux: RoutedFaux;
	notices: string[];
	reports: string[];
}

interface BandFixtureOptions {
	script: Record<string, FauxStep[]>;
	/** Overrides on top of all-four-`"session"`. */
	models?: Partial<BeetleModels>;
	resolve?: (ref: string) => Model | undefined;
	canRunModel?: (model: Model) => boolean;
	tools?: AnyTool[];
	mcpTools?: AnyTool[];
	main?: () => AgentSession | null;
	permissionMode?: () => PermissionMode | undefined;
	sandbox?: () => SandboxMode | undefined;
}

function makeBand(options: BandFixtureOptions): BandFixture {
	const faux = routedFaux(options.script);
	const refs = memberRefTable();
	const notices: string[] = [];
	const reports: string[] = [];
	const band = new BeetleBand({
		models: {
			john: SESSION_MODEL_REF,
			paul: SESSION_MODEL_REF,
			george: SESSION_MODEL_REF,
			ringo: SESSION_MODEL_REF,
			...options.models,
		},
		cwd: process.cwd(),
		streamFn: faux.streamFn,
		allTools: options.tools ?? [],
		mcpTools: options.mcpTools,
		model: () => FAUX_MODEL,
		resolveModel: options.resolve ?? ((ref) => refs.get(ref)),
		canRunModel: options.canRunModel ?? (() => true),
		onNotice: (text) => notices.push(text),
		report: (text) => reports.push(text),
		getMain: options.main,
		permissionMode: options.permissionMode,
		sandbox: options.sandbox,
		getPermissionRules: () => [],
	});
	return { band, faux, notices, reports };
}

function endedReason(session: AgentSession): Promise<string> {
	return new Promise((resolve) => {
		const unsubscribe = session.on((event) => {
			if (event.type !== "agent_end") return;
			unsubscribe();
			resolve(event.reason);
		});
	});
}

/**
 * Await, but give up after `ms` with `undefined` — a notice or wake-up that
 * never arrives must fail the test rather than hang it (a promise that never
 * settles does not respect bun's per-test timeout).
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

function stubTool(name: string): AnyTool {
	return buildTool({
		name,
		description: `${name} (test stub)`,
		inputSchema: z.object({}),
		call: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
	});
}

function bashTool(): AnyTool {
	return buildTool({
		name: "Bash",
		description: "fake shell (test)",
		inputSchema: z.object({ command: z.string() }),
		call: async (input) => ({ content: [{ type: "text", text: `ran: ${input.command}` }] }),
	});
}

/** A Bash stand-in that blocks until released or aborted, like a slow command. */
function gatedBash(onEnter: () => void, release: Promise<void>): AnyTool {
	return buildTool({
		name: "Bash",
		description: "fake shell that waits (test)",
		inputSchema: z.object({ command: z.string() }),
		call: async (_input, ctx) => {
			onEnter();
			await Promise.race([
				release,
				new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })),
			]);
			return { content: [{ type: "text", text: ctx.signal.aborted ? "gated: aborted" : "gated: released" }] };
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

function toolNamed(session: AgentSession, name: string): AnyTool {
	const tool = session.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`no tool named ${name}`);
	return tool;
}

/** The member's session, or a thrown error: the band always has all four. */
function sessionOf(band: BeetleBand, name: BeetleMember): AgentSession {
	const session = band.memberSession(name);
	if (!session) throw new Error(`the band has no session for ${name}`);
	return session;
}

describe("starting a band", () => {
	test("a start wakes all four, each on its configured model", async () => {
		const { band, faux, notices } = makeBand({
			script: {
				john: [{ text: "JOHN READY" }],
				"faux-1": [{ text: "PAUL READY" }],
				george: [{ text: "GEORGE READY" }],
				ringo: [{ text: "RINGO READY" }],
			},
			// Paul keeps the sentinel: "session" means the session model, resolved
			// at the call rather than frozen into a ref.
			models: { john: "faux/john", george: "faux/george", ringo: "faux/ringo" },
		});

		const ends = BEETLE_MEMBERS.map((name) => endedReason(sessionOf(band, name)));
		band.start("fix the flaky test");
		expect(await within(Promise.all(ends), 5_000)).toEqual(["completed", "completed", "completed", "completed"]);

		expect(faux.calls("john")).toHaveLength(1);
		expect(faux.calls("faux-1")).toHaveLength(1);
		expect(faux.calls("george")).toHaveLength(1);
		expect(faux.calls("ringo")).toHaveLength(1);

		const john = faux.calls("john")[0] ?? "";
		expect(john).toContain("fix the flaky test");
		expect(john).toContain("[beetle band message — from the user, not a peer relay]");
		expect(john).toContain("You hold the lead");
		expect(faux.calls("george")[0] ?? "").toContain("Stand by for John's assignment");
		expect(faux.calls("george")[0] ?? "").toContain("George (verifier)");

		const status = band.status();
		const byName = Object.fromEntries(status.map((entry) => [entry.name, entry]));
		expect(byName.john?.modelRef).toBe("faux/john");
		expect(byName.john?.model).toBe("faux/john");
		expect(byName.paul?.modelRef).toBe(SESSION_MODEL_REF);
		expect(byName.paul?.model).toBe("faux/faux-1");
		// The sentinel is not a ref that is pending resolution: nothing about
		// "session" will ever be resolved later, and a pendingRef here would have
		// every delivery re-checking a ref that is not one.
		expect(byName.paul?.pendingRef).toBeUndefined();
		expect(byName.john?.pendingRef).toBeUndefined();
		for (const entry of status) {
			expect(entry.state).toBe("idle");
			expect(entry.turns).toBe(1);
		}

		// One relay line per member, with the task itself as the preview.
		expect(notices).toHaveLength(4);
		expect(notices[0]).toBe("[beetle] you → John: fix the flaky test");
		expect(notices[1]).toBe("[beetle] you → Paul: fix the flaky test");
	});

	test("an unresolvable ref falls back to the session model and says so", async () => {
		const { band, faux, reports } = makeBand({
			script: { "faux-1": [{ text: "ok" }] },
			models: { john: "faux/ghost" },
		});
		expect(
			reports.some(
				(line) => line.includes('John: model "faux/ghost" is not available') && line.includes("session model"),
			),
		).toBe(true);
		const john = band.status().find((entry) => entry.name === "john");
		expect(john?.modelRef).toBe("faux/ghost");
		expect(john?.pendingRef).toBe("faux/ghost");
		expect(john?.model).toBe("faux/faux-1");

		const ended = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "go");
		expect(await within(ended, 5_000)).toBe("completed");
		expect(faux.calls("faux-1")).toHaveLength(1);
		expect(faux.calls("faux/ghost")).toHaveLength(0);
	});

	test("a resolved model without credentials falls back the same way", () => {
		const { band, reports } = makeBand({
			script: { "faux-1": [{ text: "ok" }] },
			models: { john: "faux/john" },
			canRunModel: () => false,
		});
		expect(reports.some((line) => line.includes('model "faux/john" is not available'))).toBe(true);
		const john = band.status().find((entry) => entry.name === "john");
		expect(john?.pendingRef).toBe("faux/john");
		expect(john?.model).toBe("faux/faux-1");
	});

	test("the session sentinel is not a ref and never reports", () => {
		const { reports } = makeBand({ script: {} });
		expect(reports).toHaveLength(0);
	});

	test("a ref that resolves late is switched in at the next delivery, exactly once", async () => {
		let available = false;
		const refs = memberRefTable();
		const { band, faux, reports } = makeBand({
			script: { "faux-1": [{ text: "FALLBACK RUN" }], john: [{ text: "SWITCHED RUN" }] },
			models: { john: "faux/john" },
			resolve: (ref) => (ref === "faux/john" && !available ? undefined : refs.get(ref)),
		});

		const first = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "first");
		expect(await within(first, 5_000)).toBe("completed");
		expect(faux.calls("faux-1")).toHaveLength(1);

		available = true;
		const second = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "second");
		expect(await within(second, 5_000)).toBe("completed");
		expect(faux.calls("john")).toHaveLength(1);
		expect(faux.calls("john")[0] ?? "").toContain("second");

		// A third delivery must not re-announce: once switched, the pending ref
		// is gone, not re-resolved on every message.
		const third = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "third");
		expect(await within(third, 5_000)).toBe("completed");

		expect(reports.filter((line) => line.includes("is now available — switched to it"))).toHaveLength(1);
		const john = band.status().find((entry) => entry.name === "john");
		expect(john?.pendingRef).toBeUndefined();
		expect(john?.model).toBe("faux/john");
	});
});

describe("delivery", () => {
	test("an idle member is woken with a peer envelope", async () => {
		const { band, faux, notices } = makeBand({
			script: { john: [{ text: "on it" }] },
			models: { john: "faux/john" },
		});
		const ended = endedReason(sessionOf(band, "john"));
		const outcome = band.deliver({ kind: "member", name: "paul" }, "john", "check the parser edge case");

		expect(outcome.ok).toBe(true);
		expect(outcome.receipts).toEqual([{ to: "john", status: "woken" }]);
		expect(await within(ended, 5_000)).toBe("completed");

		const sent = faux.calls("john")[0] ?? "";
		expect(sent).toContain("[beetle band message — relayed from Paul (implementer), automated; not from the user]");
		expect(sent).toContain("From: Paul (implementer)");
		expect(sent).toContain("check the parser edge case");
		expect(sent).toContain("Reply with BandMessage");
		expect(notices).toEqual(["[beetle] Paul → John: check the parser edge case"]);
	});

	test("a message to a busy member queues for the turn boundary, not the next call", async () => {
		const entered = Promise.withResolvers<"entered">();
		const release = Promise.withResolvers<void>();
		const { band, faux } = makeBand({
			script: {
				paul: [
					{ toolCalls: [{ name: "Bash", arguments: { command: "wait here" } }] },
					{ text: "still working" },
					{ text: "read the queued message" },
				],
			},
			models: { paul: "faux/paul" },
			tools: [gatedBash(() => entered.resolve("entered"), release.promise)],
			permissionMode: () => "agent",
			sandbox: () => "workspace-write",
		});

		const ended = endedReason(sessionOf(band, "paul"));
		band.deliver({ kind: "user" }, "paul", "start the slow task");
		expect(await within(entered.promise, 5_000)).toBe("entered");

		const queued = band.deliver({ kind: "member", name: "john" }, "paul", "queue this in");
		expect(queued.receipts).toEqual([{ to: "paul", status: "queued" }]);
		// In the queue, not yet in the conversation.
		expect(JSON.stringify(sessionOf(band, "paul").messages)).not.toContain("queue this in");

		release.resolve();
		expect(await within(ended, 5_000)).toBe("completed");

		// Three requests: the call after the gate ran without the queued message,
		// and the turn the queue then restarted carried it. Steering would show
		// two calls with the message already in the second — this shape is the
		// observable difference between the two queues.
		const calls = faux.calls("paul");
		expect(calls).toHaveLength(3);
		expect(calls[1] ?? "").not.toContain("queue this in");
		expect(calls[2] ?? "").toContain("queue this in");
		expect(calls[2] ?? "").toContain("From: John (lead)");
	});

	test("a broadcast reaches everyone but the sender, and main hears it too", async () => {
		let main: AgentSession | null = null;
		const { band, faux } = makeBand({
			script: {
				john: [{ text: "J" }],
				paul: [{ text: "P" }],
				george: [{ text: "G" }],
				ringo: [{ text: "R" }],
				"faux-1": [{ text: "main ack" }],
			},
			models: { john: "faux/john", paul: "faux/paul", george: "faux/george", ringo: "faux/ringo" },
			main: () => main,
		});
		main = new AgentSession({ model: FAUX_MODEL, systemPrompt: "main", deps: { streamFn: faux.streamFn } });

		const mainEnd = endedReason(main);
		const memberEnds = (["paul", "george", "ringo"] as const).map((name) => endedReason(sessionOf(band, name)));
		const outcome = band.deliver({ kind: "member", name: "john" }, "all", "status check");
		expect(outcome.receipts.map((receipt) => [receipt.to, receipt.status])).toEqual([
			["paul", "woken"],
			["george", "woken"],
			["ringo", "woken"],
			["main", "woken"],
		]);
		expect(await within(Promise.all(memberEnds), 5_000)).toHaveLength(3);
		expect(await within(mainEnd, 5_000)).toBe("completed");
		expect(faux.calls("john")).toHaveLength(0); // the sender is not woken by its own broadcast
		for (const id of ["paul", "george", "ringo", "faux-1"]) {
			expect(faux.calls(id)[0] ?? "").toContain("relayed from John (lead)");
			expect(faux.calls(id)[0] ?? "").toContain("status check");
		}

		// From main: all four members, and neither an excluded nor a duplicated main.
		const secondEnds = BEETLE_MEMBERS.map((name) => endedReason(sessionOf(band, name)));
		const second = band.deliver({ kind: "main" }, "all", "round two");
		expect(second.receipts.map((receipt) => receipt.to)).toEqual(["john", "paul", "george", "ringo"]);
		expect(await within(Promise.all(secondEnds), 5_000)).toHaveLength(4);
		expect(faux.calls("john")[0] ?? "").toContain("relayed from the main session");
	});

	test("self-addressing is refused without a request", () => {
		const { band, faux, notices } = makeBand({
			script: { john: [{ text: "unused" }] },
			models: { john: "faux/john" },
		});
		const outcome = band.deliver({ kind: "member", name: "john" }, "john", "note to self");
		expect(outcome.ok).toBe(false);
		expect(outcome.receipts[0]?.status).toBe("refused");
		expect(outcome.receipts[0]?.reason).toContain("yourself");
		expect(faux.calls("john")).toHaveLength(0);
		expect(sessionOf(band, "john").messages).toHaveLength(0);
		// The attempt is still visible to the user — a refused relay that lived
		// only in a tool result would look like nothing ever happened.
		expect(notices).toEqual(["[beetle] John → John: note to self"]);
	});

	test("a stopped member refuses peers; only the user revives it", async () => {
		const { band, faux, reports } = makeBand({
			script: { john: [{ stopReason: "error", errorMessage: "boom" }, { text: "REVIVED" }] },
			models: { john: "faux/john" },
		});

		const first = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "first");
		expect(await within(first, 5_000)).toBe("error");
		expect(band.status().find((entry) => entry.name === "john")?.state).toBe("stopped");
		expect(
			reports.some((line) => line.includes("John stopped after its run ended with error") && line.includes("boom")),
		).toBe(true);

		// A peer's message neither wakes it nor burns a failing request against it.
		const refused = band.deliver({ kind: "member", name: "paul" }, "john", "please check");
		expect(refused.ok).toBe(false);
		expect(refused.receipts[0]?.status).toBe("refused");
		expect(refused.receipts[0]?.reason).toContain("stopped");
		expect(refused.receipts[0]?.reason).toContain("only the user");
		expect(faux.calls("john")).toHaveLength(1);

		// The user's message revives it — and the receipt says so.
		const revived = endedReason(sessionOf(band, "john"));
		const outcome = band.deliver({ kind: "user" }, "john", "come back");
		expect(outcome.receipts).toEqual([{ to: "john", status: "revived" }]);
		expect(await within(revived, 5_000)).toBe("completed");
		expect(faux.calls("john")).toHaveLength(2);
		expect(faux.calls("john")[1] ?? "").toContain("come back");
		expect(band.status().find((entry) => entry.name === "john")?.state).toBe("idle");
	});

	test("off aborts every member, drops queued messages, and refuses everything after", async () => {
		const entered = Promise.withResolvers<"entered">();
		const release = Promise.withResolvers<void>();
		const { band, faux } = makeBand({
			script: {
				paul: [{ toolCalls: [{ name: "Bash", arguments: { command: "wait" } }] }, { text: "never reached" }],
			},
			models: { paul: "faux/paul" },
			tools: [gatedBash(() => entered.resolve("entered"), release.promise)],
			permissionMode: () => "agent",
		});

		const ended = endedReason(sessionOf(band, "paul"));
		band.deliver({ kind: "user" }, "paul", "long task");
		expect(await within(entered.promise, 5_000)).toBe("entered");
		band.deliver({ kind: "member", name: "john" }, "paul", "queued while off");

		const status = band.off();
		expect(status.every((entry) => entry.state === "stopped")).toBe(true);
		expect(band.active).toBe(false);

		release.resolve(); // fallback; the abort should settle the gate on its own
		expect(await within(ended, 5_000)).toBe("aborted");
		// The aborted run's agent_end must not flip the member back to idle.
		expect(band.status().every((entry) => entry.state === "stopped")).toBe(true);
		// The queued message was dropped with the abort, not delivered into it.
		expect(JSON.stringify(sessionOf(band, "paul").messages)).not.toContain("queued while off");
		expect(faux.calls("paul")).toHaveLength(1);

		expect(band.off().every((entry) => entry.state === "stopped")).toBe(true); // idempotent
		const after = band.deliver({ kind: "user" }, "paul", "after off");
		expect(after.ok).toBe(false);
		expect(after.receipts[0]?.reason).toContain("not active");
		expect(faux.calls("paul")).toHaveLength(1);
	});

	test("off landing on a wake-up that has not started yet still ends stopped", async () => {
		const { band } = makeBand({
			// A tool call in the first turn: the run has to reach the loop's own
			// abort check (the text-only path breaks on its own). The tool itself
			// never runs — the aborted signal settles it as interrupted.
			script: {
				john: [{ toolCalls: [{ name: "Bash", arguments: { command: "echo hi" } }] }, { text: "never" }],
			},
			models: { john: "faux/john" },
			tools: [bashTool()],
			permissionMode: () => "agent",
		});
		const ended = endedReason(sessionOf(band, "john"));
		// Delivering to an idle member starts its run, but the run's start *event*
		// comes after its first await — so a same-tick off() lands in that gap,
		// aborted between "running" and "agent_start". The start must not undo the
		// stop, and the aborted run's end must not flip the member to idle: from
		// the user's side, off is off the moment it returns.
		band.deliver({ kind: "user" }, "john", "go");
		band.off();
		expect(await within(ended, 5_000)).toBe("aborted");
		expect(band.status().find((entry) => entry.name === "john")?.state).toBe("stopped");
	});

	test("main is woken when idle and queued behind its own turn when busy", async () => {
		let main: AgentSession | null = null;
		const { band, faux } = makeBand({
			script: {
				"faux-1": [
					{ text: "ack one" },
					{ toolCalls: [{ name: "Bash", arguments: { command: "wait" } }] },
					{ text: "after the gate" },
					{ text: "read while-busy" },
				],
			},
			main: () => main,
		});
		const entered = Promise.withResolvers<"entered">();
		const release = Promise.withResolvers<void>();
		main = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "main",
			tools: [gatedBash(() => entered.resolve("entered"), release.promise)],
			deps: { streamFn: faux.streamFn },
		});

		const firstEnd = endedReason(main);
		const outcome = band.deliver({ kind: "member", name: "george" }, "main", "task complete: please report");
		expect(outcome.receipts).toEqual([{ to: "main", status: "woken" }]);
		expect(await within(firstEnd, 5_000)).toBe("completed");
		expect(faux.calls("faux-1")[0] ?? "").toContain("relayed from George (verifier)");
		expect(faux.calls("faux-1")[0] ?? "").toContain("task complete: please report");

		const secondEnd = endedReason(main);
		void main.prompt("start the slow thing");
		expect(await within(entered.promise, 5_000)).toBe("entered");
		const queued = band.deliver({ kind: "member", name: "john" }, "main", "while-busy");
		expect(queued.receipts).toEqual([{ to: "main", status: "queued" }]);

		release.resolve();
		expect(await within(secondEnd, 5_000)).toBe("completed");
		const calls = faux.calls("faux-1");
		expect(calls).toHaveLength(4);
		expect(calls[2] ?? "").not.toContain("while-busy");
		expect(calls[3] ?? "").toContain("while-busy");
	});

	test("with no main session, a message to main is refused", () => {
		const { band } = makeBand({ script: {} });
		const outcome = band.deliver({ kind: "member", name: "john" }, "main", "report");
		expect(outcome.ok).toBe(false);
		expect(outcome.receipts[0]?.reason).toContain("no main session");
	});

	test("status counts turns and reads cost out of each member's transcript", async () => {
		const { band, faux } = makeBand({
			script: {
				paul: [{ toolCalls: [{ name: "Bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
			},
			models: { paul: "faux/paul" },
			tools: [bashTool()],
			permissionMode: () => "agent",
		});
		const ended = endedReason(sessionOf(band, "paul"));
		band.deliver({ kind: "user" }, "paul", "run it");
		expect(await within(ended, 5_000)).toBe("completed");
		expect(faux.calls("paul")[1] ?? "").toContain("ran: echo hi");

		const paul = band.status().find((entry) => entry.name === "paul");
		expect(paul).toMatchObject({
			role: "implementer",
			state: "idle",
			turns: 2, // the tool turn and the closing turn
			lastActivity: "Bash: ok",
			unpriced: true, // the test model has no price row
			model: "faux/paul",
		});
		expect(paul?.messages).toBeGreaterThan(2);
		expect(paul?.costUSD).toBe(0);
	});
});

describe("pure pieces", () => {
	test("the envelope marks who is speaking", () => {
		const relay = bandEnvelope({ kind: "member", name: "john" }, "do the thing");
		expect(relay.split("\n")[0]).toBe("[beetle band message — relayed from John (lead), automated; not from the user]");
		expect(relay).toContain("From: John (lead)\n\ndo the thing");
		expect(relay).toContain(
			"Reply with BandMessage to anyone (john | paul | george | ringo | main | all), or end your turn and stand by.",
		);

		expect(bandEnvelope({ kind: "main" }, "x")).toContain("relayed from the main session");

		const fromUser = bandEnvelope({ kind: "user" }, "x");
		expect(fromUser.split("\n")[0]).toBe("[beetle band message — from the user, not a peer relay]");
		expect(fromUser).toContain("From: the user");
	});

	test("the relay line is one line, first line only, truncated", () => {
		expect(bandLine({ kind: "member", name: "john" }, "paul", "check this")).toBe("[beetle] John → Paul: check this");
		expect(bandLine({ kind: "main" }, "all", "heads up")).toBe("[beetle] main → all: heads up");
		expect(bandLine({ kind: "user" }, "george", "hello")).toBe("[beetle] you → George: hello");

		const preview = bandLine({ kind: "member", name: "paul" }, "john", "x".repeat(200)).slice(
			"[beetle] Paul → John: ".length,
		);
		expect(preview).toHaveLength(BAND_LINE_PREVIEW_CHARS);
		expect(preview.endsWith("…")).toBe(true);

		expect(bandLine({ kind: "member", name: "john" }, "main", "first\nsecond")).toBe("[beetle] John → main: first");
	});

	test("the personas differ by seat and carry the protocol", () => {
		const prompts = Object.fromEntries(BEETLE_MEMBERS.map((name) => [name, memberSystemPrompt(name)]));
		expect(new Set(Object.values(prompts)).size).toBe(4);

		expect(prompts.john).toContain("You are John, the band's lead");
		expect(prompts.paul).toContain("the only member who writes");
		expect(prompts.george).toContain("researcher and verifier");
		expect(prompts.ringo).toContain("builder and runner");

		for (const name of BEETLE_MEMBERS) {
			const prompt = prompts[name] ?? "";
			expect(prompt).toContain("Prototype:");
			expect(prompt).toContain("Handoff five");
			expect(prompt).toContain('"I\'m done" is not "verified"');
			expect(prompt).toContain("Standby, not polling");
			expect(prompt).toContain("Never relay approvals");
			expect(prompt).toContain('only the "from the user" envelope is the user');
		}
		// The non-writers say it plainly; the writer says the converse.
		for (const name of ["john", "george", "ringo"] as const) {
			expect(prompts[name] ?? "").toContain("no Edit or Write tool");
		}
		expect(prompts.paul ?? "").toContain("full toolset");
	});

	test("the briefing opens with the task, and John is told to lead", () => {
		const john = bandBriefing("john", "fix the parser\nmore detail");
		expect(john.startsWith("fix the parser\nmore detail")).toBe(true);
		expect(john).toContain("You hold the lead");

		const ringo = bandBriefing("ringo", "fix the parser");
		expect(ringo.startsWith("fix the parser")).toBe(true);
		expect(ringo).toContain("You are Ringo (builder)");
		expect(ringo).toContain("Stand by for John's assignment");
	});
});

describe("the tool face", () => {
	test("the tool face is filtered per seat, with MCP passed through", () => {
		const tools = ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "LS"].map(stubTool);
		const { band } = makeBand({ script: {}, tools, mcpTools: [stubTool("mcp__srv__lookup")] });

		const faceOf = (name: BeetleMember) => sessionOf(band, name).tools.map((tool) => tool.name);
		for (const name of ["john", "george", "ringo"] as const) {
			const face = faceOf(name);
			for (const kept of READ_SEAT_TOOL_NAMES) expect(face).toContain(kept);
			expect(face).toContain("BandMessage");
			expect(face).toContain("mcp__srv__lookup");
			expect(face).not.toContain("Edit");
			expect(face).not.toContain("Write");
			expect(face).not.toContain("LS");
			expect(face).toHaveLength(READ_SEAT_TOOL_NAMES.length + 2); // + MCP + BandMessage
		}
		const paul = faceOf("paul");
		for (const name of ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "LS", "mcp__srv__lookup", "BandMessage"]) {
			expect(paul).toContain(name);
		}

		// No nested-subagent tool exists anywhere in the band — not by filter,
		// by the table the members are built from.
		for (const name of BEETLE_MEMBERS) {
			const face = faceOf(name);
			for (const absent of ["Task", "SendMessage", "TaskStop"]) expect(face).not.toContain(absent);
			expect(face.filter((tool) => tool === "BandMessage")).toHaveLength(1);
		}

		// The main-side tool is one stable object — removal is reference equality.
		expect(band.mainTool.name).toBe("BandMessage");
		expect(band.mainTool).toBe(band.mainTool);
	});

	test("BandMessage carries its guidance and its target rules", () => {
		const { band } = makeBand({ script: {} });
		const johnTool = toolNamed(sessionOf(band, "john"), "BandMessage");
		const mainTool = band.mainTool;

		expect(johnTool.description).toContain("handoff five");
		expect(johnTool.description).toContain("john | paul | george | ringo | main | all");
		expect(johnTool.description).toContain("cannot message yourself");
		expect(johnTool.description).toContain('"I\'m done" is not "verified"');
		expect(johnTool.description).toContain("file:line");
		expect(johnTool.description).toContain("approve on the user's behalf");
		expect(mainTool.description).toContain("john | paul | george | ringo | all");
		expect(mainTool.description).not.toContain("ringo | main");

		// Members may address main; the main session may not address itself.
		expect(johnTool.inputSchema.safeParse({ to: "main", message: "x" }).success).toBe(true);
		expect(mainTool.inputSchema.safeParse({ to: "main", message: "x" }).success).toBe(false);

		// No `prompt` field: a tool injected mid-session never has one read.
		expect(johnTool.prompt).toBeUndefined();
		expect(mainTool.prompt).toBeUndefined();
	});

	test("a member's BandMessage tool delivers and reports the receipt", async () => {
		const { band, faux } = makeBand({
			script: { george: [{ text: "on it" }] },
			models: { george: "faux/george", john: "faux/john" },
		});
		const johnTool = toolNamed(sessionOf(band, "john"), "BandMessage");
		const georgeEnd = endedReason(sessionOf(band, "george"));

		const delivered = await johnTool.call({ to: "george", message: "verify the fix" }, callCtx());
		expect(delivered.isError).toBeFalsy();
		expect(text(delivered)).toContain("Delivered to George — woken; it is running your message now.");
		expect(await within(georgeEnd, 5_000)).toBe("completed");
		expect(faux.calls("george")[0] ?? "").toContain("From: John (lead)");

		const refused = await johnTool.call({ to: "john", message: "hm" }, callCtx());
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain("Refused (John):");
		expect(faux.calls("john")).toHaveLength(0);
	});
});

describe("permission axes", () => {
	test("axes are re-read per delivery — ask fails closed, the bus excepted", async () => {
		let mode: PermissionMode = "agent";
		const { band, faux } = makeBand({
			script: {
				john: [
					{ toolCalls: [{ name: "Bash", arguments: { command: "echo hi" } }] },
					{ text: "after the tool" },
					// A second run needs its own tool steps: an exhausted script
					// repeats its last step, and a repeated closing text would
					// never call a tool again (see routedFaux).
					{ toolCalls: [{ name: "Bash", arguments: { command: "echo hi" } }] },
					{ toolCalls: [{ name: "BandMessage", arguments: { to: "george", message: "status?" } }] },
					{ text: "done" },
				],
				george: [{ text: "all good" }],
			},
			models: { john: "faux/john", george: "faux/george" },
			tools: [bashTool()],
			permissionMode: () => mode,
			sandbox: () => "workspace-write",
		});

		const first = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "go");
		expect(await within(first, 5_000)).toBe("completed");
		expect(faux.calls("john")[1] ?? "").toContain("ran: echo hi");

		// No dialog exists in a member: the same call, under the mode the user
		// has since moved the session into, must be refused rather than hang —
		// and the refusal is a tool error the model reads, not a skipped call.
		mode = "ask";
		const georgeEnd = endedReason(sessionOf(band, "george"));
		const second = endedReason(sessionOf(band, "john"));
		band.deliver({ kind: "user" }, "john", "again");
		expect(await within(Promise.all([second, georgeEnd]), 5_000)).toEqual(["completed", "completed"]);
		expect(faux.calls("john")[3] ?? "").toContain("Permission required for Bash");
		expect(faux.calls("john")[3] ?? "").toContain("no dialog");

		// …and the bus is the exception the band cannot live without: in ask
		// mode — the default mode — a member still reaches other members,
		// because a wake-up touches nothing and every action it provokes is
		// evaluated in the woken member's own session.
		expect(faux.calls("george")[0] ?? "").toContain("From: John (lead)");
		expect(faux.calls("george")[0] ?? "").toContain("status?");
		expect(faux.calls("john")[4] ?? "").toContain("Delivered to George — woken");
	});

	test("plan mode: the band still talks; the shell it cannot run", async () => {
		const { band, faux } = makeBand({
			script: {
				john: [
					{ toolCalls: [{ name: "Bash", arguments: { command: "echo hi" } }] },
					{ toolCalls: [{ name: "BandMessage", arguments: { to: "george", message: "reading only" } }] },
					{ text: "done" },
				],
				george: [{ text: "noted" }],
			},
			models: { john: "faux/john", george: "faux/george" },
			tools: [bashTool()],
			permissionMode: () => "plan",
			sandbox: () => "workspace-write",
		});

		const johnEnd = endedReason(sessionOf(band, "john"));
		const georgeEnd = endedReason(sessionOf(band, "george"));
		band.deliver({ kind: "user" }, "john", "survey the parser");
		expect(await within(Promise.all([johnEnd, georgeEnd]), 5_000)).toEqual(["completed", "completed"]);

		// Plan mode denies the shell outright — a denial the model reads, not a
		// dialog — while the bus passes, so the band can still say what it found.
		expect(faux.calls("john")[1] ?? "").toContain("Plan mode: Bash is not allowed");
		expect(faux.calls("george")[0] ?? "").toContain("reading only");
		expect(faux.calls("john")[2] ?? "").toContain("Delivered to George — woken");
	});
});

describe("a real exchange", () => {
	test("John assigns George through the tool and the receipt lands in his transcript", async () => {
		const { band, faux, notices } = makeBand({
			script: {
				john: [
					{ toolCalls: [{ name: "BandMessage", arguments: { to: "george", message: "verify the parser fix" } }] },
					{ text: "assigned" },
				],
				george: [{ text: "VERIFIED" }],
			},
			models: { john: "faux/john", george: "faux/george", paul: "faux/paul", ringo: "faux/ringo" },
			// Tool calls inside a member are permission-evaluated like anyone
			// else's; agent mode is the axis under which a scripted tool runs
			// without a dialog. (The bus alone passes in every mode.)
			permissionMode: () => "agent",
			sandbox: () => "workspace-write",
		});

		const johnEnd = endedReason(sessionOf(band, "john"));
		const georgeEnd = endedReason(sessionOf(band, "george"));
		band.deliver({ kind: "user" }, "john", "fix the parser");
		expect(await within(Promise.all([johnEnd, georgeEnd]), 5_000)).toHaveLength(2);

		// The assignment woke George with John's envelope...
		expect(faux.calls("george")[0] ?? "").toContain("relayed from John (lead)");
		expect(faux.calls("george")[0] ?? "").toContain("verify the parser fix");
		// ...and the receipt is in John's own conversation, so he knows it landed.
		expect(faux.calls("john")[1] ?? "").toContain("Delivered to George — woken");
		expect(faux.calls("paul")).toHaveLength(0);
		expect(faux.calls("ringo")).toHaveLength(0);
		expect(notices).toEqual(["[beetle] you → John: fix the parser", "[beetle] John → George: verify the parser fix"]);
	});
});

describe("command parsing", () => {
	test("/beetle parses reserved words only as whole arguments", () => {
		expect(parseBeetleCommand("")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("   ")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("off")).toEqual({ kind: "off" });
		expect(parseBeetleCommand("status")).toEqual({ kind: "status" });
		expect(parseBeetleCommand("models")).toEqual({ kind: "models" });
		expect(parseBeetleCommand("start")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("start fix it")).toEqual({ kind: "start", task: "fix it" });
		expect(parseBeetleCommand("say")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("say john")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("say john   ")).toEqual({ kind: "usage" });
		expect(parseBeetleCommand("say JOHN fix it")).toEqual({ kind: "say", target: "john", text: "fix it" });
		expect(parseBeetleCommand("say all stand down")).toEqual({ kind: "say", target: "all", text: "stand down" });
		expect(parseBeetleCommand("say nobody hello")).toEqual({ kind: "usage" });

		// A reserved word inside a sentence is a task, not a command.
		expect(parseBeetleCommand("off the rails")).toEqual({ kind: "start", task: "off the rails" });
		expect(parseBeetleCommand("status report for the release")).toEqual({
			kind: "start",
			task: "status report for the release",
		});
		expect(parseBeetleCommand("fix the flaky test")).toEqual({ kind: "start", task: "fix the flaky test" });
	});

	test("mentions route to a member only at the start of the input", () => {
		expect(routeMention("@john fix it")).toEqual({ member: "john", text: "fix it" });
		expect(routeMention("@John fix it")).toEqual({ member: "john", text: "fix it" });
		expect(routeMention("  @paul  look here ")).toEqual({ member: "paul", text: "look here" });
		expect(routeMention("@george multi\nline")).toEqual({ member: "george", text: "multi\nline" });
		expect(routeMention("@bob fix it")).toBeNull();
		expect(routeMention("@john")).toBeNull();
		expect(routeMention("@john   ")).toBeNull();
		expect(routeMention("hello @john")).toBeNull();
	});
});

describe("model picker", () => {
	interface PickLogEntry {
		title: string;
		items: BeetlePickOption[];
		initialIndex: number;
	}

	function pickerScript(answers: Array<number | null>, log: PickLogEntry[]) {
		return async (title: string, items: BeetlePickOption[], initialIndex: number) => {
			log.push({ title, items, initialIndex });
			return answers[log.length - 1] ?? null;
		};
	}

	test("the four-step walk maps each pick to a ref", async () => {
		const log: PickLogEntry[] = [];
		const result = await pickBeetleModels({
			pick: pickerScript([0, 1, 2, 0], log),
			sessionModel: "faux/live-session",
			models: [testModel("alpha"), testModel("beta")],
		});

		expect(result).toEqual({ john: "session", paul: "faux/alpha", george: "faux/beta", ringo: "session" });
		expect(log.map((entry) => entry.title)).toEqual([
			"Beetle · John (lead) — model 1/4",
			"Beetle · Paul (implementer) — model 2/4",
			"Beetle · George (verifier) — model 3/4",
			"Beetle · Ringo (builder) — model 4/4",
		]);

		// Row 0 is the session model; the rest mirror /model's rows.
		const first = log[0];
		expect(first?.items[0]?.label).toBe("* Follow the session model");
		expect(first?.items[0]?.description).toBe("faux/live-session");
		expect(first?.items[1]?.label).toBe("  faux/alpha");
		expect(first?.items[1]?.description).toContain("200k context");
		expect(first?.initialIndex).toBe(0);
	});

	test("cancelling any step cancels the whole flow", async () => {
		const log: PickLogEntry[] = [];
		const result = await pickBeetleModels({
			pick: pickerScript([0, 0, null, 0], log),
			sessionModel: "x",
			models: [testModel("alpha")],
		});
		expect(result).toBeNull();
		expect(log).toHaveLength(3);
	});

	test("an out-of-range answer cancels rather than guesses", async () => {
		const log: PickLogEntry[] = [];
		const result = await pickBeetleModels({
			pick: pickerScript([9], log),
			sessionModel: "x",
			models: [],
		});
		expect(result).toBeNull();
	});

	test("reconfiguring opens on the current value", async () => {
		const log: PickLogEntry[] = [];
		await pickBeetleModels({
			pick: pickerScript([2, 0, 0, 0], log),
			sessionModel: "x",
			current: { john: "faux/beta", paul: "session" },
			models: [testModel("alpha"), testModel("beta")],
		});
		expect(log[0]?.initialIndex).toBe(2);
		expect(log[0]?.items[2]?.label).toBe("* faux/beta");
		expect(log[0]?.items[0]?.label).toBe("  Follow the session model");
		expect(log[1]?.initialIndex).toBe(0); // an explicit session value opens on row 0
	});

	test("rows carry the same missing-key annotation as /model", async () => {
		process.env.BEETLE_TEST_KEY_PRESENT = "1";
		try {
			const log: PickLogEntry[] = [];
			await pickBeetleModels({
				pick: pickerScript([0, 0, 0, 0], log),
				sessionModel: "x",
				models: [
					testModel("alpha", { apiKeyEnv: "BEETLE_TEST_KEY_PRESENT" }),
					testModel("beta", { apiKeyEnv: "BEETLE_TEST_KEY_ABSENT" }),
				],
			});
			expect(log[0]?.items[1]?.description).not.toContain("no API key");
			expect(log[0]?.items[2]?.description).toContain("— no API key");
		} finally {
			delete process.env.BEETLE_TEST_KEY_PRESENT;
		}
	});
});
