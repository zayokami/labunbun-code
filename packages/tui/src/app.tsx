/**
 * Interactive REPL entry: builds the AgentSession wiring (including the
 * permission dialog bridge), renders the Ink app, and returns an exit code.
 */

import type { AgentSession, PermissionMode } from "@labunbun/agent";
import { render } from "ink";
import React from "react";
import { connectSessionToStore, REPL } from "./components/REPL.tsx";
import { createStore, type Store } from "./store.ts";
import { DARK_THEME, LIGHT_THEME, ThemeContext } from "./theme.ts";
import { initialUiState, toolPreview, type UiState } from "./ui-state.ts";

export interface ReplAppOptions {
	session: AgentSession;
	modelName: string;
	theme?: "dark" | "light";
	/** App-level slash-command handler; false falls through to built-ins. */
	onCommand?: (text: string) => boolean;
	/** Called for every non-slash prompt the user submits. */
	onSubmitText?: (text: string) => void;
	/** "#" input prefix — append a memory note instead of prompting. */
	onMemoryShortcut?: (note: string) => void;
	/** Slash-command suggestions for autocomplete. */
	commandSuggestions?: Array<[string, string]>;
	/** Called with "allow" decisions so the app can persist don't-ask-again rules. */
	onAlwaysAllow?: (toolName: string) => void;
}

export interface ReplAppHandle {
	store: Store<UiState>;
	waitUntilExit: () => Promise<void>;
	requestPermission: (toolName: string, input: unknown) => Promise<boolean>;
	clearPermissionRequest: () => void;
	setContextInfo(info: { usedTokens: number; threshold: number }): void;
}

/**
 * Mount the REPL. The returned handle exposes the permission bridge the
 * app layer wires into `deps.canUseTool`.
 */
export function mountRepl(options: ReplAppOptions): ReplAppHandle {
	const store = createStore<UiState>(initialUiState());
	const theme = options.theme === "light" ? LIGHT_THEME : DARK_THEME;

	let pendingPermission: ((allow: boolean) => void) | null = null;

	const instance = render(
		<ThemeContext.Provider value={theme}>
			<REPL
				session={options.session}
				store={store}
				modelName={options.modelName}
				onExit={() => instance.unmount()}
				onCommand={options.onCommand}
				onSubmitText={options.onSubmitText}
				onMemoryShortcut={options.onMemoryShortcut}
				commandSuggestions={options.commandSuggestions}
			/>
		</ThemeContext.Provider>,
	);

	const unsubscribe = connectSessionToStore(options.session, store);

	return {
		store,
		waitUntilExit: async () => {
			await instance.waitUntilExit();
			unsubscribe();
		},
		requestPermission: (toolName: string, input: unknown) =>
			new Promise<boolean>((resolve) => {
				pendingPermission = resolve;
				store.set((state) => ({
					...state,
					dialog: {
						callId: `perm-${toolName}`,
						toolName,
						inputPreview: toolPreview(toolName, input),
						resolve: (allow, alwaysAllow) => {
							store.set((s) => ({ ...s, dialog: null }));
							if (allow && alwaysAllow) options.onAlwaysAllow?.(toolName);
							pendingPermission = null;
							resolve(allow);
						},
					},
				}));
			}),
		setContextInfo: (info) => {
			store.set((s) => ({ ...s, contextInfo: info }));
		},
		clearPermissionRequest: () => {
			store.set((s) => ({ ...s, dialog: null }));
			pendingPermission = null;
		},
	};
}

export type { PermissionMode };
export { DARK_THEME, LIGHT_THEME, ThemeContext };
