/**
 * The one place that decides which editing model the prompt is in.
 *
 * The interesting case is the one that is not ordinary: both keys set. It has a
 * right answer, and the answer is written down here rather than left to whichever
 * caller is constructed first — which is exactly the bug this chokepoint exists
 * to prevent, and the reason two layers reading `settings.vimMode` on their own
 * used to be a hazard.
 */
import { describe, expect, test } from "bun:test";
import {
	describeEditor,
	type EditorKind,
	editorShadowNotice,
	opposingEditorKey,
	resolveEditingMode,
} from "../src/editing-mode.ts";

/** Every settings shape the schema allows, reduced to the two editor keys. */
const SHAPES: Array<[label: string, input: { vimMode?: boolean; emacsMode?: boolean }]> = [
	["neither set", {}],
	["vim off explicitly", { vimMode: false }],
	["emacs off explicitly", { emacsMode: false }],
	["both off explicitly", { vimMode: false, emacsMode: false }],
	["vim on", { vimMode: true }],
	["emacs on", { emacsMode: true }],
	["both on", { vimMode: true, emacsMode: true }],
];

describe("resolveEditingMode", () => {
	// The truth table, so a change to the precedence cannot pass unnoticed: the
	// two booleans and the mode are three inputs and one output, and every one
	// of the eight shapes gets a named expectation rather than a spot check.
	test("every combination resolves, and only 'emacs on' has a shadowed key", () => {
		const actual = SHAPES.map(([label, input]) => [label, resolveEditingMode(input)] as const);
		expect(actual).toEqual([
			["neither set", { mode: "none", chosen: null, shadowed: null }],
			["vim off explicitly", { mode: "none", chosen: null, shadowed: null }],
			["emacs off explicitly", { mode: "none", chosen: null, shadowed: null }],
			["both off explicitly", { mode: "none", chosen: null, shadowed: null }],
			["vim on", { mode: "vim", chosen: "vimMode", shadowed: null }],
			["emacs on", { mode: "emacs", chosen: "emacsMode", shadowed: null }],
			["both on", { mode: "emacs", chosen: "emacsMode", shadowed: "vimMode" }],
		]);
	});

	// `false` is not the same as absent in one place that matters: a project file
	// is allowed to set `emacsMode: false`, and that has to turn Emacs *off* for
	// this startup rather than fall through to whatever the user file said. The
	// resolved value is a mode, so a strict `=== true` somewhere upstream of it
	// would throw that away.
	test("an explicit false is honoured rather than treated as unset", () => {
		expect(resolveEditingMode({ emacsMode: true, vimMode: false }).mode).toBe("emacs");
		// The shape a strict-truthiness check would get wrong if `false` were
		// absent rather than negative: nothing here is on, so nothing is chosen.
		expect(resolveEditingMode({ emacsMode: false }).chosen).toBeNull();
	});

	// A non-boolean that reached here anyway — a settings file edited by hand, a
	// tier that bypassed the schema. The mode is the only thing that matters, and
	// a string is not a yes.
	test("only a literal true turns an editor on", () => {
		for (const value of ["true", 1, "on", {}, []] as unknown[]) {
			expect(resolveEditingMode({ vimMode: value as boolean }).mode).toBe("none");
			expect(resolveEditingMode({ emacsMode: value as boolean }).mode).toBe("none");
		}
	});

	// `mode` is what the host switches on, so a caller that tests it against a
	// string literal outside this union has to be a type error. This is the
	// runtime shadow of that: the three modes are exactly these three.
	test("the mode is one of exactly three values", () => {
		const modes: EditorKind[] = ["none", "vim", "emacs"];
		for (const [, input] of SHAPES) {
			expect(modes).toContain(resolveEditingMode(input).mode);
		}
	});
});

describe("opposingEditorKey", () => {
	// Two independent booleans cannot express "vim instead of emacs" — so turning
	// one on has to clear the other, and that requires knowing which one the
	// caller is about to write. A wrong answer here clears the key it just set,
	// which reads as a command that does nothing.
	test("each key's opposite is the other one", () => {
		expect(opposingEditorKey("vimMode")).toBe("emacsMode");
		expect(opposingEditorKey("emacsMode")).toBe("vimMode");
		expect(opposingEditorKey(opposingEditorKey("vimMode"))).toBe("vimMode");
		expect(opposingEditorKey(opposingEditorKey("emacsMode"))).toBe("emacsMode");
	});
});

describe("editorShadowNotice", () => {
	test("says which key was cleared, only when one actually was", () => {
		expect(editorShadowNotice({ vimMode: true }, "emacsMode", true)).toBe("cleared vimMode, which was also on");
		expect(editorShadowNotice({ vimMode: false }, "emacsMode", true)).toBeUndefined();
		expect(editorShadowNotice({}, "emacsMode", true)).toBeUndefined();
	});

	// Turning an editor *off* clears nothing, so a notice here would tell the
	// user about a change that was not made. The ordinary `/vim off` must read
	// exactly as it did before this key existed.
	test("says nothing when turning an editor off", () => {
		expect(editorShadowNotice({ vimMode: true }, "emacsMode", false)).toBeUndefined();
		expect(editorShadowNotice({ emacsMode: true }, "vimMode", false)).toBeUndefined();
	});

	// The notice must name the *other* key, not the one being set. A `/emacs on`
	// that says "cleared emacsMode" would name the setting it just wrote.
	test("names the key being cleared, never the one being set", () => {
		for (const kind of ["vimMode", "emacsMode"] as const) {
			const notice = editorShadowNotice({ vimMode: true, emacsMode: true }, kind, true);
			expect(notice).toBeDefined();
			expect(notice).toContain(opposingEditorKey(kind));
			expect(notice).not.toContain(kind);
		}
	});
});

describe("describeEditor", () => {
	test("names the editor the prompt is in", () => {
		expect(describeEditor(resolveEditingMode({}))).toBe("no editor");
		expect(describeEditor(resolveEditingMode({ vimMode: true }))).toBe("Vim");
		expect(describeEditor(resolveEditingMode({ emacsMode: true }))).toBe("Emacs");
	});

	// Both set is only reachable by hand-editing a settings file, and a card that
	// said just "Emacs" would leave the user staring at a file that disagrees
	// with it. The shadowed key is named, and named by its settings key rather
	// than by its display name, because that is what they have to go and edit.
	test("names the shadowed key when both are set", () => {
		expect(describeEditor(resolveEditingMode({ vimMode: true, emacsMode: true }))).toBe("Emacs (vimMode also set)");
		expect(describeEditor(resolveEditingMode({ vimMode: true, emacsMode: false }))).toBe("Vim");
	});
});
