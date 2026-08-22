/**
 * Built-in theme registry. Anything reachable by name from settings or
 * `/theme` is listed here; third-party themes loaded from JSON files are
 * merged on top of this set by the app layer.
 */
import { DEUTERANOPIA_DARK, TRITANOPIA_DARK } from "./colorblind.ts";
import { DARK_THEME } from "./dark.ts";
import { HIGH_CONTRAST_DARK, HIGH_CONTRAST_LIGHT } from "./high-contrast.ts";
import { LIGHT_THEME } from "./light.ts";
import { SPIDERMAN } from "./spiderman.ts";
import { SPLATOON } from "./splatoon.ts";
import type { Theme } from "./tokens.ts";

/**
 * Name that means "detect from the terminal background" rather than naming a
 * theme. Reserved: a theme file claiming it would be unreachable.
 */
export const AUTO_THEME_NAME = "auto";

/** The theme used when nothing is configured, or when a name does not resolve. */
export const DEFAULT_THEME: Theme = DARK_THEME;

const THEMES: readonly Theme[] = [
	DARK_THEME,
	LIGHT_THEME,
	HIGH_CONTRAST_DARK,
	HIGH_CONTRAST_LIGHT,
	DEUTERANOPIA_DARK,
	TRITANOPIA_DARK,
	SPIDERMAN,
	SPLATOON,
];

export const BUILT_IN_THEMES: ReadonlyMap<string, Theme> = new Map(THEMES.map((theme) => [theme.name, theme]));

/** Built-in theme names, in presentation order. */
export const BUILT_IN_THEME_NAMES: readonly string[] = THEMES.map((theme) => theme.name);

/** Look up a built-in theme by name; undefined lets the caller report the miss. */
export function resolveBuiltInTheme(name: string | undefined): Theme | undefined {
	return name ? BUILT_IN_THEMES.get(name) : undefined;
}

/** The built-in theme to use for a detected terminal background. */
export function themeForAppearance(appearance: "dark" | "light"): Theme {
	return appearance === "light" ? LIGHT_THEME : DARK_THEME;
}

export {
	defineTheme,
	deriveTheme,
	THEME_TOKEN_KEYS,
	type Theme,
	type ThemeBold,
	type ThemeMarks,
	type ThemeOverrides,
	type ThemeSpec,
} from "./tokens.ts";
export {
	DARK_THEME,
	DEUTERANOPIA_DARK,
	HIGH_CONTRAST_DARK,
	HIGH_CONTRAST_LIGHT,
	LIGHT_THEME,
	SPIDERMAN,
	SPLATOON,
	TRITANOPIA_DARK,
};
