import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { Store } from "../store.ts";
import { useStore } from "../store.ts";
import { initialUiState, reduceEvent, type UiState } from "../ui-state.ts";
import { MessageList, StreamingPreview, VirtualMessageList } from "./MessageList.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { QuestionDialog } from "./QuestionDialog.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { TaskStrip } from "./TaskStrip.tsx";

/** Verdict from the app layer's prompt gate (UserPromptSubmit hooks). */
export interface PromptSubmitVerdict {
	block?: boolean;
	reason?: string;
}

/**
 * Prompt gate result. `undefined` means "no opinion, let it through" — the
 * common case when no UserPromptSubmit hook is configured.
 */
export type PromptSubmitResult = PromptSubmitVerdict | undefined;

export interface ReplProps {
	session: AgentSession;
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
	/** Modal vim editing in the prompt. */
	vimMode?: boolean;
	/** Context-window usage for the status line. */
	contextInfo?: { usedTokens: number; threshold: number };
}

const HELP_TEXT = `Commands:
  /help          Show this help
  /clear         Clear the conversation display
  /model <name>  Show or switch model (e.g. /model deepseek/deepseek-chat)
  /cost          Show session cost and token usage
  /permissions   Show permission rules and mode
  /resume        Resume a saved session
  /exit          Exit LaBunbun Code

Keys:
  Enter send · Shift+Enter newline · ↑/↓ history · Esc interrupt · Ctrl+C exit`;

export function REPL({
	session,
	store,
	modelName,
	onExit,
	onCommand,
	onSubmitText,
	onMemoryShortcut,
	commandSuggestions,
	vimMode,
}: ReplProps) {
	const entries = useStore(store, (s) => s.entries);
	const streamingText = useStore(store, (s) => s.streamingText);
	const thinkingText = useStore(store, (s) => s.thinkingText);
	const statusPhase = useStore(store, (s) => s.statusPhase);
	const dialog = useStore(store, (s) => s.dialog);
	const question = useStore(store, (s) => s.question);
	const contextInfo = useStore(store, (s) => s.contextInfo);
	const tasks = useStore(store, (s) => s.tasks);
	const [elapsedMs, setElapsedMs] = useState(0);

	// Elapsed timer while busy.
	useEffect(() => {
		if (statusPhase === "idle") return;
		const startedAt = Date.now();
		setElapsedMs(0);
		const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
		return () => clearInterval(timer);
	}, [statusPhase]);

	const handleSubmit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.startsWith("/")) {
				if (onCommand?.(trimmed)) return;
				handleCommand(trimmed, { store, modelName, onExit });
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
		[session, store, modelName, onExit, onCommand, onSubmitText, onMemoryShortcut],
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
		if (key.escape && session.isRunning) {
			session.abort();
			return;
		}
		if (key.ctrl && input === "c") {
			if (session.isRunning) {
				session.abort();
			} else {
				onExit();
			}
		}
	});

	if (transcriptMode) {
		const windowSize = Math.min(entries.length, 25);
		const end = Math.max(windowSize, entries.length - transcriptOffset);
		const start = end - windowSize;
		const windowEntries = entries.slice(start, end);
		return (
			<Box flexDirection="column">
				<MessageList entries={windowEntries} />
				<Text dimColor>
					Transcript {start + 1}-{end} of {entries.length} · ↑/↓ page · ctrl+o/Esc back
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<VirtualMessageList entries={entries} />
			<StreamingPreview text={streamingText} thinking={thinkingText} />
			{tasks && tasks.length > 0 && <TaskStrip tasks={tasks} />}
			<Box marginBottom={1}>
				<StatusLine phase={statusPhase} modelName={modelName} elapsedMs={elapsedMs} contextInfo={contextInfo} />
			</Box>
			{dialog ? (
				<PermissionDialog
					toolName={dialog.toolName}
					inputPreview={dialog.inputPreview}
					onResolve={(allow, alwaysAllow) => dialog.resolve(allow, alwaysAllow)}
				/>
			) : null}
			{question ? <QuestionDialog questions={question.questions} resolve={question.resolve} /> : null}
			<PromptInput
				onSubmit={handleSubmit}
				disabled={dialog !== null || question !== null}
				commandSuggestions={commandSuggestions}
				vim={vimMode}
			/>
			<Text dimColor> </Text>
		</Box>
	);
}

function handleCommand(text: string, context: { store: Store<UiState>; modelName: string; onExit: () => void }): void {
	const { store, modelName, onExit } = context;
	const [command, ...args] = text.split(/\s+/);

	switch (command) {
		case "/help":
			pushInfo(store, HELP_TEXT);
			break;
		case "/clear":
			store.set((s) => ({ ...initialUiState(), dialog: s.dialog }));
			break;
		case "/model": {
			if (args[0]) {
				pushInfo(store, `Model switching arrives with the settings layer (Phase 4). Requested: ${args[0]}`);
			} else {
				pushInfo(store, `Current model: ${modelName}`);
			}
			break;
		}
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
