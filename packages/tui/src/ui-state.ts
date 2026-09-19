/**
 * UI state model: AgentSession events reduce into a flat transcript of
 * renderable entries plus transient streaming/status slices.
 */
import type { AgentEvent } from "@labunbun/agent";
import type { ListPickerState } from "./components/ListPickerDialog.tsx";
import type { PermissionOption } from "./permission-options.ts";
import { DEFAULT_THEME } from "./themes/index.ts";
import type { Theme } from "./themes/tokens.ts";

export type UiEntry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| {
			kind: "toolUse";
			callId: string;
			toolName: string;
			inputPreview: string;
			resultText?: string;
			isError?: boolean;
	  }
	| { kind: "error"; text: string }
	| { kind: "info"; text: string };

export interface PendingTool {
	callId: string;
	toolName: string;
}

export type StatusPhase = "idle" | "thinking" | "responding" | "tools";

export interface UiTask {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
}

export interface UiState {
	entries: UiEntry[];
	streamingText: string;
	thinkingText: string;
	pendingTools: PendingTool[];
	/**
	 * Output streamed by a tool that is still running, by callId. Separate from
	 * `pendingTools` because it changes on a different cadence — a command can
	 * print thousands of lines while the list of running tools stays put — and
	 * dropped as soon as the tool's result lands, since the result supersedes it.
	 */
	liveOutputs: Record<string, string>;
	statusPhase: StatusPhase;
	dialog: PermissionDialogState | null;
	question: QuestionDialogState | null;
	/** Pick-one dialog (resume, model switch). Like `question`, carries a resolve closure. */
	picker: ListPickerState | null;
	contextInfo?: { usedTokens: number; threshold: number };
	tasks?: UiTask[];
	/**
	 * Active theme. Lives in the store so `/theme` can take effect immediately:
	 * the provider reads it from here, so a change rerenders the tree.
	 */
	theme: Theme;
	/** Display name of the active model. In the store so /model switching updates the status line live. */
	modelName: string;
	/**
	 * Modal vim editing in the prompt. In the store rather than a prop because
	 * `/vim` turns it on and off while the app is running — and because `/help`
	 * and the key-list overlay have to describe the editor that is actually up.
	 */
	vim: boolean;
}

export interface PermissionDialogState {
	callId: string;
	toolName: string;
	inputPreview: string;
	/**
	 * The same input in full, several lines, for the Ctrl+A view. The one-line
	 * preview is short on purpose; this is what makes the dialog answerable when
	 * a command is long enough that its tail is where the danger is.
	 */
	inputFull?: string;
	/**
	 * The answers to offer, named for what each one grants (permission-options).
	 * Absent when the host had no input to scope a rule to, in which case the
	 * dialog falls back to the widest truthful wording — the bare tool.
	 */
	options?: PermissionOption[];
	/**
	 * Requests still waiting behind this one, including it. Requests arrive
	 * concurrently (a turn runs several tools at once) and are answered in
	 * order, so the dialog says how many answers are queued rather than
	 * appearing to repeat itself.
	 */
	queueLength?: number;
	resolve: (allow: boolean, alwaysAllow: boolean) => void;
}

export interface UiQuestion {
	question: string;
	header: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

export interface QuestionDialogState {
	questions: UiQuestion[];
	/** Resolves with per-question selected labels; null = user cancelled. */
	resolve: (answers: string[] | null) => void;
}

/**
 * Tool output kept per entry. Generous on purpose — transcript mode (Ctrl+O)
 * renders up to this much so real command output stays readable — while the
 * live view still truncates for layout.
 */
export const RESULT_TEXT_CAP = 16_000;

export function initialUiState(vim = false): UiState {
	return {
		entries: [],
		streamingText: "",
		thinkingText: "",
		pendingTools: [],
		liveOutputs: {},
		statusPhase: "idle",
		dialog: null,
		question: null,
		picker: null,
		theme: DEFAULT_THEME,
		modelName: "",
		vim,
	};
}

function previewInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	const text = typeof input === "string" ? input : JSON.stringify(input);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * The text a tool streamed, whatever shape it wrapped it in.
 *
 * `partial` is `unknown` by design — every tool decides what progress looks like
 * — so the only thing worth rendering here is text, and a tool whose update is a
 * percentage or a count simply has nothing for the output window.
 */
function streamedText(partial: unknown): string | undefined {
	if (typeof partial === "string") return partial;
	if (typeof partial !== "object" || partial === null) return undefined;
	const value = (partial as Record<string, unknown>).partialOutput;
	return typeof value === "string" ? value : undefined;
}

/** Extract the primary preview for common tools (command, path, pattern). */
export function toolPreview(_toolName: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return previewInput(input);
	const record = input as Record<string, unknown>;
	const key = ["command", "file_path", "pattern", "path"].find((k) => k in record);
	if (key) return String(record[key]);
	return previewInput(input);
}

/**
 * How much of an input the Ctrl+A view shows. Generous — a command long enough
 * to be truncated here is a command nobody can read at a glance anyway — but
 * bounded, because this string is held in React state and rendered every frame.
 */
export const INPUT_FULL_MAX = 4000;

/**
 * The whole tool input for the Ctrl+A view, key by key, instead of the one-line
 * preview that trims it to 120 characters.
 *
 * The preview answers "roughly what is this"; this answers "yes, and what was
 * on the end of it", which is the question that matters when the payload is a
 * long command or a diff.
 */
export function toolFullView(_toolName: string, input: unknown): string {
	const text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
	if (text.length <= INPUT_FULL_MAX) return text;
	return `${text.slice(0, INPUT_FULL_MAX)}\n… (${text.length - INPUT_FULL_MAX} more characters)`;
}

export function reduceEvent(state: UiState, event: AgentEvent): UiState {
	switch (event.type) {
		case "agent_start":
			return { ...state, statusPhase: "thinking" };

		case "turn_start":
			return { ...state, streamingText: "", thinkingText: "", statusPhase: "thinking" };

		case "message_update": {
			// Incremental append from the delta itself — rejoining the full
			// content array per delta is O(n²) on long responses.
			const ae = event.assistantMessageEvent;
			switch (ae.type) {
				case "thinking_start":
					return { ...state, thinkingText: "" };
				case "thinking_delta":
					return { ...state, thinkingText: state.thinkingText + ae.delta };
				case "text_start":
					return { ...state, statusPhase: "responding", streamingText: "" };
				case "text_delta":
					return {
						...state,
						statusPhase: "responding",
						streamingText: state.streamingText + ae.delta,
					};
				default:
					return state;
			}
		}

		case "turn_end":
			return {
				...state,
				entries: [
					...state.entries,
					...(state.streamingText ? [{ kind: "assistant", text: state.streamingText } as UiEntry] : []),
				],
				streamingText: "",
				thinkingText: "",
				statusPhase: event.toolResults.length > 0 ? "tools" : "idle",
			};

		case "tool_execution_start":
			return {
				...state,
				statusPhase: "tools",
				pendingTools: [...state.pendingTools, { callId: event.callId, toolName: event.toolName }],
				entries: [
					...state.entries,
					{
						kind: "toolUse",
						callId: event.callId,
						toolName: event.toolName,
						inputPreview: toolPreview(event.toolName, event.input),
					},
				],
			};

		case "tool_execution_update": {
			const text = streamedText(event.partial);
			if (text === undefined) return state;
			return { ...state, liveOutputs: { ...state.liveOutputs, [event.callId]: text } };
		}

		case "tool_execution_end": {
			const content = Array.isArray(event.result.content) ? event.result.content : [];
			const resultText = content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.slice(0, RESULT_TEXT_CAP);
			// The result supersedes the stream: keeping both would hold every
			// command's output in memory for the life of the session.
			const liveOutputs = { ...state.liveOutputs };
			delete liveOutputs[event.callId];
			return {
				...state,
				liveOutputs,
				pendingTools: state.pendingTools.filter((p) => p.callId !== event.callId),
				entries: state.entries.map((entry) =>
					entry.kind === "toolUse" && entry.callId === event.callId
						? { ...entry, resultText, isError: event.result.isError }
						: entry,
				),
			};
		}

		case "agent_end": {
			const entries = [...state.entries];
			if (state.streamingText) {
				entries.push({ kind: "assistant", text: state.streamingText });
			}
			if (event.reason === "error" && event.errorMessage) {
				entries.push({ kind: "error", text: `Error: ${event.errorMessage}` });
			} else if (event.reason === "aborted") {
				entries.push({ kind: "info", text: "[interrupted]" });
			}
			return {
				...state,
				entries,
				streamingText: "",
				thinkingText: "",
				pendingTools: [],
				liveOutputs: {},
				statusPhase: "idle",
			};
		}

		default:
			return state;
	}
}
