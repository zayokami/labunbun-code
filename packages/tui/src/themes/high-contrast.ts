import { DARK_THEME } from "./dark.ts";
import { LIGHT_THEME } from "./light.ts";
import { deriveTheme, type Theme } from "./tokens.ts";

/**
 * High-contrast variants. Foregrounds go to pure white or pure black and every
 * state color is pushed to a saturated value, so contrast against the
 * background stays high even on a washed-out display or a projector.
 *
 * All three `bold` flags are on: weight is a second, color-independent channel,
 * and these themes exist precisely for readers for whom color alone is not
 * enough. Both derive from a base theme and restate only what changes.
 */

export const HIGH_CONTRAST_DARK: Theme = deriveTheme(DARK_THEME, {
	name: "high-contrast-dark",

	text: "#ffffff",
	textMuted: "#d0d0d0",
	userInput: "#7fd4ff",
	thinking: "#d0d0d0",

	toolName: "#ff8cff",
	toolArgs: "#d0d0d0",
	toolOutput: "#e8e8e8",
	toolBorder: "#ffffff",

	success: "#00ff7f",
	warning: "#ffd400",
	error: "#ff4d4d",
	permission: "#ff00ff",
	pending: "#d0d0d0",

	diffAdded: "#00ff7f",
	diffRemoved: "#ff4d4d",
	diffHeader: "#00ffff",
	codeText: "#ffffff",
	codeBorder: "#ffffff",

	path: "#00ffff",
	link: "#7fd4ff",
	selection: "#00ffff",
	border: "#ffffff",
	cursor: "#00ffff",
	accent: "#00ffff",

	bold: { error: true, warning: true, success: true },
});

export const HIGH_CONTRAST_LIGHT: Theme = deriveTheme(LIGHT_THEME, {
	name: "high-contrast-light",

	text: "#000000",
	textMuted: "#3a3a3a",
	userInput: "#0000cc",
	thinking: "#3a3a3a",

	toolName: "#8b0072",
	toolArgs: "#3a3a3a",
	toolOutput: "#1a1a1a",
	toolBorder: "#000000",

	success: "#006400",
	warning: "#7a4d00",
	error: "#b30000",
	permission: "#6a00b3",
	pending: "#3a3a3a",

	diffAdded: "#006400",
	diffRemoved: "#b30000",
	diffHeader: "#0000cc",
	codeText: "#000000",
	codeBorder: "#000000",

	path: "#0000cc",
	link: "#0000cc",
	selection: "#0000cc",
	border: "#000000",
	cursor: "#000000",
	accent: "#0000cc",

	bold: { error: true, warning: true, success: true },
});
