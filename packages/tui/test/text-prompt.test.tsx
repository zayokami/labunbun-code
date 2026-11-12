/**
 * The single-line text prompt, typed into.
 *
 * Two things make it its own surface rather than the question dialog: the
 * value can be a secret, and a bad value keeps the dialog open. Both are pinned
 * here — a masked field that leaks the key into the frame, and a validator
 * that only scolds after the answer has already been accepted, are the two
 * ways this dialog could look right and be useless.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { act } from "react";
import { TextPromptDialog } from "../src/components/TextPromptDialog.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { TextPromptRequest } from "../src/ui-state.ts";
import { fakePad, padAction } from "./fake-pad.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** React reads this off `globalThis`; its types do not declare it. */
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Run React's work to completion, with the flag on only for that call. */
async function settle<T>(body: () => T): Promise<T> {
	const prior = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	try {
		return await act(async () => body());
	} finally {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = prior;
	}
}

function setup(request: Partial<TextPromptRequest> = {}) {
	const answers: Array<string | null> = [];
	const view = render(
		<ThemeContext.Provider value={DARK_THEME}>
			<TextPromptDialog title="ANTHROPIC_API_KEY" resolve={(value) => answers.push(value)} {...request} />
		</ThemeContext.Provider>,
	);
	return {
		answers,
		view,
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		type: async (text: string) => {
			view.stdin.write(text);
			await delay(40);
		},
		enter: async () => {
			view.stdin.write("\r");
			await delay(40);
		},
		escape: async () => {
			view.stdin.write("\u001b");
			await delay(40);
		},
		unmount: () => view.unmount(),
	};
}

describe("the text prompt", () => {
	test("draws its heading and hint over a field with a cursor", async () => {
		const h = setup({ hint: "saved to ~/.labunbun/settings.json" });
		await delay(30);
		expect(h.frame()).toContain("ANTHROPIC_API_KEY");
		expect(h.frame()).toContain("saved to");
		expect(h.frame()).toContain("Enter confirm · Esc cancel");
		h.unmount();
	});

	test("a masked field never shows the value", async () => {
		const h = setup({ mask: true, hint: "hidden" });
		await h.type("sk-ant-secret");
		expect(h.frame()).not.toContain("sk-ant-secret");
		expect(h.frame()).toContain("••••••••••••");
		await h.enter();
		expect(h.answers).toEqual(["sk-ant-secret"]);
		h.unmount();
	});

	test("an unmasked field shows what was typed, trimmed on submit", async () => {
		const h = setup({ initial: "https://old.example" });
		await delay(30);
		expect(h.frame()).toContain("https://old.example");
		await h.type("  ");
		await h.enter();
		expect(h.answers).toEqual(["https://old.example"]);
		h.unmount();
	});

	test("a required field refuses an empty answer and stays open", async () => {
		const h = setup();
		await h.enter();
		expect(h.answers).toEqual([]);
		expect(h.frame()).toContain("A value is required.");
		await h.type("sk-1");
		await h.enter();
		expect(h.answers).toEqual(["sk-1"]);
		h.unmount();
	});

	test("an optional field lets Enter skip it", async () => {
		const h = setup({ optional: true });
		await h.enter();
		expect(h.answers).toEqual([""]);
		h.unmount();
	});

	test("a validator's complaint keeps the dialog open until the value passes", async () => {
		const h = setup({
			validate: (value) => (value.includes("https://") ? undefined : "Use an https:// URL."),
		});
		await h.type("example");
		await h.enter();
		expect(h.answers).toEqual([]);
		expect(h.frame()).toContain("Use an https:// URL.");
		await h.type("https://example");
		await h.enter();
		expect(h.answers).toEqual(["examplehttps://example"]);
		h.unmount();
	});

	test("Esc cancels without an answer", async () => {
		const h = setup();
		await h.type("half a key");
		await h.escape();
		expect(h.answers).toEqual([null]);
		h.unmount();
	});

	test("the pad's ○ cancels, and its confirm cannot submit an empty field", async () => {
		const pad = fakePad();
		const answers: Array<string | null> = [];
		const view = render(
			<ThemeContext.Provider value={DARK_THEME}>
				<TextPromptDialog title="Base URL" resolve={(value) => answers.push(value)} pad={pad} />
			</ThemeContext.Provider>,
		);
		await delay(40);
		// A controller cannot type: confirm is swallowed rather than answering "".
		await settle(() => pad.push(padAction("confirm", { button: "cross" })));
		expect(answers).toEqual([]);
		await settle(() => pad.push(padAction("cancel", { button: "circle" })));
		expect(answers).toEqual([null]);
		view.unmount();
	});
});
