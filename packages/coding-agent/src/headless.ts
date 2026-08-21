/**
 * Headless (-p / --print) mode: run one prompt non-interactively.
 *
 * Output formats:
 * - text (default): streamed assistant text on stdout
 * - json: single JSON result object at the end
 * - stream-json: one JSON line per event, live
 */
import type { AgentEvent } from "@labunbun/agent";
import { AgentSession, SessionStore } from "@labunbun/agent";
import { createDefaultStreamFn, resolveModel, type AgentMessage } from "@labunbun/ai";
import { createAllTools } from "@labunbun/tools";
import type { PermissionMode } from "@labunbun/agent";
import { buildSystemPrompt } from "./system-prompt.ts";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
	prompt: string;
	modelRef?: string;
	permissionMode?: PermissionMode;
	maxTurns?: number;
	noSession?: boolean;
	cwd?: string;
	outputFormat?: OutputFormat;
}

interface JsonResult {
	type: "result";
	subtype: "success" | "error_max_turns" | "error_during_execution" | "error_aborted";
	cost_usd: number;
	duration_ms: number;
	num_turns: number;
	result: string;
	session_id: string | null;
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const format = options.outputFormat ?? "text";
	const model = resolveModel(options.modelRef ?? "anthropic/claude-sonnet-5");
	if (!model) {
		console.error(`Unknown model: ${options.modelRef}`);
		return 1;
	}

	const tools = createAllTools(cwd);
	const store = options.noSession ? undefined : SessionStore.startNew(cwd);
	const session = new AgentSession({
		model,
		systemPrompt: buildSystemPrompt(tools, {
			cwd,
			platform: process.platform,
			isTTY: process.stdout.isTTY ?? false,
		}),
		tools,
		store,
		cwd,
		maxTurns: options.maxTurns,
		permissionMode: options.permissionMode ?? "bypassPermissions",
		deps: {
			streamFn: createDefaultStreamFn(),
		},
	});

	const startedAt = Date.now();
	let lastAssistantText = "";
	let turns = 0;

	const emitStreamJson = (payload: Record<string, unknown>): void => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};

	session.on((event: AgentEvent) => {
		if (event.type === "turn_start") turns++;

		if (event.type === "message_update") {
			const text = event.message.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			if (format === "text") {
				const delta = text.slice(lastAssistantText.length);
				if (delta) {
					process.stdout.write(delta);
					lastAssistantText = text;
				}
			} else if (format === "stream-json") {
				emitStreamJson({
					type: "assistant",
					message: event.assistantMessageEvent.type,
					text_delta: event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined,
				});
			}
		}

		if (format === "stream-json" && event.type === "tool_execution_start") {
			emitStreamJson({ type: "tool_use", tool: event.toolName, input: event.input });
		}
		if (format === "stream-json" && event.type === "tool_execution_end") {
			emitStreamJson({
				type: "tool_result",
				tool: event.toolName,
				is_error: event.result.isError,
			});
		}
	});

	const reason = await session.prompt(options.prompt);
	const finalText = finalAssistantText(session.messages);
	const usage = totalUsage(session.messages);

	if (format === "json") {
		const result: JsonResult = {
			type: "result",
			subtype:
				reason === "completed"
					? "success"
					: reason === "max_turns"
						? "error_max_turns"
						: reason === "aborted"
							? "error_aborted"
							: "error_during_execution",
			cost_usd: 0, // pricing-aware cost lands with the model catalog expansion
			duration_ms: Date.now() - startedAt,
			num_turns: turns,
			result: finalText,
			session_id: store?.sessionId ?? null,
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (format === "stream-json") {
		emitStreamJson({
			type: "result",
			reason,
			result: finalText,
			usage,
			duration_ms: Date.now() - startedAt,
			session_id: store?.sessionId ?? null,
		});
	} else {
		// text mode already streamed; close cleanly
		process.stdout.write("\n");
		if (reason !== "completed") {
			const errorMessage = findLastError(session.messages);
			console.error(`[session ended: ${reason}${errorMessage ? ` — ${errorMessage}` : ""}]`);
		}
	}

	if (store && format !== "text") {
		console.error(`[session saved: ${store.path}]`);
	} else if (store) {
		console.error(`[session saved: ${store.path}]`);
	}
	return reason === "completed" ? 0 : reason === "aborted" ? 130 : 1;
}

function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = m.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

function totalUsage(messages: AgentMessage[]): Record<string, number> {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		totals.input += m.usage.input ?? 0;
		totals.output += m.usage.output ?? 0;
		totals.cacheRead += m.usage.cacheRead ?? 0;
		totals.cacheWrite += m.usage.cacheWrite ?? 0;
	}
	return totals;
}

function findLastError(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && m.errorMessage) return m.errorMessage;
		if (m.role === "toolResult" && m.isError) {
			const text = m.content.find((b) => b.type === "text")?.text;
			if (text) return text.slice(0, 200);
		}
	}
	return undefined;
}
