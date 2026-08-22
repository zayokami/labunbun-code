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
export { connectSessionToStore, REPL, type ReplProps } from "./components/REPL.tsx";
export { StatusLine } from "./components/StatusLine.tsx";
export { type TextInputActions, type TextInputState, useTextInput } from "./hooks/useTextInput.ts";
export { createStore, type Store, useStore } from "./store.ts";
export { DARK_THEME, LIGHT_THEME, type Theme, ThemeContext, useTheme } from "./theme.ts";
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
