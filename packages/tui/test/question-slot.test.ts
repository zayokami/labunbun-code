/**
 * The question dialog's slot: what is on screen, and how it stops being.
 *
 * The permission dialog next door can be denied by an abort (`permission-queue`
 * `clear`), because a run that is over must not leave a tool call awaiting an
 * answer nobody will give. The question dialog had no such ending: Esc was the
 * only exit, and Ctrl+C while a question was up left the dialog asking about a
 * run that had already been cancelled — the tool's promise pending forever, the
 * turn with it, and nothing left on screen that would end either.
 *
 * Every wait on an answer goes through `settled`, because the failure being
 * guarded against is exactly a promise that never settles: asserted with a bare
 * `await`, a slot that stops answering turns this file into a hang that the
 * runner does not time out — the whole suite stops, and the mutation that broke
 * the slot reads as "no result" instead of as the failing test it is.
 */
import { describe, expect, test } from "bun:test";
import { createQuestionSlot } from "../src/question-slot.ts";
import type { QuestionDialogState, UiQuestion } from "../src/ui-state.ts";

function questions(question: string): UiQuestion[] {
	return [{ question, header: "Pick", options: [{ label: "a", description: "the first" }, { label: "b" }] }];
}

/** Nothing arrived before the deadline — a hang, made into an answer. */
const NEVER = Symbol("never settled");

async function settled<T>(promise: Promise<T>, ms = 1000): Promise<T | typeof NEVER> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof NEVER>((resolve) => {
		timer = setTimeout(() => resolve(NEVER), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function harness() {
	const shown: Array<QuestionDialogState | null> = [];
	const slot = createQuestionSlot({ show: (question) => shown.push(question) });
	return {
		slot,
		/** The dialog currently on screen. */
		current: () => shown.at(-1) ?? null,
		screens: () => shown.length,
	};
}

describe("question slot", () => {
	test("shows the questions and settles with the answer", async () => {
		const { slot, current } = harness();
		const asked = slot.ask(questions("Which one?"));

		expect(current()?.questions[0]?.question).toBe("Which one?");

		current()?.resolve(["a"]);

		expect(await asked).toEqual(["a"]);
		expect(current()).toBeNull();
	});

	// The defect this file exists for: the abort path.
	test("clear takes the dialog off the screen and answers it canceled", async () => {
		const { slot, current } = harness();
		const asked = slot.ask(questions("Which one?"));

		slot.clear();

		expect(await settled(asked)).toBeNull();
		expect(current()).toBeNull();
	});

	test("clear with nothing on screen renders nothing at all", async () => {
		// A blank store write is a repaint of the whole tree to say what it already
		// says — and the abort path calls this on every Ctrl+C, dialog or not.
		const { slot, screens } = harness();

		slot.clear();

		expect(screens()).toBe(0);
	});

	// Two questions at once cannot happen through the tool (AskUserQuestion is not
	// concurrency-safe, so a turn asks one at a time), but a promise left pending
	// because this file trusted a caller's discipline is the same hang.
	test("a second ask replaces the first, which is settled as canceled", async () => {
		const { slot, current } = harness();
		const first = slot.ask(questions("The first one"));
		const second = slot.ask(questions("The second one"));

		expect(await settled(first)).toBeNull();
		expect(current()?.questions[0]?.question).toBe("The second one");

		current()?.resolve(["b"]);
		expect(await settled(second)).toEqual(["b"]);
		expect(current()).toBeNull();
	});

	test("an answer from a replaced dialog cannot close the one on screen", async () => {
		// The replaced dialog's own resolve is still reachable — its component is
		// unmounted by the next render, not synchronously with the replacement — and
		// a keypress queued behind the replacement would otherwise answer the new
		// question with the old question's answer.
		const { slot, current, screens } = harness();
		const first = slot.ask(questions("The first one"));
		const replaced = current();
		const second = slot.ask(questions("The second one"));

		replaced?.resolve(["a"]);

		expect(await settled(first)).toBeNull();
		expect(current()?.questions[0]?.question).toBe("The second one");
		// Not one render happened for it: the stale answer did not touch the slot.
		expect(screens()).toBe(2);

		current()?.resolve(["b"]);
		expect(await settled(second)).toEqual(["b"]);
	});
});
