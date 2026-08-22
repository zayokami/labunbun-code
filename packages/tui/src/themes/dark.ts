import { defineTheme, type Theme } from "./tokens.ts";

/**
 * The default theme, and the base every other built-in derives from. Uses the
 * terminal's named palette rather than hex so it inherits whatever colors the
 * user already configured — a theme meant to be unobtrusive should not fight
 * the terminal it runs in.
 */
export const DARK_THEME: Theme = defineTheme({
	name: "dark",
	appearance: "dark",

	text: "white",
	textMuted: "gray",
	userInput: "blue",
	thinking: "gray",

	toolName: "magenta",
	toolArgs: "gray",
	toolOutput: "gray",
	toolBorder: "gray",

	success: "green",
	warning: "yellow",
	error: "red",
	permission: "cyan",
	pending: "gray",

	diffAdded: "green",
	diffRemoved: "red",
	diffHeader: "cyan",
	codeText: "gray",
	codeBorder: "gray",

	path: "cyan",
	link: "blue",
	selection: "cyan",
	border: "gray",
	cursor: "cyan",
	accent: "cyan",

	marks: { success: "✓", warning: "!", error: "✗", pending: "·", selected: "❯" },
	bold: { error: true, warning: false, success: false },
});
