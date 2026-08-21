import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { Store } from "../store.ts";
import { useStore } from "../store.ts";
import { useTheme } from "../theme.ts";
import { initialUiState, reduceEvent, type UiState } from "../ui-state.ts";
import { MessageList, StreamingPreview } from "./MessageList.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { StatusLine } from "./StatusLine.tsx";

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
	/** Called for every non-slash prompt the user submits. */
	onSubmitText?: (text: string) => void;
	/** "#" input prefix — append a memory note instead of prompting. */
	onMemoryShortcut?: (note: string) => void;
	/** Slash-command suggestions for autocomplete. */
	commandSuggestions?: Array<[string, string]>;
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
}: ReplProps) {
	const theme = useTheme();
	const entries = useStore(store, (s) => s.entries);
	const streamingText = useStore(store, (s) => s.streamingText);
	const thinkingText = useStore(store, (s) => s.thinkingText);
	const statusPhase = useStore(store, (s) => s.statusPhase);
	const dialog = useStore(store, (s) => s.dialog);
	const contextInfo = useStore(store, (s) => s.contextInfo);
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
				handleCommand(trimmed, { store, session, modelName, onExit });
				return;
			}
			if (trimmed.startsWith("#")) {
				onMemoryShortcut?.(trimmed.slice(1).trim());
				return;
			}
			onSubmitText?.(text);
			void session.prompt(text);
		},
		[session, store, modelName, onExit, onCommand, onSubmitText, onMemoryShortcut],
	);

	useInput((input, key) => {
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

	return (
		<Box flexDirection="column">
			<MessageList entries={entries} />
			<StreamingPreview text={streamingText} thinking={thinkingText} />
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
			<PromptInput onSubmit={handleSubmit} disabled={dialog !== null} commandSuggestions={commandSuggestions} />
			<Text dimColor> </Text>
		</Box>
	);
}

function handleCommand(
	text: string,
	context: { store: Store<UiState>; session: AgentSession; modelName: string; onExit: () => void },
): void {
	const { store, session, modelName, onExit } = context;
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
