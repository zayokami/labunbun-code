/**
 * UI state model: AgentSession events reduce into a flat transcript of
 * renderable entries plus transient streaming/status slices.
 */
import type { AgentEvent } from "@labunbun/agent";

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

export interface UiState {
	entries: UiEntry[];
	streamingText: string;
	thinkingText: string;
	pendingTools: PendingTool[];
	statusPhase: StatusPhase;
	dialog: PermissionDialogState | null;
	contextInfo?: { usedTokens: number; threshold: number };
}

export interface PermissionDialogState {
	callId: string;
	toolName: string;
	inputPreview: string;
	resolve: (allow: boolean, alwaysAllow: boolean) => void;
}

export function initialUiState(): UiState {
	return {
		entries: [],
		streamingText: "",
		thinkingText: "",
		pendingTools: [],
		statusPhase: "idle",
		dialog: null,
	};
}

function previewInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	const text = typeof input === "string" ? input : JSON.stringify(input);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Extract the primary preview for common tools (command, path, pattern). */
export function toolPreview(toolName: string, input: unknown): string {
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
			const partial = event.message;
			let next = state;
			if (event.assistantMessageEvent.type === "thinking_delta") {
				next = {
					...next,
					thinkingText: partial.content
						.filter((b) => b.type === "thinking")
						.map((b) => b.thinking)
						.join(""),
				};
			} else if (
				event.assistantMessageEvent.type === "text_start" ||
				event.assistantMessageEvent.type === "text_delta"
			) {
				next = {
					...next,
					statusPhase: "responding",
					streamingText: partial.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join(""),
				};
			}
			return next;
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
			const resultText = event.result.content
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
