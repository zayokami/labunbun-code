import { DARK_THEME } from "./dark.ts";
import { deriveTheme, type Theme } from "./tokens.ts";

/**
 * Red-and-blue comic palette on a dark background.
 *
 * The trap in any strongly-tinted theme is letting the signature color swallow
 * a state color: if the accent is the same red as `error`, an error message
 * stops standing out because everything around it is already red. Here the red
 * is reserved for `error`, `diffRemoved`, and the user's own prompt line, while
 * the structural accent — borders, selection, cursor, paths — takes the blue.
 * The five state hues stay pairwise distinct (red / amber / green / blue /
 * violet), which the theme tests assert rather than leaving to the eye.
 */
export const SPIDERMAN: Theme = deriveTheme(DARK_THEME, {
	name: "spiderman",

	text: "#f5f5f5",
	textMuted: "#9aa0b5",
	userInput: "#ff4d52",
	thinking: "#9aa0b5",

	toolName: "#f5a3a6",
	toolArgs: "#9aa0b5",
	toolOutput: "#d5d8e5",
	toolBorder: "#3b4a8f",

	success: "#00b74a",
	warning: "#ffb300",
	error: "#e62429",
	permission: "#c77dff",
	pending: "#9aa0b5",

	diffAdded: "#00b74a",
	diffRemoved: "#e62429",
	diffHeader: "#8ea2ff",
	codeText: "#d5d8e5",
	codeBorder: "#3b4a8f",

	path: "#8ea2ff",
	link: "#8ea2ff",
	selection: "#8ea2ff",
	border: "#3b4a8f",
	cursor: "#e62429",
	accent: "#4d61c4",

	marks: { success: "✓", warning: "!", error: "✗", pending: "·", selected: "❯" },
	bold: { error: true, warning: false, success: false },
});
