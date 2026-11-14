/**
 * `/autonomy` is a settings command with one piece of live state.
 *
 * The command does not touch the permission engine, so the wiring under test is
 * narrow: it reports the current level, accepts one of the three ids, and hands
 * a change to the host's setter. The setter owns the prompt rebuild and the
 * write, which is why the tests below assert the call rather than the file — a
 * hand-built context has no prompt builder and no home.
 */
import { describe, expect, test } from "bun:test";
import { AUTONOMY_CHOICES, AUTONOMY_LEVELS, type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "@labunbun/agent";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((entry) => entry.kind === "info")
		.map((entry) => (entry as { text: string }).text)
		.join("\n");

function makeCtx(initial: AutonomyLevel | null = DEFAULT_AUTONOMY_LEVEL) {
	const store = createStore<UiState>(initialUiState(false));
	let level = initial ?? DEFAULT_AUTONOMY_LEVEL;
	const setCalls: AutonomyLevel[] = [];
	const ctx = {
		// Read before dispatch for every command, even one that does not need a
		// session: a context without it is not a context the REPL produces.
		getSession: () => null,
		handle: { store },
		autonomy: initial === null ? undefined : () => level,
		setAutonomy:
			initial === null
				? undefined
				: (next: AutonomyLevel) => {
						level = next;
						setCalls.push(next);
					},
	} as unknown as AppCommandContext;
	return { ctx, level: () => level, setCalls, info: () => infoTexts(store) };
}

describe("/autonomy with no argument", () => {
	test("names the current level, what it means, and the alternatives", () => {
		const h = makeCtx("balanced");
		expect(handleAppCommand("/autonomy", h.ctx)).toBe(true);

		const text = h.info();
		expect(text).toContain("Autonomy: Balanced (balanced)");
		// The hint is the useful half: a user asking this question wants to know
		// what the level currently allows, not only its name.
		expect(text).toContain("Decide the implementation");
		for (const choice of AUTONOMY_CHOICES) {
			expect(text).toContain(`${choice.id} (${choice.label})`);
		}
		expect(h.setCalls).toEqual([]);
	});

	test("a host without the getter says so", () => {
		const h = makeCtx(null);
		expect(handleAppCommand("/autonomy", h.ctx)).toBe(true);
		expect(h.info()).toContain("Autonomy is not available in this host");
		expect(h.info()).toContain(AUTONOMY_LEVELS.join("|"));
	});
});

describe("/autonomy with a level", () => {
	test.each([...AUTONOMY_LEVELS])("moves to %s through the host setter", (level) => {
		const h = makeCtx(level === "guided" ? "balanced" : "guided");
		expect(handleAppCommand(`/autonomy ${level}`, h.ctx)).toBe(true);
		expect(h.setCalls).toEqual([level]);
		expect(h.level()).toBe(level);
	});

	test("is case-insensitive, like the other switch commands", () => {
		const h = makeCtx("guided");
		expect(handleAppCommand("/autonomy AUTONOMOUS", h.ctx)).toBe(true);
		expect(h.setCalls).toEqual(["autonomous"]);
	});

	test("re-sending the current level does not call the setter", () => {
		const h = makeCtx("balanced");
		handleAppCommand("/autonomy balanced", h.ctx);
		expect(h.setCalls).toEqual([]);
		// Still answers: a user who typed it may be checking that it landed.
		expect(h.info()).toContain("Autonomy is already Balanced (balanced)");
	});

	test("an unknown level is a usage line, not a setter call", () => {
		const h = makeCtx("guided");
		expect(handleAppCommand("/autonomy turbo", h.ctx)).toBe(true);
		expect(h.setCalls).toEqual([]);
		expect(h.info()).toContain(`Usage: /autonomy [${AUTONOMY_LEVELS.join("|")}]`);
	});

	test("a host without the setter refuses rather than pretending", () => {
		const h = makeCtx(null);
		expect(handleAppCommand("/autonomy autonomous", h.ctx)).toBe(true);
		expect(h.info()).toContain("Autonomy cannot be changed in this host");
	});
});
