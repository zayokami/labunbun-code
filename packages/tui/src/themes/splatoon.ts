import { DARK_THEME } from "./dark.ts";
import { deriveTheme, type Theme } from "./tokens.ts";

/**
 * Ink-splat palette: neon green and magenta on a dark background.
 *
 * As with the other tinted theme, the signature colors are kept off the state
 * tokens they would otherwise drown out. Magenta carries the structure —
 * borders, selection, cursor — and the neon green stays on `success`, so a
 * green "done" still reads as a state rather than as more decoration. Error
 * takes a plain red, distinct from the magenta accent in both hue and
 * lightness, and warning takes the yellow.
 */
export const SPLATOON: Theme = deriveTheme(DARK_THEME, {
	name: "splatoon",

	text: "#f2f2f2",
	textMuted: "#9b9bad",
	userInput: "#19d719",
	thinking: "#9b9bad",

	toolName: "#fa4d95",
	toolArgs: "#9b9bad",
	toolOutput: "#dcdce4",
	toolBorder: "#7a2f52",

	success: "#19d719",
	warning: "#ffe600",
	error: "#ff2d2d",
	permission: "#8a4dff",
	pending: "#9b9bad",

	diffAdded: "#19d719",
	diffRemoved: "#ff2d2d",
	diffHeader: "#fa4d95",
	codeText: "#dcdce4",
	codeBorder: "#7a2f52",

	path: "#00e5ff",
	link: "#00e5ff",
	selection: "#fa4d95",
	border: "#7a2f52",
	cursor: "#19d719",
	accent: "#fa4d95",

	marks: { success: "✓", warning: "!", error: "✗", pending: "·", selected: "❯" },
	bold: { error: true, warning: false, success: false },
});
