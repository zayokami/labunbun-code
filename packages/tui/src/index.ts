export const TUI_PACKAGE_VERSION = "0.1.0";

export {
	mountRepl,
	type PromptSubmitResult,
	type PromptSubmitVerdict,
	type ReplAppHandle,
	type ReplAppOptions,
} from "./app.tsx";
export { MessageList, StreamingPreview } from "./components/MessageList.tsx";
export { PermissionDialog } from "./components/PermissionDialog.tsx";
export { PromptInput } from "./components/PromptInput.tsx";
export { connectSessionToStore, helpText, REPL, type ReplProps } from "./components/REPL.tsx";
export { StatusLine } from "./components/StatusLine.tsx";
export {
	type Appearance,
	appearanceFromColorFgBg,
	type DetectAppearanceOptions,
	detectAppearance,
	parseBackgroundLuminance,
} from "./detect-appearance.ts";
export { type TextInputActions, type TextInputState, useTextInput } from "./hooks/useTextInput.ts";
export { type Block, type InlineSpan, parseBlocks, parseInline } from "./markdown.ts";
export { createStore, type Store, useStore } from "./store.ts";
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
	ThemeContext,
	type ThemeMarks,
	type ThemeOverrides,
	type ThemeSpec,
	TRITANOPIA_DARK,
	themeForAppearance,
	useTheme,
} from "./theme.ts";
export {
	initialUiState,
	type PendingTool,
	type PermissionDialogState,
	reduceEvent,
	type StatusPhase,
	toolPreview,
	type UiEntry,
	type UiState,
} from "./ui-state.ts";
