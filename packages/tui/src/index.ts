export const TUI_PACKAGE_VERSION = "0.1.0";

export {
	mountRepl,
	type PromptSubmitResult,
	type PromptSubmitVerdict,
	type ReplAppHandle,
	type ReplAppOptions,
	// Exported for the poll that feeds the shell row: what "unchanged" means is
	// worth pinning down in a test, and no test mounts the whole app.
	sameShells,
} from "./app.tsx";
export { MessageList, StreamingPreview } from "./components/MessageList.tsx";
export { PermissionDialog } from "./components/PermissionDialog.tsx";
export { PromptInput } from "./components/PromptInput.tsx";
export { QueuedMessages, queuedHint, queuedPreview } from "./components/QueuedMessages.tsx";
export { connectSessionToStore, helpText, REPL, type ReplProps } from "./components/REPL.tsx";
export { backgroundShellRow, StatusLine } from "./components/StatusLine.tsx";
export {
	type Appearance,
	appearanceFromColorFgBg,
	type DetectAppearanceOptions,
	detectAppearance,
	parseBackgroundLuminance,
} from "./detect-appearance.ts";
export { type TextInputActions, type TextInputState, useTextInput } from "./hooks/useTextInput.ts";
export { LIVE_OUTPUT_LINES, liveOutputLines, livePreviewTargets } from "./live-output.ts";
export { type Block, type InlineSpan, parseBlocks, parseInline } from "./markdown.ts";
export { expandPasteTokens, makePasteToken, normalizePaste, shouldPlaceholderize } from "./paste.ts";
export { alwaysAllowLabel, type PermissionOption, permissionOptions, ruleSpecifierFor } from "./permission-options.ts";
export { applyFileCompletion, currentAtWord, filterFiles } from "./prompt-files.ts";
export { createStore, type Store, useStore } from "./store.ts";
export {
	AUTO_THEME_NAME,
	BUILT_IN_THEME_NAMES,
	BUILT_IN_THEMES,
	DARK_THEME,
	DEFAULT_THEME,
	DEUTERANOPIA_DARK,
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
	TRITANOPIA_DARK,
	themeForAppearance,
	useTheme,
} from "./theme.ts";
export {
	INPUT_FULL_MAX,
	initialUiState,
	type PendingTool,
	type PermissionDialogState,
	type QueuedMessage,
	RESULT_TEXT_CAP,
	reduceEvent,
	type StatusCardData,
	type StatusPhase,
	toolFullView,
	toolPreview,
	type UiBackgroundShell,
	type UiEntry,
	type UiState,
} from "./ui-state.ts";
