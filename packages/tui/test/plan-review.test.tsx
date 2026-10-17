/**
 * The plan review surface, and the slot that owns it.
 *
 * The permission dialog asks "may I"; this one asks "is this the plan". The
 * difference is the third answer: a rejection that carries a sentence the
 * planner can act on. These tests pin the three answers, the text that travels
 * with the third one, and the two ways the surface can end without an answer
 * (Esc, and the slot being taken down by a replacement or an abort).
 *
 * The slot's tests live here rather than in a file of their own because the two
 * halves are one contract: the component resolves the store's closure, and the
 * slot is the only thing that gets to decide which closure is on screen.
 */
import { describe, expect, test } from "bun:test";
import { PAD_HOLD_MS, type PadAction } from "@labunbun/gamepad";
import { render } from "ink-testing-library";
import { act } from "react";
import { PLAN_REVIEW_MAX, PlanReviewDialog } from "../src/components/PlanReviewDialog.tsx";
import { createPlanReviewSlot } from "../src/plan-review-slot.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { PlanReviewDialogState, PlanReviewResult } from "../src/ui-state.ts";
import { type FakePad, fakePad, padAction } from "./fake-pad.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLAN = "Add a cache. First read the existing loader, then put the cache in front of it.";

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

/** Render one review and hand back the promise the REPL is awaiting. */
function open(plan = PLAN, pad?: FakePad) {
	const answers: Array<PlanReviewResult | null> = [];
	const view = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<PlanReviewDialog plan={plan} resolve={(result) => answers.push(result)} pad={pad} />
			</ThemeContext.Provider>
		) as React.ReactElement,
	);
	return {
		stdin: view.stdin,
		answers,
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		unmount: view.unmount,
	};
}

/** React reads this off `globalThis`; its types do not declare it. */
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Hand one action to the pad, and let React finish with it before reading on. */
async function press(pad: FakePad, action: PadAction): Promise<void> {
	const prior = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	try {
		await act(async () => {
			pad.push(action);
		});
	} finally {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = prior;
	}
}

describe("PlanReviewDialog", () => {
	test("shows the plan and the three answers under a review title", async () => {
		const d = open();
		await delay(30);
		const frame = d.frame();
		expect(frame).toContain("Plan for your approval");
		expect(frame).toContain("Add a cache.");
		expect(frame).toContain("1. Yes, implement this plan");
		expect(frame).toContain("2. No, keep planning");
		expect(frame).toContain("3. Send feedback to the planner");
		expect(d.answers).toEqual([]);
		d.unmount();
	});

	test("Enter on the first row approves", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers).toEqual([{ approved: true }]);
		d.unmount();
	});

	test("y approves and n keeps planning", async () => {
		const approved = open();
		await delay(30);
		approved.stdin.write("y");
		await delay(30);
		expect(approved.answers).toEqual([{ approved: true }]);
		approved.unmount();

		const rejected = open();
		await delay(30);
		rejected.stdin.write("n");
		await delay(30);
		expect(rejected.answers).toEqual([{ approved: false }]);
		rejected.unmount();
	});

	test("a number answers that row directly", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("2");
		await delay(30);
		expect(d.answers).toEqual([{ approved: false }]);
		d.unmount();
	});

	test("3 opens the input, and Enter sends the typed sentence", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("3");
		await delay(30);
		// Opening the input is not an answer.
		expect(d.answers).toEqual([]);
		expect(d.frame()).toContain("Feedback for the planner");

		d.stdin.write("smaller diff");
		await delay(30);
		expect(d.frame()).toContain("smaller diff");
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers).toEqual([{ approved: false, feedback: "smaller diff" }]);
		d.unmount();
	});

	test("the feedback input takes y and n as letters, not shortcuts", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("3");
		await delay(30);
		d.stdin.write("ny");
		await delay(30);
		expect(d.answers).toEqual([]);
		expect(d.frame()).toContain("ny");
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers).toEqual([{ approved: false, feedback: "ny" }]);
		d.unmount();
	});

	test("Backspace deletes one character in the input", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("3");
		await delay(30);
		d.stdin.write("planx");
		await delay(30);
		d.stdin.write("\x7f");
		await delay(30);
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers).toEqual([{ approved: false, feedback: "plan" }]);
		d.unmount();
	});

	test("Esc in the input returns to the answers without answering", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("3");
		await delay(30);
		d.stdin.write("half a thought");
		await delay(30);
		d.stdin.write("\x1b");
		await delay(30);
		expect(d.answers).toEqual([]);
		expect(d.frame()).toContain("2. No, keep planning");

		// A second Esc, now on the option list, cancels the review itself.
		d.stdin.write("\x1b");
		await delay(30);
		expect(d.answers).toEqual([null]);
		d.unmount();
	});

	test("Esc on the option list cancels", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("\x1b");
		await delay(30);
		expect(d.answers).toEqual([null]);
		d.unmount();
	});

	test("a move and Enter in one read answer the moved row", async () => {
		const d = open();
		await delay(30);
		d.stdin.write("\x1b[B\r"); // down, then Enter, in the same read
		await delay(30);
		expect(d.answers).toEqual([{ approved: false }]);
		d.unmount();
	});

	test("a long plan is cut at the cap and says so", async () => {
		const plan = `${"x".repeat(PLAN_REVIEW_MAX)}TAIL`;
		const d = open(plan);
		await delay(30);
		const frame = d.frame();
		expect(frame).toContain(`plan truncated: showing the first ${PLAN_REVIEW_MAX} of ${plan.length} characters`);
		expect(frame).not.toContain("TAIL");
		d.unmount();
	});

	test("the hint names the pad only when a pad is attached", async () => {
		const bare = open();
		await delay(30);
		expect(bare.frame()).not.toContain("✕");
		bare.unmount();

		const pad = fakePad();
		const d = open(PLAN, pad);
		await delay(30);
		// The long hint wraps at the terminal width, so the two button names are
		// asserted separately rather than as one contiguous run.
		expect(d.frame()).toContain("✕ confirm");
		expect(d.frame()).toContain("○ cancel");
		d.unmount();
	});
});

describe("PlanReviewDialog and the pad", () => {
	test("✕ takes the highlighted answer, ○ cancels", async () => {
		const pad = fakePad();
		const d = open(PLAN, pad);
		await delay(PAD_HOLD_MS * 2);

		await press(pad, padAction("down"));
		await press(pad, padAction("confirm"));
		expect(d.answers).toEqual([{ approved: false }]);

		// The mapper sends a release after every press; it is not a second answer.
		await press(pad, padAction("confirm", { phase: "release" }));
		expect(d.answers).toEqual([{ approved: false }]);
		d.unmount();

		const cancelled = fakePad();
		const c = open(PLAN, cancelled);
		await delay(PAD_HOLD_MS * 2);
		await press(cancelled, padAction("cancel", { button: "circle" }));
		expect(c.answers).toEqual([null]);
		c.unmount();
	});

	test("in the feedback input ○ goes back and ✕ sends, with no way to type", async () => {
		const pad = fakePad();
		const d = open(PLAN, pad);
		await delay(PAD_HOLD_MS * 2);

		// Down twice to the third row, then confirm opens the input.
		await press(pad, padAction("down"));
		await press(pad, padAction("down"));
		await press(pad, padAction("confirm"));
		expect(d.answers).toEqual([]);
		expect(d.frame()).toContain("Feedback for the planner");

		// ○ backs out to the answers; the same answer is still there.
		await press(pad, padAction("cancel", { button: "circle" }));
		expect(d.answers).toEqual([]);
		expect(d.frame()).toContain("2. No, keep planning");

		// ✕ on the third row again, then ✕ in the input: a controller cannot type,
		// so sending the empty sentence is still a plain "keep planning".
		await press(pad, padAction("confirm"));
		await press(pad, padAction("confirm"));
		expect(d.answers).toEqual([{ approved: false, feedback: "" }]);
		d.unmount();
	});

	test("a press from before the review is not an answer", async () => {
		const pad = fakePad();
		const d = open(PLAN, pad);
		await delay(30);

		await press(pad, padAction("confirm", { heldMs: PAD_HOLD_MS * 8 }));
		await press(pad, padAction("cancel", { heldMs: PAD_HOLD_MS * 8, button: "circle" }));
		expect(d.answers).toEqual([]);

		// And the review is still usable afterwards.
		await press(pad, padAction("confirm"));
		expect(d.answers).toEqual([{ approved: true }]);
		d.unmount();
	});
});

function slotHarness() {
	const shown: Array<PlanReviewDialogState | null> = [];
	const slot = createPlanReviewSlot({ show: (planReview) => shown.push(planReview) });
	return {
		slot,
		/** The dialog currently on screen. */
		current: () => shown.at(-1) ?? null,
		screens: () => shown.length,
	};
}

describe("plan review slot", () => {
	test("shows the plan and settles with the reviewer's answer", async () => {
		const { slot, current } = slotHarness();
		const reviewing = slot.request("the plan");

		expect(current()?.plan).toBe("the plan");

		current()?.resolve({ approved: false, feedback: "use a smaller diff" });

		expect(await settled(reviewing)).toEqual({ approved: false, feedback: "use a smaller diff" });
		expect(current()).toBeNull();
	});

	test("clear takes the dialog down and answers it canceled", async () => {
		const { slot, current } = slotHarness();
		const reviewing = slot.request("the plan");

		slot.clear();

		expect(await settled(reviewing)).toBeNull();
		expect(current()).toBeNull();
	});

	test("clear with nothing on screen renders nothing at all", () => {
		const { slot, screens } = slotHarness();
		slot.clear();
		expect(screens()).toBe(0);
	});

	test("a second request replaces the first, which is settled as canceled", async () => {
		const { slot, current } = slotHarness();
		const first = slot.request("the first plan");
		const second = slot.request("the second plan");

		expect(await settled(first)).toBeNull();
		expect(current()?.plan).toBe("the second plan");

		current()?.resolve({ approved: true });
		expect(await settled(second)).toEqual({ approved: true });
		expect(current()).toBeNull();
	});

	test("an answer from a replaced dialog cannot close the one on screen", async () => {
		const { slot, current, screens } = slotHarness();
		const first = slot.request("the first plan");
		const replaced = current();
		const second = slot.request("the second plan");

		replaced?.resolve({ approved: true });

		expect(await settled(first)).toBeNull();
		expect(current()?.plan).toBe("the second plan");
		expect(screens()).toBe(2);

		current()?.resolve({ approved: false });
		expect(await settled(second)).toEqual({ approved: false });
	});

	test("an abort takes the live dialog down and answers it canceled", async () => {
		const { slot, current, screens } = slotHarness();
		const controller = new AbortController();
		const reviewing = slot.request("the plan", controller.signal);

		controller.abort();

		expect(await settled(reviewing)).toBeNull();
		expect(current()).toBeNull();

		// The listener was detached when the dialog settled: aborting again writes
		// nothing — one screen for the request, one for the cancel.
		controller.abort();
		expect(screens()).toBe(2);
	});

	test("an already-aborted signal answers without a screen, and leaves a live dialog alone", async () => {
		const { slot, current } = slotHarness();
		const live = slot.request("the live plan");
		const already = new AbortController();
		already.abort();

		expect(await settled(slot.request("the doomed plan", already.signal))).toBeNull();
		expect(current()?.plan).toBe("the live plan");

		current()?.resolve({ approved: true });
		expect(await settled(live)).toEqual({ approved: true });
	});
});
