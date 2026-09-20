import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTurnTimer } from "../hooks/useTurnTimer.ts";
import { type LastNotification, type NotifyKind, notificationSequence, shouldNotify } from "../notify.ts";
import { shortcutGroups } from "../shortcuts.ts";
import type { Store } from "../store.ts";
import { useStore } from "../store.ts";
import { type QueuedMessage, reduceEvent, type UiState } from "../ui-state.ts";
import { ListPickerDialog } from "./ListPickerDialog.tsx";
import { MessageList, StreamingPreview, VirtualMessageList } from "./MessageList.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { QuestionDialog } from "./QuestionDialog.tsx";
import { QueuedMessages } from "./QueuedMessages.tsx";
import { ShortcutOverlay } from "./ShortcutOverlay.tsx";
import { StatusCard } from "./StatusCard.tsx";
import { backgroundShellRow, estimateOutputTokens, StatusLine, toolSummary } from "./StatusLine.tsx";
import { TaskStrip } from "./TaskStrip.tsx";
import { TerminalTitle } from "./TerminalTitle.tsx";

/** Verdict from the app layer's prompt gate (UserPromptSubmit hooks). */
export interface PromptSubmitVerdict {
	block?: boolean;
	reason?: string;
	/**
	 * The gate consumed this input entirely (the "!" shell passthrough does) —
	 * it already wrote whatever belongs in the transcript, so the REPL must not
	 * push a user entry, queue the text, or prompt the model.
	 */
	handled?: true;
}

/**
 * Prompt gate result. `undefined` means "no opinion, let it through" — the
 * common case when no UserPromptSubmit hook is configured.
 */
export type PromptSubmitResult = PromptSubmitVerdict | undefined;

export interface ReplProps {
	/**
	 * Read the active session at call time. An in-app /resume swaps sessions
	 * without remounting, so holding the session in a prop would go stale.
	 */
	getSession: () => AgentSession;
	store: Store<UiState>;
	modelName: string;
	onExit: () => void;
	/**
	 * App-level command handler (settings/cost/resume...). Return true when
	 * the command was consumed; false falls through to the built-ins.
	 */
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
	/** Context-window usage for the status line. */
	contextInfo?: { usedTokens: number; threshold: number };
	/** Prompts from earlier sessions, oldest first, for ↑ recall. */
	history?: string[];
	/** Basename of the session directory, for the terminal window title. */
	dirName?: string;
}

const KEYS_HELP = `Keys:
  Enter send · Shift+Enter newline · ↑/↓ history · Esc interrupt · Ctrl+C exit (twice when idle)`;

/**
 * Appended to the key list when modal editing is on. Without it `/help` promised
 * the one thing vim mode changes: the editor claims Escape first, so the press
 * that leaves insert (or drops a half-typed command) never reaches the session.
 */
const VIM_KEYS_HELP = `  vim: i a insert · Esc leave insert · v/V Esc cancel selection · Esc interrupt when idle`;

/** Clear screen, clear scrollback, home cursor — the full terminal wipe. */
export const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

/** Double-press window for the idle Ctrl+C exit confirmation. */
export const CTRL_C_EXIT_WINDOW_MS = 2000;

/**
 * True when a second Ctrl+C inside the window should exit. Pure so the
 * two-press rule is testable without rendering the REPL.
 */
export function ctrlCShouldExit(lastAt: number, now: number, windowMs = CTRL_C_EXIT_WINDOW_MS): boolean {
	return lastAt > 0 && now - lastAt <= windowMs;
}

/**
 * Commands this component dispatches itself, which no caller-supplied registry
 * knows about. They are merged into `/help` so the list covers everything that
 * works, not just what the app layer contributed.
 */
const BUILT_IN_HELP: Array<[string, string]> = [
	["/clear", "Clear the conversation display"],
	["/exit", "Exit"],
	["/help", "Show this help"],
];

/**
 * Help text built from the command table the REPL was given, so a command added
 * to the registry cannot go missing from `/help`.
 */
export function helpText(commandSuggestions?: Array<[string, string]>, vim = false): string {
	const byName = new Map<string, string>(BUILT_IN_HELP);
	for (const [name, description] of commandSuggestions ?? []) byName.set(name, description);
	const rows = [...byName].sort(([a], [b]) => a.localeCompare(b));
	const width = Math.max(...rows.map(([name]) => name.length));
	const lines = rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`);
	const keys = vim ? `${KEYS_HELP}\n${VIM_KEYS_HELP}` : KEYS_HELP;
	return `Commands:\n${lines.join("\n")}\n\n${keys}`;
}

export function REPL({
	getSession,
	store,
	modelName: modelNameProp,
	onExit,
	onCommand,
	onSubmitText,
	onMemoryShortcut,
	commandSuggestions,
	completeFiles,
	history,
	dirName = "",
}: ReplProps) {
	const entries = useStore(store, (s) => s.entries);
	const streamingText = useStore(store, (s) => s.streamingText);
	const thinkingText = useStore(store, (s) => s.thinkingText);
	const statusPhase = useStore(store, (s) => s.statusPhase);
	const dialog = useStore(store, (s) => s.dialog);
	const question = useStore(store, (s) => s.question);
	const picker = useStore(store, (s) => s.picker);
	const contextInfo = useStore(store, (s) => s.contextInfo);
	const statusCard = useStore(store, (s) => s.statusCard);
	const backgroundShells = useStore(store, (s) => s.backgroundShells);
	const shellRow = backgroundShellRow(backgroundShells);
	const tasks = useStore(store, (s) => s.tasks);
	const liveOutputs = useStore(store, (s) => s.liveOutputs);
	const pendingTools = useStore(store, (s) => s.pendingTools);
	const queued = useStore(store, (s) => s.queued);
	// From the store, not a prop: `/vim` flips it while the app is running, and
	// the editor, `/help` and the key-list overlay all have to agree.
	const vim = useStore(store, (s) => s.vim);
	const modelName = useStore(store, (s) => s.modelName) || modelNameProp;
	// A dialog is the user deciding, not the model working. The clock stops while
	// one is open, so a turn that spent two minutes waiting on an approval does
	// not go on to report those two minutes as its own work.
	// All three overlays mean the same thing: the run is stopped until the user
	// answers. The clock, the title and the notification all read it from here so
	// a new overlay cannot be added to one and forgotten in another.
	const awaitingUser = dialog !== null || question !== null || picker !== null;
	/** A key pressed now would land mid-turn, so the prompt's keys change meaning. */
	const busy = statusPhase !== "idle";
	/**
	 * Whether the running turn will call the model again — tools are executing,
	 * so a steered message has somewhere to land. Without this Enter would queue
	 * while promising to steer.
	 */
	const canSteer = pendingTools.length > 0;
	/** Keys for the queued-message previews; text alone can repeat. */
	const queuedIdRef = useRef(0);
	const elapsedMs = useTurnTimer({ busy: statusPhase !== "idle", frozen: awaitingUser });
	// Idle Ctrl+C confirmation state: the timestamp of the first press and the
	// hint line shown until the window lapses.
	const lastCtrlCAtRef = useRef(0);
	const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [ctrlCHint, setCtrlCHint] = useState(false);
	/** Escape routing into the prompt editor — see the Esc branch below. */
	const escapeRef = useRef<(() => boolean) | null>(null);

	useEffect(
		() => () => {
			if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
		},
		[],
	);

	// Desktop notifications, on the two edges where the user is likely to be
	// looking at another window: a run ending, and a dialog opening. Coalescing
	// keeps a completion from burying the approval request that preceded it.
	const wasBusyRef = useRef(false);
	const wasBlockedRef = useRef(false);
	const lastNotifyRef = useRef<LastNotification | null>(null);
	useEffect(() => {
		const notify = (kind: NotifyKind, message: string): void => {
			// Ink 7 reports nothing about terminal focus — no `Key` field, no hook,
			// no kitty flag — so there is no way to tell whether anyone is looking.
			// Guessing would either ring during focused work or stay silent while
			// the user waits; notifying and coalescing is the honest default.
			if (!process.stdout.isTTY) return;
			const now = Date.now();
			if (!shouldNotify(kind, lastNotifyRef.current, now)) return;
			lastNotifyRef.current = { kind, at: now };
			const sequence = notificationSequence(message);
			if (sequence) process.stdout.write(sequence);
		};

		const busy = statusPhase !== "idle";
		if (busy) {
			wasBusyRef.current = true;
		} else if (wasBusyRef.current) {
			wasBusyRef.current = false;
			notify("complete", "labunbun: turn complete");
		}

		// Only the opening edge: a second dialog replacing the first is the same
		// interruption, and the terminal already rang for it.
		if (dialog !== null && !wasBlockedRef.current) notify("action", `labunbun: approval needed for ${dialog.toolName}`);
		wasBlockedRef.current = dialog !== null;
	}, [statusPhase, dialog]);

	/**
	 * Queue or steer a message into the running turn.
	 *
	 * The transcript entry goes in now rather than at delivery: it is what the
	 * user did, and waiting for the turn boundary would leave the screen silent
	 * about a keystroke they just made. `queued` is what carries the part they
	 * cannot see — that it has not been sent yet.
	 */
	const enqueue = useCallback(
		(text: string, mode: QueuedMessage["mode"]) => {
			const session = getSession();
			queuedIdRef.current += 1;
			store.set((s) => ({ ...s, queued: [...s.queued, { id: `q${queuedIdRef.current}`, text, mode }] }));
			if (mode === "steer") session.steer(text);
			else session.followUp(text);
		},
		[getSession, store],
	);

	const sendMidRun = useCallback(
		(text: string, mode: QueuedMessage["mode"]) => {
			// Same rule as an ordinary submit: sending something dismisses the
			// status card, which is a snapshot the new work has invalidated.
			store.set((s) => ({
				...s,
				statusCard: null,
				entries: [...s.entries, { kind: "user" as const, text, steered: mode === "steer" }],
			}));
			enqueue(text, mode);
		},
		[enqueue, store],
	);

	/**
	 * Escape during a run, with something typed: stop the run, then send it.
	 *
	 * `abort()` only asks the run to stop — the session stays "running" until the
	 * loop unwinds, and `prompt()` throws while it does. So the send waits for
	 * this run's own `agent_end`, which is the event that means the session is
	 * free again. If it was already free (an abort a moment earlier), there is
	 * nothing to wait for.
	 */
	const interruptAndSend = useCallback(
		(text: string) => {
			const session = getSession();
			store.set((s) => ({ ...s, entries: [...s.entries, { kind: "user" as const, text, steered: true }] }));
			session.abort();
			if (!session.isRunning) {
				void session.prompt(text);
				return;
			}
			const unsubscribe = session.on((event) => {
				if (event.type !== "agent_end") return;
				unsubscribe();
				void session.prompt(text);
			});
		},
		[getSession, store],
	);

	const handleSubmit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			// Anything the user sends dismisses the status card: it is a snapshot of
			// the moment it was asked for, and the work they are about to start
			// invalidates it. Clearing before dispatch is also what lets `/status`
			// replace an open card rather than stack one behind it.
			store.set((s) => (s.statusCard ? { ...s, statusCard: null } : s));
			if (trimmed.startsWith("/")) {
				if (onCommand?.(trimmed)) return;
				handleCommand(trimmed, { store, modelName, onExit, commandSuggestions, vim });
				return;
			}
			if (trimmed.startsWith("#")) {
				onMemoryShortcut?.(trimmed.slice(1).trim());
				return;
			}
			// The submit gate may be async (UserPromptSubmit hooks shell out), so
			// the prompt is held until it reports back. A blocked prompt never
			// reaches the transcript or the model.
			void (async () => {
				let verdict: PromptSubmitResult;
				try {
					verdict = await onSubmitText?.(text);
				} catch {
					verdict = undefined; // a failing gate must not swallow the prompt
				}
				if (verdict?.block) {
					store.set((s) => ({
						...s,
						entries: [
							...s.entries,
							{ kind: "user", text: trimmed },
							{ kind: "error", text: verdict?.reason ?? "Prompt blocked by UserPromptSubmit hook" },
						],
					}));
					return;
				}
				if (verdict?.handled) return;
				const session = getSession();
				store.set((s) => ({ ...s, entries: [...s.entries, { kind: "user", text: trimmed }] }));
				if (session.isRunning) {
					// The key handler in PromptInput owns this during a run; landing
					// here means the session went busy before the store heard about
					// it. The entry is already in; only the queueing is left.
					enqueue(text, "queue");
					return;
				}
				void session.prompt(text);
			})();
		},
		[getSession, store, modelName, onExit, onCommand, onSubmitText, onMemoryShortcut, commandSuggestions, vim, enqueue],
	);

	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [transcriptMode, setTranscriptMode] = useState(false);
	const [transcriptOffset, setTranscriptOffset] = useState(0);
	const TRANSCRIPT_PAGE = 10;

	useInput((input, key) => {
		// The key list is dismissed by either key, and while it is up the prompt is
		// disabled — so this branch owns `?` for as long as it is open, and the
		// overlay cannot be closed onto a running turn by the Esc beneath it.
		if (shortcutsOpen && (key.escape || input === "?")) {
			setShortcutsOpen(false);
			return;
		}
		// The status card answers to the same rule as the key list: what is on
		// screen takes the key before the key means something behind it. It is not
		// modal — the prompt still works, and typing over it dismisses it.
		if (statusCard && key.escape) {
			store.set((s) => ({ ...s, statusCard: null }));
			return;
		}
		if (key.ctrl && input === "o") {
			setTranscriptMode((v) => !v);
			setTranscriptOffset(0);
			return;
		}
		if (transcriptMode) {
			if (key.upArrow || input === "k") {
				setTranscriptOffset((o) => Math.min(o + TRANSCRIPT_PAGE, entries.length));
			} else if (key.downArrow || input === "j") {
				setTranscriptOffset((o) => Math.max(0, o - TRANSCRIPT_PAGE));
			} else if (key.escape || input === "q") {
				setTranscriptMode(false);
				setTranscriptOffset(0);
			}
			return;
		}
		if (key.ctrl && input === "l") {
			// Wipe the terminal, not the conversation. Sealed Static rows are not
			// redrawn after an external clear — an accepted cosmetic cost of
			// keeping transcript state out of the terminal's own scrollback.
			if (process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN);
			return;
		}
		// A dialog owns Esc while one is open: there it means "deny this request"
		// (the dialog handles the key itself), not "abort the turn". Aborting here
		// too would kill the very tool call the user is deciding about, and the
		// decision they just made would land on a run that no longer exists.
		if (key.escape) {
			if (dialog || question || picker) return;
			// The editor gets the first look — it may have something of its own to
			// cancel (an @-list, insert mode, a half-typed vim command) that is not
			// an interrupt. Only what it declines to use reaches the session.
			if (escapeRef.current?.()) return;
			if (getSession().isRunning) {
				getSession().abort();
				return;
			}
		}
		if (key.ctrl && input === "c") {
			if (getSession().isRunning) {
				getSession().abort();
				return;
			}
			// Idle exit asks for a second press: one stray Ctrl+C must not throw
			// away a half-typed prompt or the session view.
			const now = Date.now();
			if (ctrlCShouldExit(lastCtrlCAtRef.current, now)) {
				onExit();
				return;
			}
			lastCtrlCAtRef.current = now;
			setCtrlCHint(true);
			if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
			ctrlCTimerRef.current = setTimeout(() => {
				setCtrlCHint(false);
				lastCtrlCAtRef.current = 0;
			}, CTRL_C_EXIT_WINDOW_MS);
		}
	});

	if (transcriptMode) {
		const windowSize = Math.min(entries.length, 25);
		const end = Math.max(windowSize, entries.length - transcriptOffset);
		const start = end - windowSize;
		const windowEntries = entries.slice(start, end);
		return (
			<Box flexDirection="column">
				{/* full output here — reading back is exactly when truncation hurts */}
				<MessageList entries={windowEntries} full />
				<Text dimColor>
					Transcript {start + 1}-{end} of {entries.length} · ↑/↓ page · ctrl+o/Esc back
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<TerminalTitle phase={statusPhase} dirName={dirName} actionRequired={awaitingUser} />
			<VirtualMessageList entries={entries} liveOutputs={liveOutputs} />
			<StreamingPreview text={streamingText} thinking={thinkingText} />
			{tasks && tasks.length > 0 && <TaskStrip tasks={tasks} />}
			<Box marginBottom={1} flexDirection="column">
				<StatusLine
					phase={statusPhase}
					modelName={modelName}
					elapsedMs={elapsedMs}
					contextInfo={contextInfo}
					outputEstimate={estimateOutputTokens(streamingText.length)}
				/>
				{/* "Running tools…" for twenty seconds says nothing about what is
				    running; the row underneath is what makes the wait legible. */}
				{pendingTools.length > 0 && (
					<Text dimColor>
						{"  └ "}
						{toolSummary(pendingTools)}
					</Text>
				)}
				{/* Not part of the turn: a background shell outlives it, which is
				    precisely why it has to stay on screen after the turn ends. */}
				{shellRow && <Text dimColor>{`  └ ${shellRow}`}</Text>}
			</Box>
			{/* Above the dialogs: it reports, it does not ask, and a dialog that
			    appears while it is open is the more urgent of the two. */}
			{statusCard ? <StatusCard data={statusCard} /> : null}
			{dialog ? (
				<PermissionDialog
					toolName={dialog.toolName}
					inputPreview={dialog.inputPreview}
					inputFull={dialog.inputFull}
					options={dialog.options}
					queueLength={dialog.queueLength}
					onResolve={(allow, alwaysAllow) => dialog.resolve(allow, alwaysAllow)}
				/>
			) : null}
			{question ? <QuestionDialog questions={question.questions} resolve={question.resolve} /> : null}
			{picker ? (
				<ListPickerDialog
					title={picker.title}
					items={picker.items}
					resolve={picker.resolve}
					onHighlight={picker.onHighlight}
					onCancel={picker.onCancel}
				/>
			) : null}
			{shortcutsOpen && <ShortcutOverlay groups={shortcutGroups({ vim, commands: commandSuggestions })} />}
			{ctrlCHint && <Text dimColor>Press Ctrl+C again to exit</Text>}
			<QueuedMessages queued={queued} canSteer={canSteer} vim={vim} />
			<PromptInput
				onSubmit={handleSubmit}
				disabled={dialog !== null || question !== null || picker !== null || shortcutsOpen}
				onToggleHelp={() => setShortcutsOpen(true)}
				commandSuggestions={commandSuggestions}
				completeFiles={completeFiles}
				vim={vim}
				history={history}
				escapeRef={escapeRef}
				busy={busy}
				canSteer={canSteer}
				onQueue={(text) => sendMidRun(text, "queue")}
				onSteer={(text) => sendMidRun(text, "steer")}
				onInterruptSend={interruptAndSend}
			/>
			<Text dimColor> </Text>
		</Box>
	);
}

/** Exported for its own test: the component renders, this decides. */
export function handleCommand(
	text: string,
	context: {
		store: Store<UiState>;
		modelName: string;
		onExit: () => void;
		commandSuggestions?: Array<[string, string]>;
		/** Modal editing is on, so the key list says what Escape does there. */
		vim?: boolean;
	},
): void {
	const { store, onExit, commandSuggestions } = context;
	const [command] = text.split(/\s+/);

	switch (command) {
		case "/help":
			pushInfo(store, helpText(commandSuggestions, context.vim));
			break;
		case "/clear":
			// Display-only: the persisted session and the model context survive.
			// So does everything that is not the transcript — the theme, the model
			// name, the editing mode, the shells that are still running — along with
			// the dialog, picker and question, which hold the closures a running
			// turn is waiting on. Rebuilding from a fresh initial state dropped all
			// of it, and the theme came back as the default.
			store.set((s) => ({
				...s,
				entries: [],
				streamingText: "",
				thinkingText: "",
				pendingTools: [],
				liveOutputs: {},
			}));
			break;
		case "/exit":
		case "/quit":
			onExit();
			break;
		default:
			pushInfo(store, `Unknown command: ${command} — try /help`);
	}
}

function pushInfo(store: Store<UiState>, text: string): void {
	store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text }] }));
}

/** Subscribe a store to an AgentSession's events. Returns unsubscribe. */
export function connectSessionToStore(session: AgentSession, store: Store<UiState>): () => void {
	return session.on((event: AgentEvent) => {
		store.set((state) => reduceEvent(state, event));
	});
}
