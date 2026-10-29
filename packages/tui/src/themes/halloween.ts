import { DARK_THEME } from "./dark.ts";
import { deriveTheme, type Theme } from "./tokens.ts";

/**
 * Halloween palette: pumpkin orange and witch purple on a dark background.
 *
 * Orange is the decoration — accent, selection, headers — so it cannot also be
 * the error color: error takes a blood red that sits far from the pumpkin in
 * lightness and hue, and stays bold, which carries the difference where a
 * terminal renders the two close together. Slime green stays on `success` and
 * the candle yellow on `warning`, so the state colors read as state and the
 * purple and orange read as the theme.
 */
export const HALLOWEEN: Theme = deriveTheme(DARK_THEME, {
	name: "halloween",

	text: "#f3e9dc",
	textMuted: "#a89bb5",
	userInput: "#ffb347",
	thinking: "#a89bb5",

	toolName: "#b583ff",
	toolArgs: "#a89bb5",
	toolOutput: "#e6dccb",
	toolBorder: "#5a3a7a",

	success: "#8ee04b",
	warning: "#ffd23f",
	error: "#ff3b3b",
	permission: "#a56bff",
	pending: "#a89bb5",

	diffAdded: "#8ee04b",
	diffRemoved: "#ff3b3b",
	diffHeader: "#ff7a1a",
	codeText: "#e6dccb",
	codeBorder: "#5a3a7a",
	syntax: {
		keyword: "#ff7a1a",
		string: "#8ee04b",
		comment: "#a89bb5",
		number: "#ffd23f",
		function: "#b583ff",
	},

	tableHeader: "#ff7a1a",
	tableBorder: "#5a3a7a",

	path: "#5ee6d0",
	link: "#5ee6d0",
	selection: "#ff7a1a",
	border: "#5a3a7a",
	accent: "#ff7a1a",

	marks: { success: "✓", warning: "!", error: "✗", pending: "·", selected: "❯", tableColumn: "│" },
	bold: { error: true, warning: false, success: false },
});
