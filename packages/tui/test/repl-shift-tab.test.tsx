/**
 * Shift+Tab, pressed.
 *
 * The key is the one thing in this build that changes a *permission* from the
 * prompt, and it is indistinguishable from Tab by one modifier, so the tests
 * that matter are not the ones that show the mode moving — they are the ones
 * that show Tab still doing what it did, and that the sequence behind Shift+Tab
 * never reaches Tab's three branches (accept a file completion, cycle or accept
 * a command suggestion, queue the buffer during a run).
 *
 * A mode that can only be changed by an arm's length, or a key whose second
 * meaning is one that a later branch quietly claims, are both failures that read
 * fine on screen. Hence the controls: each one presses the *other* key from the
 * same starting state and asserts the opposite outcome.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession, MODE_CHOICES, type PermissionMode, type SandboxMode } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import type React from "react";
import { PromptInput } from "../src/components/PromptInput.tsx";
import { REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTheme(node: React.ReactNode) {
	return <ThemeContext.Provider value={DARK_THEME}>{node}</ThemeContext.Provider>;
}

/** What a terminal sends for Shift+Tab. Ink's parser names it `tab`, `shift: true`. */
const SHIFT_TAB = "\x1b[Z";

/**
 * A prompt that can complete one command, so the Tab branches below have
 * something to complete. `/h` is the only text in these tests that reaches the
 * suggestion branch; nothing here is sent to a model.
 */
const COMMANDS: Array<[string, string]> = [["/help", "show the help list"]];

function setup(pair?: { mode: PermissionMode; sandbox: SandboxMode }) {
	const faux = fauxProvider([{ text: "unused" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		maxTurns: 2,
		deps: { streamFn: (model, context, streamOptions) => faux.streamFn(model, context, streamOptions) },
		...(pair ? { permissionMode: pair.mode, sandbox: pair.sandbox } : {}),
	});
	// Seeded the way `mountRepl` seeds it, not left at the default "". Otherwise the
	// badge assertions would pass on a store that never got a label at all.
	const store = createStore<UiState>(initialUiState(false, false, MODE_CHOICES[0].label));
	const view = render(
		<REPL getSession={() => session} store={store} modelName="test" commandSuggestions={COMMANDS} onExit={() => {}} />,
	);
	return {
		store,
		session,
		stdin: view.stdin,
		/** The prompt's own text, out of the rounded box, as in the emacs suite. */
		buffer: () => {
			const match = /│([^│]*)│/.exec((view.lastFrame() ?? "").replace(/\s+/g, " "));
			return match?.[1]?.trim();
		},
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		axes: () => ({ mode: session.permissionMode, sandbox: session.sandbox }),
		press: async (text: string) => {
			view.stdin.write(text);
			await delay(40);
		},
		unmount: () => view.unmount(),
	};
}

describe("Shift+Tab in the prompt", () => {
	/**
	 * The whole feature in one press: the key, the session's two axes, the store's
	 * copy of them, and the badge the user reads. Asserting only the axes would
	 * pass with a store that never learns — the badge is a copy, and a copy is
	 * exactly the thing that goes stale.
	 */
	test("one press moves both axes and the badge, in that order", async () => {
		const h = setup({ mode: "ask", sandbox: "workspace-write" });
		await delay(40);
		expect(h.frame()).toContain("[Ask]");

		await h.press(SHIFT_TAB);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.sandbox).toBe("workspace-write");
		expect(h.store.get().modeLabel).toBe("Plan");
		expect(h.frame()).toContain("[Plan]");
		// The old name has to be gone, not merely joined: `[Ask]` is a substring of
		// nothing here, but a badge that appended would keep both on screen.
		expect(h.frame()).not.toContain("[Ask]");
		h.unmount();
	}, 20_000);

	/**
	 * Four presses return to the start, through the real prompt four times. The
	 * arithmetic is pinned in `mode-enum.test.ts`; this pins that the prompt is
	 * wired to *that* arithmetic rather than to a second implementation of it that
	 * happens to agree on the first step.
	 */
	test("pressing it once per row comes back to the row it started from", async () => {
		const h = setup({ mode: "ask", sandbox: "workspace-write" });
		await delay(40);
		const walked: string[] = [];
		for (let i = 0; i < MODE_CHOICES.length; i++) {
			await h.press(SHIFT_TAB);
			walked.push(h.store.get().modeLabel);
		}
		expect(walked).toEqual(["Plan", "Agent", "Agent 无沙箱", "Ask"]);
		expect(h.axes()).toEqual({ mode: "ask", sandbox: "workspace-write" });
		h.unmount();
	}, 20_000);

	/**
	 * The control for both tests above, and the oldest habit in TUI work: a key that
	 * "works" because it fell through to the branch underneath.
	 *
	 * Plain Tab with `/h` in the buffer completes it to `/help`. So this asserts
	 * Tab's own meaning *survives* — the one way to tell the new branch claimed
	 * only its own key is that the old one is still there.
	 */
	test("plain Tab still completes a command, and changes no mode", async () => {
		const h = setup({ mode: "ask", sandbox: "workspace-write" });
		await delay(40);

		h.stdin.write("/h");
		await delay(40);
		expect(h.buffer()).toBe("/h");

		await h.press("\t");

		expect(h.buffer()).toBe("/help");
		expect(h.axes()).toEqual({ mode: "ask", sandbox: "workspace-write" });
		expect(h.store.get().modeLabel).toBe("Ask");
		h.unmount();
	}, 20_000);

	/**
	 * The regression, and the reason the branch returns rather than merely setting a
	 * flag. Three Tab branches sit below it, and the suggestion one is the easiest
	 * to hit by accident: type `/h`, press the sequence, and a missing `return`
	 * leaves `/help` in the buffer — a completion the user never asked for,
	 * submitted to the model on Enter.
	 *
	 * Same two keystrokes as the control above, one byte apart, opposite outcomes.
	 */
	test("Shift+Tab does not reach the Tab that completes, in either direction", async () => {
		const h = setup({ mode: "ask", sandbox: "workspace-write" });
		await delay(40);

		h.stdin.write("/h");
		await delay(40);
		await h.press(SHIFT_TAB);

		// Untouched: the suggestion list is still open and still filtered by `/h`.
		expect(h.buffer()).toBe("/h");
		// And the mode moved, so this is a key that was claimed rather than a key
		// that was swallowed. Both failure modes are silent on screen otherwise.
		expect(h.store.get().modeLabel).toBe("Plan");
		h.unmount();
	}, 20_000);

	/**
	 * A prompt with no way to cycle still claims the key.
	 *
	 * `onCycleMode` is optional so a bare `<PromptInput>` renders, but claiming
	 * Shift+Tab is not conditional: the alternative is a key whose meaning depends
	 * on whether its owner remembered to wire it, and the bug lands only in the
	 * screens nobody tests. So the prompt is rendered *bare* — no `onCycleMode`,
	 * no session, nothing but the suggestion list — and the sequence is still not a
	 * Tab. It is the same two keystrokes as the control above; the only difference
	 * is the prop that is missing.
	 */
	test("a prompt with no cycle handler does not complete on Shift+Tab either", async () => {
		const view = render(withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} placeholder="ph" />));
		await delay(40);
		view.stdin.write("/h");
		await delay(40);
		view.stdin.write(SHIFT_TAB);
		await delay(40);

		// Still `/h`: had the branch fallen through, this would read `/help`.
		const text = /│([^│]*)│/.exec((view.lastFrame() ?? "").replace(/\s+/g, " "))?.[1]?.trim();
		expect(text).toBe("/h");
		// And Tab itself still works in this same prompt, so the assertion above is
		// about the modifier and not about a prompt that never completes anything.
		view.stdin.write("\t");
		await delay(40);
		expect(/│([^│]*)│/.exec((view.lastFrame() ?? "").replace(/\s+/g, " "))?.[1]?.trim()).toBe("/help");
		view.unmount();
	}, 20_000);
});
