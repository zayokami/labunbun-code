import { defineTheme, type Theme } from "./tokens.ts";

/**
 * Light theme. Unlike the dark base this uses explicit hex values rather than
 * the terminal's named palette: on a white background the named colors are
 * where readability actually breaks down — `yellow` all but disappears, and
 * bright variants of red and green wash out — so the shades are pinned here
 * instead of inherited.
 */
export const LIGHT_THEME: Theme = defineTheme({
	name: "light",
	appearance: "light",

	text: "black",
	textMuted: "#656d76",
	userInput: "#0550ae",
	thinking: "#656d76",

	toolName: "#bf3989",
	toolArgs: "#656d76",
	toolOutput: "#57606a",
	toolBorder: "#8c959f",

	success: "#1a7f37",
	warning: "#9a6700",
	error: "#cf222e",
	permission: "#8250df",
	pending: "#656d76",

	diffAdded: "#1a7f37",
	diffRemoved: "#cf222e",
	diffHeader: "#0969da",
	codeText: "#57606a",
	codeBorder: "#8c959f",

	path: "#0969da",
	link: "#0550ae",
	selection: "#0969da",
	border: "#8c959f",
	cursor: "#0969da",
	accent: "#0969da",

	marks: { success: "✓", warning: "!", error: "✗", pending: "·", selected: "❯" },
	bold: { error: true, warning: false, success: false },
});
