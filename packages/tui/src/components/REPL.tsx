import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Store } from "../store.ts";
import { useStore } from "../store.ts";
import { initialUiState, reduceEvent, type UiState } from "../ui-state.ts";
import { ListPickerDialog } from "./ListPickerDialog.tsx";
import { MessageList, StreamingPreview, VirtualMessageList } from "./MessageList.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { QuestionDialog } from "./QuestionDialog.tsx";
import { estimateOutputTokens, StatusLine } from "./StatusLine.tsx";
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
	/** Modal vim editing in the prompt. */
	vimMode?: boolean;
	/** Context-window usage for the status line. */
	contextInfo?: { usedTokens: number; threshold: number };
	/** Prompts from earlier sessions, oldest first, for ↑ recall. */
	history?: string[];
	/** Basename of the session directory, for the terminal window title. */
	dirName?: string;
}

const KEYS_HELP = `Keys:
  Enter send · Shift+Enter newline · ↑/↓ history · Esc interrupt · Ctrl+C exit (twice when idle)`;

/** Clear screen, clear scrollback, home cursor — the full terminal wipe. */
export const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

/** Terminal bell — rings when a run finishes and attention is needed. */
export const BEL = "\x07";

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
export function helpText(commandSuggestions?: Array<[string, string]>): string {
	const byName = new Map<string, string>(BUILT_IN_HELP);
	for (const [name, description] of commandSuggestions ?? []) byName.set(name, description);
	const rows = [...byName].sort(([a], [b]) => a.localeCompare(b));
	const width = Math.max(...rows.map(([name]) => name.length));
	const lines = rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`);
	return `Commands:\n${lines.join("\n")}\n\n${KEYS_HELP}`;
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
	vimMode,
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
	const tasks = useStore(store, (s) => s.tasks);
	const modelName = useStore(store, (s) => s.modelName) || modelNameProp;
	const [elapsedMs, setElapsedMs] = useState(0);
	// Idle Ctrl+C confirmation state: the timestamp of the first press and the
	// hint line shown until the window lapses.
	const lastCtrlCAtRef = useRef(0);
	const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [ctrlCHint, setCtrlCHint] = useState(false);

	useEffect(
		() => () => {
			if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
		},
		[],
	);

	// Elapsed timer while busy.
	useEffect(() => {
		if (statusPhase === "idle") return;
		const startedAt = Date.now();
		setElapsedMs(0);
		const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
		return () => clearInterval(timer);
	}, [statusPhase]);

	// Completion bell: a run ending is the moment attention matters, and the
	// user may be in another window. Only on a real busy → idle transition.
	const wasBusyRef = useRef(false);
	useEffect(() => {
		const busy = statusPhase !== "idle";
		if (busy) {
			wasBusyRef.current = true;
		} else if (wasBusyRef.current) {
			wasBusyRef.current = false;
			if (process.stdout.isTTY) process.stdout.write(BEL);
		}
	}, [statusPhase]);

	const handleSubmit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.startsWith("/")) {
				if (onCommand?.(trimmed)) return;
				handleCommand(trimmed, { store, modelName, onExit, commandSuggestions });
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
					// Queue for the next turn boundary instead of erroring —
					// followUp drains when the current run terminates naturally.
					session.followUp(text);
					store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text: "[queued]" }] }));
					return;
				}
				void session.prompt(text);
			})();
		},
		[getSession, store, modelName, onExit, onCommand, onSubmitText, onMemoryShortcut, commandSuggestions],
	);

	const [transcriptMode, setTranscriptMode] = useState(false);
	const [transcriptOffset, setTranscriptOffset] = useState(0);
	const TRANSCRIPT_PAGE = 10;

	useInput((input, key) => {
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
		if (key.escape && getSession().isRunning) {
			getSession().abort();
			return;
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
			<TerminalTitle phase={statusPhase} dirName={dirName} />
			<VirtualMessageList entries={entries} />
			<StreamingPreview text={streamingText} thinking={thinkingText} />
			{tasks && tasks.length > 0 && <TaskStrip tasks={tasks} />}
			<Box marginBottom={1}>
				<StatusLine
					phase={statusPhase}
					modelName={modelName}
					elapsedMs={elapsedMs}
					contextInfo={contextInfo}
					outputEstimate={estimateOutputTokens(streamingText.length)}
				/>
			</Box>
			{dialog ? (
				<PermissionDialog
					toolName={dialog.toolName}
					inputPreview={dialog.inputPreview}
					onResolve={(allow, alwaysAllow) => dialog.resolve(allow, alwaysAllow)}
				/>
			) : null}
			{question ? <QuestionDialog questions={question.questions} resolve={question.resolve} /> : null}
			{picker ? <ListPickerDialog title={picker.title} items={picker.items} resolve={picker.resolve} /> : null}
			{ctrlCHint && <Text dimColor>Press Ctrl+C again to exit</Text>}
			<PromptInput
				onSubmit={handleSubmit}
				disabled={dialog !== null || question !== null || picker !== null}
				commandSuggestions={commandSuggestions}
				completeFiles={completeFiles}
				vim={vimMode}
				history={history}
			/>
			<Text dimColor> </Text>
		</Box>
	);
}

function handleCommand(
	text: string,
	context: {
		store: Store<UiState>;
		modelName: string;
		onExit: () => void;
		commandSuggestions?: Array<[string, string]>;
	},
): void {
	const { store, onExit, commandSuggestions } = context;
	const [command] = text.split(/\s+/);

	switch (command) {
		case "/help":
			pushInfo(store, helpText(commandSuggestions));
			break;
		case "/clear":
			// Display-only: the persisted session and the model context survive.
			store.set((s) => ({ ...initialUiState(), dialog: s.dialog, picker: s.picker }));
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
