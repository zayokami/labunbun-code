/**
 * A finished background shell, as the session experiences it.
 *
 * The claim being pinned: nobody has to poll. An idle session is woken with a
 * notice that says where it came from and how the command ended; a session
 * mid-turn gets the same notice at the turn's natural end, not by cutting into
 * a model call that has nothing to do with it (that distinction is visible —
 * the turn's own request must go out *without* the notice, and the next one
 * with it); and the setting turns the whole thing off, turn and line together,
 * for a user who would rather keep polling by hand.
 *
 * The shells here end by emitting `close` on an `EventEmitter` adopted through
 * the manager — the completion path is the same one a real process takes, with
 * none of a real process's timing.
 */
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { AgentSession, type AnyTool, buildTool } from "@labunbun/agent";
import { FAUX_MODEL, type FauxStep, fauxProvider, type StreamFn } from "@labunbun/ai";
import { type BackgroundShell, BackgroundShellManager } from "@labunbun/tools";
import { z } from "zod";
import {
	attachShellNotices,
	SHELL_NOTICE_TAIL_CHARS,
	shellNotice,
	shellNoticeLine,
} from "../src/background-notifications.ts";

/**
 * Await, but give up after `ms` with `undefined`.
 *
 * A notice that fails to arrive must fail the test rather than hang it: a
 * promise that never settles does not respect bun's per-test timeout, and the
 * fix that "delivers" a notice by never sending anything (steering into an
 * idle session, say) is exactly this shape. The resolved token is a string so
 * the success value and the timeout value are distinguishable.
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

function sessionWith(steps: FauxStep[], tools: AnyTool[] = []) {
	const faux = fauxProvider(steps);
	// The session hands `streamFn` its live message array, and faux keeps the
	// context objects as given — so reading `faux.receivedContexts` after the
	// fact shows every call the conversation's *final* state, and the queue
	// test below is precisely about what each call did not yet carry. Snapshot
	// the request at call time instead.
	const requests: string[] = [];
	const streamFn: StreamFn = async function* (model, context, options) {
		requests.push(JSON.stringify(context.messages));
		yield* faux.streamFn(model, context, options);
	};
	const session = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt: "test",
		tools,
		deps: { streamFn },
	});
	return { faux, requests, session };
}

/** Register a fake child through the real `adopt` path. */
function adopt(manager: BackgroundShellManager, command: string, proc: EventEmitter): BackgroundShell {
	return manager.adopt({
		child: proc as unknown as ChildProcess,
		command,
		cwd: "/w/repo",
		startTime: Date.now(),
		stdout: "",
		stderr: "",
	});
}

describe("notice text", () => {
	const shell = (over: Partial<BackgroundShell> = {}): BackgroundShell => ({
		id: "shell_3",
		command: "npm test",
		cwd: "/w/repo",
		outputFile: "/tmp/lbb-shell_3.log",
		startTime: 1_000_000,
		status: "completed",
		exitCode: 0,
		...over,
	});

	test("the envelope says what it is, and what happened", () => {
		const text = shellNotice(shell(), 1_042_000, { text: "42 tests passed\n", truncated: false });
		const first = text.split("\n")[0] ?? "";
		expect(first).toContain("automated");
		expect(first).toContain("not from the user");
		expect(text).toContain("shell_3 finished: exit code 0 after 42s");
		expect(text).toContain("Command: npm test");
		expect(text).toContain("Full log: /tmp/lbb-shell_3.log");
		expect(text).toContain("42 tests passed");
		expect(text).toContain("not a user instruction");
	});

	test("a long log is announced as a tail of it", () => {
		const text = shellNotice(shell(), 1_042_000, { text: "…last line\n", truncated: true });
		expect(text).toContain(`Last ${SHELL_NOTICE_TAIL_CHARS} characters`);
	});

	test("a silent command says so rather than trailing off", () => {
		const text = shellNotice(shell(), 1_042_000, { text: "", truncated: false });
		expect(text).toContain("(no output)");
	});

	test("the user's line names the shell, not the envelope", () => {
		const line = shellNoticeLine(shell(), 1_042_000);
		expect(line).toContain("shell_3");
		expect(line).toContain("exit code 0");
		expect(line).toContain("42s");
	});
});

describe("a finished shell reaches the session", () => {
	test("an idle session is woken with the notice", async () => {
		const { requests, session } = sessionWith([{ text: "Noted." }]);
		const manager = new BackgroundShellManager();
		const lines: string[] = [];
		attachShellNotices({ manager, getSession: () => session, onNotice: (text) => lines.push(text) });

		const proc = new EventEmitter();
		const shell = manager.adopt({
			child: proc as unknown as ChildProcess,
			command: "npm test",
			cwd: "/w/repo",
			startTime: Date.now() - 42_000,
			stdout: "42 tests passed\n",
			stderr: "",
		});

		const ended = new Promise<"ended">((resolve) => {
			const unsubscribe = session.on((event) => {
				if (event.type !== "agent_end") return;
				unsubscribe();
				resolve("ended");
			});
		});
		proc.emit("close", 0);
		expect(await within(ended, 5_000)).toBe("ended");

		// The notice is what the model's first waking request carries: provenance
		// line, the outcome, the command, the whole log's path and its tail.
		const sent = requests[0] ?? "";
		expect(sent).toContain("[background shell notification");
		expect(sent).toContain("not from the user");
		expect(sent).toContain(`${shell.id} finished: exit code 0`);
		expect(sent).toContain("Full log:");
		expect(sent).toContain("42 tests passed");

		// What the user saw is one line about the shell — not the envelope.
		expect(lines).toHaveLength(1);
		expect(lines[0] ?? "").toContain(shell.id);
		expect(lines[0] ?? "").toContain("notifying the agent");
	});

	test("a completion during a run waits for the turn, then starts the next", async () => {
		const entered = Promise.withResolvers<"entered">();
		const release = Promise.withResolvers<"released">();
		const gate: AnyTool = buildTool({
			name: "gate",
			description: "waits for the test",
			inputSchema: z.object({}),
			call: async () => {
				entered.resolve("entered");
				await release.promise;
				return { content: [{ type: "text", text: "released" }] };
			},
		});
		const { requests, session } = sessionWith(
			[{ toolCalls: [{ name: "gate", arguments: {} }] }, { text: "still working" }, { text: "the build is done" }],
			[gate],
		);
		const manager = new BackgroundShellManager();
		attachShellNotices({ manager, getSession: () => session });

		const run = session.prompt("start the long thing");
		expect(await within(entered.promise, 5_000)).toBe("entered");

		const proc = new EventEmitter();
		adopt(manager, "npm test", proc);
		proc.emit("close", 0);

		// Queued for the turn boundary — the run is still on its first tool call
		// and the notice has not entered the conversation, nor been dropped.
		expect(session.isRunning).toBe(true);
		expect(JSON.stringify(session.messages)).not.toContain("background shell notification");

		release.resolve("released");
		expect(await within(run, 10_000)).toBe("completed");

		// Three requests, and the notice is in the third: the call after the
		// gate ran without it, and the turn the queue then started carries it.
		// Steering would show the opposite shape — two calls, the notice
		// already in the second — because it delivers ahead of the very next
		// model call. This pair is where the two queues differ.
		expect(requests).toHaveLength(3);
		expect(requests[1] ?? "").not.toContain("background shell notification");
		expect(requests[2] ?? "").toContain("background shell notification");
	}, 15_000);

	test("the switch silences both the turn and the line", async () => {
		const { faux, session } = sessionWith([{ text: "must not be asked" }]);
		const manager = new BackgroundShellManager();
		const lines: string[] = [];
		attachShellNotices({
			manager,
			getSession: () => session,
			enabled: () => false,
			onNotice: (text) => lines.push(text),
		});

		const proc = new EventEmitter();
		adopt(manager, "npm test", proc);
		proc.emit("close", 0);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(lines).toHaveLength(0);
		expect(session.messages).toHaveLength(0);
		expect(faux.receivedContexts).toHaveLength(0);
	});
});
