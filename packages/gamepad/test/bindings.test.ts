/**
 * The mapping table: what the defaults are, and what a user's override is
 * allowed to do to them.
 *
 * Two properties carry most of the weight. The map is *total*, so nothing
 * downstream ever asks whether a button is bound; and an override that does not
 * parse is *dropped* rather than honoured, so a typo costs the user one binding
 * instead of the whole file's worth.
 */

import { describe, expect, test } from "bun:test";
import {
	bindingText,
	DEFAULT_BINDINGS,
	PAD_ACTION_KINDS,
	PAD_INPUT_IDS,
	type PadBindingMap,
	resolveBindings,
} from "../src/index.ts";

describe("DEFAULT_BINDINGS", () => {
	test("binds every button and every gesture, and nothing else", () => {
		expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual([...PAD_INPUT_IDS].sort());
		for (const control of PAD_INPUT_IDS) expect(DEFAULT_BINDINGS[control]).toBeDefined();
	});

	test("the table a user reads in the docs is the table in the code", () => {
		const kinds = (button: keyof PadBindingMap) => bindingText(DEFAULT_BINDINGS[button]);
		expect(kinds("cross")).toBe("confirm");
		expect(kinds("circle")).toBe("cancel");
		expect(kinds("square")).toBe("clear");
		expect(kinds("triangle")).toBe("wheel");
		expect(kinds("l1")).toBe("page-prev");
		expect(kinds("r1")).toBe("page-next");
		expect(kinds("share")).toBe("osk");
		expect(kinds("options")).toBe("transcript");
		expect(kinds("touchpad")).toBe("status");
		expect(kinds("l3")).toBe("model");
		expect(kinds("r3")).toBe("mode");
		for (const direction of ["up", "down", "left", "right"] as const) expect(kinds(direction)).toBe(direction);
		// The deliberate silences: the system owns PS, and the triggers are
		// modifiers in the mapper rather than bindings.
		expect(kinds("ps")).toBe("none");
		expect(kinds("l2")).toBe("none");
		expect(kinds("r2")).toBe("none");
	});

	test("the surface's gestures answer to what a thumb drawn across it means", () => {
		const kinds = (gesture: keyof PadBindingMap) => bindingText(DEFAULT_BINDINGS[gesture]);
		// A drag is the move the d-pad and the stick make, in the direction it went.
		expect(kinds("touch-up")).toBe("up");
		expect(kinds("touch-down")).toBe("down");
		expect(kinds("touch-left")).toBe("left");
		expect(kinds("touch-right")).toBe("right");
		// A tap is the click's neighbour, and the only gesture worth a confirm.
		expect(kinds("touch-tap")).toBe("confirm");
		expect(kinds("touch-two-left")).toBe("page-prev");
		expect(kinds("touch-two-right")).toBe("page-next");
	});

	test("every value it hands out is an action the type allows", () => {
		// The kinds a component can ever switch on: the list, plus `command`.
		const allowed: readonly string[] = [...PAD_ACTION_KINDS, "command"];
		for (const control of PAD_INPUT_IDS) expect(allowed).toContain(DEFAULT_BINDINGS[control].kind);
	});
});

describe("resolveBindings", () => {
	test("no overrides means the defaults, and no problems", () => {
		const resolved = resolveBindings();
		expect(resolved.bindings).toEqual(DEFAULT_BINDINGS);
		expect(resolved.problems).toEqual([]);
	});

	test("an override replaces one button and leaves the rest alone", () => {
		const { bindings } = resolveBindings({ r1: "confirm" });
		expect(bindingText(bindings.r1)).toBe("confirm");
		expect(bindingText(bindings.l1)).toBe("page-prev");
		expect(bindingText(bindings.cross)).toBe("confirm");
	});

	test("`none` unbinds, and the spelling of it does not matter", () => {
		for (const text of ["none", "NONE", " None "]) {
			const { bindings, problems } = resolveBindings({ cross: text });
			expect(bindingText(bindings.cross)).toBe("none");
			expect(problems).toEqual([]);
		}
	});

	test("button names are read the way a person writes them", () => {
		const { bindings } = resolveBindings({ " Cross ": "cancel", TRIANGLE: "status" });
		expect(bindingText(bindings.cross)).toBe("cancel");
		expect(bindingText(bindings.triangle)).toBe("status");
	});

	test("a name that is not a button is a problem, and changes nothing", () => {
		const { bindings, problems } = resolveBindings({ triaangle: "confirm" });
		expect(bindings).toEqual(DEFAULT_BINDINGS);
		expect(problems).toEqual([expect.stringContaining("bindings.triaangle: not a button")]);
	});

	test("a gesture is bound by the same name a button is", () => {
		const { bindings, problems } = resolveBindings({ "touch-tap": "none", " Touch-TWO-Left ": "command:/model" });
		expect(problems).toEqual([]);
		expect(bindingText(bindings["touch-tap"])).toBe("none");
		expect(bindingText(bindings["touch-two-left"])).toBe("command:/model");
		// The one they were editing, and not the buttons they were not.
		expect(bindingText(bindings.cross)).toBe("confirm");
	});

	test("a gesture spelled wrong is a problem, and the line lists the gestures by name", () => {
		// The reason the gesture names are in the same list as the buttons: a
		// mistyped touch gesture has to be a sentence a user can act on, not a
		// binding that silently never fires.
		const { bindings, problems } = resolveBindings({ "touch-tapp": "confirm" });
		expect(bindings).toEqual(DEFAULT_BINDINGS);
		expect(problems).toEqual([expect.stringContaining("bindings.touch-tapp: not a button or gesture")]);
		expect(problems[0]).toContain("touch-tap");
	});

	test("an action that does not exist is a problem, and the default stands", () => {
		// The point of dropping it: a typo costs the binding being edited, never
		// the button it was meant for.
		const { bindings, problems } = resolveBindings({ cross: "alow" });
		expect(bindingText(bindings.cross)).toBe("confirm");
		expect(problems).toEqual([expect.stringContaining('bindings.cross: unknown action "alow"')]);
	});

	test("a value that is not a string is a problem, not a crash", () => {
		const { bindings, problems } = resolveBindings({ cross: 42, circle: ["confirm"], triangle: null });
		expect(bindings).toEqual(DEFAULT_BINDINGS);
		expect(problems).toHaveLength(3);
		expect(problems[0]).toContain("bindings.cross");
	});

	test("an empty string is a problem — it is not `none` by accident", () => {
		const { bindings, problems } = resolveBindings({ cross: "   " });
		expect(bindingText(bindings.cross)).toBe("confirm");
		expect(problems).toEqual([expect.stringContaining("empty")]);
	});

	test("problems come back in the order the file listed them", () => {
		const { problems } = resolveBindings({ cross: "alow", circle: "nope" });
		expect(problems[0]).toContain("bindings.cross");
		expect(problems[1]).toContain("bindings.circle");
	});

	test("every kind the type lists can be bound", () => {
		for (const kind of PAD_ACTION_KINDS) {
			const { bindings, problems } = resolveBindings({ r1: kind });
			expect(problems).toEqual([]);
			expect(bindingText(bindings.r1)).toBe(kind);
		}
	});
});

describe("command bindings", () => {
	test("a command binding keeps its text, and gains a slash if it needs one", () => {
		expect(resolveBindings({ l1: "command:/theme" }).bindings.l1).toEqual({ kind: "command", command: "/theme" });
		expect(resolveBindings({ l1: "command:theme" }).bindings.l1).toEqual({ kind: "command", command: "/theme" });
		expect(bindingText({ kind: "command", command: "/theme" })).toBe("command:/theme");
	});

	test("arguments survive — a command is a line, not a name", () => {
		const { bindings } = resolveBindings({ l1: "command:/theme dark" }, ["/theme"]);
		expect(bindings.l1).toEqual({ kind: "command", command: "/theme dark" });
	});

	test("a command that does not exist is a problem when the list says so", () => {
		const { bindings, problems } = resolveBindings({ l1: "command:/themme" }, ["/theme", "/model"]);
		expect(bindingText(bindings.l1)).toBe("page-prev");
		expect(problems).toEqual([expect.stringContaining('bindings.l1: unknown command "/themme"')]);
	});

	test("without a list of commands to check against, one is taken at its word", () => {
		const { bindings, problems } = resolveBindings({ l1: "command:/themme" });
		expect(problems).toEqual([]);
		expect(bindings.l1).toEqual({ kind: "command", command: "/themme" });
	});

	test("the command list may be spelled either way — with or without the slash", () => {
		expect(resolveBindings({ l1: "command:/theme" }, ["theme"]).problems).toEqual([]);
		expect(resolveBindings({ l1: "command:/theme" }, ["/theme"]).problems).toEqual([]);
	});

	test("`command:` with nothing after it is a problem", () => {
		const { bindings, problems } = resolveBindings({ l1: "command:" });
		expect(bindingText(bindings.l1)).toBe("page-prev");
		expect(problems).toEqual([expect.stringContaining("expected a command")]);
	});

	test("a command is not an action name, even when it looks like one", () => {
		// `command:confirm` runs a command called confirm; it does not confirm.
		expect(resolveBindings({ l1: "command:confirm" }).bindings.l1).toEqual({ kind: "command", command: "/confirm" });
	});
});
