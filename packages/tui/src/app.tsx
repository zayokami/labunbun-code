/**
 * Interactive REPL entry: builds the AgentSession wiring (including the
 * permission dialog bridge), renders the Ink app, and returns an exit code.
 */

import type { AgentSession, PermissionMode } from "@labunbun/agent";
import { render } from "ink";
import { connectSessionToStore, type PromptSubmitResult, type PromptSubmitVerdict, REPL } from "./components/REPL.tsx";
import { createStore, type Store } from "./store.ts";
import { DARK_THEME, LIGHT_THEME, ThemeContext } from "./theme.ts";
import { initialUiState, toolPreview, type UiState } from "./ui-state.ts";

export interface ReplAppOptions {
	session: AgentSession;
	modelName: string;
	theme?: "dark" | "light";
	/** Modal vim editing in the prompt. */
	vimMode?: boolean;
	/** App-level slash-command handler; false falls through to built-ins. */
	onCommand?: (text: string) => boolean;
	/**
	 * Called for every non-slash prompt the user submits, before it reaches the
	 * transcript or the model. Returning `{ block: true }` rejects the prompt.
	 */
	onSubmitText?: (text: string) => PromptSubmitResult | Promise<PromptSubmitResult>;
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
	/** Show a structured question dialog; resolves with answers or null on cancel. */
	askUser: (
		questions: Array<{
			question: string;
			header: string;
			options: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
	) => Promise<string[] | null>;
	clearPermissionRequest: () => void;
	setContextInfo(info: { usedTokens: number; threshold: number }): void;
	setTasks(
		tasks: Array<{ id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>,
	): void;
}

/**
 * Mount the REPL. The returned handle exposes the permission bridge the
 * app layer wires into `deps.canUseTool`.
 */
export function mountRepl(options: ReplAppOptions): ReplAppHandle {
	const store = createStore<UiState>(initialUiState());
	const theme = options.theme === "light" ? LIGHT_THEME : DARK_THEME;

	const instance = render(
		<ThemeContext.Provider value={theme}>
			<REPL
				session={options.session}
				store={store}
				modelName={options.modelName}
				onExit={() => instance.unmount()}
				vimMode={options.vimMode}
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
				store.set((state) => ({
					...state,
					dialog: {
						callId: `perm-${toolName}`,
						toolName,
						inputPreview: toolPreview(toolName, input),
						resolve: (allow, alwaysAllow) => {
							store.set((s) => ({ ...s, dialog: null }));
							if (allow && alwaysAllow) options.onAlwaysAllow?.(toolName);
							resolve(allow);
						},
					},
				}));
			}),
		setContextInfo: (info) => {
			store.set((s) => ({ ...s, contextInfo: info }));
		},
		setTasks: (tasks) => {
			store.set((s) => ({ ...s, tasks }));
		},
		askUser: (questions) =>
			new Promise<string[] | null>((resolve) => {
				store.set((s) => ({
					...s,
					question: {
						questions,
						resolve: (answers) => {
							store.set((st) => ({ ...st, question: null }));
							resolve(answers);
						},
					},
				}));
			}),
		clearPermissionRequest: () => {
			store.set((s) => ({ ...s, dialog: null }));
		},
	};
}

export type { PermissionMode, PromptSubmitResult, PromptSubmitVerdict };
export { DARK_THEME, LIGHT_THEME, ThemeContext };
