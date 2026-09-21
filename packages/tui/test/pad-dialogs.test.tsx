/**
 * The pad inside the three dialogs.
 *
 * A dialog's state is its own — `selected`, `expanded`, `picked` are component
 * locals — so the only thing that can move a dialog's highlight is the dialog
 * itself. That is why each one subscribes to the pad rather than being handed a
 * handler by the REPL, and it is why these tests render the dialogs directly
 * rather than through the whole app.
 *
 * The permission dialog carries the one rule the whole feature is built around:
 * a controller may answer a question only when the user has said so in their own
 * settings, and when it may not, the press is not silently swallowed — it comes
 * back as a buzz, because the thumb that pressed is the only evidence anything
 * happened at all.
 */
import { describe, expect, test } from "bun:test";
import type { PadAction } from "@labunbun/gamepad";
import { render } from "ink-testing-library";
import { act, type ReactNode } from "react";
import { ListPickerDialog } from "../src/components/ListPickerDialog.tsx";
import { PermissionDialog } from "../src/components/PermissionDialog.tsx";
import { QuestionDialog } from "../src/components/QuestionDialog.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { UiQuestion } from "../src/ui-state.ts";
import { type FakePad, fakePad, padAction } from "./fake-pad.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** React reads this off `globalThis`; its types do not declare it. */
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/**
 * Do something to the pad and let React finish with it before the next thing.
 *
 * `act` rather than a measured sleep, and the difference is why this file can be
 * trusted. A press is answered by the handler `usePadAction` last wrote into its
 * ref, and that write belongs to React's commit — which happens on the
 * scheduler's task, not when `push` returns. A sleep is a guess at how long that
 * task takes: 60 ms was enough on an idle machine and not enough in a full-suite
 * run, where four tests in this file ticked the box the highlight had already
 * left. `act` does not guess. It runs React's work to completion before it
 * returns, so the frame read next is the frame this press produced, and the
 * handler the next press meets is the one that produced it.
 *
 * The environment flag is set for the call and restored after it rather than
 * left on. Other test files in the same process render React outside `act` on
 * purpose — the ones that write to `stdin` and let ink's own input handling do
 * the work — and the flag would turn their ordinary updates into warnings about
 * a harness they are not using.
 */
async function settle<T>(body: () => T): Promise<T> {
	const prior = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	try {
		return await act(async () => body());
	} finally {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = prior;
	}
}

/** Hand one action to the pad, and let the screen catch up with it. */
async function press(pad: FakePad, action: PadAction): Promise<void> {
	await settle(() => {
		pad.push(action);
	});
}

/** Render inside a theme (the components take one), with the mount flushed. */
async function show(node: ReactNode) {
	return settle(() =>
		render((<ThemeContext.Provider value={DARK_THEME}>{node}</ThemeContext.Provider>) as React.ReactElement),
	);
}

const ITEMS = [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }];

async function picker(pad: FakePad, items = ITEMS) {
	const picked: Array<number | null> = [];
	let cancels = 0;
	const view = await show(
		<ListPickerDialog
			title="Pick one"
			items={items}
			resolve={(index) => picked.push(index)}
			onCancel={() => cancels++}
			pad={pad}
		/>,
	);
	return {
		picked,
		cancels: () => cancels,
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		unmount: view.unmount,
	};
}

describe("ListPickerDialog and the pad", () => {
	test("the movement keys move the highlight the keyboard moves", async () => {
		const pad = fakePad();
		const p = await picker(pad);

		await press(pad, padAction("down"));
		await press(pad, padAction("down"));
		await press(pad, padAction("down"));
		// Wrapping, exactly as ↑/↓ wrap: three downs from the top is the top again.
		await press(pad, padAction("up"));
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} gamma`);
		expect(p.picked).toEqual([]); // moving is not choosing

		p.unmount();
	});

	test("left and right are up and down, and a shoulder pages", async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ label: `t${i}` }));
		const pad = fakePad();
		const p = await picker(pad, many);

		await press(pad, padAction("right"));
		await press(pad, padAction("page-next"));
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t9`);

		await press(pad, padAction("left"));
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t8`);

		await press(pad, padAction("page-prev"));
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t0`);

		p.unmount();
	});

	test("✕ takes the row it is standing on, and only once", async () => {
		const pad = fakePad();
		const p = await picker(pad);

		await press(pad, padAction("down"));
		await press(pad, padAction("confirm"));
		expect(p.picked).toEqual([1]);

		// The mapper sends a release for every press. If the release answered too,
		// the list would resolve twice — and the second answer would be the one
		// whoever is listening happens to take.
		await press(pad, padAction("confirm", { phase: "release" }));
		expect(p.picked).toEqual([1]);

		p.unmount();
	});

	test("○ leaves without choosing, and says so to the caller", async () => {
		const pad = fakePad();
		const p = await picker(pad);

		await press(pad, padAction("cancel", { button: "circle" }));
		expect(p.picked).toEqual([null]);
		expect(p.cancels()).toBe(1);

		p.unmount();
	});

	/**
	 * A press from before the question is not an answer to it.
	 *
	 * The mapper reports how long a button has been down, so a dialog can tell a
	 * press it caused from one that was already in flight when it appeared. A
	 * thumb resting on ✕ as a list opens must not pick whatever is highlighted.
	 */
	test("a press that predates the list is not aimed at it", async () => {
		const pad = fakePad();
		const p = await picker(pad);

		await press(pad, padAction("confirm", { heldMs: 4000 }));
		await press(pad, padAction("cancel", { heldMs: 4000, button: "circle" }));
		expect(p.picked).toEqual([]);

		// And the list is still usable afterwards.
		await press(pad, padAction("confirm"));
		expect(p.picked).toEqual([0]);

		p.unmount();
	});

	test("an empty list leaves on either button, and picks nothing", async () => {
		const pad = fakePad();
		const p = await picker(pad, []);

		await press(pad, padAction("confirm"));
		expect(p.picked).toEqual([null]);
		expect(p.cancels()).toBe(1);

		p.unmount();
	});

	/**
	 * The hint line is the only place the pad's buttons are written down.
	 *
	 * A user holding a controller has no keyboard legend to read: the line under
	 * the list is where they learn that ✕ is Enter here, and a list opened from
	 * the pad that never mentions the pad is a list they have to guess their way
	 * out of. Saying nothing when there is no controller is the other half — a
	 * "✕" on screen for someone who has no ✕ is a lie about their keyboard.
	 */
	test("the hint names the pad's answers, and nothing at all without one", async () => {
		const pad = fakePad();
		const p = await picker(pad);
		expect(p.frame()).toContain("✕ choose · ○ cancel");
		p.unmount();

		const bare = await show(<ListPickerDialog title="Pick one" items={ITEMS} resolve={() => {}} />);
		expect((bare.lastFrame() ?? "").replace(/\s+/g, " ")).not.toContain("✕");
		bare.unmount();
	});
});

async function permission(pad: FakePad) {
	const answers: Array<[boolean, boolean]> = [];
	const view = await show(
		<PermissionDialog
			toolName="Bash"
			inputPreview="Allow Bash?"
			onResolve={(allow, alwaysAllow) => answers.push([allow, alwaysAllow])}
			pad={pad}
		/>,
	);
	return { answers, frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "), unmount: view.unmount };
}

describe("PermissionDialog and the pad", () => {
	test("○ denies, which is the one answer a pad may always give", async () => {
		const pad = fakePad();
		const d = await permission(pad);

		await press(pad, padAction("cancel", { button: "circle" }));
		expect(d.answers).toEqual([[false, false]]);
		// Said out loud as well as on screen. A press with nothing behind it is a
		// press the thumb cannot tell from a report that never arrived — and this
		// is the one answer the pad is always allowed to give, so confirming it
		// costs nothing and settles the doubt.
		expect(pad.buzzes).toEqual(["refused"]);

		// The release that follows every press is not a second denial: an answer
		// that arrived twice is a promise resolved twice, and the second one is
		// the one whoever is waiting happens to miss.
		await press(pad, padAction("cancel", { phase: "release", button: "circle" }));
		expect(d.answers).toEqual([[false, false]]);
		// Nor is it a second buzz.
		expect(pad.buzzes).toEqual(["refused"]);

		d.unmount();
	});

	test("✕ does nothing at all until the user has allowed it to", async () => {
		const pad = fakePad({ allowApprove: false });
		const d = await permission(pad);

		await press(pad, padAction("confirm"));
		// Nothing was approved, and nothing timed out waiting either.
		expect(d.answers).toEqual([]);
		// The press is not swallowed: the thumb is told, by the only channel it
		// has, that this one is not its to make.
		expect(pad.buzzes).toEqual(["refused"]);
		// And the screen says why, so a person can go and change the setting.
		expect(d.frame()).toContain("pad may not approve");

		// Holding it says the same thing — there is no gesture that gets around
		// the setting, which is the point of it being a setting. (A hold carries
		// the age of its own press, so it is written here as one that began after
		// the dialog appeared: a longer one would be filtered as aimed at the
		// screen before, which is a different rule and is tested on its own.)
		await press(pad, padAction("confirm", { phase: "hold", heldMs: 20 }));
		expect(d.answers).toEqual([]);
		expect(pad.buzzes).toEqual(["refused", "refused"]);

		d.unmount();
	});

	test("✕ takes the highlighted answer once the user has allowed it", async () => {
		const pad = fakePad({ allowApprove: true });
		const d = await permission(pad);

		await press(pad, padAction("down", { button: "down" }));
		await press(pad, padAction("confirm"));
		// Row two is "yes, and don't ask again like this".
		expect(d.answers).toEqual([[true, true]]);
		expect(pad.buzzes).toEqual([]);
		// The hint stops apologising once there is nothing to apologise for.
		expect(d.frame()).not.toContain("pad may not approve");

		d.unmount();
	});

	/**
	 * Holding ✕ is how a couch approves a whole class of calls.
	 *
	 * A tap says "this once"; a hold says "and stop asking like this". The two
	 * are the same button because the difference the user has to express is how
	 * sure they are, and a thumb already knows how to express that.
	 */
	test("holding ✕ takes the standing answer instead of the highlighted one", async () => {
		const pad = fakePad({ allowApprove: true });
		const d = await permission(pad);

		// Still on row one — "just this once" — and holding goes past it.
		await press(pad, padAction("confirm", { phase: "hold", heldMs: 20 }));
		expect(d.answers).toEqual([[true, true]]);

		d.unmount();
	});

	test("a ✕ that was already down when the question appeared is not an answer", async () => {
		const pad = fakePad({ allowApprove: true });
		const d = await permission(pad);

		await press(pad, padAction("confirm", { heldMs: 5000 }));
		await press(pad, padAction("confirm", { phase: "hold", heldMs: 5000 }));
		expect(d.answers).toEqual([]);

		d.unmount();
	});

	/**
	 * Holding ✕ is the one gesture a hint has to teach, because it cannot be
	 * found by trying buttons: nobody holds a button by accident, so a grant that
	 * waits behind a hold is a grant that stays hidden unless the line says so.
	 * It points at the numbered row a hold takes rather than promising "always" —
	 * the row is the thing that is actually offered.
	 */
	test("the hint names the pad's answers, and the row a hold would take", async () => {
		const allowed = fakePad({ allowApprove: true });
		const d = await permission(allowed);
		expect(d.frame()).toContain("✕ confirm · hold ✕ row 2 · ○ deny");
		d.unmount();

		// Approving is off: the pad keeps the answer that is always its own, and
		// the one it may not give is still named rather than left to a guess.
		const refused = fakePad({ allowApprove: false });
		const r = await permission(refused);
		expect(r.frame()).toContain("pad may not approve · ○ deny");
		r.unmount();
	});

	test("a dialog with no pad at all is the dialog it always was", async () => {
		const answers: Array<[boolean, boolean]> = [];
		const view = await show(
			<PermissionDialog
				toolName="Bash"
				inputPreview="Allow Bash?"
				onResolve={(allow, alwaysAllow) => answers.push([allow, alwaysAllow])}
			/>,
		);
		const frame = () => (view.lastFrame() ?? "").replace(/\s+/g, " ");
		expect(frame()).toContain("Permission required");
		// Nothing on screen is about a controller nobody has.
		expect(frame()).not.toContain("pad");

		view.stdin.write("y");
		await delay(40);
		expect(answers).toEqual([[true, false]]);
		view.unmount();
	});
});

const MULTI_QUESTION: UiQuestion = {
	header: "Choose",
	question: "Which ones?",
	multiSelect: true,
	options: [{ label: "one" }, { label: "two" }, { label: "three" }],
};

const SINGLE_QUESTION: UiQuestion = {
	header: "Choose",
	question: "Which one?",
	options: [{ label: "one" }, { label: "two" }],
};

async function question(pad: FakePad, questions: UiQuestion[]) {
	const answers: Array<string[] | null> = [];
	const view = await show(<QuestionDialog questions={questions} resolve={(a) => answers.push(a)} pad={pad} />);
	return { answers, frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "), unmount: view.unmount };
}

describe("QuestionDialog and the pad", () => {
	test("✕ answers with the highlighted option", async () => {
		const pad = fakePad();
		const q = await question(pad, [SINGLE_QUESTION]);

		await press(pad, padAction("down"));
		await press(pad, padAction("confirm"));
		expect(q.answers).toEqual([["two"]]);

		q.unmount();
	});

	test("○ cancels the whole set", async () => {
		const pad = fakePad();
		const q = await question(pad, [SINGLE_QUESTION, SINGLE_QUESTION]);

		await press(pad, padAction("cancel", { button: "circle" }));
		expect(q.answers).toEqual([null]);

		q.unmount();
	});

	test("the hint names □ where ticking is the answer, and ✕ where it is not", async () => {
		const pad = fakePad();
		const boxes = await question(pad, [MULTI_QUESTION]);
		expect(boxes.frame()).toContain("□ select · ✕ confirm · ○ cancel");
		boxes.unmount();

		const pick = await question(pad, [SINGLE_QUESTION]);
		expect(pick.frame()).toContain("✕ answer · ○ cancel");
		expect(pick.frame()).not.toContain("□");
		pick.unmount();

		// The same checkbox question with no controller on the desk: the hint is
		// the keyboard's alone. A "□" on screen for someone who has no □ is a
		// promise about their keyboard that is not true.
		const bare = await show(<QuestionDialog questions={[MULTI_QUESTION]} resolve={() => {}} />);
		const bareFrame = (bare.lastFrame() ?? "").replace(/\s+/g, " ");
		expect(bareFrame).toContain("Space select");
		expect(bareFrame).not.toContain("□");
		expect(bareFrame).not.toContain("✕");
		bare.unmount();
	});

	/**
	 * □ is the space bar here.
	 *
	 * A checkbox question cannot be answered without it — ✕ confirms the set, and
	 * with nothing ticked that is the highlighted row alone. So the pad needs one
	 * button that means "tick this one", and □ is the button that means nothing
	 * else while a question is on screen.
	 */
	test("□ ticks a box, and ✕ sends the ticks", async () => {
		const pad = fakePad();
		const q = await question(pad, [MULTI_QUESTION]);

		await press(pad, padAction("clear", { button: "square" }));
		await press(pad, padAction("down"));
		await press(pad, padAction("down"));
		await press(pad, padAction("clear", { button: "square" }));
		expect(q.frame()).toContain("[x] one");
		expect(q.frame()).toContain("[x] three");
		expect(q.frame()).not.toContain("[x] two");

		await press(pad, padAction("confirm"));
		expect(q.answers).toEqual([["one, three"]]);

		q.unmount();
	});

	test("□ unticks the box it ticked", async () => {
		const pad = fakePad();
		const q = await question(pad, [MULTI_QUESTION]);

		await press(pad, padAction("clear", { button: "square" }));
		expect(q.frame()).toContain("[x] one");
		await press(pad, padAction("clear", { button: "square" }));
		expect(q.frame()).not.toContain("[x] one");

		// Nothing ticked, so confirming answers the highlighted one rather than
		// dead-ending on a question with one obvious answer.
		await press(pad, padAction("confirm"));
		expect(q.answers).toEqual([["one"]]);

		q.unmount();
	});

	test("a multi-select with nothing ticked answers the highlighted row", async () => {
		const pad = fakePad();
		const q = await question(pad, [MULTI_QUESTION]);

		await press(pad, padAction("confirm"));
		expect(q.answers).toEqual([["one"]]);

		q.unmount();
	});

	test("a release, and a press from before the question, both do nothing", async () => {
		const pad = fakePad();
		const q = await question(pad, [SINGLE_QUESTION]);

		await press(pad, padAction("confirm", { phase: "release" }));
		await press(pad, padAction("confirm", { heldMs: 9000 }));
		expect(q.answers).toEqual([]);

		q.unmount();
	});

	/**
	 * □ clears the screen everywhere else, and a question is the one place it
	 * must not: the boxes it ticks are the question's own, and a question that
	 * reached past itself to repaint the window would take the transcript with
	 * it.
	 */
	test("□ does not reach past a question that has no boxes to tick", async () => {
		const pad = fakePad();
		const q = await question(pad, [SINGLE_QUESTION]);

		await press(pad, padAction("clear", { button: "square" }));
		expect(q.answers).toEqual([]);
		expect(q.frame()).toContain("Which one?");

		q.unmount();
	});
});
