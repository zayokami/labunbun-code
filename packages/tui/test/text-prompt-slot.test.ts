/**
 * The text prompt's slot: what is on screen, and how it stops being.
 *
 * The endings are the same three every modal here has — a value, a
 * cancellation, and a replacement — and the same failure is guarded against:
 * a caller awaiting a promise that a dialog left behind never settles. The
 * `settled` helper turns that hang into a failed assertion.
 */
import { describe, expect, test } from "bun:test";
import { createTextPromptSlot } from "../src/text-prompt-slot.ts";
import type { TextPromptState } from "../src/ui-state.ts";

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
	const shown: Array<TextPromptState | null> = [];
	const slot = createTextPromptSlot({ show: (textPrompt) => shown.push(textPrompt) });
	return {
		slot,
		current: () => shown.at(-1) ?? null,
		screens: () => shown.length,
	};
}

describe("the text prompt slot", () => {
	test("shows the request and resolves the answer", async () => {
		const h = harness();
		const answer = h.slot.prompt({ title: "Base URL", initial: "https://old" });
		const screen = h.current();
		expect(screen?.title).toBe("Base URL");
		expect(screen?.initial).toBe("https://old");

		screen?.resolve("https://new");
		expect(await settled(answer)).toBe("https://new");
		expect(h.current()).toBeNull();
	});

	test("clearing resolves null, not an empty string", async () => {
		const h = harness();
		const answer = h.slot.prompt({ title: "Key", mask: true });
		h.slot.clear();
		expect(await settled(answer)).toBeNull();
		expect(h.current()).toBeNull();
	});

	test("a replacement cancels the prompt it replaces", async () => {
		const h = harness();
		const first = h.slot.prompt({ title: "First" });
		const second = h.slot.prompt({ title: "Second" });
		expect(await settled(first)).toBeNull();
		expect(h.current()?.title).toBe("Second");
		h.current()?.resolve("two");
		expect(await settled(second)).toBe("two");
		expect(h.screens()).toBe(3);
	});

	test("clearing with nothing up does nothing", () => {
		const h = harness();
		h.slot.clear();
		expect(h.screens()).toBe(0);
	});
});
