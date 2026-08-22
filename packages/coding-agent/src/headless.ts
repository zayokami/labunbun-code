/**
 * Headless (-p / --print) mode: run one prompt non-interactively.
 *
 * Output formats:
 * - text (default): streamed assistant text on stdout
 * - json: single JSON result object at the end
 * - stream-json: one JSON line per event, live
 */
import type { AgentEvent, PermissionMode } from "@labunbun/agent";
import { AgentSession, evaluatePermissions, SessionStore } from "@labunbun/agent";
import { type AgentMessage, createDefaultStreamFn, resolveModel } from "@labunbun/ai";
import { createAllTools } from "@labunbun/tools";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { applySettingsEnv, collectPermissionRules, loadSettings, resolvePermissionMode } from "./settings.ts";
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
	const loadedSettings = loadSettings(cwd);
	const { settings } = loadedSettings;
	applySettingsEnv(settings);
	const rules = collectPermissionRules(loadedSettings);
	// Headless defaults to bypassPermissions, so this is the tier check that
	// matters most: managed settings can veto it and force real evaluation.
	// Note `settings.permissionMode` is deliberately not consulted here — it
	// governs the interactive default, and honouring it would change what
	// existing scripted `-p` runs are allowed to do.
	const { mode: effectiveMode, downgradeReason } = resolvePermissionMode(
		options.permissionMode ?? "bypassPermissions",
		loadedSettings,
	);
	if (downgradeReason) console.error(`Warning: ${downgradeReason}`);

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	const sessionId = store?.sessionId ?? undefined;
	const hookContext: string[] = [];

	// SessionStart runs before the prompt so its context reaches the model.
	// Hook failures are reported on stderr and never change the exit code.
	const sessionStart = await hooksRuntime.run("SessionStart", { session_id: sessionId, cwd });
	hookContext.push(...sessionStart.addedContext);
	for (const message of advisoryHookFailures("SessionStart", sessionStart)) {
		console.error(`Warning: ${message}`);
	}
	let hookContextInjected = false;
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
		permissionMode: effectiveMode,
		deps: {
			streamFn: createDefaultStreamFn(),
			// Headless has no interactive dialog, so an unresolved "ask" fails
			// closed rather than hanging — matches dontAsk's documented contract.
			canUseTool: async (toolName, input, ctx) => {
				const decision = evaluatePermissions(toolName, input, { mode: ctx.mode, rules, cwd });
				if (decision.behavior === "ask") {
					return {
						behavior: "deny",
						message: decision.message ?? `Permission required for ${toolName} (no interactive dialog in headless mode)`,
					};
				}
				return decision;
			},
			hooks: {
				transformContext: (context) => {
					if (hookContextInjected || hookContext.length === 0) return context;
					hookContextInjected = true;
					const prefix = hookContext.join("\n\n");
					const messages = [...context.messages];
					for (let i = messages.length - 1; i >= 0; i--) {
						const message = messages[i];
						if (message.role === "user") {
							const text = typeof message.content === "string" ? message.content : "";
							messages[i] = { ...message, content: `${prefix}\n\n---\n\n${text}`.trimEnd() };
							break;
						}
					}
					return { ...context, messages };
				},
				beforeToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PreToolUse")) return undefined;
					const outcome = await hooksRuntime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
					for (const error of outcome.errors) console.error(`Warning: PreToolUse hook failed: ${error}`);
					if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
					return undefined;
				},
				afterToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PostToolUse")) return undefined;
					const outcome = await hooksRuntime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
					// Advisory: the call already ran, so a block has nothing to stop.
					for (const message of advisoryHookFailures("PostToolUse", outcome)) {
						console.error(`Warning: ${message}`);
					}
					return undefined;
				},
			},
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

	// UserPromptSubmit gates the single headless prompt. A block exits non-zero
	// without ever reaching the model, so scripted callers can detect it.
	if (hooksRuntime.has("UserPromptSubmit")) {
		const outcome = await hooksRuntime.run("UserPromptSubmit", {
			prompt: options.prompt,
			session_id: sessionId,
			cwd,
		});
		for (const error of outcome.errors) console.error(`Warning: UserPromptSubmit hook failed: ${error}`);
		hookContext.push(...outcome.addedContext);
		if (outcome.blocked) {
			console.error(`[prompt blocked by UserPromptSubmit hook${outcome.reason ? `: ${outcome.reason}` : ""}]`);
			const endOutcome = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
			for (const message of advisoryHookFailures("SessionEnd", endOutcome)) {
				console.error(`Warning: ${message}`);
			}
			return 1;
		}
	}

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

	// SessionEnd is last, and its failures never change the exit code.
	const sessionEnd = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
	for (const message of advisoryHookFailures("SessionEnd", sessionEnd)) {
		console.error(`Warning: ${message}`);
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
