/**
 * Theme context. The tokens themselves live in `themes/` — this module is the
 * React binding plus the import path components already use, so a component
 * only ever needs `useTheme()`.
 */
import { createContext, useContext } from "react";
import { DARK_THEME } from "./themes/index.ts";
import type { Theme } from "./themes/tokens.ts";

export const ThemeContext = createContext<Theme>(DARK_THEME);

export function useTheme(): Theme {
	return useContext(ThemeContext);
}

export {
	AUTO_THEME_NAME,
	BUILT_IN_THEME_NAMES,
	BUILT_IN_THEMES,
	DARK_THEME,
	DEFAULT_THEME,
	DEUTERANOPIA_DARK,
	defineTheme,
	deriveTheme,
	HIGH_CONTRAST_DARK,
	HIGH_CONTRAST_LIGHT,
	LIGHT_THEME,
	resolveBuiltInTheme,
	SPIDERMAN,
	SPLATOON,
	THEME_TOKEN_KEYS,
	type Theme,
	type ThemeBold,
	type ThemeMarks,
	type ThemeOverrides,
	type ThemeSpec,
	TRITANOPIA_DARK,
	themeForAppearance,
} from "./themes/index.ts";
