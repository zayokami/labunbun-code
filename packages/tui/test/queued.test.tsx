/**
 * The three verbs for a message typed while a turn is running: Tab queues it
 * behind the turn, Enter steers it into the turn, Escape stops the turn and
 * sends it now.
 *
 * The session's side of all three already has tests (loop.test.ts covers when a
 * steered message lands and that an interrupt drops it). What is under test
 * here is the half only the UI can get wrong — which key calls which method,
 * and whether the screen admits that the message has not been sent yet.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList } from "../src/components/MessageList.tsx";
import { QueuedMessages, queuedHint, queuedPreview } from "../src/components/QueuedMessages.tsx";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import { initialUiState, type QueuedMessage, reduceEvent, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const withTheme = (node: React.ReactNode) => <ThemeContext.Provider value={DARK_THEME}>{node}</ThemeContext.Provider>;

const queued = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
	id: "q1",
	text: "and also fix the other test",
	mode: "queue",
	...overrides,
});

describe("the queued-message preview", () => {
	test("one line per message, folded and elided", () => {
		expect(queuedPreview("fix the\n  thing")).toBe("fix the thing");
		const long = "x".repeat(200);
		const preview = queuedPreview(long);
		expect(preview).toHaveLength(72);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("the hint says what Enter does for this turn, not what it can do in general", () => {
		// Enter means different things depending on whether the turn will call the
		// model again; naming both would leave the user to guess which one is live.
		expect(queuedHint(true)).toContain("Enter steer");
		expect(queuedHint(true)).toContain("next tool");
		expect(queuedHint(false)).toContain("Enter queue");
		expect(queuedHint(false)).toContain("turn ends");
	});

	test("in vim the hint stops promising that Escape sends", () => {
		// Escape is the vim mode key, so in vim it never sends the buffer — a legend
		// that kept the "& send" half would be describing a key that does not exist.
		expect(queuedHint(true, true)).toBe("Tab queue · Enter steer (at the next tool) · Esc interrupt");
		expect(queuedHint(false, true)).not.toContain("send");
		expect(queuedHint(true, false)).toContain("Esc interrupt & send");
	});

	test("says nothing at all when nothing is waiting", () => {
		const { lastFrame } = render(withTheme(<QueuedMessages queued={[]} canSteer />));
		expect(lastFrame() ?? "").toBe("");
	});

	test("draws steered and queued messages apart", () => {
		const frame =
			render(
				withTheme(
					<QueuedMessages
						queued={[
							queued({ id: "q1", text: "wait for the turn", mode: "queue" }),
							queued({ id: "q2", text: "go in now", mode: "steer" }),
						]}
						canSteer
					/>,
				),
			).lastFrame() ?? "";
		expect(frame).toContain("↳ wait for the turn");
		expect(frame).toContain("≫ go in now");
	});

	test("counts what it does not list", () => {
		const many = ["a", "b", "c", "d", "e"].map((text, i) => queued({ id: `q${i}`, text }));
		const frame = render(withTheme(<QueuedMessages queued={many} canSteer />)).lastFrame() ?? "";
		expect(frame).toContain("↳ a");
		expect(frame).not.toContain("↳ d");
		expect(frame).toContain("… +2 more");
	});
});

describe("the transcript's steered marker", () => {
	test("a message sent into a turn reads differently from one that started it", () => {
		const frame =
			render(
				withTheme(
					<MessageList
						entries={[
							{ kind: "user", text: "start the work" },
							{ kind: "user", text: "actually, this way", steered: true },
						]}
					/>,
				),
			).lastFrame() ?? "";
		expect(frame).toContain("> start the work");
		expect(frame).toContain("≫ actually, this way");
	});
});

describe("when the queue empties", () => {
	const state = (): UiState => ({ ...initialUiState(), queued: [queued()] });

	test("a turn starting means the queue was drained into the transcript", () => {
		// The loop drains steering right before turn_start and follow-ups just
		// before that, so nothing listed is still waiting once a turn begins.
		expect(reduceEvent(state(), { type: "turn_start" }).queued).toEqual([]);
	});

	test("a run ending clears what the run took with it", () => {
		const ended = reduceEvent(state(), { type: "agent_end", reason: "completed", messages: [] });
		expect(ended.queued).toEqual([]);
	});

	test("an interrupt says how many messages it threw away", () => {
		const two = { ...state(), queued: [queued({ id: "q1" }), queued({ id: "q2", mode: "steer" as const })] };
		const aborted = reduceEvent(two, { type: "agent_end", reason: "aborted", messages: [] });
		expect(aborted.entries.map((e) => (e.kind === "info" ? e.text : e.kind))).toContain(
			"[interrupted · 2 queued messages dropped]",
		);
		// Nothing was waiting, so there is nothing to report beyond the interrupt.
		const plain = reduceEvent({ ...state(), queued: [] }, { type: "agent_end", reason: "aborted", messages: [] });
		expect(plain.entries.map((e) => (e.kind === "info" ? e.text : e.kind))).toContain("[interrupted]");
	});

	test("a clean end keeps the transcript free of queue bookkeeping", () => {
		const noQueue = reduceEvent({ ...state(), queued: [] }, { type: "agent_end", reason: "completed", messages: [] });
		expect(noQueue.entries.some((e) => e.kind === "info")).toBe(false);
	});
});

/** A session whose queue methods are recorded, then called for real. */
function setup(vim = false) {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const faux = fauxProvider([{ text: "first answer" }, { text: "second answer" }, { text: "third answer" }]);
	const streamFn: StreamFn = async function* (model, context, options) {
		for await (const event of faux.streamFn(model, context, options)) {
			if (event.type === "done") {
				// The turn is in flight while the keys are pressed.
				streaming.resolve();
				await release.promise;
			}
			yield event;
		}
	};

	const session = new AgentSession({ model: FAUX_MODEL, maxTurns: 4, deps: { streamFn } });
	const calls: Array<{ kind: "queue" | "steer" | "prompt"; text: string }> = [];
	const realSteer = session.steer.bind(session);
	const realFollowUp = session.followUp.bind(session);
	const realPrompt = session.prompt.bind(session);
	session.steer = (text: string) => {
		calls.push({ kind: "steer", text });
		realSteer(text);
	};
	session.followUp = (text: string) => {
		calls.push({ kind: "queue", text });
		realFollowUp(text);
	};
	session.prompt = (text: string) => {
		calls.push({ kind: "prompt", text });
		return realPrompt(text);
	};

	// Idle, as `mountRepl` seeds it: the keys only change meaning once a run has
	// actually started, which is what the first submit is here to do.
	const store = createStore<UiState>(initialUiState(vim));
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);

	return {
		session,
		store,
		calls,
		streaming,
		release,
		stdin: view.stdin,
		frame: () => view.lastFrame() ?? "",
		queuedNow: () => store.get().queued,
		userEntries: () => store.get().entries.filter((e) => e.kind === "user"),
		unmount: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

async function type(stdin: { write: (text: string) => void }, text: string) {
	stdin.write(text);
	await delay(20);
}

describe("the three verbs in the REPL", () => {
	test("Tab queues the message behind the turn instead of sending it", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		await type(h.stdin, "and then this");
		h.stdin.write("\t");
		await delay(40);

		expect(h.calls).toEqual([
			{ kind: "prompt", text: "run something slow" },
			{ kind: "queue", text: "and then this" },
		]);
		expect(h.queuedNow().map((q) => [q.mode, q.text])).toEqual([["queue", "and then this"]]);
		// The message is in the transcript — it was typed — and the preview is what
		// says it has not gone out yet. The old `[queued]` info line said the same
		// thing in a wall of text and is gone.
		expect(h.frame()).toContain("↳ and then this");
		expect(h.frame()).not.toContain("[queued]");

		h.release.resolve();
		await delay(200);
		// Delivered at the end of the turn it was queued behind, and no longer
		// waiting for anything.
		expect(h.session.messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content)).toEqual([
			"run something slow",
			"and then this",
		]);
		expect(h.queuedNow()).toEqual([]);
		h.unmount();
	});

	test("Enter steers when the turn has tools to finish", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		// A tool is executing, so the loop will call the model again and a steered
		// message has somewhere to land.
		h.store.set((s) => reduceEvent(s, { type: "tool_execution_start", callId: "c1", toolName: "Bash", input: {} }));
		await type(h.stdin, "no, do it the other way");
		h.stdin.write("\r");
		await delay(40);

		expect(h.calls.at(-1)).toEqual({ kind: "steer", text: "no, do it the other way" });
		expect(h.queuedNow().map((q) => q.mode)).toEqual(["steer"]);
		expect(h.frame()).toContain("≫ no, do it the other way");
		// The hint has to promise what the key actually just did.
		expect(h.frame()).toContain("Enter steer");
		h.unmount();
	});

	test("Enter queues when the turn is ending anyway, rather than promising a steer", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		// No tools running: the model is mid-answer, so the only thing that can
		// happen next is the turn ending.
		await type(h.stdin, "one more thing");
		h.stdin.write("\r");
		await delay(40);

		expect(h.calls.at(-1)).toEqual({ kind: "queue", text: "one more thing" });
		expect(h.frame()).toContain("Enter queue");
		h.unmount();
	});

	test("Escape stops the turn and sends what was typed, in that order", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		await type(h.stdin, "stop — do this instead");
		h.stdin.write("\x1b");
		await delay(30);
		// The interrupt is immediate; the send has to wait for the session to let
		// go of the run it is still unwinding.
		expect(h.session.isInterrupted).toBe(true);
		expect(h.calls.filter((c) => c.kind === "prompt")).toHaveLength(1);

		h.release.resolve();
		await delay(250);

		expect(h.calls.filter((c) => c.kind === "prompt").map((c) => c.text)).toEqual([
			"run something slow",
			"stop — do this instead",
		]);
		// Sent *after* the interrupt, not queued behind it: a plain interrupt was
		// the old meaning of this key, and the typed text would have been lost.
		expect(h.calls.some((c) => c.kind === "queue" || c.kind === "steer")).toBe(false);
		expect(
			h
				.userEntries()
				.map((e) => (e.kind === "user" ? [e.text, e.steered ?? false] : []))
				.slice(-2),
		).toEqual([
			["run something slow", false],
			["stop — do this instead", true],
		]);
		h.unmount();
	});

	test("Escape with an empty prompt is still a plain interrupt", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		h.stdin.write("\x1b");
		await delay(30);
		h.release.resolve();
		await delay(200);

		expect(h.calls.filter((c) => c.kind === "prompt")).toHaveLength(1);
		h.unmount();
	});

	// Escape is how a vim user leaves insert — a press made by reflex, dozens of
	// times an hour. Giving that press the power to fire the buffer as a prompt
	// *and* kill the run would make the most common keystroke the most dangerous.
	test("in vim, Escape stops at the interrupt and leaves the buffer alone", async () => {
		const h = setup(true);
		await type(h.stdin, "i"); // NORMAL → INSERT
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		await type(h.stdin, "half-typed thought");
		h.stdin.write("\x1b"); // leaves insert; the run keeps going
		await delay(30);
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("\x1b"); // NORMAL: nothing to cancel, so the host gets it
		await delay(30);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(250);
		// Interrupted, and that is all: the text stays in the buffer, unqueued and
		// unsent, for the user to send deliberately.
		expect(h.calls.filter((c) => c.kind === "prompt")).toHaveLength(1);
		expect(h.calls.some((c) => c.kind === "queue" || c.kind === "steer")).toBe(false);
		expect(h.queuedNow()).toEqual([]);
		h.unmount();
	});

	// A command is not a message: it acts on the app now. Queueing `/stop` behind
	// the turn it is meant to stop would be worse than not offering it at all.
	test("a slash command is handled during a run, not queued", async () => {
		const h = setup();
		await type(h.stdin, "run something slow");
		h.stdin.write("\r");
		await h.streaming.promise;

		await type(h.stdin, "/help");
		h.stdin.write("\r");
		await delay(40);

		expect(h.calls.filter((c) => c.kind !== "prompt")).toEqual([]);
		expect(h.queuedNow()).toEqual([]);
		expect(h.frame()).toContain("Commands:");
		h.unmount();
	});
});
