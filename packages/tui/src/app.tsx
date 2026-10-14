/**
 * Interactive REPL entry: builds the AgentSession wiring (including the
 * permission dialog bridge), renders the Ink app, and returns an exit code.
 */

import type { ActivityRange, AgentSession, ModeChoice, PermissionMode } from "@labunbun/agent";
import { describeModeChoice } from "@labunbun/agent";
import type { PadBridge } from "@labunbun/gamepad";
import { render } from "ink";
import { sealCount } from "./components/MessageList.tsx";
import {
	bindSession,
	clearScreenSequence,
	type PromptSubmitResult,
	type PromptSubmitVerdict,
	REPL,
} from "./components/REPL.tsx";
import { inputTrace } from "./input-trace.ts";
import { createPermissionQueue } from "./permission-queue.ts";
import { createQuestionSlot } from "./question-slot.ts";
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
	/** Modeless emacs editing in the prompt. Exclusive with {@link vimMode}. */
	emacsMode?: boolean;
	/** App-level slash-command handler; false falls through to built-ins. */
	onCommand?: (text: string) => boolean;
	/**
	 * Called for every non-slash prompt the user submits, before it reaches the
	 * transcript or the model. Returning `{ block: true }` rejects the prompt.
	 */
	onSubmitText?: (text: string) => PromptSubmitResult | Promise<PromptSubmitResult>;
	/**
	 * First refusal for a line typed while a run is in flight. Return true when
	 * the app has taken the line (an @-mention routed to a band member): it is
	 * not queued behind the run, and no user entry is recorded — the claiming
	 * path records it itself.
	 */
	onMidRunText?: (text: string) => boolean;
	/** "#" input prefix — append a memory note instead of prompting. */
	onMemoryShortcut?: (note: string) => void;
	/**
	 * Called after Shift+Tab moves the session's two axes, with the row it landed
	 * on. The app layer records the change — the session file is where a restart
	 * reads the mode from — and only this package sees the key.
	 */
	onModeChange?: (choice: ModeChoice) => void;
	/**
	 * Consulted when the user asks to leave — `/exit`, `/quit`, or the idle
	 * double Ctrl+C — before anything unmounts. Return true to leave; false
	 * keeps the session up, with the screen still here for whatever the hook
	 * has to ask or say.
	 *
	 * The question "what is still running" is the app layer's to answer: its
	 * registries hold the truth, and this package has no business knowing
	 * about subagents or background shells. A hook that throws is treated as
	 * true — a guard that cannot answer must not become an app nobody can
	 * exit.
	 */
	onExitRequest?: () => boolean | Promise<boolean>;
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
	/**
	 * Called with "ask me every time" decisions so the app can record a session
	 * rule that keeps the same scope coming back to the dialog. The mirror of
	 * `onAlwaysAllow`, scope derived from the same input.
	 */
	onAlwaysAsk?: (toolName: string, input: unknown) => void;
	/**
	 * Whether a call the queue matched against a fresh grant may be answered
	 * without asking. Supplied by the app layer because the rules and the mode
	 * are its to know; the TUI can only match, never decide.
	 */
	canAutoResolve?: (toolName: string, input: unknown) => boolean;
	/**
	 * The controller, when the app layer built one. The TUI never builds one: it
	 * is handed the bridge, which is what keeps node-hid and everything else a
	 * device needs on the other side of a package boundary.
	 */
	pad?: PadBridge;
}

export interface ReplAppHandle {
	store: Store<UiState>;
	waitUntilExit: () => Promise<void>;
	/**
	 * Ask for permission; resolves true when allowed.
	 *
	 * `source` names who raised the ask when that is not this session — an ask
	 * forwarded from a subagent's funnel, shown on the dialog so the user knows
	 * which worker is blocked on the answer. `signal` withdraws the ask: on
	 * abort it leaves the queue and resolves false, so a stopped subagent
	 * cannot leave its question on the screen. The session's own calls pass
	 * neither.
	 */
	requestPermission: (toolName: string, input: unknown, source?: string, signal?: AbortSignal) => Promise<boolean>;
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
		options?: { initialIndex?: number; onHighlight?: (index: number) => void; onCancel?: () => void },
	) => Promise<number | null>;
	/**
	 * Deny every pending permission request and dismiss the dialog. For a run
	 * being aborted: the answers no longer matter, but their callers are still
	 * awaiting them, so they must be settled rather than dropped.
	 */
	clearPermissionRequest: () => void;
	/**
	 * Dismiss the question dialog as canceled, if one is up. The same caller-side
	 * need as `clearPermissionRequest` above and for the same reason: an aborted
	 * run's question will never be answered, and its caller is still awaiting it.
	 */
	clearQuestionRequest: () => void;
	/**
	 * Dismiss an open picker as canceled, if one is up. The same caller-side
	 * need again: something else is about to take the screen — a confirmation
	 * asked while a list is still up — and a list left up would move and
	 * confirm with the same keys as the dialog under it, so one Enter would
	 * answer both. Cancelling lands as the null Esc would have given it, any
	 * preview undone.
	 */
	clearPickerRequest: () => void;
	setContextInfo(info: { usedTokens: number; threshold: number }): void;
	/** Show the `/status` card over the prompt; null dismisses it. */
	setStatusCard(card: StatusCardData | null): void;
	/**
	 * Open the activity heatmap over the prompt (`/activity`). It is handed the
	 * home directory and a range rather than a finished report, because the panel
	 * re-collects when `r` changes the range and a report frozen here would make
	 * every wider window cost a walk of the whole session tree.
	 */
	showActivity(home: string | undefined, range?: ActivityRange): void;
	/** Put the heatmap away — what Esc does, and what reopening never has to ask. */
	clearActivity(): void;
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
	/**
	 * Show a theme without committing it: the live rows recolor, the sealed
	 * transcript keeps the palette it was printed with, and nothing is wiped
	 * or reprinted. What the picker calls as the highlight moves; see
	 * `applyTheme` for what making the choice costs.
	 */
	previewTheme(theme: Theme): void;
	/** Turn modal vim editing in the prompt on or off (`/vim`). */
	setVimMode(on: boolean): void;
	/** Turn modeless emacs editing in the prompt on or off (`/emacs`). */
	setEmacsMode(on: boolean): void;
	/**
	 * Republish the permission mode the prompt shows.
	 *
	 * Here for the same reason `setVimMode` is: `/mode` runs in the app layer and
	 * sets the mode on the session, and the session has no event for it, so the
	 * prompt's label would keep naming the mode the user just left. The label is
	 * `describeModeChoice`'s — the caller names the pair, this does not interpret
	 * it, because "what does `agent` + `danger-full-access` call itself" is the
	 * one answer in the codebase and it belongs beside the table.
	 */
	setModeLabel(label: string): void;
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
 * Whether two shell lists would render identically.
 *
 * The app layer polls the shell manager, so this runs every couple of seconds
 * forever: it decides between "nothing to say" and a full tree render.
 *
 * The tail is compared line by line, which is the difference between a watch
 * panel that updates and one that only ever shows what the shell printed before
 * it was first polled. A field that reaches the store without reaching this
 * function is a field the store silently refuses to hear about — the publisher
 * keeps the old array, so nothing downstream can tell the new value existed.
 * The comparison is cheap in the case that matters: the first line that differs
 * answers `false`, and an unchanged tail is one pass over lines that were just
 * built by slicing a string.
 */
export function sameShells(a: UiBackgroundShell[], b: UiBackgroundShell[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every(
		(shell, i) =>
			shell.id === b[i].id &&
			shell.status === b[i].status &&
			shell.command === b[i].command &&
			sameTail(shell.tail, b[i].tail),
	);
}

/** Element-wise, and length first: two tails are the same window or they are not. */
function sameTail(a: string[], b: string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((line, i) => line === b[i]);
}

/**
 * Commit a theme: the palette in the store, and the screen underneath it.
 *
 * Ink appends `<Static>` output and never erases it, so a row that has been
 * printed belongs to the terminal's scrollback with the colors it was born
 * with. The transcript remounts on a new committed theme and ink prints every
 * sealed row again (see `transcriptPaintKey`) — which is a repaint only if the
 * screen is empty first, or the transcript would simply appear twice, the old
 * palette above the new. Taking the screen back takes the scrollback with it
 * on the terminals that can; Windows consoles keep it (see
 * `clearScreenSequence`). So the wipe is spent only when there is both
 * something to reprint and something to change.
 *
 * Committing is the expensive half, and it is for choices that are being
 * kept — Enter in the picker, `/theme <name>`. Browsing the list previews
 * through `previewTheme` instead, which is why this may find `theme` already
 * equal and still have work to do: a previewed theme has not been stamped
 * into the transcript yet, and stamping is exactly the wipe-and-reprint.
 */
export function applyTheme(
	store: Store<UiState>,
	theme: Theme,
	stream: { isTTY?: boolean; write: (data: string) => void } = process.stdout,
): void {
	if (store.get().theme === theme && store.get().themeCommit === theme) return;
	if (stream.isTTY && sealCount(store.get().entries) > 0) stream.write(clearScreenSequence());
	store.set((s) => ({ ...s, theme, themeCommit: theme }));
}

/**
 * Show a theme without stamping it into the transcript.
 *
 * The picker previews a theme on every highlight move, and a move is not a
 * choice. Committing each one — the old behavior — wiped the screen and
 * reprinted the whole transcript on every arrow press, scrollback included
 * wherever the wipe reaches it: the screen the user is reading gets redrawn
 * per keystroke. A preview changes `theme` and stops: the live rows recolor
 * because they re-render — the palette reaches them through the provider —
 * while the sealed rows keep the colors they were printed with, because the
 * list's remount key reads `themeCommit` and it has not moved. Undoing a
 * preview costs the same one store write (`/theme`'s cancel does exactly
 * that). Whatever preview is kept commits through `applyTheme`.
 */
export function previewTheme(store: Store<UiState>, theme: Theme): void {
	if (store.get().theme === theme) return;
	store.set((s) => ({ ...s, theme }));
}

/**
 * Reads the theme from the store so a `setTheme` call rerenders the tree.
 * Without this the provider value would be captured once at `render()` time,
 * outside any component, and a store change would never reach it.
 */
function ThemedTree({ store, children }: { store: Store<UiState>; children: React.ReactNode }) {
	const theme = useStore(store, (state) => state.theme);
	return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/**
 * Cancel whatever picker is on screen, if one is up, landing as the null Esc
 * would have given it.
 *
 * The two calls are, in order, the ones `ListPickerDialog` makes for its own
 * escape: a preview the caller asked to be able to undo is undone, then the
 * list resolves as canceled. Nothing here needs a mounted tree — the picker is
 * whatever the store holds — which is what lets `clearPickerRequest` be the
 * same two lines rather than a second implementation of them.
 */
export function cancelOpenPicker(store: Store<UiState>): void {
	const picker = store.get().picker;
	if (!picker) return;
	picker.onCancel?.();
	picker.resolve(null);
}

/**
 * Route the REPL's exit request through the app's guard.
 *
 * The REPL reports the request and forgets it — its `onExit` returns nothing —
 * so the guard's answer is awaited here and the unmount happens only on
 * "leave". The decision table is a function of its own rather than a closure
 * inside `mountRepl` so it can be tested without mounting: this is the TUI's
 * whole share of the exit guard.
 */
export function createExitHandler(
	request: (() => boolean | Promise<boolean>) | undefined,
	unmount: () => void,
): () => void {
	return () => {
		if (!request) {
			unmount();
			return;
		}
		void (async () => {
			let proceed: boolean;
			try {
				proceed = await request();
			} catch {
				// Fail open, per the option's own doc: a guard that cannot
				// answer must not become an app nobody can leave.
				proceed = true;
			}
			if (proceed) unmount();
		})();
	};
}

/**
 * Mount the REPL. The returned handle exposes the permission bridge the
 * app layer wires into `deps.canUseTool`.
 */
export function mountRepl(options: ReplAppOptions): ReplAppHandle {
	const store = createStore<UiState>({
		// Seeded from the session rather than defaulted: a run started with
		// `--permission-mode agent` is in `Agent` on its first frame, and a prompt
		// that says `Ask` until something changes it is a prompt that lied for as
		// long as it took to notice.
		...initialUiState(
			options.vimMode ?? false,
			options.emacsMode ?? false,
			describeModeChoice(options.session.permissionMode, options.session.sandbox),
		),
		theme: options.theme ?? DEFAULT_THEME,
		// What is on screen at startup was never printed before, so the stamp
		// starts on the same palette — nothing to reprint until a choice moves it.
		themeCommit: options.theme ?? DEFAULT_THEME,
		modelName: options.modelName,
	});

	/**
	 * The session lives behind a holder so an in-app /resume can hot-swap it
	 * without remounting: every REPL read goes through getSession() at call
	 * time, so no closure ever holds a stale session.
	 */
	const sessionHolder = { current: options.session };
	// Both subscriptions and the opening transcript come from `bindSession`: a
	// session resumed at startup carries its history in `messages`, and the
	// connect is what turns it into rows. (The footer is the second listener on
	// the same session — subscribed after the reducer, so its line lands after
	// whatever `agent_end` committed to the transcript.)
	let { unsubscribeSession, unsubscribeFooter } = bindSession(store, sessionHolder.current);

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
				onExit={createExitHandler(options.onExitRequest, () => instance.unmount())}
				onCommand={options.onCommand}
				onSubmitText={options.onSubmitText}
				onMidRunText={options.onMidRunText}
				onMemoryShortcut={options.onMemoryShortcut}
				onModeChange={options.onModeChange}
				commandSuggestions={options.commandSuggestions}
				completeFiles={options.completeFiles}
				dirName={options.dirName}
				history={options.history}
				pad={options.pad}
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
		onAlwaysAsk: options.onAlwaysAsk,
		canAutoResolve: options.canAutoResolve,
	});

	const questionSlot = createQuestionSlot({
		show: (question) => store.set((state) => ({ ...state, question })),
	});

	return {
		store,
		waitUntilExit: async () => {
			await instance.waitUntilExit();
			unsubscribeSession();
			unsubscribeFooter();
		},
		requestPermission: permissionQueue.request,
		setContextInfo: (info) => {
			store.set((s) => ({ ...s, contextInfo: info }));
		},
		setStatusCard: (card) => {
			store.set((s) => ({ ...s, statusCard: card }));
		},
		showActivity: (home, range) => {
			store.set((s) => ({ ...s, activity: { home, range: range ?? "30d" } }));
		},
		clearActivity: () => {
			store.set((s) => (s.activity ? { ...s, activity: null } : s));
		},
		setBackgroundShells: (shells) => {
			store.set((s) => (sameShells(s.backgroundShells, shells) ? s : { ...s, backgroundShells: shells }));
		},
		setVimMode: (on) => {
			// Turning one on clears the other here rather than in the command, so
			// that every route into the store — `/vim`, a settings reload, a test
			// calling the handle directly — gets the same answer. A prompt that is
			// both modal and modeless is a prompt whose `C-f` depends on which
			// engine was constructed last.
			store.set((s) => (on ? { ...s, vim: true, emacs: false } : { ...s, vim: false }));
		},
		setEmacsMode: (on) => {
			store.set((s) => (on ? { ...s, emacs: true, vim: false } : { ...s, emacs: false }));
		},
		setModeLabel: (label) => {
			store.set((s) => (s.modeLabel === label ? s : { ...s, modeLabel: label }));
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
						initialIndex: options?.initialIndex,
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
			inputTrace("ui.setTheme", theme.name);
			applyTheme(store, theme);
		},
		previewTheme: (theme) => {
			inputTrace("ui.previewTheme", theme.name);
			previewTheme(store, theme);
		},
		setSession: (next) => {
			sessionHolder.current = next;
			// Detach the outgoing session first, so a last event from it cannot land
			// after the swap; `bindSession` then owns the clear-then-seed order and
			// re-reads the mode label the incoming session is actually in.
			unsubscribeSession();
			unsubscribeFooter();
			({ unsubscribeSession, unsubscribeFooter } = bindSession(store, next));
		},
		setModelName: (name) => {
			store.set((s) => ({ ...s, modelName: name }));
		},
		askUser: questionSlot.ask,
		clearPermissionRequest: permissionQueue.clear,
		clearQuestionRequest: questionSlot.clear,
		clearPickerRequest: () => cancelOpenPicker(store),
	};
}

export type { PermissionMode, PromptSubmitResult, PromptSubmitVerdict, Theme };
export { DARK_THEME, DEFAULT_THEME, LIGHT_THEME, ThemeContext };
