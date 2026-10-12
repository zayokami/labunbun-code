/**
 * The confirmation on the way out, and the guard that asks it.
 *
 * What is under test is policy, not prose alone: which states deserve a
 * question, which answer leaves, and what every failure path does. The copy
 * assertions are exact because the truthfulness of the wording is the feature
 * — "the shells keep running" is the one sentence a user will remember
 * tomorrow, when they wonder whether the dev server they left behind is up.
 */
import { describe, expect, test } from "bun:test";
import { createExitGuard, EXIT_ANSWER, type ExitQuestion, type ExitWork, exitConfirmation } from "../src/exit-guard.ts";

const NOTHING: ExitWork = { turnRunning: false, subagents: 0, shells: 0 };
const ONE_SHELL: ExitWork = { turnRunning: false, subagents: 0, shells: 1 };

describe("exitConfirmation", () => {
	test("nothing running means nothing to say", () => {
		expect(exitConfirmation(NOTHING)).toBeNull();
	});

	test("a run names itself and its fate", () => {
		const question = exitConfirmation({ turnRunning: true, subagents: 0, shells: 0 });
		expect(question?.question).toBe("Still active: a run is in flight. Exiting stops the run where it is.");
		// Nothing survives this exit, so no follow-up command is named.
		expect(question?.question).not.toContain("/ps");
	});

	test("a run and its subagents: one sentence, both fates, the number intact", () => {
		expect(exitConfirmation({ turnRunning: true, subagents: 2, shells: 0 })?.question).toBe(
			"Still active: a run is in flight, 2 subagents. Exiting stops the run and terminates the subagents.",
		);
	});

	test("one subagent is said in the singular, in the count and the fate both", () => {
		expect(exitConfirmation({ turnRunning: false, subagents: 1, shells: 0 })?.question).toBe(
			"Still active: 1 subagent. Exiting terminates the subagent.",
		);
	});

	test("a lone shell survives, and the wording must not claim otherwise", () => {
		const question = exitConfirmation(ONE_SHELL);
		expect(question?.question).toBe(
			"Still active: 1 background shell. The shell keeps running; /ps lists it and /stop ends it.",
		);
		// The exit never kills a shell; a "terminates" in this wording would be
		// the one lie this question cannot afford.
		expect(question?.question).not.toContain("terminates");
	});

	test("several shells agree in number through every clause", () => {
		expect(exitConfirmation({ turnRunning: false, subagents: 0, shells: 3 })?.question).toBe(
			"Still active: 3 background shells. The shells keep running; /ps lists them and /stop ends one.",
		);
	});

	test("everything at once: every count, both fates, in the order the work dies", () => {
		expect(exitConfirmation({ turnRunning: true, subagents: 2, shells: 1 })?.question).toBe(
			"Still active: a run is in flight, 2 subagents, 1 background shell. " +
				"Exiting stops the run and terminates the subagents. " +
				"The shell keeps running; /ps lists it and /stop ends it.",
		);
	});

	test("the safe answer leads; the guard's exit label is the second row", () => {
		const options = exitConfirmation({ turnRunning: false, subagents: 1, shells: 0 })?.options;
		expect(options?.map((option) => option.label)).toEqual(["Stay", EXIT_ANSWER]);
		// The label is a contract with the guard below and the dialog above;
		// spelled here so a rewording on either side has to face the other.
		expect(EXIT_ANSWER).toBe("Exit anyway");
	});
});

/** A guard over fakes: the answers are the test's to control, and every call is recorded. */
function harness(work: () => ExitWork = () => NOTHING) {
	const calls = { asks: [] as ExitQuestion[], cancels: 0 };
	const order: string[] = [];
	let answer: () => Promise<string[] | null> = async () => null;
	const guard = createExitGuard({
		work,
		cancelPicker: () => {
			calls.cancels += 1;
			order.push("cancel");
		},
		ask: (question) => {
			calls.asks.push(question);
			order.push("ask");
			return answer();
		},
	});
	return {
		guard,
		calls,
		order,
		answer: (next: () => Promise<string[] | null>) => {
			answer = next;
		},
	};
}

describe("createExitGuard", () => {
	test("a quiet session leaves without a question", async () => {
		const t = harness();
		expect(await t.guard()).toBe(true);
		expect(t.calls.asks).toHaveLength(0);
		expect(t.calls.cancels).toBe(0);
	});

	test("the work is read at each request, not captured at construction", async () => {
		let work = NOTHING;
		const t = harness(() => work);
		expect(await t.guard()).toBe(true);
		work = ONE_SHELL;
		t.answer(async () => [EXIT_ANSWER]);
		expect(await t.guard()).toBe(true);
		expect(t.calls.asks).toHaveLength(1);
	});

	test("the exit answer leaves", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => [EXIT_ANSWER]);
		expect(await t.guard()).toBe(true);
	});

	test("the safe answer — and a dismissal — stay", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => ["Stay"]);
		expect(await t.guard()).toBe(false);
		t.answer(async () => null);
		expect(await t.guard()).toBe(false);
		// Both went through the question; Esc is not a second way out.
		expect(t.calls.asks).toHaveLength(2);
	});

	test("an answer nobody offered stays", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => ["y"]);
		expect(await t.guard()).toBe(false);
	});

	test("a second request while the question is up is refused, and nothing is asked twice", async () => {
		const t = harness(() => ONE_SHELL);
		let release: (answers: string[] | null) => void = () => {};
		t.answer(() => new Promise((resolve) => (release = resolve)));
		const first = t.guard();
		const second = await t.guard();
		expect(second).toBe(false);
		expect(t.calls.asks).toHaveLength(1);
		release([EXIT_ANSWER]);
		expect(await first).toBe(true);
	});

	test("the guard re-arms after an answer — a stayed exit can be asked again", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => ["Stay"]);
		expect(await t.guard()).toBe(false);
		t.answer(async () => [EXIT_ANSWER]);
		expect(await t.guard()).toBe(true);
		expect(t.calls.asks).toHaveLength(2);
	});

	test("the picker is dismissed before the question goes up", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => [EXIT_ANSWER]);
		await t.guard();
		expect(t.order).toEqual(["cancel", "ask"]);
	});

	test("a dialog that rejects fails open — doubt leaves", async () => {
		const t = harness(() => ONE_SHELL);
		t.answer(async () => {
			throw new Error("boom");
		});
		expect(await t.guard()).toBe(true);
	});

	test("a cancel that throws fails open too", async () => {
		const guard = createExitGuard({
			work: () => ONE_SHELL,
			cancelPicker: () => {
				throw new Error("boom");
			},
			ask: async () => [EXIT_ANSWER],
		});
		expect(await guard()).toBe(true);
	});
});
