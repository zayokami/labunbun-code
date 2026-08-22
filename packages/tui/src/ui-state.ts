/**
 * UI state model: AgentSession events reduce into a flat transcript of
 * renderable entries plus transient streaming/status slices.
 */
import type { AgentEvent } from "@labunbun/agent";
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
	partial?: unknown;
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
	statusPhase: StatusPhase;
	dialog: PermissionDialogState | null;
	question: QuestionDialogState | null;
	contextInfo?: { usedTokens: number; threshold: number };
	tasks?: UiTask[];
	/**
	 * Active theme. Lives in the store so `/theme` can take effect immediately:
	 * the provider reads it from here, so a change rerenders the tree.
	 */
	theme: Theme;
}

export interface PermissionDialogState {
	callId: string;
	toolName: string;
	inputPreview: string;
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

export function initialUiState(): UiState {
	return {
		entries: [],
		streamingText: "",
		thinkingText: "",
		pendingTools: [],
		statusPhase: "idle",
		dialog: null,
		question: null,
		theme: DEFAULT_THEME,
	};
}

function previewInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	const text = typeof input === "string" ? input : JSON.stringify(input);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Extract the primary preview for common tools (command, path, pattern). */
export function toolPreview(_toolName: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return previewInput(input);
	const record = input as Record<string, unknown>;
	const key = ["command", "file_path", "pattern", "path"].find((k) => k in record);
	if (key) return String(record[key]);
	return previewInput(input);
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
			const pendingTools = state.pendingTools.map((p) =>
				p.callId === event.callId ? { ...p, partial: event.partial } : p,
			);
			return { ...state, pendingTools };
		}

		case "tool_execution_end": {
			const content = Array.isArray(event.result.content) ? event.result.content : [];
			const resultText = content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.slice(0, 2000);
			return {
				...state,
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
				statusPhase: "idle",
			};
		}

		default:
			return state;
	}
}
