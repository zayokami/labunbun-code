import { DARK_THEME } from "./dark.ts";
import { deriveTheme, type Theme } from "./tokens.ts";

/**
 * Colorblind-safe variants, both on a dark background.
 *
 * Neither theme relies on color alone — `marks` and `bold` are what actually
 * carry state, and diff lines keep their `+`/`-` prefixes. The palettes below
 * are the second line of defence: they keep the state colors far enough apart
 * that a reader who can see them still gets the same information.
 *
 * `deuteranopia-dark` uses the Okabe-Ito palette, a published qualitative
 * color set designed to stay distinguishable under color vision deficiency.
 */

/**
 * Red-green (deuteranopia). The load-bearing change is success moving off
 * green onto blue — under deuteranopia green and red converge, so a green
 * "done" and a red "failed" read as the same color.
 *
 * Success, permission, and accent all sit in the blue-violet range because
 * five distinct hues are not available; they are separated by lightness
 * instead (dark blue / desaturated violet / light sky blue), and they never
 * appear in the same position as one another.
 */
export const DEUTERANOPIA_DARK: Theme = deriveTheme(DARK_THEME, {
	name: "deuteranopia-dark",

	text: "#ffffff",
	textMuted: "#a0a0a0",
	userInput: "#56b4e9",
	thinking: "#a0a0a0",

	toolName: "#cc79a7",
	toolArgs: "#a0a0a0",
	toolOutput: "#d0d0d0",
	toolBorder: "#a0a0a0",

	success: "#0072b2",
	warning: "#f0e442",
	error: "#d55e00",
	permission: "#cc79a7",
	pending: "#a0a0a0",

	diffAdded: "#0072b2",
	diffRemoved: "#d55e00",
	diffHeader: "#56b4e9",
	codeText: "#d0d0d0",
	codeBorder: "#a0a0a0",

	path: "#56b4e9",
	link: "#56b4e9",
	selection: "#56b4e9",
	border: "#a0a0a0",
	cursor: "#56b4e9",
	accent: "#56b4e9",

	bold: { error: true, warning: true, success: true },
});

/**
 * Blue-yellow (tritanopia). Red and green survive here, so success stays
 * green and error stays red; yellow is the casualty — it converges with pink
 * and violet — so warning moves onto pink and nothing depends on a yellow.
 *
 * Blue is avoided throughout because it converges with green: a blue accent
 * beside a green success would read as one color. Accent is a light teal,
 * clearly lighter than the success green, and permission is a salmon that sits
 * lighter than the error red.
 */
export const TRITANOPIA_DARK: Theme = deriveTheme(DARK_THEME, {
	name: "tritanopia-dark",

	text: "#ffffff",
	textMuted: "#a0a0a0",
	userInput: "#7fdbd0",
	thinking: "#a0a0a0",

	toolName: "#ff9ecb",
	toolArgs: "#a0a0a0",
	toolOutput: "#d0d0d0",
	toolBorder: "#a0a0a0",

	success: "#00a86b",
	warning: "#ff9ecb",
	error: "#e02020",
	permission: "#ff8a80",
	pending: "#a0a0a0",

	diffAdded: "#00a86b",
	diffRemoved: "#e02020",
	diffHeader: "#7fdbd0",
	codeText: "#d0d0d0",
	codeBorder: "#a0a0a0",

	path: "#7fdbd0",
	link: "#7fdbd0",
	selection: "#7fdbd0",
	border: "#a0a0a0",
	cursor: "#7fdbd0",
	accent: "#7fdbd0",

	bold: { error: true, warning: true, success: true },
});
