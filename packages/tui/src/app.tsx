/**
 * Interactive REPL entry: builds the AgentSession wiring (including the
 * permission dialog bridge), renders the Ink app, and returns an exit code.
 */

import type { AgentSession, PermissionMode } from "@labunbun/agent";
import { render } from "ink";
import { connectSessionToStore, type PromptSubmitResult, type PromptSubmitVerdict, REPL } from "./components/REPL.tsx";
import { createPermissionQueue } from "./permission-queue.ts";
import { createStore, type Store, useStore } from "./store.ts";
import { DARK_THEME, DEFAULT_THEME, LIGHT_THEME, type Theme, ThemeContext } from "./theme.ts";
import {
	initialUiState,
	type StatusCardData,
	toolFullView,
	toolPreview,
	type UiBackgroundShell,
	type UiState,
} from "./ui-state.ts";

export interface ReplAppOptions {
	session: AgentSession;
	modelName: string;
	/**
	 * Theme to start with. Resolved by the caller — the TUI has no filesystem
	 * access, so third-party themes are loaded and named upstream of here.
	 */
	theme?: Theme;
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
	/** Candidate file paths for @-mention completion in the prompt. */
	completeFiles?: (query: string) => Promise<string[]>;
	/** Basename of the session directory, for the terminal window title. */
	dirName?: string;
	/** Prompts from earlier sessions, oldest first, for ↑ recall in the prompt. */
	history?: string[];
	/** Workspace root — what a "don't ask again" rule for a file tool is scoped to. */
	cwd?: string;
	/**
	 * Called with "allow" decisions so the app can record don't-ask-again rules.
	 * The input comes along because the scope of the rule is derived from what
	 * the user was looking at when they answered.
	 */
	onAlwaysAllow?: (toolName: string, input: unknown) => void;
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
	/**
	 * Show a scrollable pick-one list; resolves with the chosen index or null on
	 * cancel. The in-app /resume and /model pickers both run on this.
	 *
	 * `onHighlight` fires as the highlight moves so the caller can preview the
	 * choice (the theme picker does); `onCancel` fires before the null resolution
	 * so that preview can be undone.
	 */
	pickFromList: (
		title: string,
		items: Array<{ label: string; description?: string }>,
		options?: { onHighlight?: (index: number) => void; onCancel?: () => void },
	) => Promise<number | null>;
	/**
	 * Deny every pending permission request and dismiss the dialog. For a run
	 * being aborted: the answers no longer matter, but their callers are still
	 * awaiting them, so they must be settled rather than dropped.
	 */
	clearPermissionRequest: () => void;
	setContextInfo(info: { usedTokens: number; threshold: number }): void;
	/** Show the `/status` card over the prompt; null dismisses it. */
	setStatusCard(card: StatusCardData | null): void;
	/**
	 * Long-running shells for the status row. Called on a poll, so an unchanged
	 * list must keep the same array identity — otherwise every tick rerenders the
	 * whole tree to say what it already said.
	 */
	setBackgroundShells(shells: UiBackgroundShell[]): void;
	setTasks(
		tasks: Array<{ id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>,
	): void;
	/** Swap the active theme; takes effect on the next render. */
	setTheme(theme: Theme): void;
	/** Turn modal vim editing in the prompt on or off (`/vim`). */
	setVimMode(on: boolean): void;
	/**
	 * Hot-swap the running REPL onto a different AgentSession (in-app /resume):
	 * rebinds event subscription, clears transient transcript state, and keeps
	 * dialogs/theme/model name.
	 */
	setSession(next: AgentSession): void;
	/** Rename the model shown in the status line (/model switch). */
	setModelName(name: string): void;
}

/**
 * Reads the theme from the store so a `setTheme` call rerenders the tree.
 * Without this the provider value would be captured once at `render()` time,
 * outside any component, and a store change would never reach it.
 */
/**
 * Whether two shell lists would render identically.
 *
 * The app layer polls the shell manager, so this runs every couple of seconds
 * forever: it decides between "nothing to say" and a full tree render.
 */
export function sameShells(a: UiBackgroundShell[], b: UiBackgroundShell[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((shell, i) => shell.id === b[i].id && shell.status === b[i].status && shell.command === b[i].command);
}

function ThemedTree({ store, children }: { store: Store<UiState>; children: React.ReactNode }) {
	const theme = useStore(store, (state) => state.theme);
	return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/**
 * Mount the REPL. The returned handle exposes the permission bridge the
 * app layer wires into `deps.canUseTool`.
 */
export function mountRepl(options: ReplAppOptions): ReplAppHandle {
	const store = createStore<UiState>({
		...initialUiState(options.vimMode ?? false),
		theme: options.theme ?? DEFAULT_THEME,
		modelName: options.modelName,
	});

	/**
	 * The session lives behind a holder so an in-app /resume can hot-swap it
	 * without remounting: every REPL read goes through getSession() at call
	 * time, so no closure ever holds a stale session.
	 */
	const sessionHolder = { current: options.session };
	let unsubscribeSession = connectSessionToStore(sessionHolder.current, store);

	// exitOnCtrlC: false hands Ctrl+C to the REPL's own handler, which aborts a
	// running turn first and requires a second press when idle. Ink's default
	// (true) unmounts the whole app on the first \x03 before any handler runs,
	// discarding in-flight work with no chance to interrupt cleanly.
	const instance = render(
		<ThemedTree store={store}>
			<REPL
				getSession={() => sessionHolder.current}
				store={store}
				modelName={options.modelName}
				onExit={() => instance.unmount()}
				onCommand={options.onCommand}
				onSubmitText={options.onSubmitText}
				onMemoryShortcut={options.onMemoryShortcut}
				commandSuggestions={options.commandSuggestions}
				completeFiles={options.completeFiles}
				dirName={options.dirName}
				history={options.history}
			/>
		</ThemedTree>,
		{ exitOnCtrlC: false },
	);

	const permissionQueue = createPermissionQueue({
		show: (dialog) => store.set((state) => ({ ...state, dialog })),
		preview: toolPreview,
		fullPreview: toolFullView,
		cwd: options.cwd,
		onAlwaysAllow: options.onAlwaysAllow,
	});

	return {
		store,
		waitUntilExit: async () => {
			await instance.waitUntilExit();
			unsubscribeSession();
		},
		requestPermission: permissionQueue.request,
		setContextInfo: (info) => {
			store.set((s) => ({ ...s, contextInfo: info }));
		},
		setStatusCard: (card) => {
			store.set((s) => ({ ...s, statusCard: card }));
		},
		setBackgroundShells: (shells) => {
			store.set((s) => (sameShells(s.backgroundShells, shells) ? s : { ...s, backgroundShells: shells }));
		},
		setVimMode: (on) => {
			store.set((s) => ({ ...s, vim: on }));
		},
		setTasks: (tasks) => {
			store.set((s) => ({ ...s, tasks }));
		},
		pickFromList: (title, items, options) =>
			new Promise<number | null>((resolve) => {
				store.set((s) => ({
					...s,
					picker: {
						title,
						items,
						onHighlight: options?.onHighlight,
						onCancel: options?.onCancel,
						resolve: (index) => {
							store.set((st) => ({ ...st, picker: null }));
							resolve(index);
						},
					},
				}));
			}),
		setTheme: (theme) => {
			store.set((s) => ({ ...s, theme }));
		},
		setSession: (next) => {
			sessionHolder.current = next;
			unsubscribeSession();
			unsubscribeSession = connectSessionToStore(next, store);
			// Transient transcript state belongs to the old session; dialogs and
			// the theme belong to the app and survive.
			store.set((s) => ({
				...s,
				entries: [],
				streamingText: "",
				thinkingText: "",
				pendingTools: [],
				statusPhase: "idle",
				contextInfo: undefined,
				tasks: [],
			}));
		},
		setModelName: (name) => {
			store.set((s) => ({ ...s, modelName: name }));
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
		clearPermissionRequest: permissionQueue.clear,
	};
}

export type { PermissionMode, PromptSubmitResult, PromptSubmitVerdict, Theme };
export { DARK_THEME, DEFAULT_THEME, LIGHT_THEME, ThemeContext };
